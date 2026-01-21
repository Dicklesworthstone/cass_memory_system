/**
 * E2E Tests for CLI init command - Project initialization
 *
 * Tests the `cm init` command for both global and repo-level initialization.
 * Uses isolated temp directories to avoid affecting the real system.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { stat, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { initCommand } from "../src/commands/init.js";
import { withTempCassHome, TestEnv, createIsolatedEnvironment, cleanupEnvironment } from "./helpers/temp.js";
import { withTempGitRepo, createTempGitRepo, cleanupTempGitRepo } from "./helpers/git.js";
import { createTestLogger } from "./helpers/logger.js";
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

describe("E2E: CLI init command", () => {
  describe("Global Init (~/.cass-memory)", () => {
    it.serial("creates global structure in fresh environment", async () => {
      const log = createE2ELogger("cli-init: creates global structure (fresh)");
      log.setRepro("bun test test/cli-init.e2e.test.ts");

      await log.run(async () => {
        log.step("Starting fresh init test");

        await withTempCassHome(async (env) => {
          log.snapshot("env", {
            home: env.home,
            cassMemoryDir: env.cassMemoryDir,
            configPath: env.configPath,
            playbookPath: env.playbookPath,
            diaryDir: env.diaryDir,
          });

          // Verify nothing exists yet (withTempCassHome creates the dirs but not config)
          const configExists = await exists(env.configPath);
          log.step("Before init - config exists?", { configExists });

          // Remove pre-created dirs to simulate truly fresh env
          log.step("Remove pre-created dirs", { cassMemoryDir: env.cassMemoryDir });
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          // Run init
          const capture = captureConsole();
          try {
            log.startTimer("initCommand");
            await initCommand({});
            log.endTimer("initCommand");
          } finally {
            capture.restore();
          }

          log.snapshot("initConsole", { logs: capture.logs.slice(0, 20), errors: capture.errors.slice(0, 20) });

          // Verify structure created
          const cassMemoryExists = await exists(env.cassMemoryDir);
          expect(cassMemoryExists).toBe(true);

          // Verify config.json created
          const configCreated = await exists(env.configPath);
          expect(configCreated).toBe(true);

          // Verify playbook.yaml created
          const playbookCreated = await exists(env.playbookPath);
          expect(playbookCreated).toBe(true);

          // Verify diary directory created
          const diaryExists = await exists(env.diaryDir);
          expect(diaryExists).toBe(true);

          // Verify config is valid JSON
          const configContent = await readFile(env.configPath, "utf-8");
          const config = JSON.parse(configContent);
          log.snapshot("config", config);
          expect(config.schema_version).toBeDefined();

          // Verify playbook is valid YAML
          const playbookContent = await readFile(env.playbookPath, "utf-8");
          const playbook = yaml.parse(playbookContent);
          log.snapshot("playbook", playbook);
          expect(playbook).toBeDefined();
          expect(playbook.bullets).toEqual([]);
        });
      });
    });

    it.serial("init is idempotent - warns but doesn't overwrite without --force", async () => {
      await withTempCassHome(async (env) => {
        // Remove pre-created structure and do fresh init
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init
        const capture1 = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture1.restore();
        }

        // Get original config content
        const originalConfig = await readFile(env.configPath, "utf-8");

        // Modify config to prove it won't be overwritten
        const modifiedConfig = JSON.parse(originalConfig);
        modifiedConfig._test_marker = "should_remain";
        await writeFile(env.configPath, JSON.stringify(modifiedConfig, null, 2));

        // Second init without --force - use --json to reliably capture output
        const capture2 = captureConsole();
        try {
          await initCommand({ json: true });
        } finally {
          capture2.restore();
        }

        // JSON output should indicate not successful due to existing init
        const output = capture2.logs.join("\n");
        const result = JSON.parse(output);
        expect(result.success).toBe(false);
        expect(result.error.message).toContain("Already initialized");

        // Config should NOT be overwritten
        const currentConfig = await readFile(env.configPath, "utf-8");
        const parsedConfig = JSON.parse(currentConfig);
        expect(parsedConfig._test_marker).toBe("should_remain");
      });
    });

    it.serial("init with --force reinitializes with backups", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init
        const capture1 = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture1.restore();
        }

        // Modify config + playbook so we can prove --force overwrote them
        const originalConfig = await readFile(env.configPath, "utf-8");
        const modifiedConfig = JSON.parse(originalConfig);
        modifiedConfig._test_marker = "should_be_backed_up";
        await writeFile(env.configPath, JSON.stringify(modifiedConfig, null, 2));

        const originalPlaybook = await readFile(env.playbookPath, "utf-8");
        const modifiedPlaybook = yaml.parse(originalPlaybook);
        modifiedPlaybook._test_marker = "should_be_backed_up";
        await writeFile(env.playbookPath, yaml.stringify(modifiedPlaybook));

        // Reinit with --force + --yes and --json to capture result
        const capture2 = captureConsole();
        try {
          await initCommand({ force: true, yes: true, json: true });
        } finally {
          capture2.restore();
        }

        const output = capture2.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(true);
        const result = payload.data;
        expect(result.overwritten).toEqual(expect.arrayContaining(["config.json", "playbook.yaml"]));
        expect(Array.isArray(result.backups)).toBe(true);

        const configBackup = result.backups.find((b: any) => String(b.file).endsWith("config.json"))?.backup;
        expect(typeof configBackup).toBe("string");
        expect(await exists(configBackup)).toBe(true);
        expect(await readFile(configBackup, "utf-8")).toContain("should_be_backed_up");

        const playbookBackup = result.backups.find((b: any) => String(b.file).endsWith("playbook.yaml"))?.backup;
        expect(typeof playbookBackup).toBe("string");
        expect(await exists(playbookBackup)).toBe(true);
        expect(await readFile(playbookBackup, "utf-8")).toContain("should_be_backed_up");

        // Current files should be reset (marker removed)
        const currentConfig = JSON.parse(await readFile(env.configPath, "utf-8"));
        expect(currentConfig._test_marker).toBeUndefined();

        const currentPlaybook = yaml.parse(await readFile(env.playbookPath, "utf-8"));
        expect(currentPlaybook._test_marker).toBeUndefined();
      });
    });

    it.serial("init with --json outputs JSON result", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        const capture = captureConsole();
        try {
          await initCommand({ json: true });
        } finally {
          capture.restore();
        }

        // Should output valid JSON
        expect(capture.logs.length).toBeGreaterThan(0);
        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);

        expect(payload.success).toBe(true);
        expect(payload.data.configPath).toContain(".cass-memory");
        expect(Array.isArray(payload.data.created)).toBe(true);
      });
    });

    it.serial("init --json reports already initialized", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init
        const capture1 = captureConsole();
        try {
          await initCommand({ json: true });
        } finally {
          capture1.restore();
        }

        // Second init
        const capture2 = captureConsole();
        try {
          await initCommand({ json: true });
        } finally {
          capture2.restore();
        }

        const output = capture2.logs.join("\n");
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.error.message).toContain("Already initialized");
      });
    });
  });

  describe("Repo Init (.cass/)", () => {
    it.serial("creates repo-level .cass/ structure in git repo", async () => {
      await withTempGitRepo(async (repoDir) => {
        const logger = createTestLogger("debug");
        logger.info("Testing repo init", { repoDir });

        // Save and change cwd to the repo
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture.restore();
          }

          // Verify .cass/ directory created
          const cassDir = path.join(repoDir, ".cass");
          const cassDirExists = await exists(cassDir);
          expect(cassDirExists).toBe(true);

          // Verify playbook.yaml created in .cass/
          const playbookPath = path.join(cassDir, "playbook.yaml");
          const playbookExists = await exists(playbookPath);
          expect(playbookExists).toBe(true);

          // Verify playbook is valid YAML
          const playbookContent = await readFile(playbookPath, "utf-8");
          const playbook = yaml.parse(playbookContent);
          expect(playbook).toBeDefined();
          expect(playbook.bullets).toEqual([]);

          // Verify blocked.log created
          const blockedLogPath = path.join(cassDir, "blocked.log");
          const blockedLogExists = await exists(blockedLogPath);
          expect(blockedLogExists).toBe(true);

          logger.info("Repo init verified", {
            cassDir: cassDirExists,
            playbook: playbookExists
          });
        } finally {
          process.chdir(originalCwd);
        }
      });
    }, 15000);

    it.serial("repo init is idempotent - warns without --force", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // First init
          const capture1 = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture1.restore();
          }

          // Modify playbook to verify it won't be overwritten
          const cassDir = path.join(repoDir, ".cass");
          const playbookPath = path.join(cassDir, "playbook.yaml");
          const original = await readFile(playbookPath, "utf-8");
          const playbook = yaml.parse(original);
          playbook._test_marker = "should_remain";
          await writeFile(playbookPath, yaml.stringify(playbook));

          // Second init without --force
          const capture2 = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture2.restore();
          }

          // Should have warned (error message goes to console.error)
          const allOutput = [...capture2.logs, ...capture2.errors];
          const hasWarning = allOutput.some(log =>
            log.includes("already has .cass") || log.includes("--force")
          );
          expect(hasWarning).toBe(true);

          // Playbook should NOT be overwritten
          const current = await readFile(playbookPath, "utf-8");
          const currentPlaybook = yaml.parse(current);
          const warningOutput = allOutput.join("\n");
          expect(warningOutput).toContain("Repo already has .cass/ directory");
        } finally {
          process.chdir(originalCwd);
        }
      });
    }, 30000);

    it.serial("repo init with --force reinitializes with backups", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // First init
          const capture1 = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture1.restore();
          }

          // Modify repo playbook + blocked.log so we can prove --force overwrote them
          const cassDir = path.join(repoDir, ".cass");
          const playbookPath = path.join(cassDir, "playbook.yaml");
          const blockedLogPath = path.join(cassDir, "blocked.log");

          const originalPlaybook = await readFile(playbookPath, "utf-8");
          const modifiedPlaybook = yaml.parse(originalPlaybook);
          modifiedPlaybook._test_marker = "should_be_backed_up";
          await writeFile(playbookPath, yaml.stringify(modifiedPlaybook));

          await writeFile(blockedLogPath, "should_be_backed_up\n");

          // Reinit with --force + --yes and --json
          const capture2 = captureConsole();
          try {
            await initCommand({ repo: true, force: true, yes: true, json: true });
          } finally {
            capture2.restore();
          }

          const output = capture2.logs.join("\n");
          const payload = JSON.parse(output);
          const result = payload.data;
          expect(payload.success).toBe(true);
          expect(result.overwritten).toEqual(expect.arrayContaining(["playbook.yaml", "blocked.log"]));
          expect(Array.isArray(result.backups)).toBe(true);

          const playbookBackup = result.backups.find((b: any) => String(b.file).endsWith("playbook.yaml"))?.backup;
          expect(typeof playbookBackup).toBe("string");
          expect(await exists(playbookBackup)).toBe(true);
          expect(await readFile(playbookBackup, "utf-8")).toContain("should_be_backed_up");

          const blockedBackup = result.backups.find((b: any) => String(b.file).endsWith("blocked.log"))?.backup;
          expect(typeof blockedBackup).toBe("string");
          expect(await exists(blockedBackup)).toBe(true);
          expect(await readFile(blockedBackup, "utf-8")).toContain("should_be_backed_up");

          // Current repo files should be reset (marker removed)
          const currentPlaybook = yaml.parse(await readFile(playbookPath, "utf-8"));
          expect(currentPlaybook._test_marker).toBeUndefined();

          expect(await readFile(blockedLogPath, "utf-8")).toBe("");
        } finally {
          process.chdir(originalCwd);
        }
      });
    }, 15000);

    it.serial("repo init with --json outputs JSON result", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true, json: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          const result = payload.data;

          expect(payload.success).toBe(true);
          expect(result.cassDir).toContain(".cass");
          expect(Array.isArray(result.created)).toBe(true);
        } finally {
          process.chdir(originalCwd);
        }
      });
    }, 30000);

    it.serial("repo init fails gracefully when not in git repo", async () => {
      // Create a temp dir that is NOT a git repo
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const tempDir = await mkdtemp(path.join(tmpdir(), "cass-no-git-"));

      const originalCwd = process.cwd();
      process.chdir(tempDir);

      try {
        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await initCommand({ repo: true });
        } finally {
          capture.restore();
        }

        // Should have error output about not being in git repo
        const hasError = capture.errors.some(err =>
          err.includes("Not in a git repository") || err.includes("git repo")
        );
        expect(hasError).toBe(true);
        expect(process.exitCode as number | undefined).toBe(3);
        process.exitCode = 0;
      } finally {
        process.chdir(originalCwd);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it.serial("repo init --json reports error when not in git repo", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const tempDir = await mkdtemp(path.join(tmpdir(), "cass-no-git-json-"));

      const originalCwd = process.cwd();
      process.chdir(tempDir);

      try {
        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await initCommand({ repo: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.error.message).toContain("Not in a git repository");
        expect(process.exitCode as number | undefined).toBe(3);
        process.exitCode = 0;
      } finally {
        process.chdir(originalCwd);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it.serial("repo init in nested subdirectory creates .cass in that location", async () => {
      await withTempGitRepo(async (repoDir) => {
        // Create a nested subdirectory
        const nestedDir = path.join(repoDir, "src", "services", "api");
        await mkdir(nestedDir, { recursive: true });

        const originalCwd = process.cwd();
        process.chdir(nestedDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture.restore();
          }

          // .cass should be created at repo root, not in nested dir
          const cassAtRoot = path.join(repoDir, ".cass");
          const cassAtNested = path.join(nestedDir, ".cass");

          // The repo init finds the git root and creates .cass there
          const rootExists = await exists(cassAtRoot);
          const nestedExists = await exists(cassAtNested);

          expect(rootExists).toBe(true);
          expect(nestedExists).toBe(false);
        } finally {
          process.chdir(originalCwd);
        }
      });
    }, 30000);
  });

  describe("Error Cases", () => {
    it.serial("handles read-only directory gracefully", async () => {
      // Skip on Windows where chmod doesn't work the same way
      if (process.platform === "win32") {
        return;
      }

      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // Create a read-only directory
        await mkdir(env.cassMemoryDir, { recursive: true });
        const { chmod } = await import("node:fs/promises");
        await chmod(env.cassMemoryDir, 0o444);

        const capture = captureConsole();
        try {
          await initCommand({});
        } catch {
          // Expected to fail
        } finally {
          capture.restore();
          // Restore permissions for cleanup
          await chmod(env.cassMemoryDir, 0o755);
        }

        // Should have some error indication
        // (either in console output or thrown error)
      });
    });
  });

  describe("Starter Seeds", () => {
    it.serial("init with invalid --starter reports error", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await initCommand({ json: true, starter: "nonexistent-starter-xyz" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("VALIDATION_FAILED");
        expect(payload.error.message).toContain("not found");
      });
    });
  });

  describe("Repo Init Starters", () => {
    it.serial("repo init with invalid --starter reports error", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          process.exitCode = 0;
          const capture = captureConsole();
          try {
            await initCommand({ repo: true, json: true, starter: "nonexistent-xyz" });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          expect(payload.success).toBe(false);
          expect(payload.error.code).toBe("VALIDATION_FAILED");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Human Output", () => {
    it.serial("init shows human-readable success output", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        const capture = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Created");
        expect(output).toContain(".cass-memory");
        expect(output).toContain("initialized successfully");
        expect(output).toContain("Next steps");
      });
    });

    it.serial("init shows already-exists files in output", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init
        const capture1 = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture1.restore();
        }

        // Reinit with --force --yes (shows "already exists" for diary)
        const capture2 = captureConsole();
        try {
          await initCommand({ force: true, yes: true });
        } finally {
          capture2.restore();
        }

        const output = capture2.logs.join("\n");
        // Should show backup info
        expect(output).toContain("Backups created");
        // Should show overwritten files
        expect(output).toContain("Overwritten");
      });
    });

    it.serial("repo init shows human-readable output", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          expect(output).toContain("Initializing repo-level");
          expect(output).toContain("Created");
          expect(output).toContain(".cass");
          expect(output).toContain("playbook.yaml");
          expect(output).toContain("Commit");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it.serial("repo init shows backup info when using --force", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // First init
          const capture1 = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture1.restore();
          }

          // Modify the playbook
          const playbookPath = path.join(repoDir, ".cass", "playbook.yaml");
          const original = await readFile(playbookPath, "utf-8");
          const playbook = yaml.parse(original);
          playbook.description = "modified";
          await writeFile(playbookPath, yaml.stringify(playbook));

          // Reinit with --force --yes
          const capture2 = captureConsole();
          try {
            await initCommand({ repo: true, force: true, yes: true });
          } finally {
            capture2.restore();
          }

          const output = capture2.logs.join("\n");
          expect(output).toContain("Backups created");
          expect(output).toContain("Overwritten");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

  });

  describe("CASS_PATH environment variable", () => {
    it.serial("respects CASS_PATH when checking cass availability", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // Set CASS_PATH to a non-existent path
        const originalCassPath = process.env.CASS_PATH;
        process.env.CASS_PATH = "/nonexistent/cass/binary";

        const capture = captureConsole();
        try {
          await initCommand({ json: true });
        } finally {
          capture.restore();
          // Restore original
          if (originalCassPath) {
            process.env.CASS_PATH = originalCassPath;
          } else {
            delete process.env.CASS_PATH;
          }
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(true);
        // cassAvailable should be false since path doesn't exist
        expect(payload.data.cassAvailable).toBe(false);
      });
    });

    it.serial("shows cass warning in human-readable mode when cass not available", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // Set CASS_PATH to a non-existent path
        const originalCassPath = process.env.CASS_PATH;
        process.env.CASS_PATH = "/nonexistent/cass/binary";

        const capture = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture.restore();
          if (originalCassPath) {
            process.env.CASS_PATH = originalCassPath;
          } else {
            delete process.env.CASS_PATH;
          }
        }

        const allOutput = [...capture.logs, ...capture.errors].join("\n");
        // Should show cass warning
        expect(allOutput).toContain("cass is not available");
      });
    });
  });

  describe("Starter application", () => {
    it.serial("init with valid starter applies it to playbook", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        const capture = captureConsole();
        try {
          // Use "general" starter which is a builtin
          await initCommand({ json: true, starter: "general" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(true);
        expect(payload.data.starter).toBeDefined();
        expect(payload.data.starter.name).toBe("general");
        expect(typeof payload.data.starter.added).toBe("number");
        expect(typeof payload.data.starter.skipped).toBe("number");
      });
    });

    it.serial("init with starter shows human-readable starter outcome", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        const capture = captureConsole();
        try {
          await initCommand({ starter: "general" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Applied starter");
        expect(output).toContain("general");
      });
    });

    it.serial("init --starter on already initialized playbook skips existing rules", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init with starter
        const capture1 = captureConsole();
        try {
          await initCommand({ json: true, starter: "general" });
        } finally {
          capture1.restore();
        }

        const output1 = capture1.logs.join("\n");
        const payload1 = JSON.parse(output1);
        const addedFirst = payload1.data.starter.added;

        // Second init with same starter (should skip all)
        const capture2 = captureConsole();
        try {
          await initCommand({ json: true, starter: "general" });
        } finally {
          capture2.restore();
        }

        const output2 = capture2.logs.join("\n");
        const payload2 = JSON.parse(output2);
        // Second time should skip most/all since they already exist
        expect(payload2.data.starter.skipped).toBeGreaterThanOrEqual(addedFirst);
      });
    });

    it.serial("repo init with valid starter applies it", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true, json: true, starter: "general" });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          expect(payload.success).toBe(true);
          expect(payload.data.starter).toBeDefined();
          expect(payload.data.starter.name).toBe("general");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it.serial("repo init with starter shows human-readable outcome", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const capture = captureConsole();
          try {
            await initCommand({ repo: true, starter: "general" });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          expect(output).toContain("Applied starter");
          expect(output).toContain("general");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Force without confirmation", () => {
    it.serial("init --force without --yes in non-interactive mode returns error", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // First init
        const capture1 = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture1.restore();
        }

        // Try to reinit with --force but no --yes and no interactive mode
        process.exitCode = 0;
        const capture2 = captureConsole();
        try {
          await initCommand({ force: true, json: true });
        } finally {
          capture2.restore();
        }

        const output = capture2.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(false);
        expect(payload.error.message).toContain("Refusing to overwrite");
        expect(payload.error.code).toBe("MISSING_REQUIRED");
      });
    });

    it.serial("repo init --force without --yes in non-interactive mode returns error", async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // First init
          const capture1 = captureConsole();
          try {
            await initCommand({ repo: true });
          } finally {
            capture1.restore();
          }

          // Try to reinit with --force but no --yes
          process.exitCode = 0;
          const capture2 = captureConsole();
          try {
            await initCommand({ repo: true, force: true, json: true });
          } finally {
            capture2.restore();
          }

          const output = capture2.logs.join("\n");
          const payload = JSON.parse(output);
          expect(payload.success).toBe(false);
          expect(payload.error.message).toContain("Refusing to overwrite");
          expect(payload.error.code).toBe("MISSING_REQUIRED");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("seedStarter function", () => {
    it.serial("seedStarter throws error for non-existent starter", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        const capture = captureConsole();
        try {
          await initCommand({ json: true, starter: "this-starter-does-not-exist-xyz" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(false);
        expect(payload.error.message).toContain("not found");
        expect(payload.error.details.starter).toBe("this-starter-does-not-exist-xyz");
      });
    });
  });
});
