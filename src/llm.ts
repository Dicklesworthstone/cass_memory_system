// src/llm.ts
// LLM Provider Abstraction - Using Vercel AI SDK
// Supports OpenAI, Anthropic, and Google providers with a unified interface

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, type LanguageModel, type GenerateObjectResult } from "ai";
import { z } from "zod";
import type { Config, DiaryEntry } from "./types.js";
import { checkBudget, recordCost } from "./cost.js";

/**
 * Supported LLM provider names
 */
export type LLMProvider = "openai" | "anthropic" | "google";

/**
 * Minimal config interface for LLM operations.
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
}

/**
 * Map of provider names to environment variable names
 */
const ENV_VAR_MAP: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/**
 * Expected key prefixes for format validation
 */
const KEY_PREFIX_MAP: Record<LLMProvider, string> = {
  openai: "sk-",
  anthropic: "sk-ant-",
  google: "AIza",
};

export function getApiKey(provider: string): string {
  const normalized = provider.trim().toLowerCase() as LLMProvider;

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
  const envVar = ENV_VAR_MAP[normalized];
  if (!envVar) return;

  const apiKey = process.env[envVar];
  if (!apiKey) return;

  const expectedPrefix = KEY_PREFIX_MAP[normalized];
  if (expectedPrefix && !apiKey.startsWith(expectedPrefix)) {
    console.warn(
      `Warning: ${provider} API key does not start with '${expectedPrefix}' - this may be incorrect`
    );
  }

  const placeholders = ["YOUR_API_KEY", "xxx", "test", "demo", "placeholder"];
  const lowerKey = apiKey.toLowerCase();
  for (const placeholder of placeholders) {
    if (lowerKey.includes(placeholder.toLowerCase())) {
      console.warn(
        `Warning: ${provider} API key appears to contain a placeholder ('${placeholder}')`
      );
      break;
    }
  }

  if (apiKey.length < 20) {
    console.warn(
      `Warning: ${provider} API key seems too short (${apiKey.length} chars) - this may be incorrect`
    );
  }
}

export function getModel(config: { provider: string; model: string; apiKey?: string }): LanguageModel {
  try {
    const provider = config.provider as LLMProvider;
    const apiKey = config.apiKey || getApiKey(provider);
    
    switch (provider) {
      case "openai": return createOpenAI({ apiKey })(config.model);
      case "anthropic": return createAnthropic({ apiKey })(config.model);
      case "google": return createGoogleGenerativeAI({ apiKey })(config.model);
      default: throw new Error(`Unsupported provider: ${config.provider}`);
    }
  } catch (err: any) {
    throw err;
  }
}

export function isLLMAvailable(provider: LLMProvider): boolean {
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

Respond with:
{
  "results": [
    {
      "ruleId": string,
      "status": "followed" | "violated" | "not_applicable",
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
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

export function truncateForPrompt(content: string, maxChars = 50000): string {
  if (content.length <= maxChars) return content;

  const marker = `\n\n[... ${content.length - maxChars} characters truncated ...]\n\n`;
  const markerLen = marker.length;
  const available = maxChars - markerLen;

  if (available <= 0) {
    return content.slice(0, maxChars);
  }

  const keepChars = Math.floor(available / 2);
  const beginning = content.slice(0, keepChars);
  const ending = content.slice(-keepChars);

  return `${beginning}${marker}${ending}`;
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
      
      console.warn(`[LLM] ${operationName} failed (attempt ${attempt}): ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Explicitly type monitoredGenerateObject to return GenerateObjectResult<T>
async function monitoredGenerateObject<T>(
  options: any,
  config: Config,
  context: string
): Promise<GenerateObjectResult<T>> {
  const budgetCheck = await checkBudget(config);
  if (!budgetCheck.allowed) {
    throw new Error(`LLM budget exceeded: ${budgetCheck.reason}`);
  }

  const result = await generateObject({
    ...options,
    // Ensure schema is passed through if present in options, typically it is
  }) as GenerateObjectResult<T>;

  if (result.usage) {
    const modelName = config.llm?.model ?? config.model;
    const provider = (config.llm?.provider ?? config.provider);

    await recordCost(config, {
      provider,
      model: modelName,
      tokensIn: result.usage.promptTokens,
      tokensOut: result.usage.completionTokens,
      context
    });
  }
  
  return result;
}

/**
 * Handle malformed or invalid LLM responses with progressive retry strategies.
 * Attempts to recover valid data from responses that don't match the expected schema.
 *
 * Recovery strategies:
 * 1. First retry: Add explicit JSON format instructions
 * 2. Second retry: Include example output structure
 * 3. Final retry: Attempt partial data extraction
 * 4. Fail gracefully with detailed diagnostics
 */
export async function handleMalformedLLMResponse<T>(
  response: unknown,
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config
): Promise<T> {
  const MAX_ATTEMPTS = 3;
  const errors: Array<{ attempt: number; error: string; response?: unknown }> = [];

  // First, try to validate the original response
  const initialParse = schema.safeParse(response);
  if (initialParse.success) {
    return initialParse.data;
  }

  // Log the malformed response for debugging
  console.warn(`[LLM] Malformed response received. Validation error: ${initialParse.error.message}`);
  if (process.env.DEBUG_LLM) {
    console.debug("[LLM] Malformed response:", JSON.stringify(response, null, 2).slice(0, 500));
  }

  errors.push({
    attempt: 0,
    error: initialParse.error.message,
    response: typeof response === "object" ? response : undefined
  });

  // Try to extract partial valid data
  const partialData = tryExtractPartialData(response, schema);
  if (partialData) {
    console.warn("[LLM] Recovered partial valid data from malformed response");
    return partialData;
  }

  // Prepare retry strategies
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let enhancedPrompt = prompt;
      let temperature = 0.3;

      switch (attempt) {
        case 1:
          // First retry: Add explicit JSON format instructions
          enhancedPrompt = `[FORMATTING ERROR IN PREVIOUS RESPONSE - STRICT JSON REQUIRED]

${prompt}

CRITICAL FORMATTING REQUIREMENTS:
- Your response MUST be valid JSON
- All required fields MUST be present
- Do NOT include markdown code fences
- Do NOT include any text before or after the JSON`;
          temperature = 0.2;
          break;

        case 2:
          // Second retry: Include example output structure
          const exampleStructure = generateSchemaExample(schema);
          enhancedPrompt = `[SECOND RETRY - FOLLOW EXACT STRUCTURE]

${prompt}

EXPECTED OUTPUT STRUCTURE (follow this exactly):
${exampleStructure}

Ensure your response matches this structure precisely.`;
          temperature = 0.35;
          break;

        case 3:
          // Final retry: Simplify request
          enhancedPrompt = `[FINAL ATTEMPT - SIMPLIFIED REQUEST]

${prompt}

SIMPLIFIED INSTRUCTIONS:
1. Output ONLY valid JSON
2. Include all required fields
3. Use null for optional fields you're unsure about
4. No explanatory text, only JSON`;
          temperature = 0.4;
          break;
      }

      const model = getModel(llmConfig);
      const result = await monitoredGenerateObject<T>({
        model,
        schema,
        prompt: enhancedPrompt,
        temperature
      }, config, `handleMalformedLLMResponse-retry${attempt}`);

      console.warn(`[LLM] Recovery successful on attempt ${attempt}`);
      return result.object;

    } catch (err: any) {
      errors.push({
        attempt,
        error: err.message || String(err)
      });
      console.warn(`[LLM] Recovery attempt ${attempt} failed: ${err.message}`);
    }
  }

  // All retries exhausted - throw detailed error
  const errorSummary = errors
    .map(e => `  Attempt ${e.attempt}: ${e.error}`)
    .join("\n");

  const schemaDescription = describeSchema(schema);

  throw new Error(
    `LLM response recovery failed after ${MAX_ATTEMPTS} attempts.\n\n` +
    `Errors:\n${errorSummary}\n\n` +
    `Expected schema:\n${schemaDescription}\n\n` +
    `Original prompt (truncated): ${prompt.slice(0, 200)}...`
  );
}

/**
 * Attempt to extract partial valid data from a malformed response.
 * Returns undefined if no partial data can be recovered.
 */
function tryExtractPartialData<T>(response: unknown, schema: z.ZodSchema<T>): T | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  try {
    // For objects, try to coerce missing optional fields with defaults
    const partial = schema.safeParse(response);
    if (partial.success) {
      return partial.data;
    }

    // Try parsing with passthrough to see what we got
    const looseSchema = z.object({}).passthrough();
    const looseParse = looseSchema.safeParse(response);

    if (looseParse.success && Object.keys(looseParse.data).length > 0) {
      // Attempt strict parse again - Zod may coerce some values
      const retryParse = schema.safeParse(looseParse.data);
      if (retryParse.success) {
        return retryParse.data;
      }
    }
  } catch {
    // Extraction failed
  }

  return undefined;
}

/**
 * Generate a human-readable example of what the schema expects.
 */
function generateSchemaExample<T>(schema: z.ZodSchema<T>): string {
  try {
    // Use Zod's internal shape if available
    const def = (schema as any)._def;
    if (def?.typeName === "ZodObject" && def.shape) {
      const example: Record<string, any> = {};
      for (const [key, fieldSchema] of Object.entries(def.shape())) {
        example[key] = getFieldExample(fieldSchema as z.ZodSchema);
      }
      return JSON.stringify(example, null, 2);
    }
  } catch {
    // Fall back to generic example
  }

  return '{ /* JSON object matching required schema */ }';
}

/**
 * Get an example value for a Zod field type.
 */
function getFieldExample(schema: z.ZodSchema): any {
  const def = (schema as any)._def;
  const typeName = def?.typeName;

  switch (typeName) {
    case "ZodString":
      return "string_value";
    case "ZodNumber":
      return 0;
    case "ZodBoolean":
      return false;
    case "ZodArray":
      return [];
    case "ZodObject":
      return {};
    case "ZodEnum":
      return def.values?.[0] ?? "enum_value";
    case "ZodOptional":
    case "ZodNullable":
      return null;
    case "ZodDefault":
      return def.defaultValue?.();
    default:
      return null;
  }
}

/**
 * Describe a schema in human-readable form for error messages.
 */
function describeSchema<T>(schema: z.ZodSchema<T>): string {
  try {
    const def = (schema as any)._def;
    if (def?.typeName === "ZodObject" && def.shape) {
      const fields = Object.entries(def.shape())
        .map(([key, fieldSchema]) => {
          const fieldDef = (fieldSchema as any)._def;
          const isOptional = fieldDef?.typeName === "ZodOptional";
          const type = fieldDef?.typeName?.replace("Zod", "").toLowerCase() ?? "unknown";
          return `  ${key}: ${type}${isOptional ? " (optional)" : " (required)"}`;
        })
        .join("\n");
      return `Object with fields:\n${fields}`;
    }
  } catch {
    // Fall back to generic description
  }

  return "Schema validation failed - check field types and required fields";
}

export async function generateObjectSafe<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config,
  maxAttempts: number = 2
): Promise<T> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };
  const model = getModel(llmConfig);
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
      }, config, "generateObjectSafe");

      // result.object is typed as T now
      return result.object;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts) {
        console.warn(`[LLM] generateObjectSafe attempt ${attempt} failed: ${err.message}. Retrying...`);
      }
    }
  }

  throw lastError ?? new Error("generateObjectSafe failed after all attempts");
}

// --- Operations ---

// Optional reflector stubs for offline/tests (set env CM_REFLECTOR_STUBS to JSON array of per-iteration delta arrays)
let REFLECTOR_STUBS: any[][] | null = null;
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
        REFLECTOR_STUBS = parsed as any[][];
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
  config: Config
): Promise<T> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  const model = getModel(llmConfig);
  
  const truncatedContent = truncateForPrompt(sessionContent, 50000);

  const prompt = fillPrompt(PROMPTS.diary, {
    sessionPath: metadata.sessionPath,
    agent: metadata.agent,
    workspace: metadata.workspace || "unknown",
    content: truncatedContent
  });

  return llmWithRetry(async () => {
    const result = await monitoredGenerateObject<T> ({
      model,
      schema,
      prompt,
      temperature: 0.3,
    }, config, "extractDiary");
    return result.object;
  }, "extractDiary");
}

export async function runReflector<T>(
  schema: z.ZodSchema<T>,
  diary: DiaryEntry,
  existingBullets: string,
  cassHistory: string,
  iteration: number,
  config: Config
): Promise<T> {
  const stub = nextReflectorStub<T>();
  if (stub) {
    return stub;
  }

  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  const model = getModel(llmConfig);

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

  const safeExistingBullets = truncateForPrompt(existingBullets, 20000);
  const safeCassHistory = truncateForPrompt(cassHistory, 20000);

  const prompt = fillPrompt(PROMPTS.reflector, {
    existingBullets: safeExistingBullets,
    diary: diaryText,
    cassHistory: safeCassHistory,
    iterationNote,
  });

  return llmWithRetry(async () => {
    const result = await monitoredGenerateObject<T> ({
      model,
      schema,
      prompt,
      temperature: 0.5,
    }, config, "runReflector");
    return result.object;
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
  config: Config
): Promise<ValidatorResult> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  const model = getModel(llmConfig);

  const safeEvidence = truncateForPrompt(formattedEvidence, 30000);

  const prompt = fillPrompt(PROMPTS.validator, {
    proposedRule,
    evidence: safeEvidence
  });

  return llmWithRetry(async () => {
    const result = await monitoredGenerateObject<ValidatorOutput> ({
      model,
      schema: ValidatorOutputSchema,
      prompt,
      temperature: 0.2,
    }, config, "runValidator");

    const object = result.object;

    const mappedEvidence = [
      ...object.evidence.supporting.map((s: string) => ({ sessionPath: "unknown", snippet: s, supports: true })),
      ...object.evidence.contradicting.map((s: string) => ({ sessionPath: "unknown", snippet: s, supports: false }))
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
  config: Config
): Promise<string> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  const model = getModel(llmConfig);

  const prompt = fillPrompt(PROMPTS.context, {
    task: truncateForPrompt(task, 5000),
    bullets: truncateForPrompt(bullets, 20000),
    history: truncateForPrompt(history, 20000),
    deprecatedPatterns: truncateForPrompt(deprecatedPatterns, 5000)
  });

  return llmWithRetry(async () => {
    const result = await monitoredGenerateObject<{ briefing: string }> ({
      model,
      schema: z.object({ briefing: z.string() }),
      prompt,
      temperature: 0.3,
    }, config, "generateContext");
    return result.object.briefing;
  }, "generateContext");
}

export async function generateSearchQueries(
  task: string,
  config: Config
): Promise<string[]> {
  const llmConfig: LLMConfig = {
    provider: (config.llm?.provider ?? config.provider) as LLMProvider,
    model: config.llm?.model ?? config.model,
    apiKey: config.apiKey
  };

  const model = getModel(llmConfig);

  const prompt = `Given this task: ${truncateForPrompt(task, 5000)}

Generate 3-5 diverse search queries to find relevant information:
- Similar problems encountered before
- Related frameworks or tools
- Relevant patterns or best practices
- Error messages or debugging approaches

Make queries specific enough to be useful but broad enough to match variations.`;

  return llmWithRetry(async () => {
    const result = await monitoredGenerateObject<{ queries: string[] }> ({
      model,
      schema: z.object({ queries: z.array(z.string()).max(5) }),
      prompt,
      temperature: 0.5,
    }, config, "generateSearchQueries");
    return result.object.queries;
  }, "generateSearchQueries");
}

// --- Multi-Provider Fallback ---

const FALLBACK_ORDER: LLMProvider[] = ["anthropic", "openai", "google"];

const FALLBACK_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
};

export async function llmWithFallback<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config
): Promise<T> {
  const primaryProvider = (config.llm?.provider ?? config.provider) as LLMProvider;
  const primaryModel = config.llm?.model ?? config.model;

  const availableProviders = getAvailableProviders();
  const providerOrder: Array<{ provider: LLMProvider; model: string }> = [];

  if (availableProviders.includes(primaryProvider)) {
    providerOrder.push({ provider: primaryProvider, model: primaryModel });
  }

  for (const fallback of FALLBACK_ORDER) {
    if (fallback !== primaryProvider && availableProviders.includes(fallback)) {
      providerOrder.push({ provider: fallback, model: FALLBACK_MODELS[fallback] });
    }
  }

  if (providerOrder.length === 0) {
    throw new Error(
      "No LLM providers available. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY"
    );
  }

  const errors: Array<{ provider: string; error: string }> = [];

  for (let i = 0; i < providerOrder.length; i++) {
    const { provider, model } = providerOrder[i];
    const isLastProvider = i === providerOrder.length - 1;

    try {
      const llmModel = getModel({ provider, model });

      const result = await monitoredGenerateObject<T> ({
        model: llmModel,
        schema,
        prompt,
        temperature: 0.3,
      }, config, "llmWithFallback");

      return result.object;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      errors.push({ provider, error: errorMsg });

      if (isLastProvider) {
        console.warn(`[LLM] ${provider} failed: ${errorMsg}. No more providers to try.`);
      } else {
        console.warn(`[LLM] ${provider} failed: ${errorMsg}. Trying next provider...`);
      }
    }
  }

  const errorSummary = errors
    .map(e => `${e.provider}: ${e.error}`)
    .join("\n  ");

  throw new Error(`All LLM providers failed:\n  ${errorSummary}`);
}