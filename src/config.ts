import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { Config, ConfigSchema, SanitizationConfig, BudgetConfig } from "./types.js";
import { fileExists, warn, atomicWrite, expandPath, normalizeYamlKeys, resolveRepoDir } from "./utils.js";

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
  dedupSimilarityThreshold: 0.70,
  pruneHarmfulThreshold: 10,
  defaultDecayHalfLife: 90,
  maxBulletsInContext: 50,
  maxHistoryInContext: 10,
  sessionLookbackDays: 7,
  validationLookbackDays: 90,
  relatedSessionsDays: 30,
  minRelevanceScore: 0.1,
  maxRelatedSessions: 5,
  validationEnabled: true,
  crossAgent: {
    enabled: false,
    consentGiven: false,
    consentDate: null,
    agents: [],
    auditLog: true,
  },
  semanticSearchEnabled: false,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
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

export async function loadConfig(cliOverrides: Partial<Config> = {}): Promise<Config> {
  const globalConfigPath = expandPath("~/.cass-memory/config.json");
  const globalConfig = await loadConfigFile(globalConfigPath);

  let repoConfig: Partial<Config> = {};
  const repoCassDir = await resolveRepoDir();
  
  if (repoCassDir) {
    repoConfig = await loadConfigFile(path.join(repoCassDir, "config.yaml"));
    
    // Security: Prevent repo from overriding sensitive paths
    delete repoConfig.cassPath;
    delete repoConfig.playbookPath;
    delete repoConfig.diaryDir;
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
    crossAgent: {
      ...DEFAULT_CONFIG.crossAgent,
      ...(globalConfig.crossAgent || {}),
      ...(repoConfig.crossAgent || {}),
      ...(cliOverrides.crossAgent || {}),
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