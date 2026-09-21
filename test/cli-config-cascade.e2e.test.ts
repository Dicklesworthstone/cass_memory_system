/**
 * E2E Tests for Config Cascade - Global, Repo, Session Merging
 *
 * Tests that configuration properly cascades from:
 * 1. Default values
 * 2. Global config (~/.cass-memory/config.json)
 * 3. Repo config (.cass/config.yaml)
 * 4. CLI overrides
 *
 * Uses isolated temp directories to avoid affecting the real system.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { DEFAULT_CONFIG, getDefaultConfig, loadConfig } from "../src/config.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = path.join(
    os.tmpdir(),
    `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function setupTestEnvironment() {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const cassMemoryDir = path.join(home, ".cass-memory");
  const repoCassDir = path.join(repo, ".cass");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });
  await mkdir(repo, { recursive: true });

  // Initialize git repo
  execSync("git init", { cwd: repo, stdio: "pipe" });

  return { dir, home, repo, cassMemoryDir, repoCassDir };
}

// --- Test Suites ---

describe("E2E: Config Cascade", () => {
  describe("Default Values", () => {
    it("returns defaults when no configs exist", async () => {
      const { home, repo } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // No config files created
        const config = await loadConfig();

        // Should have default values
        expect(config.provider).toBe(DEFAULT_CONFIG.provider);
        expect(config.model).toBe(DEFAULT_CONFIG.model);
        expect(config.dedupSimilarityThreshold).toBe(DEFAULT_CONFIG.dedupSimilarityThreshold);
        expect(config.scoring.decayHalfLifeDays).toBe(DEFAULT_CONFIG.scoring.decayHalfLifeDays);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("getDefaultConfig returns a copy of defaults", () => {
      const defaults1: any = getDefaultConfig();
      const defaults2 = getDefaultConfig();

      // Should be equal but not the same object
      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2);

      // Modifying one should not affect the other
      defaults1.provider = "modified";
      expect(defaults2.provider).toBe(DEFAULT_CONFIG.provider);
    });
  });

  describe("Global Config Only", () => {
    it("uses global config when repo config does not exist", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create global config
        const globalConfig = {
          provider: "openai",
          model: "gpt-4",
          verbose: true,
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        const config = await loadConfig();

        expect(config.provider).toBe("openai");
        expect(config.model).toBe("gpt-4");
        expect(config.verbose).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("global config inherits defaults for missing fields", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Partial global config
        const globalConfig = {
          provider: "openai",
          // model is not specified
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        const config = await loadConfig();

        expect(config.provider).toBe("openai");
        expect(config.model).toBe(DEFAULT_CONFIG.model); // Inherited from defaults
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Repo Overrides Global", () => {
    it("repo config overrides global config", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create global config
        const globalConfig = {
          provider: "openai",
          model: "gpt-4",
          verbose: false,
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        // Create repo config (YAML format)
        await mkdir(repoCassDir, { recursive: true });
        const repoConfig = {
          provider: "anthropic",
          verbose: true,
        };
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify(repoConfig));

        const config = await loadConfig();

        expect(config.provider).toBe("anthropic"); // Overridden by repo
        expect(config.model).toBe("gpt-4"); // Inherited from global
        expect(config.verbose).toBe(true); // Overridden by repo
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("repo config cannot override sensitive paths (security)", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create global config with safe paths
        const globalConfig = {
          cassPath: "safe-cass-path",
          playbookPath: "~/.cass-memory/playbook.yaml",
          diaryDir: "~/.cass-memory/diary",
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        // Repo tries to override sensitive paths (malicious attempt)
        await mkdir(repoCassDir, { recursive: true });
        const repoConfig = {
          cassPath: "/evil/path",
          playbookPath: "/etc/passwd",
          diaryDir: "/tmp/evil",
          verbose: true, // This should work
        };
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify(repoConfig));

        const config = await loadConfig();

        // Sensitive paths should NOT be overridden
        expect(config.cassPath).toBe("safe-cass-path");
        expect(config.playbookPath).toBe("~/.cass-memory/playbook.yaml");
        expect(config.diaryDir).toBe("~/.cass-memory/diary");

        // Non-sensitive settings should be overridden
        expect(config.verbose).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("CLI Overrides All", () => {
    it("CLI overrides take precedence over all configs", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create global config
        const globalConfig = {
          provider: "openai",
          model: "gpt-4",
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        // Create repo config
        await mkdir(repoCassDir, { recursive: true });
        const repoConfig = {
          provider: "anthropic",
        };
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify(repoConfig));

        // CLI override
        const config = await loadConfig({
          provider: "google",
          verbose: true,
        });

        expect(config.provider).toBe("google"); // CLI wins
        expect(config.model).toBe("gpt-4"); // From global
        expect(config.verbose).toBe(true); // CLI
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Nested Object Merging", () => {
    it("merges nested sanitization config", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Global with partial sanitization
        const globalConfig = {
          sanitization: {
            enabled: true,
            auditLog: true,
          },
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        // Repo with different sanitization settings
        await mkdir(repoCassDir, { recursive: true });
        const repoConfig = {
          sanitization: {
            extraPatterns: ["secret_.*", "token_.*"],
          },
        };
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify(repoConfig));

        const config = await loadConfig();

        // Both settings should be merged
        expect(config.sanitization.enabled).toBe(true); // From global
        expect(config.sanitization.auditLog).toBe(true); // From global
        expect(config.sanitization.extraPatterns).toEqual(["secret_.*", "token_.*"]); // From repo
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("merges nested scoring config", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Global with partial scoring
        const globalConfig = {
          scoring: {
            decayHalfLifeDays: 60,
            harmfulMultiplier: 3,
          },
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        // Repo with different scoring settings
        await mkdir(repoCassDir, { recursive: true });
        const repoConfig = {
          scoring: {
            minFeedbackForActive: 5,
          },
        };
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify(repoConfig));

        const config = await loadConfig();

        expect(config.scoring.decayHalfLifeDays).toBe(60); // From global
        expect(config.scoring.harmfulMultiplier).toBe(3); // From global
        expect(config.scoring.minFeedbackForActive).toBe(5); // From repo
        expect(config.scoring.minHelpfulForProven).toBe(DEFAULT_CONFIG.scoring.minHelpfulForProven); // Default
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("CLI overrides nested config", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        const globalConfig = {
          scoring: {
            decayHalfLifeDays: 60,
          },
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(globalConfig));

        const config = await loadConfig({
          scoring: {
            ...DEFAULT_CONFIG.scoring,
            decayHalfLifeDays: 30,
            harmfulMultiplier: 10,
          },
        });

        expect(config.scoring.decayHalfLifeDays).toBe(30); // CLI override
        expect(config.scoring.harmfulMultiplier).toBe(10); // CLI override
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("YAML Format Support", () => {
    it("repo config supports YAML format", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Global in JSON
        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ provider: "openai" }),
        );

        // Repo in YAML
        await mkdir(repoCassDir, { recursive: true });
        const yamlContent = `
provider: anthropic
verbose: true
scoring:
  decayHalfLifeDays: 45
`;
        await writeFile(path.join(repoCassDir, "config.yaml"), yamlContent);

        const config = await loadConfig();

        expect(config.provider).toBe("anthropic");
        expect(config.verbose).toBe(true);
        expect(config.scoring.decayHalfLifeDays).toBe(45);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("handles snake_case to camelCase conversion in YAML", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");

        // YAML with snake_case keys
        await mkdir(repoCassDir, { recursive: true });
        const yamlContent = `
max_reflector_iterations: 5
auto_reflect: true
`;
        await writeFile(path.join(repoCassDir, "config.yaml"), yamlContent);

        const config = await loadConfig();

        // Should be converted to camelCase
        expect(config.maxReflectorIterations).toBe(5);
        expect(config.autoReflect).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Missing Config Files", () => {
    it("handles missing global config gracefully", async () => {
      const { home, repo } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // No config files created at all
        const config = await loadConfig();

        // Should return defaults without crashing
        expect(config).toBeDefined();
        expect(config.provider).toBe(DEFAULT_CONFIG.provider);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("handles missing repo .cass directory gracefully", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Only global config exists
        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ provider: "openai" }),
        );

        // No .cass directory in repo
        const config = await loadConfig();

        expect(config.provider).toBe("openai");
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("handles empty config file gracefully", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Empty config file
        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");

        const config = await loadConfig();

        // Should fall back to defaults
        expect(config.provider).toBe(DEFAULT_CONFIG.provider);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Environment Variables", () => {
    it("CASS_MEMORY_VERBOSE enables verbose mode", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();
      const originalVerbose = process.env.CASS_MEMORY_VERBOSE;

      try {
        process.env.HOME = home;
        process.chdir(repo);
        process.env.CASS_MEMORY_VERBOSE = "1";

        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ verbose: false }),
        );

        const config = await loadConfig();

        expect(config.verbose).toBe(true); // Env var overrides config
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
        if (originalVerbose === undefined) {
          delete process.env.CASS_MEMORY_VERBOSE;
        } else {
          process.env.CASS_MEMORY_VERBOSE = originalVerbose;
        }
      }
    });

    it("CASS_MEMORY_VERBOSE accepts 'true' string", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();
      const originalVerbose = process.env.CASS_MEMORY_VERBOSE;

      try {
        process.env.HOME = home;
        process.chdir(repo);
        process.env.CASS_MEMORY_VERBOSE = "true";

        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");

        const config = await loadConfig();

        expect(config.verbose).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
        if (originalVerbose === undefined) {
          delete process.env.CASS_MEMORY_VERBOSE;
        } else {
          process.env.CASS_MEMORY_VERBOSE = originalVerbose;
        }
      }
    });
  });

  describe("Non-Git Directory", () => {
    it("loads only global config when not in git repo", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const nonGitDir = await createTempDir();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(nonGitDir); // Not a git repo

        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ provider: "openai", verbose: true }),
        );

        const config = await loadConfig();

        expect(config.provider).toBe("openai");
        expect(config.verbose).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Config Validation", () => {
    it("validates config against schema", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Invalid provider
        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ provider: "invalid-provider" }),
        );

        await expect(loadConfig()).rejects.toThrow();
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("accepts valid provider values", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        for (const provider of ["openai", "anthropic", "google"] as const) {
          await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify({ provider }));

          const config = await loadConfig();
          expect(config.provider).toBe(provider);
        }
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Config Cascading Edge Cases", () => {
    it("handles nested directory structure in git repo", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;

        // Create nested directory
        const nestedDir = path.join(repo, "src", "components");
        await mkdir(nestedDir, { recursive: true });
        process.chdir(nestedDir);

        // Create configs
        await writeFile(
          path.join(cassMemoryDir, "config.json"),
          JSON.stringify({ provider: "openai" }),
        );

        await mkdir(repoCassDir, { recursive: true });
        await writeFile(path.join(repoCassDir, "config.yaml"), yaml.stringify({ verbose: true }));

        const config = await loadConfig();

        // Should still find repo config from nested directory
        expect(config.provider).toBe("openai");
        expect(config.verbose).toBe(true);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("preserves default budget config", async () => {
      const { home, repo, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");

        const config = await loadConfig();

        expect(config.budget).toBeDefined();
        expect(config.budget.dailyLimit).toBe(DEFAULT_CONFIG.budget.dailyLimit);
        expect(config.budget.monthlyLimit).toBe(DEFAULT_CONFIG.budget.monthlyLimit);
        expect(config.budget.currency).toBe(DEFAULT_CONFIG.budget.currency);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });
});
