import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GIT_PRECOMMIT_HOOK,
  renderGuardScript,
  TRAUMA_GUARD_SCRIPT,
} from "../src/trauma_guard_script.js";
import type { TraumaEntry } from "../src/types.js";
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
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
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

// =============================================================================
// Regression tests for issue #45 — Rust-style \u{1f525} escapes leaking into
// compiled binaries. Bun's TypeScript loader normalises non-ASCII characters
// in template literals to \u{…} escapes; inside `String.raw` those escapes
// are preserved as literal backslash sequences, producing a Python hook
// that fails with `SyntaxError: (unicode error) 'unicodeescape' codec can't
// decode bytes … truncated \uXXXX escape`.
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT / GIT_PRECOMMIT_HOOK — no raw \\u{…} escapes", () => {
  it("TRAUMA_GUARD_SCRIPT contains no literal \\u{...} escape sequences", () => {
    // If this fails, bun has regressed or someone reintroduced a literal emoji
    // into the String.raw template. Route emoji through `${FIRE}` interpolation
    // (see src/trauma_guard_script.ts).
    expect(TRAUMA_GUARD_SCRIPT).not.toMatch(/\\u\{[0-9a-fA-F]+\}/);
  });

  it("GIT_PRECOMMIT_HOOK contains no literal \\u{...} escape sequences", () => {
    expect(GIT_PRECOMMIT_HOOK).not.toMatch(/\\u\{[0-9a-fA-F]+\}/);
  });

  it("TRAUMA_GUARD_SCRIPT embeds the fire emoji as a Python-side escape", () => {
    // We deliberately emit `\U0001F525` (Python escape) rather than the literal
    // 🔥 character or the JS-side `\u{1F525}` escape. The Python parser decodes
    // `\U0001F525` to U+1F525 (🔥) at script-execution time, so the rendered
    // banner is identical at runtime — but the on-disk script contains only
    // ASCII, which is immune to Bun's compiled-binary normalisation drift
    // documented in #48 (and previously #45).
    expect(TRAUMA_GUARD_SCRIPT).toContain("\\U0001F525 HOT STOVE");
    // And as a regression guard: it must NOT contain the literal emoji or the
    // JS-side escape form, because those are the two shapes that have leaked
    // bugs in the past.
    expect(TRAUMA_GUARD_SCRIPT).not.toContain("🔥 HOT STOVE");
    expect(TRAUMA_GUARD_SCRIPT).not.toMatch(/\\u\{[0-9a-fA-F]+\}\s*HOT STOVE/);
  });

  it("GIT_PRECOMMIT_HOOK embeds the fire emoji as a Python-side escape", () => {
    expect(GIT_PRECOMMIT_HOOK).toContain("\\U0001F525 HOT STOVE");
    expect(GIT_PRECOMMIT_HOOK).not.toContain("🔥 HOT STOVE");
    expect(GIT_PRECOMMIT_HOOK).not.toMatch(/\\u\{[0-9a-fA-F]+\}\s*HOT STOVE/);
  });

  it("Python parses the FIRE escape to U+1F525 (🔥) at runtime", async () => {
    // End-to-end semantic check: when Python actually executes the trauma
    // guard, the banner string must include the real fire emoji character —
    // otherwise we've shipped a script that prints `\U0001F525` literally.
    await withTempDir("trauma-guard-fire-decode", async (dir) => {
      const scriptPath = join(dir, "fire_check.py");
      await writeFile(
        scriptPath,
        `banner = "\\U0001F525 HOT STOVE: VISCERAL SAFETY INTERVENTION \\U0001F525"\nprint(banner)\n`,
      );
      const result = spawnSync("python3", [scriptPath], { encoding: "utf-8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("🔥 HOT STOVE");
    });
  });

  it("installed trauma guard parses as valid Python (ast.parse)", async () => {
    // End-to-end: the very failure mode the user hit. If `\u{1f525}` is
    // present, ast.parse raises SyntaxError at line with "\uXXXX truncated".
    await withTempDir("trauma-guard-parse", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, TRAUMA_GUARD_SCRIPT);
      const result = spawnSync(
        "python3",
        ["-c", `import ast; ast.parse(open(${JSON.stringify(scriptPath)}).read())`],
        { encoding: "utf-8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });

  it("installed git pre-commit hook parses as valid Python (ast.parse)", async () => {
    await withTempDir("git-precommit-parse", async (dir) => {
      const scriptPath = join(dir, "trauma_guard_precommit.py");
      await writeFile(scriptPath, GIT_PRECOMMIT_HOOK);
      const result = spawnSync(
        "python3",
        ["-c", `import ast; ast.parse(open(${JSON.stringify(scriptPath)}).read())`],
        { encoding: "utf-8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });
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
      timestamp: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  });

  async function setupAndRunHook(
    dir: string,
    diffContent: string,
    traumas: TraumaEntry[] = [],
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
    script = script.replace(
      /def get_staged_diff\(\):[\s\S]+?return result.stdout\n {4}except:\n {8}return ""/,
      mockFunc,
    );

    await writeFile(scriptPath, script);

    // Create trauma files if needed
    if (traumas.length > 0) {
      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      const traumaContent = traumas.map((t) => JSON.stringify(t)).join("\n") + "\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), traumaContent);
    }

    const result = spawnSync("python3", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: dir },
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
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
        timeout: 5000,
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
        env: { ...process.env, HOME: dir },
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
      timestamp: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  });

  async function setupAndRun(
    dir: string,
    input: Record<string, unknown>,
    traumas: TraumaEntry[] = [],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scriptPath = join(dir, "trauma_guard.py");
    await writeFile(scriptPath, getPythonScript());

    // Create trauma files if needed
    if (traumas.length > 0) {
      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      const traumaContent = traumas.map((t) => JSON.stringify(t)).join("\n") + "\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), traumaContent);
    }

    const result = spawnSync("python3", [scriptPath], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: dir },
    });

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
    };
  }

  it("exits 0 for non-JSON input", async () => {
    await withTempDir("guard-nonjson", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const result = spawnSync("python3", [scriptPath], {
        input: "not json at all",
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(result.status).toBe(0);
    });
  });

  it("exits 0 for non-Bash tool", async () => {
    await withTempDir("guard-nonbash", async (dir) => {
      const input = {
        tool_name: "Read",
        tool_input: { file_path: "/some/file.txt" },
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
        tool_input: { command: "git status" },
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
        tool_input: { command: "git status" },
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
        tool_input: { command: "rm -rf /home/user" },
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
          human_message: "We lost 3 hours of data!",
        },
      };

      const input = {
        tool_name: "Bash",
        tool_input: { command: "DROP DATABASE production" },
      };

      const result = await setupAndRun(dir, input, [trauma]);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
        "We lost 3 hours of data!",
      );
    });
  });

  it("ignores healed traumas", async () => {
    await withTempDir("guard-healed", async (dir) => {
      const trauma: TraumaEntry = {
        ...createTrauma("t1", "rm -rf"),
        status: "healed",
      };

      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /home" },
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
        tool_input: { command: "" },
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
        tool_input: { command: "drop database production" },
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
        tool_input: { command: "git push origin main --force" },
      };
      const result1 = await setupAndRun(dir, input1, traumas);
      expect(result1.stdout).toContain("deny");

      // Should not match
      const input2 = {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      };
      const result2 = await setupAndRun(dir, input2, traumas);
      expect(result2.stdout).toBe("");
    });
  });

  it("handles invalid regex gracefully", async () => {
    await withTempDir("guard-badregex", async (dir) => {
      const traumas = [
        createTrauma("bad", "[invalid(regex"),
        createTrauma("good", "valid-pattern"),
      ];

      const input = {
        tool_name: "Bash",
        tool_input: { command: "valid-pattern-test" },
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
        tool_input: { command: "rm -rf /" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
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
        tool_input: { command: "rm -rf /" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
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
          timestamp: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      };

      const content = "not json\n" + JSON.stringify(validTrauma) + "\n{bad json\n";
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), content);

      const input = {
        tool_name: "Bash",
        tool_input: { command: "dangerous command" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
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
      timestamp: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  });

  it("handles newlines in command", async () => {
    await withTempDir("guard-newlines", async (dir) => {
      const scriptPath = join(dir, "trauma_guard.py");
      await writeFile(scriptPath, getPythonScript());

      const cassMemoryDir = join(dir, ".cass-memory");
      await mkdir(cassMemoryDir, { recursive: true });
      await writeFile(
        join(cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(createTrauma("t1", "rm -rf")) + "\n",
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "echo hello\nrm -rf /\necho done" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
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
        JSON.stringify(createTrauma("t1", "dangerous")) + "\n",
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "dangerous" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir, CASS_MEMORY_NO_EMOJI: "1" },
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
          human_message: "永远不要这样做！",
        },
      };
      await writeFile(join(cassMemoryDir, "traumas.jsonl"), JSON.stringify(trauma) + "\n");

      const input = {
        tool_name: "Bash",
        tool_input: { command: "删除所有数据库" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
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
        JSON.stringify(createTrauma("t1", "rm\\s+-rf\\s+/\\w+")) + "\n",
      );

      const input = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /home" },
      };

      const result = spawnSync("python3", [scriptPath], {
        input: JSON.stringify(input),
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deny");
    });
  });
});

// =============================================================================
// Global trauma dir resolution (GH #82): the installed guard and pre-commit hook
// must read the same global traumas.jsonl that `cm trauma add` writes via
// resolveGlobalDir(): CASS_MEMORY_HOME, then $XDG_DATA_HOME/cass-memory, then
// ~/.cass-memory.
// =============================================================================
describe("TRAUMA_GUARD_SCRIPT / GIT_PRECOMMIT_HOOK - global dir resolution (#82)", () => {
  const trauma: TraumaEntry = {
    id: "t-env",
    severity: "FATAL",
    pattern: "rm -rf /srv/data",
    scope: "global",
    status: "active",
    trigger_event: { session_path: "x", timestamp: "2026-09-01T00:00:00Z" },
    created_at: "2026-09-01T00:00:00Z",
  };

  async function writeTraumaFile(globalDir: string): Promise<void> {
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "traumas.jsonl"), JSON.stringify(trauma) + "\n");
  }

  function baseEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.CASS_MEMORY_HOME;
    delete env.XDG_DATA_HOME;
    return env;
  }

  function runGuard(dir: string, env: NodeJS.ProcessEnv) {
    return spawnSync("python3", [join(dir, "trauma_guard.py")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /srv/data" } }),
      encoding: "utf-8",
      timeout: 5000,
      cwd: dir,
      env,
    });
  }

  async function writeGuard(dir: string): Promise<void> {
    await writeFile(join(dir, "trauma_guard.py"), getPythonScript());
  }

  it("guard reads CASS_MEMORY_HOME/traumas.jsonl", async () => {
    await withTempDir("guard-cmhome", async (dir) => {
      await writeGuard(dir);
      await writeTraumaFile(join(dir, "cmhome"));
      const env = { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: join(dir, "cmhome") };
      const result = runGuard(dir, env);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });

  it("guard expands ~ in CASS_MEMORY_HOME", async () => {
    await withTempDir("guard-cmhome-tilde", async (dir) => {
      await writeGuard(dir);
      await writeTraumaFile(join(dir, "home", "custom-cm"));
      const env = { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: "~/custom-cm" };
      const result = runGuard(dir, env);
      expect(result.stdout).toContain("deny");
    });
  });

  it("guard reads $XDG_DATA_HOME/cass-memory/traumas.jsonl", async () => {
    await withTempDir("guard-xdg", async (dir) => {
      await writeGuard(dir);
      await writeTraumaFile(join(dir, "xdg", "cass-memory"));
      const env = { ...baseEnv(join(dir, "home")), XDG_DATA_HOME: join(dir, "xdg") };
      const result = runGuard(dir, env);
      expect(result.stdout).toContain("deny");
    });
  });

  it("CASS_MEMORY_HOME takes precedence over XDG_DATA_HOME and ~/.cass-memory", async () => {
    await withTempDir("guard-precedence", async (dir) => {
      await writeGuard(dir);
      // Trauma exists only under XDG and ~/.cass-memory; CASS_MEMORY_HOME is empty.
      await writeTraumaFile(join(dir, "xdg", "cass-memory"));
      await writeTraumaFile(join(dir, "home", ".cass-memory"));
      await mkdir(join(dir, "cmhome"), { recursive: true });
      const env = {
        ...baseEnv(join(dir, "home")),
        CASS_MEMORY_HOME: join(dir, "cmhome"),
        XDG_DATA_HOME: join(dir, "xdg"),
      };
      const result = runGuard(dir, env);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });
  });

  it("falls back to ~/.cass-memory when neither variable is set", async () => {
    await withTempDir("guard-default", async (dir) => {
      await writeGuard(dir);
      await writeTraumaFile(join(dir, "home", ".cass-memory"));
      const result = runGuard(dir, baseEnv(join(dir, "home")));
      expect(result.stdout).toContain("deny");
    });
  });

  it("pre-commit hook reads CASS_MEMORY_HOME/traumas.jsonl", async () => {
    await withTempDir("precommit-cmhome", async (dir) => {
      const script = getPythonScript(GIT_PRECOMMIT_HOOK).replace(
        /def get_staged_diff\(\):[\s\S]+?return result.stdout\n {4}except:\n {8}return ""/,
        'def get_staged_diff():\n    return """@@ -0,0 +1 @@\n+rm -rf /srv/data\n"""\n',
      );
      expect(script).toContain("+rm -rf /srv/data");
      const scriptPath = join(dir, "pre-commit.py");
      await writeFile(scriptPath, script);
      await writeTraumaFile(join(dir, "cmhome"));
      const result = spawnSync("python3", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        cwd: dir,
        env: { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: join(dir, "cmhome") },
      });
      expect(result.status).toBe(1);
    });
  });

  // The hook's environment can differ from cm's (CASS_MEMORY_HOME set only for
  // the `cm serve` daemon, a relative value resolved against another cwd).
  // `cm guard` bakes the dir it resolved into the script, and the hook reads
  // it in addition to the dir its own environment points at.
  it("installed guard reads the global dir baked in at install time when its env lacks the override", async () => {
    await withTempDir("guard-baked", async (dir) => {
      await writeFile(
        join(dir, "trauma_guard.py"),
        renderGuardScript(getPythonScript(), join(dir, "cmhome")),
      );
      await writeTraumaFile(join(dir, "cmhome"));
      // Neither variable set in the hook's environment.
      const result = runGuard(dir, baseEnv(join(dir, "home")));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });

  it("baked global dir is absolute even when cm resolved a relative CASS_MEMORY_HOME", async () => {
    await withTempDir("guard-baked-relative", async (dir) => {
      const originalCwd = process.cwd();
      let script: string;
      try {
        process.chdir(dir);
        script = renderGuardScript(getPythonScript(), "rel-cmhome");
      } finally {
        process.chdir(originalCwd);
      }
      await writeTraumaFile(join(dir, "rel-cmhome"));
      const hookCwd = join(dir, "elsewhere");
      await mkdir(hookCwd, { recursive: true });
      await writeFile(join(hookCwd, "trauma_guard.py"), script);
      // The hook sees the same relative value but runs from another cwd.
      const env = { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: "rel-cmhome" };
      const result = runGuard(hookCwd, env);
      expect(result.stdout).toContain("deny");
    });
  });

  it("baked dir and env dir are both enforced", async () => {
    await withTempDir("guard-baked-and-env", async (dir) => {
      await writeFile(
        join(dir, "trauma_guard.py"),
        renderGuardScript(getPythonScript(), join(dir, "baked-empty")),
      );
      await mkdir(join(dir, "baked-empty"), { recursive: true });
      await writeTraumaFile(join(dir, "cmhome"));
      const env = { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: join(dir, "cmhome") };
      expect(runGuard(dir, env).stdout).toContain("deny");
    });
  });

  it("expands ~name like cm's expandPath (under $HOME, not another user's home)", async () => {
    await withTempDir("guard-tilde-name", async (dir) => {
      await writeGuard(dir);
      await writeTraumaFile(join(dir, "home", "cmhome-x"));
      const env = { ...baseEnv(join(dir, "home")), CASS_MEMORY_HOME: "~cmhome-x" };
      expect(runGuard(dir, env).stdout).toContain("deny");
    });
  });

  it("an undecodable byte in traumas.jsonl does not drop the valid entries", async () => {
    await withTempDir("guard-bad-utf8", async (dir) => {
      await writeGuard(dir);
      const globalDir = join(dir, "home", ".cass-memory");
      await mkdir(globalDir, { recursive: true });
      await writeFile(
        join(globalDir, "traumas.jsonl"),
        Buffer.concat([
          Buffer.from('{"note":"'),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('"}\n'),
          Buffer.from(`${JSON.stringify(trauma)}\n`),
        ]),
      );
      expect(runGuard(dir, baseEnv(join(dir, "home"))).stdout).toContain("deny");
    });
  });

  it("renderGuardScript fills the placeholder in both scripts with a valid Python literal", async () => {
    await withTempDir("guard-render", async (dir) => {
      const weird = join(dir, 'we"ird\\dir');
      for (const template of [TRAUMA_GUARD_SCRIPT, GIT_PRECOMMIT_HOOK]) {
        const rendered = renderGuardScript(template, weird);
        expect(rendered).not.toContain("__CM_INSTALLED_GLOBAL_DIR__");
        const scriptPath = join(dir, "render.py");
        await writeFile(scriptPath, rendered);
        const probe = spawnSync(
          "python3",
          [
            "-c",
            "import ast,sys; t=ast.parse(open(sys.argv[1]).read()); print([n.value.value for n in t.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '')=='INSTALLED_GLOBAL_DIR'][0])",
            scriptPath,
          ],
          { encoding: "utf-8", timeout: 5000 },
        );
        expect(probe.status).toBe(0);
        expect(probe.stdout.trim()).toBe(weird);
      }
    });
  });
});

describe("cm guard --install / --git write refreshed scripts (#82)", () => {
  async function withCassHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd();
    const originalHome = process.env.CASS_MEMORY_HOME;
    try {
      process.chdir(dir);
      process.env.CASS_MEMORY_HOME = join(dir, "cmhome");
      return await fn();
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.CASS_MEMORY_HOME;
      else process.env.CASS_MEMORY_HOME = originalHome;
    }
  }

  it("--git refreshes an already-installed guard script instead of keeping the stale copy", async () => {
    await withTempDir("guard-git-refresh", async (dir) => {
      await withCassHome(dir, async () => {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        const { installGitHook } = await import("../src/commands/guard.js");
        expect(await installGitHook(false, true)).toBe(true);
        const scriptPath = join(dir, ".git", "hooks", "trauma-guard-precommit.py");
        // Simulate a pre-#82 install: stale script, wrapper already in place.
        await writeFile(scriptPath, "# stale guard\n");
        expect(await installGitHook(false, true)).toBe(true);
        const refreshed = await readFile(scriptPath, "utf-8");
        expect(refreshed).toContain("def global_trauma_files");
        expect(refreshed).toContain(JSON.stringify(join(dir, "cmhome")));
        const wrapper = await readFile(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
        expect(wrapper.match(/trauma-guard-precommit\.py/g)?.length).toBe(1);
      });
    });
  });

  it("--install bakes the resolved global dir into trauma_guard.py", async () => {
    await withTempDir("guard-install-baked", async (dir) => {
      await withCassHome(dir, async () => {
        await mkdir(join(dir, ".claude"), { recursive: true });
        const { installGuard } = await import("../src/commands/guard.js");
        await installGuard(false, true);
        const script = await readFile(join(dir, ".claude", "hooks", "trauma_guard.py"), "utf-8");
        expect(script).toContain(`INSTALLED_GLOBAL_DIR = ${JSON.stringify(join(dir, "cmhome"))}`);
      });
    });
  });
});
