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

// --- LLM Config Migration ---

/**
 * Track if we've already warned about deprecated llm.* config shape.
 * We only warn once per process to avoid spam.
 */
let _llmMigrationWarned = false;

/**
 * Migrate deprecated llm.* config to canonical top-level provider/model.
 * If llm.provider or llm.model is set, copy to top-level and warn once.
 *
 * Canonical shape (as of v0.1.0):
 *   { provider: "anthropic", model: "claude-sonnet-4-20250514", ... }
 *
 * Deprecated shape:
 *   { llm: { provider: "anthropic", model: "..." }, ... }
 *
 * After migration, the llm field is removed from the config.
 */
function migrateLlmConfig(config: Partial<any>): Partial<any> {
  if (!config.llm) return config;

  const { llm, ...rest } = config;

  // Migrate provider if set in llm and not at top-level
  if (llm.provider && !rest.provider) {
    rest.provider = llm.provider;
  }

  // Migrate model if set in llm and not at top-level
  if (llm.model && !rest.model) {
    rest.model = llm.model;
  }

  // Warn once about deprecated config shape
  if (!_llmMigrationWarned) {
    _llmMigrationWarned = true;
    warn(
      `Config uses deprecated 'llm.provider/llm.model' shape. ` +
      `Please migrate to top-level 'provider' and 'model' fields. ` +
      `Run 'cm doctor' for details.`
    );
  }

  return rest;
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
  const globalConfigRaw = await loadConfigFile(globalConfigPath);

  // Migrate deprecated llm.* shape to top-level
  const globalConfig = migrateLlmConfig(globalConfigRaw);

  // Repo-level config is user-owned and may be committed to source control. We intentionally
  // restrict which settings a repo can override to prevent leaking secrets or weakening
  // sanitization/budget protections.
  let repoConfig: Partial<Config> = {};
  let repoSanitizationExtraPatterns: string[] = [];
  const repoCassDir = await resolveRepoDir();

  if (repoCassDir) {
    const { config: repoConfigRaw } = await loadRepoConfig(repoCassDir);

    // Migrate deprecated llm.* shape to top-level
    repoConfig = migrateLlmConfig(repoConfigRaw);

    // Allow repos to *add* extra sanitization patterns, but never disable sanitization.
    const maybeExtra = (repoConfig as any)?.sanitization?.extraPatterns;
    if (Array.isArray(maybeExtra)) {
      repoSanitizationExtraPatterns = maybeExtra
        .filter((p: unknown): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (maybeExtra !== undefined) {
      warn(`Ignoring repo sanitization.extraPatterns: expected string[] (repo config cannot override sanitization settings)`);
    }

    // Security: Prevent repo from overriding sensitive user-level settings
    delete repoConfig.cassPath;
    delete repoConfig.playbookPath;
    delete repoConfig.diaryDir;
    delete repoConfig.crossAgent;
    delete repoConfig.remoteCass;
    delete repoConfig.apiKey;
    delete (repoConfig as any).budget;
    delete (repoConfig as any).sanitization;
  }

  // Migrate CLI overrides as well (unlikely but complete)
  const migratedOverrides = migrateLlmConfig(cliOverrides);

  // Environment variable overrides
  const envOverrides: Partial<Config> = {};
  if (process.env.CASS_PATH) {
    envOverrides.cassPath = process.env.CASS_PATH;
  }

  const globalExtra = (globalConfig as any)?.sanitization?.extraPatterns;
  const cliExtra = (cliOverrides as any)?.sanitization?.extraPatterns;
  const canOverrideExtraPatterns =
    (globalExtra === undefined || Array.isArray(globalExtra)) &&
    (cliExtra === undefined || Array.isArray(cliExtra));

  // Only override `sanitization.extraPatterns` when upstream types are valid. This preserves
  // strict config validation (mis-typed config should fail fast instead of being silently coerced).
  const mergedSanitizationExtraPatterns: string[] | undefined = (() => {
    if (!canOverrideExtraPatterns) return undefined;

    const merged: string[] = [];
    const seen = new Set<string>();
    const pushPattern = (p: unknown) => {
      if (typeof p !== "string") return;
      const trimmed = p.trim();
      if (!trimmed) return;
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      merged.push(trimmed);
    };

    for (const p of defaults.sanitization.extraPatterns) pushPattern(p);
    if (Array.isArray(globalExtra)) for (const p of globalExtra) pushPattern(p);
    for (const p of repoSanitizationExtraPatterns) pushPattern(p);
    if (Array.isArray(cliExtra)) for (const p of cliExtra) pushPattern(p);

    return merged;
  })();

  const merged = {
    ...defaults,
    ...globalConfig,
    ...envOverrides,
    ...repoConfig,
    ...migratedOverrides,
    sanitization: {
      ...defaults.sanitization,
      ...(globalConfig.sanitization || {}),
      ...(cliOverrides.sanitization || {}),
      ...(mergedSanitizationExtraPatterns ? { extraPatterns: mergedSanitizationExtraPatterns } : {}),
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
