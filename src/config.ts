import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { Config, ConfigSchema, SanitizationConfig, BudgetConfig } from "./types.js";
import {
  fileExists,
  warn,
  atomicWrite,
  expandPath,
  normalizeYamlKeys,
  resolveRepoDir,
  resolveGlobalDir,
  resolveConfigFileInDir,
  resolveGlobalConfigFile,
  type ResolvedConfigFile,
} from "./utils.js";
import { configureEmbeddingBackend } from "./semantic.js";

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
 *   { provider: "anthropic", model: "claude-sonnet-5", ... }
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

  // Migrate LLM timeouts (#53). `llm.timeoutMs` is the documented config knob;
  // surface it as the resolved top-level `llmTimeoutMs` consumed by the LLM layer.
  if (llm.timeoutMs !== undefined && rest.llmTimeoutMs === undefined) {
    rest.llmTimeoutMs = llm.timeoutMs;
  }
  if (llm.totalTimeoutMs !== undefined && rest.llmTotalTimeoutMs === undefined) {
    rest.llmTotalTimeoutMs = llm.totalTimeoutMs;
  }

  // Warn once about deprecated config shape — only for the deprecated
  // provider/model keys. `llm.timeoutMs`/`llm.totalTimeoutMs` are the
  // canonical, documented home for the LLM timeouts (#53), so their presence
  // alone must not trigger the migration warning.
  if (!_llmMigrationWarned && (llm.provider || llm.model)) {
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
 * Paths we have already warned about being shadowed, so a long-lived process
 * (`cm serve`) does not repeat the warning on every config load.
 */
const _shadowWarned = new Set<string>();

/**
 * Load the config file from a config directory with format parity.
 *
 * Used for BOTH the global directory (`~/.cass-memory/`) and repo-level
 * `.cass/` directories (#75: previously only repo configs honored YAML, while
 * the global loader silently ignored `~/.cass-memory/config.yaml`).
 *
 * Supports config.json, config.yaml and config.yml. Precedence: JSON preferred
 * if more than one exists (deterministic behavior); the ignored file(s) are
 * reported once via a warning so the shadowing is never silent.
 *
 * @returns Loaded config and which source was used (for diagnostics)
 */
async function loadConfigFromDir(dir: string): Promise<{
  config: Partial<Config>;
  source: string | null;
}> {
  const file = await resolveConfigFileInDir(dir);
  if (!file.exists) return { config: {}, source: null };

  for (const ignored of file.shadowed) {
    if (_shadowWarned.has(ignored)) continue;
    _shadowWarned.add(ignored);
    warn(
      `Ignoring ${ignored}: ${path.basename(file.path)} in the same directory takes precedence ` +
      `(remove one of them to avoid confusion)`
    );
  }

  const config = await loadConfigFile(file.path);
  return { config, source: file.path };
}

export async function loadConfig(cliOverrides: Partial<Config> = {}): Promise<Config> {
  const defaults = getCachedDefaults();
  const { config: globalConfigRaw } = await loadConfigFromDir(resolveGlobalDir());

  // Migrate deprecated llm.* shape to top-level
  const globalConfig = migrateLlmConfig(globalConfigRaw);

  // Repo-level config is user-owned and may be committed to source control. We intentionally
  // restrict which settings a repo can override to prevent leaking secrets or weakening
  // sanitization/budget protections.
  let repoConfig: Partial<Config> = {};
  let repoSanitizationExtraPatterns: string[] = [];
  const repoCassDir = await resolveRepoDir();

  if (repoCassDir) {
    const { config: repoConfigRaw } = await loadConfigFromDir(repoCassDir);

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
    delete repoConfig.baseUrl; // Prevent repo from redirecting API calls to exfiltration endpoints
    delete repoConfig.ollamaBaseUrl; // Same concern — controls where model calls are sent
    delete repoConfig.cliCommand; // Prevent repo from redirecting CLI calls to arbitrary executables
    // Same class of concern: this is the directory cm runs an agent CLI in, and
    // clearing it would also re-open the #76 self-reflection loop.
    delete (repoConfig as any).cliSubprocessCwd;
    delete (repoConfig as any).budget;
    delete (repoConfig as any).sanitization;
    // `serve` is a deployment concern (bounds a shared `cm serve` process); a
    // committed repo config must not weaken/override a host's admission limits.
    delete (repoConfig as any).serve;
  }

  // Migrate CLI overrides as well (unlikely but complete)
  const migratedOverrides = migrateLlmConfig(cliOverrides);

  // Environment variable overrides
  const envOverrides: Partial<Config> = {};
  if (process.env.CASS_PATH) {
    envOverrides.cassPath = process.env.CASS_PATH;
  }
  if (process.env.OLLAMA_BASE_URL) {
    envOverrides.ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  }

  // `cm serve` admission-control env overrides (#61). Parsed leniently: a
  // non-integer value is ignored (falls back to config/default) rather than
  // failing config load for a shared server process.
  const parseEnvInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isInteger(n) ? n : undefined;
  };
  const serveEnv: Partial<Config["serve"]> = {};
  const maxConc = parseEnvInt(process.env.MCP_CASS_MAX_CONCURRENCY);
  if (maxConc !== undefined) serveEnv.maxConcurrentCassCalls = maxConc;
  const maxQueue = parseEnvInt(process.env.MCP_CASS_MAX_QUEUE);
  if (maxQueue !== undefined && maxQueue >= 0) serveEnv.maxQueuedCassCalls = maxQueue;
  const queueTimeout = parseEnvInt(process.env.MCP_CASS_QUEUE_TIMEOUT_MS);
  if (queueTimeout !== undefined && queueTimeout >= 0) serveEnv.cassQueueTimeoutMs = queueTimeout;
  if (Object.keys(serveEnv).length > 0) {
    envOverrides.serve = serveEnv as Config["serve"];
  }

  // Base URL env var fallback: provider-specific env vars override config.
  // Checked in order: OPENAI_BASE_URL, ANTHROPIC_BASE_URL, GOOGLE_BASE_URL.
  // Only applied when no config-level baseUrl is already set from any source.
  if (!(globalConfig as any).baseUrl && !(migratedOverrides as any).baseUrl && !(repoConfig as any).baseUrl) {
    const baseUrlFromEnv =
      process.env.OPENAI_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      process.env.GOOGLE_BASE_URL;
    if (baseUrlFromEnv) {
      envOverrides.baseUrl = baseUrlFromEnv;
    }
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
    serve: {
      ...defaults.serve,
      ...(globalConfig.serve || {}),
      ...(envOverrides.serve || {}),
      ...(cliOverrides.serve || {}),
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

  // Resolve legacy hardcoded defaults to the dynamic global dir *only* when
  // the user has explicitly opted into a non-default global location via
  // CASS_MEMORY_HOME or XDG_DATA_HOME. Without an explicit override we must
  // preserve the portable "~/.cass-memory/..." literal so:
  //   - security tests can assert that repo configs cannot override sensitive
  //     paths (the returned value must equal DEFAULT_CONFIG.playbookPath /
  //     .diaryDir exactly, not a $HOME-expanded absolute path), and
  //   - saveConfig/loadConfig round-trips remain stable.
  // Downstream callers all run the value through expandPath(), which handles
  // the "~" expansion at use-time.
  const hasExplicitGlobalDir =
    !!process.env.CASS_MEMORY_HOME || !!process.env.XDG_DATA_HOME;
  if (hasExplicitGlobalDir) {
    const globalDir = resolveGlobalDir();
    const legacyDefaults: Record<string, string> = {
      playbookPath: "~/.cass-memory/playbook.yaml",
      diaryDir: "~/.cass-memory/diary",
    };
    for (const [key, legacyDefault] of Object.entries(legacyDefaults)) {
      const val = (result.data as any)[key];
      if (val === legacyDefault) {
        (result.data as any)[key] = path.join(globalDir, key === "playbookPath" ? "playbook.yaml" : "diary");
      }
    }
  }

  configureEmbeddingBackend(result.data);
  return result.data;
}

// --- Global config file I/O (format-aware) ---

/**
 * Raw (unvalidated) contents of the active global config file.
 *
 * `data` is `{}` when no file exists, and `null` when the file exists but
 * could not be parsed or is not an object — writers must never clobber such
 * a file. YAML keys are normalized to camelCase exactly like the loader does.
 */
export async function readGlobalConfigRaw(): Promise<{
  file: ResolvedConfigFile;
  data: Record<string, unknown> | null;
}> {
  const file = await resolveGlobalConfigFile();
  if (!file.exists) return { file, data: {} };

  try {
    const content = await fs.readFile(file.path, "utf-8");
    const parsed: unknown =
      file.format === "yaml" ? normalizeYamlKeys(yaml.parse(content)) : JSON.parse(content);
    // An empty YAML file parses to null; treat it as an empty object.
    if (parsed === null || parsed === undefined) return { file, data: {} };
    if (typeof parsed !== "object" || Array.isArray(parsed)) return { file, data: null };
    return { file, data: parsed as Record<string, unknown> };
  } catch {
    return { file, data: null };
  }
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Write the global config file in that file's format.
 *
 * JSON: `data` is written as the whole document (callers pass the merged
 * object). YAML: only `changedKeys` are updated in the existing document, so
 * comments and untouched sections survive; a `snake_case` spelling of an
 * updated key is dropped so the file never carries two spellings of one
 * setting.
 */
async function writeGlobalConfigKeys(
  file: ResolvedConfigFile,
  data: Record<string, unknown>,
  changedKeys: string[] = Object.keys(data)
): Promise<void> {
  if (file.format === "json") {
    await atomicWrite(file.path, JSON.stringify(data, null, 2));
    return;
  }

  const existing = file.exists ? await fs.readFile(file.path, "utf-8") : "";
  const doc = yaml.parseDocument(existing);
  if (doc.errors.length > 0 || (doc.contents !== null && !yaml.isMap(doc.contents))) {
    // readGlobalConfigRaw() already reports such files as unwritable (null);
    // this is the last line of defense against clobbering them.
    throw new Error(`Refusing to rewrite ${file.path}: not a valid YAML mapping`);
  }
  for (const key of changedKeys) {
    const value = data[key];
    const snake = camelToSnake(key);
    if (snake !== key && doc.has(snake)) doc.delete(snake);
    if (value === undefined) {
      // JSON.stringify drops undefined; mirror that instead of writing `null`.
      doc.delete(key);
      continue;
    }
    doc.set(key, value);
  }
  await atomicWrite(file.path, doc.toString());
}

/**
 * Merge top-level keys into the global config file, preserving every other
 * key (and, for YAML, comments). Creates `config.json` when no global config
 * file exists yet.
 *
 * `values` may be a function of the current (normalized) file contents, for
 * patches that need to merge into a nested object.
 *
 * @returns true if the file was written, false if it was skipped because the
 *          existing file is corrupt or not an object (never clobbered).
 */
export async function patchGlobalConfig(
  values:
    | Record<string, unknown>
    | ((existing: Record<string, unknown>) => Record<string, unknown>)
): Promise<boolean> {
  const { file, data } = await readGlobalConfigRaw();
  if (data === null) return false;
  const patch = typeof values === "function" ? values(data) : values;
  await writeGlobalConfigKeys(file, { ...data, ...patch }, Object.keys(patch));
  return true;
}

export async function saveConfig(config: Config): Promise<void> {
  const file = await resolveGlobalConfigFile();

  // Normalize dynamically resolved paths back to portable defaults before
  // persisting. loadConfig() expands "~/.cass-memory/playbook.yaml" to an
  // absolute path at runtime; if we saved that absolute path, it would
  // become stale when CASS_MEMORY_HOME or XDG_DATA_HOME changes.
  const globalDir = resolveGlobalDir();
  const toSave = { ...config };
  if (toSave.playbookPath === path.join(globalDir, "playbook.yaml")) {
    toSave.playbookPath = "~/.cass-memory/playbook.yaml";
  }
  if (toSave.diaryDir === path.join(globalDir, "diary")) {
    toSave.diaryDir = "~/.cass-memory/diary";
  }

  await writeGlobalConfigKeys(file, toSave as unknown as Record<string, unknown>);
}

// --- Budget baking (#68) ---

/**
 * Check whether the reflect budget limits are explicitly present ("baked")
 * in the user's global config file, as opposed to coming from the zod
 * schema defaults at load time.
 *
 * Rationale (#68): `cm init` never calls saveConfig, so most users have no
 * budget keys on disk — which means any future change to the code defaults
 * would silently apply to them. We treat the budget as baked only when both
 * spend ceilings (dailyLimit and monthlyLimit) are present in the file.
 */
export async function isBudgetBakedInConfig(): Promise<boolean> {
  // Unreadable/corrupt config reads as null: report unbaked so the
  // default-budget notice shows; bakeBudgetIntoConfig separately refuses to
  // clobber such a file.
  const { data } = await readGlobalConfigRaw();
  const budget = data?.budget;
  return (
    !!budget &&
    typeof budget === "object" &&
    !Array.isArray(budget) &&
    (budget as Record<string, unknown>).dailyLimit !== undefined &&
    (budget as Record<string, unknown>).monthlyLimit !== undefined
  );
}

/**
 * Persist ONLY the resolved budget keys into the global config file,
 * preserving all other config content (and key order — JSON.parse/stringify
 * keep object insertion order, and an existing `budget` key keeps its
 * position). Unknown extra keys inside an existing `budget` object are
 * preserved too.
 *
 * Unlike saveConfig(), this deliberately does NOT write the full resolved
 * config: baking every default would freeze all of them, when the goal
 * (#68) is only to pin the spend ceilings in effect at first reflect.
 *
 * @returns true if the file was written, false if baking was skipped
 *          (existing file is corrupt or not an object).
 */
export async function bakeBudgetIntoConfig(budget: BudgetConfig): Promise<boolean> {
  return patchGlobalConfig((existing) => {
    const existingBudget =
      existing.budget && typeof existing.budget === "object" && !Array.isArray(existing.budget)
        ? (existing.budget as Record<string, unknown>)
        : {};
    return {
      budget: {
        ...existingBudget,
        dailyLimit: budget.dailyLimit,
        monthlyLimit: budget.monthlyLimit,
        warningThreshold: budget.warningThreshold,
        currency: budget.currency,
      },
    };
  });
}
