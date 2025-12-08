import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import { Config, ConfigSchema } from "./types.js";
import { expandPath, fileExists, warn } from "./utils.js";

// ---------------------------------------------------------------------------
// Defaults (aligned with ConfigSchema in types.ts)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Config = {
  schema_version: 1,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  cassPath: "cass",
  playbookPath: "~/.cass-memory/playbook.yaml",
  diaryDir: "~/.cass-memory/diary",
  maxReflectorIterations: 3,
  autoReflect: false,
  dedupSimilarityThreshold: 0.85,
  pruneHarmfulThreshold: 3,
  defaultDecayHalfLife: 90,
  maxBulletsInContext: 50,
  maxHistoryInContext: 10,
  sessionLookbackDays: 7,
  validationLookbackDays: 90,
  scoring: {
    decayHalfLifeDays: 90,
    harmfulMultiplier: 4,
    minFeedbackForActive: 1,
    minHelpfulForProven: 10,
    maxHarmfulRatioForProven: 0.1,
  },
  validationEnabled: true,
  enrichWithCrossAgent: true,
  semanticSearchEnabled: false,
  verbose: false,
  jsonOutput: false,
  sanitization: {
    enabled: true,
    extraPatterns: []
  },
};

// Convenience accessors ------------------------------------------------------

export function getUserConfigPath(): string {
  return expandPath("~/.cass-memory/config.json");
}

export function getDefaultConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    sanitization: { ...DEFAULT_CONFIG.sanitization },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function detectRepoConfig(cwd: string): Promise<string | null> {
  const cassDir = path.join(cwd, ".cass");
  const candidate = path.join(cassDir, "config.yaml");
  if (await fileExists(candidate)) return candidate;
  return null;
}

function normalizeKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const key of Object.keys(obj)) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = normalizeKeys(obj[key]);
    }
    return out;
  }
  return obj;
}

async function loadConfigFile(filePath: string): Promise<Partial<Config>> {
  const expanded = expandPath(filePath);
  if (!(await fileExists(expanded))) return {};

  try {
    const content = await fs.readFile(expanded, "utf-8");
    const ext = path.extname(expanded).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      return normalizeKeys(yaml.parse(content));
    }
    return JSON.parse(content);
  } catch (err: any) {
    warn(`Failed to load config ${expanded}: ${err.message}`);
    return {};
  }
}

function deepMergeConfig(base: Config, override: Partial<Config>): Config {
  const merged: Config = { ...base, ...override } as Config;

  // Sanitization needs deep merge
  merged.sanitization = {
    ...base.sanitization,
    ...(override.sanitization || {}),
  };

  // Nested llm (if present in overrides) should override provider/model
  if ((override as any).llm) {
    const llm = (override as any).llm;
    merged.provider = llm.provider ?? merged.provider;
    merged.model = llm.model ?? merged.model;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadConfig(
  cliOverrides: Partial<Config> = {},
  cwd: string = process.cwd()
): Promise<Config> {
  const userConfig = await loadConfigFile(getUserConfigPath());
  const repoConfigPath = await detectRepoConfig(cwd);
  const repoConfig = repoConfigPath ? await loadConfigFile(repoConfigPath) : {};

  let merged = getDefaultConfig();
  merged = deepMergeConfig(merged, userConfig);
  merged = deepMergeConfig(merged, repoConfig);
  merged = deepMergeConfig(merged, cliOverrides);

  const validated = ConfigSchema.safeParse(merged);
  if (!validated.success) {
    throw new Error(`Configuration validation failed: ${validated.error.message}`);
  }

  // Verbose env override
  if (process.env.CASS_MEMORY_VERBOSE === "1" || process.env.CASS_MEMORY_VERBOSE === "true") {
    validated.data.verbose = true;
  }

  return validated.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = getUserConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmp, configPath);
}

export async function ensureConfigDirs(config: Config): Promise<void> {
  const dirs = [
    expandPath(path.dirname(config.playbookPath)),
    expandPath(config.diaryDir),
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Compile sanitization settings into the format expected by sanitize().
 * Converts user-provided pattern strings into RegExp instances; skips invalid patterns.
 */
export function getSanitizeConfig(config: Config): { enabled: boolean; extraPatterns?: RegExp[] } {
  const { sanitization } = config;
  if (!sanitization?.enabled) return { enabled: false };

  const compiled =
    sanitization.extraPatterns?.reduce<RegExp[]>((acc, patternStr) => {
      try {
        acc.push(new RegExp(patternStr, "gi"));
      } catch {
        warn(`Invalid sanitization pattern skipped: ${patternStr}`);
      }
      return acc;
    }, []) ?? [];

  return { enabled: true, extraPatterns: compiled.length ? compiled : undefined };
}
