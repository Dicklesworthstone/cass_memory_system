import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { Config, ConfigSchema, SanitizationConfig, BudgetConfig } from "./types.js";
import { fileExists, warn, atomicWrite, expandPath, normalizeYamlKeys, resolveRepoDir } from "./utils.js";

// --- Defaults ---

/**
 * Get default configuration by parsing an empty object through ConfigSchema.
 * This ensures ConfigSchema is the single source of truth for all defaults.
 *
 * The schema defines all defaults via .default() modifiers. By parsing {},
 * we get a fully populated Config object with all schema-defined defaults.
 */
export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Cached default config for internal use.
 * Lazily initialized on first access.
 */
let _cachedDefaults: Config | null = null;

function getCachedDefaults(): Config {
  if (_cachedDefaults === null) {
    _cachedDefaults = getDefaultConfig();
  }
  return _cachedDefaults;
}

/**
 * @deprecated Use getDefaultConfig() instead.
 * This export is retained for backward compatibility but now delegates to ConfigSchema.
 */
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function getSanitizeConfig(config?: Config): SanitizationConfig {
  const defaults = getCachedDefaults();
  const conf = config?.sanitization ?? defaults.sanitization;
  return {
    ...defaults.sanitization,
    ...conf,
  };
}

// --- Loading ---

async function loadConfigFile(filePath: string): Promise<Partial<Config>> {
  const expanded = expandPath(filePath);
  if (!(await fileExists(expanded))) return {};

  try {
    const content = await fs.readFile(expanded, "utf-8");
    const ext = path.extname(expanded);

    if (ext === ".yaml" || ext === ".yml") {
      return normalizeYamlKeys(yaml.parse(content));
    } else {
      return JSON.parse(content);
    }
  } catch (error: any) {
    warn(`Failed to load config from ${expanded}: ${error.message}`);
    return {};
  }
}

/**
 * Load repo-level config with format parity.
 * Supports both .cass/config.json and .cass/config.yaml (.yml).
 * Precedence: JSON preferred if both exist (deterministic behavior).
 *
 * @returns Loaded config and which source was used (for diagnostics)
 */
async function loadRepoConfig(repoCassDir: string): Promise<{
  config: Partial<Config>;
  source: string | null;
}> {
  const jsonPath = path.join(repoCassDir, "config.json");
  const yamlPath = path.join(repoCassDir, "config.yaml");
  const ymlPath = path.join(repoCassDir, "config.yml");

  // Check which files exist
  const [jsonExists, yamlExists, ymlExists] = await Promise.all([
    fileExists(jsonPath),
    fileExists(yamlPath),
    fileExists(ymlPath),
  ]);

  // Prefer JSON if it exists (deterministic precedence)
  if (jsonExists) {
    const config = await loadConfigFile(jsonPath);
    return { config, source: jsonPath };
  }

  // Fall back to YAML
  if (yamlExists) {
    const config = await loadConfigFile(yamlPath);
    return { config, source: yamlPath };
  }

  // Fall back to YML
  if (ymlExists) {
    const config = await loadConfigFile(ymlPath);
    return { config, source: ymlPath };
  }

  return { config: {}, source: null };
}

export async function loadConfig(cliOverrides: Partial<Config> = {}): Promise<Config> {
  const defaults = getCachedDefaults();
  const globalConfigPath = expandPath("~/.cass-memory/config.json");
  const globalConfig = await loadConfigFile(globalConfigPath);

  let repoConfig: Partial<Config> = {};
  const repoCassDir = await resolveRepoDir();

  if (repoCassDir) {
    const { config } = await loadRepoConfig(repoCassDir);
    repoConfig = config;

    // Security: Prevent repo from overriding sensitive paths
    delete repoConfig.cassPath;
    delete repoConfig.playbookPath;
    delete repoConfig.diaryDir;
  }

  const merged = {
    ...defaults,
    ...globalConfig,
    ...repoConfig,
    ...cliOverrides,
    sanitization: {
      ...defaults.sanitization,
      ...(globalConfig.sanitization || {}),
      ...(repoConfig.sanitization || {}),
      ...(cliOverrides.sanitization || {}),
    },
    crossAgent: {
      ...defaults.crossAgent,
      ...(globalConfig.crossAgent || {}),
      ...(repoConfig.crossAgent || {}),
      ...(cliOverrides.crossAgent || {}),
    },
    scoring: {
      ...defaults.scoring,
      ...(globalConfig.scoring || {}),
      ...(repoConfig.scoring || {}),
      ...(cliOverrides.scoring || {}),
    },
    budget: {
      ...defaults.budget,
      ...(globalConfig.budget || {}),
      ...(repoConfig.budget || {}),
      ...(cliOverrides.budget || {}),
    },
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    warn(`Invalid configuration detected: ${result.error.message}`);
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }

  if (process.env.CASS_MEMORY_VERBOSE === "1" || process.env.CASS_MEMORY_VERBOSE === "true") {
    result.data.verbose = true;
  }

  return result.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const globalConfigPath = expandPath("~/.cass-memory/config.json");
  await atomicWrite(globalConfigPath, JSON.stringify(config, null, 2));
}
