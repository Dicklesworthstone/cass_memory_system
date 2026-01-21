import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { TRAUMA_GUARD_SCRIPT, GIT_PRECOMMIT_HOOK } from "../src/trauma_guard_script.js";
import { TraumaEntry } from "../src/types.js";
import { withTempDir } from "./helpers/index.js";

/**
 * Tests for trauma_guard_script.ts
 *
 * This module exports a Python script that acts as a Claude Code hook
 * to block dangerous commands based on trauma patterns.
 */

/**
 * Get the Python script content with proper Unicode handling.
 * Bun's String.raw may escape Unicode, so we fix the common escapes.
 */
function getPythonScript(script: string = TRAUMA_GUARD_SCRIPT): string {
  // Fix Unicode escapes that Bun may introduce
  return script
    .replace(/\\u\{1f525\}/g, "🔥")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    );
}

// =============================================================================
// TRAUMA_GUARD_SCRIPT Export Validation
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT - Export Validation", () => {
  it("exports a non-empty string", () => {
    expect(typeof TRAUMA_GUARD_SCRIPT).toBe("string");
    expect(TRAUMA_GUARD_SCRIPT.length).toBeGreaterThan(100);
  });
  // ... existing tests ...
});

// ... existing TRAUMA_GUARD_SCRIPT tests ...

// =============================================================================
// GIT_PRECOMMIT_HOOK Tests
// =============================================================================
describe("GIT_PRECOMMIT_HOOK", () => {
  const createTrauma = (id: string, pattern: string): TraumaEntry => ({
    id,
    severity: "CRITICAL",
    pattern,
    scope: "global",
    status: "active",
    trigger_event: {
      session_path: "/sessions/test.jsonl",
      timestamp: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  });

  async function setupAndRunHook(
    dir: string,
    diffContent: string,
    traumas: TraumaEntry[] = []
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scriptPath = join(dir, "pre-commit.py");
    // Mock get_staged_diff to return our content
    let script = getPythonScript(GIT_PRECOMMIT_HOOK);
    
    // Inject mock for get_staged_diff
    const mockFunc = `
def get_staged_diff():
    return """${diffContent}"""
`;
    // Replace the real function with our mock
    script = script.replace(/def get_staged_diff\(\):[\s\S]+?return result.stdout\n    except:\n        return ""/, mockFunc);
    
    await writeFile(scriptPath, script);

    // Create trauma files if needed
    if (traumas.length > 0) {
      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      const traumaContent = traumas.map(t => JSON.stringify(t)).join("\n") + "\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), traumaContent);
    }

    const result = spawnSync("python3", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: dir }
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? ""
    };
  }

  it("blocks added dangerous lines", async () => {
    await withTempDir("git-block-add", async (dir) => {
      const traumas = [createTrauma("t1", "^rm\\s+-rf")];
      const diff = `diff --git a/test.sh b/test.sh
index ...
--- a/test.sh
+++ b/test.sh
@@ -0,0 +1 @@
+rm -rf /`;

      const result = await setupAndRunHook(dir, diff, traumas);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("BLOCKED");
      expect(result.stdout).toContain("rm\\s+-rf");
    });
  });

  it("blocks dangerous content starting with ++", async () => {
    await withTempDir("git-cpp-increment", async (dir) => {
      const traumas = [createTrauma("t1", "dangerous")];
      const diff = `diff --git a/test.cpp b/test.cpp
index ...
--- a/test.cpp
+++ b/test.cpp
@@ -0,0 +1 @@
+++i; // dangerous`;

      const result = await setupAndRunHook(dir, diff, traumas);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("BLOCKED");
    });
  });

  it("ignores deleted dangerous lines", async () => {
    await withTempDir("git-allow-delete", async (dir) => {
      const traumas = [createTrauma("t1", "^rm\\s+-rf")];
      const diff = `diff --git a/test.sh b/test.sh
index ...
--- a/test.sh
+++ b/test.sh
@@ -1 +0,0 @@
-rm -rf /`;

      const result = await setupAndRunHook(dir, diff, traumas);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  it("ignores dangerous lines in context (not starting with +)", async () => {
    await withTempDir("git-allow-context", async (dir) => {
      const traumas = [createTrauma("t1", "^rm\\s+-rf")];
      // Note: ' ' prefix is context
      const diff = `diff --git a/test.sh b/test.sh
index ...
--- a/test.sh
+++ b/test.sh
@@ -1,3 +1,3 @@
 echo start
 rm -rf /
-echo end
+echo done`;

      const result = await setupAndRunHook(dir, diff, traumas);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });
});

describe("TRAUMA_GUARD_SCRIPT Content", () => {
  it("starts with Python shebang", () => {
    expect(TRAUMA_GUARD_SCRIPT.startsWith("#!/usr/bin/env python3")).toBe(true);
  });

  it("contains required Python imports", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("import json");
    expect(TRAUMA_GUARD_SCRIPT).toContain("import sys");
    expect(TRAUMA_GUARD_SCRIPT).toContain("import re");
    expect(TRAUMA_GUARD_SCRIPT).toContain("import os");
    expect(TRAUMA_GUARD_SCRIPT).toContain("from pathlib import Path");
  });

  it("defines main() function", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("def main():");
  });

  it("defines load_traumas() function", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("def load_traumas():");
  });

  it("defines check_command() function", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("def check_command(command, traumas):");
  });

  it("defines find_repo_root() function", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("def find_repo_root():");
  });

  it("has proper __main__ guard", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain('if __name__ == "__main__":');
    expect(TRAUMA_GUARD_SCRIPT).toContain("main()");
  });

  it("contains HOT STOVE message", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("HOT STOVE");
    expect(TRAUMA_GUARD_SCRIPT).toContain("VISCERAL SAFETY INTERVENTION");
  });

  it("handles CASS_MEMORY_NO_EMOJI env var", () => {
    expect(TRAUMA_GUARD_SCRIPT).toContain("CASS_MEMORY_NO_EMOJI");
  });
});

// =============================================================================
// Python Syntax Validation
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT - Python Syntax Validation", () => {
  it("is valid Python 3 syntax", async () => {
    await withTempDir("guard-syntax", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      // Use Python's compile check (-m py_compile)
      const result = spawnSync("python3", ["-m", "py_compile", scriptPath], {
        encoding: "utf-8",
        timeout: 5000
      });

      if (result.status !== 0) {
        console.error("Python syntax error:", result.stderr);
      }
      expect(result.status).toBe(0);
    });
  });

  it("can be executed without errors (dry run)", async () => {
    await withTempDir("guard-dryrun", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      // Run with empty input - should exit 0 (fail open for non-JSON)
      const result = spawnSync("python3", [scriptPath], {
        input: "",
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      expect(result.status).toBe(0);
    });
  });
});

// =============================================================================
// Hook I/O Format Tests
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT - Hook I/O", () => {
  const createTrauma = (id: string, pattern: string): TraumaEntry => ({
    id,
    severity: "CRITICAL",
    pattern,
    scope: "global",
    status: "active",
    trigger_event: {
      session_path: "/sessions/test.jsonl",
      timestamp: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  });

  async function setupAndRun(
    dir: string,
    input: Record<string, unknown>,
    traumas: TraumaEntry[] = []
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scriptPath = join(dir, "trauma_guard.py");
    await writeFile(scriptPath, getPythonScript());

    // Create trauma files if needed
    if (traumas.length > 0) {
      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      const traumaContent = traumas.map(t => JSON.stringify(t)).join("\n") + "\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), traumaContent);
    }

    const result = spawnSync("python3", [scriptPath], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: dir }
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? ""
    };
  }

  it("exits 0 for non-JSON input", async () => {
    await withTempDir("guard-nonjson", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const result = spawnSync("python3", [scriptPath], {
        input: "not json at all",
        encoding: "utf-8",
        timeout: 5000
      });

      expect(result.status).toBe(0);
    });
  });

  it("exits 0 for non-Bash tool", async () => {
    await withTempDir("guard-nonbash", async (dir) => {
      const input = {
        tool_name: "Read",
        tool_input: { file_path: "/some/file.txt" }
      };

      const result = await setupAndRun(dir, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(""); // No output for non-Bash
    });
  });

  it("exits 0 for safe Bash command with no traumas", async () => {
    await withTempDir("guard-safe", async (dir) => {
      const input = {
        tool_name: "Bash",
        tool_input: { command: "git status" }
      };

      const result = await setupAndRun(dir, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  it("exits 0 for safe command with non-matching traumas", async () => {
    await withTempDir("guard-nomatch", async (dir) => {
      const traumas = [createTrauma("t1", "rm -rf")];
      const input = {
        tool_name: "Bash",
        tool_input: { command: "git status" }
      };

      const result = await setupAndRun(dir, input, traumas);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  it("outputs deny for matching trauma pattern", async () => {
    await withTempDir("guard-deny", async (dir) => {
      const traumas = [createTrauma("trauma-123", "rm -rf")];
      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /home/user" }
      };

      const result = await setupAndRun(dir, input, traumas);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe("");

      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput).toBeDefined();
      expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("HOT STOVE");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("rm -rf");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("trauma-123");
    });
  });

  it("includes human_message in deny reason", async () => {
    await withTempDir("guard-message", async (dir) => {
      const trauma: TraumaEntry = {
        ...createTrauma("trauma-db", "DROP DATABASE"),
        trigger_event: {
          session_path: "/sessions/disaster.jsonl",
          timestamp: new Date().toISOString(),
          human_message: "We lost 3 hours of data!"
        }
      };

      const input = {
        tool_name: "Bash",
        tool_input: { command: "DROP DATABASE production" }
      };

      const result = await setupAndRun(dir, input, [trauma]);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("We lost 3 hours of data!");
    });
  });

  it("ignores healed traumas", async () => {
    await withTempDir("guard-healed", async (dir) => {
      const trauma: TraumaEntry = {
        ...createTrauma("t1", "rm -rf"),
        status: "healed"
      };

      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /home" }
      };

      const result = await setupAndRun(dir, input, [trauma]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(""); // No deny - healed trauma ignored
    });
  });

  it("handles missing tool_input gracefully", async () => {
    await withTempDir("guard-noinput", async (dir) => {
      const input = { tool_name: "Bash" };
      const result = await setupAndRun(dir, input);
      expect(result.exitCode).toBe(0);
    });
  });

  it("handles empty command gracefully", async () => {
    await withTempDir("guard-empty", async (dir) => {
      const input = {
        tool_name: "Bash",
        tool_input: { command: "" }
      };

      const result = await setupAndRun(dir, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  it("matches case-insensitively", async () => {
    await withTempDir("guard-case", async (dir) => {
      const traumas = [createTrauma("t1", "DROP DATABASE")];
      const input = {
        tool_name: "Bash",
        tool_input: { command: "drop database production" }
      };

      const result = await setupAndRun(dir, input, traumas);
      expect(result.stdout).toContain("deny");
    });
  });

  it("handles regex patterns", async () => {
    await withTempDir("guard-regex", async (dir) => {
      const traumas = [createTrauma("t1", "git\\s+push\\s+.*--force")];

      // Should match
      const input1 = {
        tool_name: "Bash",
        tool_input: { command: "git push origin main --force" }
      };
      const result1 = await setupAndRun(dir, input1, traumas);
      expect(result1.stdout).toContain("deny");

      // Should not match
      const input2 = {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" }
      };
      const result2 = await setupAndRun(dir, input2, traumas);
      expect(result2.stdout).toBe("");
    });
  });

  it("handles invalid regex gracefully", async () => {
    await withTempDir("guard-badregex", async (dir) => {
      const traumas = [
        createTrauma("bad", "[invalid(regex"),
        createTrauma("good", "valid-pattern")
      ];

      const input = {
        tool_name: "Bash",
        tool_input: { command: "valid-pattern-test" }
      };

      // Should not crash, should match the valid pattern
      const result = await setupAndRun(dir, input, traumas);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deny");
      expect(result.stdout).toContain("good");
    });
  });
});

// =============================================================================
// Trauma File Loading
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT - load_traumas", () => {
  it("handles missing trauma file", async () => {
    await withTempDir("guard-nofile", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      // No trauma file exists
      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      // Should pass (no traumas to match)
      expect(result.status).toBe(0);
      expect(result.stdout?.trim()).toBe("");
    });
  });

  it("handles empty trauma file", async () => {
    await withTempDir("guard-emptyfile", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), "");

      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      expect(result.status).toBe(0);
      expect(result.stdout?.trim()).toBe("");
    });
  });

  it("skips invalid JSON lines", async () => {
    await withTempDir("guard-invalidjson", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });

      const validTrauma: TraumaEntry = {
        id: "valid-1",
        severity: "CRITICAL",
        pattern: "dangerous",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const content = "not json\n" + JSON.stringify(validTrauma) + "\n{bad json\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), content);

      const input = {
        tool_name: "Bash",
        tool_input: { command: "dangerous command" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      // Should still match the valid trauma
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deny");
    });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT - Edge Cases", () => {
  const createTrauma = (id: string, pattern: string): TraumaEntry => ({
    id,
    severity: "CRITICAL",
    pattern,
    scope: "global",
    status: "active",
    trigger_event: {
      session_path: "/sessions/test.jsonl",
      timestamp: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  });

  it("handles newlines in command", async () => {
    await withTempDir("guard-newlines", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      await writeFile(
        join(cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(createTrauma("t1", "rm -rf")) + "\n"
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "echo hello\nrm -rf /\necho done" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deny");
    });
  });

  it("respects CASS_MEMORY_NO_EMOJI env var", async () => {
    await withTempDir("guard-noemoji", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      await writeFile(
        join(cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(createTrauma("t1", "dangerous")) + "\n"
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "dangerous" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir, CASS_MEMORY_NO_EMOJI: "1" }
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      // Should NOT have emoji
      expect(output.hookSpecificOutput.permissionDecisionReason).not.toContain("🔥");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("[HOT STOVE]");
    });
  });

  it("handles unicode in patterns", async () => {
    await withTempDir("guard-unicode", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });

      const trauma: TraumaEntry = {
        ...createTrauma("unicode", "删除.*数据库"),
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString(),
          human_message: "永远不要这样做！"
        }
      };
      await writeFile(
        join(cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "删除所有数据库" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deny");
      // The human_message may be unicode-escaped in JSON output
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("永远不要这样做");
    });
  });

  it("handles special regex characters safely", async () => {
    await withTempDir("guard-special", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      await writeFile(
        join(cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(createTrauma("t1", "rm\\s+-rf\\s+/\\w+")) + "\n"
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /home" }
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir }
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deny");
    });
  });
});
