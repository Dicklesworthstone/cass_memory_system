import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Config, ConfigSchema, SanitizationConfig, BudgetConfig } from "./types.js";
import { expandPath, fileExists, warn, atomicWrite } from "./utils.js";

const execAsync = promisify(exec);

// --- Defaults ---

export const DEFAULT_CONFIG: Config = {
  schema_version: 1,
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
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
  validationEnabled: true,
  enrichWithCrossAgent: true,
  semanticSearchEnabled: false,
  verbose: false,
  jsonOutput: false,
  scoring: {
    decayHalfLifeDays: 90,
    harmfulMultiplier: 4,
    minFeedbackForActive: 3,
    minHelpfulForProven: 10,
    maxHarmfulRatioForProven: 0.1
  },
  budget: {
    dailyLimit: 0.10,
    monthlyLimit: 2.00,
    warningThreshold: 80,
    currency: "USD"
  },
  sanitization: {
    enabled: true,
    extraPatterns: [],
    auditLog: false,
    auditLevel: "info",
  },
};

export function getDefaultConfig(): Config {
  // structuredClone is available in modern runtimes (Node 18+/Bun). Fallback keeps this safe if absent.
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_CONFIG);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function getSanitizeConfig(config?: Config): SanitizationConfig {
  const conf = config?.sanitization ?? DEFAULT_CONFIG.sanitization;
  return {
    ...DEFAULT_CONFIG.sanitization,
    ...conf,
  };
}

// --- Repo Context ---

async function detectRepoContext(): Promise<{ inRepo: boolean; repoRoot?: string; cassDir?: string }> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel");
    const repoRoot = stdout.trim();
    const cassDir = path.join(repoRoot, ".cass");
    const hasCassDir = await fileExists(cassDir);
    
    return {
      inRepo: true,
      repoRoot,
      cassDir: hasCassDir ? cassDir : undefined,
    };
  } catch {
    return { inRepo: false };
  }
}

// --- Loading ---

async function loadConfigFile(filePath: string): Promise<Partial<Config>> {
  const expanded = expandPath(filePath);
  if (!(await fileExists(expanded))) return {};

  try {
    const content = await fs.readFile(expanded, "utf-8");
    const ext = path.extname(expanded);
    
    if (ext === ".yaml" || ext === ".yml") {
      return normalizeConfigKeys(yaml.parse(content));
    } else {
      return JSON.parse(content);
    }
  } catch (error: any) {
    warn(`Failed to load config from ${expanded}: ${error.message}`);
    return {};
  }
}

function normalizeConfigKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(normalizeConfigKeys);
  if (obj && typeof obj === "object") {
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      newObj[camelKey] = normalizeConfigKeys(obj[key]);
    }
    return newObj;
  }
  return obj;
}

export async function loadConfig(cliOverrides: Partial<Config> = {}): Promise<Config> {
  const globalConfigPath = expandPath("~/.cass-memory/config.json");
  const globalConfig = await loadConfigFile(globalConfigPath);

  let repoConfig: Partial<Config> = {};
  const repoContext = await detectRepoContext();
  if (repoContext.cassDir) {
    repoConfig = await loadConfigFile(path.join(repoContext.cassDir, "config.yaml"));
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...repoConfig,
    ...cliOverrides,
    sanitization: {
      ...DEFAULT_CONFIG.sanitization,
      ...(globalConfig.sanitization || {}),
      ...(repoConfig.sanitization || {}),
      ...(cliOverrides.sanitization || {}),
    },
    scoring: {
        ...DEFAULT_CONFIG.scoring,
        ...(globalConfig.scoring || {}),
        ...(repoConfig.scoring || {}),
        ...(cliOverrides.scoring || {}),
    }
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