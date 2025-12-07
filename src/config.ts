// src/config.ts
// Configuration loading/saving with cascading priority

import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import {
  Config,
  SanitizationConfig,
  ScoringConfigSection,
  LLMProvider
} from "./types.js";

/**
 * Default sanitization configuration
 */
export const DEFAULT_SANITIZATION_CONFIG: SanitizationConfig = {
  enabled: true,
  extraPatterns: [],
};

/**
 * Default scoring configuration
 */
export const DEFAULT_SCORING_SECTION: ScoringConfigSection = {
  decayHalfLifeDays: 90,
  harmfulMultiplier: 4,
  minFeedbackForActive: 3,
  minHelpfulForProven: 10,
  maxHarmfulRatioForProven: 0.1,
};

/**
 * Get the user-level config directory
 */
export function getUserConfigDir(): string {
  return join(homedir(), ".cass-memory");
}

/**
 * Get the user-level config file path
 */
export function getUserConfigPath(): string {
  return join(getUserConfigDir(), "config.json");
}

/**
 * Get the repo-level config path (if in a repo)
 */
export function getRepoConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".cass", "config.yaml");
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): Config {
  const userDir = getUserConfigDir();
  return {
    schema_version: 1,

    // LLM Provider
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",

    // Paths
    playbookPath: join(userDir, "playbook.yaml"),
    diaryDir: join(userDir, "diary"),
    cassPath: "cass", // Assume in PATH

    // Reflection settings
    maxReflectorIterations: 2,
    dedupSimilarityThreshold: 0.85,
    pruneHarmfulThreshold: 5,

    // Context settings
    maxBulletsInContext: 20,
    maxHistoryInContext: 5,

    // Scoring settings
    scoring: { ...DEFAULT_SCORING_SECTION },

    // Session settings
    sessionLookbackDays: 30,
    validationLookbackDays: 90,

    // Feature flags
    validationEnabled: true,
    autoReflect: false,
    enrichWithCrossAgent: true,
    semanticSearchEnabled: false,

    // Sanitization (P12 - Security Critical)
    sanitization: { ...DEFAULT_SANITIZATION_CONFIG },

    // Logging
    verbose: false,
    jsonOutput: false,
  };
}

/**
 * Deep merge two config objects, with source overriding target
 */
function mergeConfig(target: Config, source: Partial<Config>): Config {
  const result: Config = { ...target };

  // Merge each top-level key
  for (const key of Object.keys(source) as Array<keyof Config>) {
    const sourceValue = source[key];
    if (sourceValue === undefined) continue;

    // Special handling for nested objects
    if (key === "scoring" && sourceValue !== undefined) {
      result.scoring = { ...target.scoring, ...(sourceValue as Partial<ScoringConfigSection>) };
    } else if (key === "sanitization" && sourceValue !== undefined) {
      result.sanitization = { ...target.sanitization, ...(sourceValue as Partial<SanitizationConfig>) };
    } else {
      // Direct assignment for primitive values
      (result as unknown as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Try to load a JSON config file, return null if not found or invalid
 */
function tryLoadJsonConfig(path: string): Partial<Config> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Partial<Config>;
  } catch {
    return null;
  }
}

/**
 * Try to load a YAML config file, return null if not found or invalid
 * Note: Requires yaml package import when used
 */
async function tryLoadYamlConfig(path: string): Promise<Partial<Config> | null> {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const { parse } = await import("yaml");
    const content = readFileSync(path, "utf-8");
    return parse(content) as Partial<Config>;
  } catch {
    return null;
  }
}

/**
 * Load configuration with cascading priority:
 * 1. CLI overrides (highest)
 * 2. Repo-level config (.cass/config.yaml)
 * 3. User-level config (~/.cass-memory/config.json)
 * 4. Built-in defaults (lowest)
 *
 * @param cliOverrides - Command-line overrides (highest priority)
 * @param cwd - Current working directory (for repo-level config)
 * @returns Merged configuration
 */
export async function loadConfig(
  cliOverrides?: Partial<Config>,
  cwd: string = process.cwd()
): Promise<Config> {
  // Start with defaults
  let config = getDefaultConfig();

  // Layer 1: User-level config
  const userConfig = tryLoadJsonConfig(getUserConfigPath());
  if (userConfig) {
    config = mergeConfig(config, userConfig);
  }

  // Layer 2: Repo-level config
  const repoConfig = await tryLoadYamlConfig(getRepoConfigPath(cwd));
  if (repoConfig) {
    config = mergeConfig(config, repoConfig);
  }

  // Layer 3: CLI overrides
  if (cliOverrides) {
    config = mergeConfig(config, cliOverrides);
  }

  return config;
}

/**
 * Save configuration to user-level config file
 * Note: Only saves to user level, not repo level
 *
 * @param config - Configuration to save
 */
export function saveConfig(config: Config): void {
  const configDir = getUserConfigDir();
  const configPath = getUserConfigPath();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Write config atomically
  const tempPath = configPath + ".tmp";
  writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");

  // Rename is atomic on POSIX
  const { renameSync } = require("fs");
  renameSync(tempPath, configPath);
}

/**
 * Ensure required directories exist based on config
 *
 * @param config - Configuration to initialize directories for
 */
export function ensureConfigDirs(config: Config): void {
  const dirs = [
    dirname(config.playbookPath),
    config.diaryDir,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Get a sanitization config ready for use with sanitize()
 * Converts extraPatterns from strings to the format expected by sanitize module
 *
 * @param config - Full config or just sanitization section
 * @returns Sanitization config in format expected by sanitize module
 */
export function getSanitizeConfig(
  config: Config | SanitizationConfig
): { enabled: boolean; extraPatterns?: Array<{ pattern: RegExp; replacement: string }> } {
  const sanitizationConfig = "sanitization" in config ? config.sanitization : config;

  if (!sanitizationConfig.enabled) {
    return { enabled: false };
  }

  // Compile extra patterns if provided
  const extraPatterns = sanitizationConfig.extraPatterns.length > 0
    ? sanitizationConfig.extraPatterns.map((patternStr) => ({
        pattern: new RegExp(patternStr, "gi"),
        replacement: "[USER_SECRET]",
      }))
    : undefined;

  return {
    enabled: true,
    extraPatterns,
  };
}
