export const TRAUMA_GUARD_SCRIPT = String.raw`#!/usr/bin/env python3
"""
Dynamic Trauma Guard for Project Hot Stove.
Reads from ~/.cass-memory/traumas.jsonl and .cass/traumas.jsonl to enforce safety.
"""
import json
import sys
import re
import os
from pathlib import Path

GLOBAL_TRAUMA_FILE = Path.home() / ".cass-memory" / "traumas.jsonl"

def find_repo_root():
    """Find the root of the current git repository."""
    curr = Path.cwd()
    while curr != curr.parent:
        if (curr / ".git").exists():
            return curr
        curr = curr.parent
    return None

def load_traumas():
    """Load active traumas from global and project storage."""
    traumas = []
    
    # Load Global
    if GLOBAL_TRAUMA_FILE.exists():
        try:
            with open(GLOBAL_TRAUMA_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            t = json.loads(line)
                            if t.get("status") == "active":
                                traumas.append(t)
                        except:
                            pass
        except Exception:
            pass # Fail open on read error (don't block work if DB is corrupt)

    # Load Project
    repo_root = find_repo_root()
    if repo_root:
        repo_file = repo_root / ".cass" / "traumas.jsonl"
        if repo_file.exists():
            try:
                with open(repo_file, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            try:
                                t = json.loads(line)
                                if t.get("status") == "active":
                                    traumas.append(t)
                            except:
                                pass
            except Exception:
                pass

    return traumas

def check_command(command, traumas):
    """Check command against trauma patterns."""
    for trauma in traumas:
        pattern = trauma.get("pattern")
        if not pattern:
            continue
            
        try:
            # Case-insensitive match
            if re.search(pattern, command, re.IGNORECASE):
                return trauma
        except re.error:
            continue
    return None

def main():
    # Read input from Claude/Generic Hook
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # Not a JSON hook input, ignore
        sys.exit(0)

    # Extract command
    # Claude Code format: {"tool_name": "Bash", "tool_input": {"command": "..."}}
    tool_name = input_data.get("tool_name")
    tool_input = input_data.get("tool_input", {})
    command = tool_input.get("command")

    # Only check Bash commands
    if tool_name != "Bash" or not command:
        sys.exit(0)

    traumas = load_traumas()
    match = check_command(command, traumas)

    if match:
        msg = match["trigger_event"].get("human_message") or "You previously caused a catastrophe with this command."
        
        # Deny the command
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"🔥 HOT STOVE: VISCERAL SAFETY INTERVENTION 🔥\n\n"
                    f"BLOCKED: This pattern matches a registered TRAUMA.\n"
                    f"Pattern: {match['pattern']}\n"
                    f"Reason: {msg}\n"
                    f"Reference: {match['trigger_event'].get('session_path', 'unknown')}\n\n"
                    f"If you MUST run this, use 'cm trauma remove {match['id']}' to heal the scar first."
                )
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    # Allow
    sys.exit(0)

if __name__ == "__main__":
    main()
`;