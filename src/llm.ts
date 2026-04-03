// src/llm.ts
// LLM Provider Abstraction - Using Vercel AI SDK
// Supports OpenAI, Anthropic, Google, Ollama, AWS Bedrock, and CLI providers with a unified interface

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOllama } from "ollama-ai-provider";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config, DiaryEntry, LLMProvider } from "./types.js";
import { checkBudget, recordCost } from "./cost.js";
import { truncateForContext, warn } from "./utils.js";

// Re-export LLMProvider from types.ts (single source of truth)
export type { LLMProvider } from "./types.js";

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMGenerateObjectResult<T> {
  object: T;
  usage?: LLMUsage;
}

export interface LLMIO {
  generateObject: <T>(options: any) => Promise<LLMGenerateObjectResult<T>>;
}

const DEFAULT_LLM_IO: LLMIO = {
  generateObject: generateObject as any,
};

/**
 * Minimal config interface for LLM operations.
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  ollamaBaseUrl?: string;
}

/**
 * Map of provider names to environment variable names.
 * Ollama uses OLLAMA_BASE_URL instead of an API key, but is included
 * here so getAvailableProviders() can detect it.
 */
const ENV_VAR_MAP: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  ollama: "OLLAMA_BASE_URL",
  bedrock: "AWS_ACCESS_KEY_ID",
  cli: "CASS_CLI_COMMAND",
};

/**
 * Expected key prefixes for format validation.
 * Ollama has no API key, so no prefix is checked.
 */
const KEY_PREFIX_MAP: Record<string, string> = {
  openai: "sk-",
  anthropic: "sk-ant-",
  google: "AIza",
};

export function getApiKey(provider: string): string {
  const normalized = provider.trim().toLowerCase() as LLMProvider;

  // Ollama and Bedrock don't use a single API key — return empty string.
  // Bedrock uses the AWS credential chain (env vars, profile, IAM role).
  if (normalized === "ollama" || normalized === "bedrock") {
    return "";
  }

  const envVar = ENV_VAR_MAP[normalized];
  if (!envVar) {
    const supported = Object.keys(ENV_VAR_MAP).join(", ");
    throw new Error(
      `Unknown LLM provider '${provider}'. Supported providers: ${supported}.`
    );
  }

  const apiKey = process.env[envVar];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      `${envVar} environment variable not found. Set it with: export ${envVar}=<your-key>`
    );
  }

  return apiKey.trim();
}

export function validateApiKey(provider: string): void {
  const normalized = provider.trim().toLowerCase() as LLMProvider;

  // Ollama and Bedrock don't use a traditional API key — nothing to validate.
  if (normalized === "ollama" || normalized === "bedrock") return;

  const envVar = ENV_VAR_MAP[normalized];
  if (!envVar) return;

  const apiKey = process.env[envVar];
  if (!apiKey) return;

  const expectedPrefix = KEY_PREFIX_MAP[normalized];
  if (expectedPrefix && !apiKey.startsWith(expectedPrefix)) {
    warn(
      `Warning: ${provider} API key does not start with '${expectedPrefix}' - this may be incorrect`
    );
  }

  const placeholders = ["YOUR_API_KEY", "xxx", "test", "demo", "placeholder"];
  const lowerKey = apiKey.toLowerCase();
  for (const placeholder of placeholders) {
    if (lowerKey.includes(placeholder.toLowerCase())) {
      warn(
        `Warning: ${provider} API key appears to contain a placeholder ('${placeholder}')`
      );
      break;
    }
  }

  if (apiKey.length < 20) {
    warn(
      `Warning: ${provider} API key seems too short (${apiKey.length} chars) - this may be incorrect`
    );
  }
}

/**
 * Resolve the Ollama base URL.
 * Priority: OLLAMA_BASE_URL env > OLLAMA_HOST env > config value > default.
 * Env vars take precedence because config.ollamaBaseUrl always has a Zod
 * default ("http://localhost:11434"), which would shadow OLLAMA_HOST otherwise.
 * OLLAMA_HOST may be just "host:port" (no scheme), so we prepend http://.
 */
export function resolveOllamaBaseUrl(ollamaBaseUrl?: string): string {
  if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
  const host = process.env.OLLAMA_HOST;
  if (host) {
    return host.startsWith("http") ? host : `http://${host}`;
  }
  return ollamaBaseUrl || "http://localhost:11434";
}

export function getModel(config: { provider: string; model: string; apiKey?: string; baseUrl?: string; ollamaBaseUrl?: string }): LanguageModel {
  const provider = config.provider as LLMProvider;

  if (provider === "ollama") {
    const baseURL = resolveOllamaBaseUrl(config.ollamaBaseUrl);
    // ollama-ai-provider expects baseURL with /api suffix
    const normalizedBase = baseURL.replace(/\/+$/, "");
    const apiBase = normalizedBase.endsWith("/api") ? normalizedBase : `${normalizedBase}/api`;
    return createOllama({ baseURL: apiBase })(config.model);
  }

  if (provider === "bedrock") {
    const bedrock = createAmazonBedrock({
      region: process.env.AWS_REGION || "us-east-1",
      // Uses AWS credential chain: env vars (AWS_ACCESS_KEY_ID +
      // AWS_SECRET_ACCESS_KEY), shared credentials file, IAM role, etc.
    });
    return bedrock(config.model);
  }

  const apiKey = config.apiKey || getApiKey(provider);

  // Support custom base URL for OpenAI-compatible endpoints (OpenRouter, Azure, etc.)
  const baseURL = config.baseUrl;

  switch (provider) {
    case "openai": return createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(config.model);
    case "anthropic": return createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })(config.model);
    case "google": return createGoogleGenerativeAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(config.model);
    default: throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

// --- CLI LLM Backend ---
// Shells out to installed CLI tools (claude, codex, gemini) for LLM calls,
// reusing their existing auth instead of requiring separate API keys.

/** Known CLI tools and their invocation flags (prompt is always piped via stdin). */
const CLI_TOOL_CONFIGS: Record<string, { flags: string[] }> = {
  claude:  { flags: ["-p"] },       // claude -p (print mode, reads prompt from stdin)
  codex:   { flags: ["--quiet"] },  // codex --quiet (reads from stdin)
  gemini:  { flags: [] },           // gemini (reads from stdin)
};

/** Cached result of CLI tool resolution to avoid repeated `which` subprocesses. */
let _cliResolveCache: { key: string; result: string | null } | null = null;

/**
 * Resolve which CLI command to use.
 * Priority: config.cliCommand > CASS_CLI_COMMAND env > auto-detect on PATH.
 * Result is cached per key to avoid repeated subprocess calls.
 */
export function resolveCliCommand(cliCommand?: string): string | null {
  const key = cliCommand || process.env.CASS_CLI_COMMAND || "__auto__";
  if (_cliResolveCache?.key === key) return _cliResolveCache.result;

  let result: string | null = null;

  if (cliCommand) {
    result = cliCommand;
  } else if (process.env.CASS_CLI_COMMAND) {
    result = process.env.CASS_CLI_COMMAND;
  } else {
    // Auto-detect: check known tools on PATH
    for (const tool of Object.keys(CLI_TOOL_CONFIGS)) {
      try {
        const proc = Bun.spawnSync(["which", tool], { stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode === 0) { result = tool; break; }
      } catch {
        // which not available or tool not found — try next
      }
    }
  }

  _cliResolveCache = { key, result };
  return result;
}

/**
 * Check if a CLI LLM tool is available (synchronous, cached via resolveCliCommand).
 */
export function isCliAvailable(cliCommand?: string): boolean {
  return resolveCliCommand(cliCommand) !== null;
}

/**
 * Extract JSON from CLI output that may contain markdown fences or prose.
 * Tries progressively less strict strategies and validates with JSON.parse.
 */
function extractJsonFromOutput(output: string): string {
  const trimmed = output.trim();

  // Strategy 1: the entire output is valid JSON
  try { JSON.parse(trimmed); return trimmed; } catch {}

  // Strategy 2: extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    try { JSON.parse(fenceMatch[1].trim()); return fenceMatch[1].trim(); } catch {}
  }

  // Strategy 3: find the first `{...}` or `[...]` that parses as valid JSON.
  // Scan for opening braces/brackets and try parsing from each position.
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const closing = ch === "{" ? "}" : "]";
    // Search backwards from end for the matching close
    for (let j = trimmed.length - 1; j > i; j--) {
      if (trimmed[j] !== closing) continue;
      const candidate = trimmed.slice(i, j + 1);
      try { JSON.parse(candidate); return candidate; } catch {}
      break; // only try the outermost matching close for this opening
    }
  }

  // Fallback: return as-is and let the caller's JSON.parse fail with a clear error
  return trimmed;
}

/**
 * Call an LLM via a CLI tool (claude, codex, gemini, etc.).
 * Sends the prompt as an argument and parses JSON from stdout.
 */
export async function cliGenerateObject<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  cliCommand?: string,
): Promise<{ object: T; usage: LLMUsage }> {
  const cmd = resolveCliCommand(cliCommand);
  if (!cmd) {
    throw new Error(
      "No CLI LLM tool found. Install one of: claude, codex, gemini — or set cliCommand in config."
    );
  }

  // Build a schema hint for the prompt — uses zodToJsonSchema-like extraction
  let schemaHint = "structured JSON object";
  try {
    const schemaDef = (schema as any)?._def;
    if (schemaDef?.typeName === "ZodObject" && schemaDef?.shape) {
      const shape = typeof schemaDef.shape === "function" ? schemaDef.shape() : schemaDef.shape;
      const fields = Object.entries(shape).map(([k, v]) => `"${k}": ${(v as any)?._def?.typeName || "unknown"}`);
      schemaHint = `{ ${fields.join(", ")} }`;
    }
  } catch { /* non-critical — use generic hint */ }

  const enhancedPrompt = [
    prompt,
    "",
    "CRITICAL: You MUST respond with ONLY valid JSON (no markdown, no explanation, no prose).",
    `The JSON must conform to this schema: ${schemaHint}`,
    "Output ONLY the JSON object, nothing else.",
  ].join("\n");

  // Resolve invocation pattern — prompt is always piped via stdin to avoid
  // hitting OS argument length limits on long reflection prompts.
  const toolConfig = CLI_TOOL_CONFIGS[cmd] ?? { flags: [] };
  const spawnArgs = [cmd, ...toolConfig.flags];

  const proc = Bun.spawn(spawnArgs, {
    stdin: new Response(enhancedPrompt).body!,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `CLI tool '${cmd}' exited with code ${exitCode}: ${stderr.slice(0, 500)}`
    );
  }

  if (!stdout.trim()) {
    throw new Error(`CLI tool '${cmd}' produced no output`);
  }

  // Parse JSON from output
  const jsonStr = extractJsonFromOutput(stdout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from '${cmd}' output:\n${jsonStr.slice(0, 500)}`
    );
  }

  // Validate against schema
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `CLI output failed schema validation: ${validated.error.message}\nRaw JSON: ${jsonStr.slice(0, 500)}`
    );
  }

  return {
    object: validated.data,
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

export function isLLMAvailable(provider: LLMProvider): boolean {
  // Ollama is "available" when either OLLAMA_BASE_URL or OLLAMA_HOST is set.
  // We cannot auto-detect a running local server because this function is
  // synchronous and a network probe would block.
  if (provider === "ollama") {
    return !!process.env.OLLAMA_BASE_URL || !!process.env.OLLAMA_HOST;
  }
  // Bedrock supports multiple auth methods: explicit credentials, shared
  // credentials file, IAM roles, etc.  Check for the most common env vars.
  if (provider === "bedrock") {
    return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      || !!process.env.AWS_PROFILE
      || !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  }
  // CLI provider: check if a CLI LLM tool is on PATH
  if (provider === "cli") {
    return isCliAvailable();
  }
  const envVar = ENV_VAR_MAP[provider];
  return !!process.env[envVar];
}

export function getAvailableProviders(): LLMProvider[] {
  return (Object.keys(ENV_VAR_MAP) as LLMProvider[]).filter((provider) =>
    isLLMAvailable(provider)
  );
}

// --- Prompt Templates ---

export const PROMPTS = {
  diary: `You are analyzing a coding agent session to extract structured insights.

SESSION METADATA:
- Path: {sessionPath}
- Agent: {agent}
- Workspace: {workspace}

<session_content>
{content}
</session_content>

INSTRUCTIONS:
Extract the following from the session content above. Be SPECIFIC and ACTIONABLE.
Avoid generic statements like "wrote code" or "fixed bug".
Include specific:
- File names and paths
- Function/class/component names
- Error messages and stack traces
- Commands run
- Tools used

If the session lacks information for a field, provide an empty array.

Respond with JSON matching this schema:
{
  "status": "success" | "failure" | "mixed",
  "accomplishments": string[],  // Specific completed tasks with file/function names
  "decisions": string[],        // Design choices with rationale
  "challenges": string[],       // Problems encountered, errors, blockers
  "preferences": string[],      // User style revelations
  "keyLearnings": string[],     // Reusable insights
  "tags": string[],             // Discovery keywords
  "searchAnchors": string[]     // Search phrases for future retrieval
}`,

  reflector: `You are analyzing a coding session diary to extract reusable lessons for a playbook.

<existing_playbook>
{existingBullets}
</existing_playbook>

<session_diary>
{diary}
</session_diary>

<cass_history>
{cassHistory}
</cass_history>

{iterationNote}

INSTRUCTIONS:
Extract playbook deltas (changes) from this session. Each delta should be:
- SPECIFIC: Bad: "Write tests". Good: "For React hooks, test effects separately with renderHook"
- ACTIONABLE: Include concrete examples, file patterns, command flags
- REUSABLE: Would help a DIFFERENT agent on a similar problem

Delta types:
- add: New insight not covered by existing bullets
- helpful: Existing bullet proved useful (reference by ID)
- harmful: Existing bullet caused problems (reference by ID, explain why)
- replace: Existing bullet needs updated wording
- deprecate: Existing bullet is outdated

Maximum 20 deltas per reflection. Focus on quality over quantity.`,

  validator: `You are a scientific validator checking if a proposed rule is supported by historical evidence.

<proposed_rule>
{proposedRule}
</proposed_rule>

<historical_evidence>
{evidence}
</historical_evidence>

INSTRUCTIONS:
Analyze whether the evidence supports, contradicts, or is neutral toward the proposed rule.

Consider:
1. How many sessions show success when following this pattern?
2. How many sessions show failure when following this pattern?
3. Are there edge cases or conditions where the rule doesn't apply?
4. Is the rule too broad or too specific?

Respond with:
{
  "verdict": "ACCEPT" | "REJECT" | "REFINE" | "ACCEPT_WITH_CAUTION",
  "confidence": number,  // 0.0-1.0
  "reason": string,
  "suggestedRefinement": string | null,  // Suggested improvement if partially valid
  "evidence": { "supporting": string[], "contradicting": string[] }
}`,

  context: `You are preparing a context briefing for a coding task.

TASK DESCRIPTION:
{task}

<playbook_rules>
{bullets}
</playbook_rules>

<session_history>
{history}
</session_history>

<deprecated_patterns>
{deprecatedPatterns}
</deprecated_patterns>

INSTRUCTIONS:
Create a concise briefing that:
1. Summarizes the most relevant rules for this task
2. Highlights any pitfalls or anti-patterns to avoid
3. Suggests relevant cass searches for deeper context
4. Notes any deprecated patterns that might come up

Keep the briefing actionable and under 500 words.`,

  audit: `You are auditing a coding session to check if established rules were followed.

<session_content>
{sessionContent}
</session_content>

<rules_to_check>
{rulesToCheck}
</rules_to_check>

INSTRUCTIONS:
For each rule, determine if the session:
- FOLLOWED the rule (with evidence)
- VIOLATED the rule (with evidence)
- Rule was NOT APPLICABLE to this session

IMPORTANT: To save space, ONLY return results for rules that were explicitly FOLLOWED or VIOLATED. Omit rules that were NOT APPLICABLE.

Respond with:
{
  "results": [
    {
      "ruleId": string,
      "status": "followed" | "violated",
      "evidence": string
    }
  ],
  "summary": string
}`,
} as const;

export function fillPrompt(
  template: string,
  values: Record<string, string>
): string {
  // Use a single-pass regex replacement to prevent recursive substitution vulnerabilities.
  // This constructs a regex like /\{key1\}|\{key2\}|.../g and replaces each match.
  
  const keys = Object.keys(values);
  if (keys.length === 0) return template;

  // Escape keys for regex safety (though keys are usually trusted identifiers)
  const escapedKeys = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\{(${escapedKeys.join("|")})\\}`, "g");

  return template.replace(pattern, (match, key) => {
    // Return the value for the matched key, or the original match if somehow undefined
    return values[key] ?? match;
  });
}

// --- Resilience Wrapper ---

export const LLM_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  totalTimeoutMs: 60000, 
  perOperationTimeoutMs: 30000,
  retryableErrors: [
    "rate_limit_exceeded",
    "server_error",
    "timeout",
    "overloaded",
    "ETIMEDOUT",
    "ECONNRESET",
    "429",
    "500",
    "503"
  ]
};

async function withTimeout<T>(promise: Promise<T>, ms: number, operationName: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function llmWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  const startTime = Date.now();
  let attempt = 0;
  
  while (true) {
    try {
      const elapsed = Date.now() - startTime;
      if (elapsed > LLM_RETRY_CONFIG.totalTimeoutMs) {
        throw new Error(`${operationName} exceeded total timeout ceiling of ${LLM_RETRY_CONFIG.totalTimeoutMs}ms`);
      }

      return await withTimeout(operation(), LLM_RETRY_CONFIG.perOperationTimeoutMs, operationName);
    } catch (err: any) {
      attempt++;
      const isRetryable = LLM_RETRY_CONFIG.retryableErrors.some(e => {
        const lowerE = e.toLowerCase();
        const messageMatch = err.message?.toLowerCase().includes(lowerE);
        const codeMatch = err.code?.toString().includes(e);
        const statusMatch = err.statusCode?.toString().includes(e);
        return messageMatch || codeMatch || statusMatch;
      });
      
      if (!isRetryable || attempt > LLM_RETRY_CONFIG.maxRetries) {
        throw err;
      }
      
      const delay = Math.min(
        LLM_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt), 
        LLM_RETRY_CONFIG.maxDelayMs
      );
      
      warn(`[LLM] ${operationName} failed (attempt ${attempt}): ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Explicitly type monitoredGenerateObject to return GenerateObjectResult<T>
async function monitoredGenerateObject<T>(
  options: any,
  config: Config,
  context: string,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<LLMGenerateObjectResult<T>> {
  const budgetCheck = await checkBudget(config);
  if (!budgetCheck.allowed) {
    throw new Error(`LLM budget exceeded: ${budgetCheck.reason}`);
  }

  const result = await io.generateObject<T>({
    ...options,
    // Ensure schema is passed through if present in options, typically it is
  });

  if (result.usage) {
    await recordCost(config, {
      provider: config.provider,
      model: config.model,
      tokensIn: result.usage.promptTokens,
      tokensOut: result.usage.completionTokens,
      context
    });
  }
  
  return result;
}

export async function generateObjectSafe<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config,
  maxAttempts: number = 3,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<T> {
  // CLI provider: bypass AI SDK entirely and shell out to the CLI tool
  if (config.provider === "cli" && io === DEFAULT_LLM_IO) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await cliGenerateObject(schema, prompt, config.cliCommand);
        return result.object;
      } catch (err: any) {
        if (attempt >= maxAttempts) throw err;
        warn(`[CLI] Attempt ${attempt} failed: ${err.message}. Retrying...`);
      }
    }
    throw new Error("CLI LLM backend: all attempts exhausted");
  }

  // Only create real model when using real LLM (not mock LLMIO)
  // Mock LLMIO ignores the model and just uses prompt content for detection
  let model: ReturnType<typeof getModel> | null = null;
  if (io === DEFAULT_LLM_IO) {
    const llmConfig: LLMConfig = {
      provider: config.provider as LLMProvider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      ollamaBaseUrl: config.ollamaBaseUrl
    };
    model = getModel(llmConfig);
  }
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const enhancedPrompt = attempt > 1
        ? `[PREVIOUS ATTEMPT FAILED - OUTPUT MUST BE VALID JSON]\n\n${prompt}\n\nCRITICAL: Your response MUST be valid JSON matching the provided schema exactly. Ensure all required fields are present.`
        : prompt;

      const temperature = attempt > 1 ? 0.35 : 0.3;

      const result = await monitoredGenerateObject<T>({ 
        model,
        schema,
        prompt: enhancedPrompt,
        temperature
      }, config, "generateObjectSafe", io);

      return result.object;
    } catch (err: any) {
      lastError = err;
      
      const errorMsg = err.message || String(err);
      const isBudgetError = errorMsg.includes("budget exceeded");
      
      // Stop immediately for budget errors
      if (isBudgetError) throw err;

      // Identify hard API errors that won't be fixed by retrying (400 Bad Request, 401 Unauthorized, 403 Forbidden)
      // Note: 429 and 5xx are handled by llmWithRetry
      const status = err.statusCode || err.status;
      const isHardApiError = status === 400 || status === 401 || status === 403;
      
      if (isHardApiError) {
        warn(`[LLM] Hard API error (${status}): ${errorMsg}. Not retrying.`);
        throw err;
      }
      
      // Check if it's a network/rate-limit error that llmWithRetry should handle
      const isNetworkOrApiError = LLM_RETRY_CONFIG.retryableErrors.some(e => 
        errorMsg.toLowerCase().includes(e.toLowerCase()) || 
        err.code?.toString().includes(e) ||
        err.statusCode?.toString().includes(e)
      );

      if (isNetworkOrApiError) {
         // Rethrow so llmWithRetry can handle the backoff/retry logic at the higher level
         throw err; 
      }

      // If we are here, it's likely a schema validation error or model hallucination (JSON parse error).
      // We log it and continue the loop to retry with a "fix it" prompt.
      if (attempt < maxAttempts) {
        warn(`[LLM] Schema validation failed (attempt ${attempt}): ${errorMsg}. Retrying with stricter prompt...`);
      }
    }
  }

  throw lastError ?? new Error("generateObjectSafe failed after all attempts");
}

// --- Operations ---

// Optional reflector stubs for offline/tests.
// Set `CM_REFLECTOR_STUBS` to a JSON array of per-iteration reflector outputs
// (typically objects like `{ deltas: [...] }`).
let REFLECTOR_STUBS: unknown[] | null = null;
let REFLECTOR_STUB_INDEX = 0;

export function __resetReflectorStubsForTest(): void {
  REFLECTOR_STUBS = null;
  REFLECTOR_STUB_INDEX = 0;
}

function nextReflectorStub<T>(): T | null {
  if (!REFLECTOR_STUBS) {
    const raw = process.env.CM_REFLECTOR_STUBS;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        REFLECTOR_STUBS = parsed as unknown[];
      }
    } catch {
      return null;
    }
  }
  if (!REFLECTOR_STUBS) return null;
  const idx = Math.min(REFLECTOR_STUB_INDEX, REFLECTOR_STUBS.length - 1);
  const value = REFLECTOR_STUBS[idx] as T;
  REFLECTOR_STUB_INDEX++;
  return value ?? null;
}

export async function extractDiary<T>(
  schema: z.ZodSchema<T>,
  sessionContent: string,
  metadata: { sessionPath: string; agent: string; workspace?: string },
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<T> {
  const truncatedContent = truncateForContext(sessionContent, { maxChars: 50000 });

  const prompt = fillPrompt(PROMPTS.diary, {
    sessionPath: metadata.sessionPath,
    agent: metadata.agent,
    workspace: metadata.workspace || "unknown",
    content: truncatedContent
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(schema, prompt, config, 3, io);
  }, "extractDiary");
}

export async function runReflector<T>(
  schema: z.ZodSchema<T>,
  diary: DiaryEntry,
  existingBullets: string,
  cassHistory: string,
  iteration: number,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<T> {
  // Only check env-based stubs when using default IO (backward compat for subprocess E2E tests).
  // When explicit LLMIO is injected, tests control responses directly via the io object.
  if (io === DEFAULT_LLM_IO) {
    const stub = nextReflectorStub<T>();
    if (stub) {
      return stub;
    }
  }

  const diaryText = `
Status: ${diary.status}
Accomplishments: ${diary.accomplishments.join('\n- ')}
Decisions: ${diary.decisions.join('\n- ')}
Challenges: ${diary.challenges.join('\n- ')}
Preferences: ${diary.preferences.join('\n- ')}
Key Learnings: ${diary.keyLearnings.join('\n- ')}
`.trim();

  const iterationNote = iteration > 0
    ? `This is iteration ${iteration + 1}. Focus on insights you may have missed in previous passes.`
    : "";

  const safeExistingBullets = truncateForContext(existingBullets, { maxChars: 20000 });
  const safeCassHistory = truncateForContext(cassHistory, { maxChars: 20000 });

  const prompt = fillPrompt(PROMPTS.reflector, {
    existingBullets: safeExistingBullets,
    diary: diaryText,
    cassHistory: safeCassHistory,
    iterationNote,
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(schema, prompt, config, 3, io);
  }, "runReflector");
}

export interface ValidatorResult {
  valid: boolean;
  verdict: 'ACCEPT' | 'REJECT' | 'REFINE' | 'ACCEPT_WITH_CAUTION';
  confidence: number;
  reason: string;
  evidence: Array<{ sessionPath: string; snippet: string; supports: boolean }>;
  suggestedRefinement?: string;
}

const ValidatorOutputSchema = z.object({
  verdict: z.enum(['ACCEPT', 'REJECT', 'REFINE', 'ACCEPT_WITH_CAUTION']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.object({
    supporting: z.array(z.string()).default([]),
    contradicting: z.array(z.string()).default([])
  }),
  suggestedRefinement: z.string().optional().nullable()
});

// Helper interface for ValidatorOutput
type ValidatorOutput = z.infer<typeof ValidatorOutputSchema>;

export async function runValidator(
  proposedRule: string,
  formattedEvidence: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<ValidatorResult> {
  const safeEvidence = truncateForContext(formattedEvidence, { maxChars: 30000 });

  const prompt = fillPrompt(PROMPTS.validator, {
    proposedRule,
    evidence: safeEvidence
  });

  return llmWithRetry(async () => {
    const object = await generateObjectSafe(ValidatorOutputSchema, prompt, config, 3, io);

    const supporting = object.evidence?.supporting ?? [];
    const contradicting = object.evidence?.contradicting ?? [];

    const mappedEvidence = [
      ...supporting.map((s: string) => ({ sessionPath: "unknown", snippet: s, supports: true })),
      ...contradicting.map((s: string) => ({ sessionPath: "unknown", snippet: s, supports: false }))
    ];

    return {
      valid: object.verdict === 'ACCEPT',
      verdict: object.verdict,
      confidence: object.confidence,
      reason: object.reason,
      evidence: mappedEvidence,
      suggestedRefinement: object.suggestedRefinement || undefined
    };
  }, "runValidator");
}

export async function generateContext(
  task: string,
  bullets: string,
  history: string,
  deprecatedPatterns: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<string> {
  const prompt = fillPrompt(PROMPTS.context, {
    task: truncateForContext(task, { maxChars: 5000 }),
    bullets: truncateForContext(bullets, { maxChars: 20000 }),
    history: truncateForContext(history, { maxChars: 20000 }),
    deprecatedPatterns: truncateForContext(deprecatedPatterns, { maxChars: 5000 })
  });

  return llmWithRetry(async () => {
    const result = await generateObjectSafe(z.object({ briefing: z.string() }), prompt, config, 3, io);
    return result.briefing;
  }, "generateContext");
}

export async function generateSearchQueries(
  task: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<string[]> {
  const prompt = `Given this task: ${truncateForContext(task, { maxChars: 5000 })}

Generate 3-5 diverse search queries to find relevant information:
- Similar problems encountered before
- Related frameworks or tools
- Relevant patterns or best practices
- Error messages or debugging approaches

Make queries specific enough to be useful but broad enough to match variations.`;

  return llmWithRetry(async () => {
    const result = await generateObjectSafe(
      z.object({ queries: z.array(z.string()).max(5) }), 
      prompt, 
      config,
      3,
      io
    );
    return result.queries;
  }, "generateSearchQueries");
}

// --- Multi-Provider Fallback ---

const FALLBACK_ORDER: LLMProvider[] = ["anthropic", "openai", "google", "bedrock", "ollama", "cli"];

const FALLBACK_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.2:3b",
  bedrock: "anthropic.claude-sonnet-4-20250514-v1:0",
  cli: "default",
};

export async function llmWithFallback<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<T> {
  const primaryProvider = config.provider as LLMProvider;
  const primaryModel = config.model;

  const apiKeyOverride =
    typeof config.apiKey === "string" && config.apiKey.trim() !== "" ? config.apiKey.trim() : undefined;

  const availableProviders = getAvailableProviders();
  const providerOrder: Array<{ provider: LLMProvider; model: string; apiKey?: string }> = [];

  // Ollama and Bedrock are always considered available when explicitly configured
  // as the primary provider: Ollama defaults to localhost:11434, and Bedrock can
  // use IAM roles or instance profiles that we can't detect via env vars.
  const primaryUsesImplicitAuth = primaryProvider === "ollama" || primaryProvider === "bedrock";
  if (availableProviders.includes(primaryProvider) || apiKeyOverride !== undefined || primaryUsesImplicitAuth) {
    providerOrder.push({ provider: primaryProvider, model: primaryModel, apiKey: apiKeyOverride });
  }

  for (const fallback of FALLBACK_ORDER) {
    if (fallback !== primaryProvider && availableProviders.includes(fallback)) {
      providerOrder.push({ provider: fallback, model: FALLBACK_MODELS[fallback] });
    }
  }

  if (providerOrder.length === 0) {
    throw new Error(
      "No LLM providers available. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OLLAMA_BASE_URL, AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY (Bedrock), or install a CLI tool (claude, codex, gemini)"
    );
  }

  const errors: Array<{ provider: string; error: string }> = [];

  for (let i = 0; i < providerOrder.length; i++) {
    const { provider, model, apiKey } = providerOrder[i];
    const isLastProvider = i === providerOrder.length - 1;

    try {
      // CLI provider: bypass AI SDK, shell out directly
      if (provider === "cli") {
        const result = await cliGenerateObject<T>(schema, prompt, config.cliCommand);
        return result.object;
      }

      const llmModel = getModel({ provider, model, apiKey, baseUrl: config.baseUrl, ollamaBaseUrl: config.ollamaBaseUrl });
      const costConfig: Config = { ...config, provider, model, apiKey };

      const result = await monitoredGenerateObject<T>({
        model: llmModel,
        schema,
        prompt,
        temperature: 0.3,
      }, costConfig, "llmWithFallback", io);

      return result.object;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      errors.push({ provider, error: errorMsg });

      if (isLastProvider) {
        warn(`[LLM] ${provider} failed: ${errorMsg}. No more providers to try.`);
      } else {
        warn(`[LLM] ${provider} failed: ${errorMsg}. Trying next provider...`);
      }
    }
  }

  const errorSummary = errors
    .map(e => `${e.provider}: ${e.error}`)
    .join("\n  ");

  throw new Error(`All LLM providers failed:\n  ${errorSummary}`);
}
