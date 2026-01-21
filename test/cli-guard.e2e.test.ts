/**
 * E2E Tests for CLI guard command - Trauma guard installation
 *
 * Tests the `cm guard --install` command for installing pre-commit hooks
 * that block dangerous commands matching registered trauma patterns.
 * Uses isolated temp directories to avoid affecting the real system.
 */
import { describe, it, expect } from "bun:test";
import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { guardCommand, installGuard } from "../src/commands/guard.js";
import { withTempDir } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

// Helper to check if a file exists
async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Helper to capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

// Helper to create a mock .claude directory structure
async function createClaudeDir(baseDir: string): Promise<string> {
  const claudeDir = path.join(baseDir, ".claude");
  await mkdir(claudeDir, { recursive: true });
  return claudeDir;
}

describe("E2E: CLI guard command", () => {
  describe("guardCommand entry point", () => {
    it("reports error when --install flag is missing", async () => {
      const log = createE2ELogger("guard: missing install flag");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-missing-flag", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("Changed to temp dir with .claude", { tempDir });

            const capture = captureConsole();
            try {
              log.startTimer("guardCommand");
              await guardCommand({});
              log.endTimer("guardCommand");
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report missing required flag
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("Missing required flag");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("reports error in JSON mode when --install flag is missing", async () => {
      const log = createE2ELogger("guard: missing install flag (JSON)");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-missing-flag-json", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            const capture = captureConsole();
            try {
              await guardCommand({ json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // In JSON mode, should output valid JSON error
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            // Check that error is communicated (either via JSON or text)
            expect(allOutput.toLowerCase()).toMatch(/missing|required|install/);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("installGuard function", () => {
    it("installs guard successfully in a .claude project", async () => {
      const log = createE2ELogger("guard: successful install");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-install", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("Created .claude directory", { claudeDir });

            const capture = captureConsole();
            try {
              log.startTimer("installGuard");
              await installGuard(false);
              log.endTimer("installGuard");
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify script was created
            const hooksDir = path.join(claudeDir, "hooks");
            const scriptPath = path.join(hooksDir, "trauma_guard.py");
            const scriptExists = await exists(scriptPath);
            log.step("Script created", { scriptPath, scriptExists });
            expect(scriptExists).toBe(true);

            // Verify script is executable (has shebang)
            const scriptContent = await readFile(scriptPath, "utf-8");
            expect(scriptContent).toContain("#!/usr/bin/env python3");
            expect(scriptContent).toContain("HOT STOVE");

            // Verify settings.json was created/updated
            const settingsPath = path.join(claudeDir, "settings.json");
            const settingsExists = await exists(settingsPath);
            log.step("Settings updated", { settingsPath, settingsExists });
            expect(settingsExists).toBe(true);

            const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
            log.snapshot("settings", settings);

            // Verify hook structure
            expect(settings.hooks).toBeDefined();
            expect(settings.hooks.PreToolUse).toBeDefined();
            expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
            expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);

            // Verify the hook entry
            const hookEntry = settings.hooks.PreToolUse[0];
            expect(hookEntry.matcher).toBe("Bash");
            expect(hookEntry.hooks[0].type).toBe("command");
            expect(hookEntry.hooks[0].command).toContain("trauma_guard.py");

            // Verify console output
            const allLogs = capture.logs.join("\n");
            expect(allLogs).toContain("Installed");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("installation is idempotent (running twice doesn't duplicate)", async () => {
      const log = createE2ELogger("guard: idempotent install");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-idempotent", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("Created .claude directory", { claudeDir });

            // First install
            const capture1 = captureConsole();
            try {
              await installGuard(false);
            } finally {
              capture1.restore();
            }
            log.step("First install completed", { logs: capture1.logs });

            // Second install
            const capture2 = captureConsole();
            try {
              await installGuard(false);
            } finally {
              capture2.restore();
            }
            log.step("Second install completed", { logs: capture2.logs });

            // Verify settings.json has only ONE hook entry
            const settingsPath = path.join(claudeDir, "settings.json");
            const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
            log.snapshot("settings after 2 installs", settings);

            // Should only have 1 PreToolUse entry (not duplicated)
            expect(settings.hooks.PreToolUse.length).toBe(1);

            // Second install should say "already installed"
            const secondOutput = capture2.logs.join("\n");
            expect(secondOutput).toContain("Verified");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("reports error when no .claude directory exists", async () => {
      const log = createE2ELogger("guard: no .claude directory");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-no-claude", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("Changed to temp dir WITHOUT .claude", { tempDir });

            const capture = captureConsole();
            try {
              await installGuard(false);
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report error about missing .claude
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain(".claude");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("outputs valid JSON in JSON mode", async () => {
      const log = createE2ELogger("guard: JSON output mode");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-json", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            const capture = captureConsole();
            try {
              await installGuard(true); // json=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should output valid JSON
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.command).toBe("guard");
            expect(parsed.data).toBeDefined();
            expect(parsed.data.message).toContain("installed");
            expect(parsed.data.scriptPath).toContain("trauma_guard.py");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("handles malformed settings.json gracefully", async () => {
      const log = createE2ELogger("guard: malformed settings.json");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-malformed", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Write malformed settings.json
            const settingsPath = path.join(claudeDir, "settings.json");
            await writeFile(settingsPath, "{ invalid json here", "utf-8");
            log.step("Created malformed settings.json");

            const capture = captureConsole();
            try {
              await installGuard(false);
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report error about invalid JSON
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput.toLowerCase()).toMatch(/invalid|parse|json/);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("preserves existing settings.json content", async () => {
      const log = createE2ELogger("guard: preserves existing settings");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-preserve", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Write existing settings.json with some content
            const settingsPath = path.join(claudeDir, "settings.json");
            const existingSettings = {
              theme: "dark",
              someOtherSetting: true,
              hooks: {
                PostToolUse: [{ matcher: "Write", hooks: [] }]
              }
            };
            await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2), "utf-8");
            log.step("Created existing settings.json with custom content");

            const capture = captureConsole();
            try {
              await installGuard(false);
            } finally {
              capture.restore();
            }

            // Verify existing content preserved
            const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
            log.snapshot("settings after install", settings);

            expect(settings.theme).toBe("dark");
            expect(settings.someOtherSetting).toBe(true);
            expect(settings.hooks.PostToolUse).toBeDefined();
            expect(settings.hooks.PreToolUse).toBeDefined();
            expect(settings.hooks.PreToolUse.length).toBe(1);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("silent mode produces no console output", async () => {
      const log = createE2ELogger("guard: silent mode");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-silent", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            const capture = captureConsole();
            try {
              await installGuard(false, true); // json=false, silent=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Silent mode should produce no output
            expect(capture.logs.length).toBe(0);
            expect(capture.errors.length).toBe(0);

            // But the script should still be installed
            const scriptPath = path.join(claudeDir, "hooks", "trauma_guard.py");
            const scriptExists = await exists(scriptPath);
            expect(scriptExists).toBe(true);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("silent mode returns early when .claude missing (no error)", async () => {
      const log = createE2ELogger("guard: silent mode no .claude");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-silent-no-claude", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("No .claude directory present");

            const capture = captureConsole();
            try {
              await installGuard(false, true); // json=false, silent=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Silent mode should produce no output even on error
            expect(capture.logs.length).toBe(0);
            expect(capture.errors.length).toBe(0);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("installGitHook function", () => {
    it("installs git pre-commit hook successfully", async () => {
      const log = createE2ELogger("guard: git hook install");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-hook", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });
            log.step("Initialized git repo", { tempDir });

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              log.startTimer("installGitHook");
              result = await installGitHook(false);
              log.endTimer("installGitHook");
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors, result });

            // Should succeed
            expect(result).toBe(true);

            // Verify guard script was created
            const gitHooksDir = path.join(tempDir, ".git", "hooks");
            const guardScriptPath = path.join(gitHooksDir, "trauma-guard-precommit.py");
            const guardScriptExists = await exists(guardScriptPath);
            log.step("Guard script created", { guardScriptPath, guardScriptExists });
            expect(guardScriptExists).toBe(true);

            // Verify pre-commit hook was created
            const preCommitPath = path.join(gitHooksDir, "pre-commit");
            const preCommitExists = await exists(preCommitPath);
            log.step("Pre-commit hook created", { preCommitPath, preCommitExists });
            expect(preCommitExists).toBe(true);

            // Verify pre-commit hook calls the guard script
            const preCommitContent = await readFile(preCommitPath, "utf-8");
            expect(preCommitContent).toContain("trauma-guard-precommit.py");
            expect(preCommitContent).toContain("#!/bin/sh");

            // Verify guard script content
            const guardScriptContent = await readFile(guardScriptPath, "utf-8");
            expect(guardScriptContent).toContain("#!/usr/bin/env python3");
            expect(guardScriptContent).toContain("HOT STOVE");

            // Verify console output
            const allLogs = capture.logs.join("\n");
            expect(allLogs).toContain("Installed");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("git hook installation is idempotent", async () => {
      const log = createE2ELogger("guard: git hook idempotent");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-idempotent", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            const { installGitHook } = await import("../src/commands/guard.js");

            // First install
            const capture1 = captureConsole();
            let result1: boolean;
            try {
              result1 = await installGitHook(false);
            } finally {
              capture1.restore();
            }
            log.step("First install completed", { result: result1, logs: capture1.logs });

            // Second install
            const capture2 = captureConsole();
            let result2: boolean;
            try {
              result2 = await installGitHook(false);
            } finally {
              capture2.restore();
            }
            log.step("Second install completed", { result: result2, logs: capture2.logs });

            // Both should succeed
            expect(result1).toBe(true);
            expect(result2).toBe(true);

            // Second install should say "already installed"
            const secondOutput = capture2.logs.join("\n");
            expect(secondOutput).toContain("already installed");

            // Verify only one guard script invocation in pre-commit hook
            const preCommitPath = path.join(tempDir, ".git", "hooks", "pre-commit");
            const preCommitContent = await readFile(preCommitPath, "utf-8");
            const matches = preCommitContent.match(/trauma-guard-precommit\.py/g) || [];
            expect(matches.length).toBe(1);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("returns false when not in git repo", async () => {
      const log = createE2ELogger("guard: git hook no repo");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-no-repo", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("Changed to temp dir WITHOUT git repo", { tempDir });

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              result = await installGitHook(false);
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors, result });

            // Should return false
            expect(result).toBe(false);

            // Should report error about not being in git repo
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput.toLowerCase()).toMatch(/git|repository/);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("outputs valid JSON in JSON mode", async () => {
      const log = createE2ELogger("guard: git hook JSON output");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-json", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              result = await installGitHook(true); // json=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors, result });

            // Should output valid JSON
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.command).toBe("guard");
            expect(parsed.data).toBeDefined();
            expect(parsed.data.message).toContain("installed");
            expect(parsed.data.hookPath).toContain("pre-commit");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("silent mode produces no console output", async () => {
      const log = createE2ELogger("guard: git hook silent mode");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-silent", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              result = await installGitHook(false, true); // json=false, silent=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors, result });

            // Silent mode should produce no output
            expect(capture.logs.length).toBe(0);
            expect(capture.errors.length).toBe(0);

            // But the hook should still be installed
            expect(result).toBe(true);
            const preCommitPath = path.join(tempDir, ".git", "hooks", "pre-commit");
            expect(await exists(preCommitPath)).toBe(true);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("silent mode returns false when not in git repo (no error)", async () => {
      const log = createE2ELogger("guard: git hook silent no repo");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-silent-no-repo", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);
            log.step("No git repo present");

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              result = await installGitHook(false, true); // json=false, silent=true
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors, result });

            // Silent mode should produce no output even on error
            expect(capture.logs.length).toBe(0);
            expect(capture.errors.length).toBe(0);
            expect(result).toBe(false);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("appends to existing pre-commit hook", async () => {
      const log = createE2ELogger("guard: append to existing hook");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-append", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            // Create existing pre-commit hook
            const gitHooksDir = path.join(tempDir, ".git", "hooks");
            const preCommitPath = path.join(gitHooksDir, "pre-commit");
            const existingHook = `#!/bin/sh
# Existing pre-commit hook
echo "Running existing hook"
npm test
`;
            await writeFile(preCommitPath, existingHook, { mode: 0o755 });
            log.step("Created existing pre-commit hook");

            const { installGitHook } = await import("../src/commands/guard.js");

            const capture = captureConsole();
            let result: boolean;
            try {
              result = await installGitHook(false);
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, result });

            expect(result).toBe(true);

            // Verify existing content preserved and hook appended
            const updatedHook = await readFile(preCommitPath, "utf-8");
            log.snapshot("updated hook content", updatedHook);

            expect(updatedHook).toContain("Existing pre-commit hook");
            expect(updatedHook).toContain("npm test");
            expect(updatedHook).toContain("trauma-guard-precommit.py");
            expect(updatedHook).toContain("Hot Stove");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("guardCommand with --git flag", () => {
    it("calls installGitHook when --git flag is provided", async () => {
      const log = createE2ELogger("guard: --git flag");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-flag", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            const capture = captureConsole();
            try {
              await guardCommand({ git: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify hook was installed
            const preCommitPath = path.join(tempDir, ".git", "hooks", "pre-commit");
            expect(await exists(preCommitPath)).toBe(true);

            const allLogs = capture.logs.join("\n");
            expect(allLogs).toContain("Installed");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("cm guard --git --json works end-to-end", async () => {
      const log = createE2ELogger("guard: --git --json e2e");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-git-json-e2e", async (tempDir) => {
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            // Initialize git repo
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            await promisify(exec)("git init", { cwd: tempDir });

            const capture = captureConsole();
            try {
              await guardCommand({ git: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should output valid JSON
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            expect(parsed.success).toBe(true);
            expect(parsed.data.message).toContain("installed");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("integration with full CLI", () => {
    it("cm guard --install --json works end-to-end", async () => {
      const log = createE2ELogger("guard: full CLI e2e");
      log.setRepro("bun test test/cli-guard.e2e.test.ts");

      await log.run(async () => {
        await withTempDir("guard-full-cli", async (tempDir) => {
          const claudeDir = await createClaudeDir(tempDir);
          const originalCwd = process.cwd();

          try {
            process.chdir(tempDir);

            const capture = captureConsole();
            try {
              await guardCommand({ install: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should output valid JSON
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            expect(parsed.success).toBe(true);
            expect(parsed.data.message).toContain("installed");

            // Verify actual files created
            const scriptPath = path.join(claudeDir, "hooks", "trauma_guard.py");
            expect(await exists(scriptPath)).toBe(true);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });
});
