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
                            if isinstance(t, dict) and t.get("status") == "active":
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
                                if isinstance(t, dict) and t.get("status") == "active":
                                    traumas.append(t)
                            except:
                                pass
            except Exception:
                pass

    return traumas

def check_command(command, traumas):
    """Check command against trauma patterns."""
    for trauma in traumas:
        if not isinstance(trauma, dict):
            continue

        pattern = trauma.get("pattern")
        if not isinstance(pattern, str) or not pattern:
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

    if not isinstance(input_data, dict):
        # Fail open if the hook input isn't the expected object shape
        sys.exit(0)

    # Extract command
    # Claude Code format: {"tool_name": "Bash", "tool_input": {"command": "..."}}
    tool_name = input_data.get("tool_name")
    tool_input = input_data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        sys.exit(0)
    command = tool_input.get("command")

    # Only check Bash commands
    if tool_name != "Bash" or not isinstance(command, str) or not command:
        sys.exit(0)

    traumas = load_traumas()
    match = check_command(command, traumas)

    if match:
        trigger = match.get("trigger_event")
        if not isinstance(trigger, dict):
            trigger = {}
        msg = trigger.get("human_message") or "You previously caused a catastrophe with this command."
        ref = trigger.get("session_path") or "unknown"
        pattern = match.get("pattern") or "<unknown>"
        trauma_id = match.get("id") or "<unknown>"

        use_emoji = os.environ.get("CASS_MEMORY_NO_EMOJI") is None
        banner = (
            "🔥 HOT STOVE: VISCERAL SAFETY INTERVENTION 🔥"
            if use_emoji
            else "[HOT STOVE] VISCERAL SAFETY INTERVENTION"
        )
        
        # Deny the command
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"{banner}\n\n"
                    f"BLOCKED: This pattern matches a registered TRAUMA.\n"
                    f"Pattern: {pattern}\n"
                    f"Reason: {msg}\n"
                    f"Reference: {ref}\n\n"
                    f"If you MUST run this, heal it first with: cm trauma heal {trauma_id}"
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

/**
 * Git pre-commit hook script for trauma pattern detection.
 * Scans staged changes for dangerous patterns before allowing commits.
 */
export const GIT_PRECOMMIT_HOOK = String.raw`#!/usr/bin/env python3
"""
Git Pre-Commit Trauma Guard for Project Hot Stove.
Scans staged changes for dangerous patterns before allowing commits.
"""
import json
import sys
import re
import os
import subprocess
from pathlib import Path

GLOBAL_TRAUMA_FILE = Path.home() / ".cass-memory" / "traumas.jsonl"

def find_repo_root():
    """Find the root of the current git repository."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True
        )
        return Path(result.stdout.strip())
    except:
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
                            if isinstance(t, dict) and t.get("status") == "active":
                                traumas.append(t)
                        except:
                            pass
        except Exception:
            pass

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
                                if isinstance(t, dict) and t.get("status") == "active":
                                    traumas.append(t)
                            except:
                                pass
            except Exception:
                pass

    return traumas

def get_staged_diff():
    """Get the staged changes as text."""
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--unified=0"],
            capture_output=True, text=True, check=True
        )
        return result.stdout
    except:
        return ""

def check_content(content, traumas):
    """Check content against trauma patterns (only added lines)."""
    lines = content.splitlines()
    added_lines = []
    in_hunk = False

    for line in lines:
        if line.startswith('diff --git'):
            in_hunk = False
            continue
        
        if line.startswith('@@'):
            in_hunk = True
            continue

        if in_hunk and line.startswith('+'):
            # Strip the '+' prefix
            added_lines.append(line[1:])

    for trauma in traumas:
        if not isinstance(trauma, dict):
            continue

        pattern = trauma.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            continue

        try:
            regex = re.compile(pattern, re.IGNORECASE)
            for line in added_lines:
                if regex.search(line):
                    return trauma
        except re.error:
            continue
    return None

def main():
    traumas = load_traumas()
    if not traumas:
        sys.exit(0)  # No traumas to check

    diff = get_staged_diff()
    if not diff:
        sys.exit(0)  # Nothing staged

    match = check_content(diff, traumas)
    if match:
        trigger = match.get("trigger_event") or {}
        msg = trigger.get("human_message") or "This pattern matches a previous catastrophe."
        pattern = match.get("pattern") or "<unknown>"
        trauma_id = match.get("id") or "<unknown>"
        severity = match.get("severity") or "CRITICAL"

        use_emoji = os.environ.get("CASS_MEMORY_NO_EMOJI") is None
        banner = (
            "🔥 HOT STOVE: COMMIT BLOCKED 🔥"
            if use_emoji
            else "[HOT STOVE] COMMIT BLOCKED"
        )

        print(f"\n{banner}")
        print(f"\nBLOCKED: Staged changes match a registered TRAUMA pattern.")
        print(f"Severity: {severity}")
        print(f"Pattern: {pattern}")
        print(f"Reason: {msg}")
        print(f"\nTo proceed anyway, use: git commit --no-verify")
        print(f"To heal this trauma: cm trauma heal {trauma_id}")
        print()
        sys.exit(1)

    sys.exit(0)

if __name__ == "__main__":
    main()
`;
