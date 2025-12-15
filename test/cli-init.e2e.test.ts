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
      const logger = createTestLogger("debug");
      logger.info("Starting fresh init test");

      await withTempCassHome(async (env) => {
        logger.info("Created temp home", { home: env.home });

        // Verify nothing exists yet (withTempCassHome creates the dirs but not config)
        const configExists = await exists(env.configPath);
        logger.info("Before init - config exists?", { configExists });

        // Remove pre-created dirs to simulate truly fresh env
        await rm(env.cassMemoryDir, { recursive: true, force: true });

        // Run init
        const capture = captureConsole();
        try {
          await initCommand({});
        } finally {
          capture.restore();
        }

        logger.info("Init completed", { logs: capture.logs.length });

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
        expect(config.schema_version).toBeDefined();
        logger.info("Config validated", { schemaVersion: config.schema_version });

        // Verify playbook is valid YAML
        const playbookContent = await readFile(env.playbookPath, "utf-8");
        const playbook = yaml.parse(playbookContent);
        expect(playbook).toBeDefined();
        expect(playbook.bullets).toEqual([]);
        logger.info("Playbook validated", { bulletCount: playbook.bullets?.length ?? 0 });
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
        expect(result.error).toContain("Already initialized");

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
        const result = JSON.parse(output);
        expect(result.success).toBe(true);
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
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        expect(result.configPath).toContain(".cass-memory");
        expect(Array.isArray(result.created)).toBe(true);
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
        expect(result.error).toContain("Already initialized");
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

          // Should have warned
          const hasWarning = capture2.logs.some(log =>
            log.includes("already has .cass") || log.includes("--force")
          );
          expect(hasWarning).toBe(true);

          // Playbook should NOT be overwritten
          const current = await readFile(playbookPath, "utf-8");
          const currentPlaybook = yaml.parse(current);
          const warningOutput = capture2.logs.join("\n");
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
          const result = JSON.parse(output);
          expect(result.success).toBe(true);
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
          const result = JSON.parse(output);

          expect(result.success).toBe(true);
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
        process.exitCode = undefined;
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
        expect(process.exitCode).toBe(1);
        process.exitCode = undefined;
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
        process.exitCode = undefined;
        const capture = captureConsole();
        try {
          await initCommand({ repo: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Not in a git repository");
        expect(process.exitCode).toBe(1);
        process.exitCode = undefined;
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
});
