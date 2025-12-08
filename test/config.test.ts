import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  DEFAULT_CONFIG,
  getDefaultConfig,
  getSanitizeConfig,
  loadConfig,
  saveConfig,
} from "../src/config.js";
import { ConfigSchema, Config } from "../src/types.js";
import { withTempDir, withTempCassHome, createIsolatedEnvironment, cleanupEnvironment, TestEnv } from "./helpers/index.js";

// =============================================================================
// getDefaultConfig() - Clone behavior
// =============================================================================
describe("getDefaultConfig()", () => {
  test("returns a valid config object", () => {
    const config = getDefaultConfig();
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("returns a deep clone (mutations don't affect DEFAULT_CONFIG)", () => {
    const config = getDefaultConfig();
    config.provider = "openai";
    config.scoring.decayHalfLifeDays = 999;
    config.sanitization.enabled = false;

    // DEFAULT_CONFIG should be unchanged
    expect(DEFAULT_CONFIG.provider).toBe("anthropic");
    expect(DEFAULT_CONFIG.scoring.decayHalfLifeDays).toBe(90);
    expect(DEFAULT_CONFIG.sanitization.enabled).toBe(true);
  });

  test("includes all required fields", () => {
    const config = getDefaultConfig();

    // Core fields
    expect(config.schema_version).toBe(1);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-3-5-sonnet-20241022");
    expect(config.cassPath).toBe("cass");

    // Nested objects
    expect(config.scoring).toBeDefined();
    expect(config.budget).toBeDefined();
    expect(config.sanitization).toBeDefined();
  });

  test("scoring defaults are sensible", () => {
    const config = getDefaultConfig();
    expect(config.scoring.decayHalfLifeDays).toBe(90);
    expect(config.scoring.harmfulMultiplier).toBe(4);
    expect(config.scoring.minFeedbackForActive).toBe(3);
    expect(config.scoring.minHelpfulForProven).toBe(10);
    expect(config.scoring.maxHarmfulRatioForProven).toBe(0.1);
  });

  test("budget defaults are sensible", () => {
    const config = getDefaultConfig();
    expect(config.budget.dailyLimit).toBe(0.10);
    expect(config.budget.monthlyLimit).toBe(2.00);
    expect(config.budget.warningThreshold).toBe(80);
    expect(config.budget.currency).toBe("USD");
  });

  test("sanitization defaults are sensible", () => {
    const config = getDefaultConfig();
    expect(config.sanitization.enabled).toBe(true);
    expect(config.sanitization.extraPatterns).toEqual([]);
    expect(config.sanitization.auditLog).toBe(false);
    expect(config.sanitization.auditLevel).toBe("info");
  });
});

// =============================================================================
// getSanitizeConfig() - Extraction and merging
// =============================================================================
describe("getSanitizeConfig()", () => {
  test("returns defaults when config is undefined", () => {
    const result = getSanitizeConfig(undefined);
    expect(result.enabled).toBe(true);
    expect(result.extraPatterns).toEqual([]);
    expect(result.auditLog).toBe(false);
    expect(result.auditLevel).toBe("info");
  });

  test("returns defaults when config.sanitization is undefined", () => {
    const config = { ...DEFAULT_CONFIG };
    delete (config as any).sanitization;
    const result = getSanitizeConfig(config as Config);
    expect(result.enabled).toBe(true);
    expect(result.extraPatterns).toEqual([]);
  });

  test("merges config.sanitization with defaults", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      sanitization: {
        enabled: false,
        extraPatterns: ["secret-.*"],
        auditLog: true,
        auditLevel: "debug",
      },
    };

    const result = getSanitizeConfig(config);
    expect(result.enabled).toBe(false);
    expect(result.extraPatterns).toEqual(["secret-.*"]);
    expect(result.auditLog).toBe(true);
    expect(result.auditLevel).toBe("debug");
  });

  test("partial sanitization config uses defaults for missing fields", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      sanitization: {
        enabled: false,
        extraPatterns: [],
        auditLog: false,
        auditLevel: "info",
      },
    };
    // Override just one field
    (config.sanitization as any) = { enabled: false };

    const result = getSanitizeConfig(config);
    expect(result.enabled).toBe(false);
    // Other fields should come from defaults
    expect(result.extraPatterns).toEqual([]);
    expect(result.auditLog).toBe(false);
  });
});

// =============================================================================
// loadConfig() - CLI overrides
// =============================================================================
describe("loadConfig() - CLI overrides", () => {
  test("CLI overrides take precedence over defaults", async () => {
    const config = await loadConfig({
      provider: "openai",
      model: "gpt-4",
      verbose: true,
    });

    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4");
    expect(config.verbose).toBe(true);
    // Non-overridden fields should use defaults
    expect(config.cassPath).toBe("cass");
  });

  test("nested scoring overrides merge correctly", async () => {
    const config = await loadConfig({
      scoring: {
        decayHalfLifeDays: 45,
        harmfulMultiplier: 2,
        minFeedbackForActive: 5,
        minHelpfulForProven: 15,
        maxHarmfulRatioForProven: 0.2,
      },
    });

    expect(config.scoring.decayHalfLifeDays).toBe(45);
    expect(config.scoring.harmfulMultiplier).toBe(2);
    expect(config.scoring.minFeedbackForActive).toBe(5);
    expect(config.scoring.minHelpfulForProven).toBe(15);
    expect(config.scoring.maxHarmfulRatioForProven).toBe(0.2);
  });

  test("nested sanitization overrides merge correctly", async () => {
    const config = await loadConfig({
      sanitization: {
        enabled: false,
        extraPatterns: ["MY_SECRET_.*"],
        auditLog: true,
        auditLevel: "debug",
      },
    });

    expect(config.sanitization.enabled).toBe(false);
    expect(config.sanitization.extraPatterns).toEqual(["MY_SECRET_.*"]);
    expect(config.sanitization.auditLog).toBe(true);
  });

  test("nested budget overrides merge correctly", async () => {
    const config = await loadConfig({
      budget: {
        dailyLimit: 1.0,
        monthlyLimit: 20.0,
        warningThreshold: 90,
        currency: "EUR",
      },
    });

    expect(config.budget.dailyLimit).toBe(1.0);
    expect(config.budget.monthlyLimit).toBe(20.0);
    expect(config.budget.warningThreshold).toBe(90);
    expect(config.budget.currency).toBe("EUR");
  });

  test("empty CLI overrides returns defaults", async () => {
    await withTempCassHome(async () => {
      // With isolated HOME and no config files, should return pure defaults
      const config = await loadConfig({});
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-3-5-sonnet-20241022");
    });
  });
});

// =============================================================================
// loadConfig() - Global config file
// =============================================================================
describe("loadConfig() - Global config file", () => {
  test("loads config from ~/.cass-memory/config.json when present", async () => {
    await withTempCassHome(async (env) => {
      // Write a global config
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "google",
          model: "gemini-pro",
          verbose: true,
        })
      );

      const config = await loadConfig();

      expect(config.provider).toBe("google");
      expect(config.model).toBe("gemini-pro");
      expect(config.verbose).toBe(true);
      // Non-overridden fields use defaults
      expect(config.cassPath).toBe("cass");
    });
  });

  test("returns defaults when global config file is missing", async () => {
    await withTempCassHome(async (env) => {
      // Don't create any config file
      const config = await loadConfig();

      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-3-5-sonnet-20241022");
    });
  });

  test("handles partial global config (fills in defaults)", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "openai",
          // model not specified
        })
      );

      const config = await loadConfig();

      expect(config.provider).toBe("openai");
      expect(config.model).toBe("claude-3-5-sonnet-20241022"); // default
    });
  });

  test("merges nested objects from global config", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({
          scoring: {
            decayHalfLifeDays: 60,
          },
          budget: {
            dailyLimit: 0.50,
          },
        })
      );

      const config = await loadConfig();

      // Overridden nested values
      expect(config.scoring.decayHalfLifeDays).toBe(60);
      expect(config.budget.dailyLimit).toBe(0.50);
      // Non-overridden nested values use defaults
      expect(config.scoring.harmfulMultiplier).toBe(4);
      expect(config.budget.currency).toBe("USD");
    });
  });
});

// =============================================================================
// loadConfig() - Repo config file
// =============================================================================
describe("loadConfig() - Repo config file", () => {
  test("loads YAML config from .cass/config.yaml in git repo", async () => {
    await withTempCassHome(async (env) => {
      await withTempDir("config-repo", async (repoDir) => {
        // Initialize git repo
        execSync("git init", { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });

        // Create .cass directory with config
        await mkdir(join(repoDir, ".cass"), { recursive: true });
        await writeFile(
          join(repoDir, ".cass", "config.yaml"),
          `provider: openai
model: gpt-4-turbo
verbose: true
`
        );

        // Change to repo directory
        const originalCwd = process.cwd();
        try {
          process.chdir(repoDir);
          const config = await loadConfig();

          expect(config.provider).toBe("openai");
          expect(config.model).toBe("gpt-4-turbo");
          expect(config.verbose).toBe(true);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("repo config cannot override sensitive paths (security)", async () => {
    await withTempCassHome(async (env) => {
      await withTempDir("config-repo-security", async (repoDir) => {
        execSync("git init", { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });

        await mkdir(join(repoDir, ".cass"), { recursive: true });
        await writeFile(
          join(repoDir, ".cass", "config.yaml"),
          `cassPath: /malicious/path
playbookPath: /malicious/playbook.yaml
diaryDir: /malicious/diary
provider: openai
`
        );

        const originalCwd = process.cwd();
        try {
          process.chdir(repoDir);
          const config = await loadConfig();

          // Sensitive paths should use defaults, NOT the repo values
          expect(config.cassPath).toBe("cass");
          expect(config.playbookPath).toBe("~/.cass-memory/playbook.yaml");
          expect(config.diaryDir).toBe("~/.cass-memory/diary");
          // Non-sensitive values should be applied
          expect(config.provider).toBe("openai");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("repo config with snake_case keys gets normalized to camelCase", async () => {
    await withTempCassHome(async (env) => {
      await withTempDir("config-snake-case", async (repoDir) => {
        execSync("git init", { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });

        await mkdir(join(repoDir, ".cass"), { recursive: true });
        await writeFile(
          join(repoDir, ".cass", "config.yaml"),
          `max_reflector_iterations: 5
dedup_similarity_threshold: 0.9
session_lookback_days: 14
`
        );

        const originalCwd = process.cwd();
        try {
          process.chdir(repoDir);
          const config = await loadConfig();

          expect(config.maxReflectorIterations).toBe(5);
          expect(config.dedupSimilarityThreshold).toBe(0.9);
          expect(config.sessionLookbackDays).toBe(14);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

// =============================================================================
// loadConfig() - Merge precedence
// =============================================================================
describe("loadConfig() - Merge precedence", () => {
  test("CLI > Repo > Global > Defaults", async () => {
    await withTempCassHome(async (env) => {
      // Write global config
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "google",
          model: "gemini-pro",
          maxReflectorIterations: 2,
        })
      );

      await withTempDir("config-precedence", async (repoDir) => {
        execSync("git init", { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });

        // Write repo config (overrides global)
        await mkdir(join(repoDir, ".cass"), { recursive: true });
        await writeFile(
          join(repoDir, ".cass", "config.yaml"),
          `model: gpt-4-turbo
maxReflectorIterations: 4
`
        );

        const originalCwd = process.cwd();
        try {
          process.chdir(repoDir);

          // CLI overrides everything
          const config = await loadConfig({
            maxReflectorIterations: 10,
          });

          expect(config.provider).toBe("google"); // from global (not in repo or CLI)
          expect(config.model).toBe("gpt-4-turbo"); // from repo (overrides global)
          expect(config.maxReflectorIterations).toBe(10); // from CLI (overrides repo)
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

// =============================================================================
// loadConfig() - Environment variables
// =============================================================================
describe("loadConfig() - Environment variables", () => {
  const originalVerbose = process.env.CASS_MEMORY_VERBOSE;

  afterEach(() => {
    if (originalVerbose === undefined) {
      delete process.env.CASS_MEMORY_VERBOSE;
    } else {
      process.env.CASS_MEMORY_VERBOSE = originalVerbose;
    }
  });

  test("CASS_MEMORY_VERBOSE=1 sets verbose to true", async () => {
    process.env.CASS_MEMORY_VERBOSE = "1";
    const config = await loadConfig();
    expect(config.verbose).toBe(true);
  });

  test("CASS_MEMORY_VERBOSE=true sets verbose to true", async () => {
    process.env.CASS_MEMORY_VERBOSE = "true";
    const config = await loadConfig();
    expect(config.verbose).toBe(true);
  });

  test("CASS_MEMORY_VERBOSE unset uses config value", async () => {
    delete process.env.CASS_MEMORY_VERBOSE;
    const config = await loadConfig({ verbose: false });
    expect(config.verbose).toBe(false);
  });
});

// =============================================================================
// loadConfig() - Error handling
// =============================================================================
describe("loadConfig() - Error handling", () => {
  test("handles malformed JSON in global config gracefully", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, "{ invalid json }");

      // Should not throw, should use defaults
      const config = await loadConfig();
      expect(config.provider).toBe("anthropic");
    });
  });

  test("handles malformed YAML in repo config gracefully", async () => {
    await withTempCassHome(async (env) => {
      await withTempDir("config-malformed-yaml", async (repoDir) => {
        execSync("git init", { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
        execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" });

        await mkdir(join(repoDir, ".cass"), { recursive: true });
        await writeFile(
          join(repoDir, ".cass", "config.yaml"),
          `invalid: yaml: : content
  - broken
`
        );

        const originalCwd = process.cwd();
        try {
          process.chdir(repoDir);
          // Should not throw, should use defaults
          const config = await loadConfig();
          expect(config.provider).toBe("anthropic");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("throws on schema validation failure for invalid config values", async () => {
    await expect(
      loadConfig({
        provider: "invalid-provider" as any,
      })
    ).rejects.toThrow(/Configuration validation failed/);
  });
});

// =============================================================================
// saveConfig() - Writing config
// =============================================================================
describe("saveConfig()", () => {
  test("writes config to ~/.cass-memory/config.json", async () => {
    await withTempCassHome(async (env) => {
      const config = getDefaultConfig();
      config.provider = "openai";
      config.verbose = true;

      await saveConfig(config);

      // Read back and verify
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(env.configPath, "utf-8");
      const saved = JSON.parse(content);

      expect(saved.provider).toBe("openai");
      expect(saved.verbose).toBe(true);
    });
  });

  test("creates parent directory if needed", async () => {
    await withTempDir("config-save-mkdir", async (tempDir) => {
      const originalHome = process.env.HOME;
      try {
        process.env.HOME = tempDir;
        // .cass-memory directory doesn't exist yet

        const config = getDefaultConfig();
        await saveConfig(config);

        const { readFile } = await import("node:fs/promises");
        const content = await readFile(
          join(tempDir, ".cass-memory", "config.json"),
          "utf-8"
        );
        const saved = JSON.parse(content);
        expect(saved.schema_version).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});

// =============================================================================
// DEFAULT_CONFIG validation
// =============================================================================
describe("DEFAULT_CONFIG", () => {
  test("passes schema validation", () => {
    const result = ConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("has correct schema version", () => {
    expect(DEFAULT_CONFIG.schema_version).toBe(1);
  });

  test("has valid provider", () => {
    expect(["anthropic", "openai", "google"]).toContain(DEFAULT_CONFIG.provider);
  });
});
