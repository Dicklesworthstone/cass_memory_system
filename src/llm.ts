// src/llm.ts
// LLM Provider Abstraction - Using Vercel AI SDK
// Supports OpenAI, Anthropic, Google, and Ollama providers with a unified interface

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config, DiaryEntry, LLMProvider, ReflectorCall1Output, ReflectorCall2Output, DiaryFromNoteOutput, DigestSynthesisOutput } from "./types.js";
import { ReflectorCall1OutputSchema, ReflectorCall2OutputSchema, DiaryFromNoteOutputSchema, DigestSynthesisOutputSchema } from "./types.js";
import { checkBudget, recordCost } from "./cost.js";
import { truncateForContext, warn } from "./utils.js";
import path from "node:path";

// Re-export LLMProvider from types.ts (single source of truth)
export type { LLMProvider } from "./types.js";

/**
 * Create a config override for a specific pipeline step.
 * If the step has a model override configured, returns config with that model.
 * Empty string means "use default config.model".
 */
export type PipelineStep = "sessionNoteCreate" | "sessionNoteExtend" | "diaryFromNote" | "reflectorCall1" | "reflectorCall2" | "knowledgeGen" | "digestSynthesis";

export function configForStep(config: Config, step: PipelineStep): Config {
  const override = config.pipelineModels?.[step];
  if (!override) return config;
  return { ...config, model: override };
}

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

  // Ollama doesn't use an API key — return empty string
  if (normalized === "ollama") {
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

  // Ollama doesn't use an API key — nothing to validate
  if (normalized === "ollama") return;

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

export function isLLMAvailable(provider: LLMProvider): boolean {
  // Ollama is "available" when either OLLAMA_BASE_URL or OLLAMA_HOST is set.
  // We cannot auto-detect a running local server because this function is
  // synchronous and a network probe would block.
  if (provider === "ollama") {
    return !!process.env.OLLAMA_BASE_URL || !!process.env.OLLAMA_HOST;
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

  sessionNoteCreate: `You are a session note generator for a coding knowledge management system. Your job is to compress a raw coding session transcript into a concise, information-dense session note.

Write for someone who needs to pick up this work tomorrow. Include the specific details they'd need — paths, configs, error messages, ticket numbers — not the process of how you found them.

<transcript>
{transcript}
</transcript>

INCLUSION CRITERIA (what survives compression):
- Specific facts: file paths, config values, API endpoints, error messages, version numbers
- Decisions and their reasoning: why option A was chosen over B
- Discovered behaviors: "X actually works like Y, not like the docs say"
- Commands that worked (or didn't) and why
- People mentioned and their roles/opinions
- Links, ticket numbers, PR numbers, channel names — preserve ALL external URLs (API docs, library references, etc.) as clickable markdown links
- Unresolved questions and open threads
- Dead ends that taught something ("initially suspected retry logic, was actually HMAC key mismatch")

EXCLUSION CRITERIA (what gets dropped):
- Verbose back-and-forth debugging that led nowhere
- Repeated attempts at the same fix
- Boilerplate code generation that worked first try
- Standard tool invocations with expected results
- Meta-conversation about approach
- The code itself (capture WHAT was built and WHY, not the implementation listing)

FORMAT:
- Use ## date — time headers (e.g. ## March 20, 2026 — 09:15)
- Use ### topic headers (e.g. ### Initial investigation)
- When the session touches multiple topics, insert topic transition headers: ### [Topic shift: Topic Name]
- Be SPECIFIC and ACTIONABLE. Avoid generic statements like "wrote code" or "fixed bug". Include specific file names, function names, error messages.

Respond with JSON:
{
  "abstract": "1-2 sentence summary of the full session",
  "topics_touched": ["topic-slug-1", "topic-slug-2"],
  "content": "The markdown body of the session note"
}`,

  sessionNoteAppend: `You are extending an existing session note with new transcript content. The session has continued and there is new content to add.

<existing_note>
{existingNote}
</existing_note>

<existing_abstract>
{existingAbstract}
</existing_abstract>

<new_transcript>
{newTranscript}
</new_transcript>

RULES:
- Append ONLY what is genuinely new. Do NOT repeat what is already in the existing note.
- Reference earlier findings where relevant ("as identified earlier, the HMAC key was the root cause").
- Start with a brief context resumption sentence ("Continuing investigation into billing webhook failures.").
- If the new content is from a different day than the last entry in the existing note, add a new ## date header.
- If the session shifts to a new topic, use ### [Topic shift: Topic Name].
- Detect if new content contradicts something in the existing note. If the transcript itself contains an explicit self-correction ("actually, I was wrong earlier"), capture the correction. Otherwise, just add the new information as new sections — the Validator will catch contradictions later.
- Update the abstract to cover the FULL note (existing + new content).
- Update topics_touched to include any new topics.

INCLUSION/EXCLUSION CRITERIA: Same as initial note generation — include specific facts, decisions, outcomes, references. Omit debugging noise, boilerplate, meta-conversation.

Respond with JSON:
{
  "abstract": "Updated 1-2 sentence summary covering the FULL note",
  "topics_touched": ["all-topic-slugs", "including-new-ones"],
  "new_content": "ONLY the new section(s) to append"
}`,

  diaryFromNote: `You are generating a structured diary entry from a session note. The diary entry is an internal scaffold used by the Reflector to identify patterns and generate knowledge. It should be a compressed structural summary, NOT a rewrite of the note.

SESSION NOTE (frontmatter):
- Session: {sessionId}
- Topics: {topicsTouched}
- Abstract: {abstract}

<session_note_body>
{noteContent}
</session_note_body>

INSTRUCTIONS:
Map the session note into these fields. Be SPECIFIC — include file names, error messages, config paths. Do not add information that isn't in the note.

- status: "success" if the session achieved its goals, "failure" if blocked/unresolved, "mixed" if partial
- accomplishments: Concrete completed tasks (1 bullet each, max 8)
- decisions: Design choices with brief rationale (max 5)
- challenges: Problems encountered, dead ends, blockers (max 5)
- preferences: User workflow preferences or style choices revealed
- keyLearnings: Insights reusable in future sessions (max 5)
- tags: 3-8 keyword tags for search discovery`,

  reflectorCall1: `You are extracting reusable rules and topic classifications from a coding session.

<diary_entry>
Status: {status}
Accomplishments:
{accomplishments}
Decisions:
{decisions}
Challenges:
{challenges}
Key Learnings:
{keyLearnings}
</diary_entry>

<existing_topics>
{existingTopics}
</existing_topics>

<existing_playbook>
{existingBullets}
</existing_playbook>

INSTRUCTIONS — BULLETS:
Extract playbook bullet proposals from this session. Each bullet is a terse, reusable rule.

Quality criteria:
- SPECIFIC: Bad: "Write tests". Good: "For React hooks, test effects separately with renderHook"
- ACTIONABLE: Include concrete file patterns, command flags, config paths
- REUSABLE: Would help a DIFFERENT agent on a similar problem in the future
- NOT REDUNDANT: Check existing_playbook — don't propose rules already covered

Bullet fields:
- content: The rule text (1-2 sentences max)
- scope: "global" (any project), "workspace" (this repo), "language", "framework", or "task"
- category: Short category label (e.g. "testing", "deployment", "error-handling")
- type: "rule" (do this) or "anti-pattern" (don't do this)
- kind: "project_convention", "stack_pattern", "workflow_rule", or "anti_pattern"
- reasoning: Why this bullet is worth extracting (1 sentence)

Maximum 10 bullets. Prefer fewer, higher-quality bullets over many weak ones.

INSTRUCTIONS — FEEDBACK ON EXISTING BULLETS:
Review the existing_playbook. If this session provides evidence that an existing bullet is correct and useful, mark it "helpful". If the session shows an existing bullet is wrong, misleading, or caused problems, mark it "harmful".

Only emit feedback when the session provides CLEAR evidence. Don't mark bullets helpful just because they're tangentially related. Don't mark bullets harmful based on a single edge case.

Feedback fields:
- bulletId: The ID of the existing bullet (e.g. "b-1a2b3c4d")
- type: "helpful" or "harmful"
- reasoning: One sentence explaining what evidence this session provides

Maximum 5 feedback items per session.

INSTRUCTIONS — TOPIC SUGGESTIONS:
If the session covered a subject area NOT covered by any existing topic, suggest a new topic. The user will review and approve/dismiss suggestions — so err on the side of suggesting rather than dropping knowledge silently.

Rules:
- Prefer routing to existing topics when they fit, especially user-defined ones
- If no existing topic covers the session's main subject, ALWAYS suggest one
- Topics should be broad enough to accumulate knowledge over time (e.g. "transit-data-processing" not "fix-gtfs-parser-bug")
- Include a clear description so the system knows what to route there in the future

Topic fields:
- slug: kebab-case identifier (e.g. "billing-webhooks")
- name: Human-readable name (e.g. "Billing Webhooks")
- description: 1-sentence description of what this topic covers
- reasoning: Why this should be a standalone topic

Maximum 3 topic suggestions per session.`,

  reflectorCall2: `You are revising knowledge pages with new information from a coding session.

Each knowledge page is a cohesive markdown document about a topic. Your job is to REVISE existing pages by incorporating new information from the session — producing the full updated page content.

<diary_entry>
{diaryText}
</diary_entry>

<session_note>
{sessionNote}
</session_note>

<existing_knowledge_pages>
{knowledgePages}
</existing_knowledge_pages>

<available_topics>
{availableTopics}
</available_topics>

PAGE UPDATES:
For each topic page that needs updating, provide the FULL revised markdown content for that sub-page. The content you return will REPLACE the existing page content entirely.

Rules:
- Only update pages for topics that ALREADY EXIST in <available_topics>
- PRESERVE all existing content that's still accurate — don't drop information
- INTEGRATE new facts from the session into the existing narrative naturally
- If new information CONTRADICTS existing content and you're confident the new info is correct (e.g., "actually the config is at X, not Y"), update the text
- If you're NOT SURE which version is correct, KEEP BOTH and add an entry to the contradictions array describing the conflict
- Be conservative: when in doubt, keep existing content and flag the contradiction
- Include external URLs as markdown links where referenced
- Skip ephemeral facts (local env state, one-off debug output)
- It's fine to produce zero page_updates if no existing topic fits the session

For each update, provide:
- topic_slug: Which topic (must exist in available_topics)
- sub_page: Which sub-page ("_index" for the main page, or a specific sub-page slug)
- revised_content: The FULL revised markdown content for this sub-page
- contradictions: Array of conflicts you couldn't resolve (each with description, existing_claim, new_claim)

NOTE: The digest_content field is optional. Leave it empty — daily digests are generated separately.`,

  digestSynthesis: `You are writing a daily digest summarizing a developer's coding sessions.

<sessions>
{sessionSummaries}
</sessions>

<pipeline_results>
{pipelineResults}
</pipeline_results>

Write a concise, well-structured daily digest. Group related work by project. Highlight:
- Key accomplishments and outcomes
- Important decisions made and their rationale
- Problems encountered and how they were resolved
- Open questions or unfinished work carrying forward

Rules:
- Skip sessions that failed to capture content or have no accomplishments
- Deduplicate — if the same work appears in multiple sessions, mention it once
- Use project names as section headers when sessions span multiple projects
- Include specific details (file names, error messages, tool names) — not vague summaries
- End with a brief "Open items" list if any sessions have unresolved questions
- Keep the total length to 3-8 paragraphs depending on how much happened

Also return a topics_touched array with all unique topic slugs from the sessions.`,
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
  totalTimeoutMs: 300000, // 5 min total — Call 2 generates full page revisions
  perOperationTimeoutMs: 120000, // 2 min per attempt — Sonnet needs time for long prose output
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

// --- Session Note Generation ---

import {
  SessionNoteCreateOutputSchema,
  SessionNoteAppendOutputSchema,
  type SessionNoteCreateOutput,
  type SessionNoteAppendOutput,
} from "./session-notes.js";

export async function generateSessionNoteContent(
  transcript: string,
  transcriptPath: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<SessionNoteCreateOutput> {
  const safeTranscript = truncateForContext(transcript, { maxChars: 80000 });

  const prompt = fillPrompt(PROMPTS.sessionNoteCreate, {
    transcript: safeTranscript,
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(SessionNoteCreateOutputSchema, prompt, configForStep(config, "sessionNoteCreate"), 3, io);
  }, "generateSessionNoteContent");
}

export async function extendSessionNoteContent(
  existingNoteBody: string,
  newTranscript: string,
  existingAbstract: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<SessionNoteAppendOutput> {
  const safeExisting = truncateForContext(existingNoteBody, { maxChars: 30000 });
  const safeNewTranscript = truncateForContext(newTranscript, { maxChars: 50000 });

  const prompt = fillPrompt(PROMPTS.sessionNoteAppend, {
    existingNote: safeExisting,
    existingAbstract,
    newTranscript: safeNewTranscript,
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(SessionNoteAppendOutputSchema, prompt, configForStep(config, "sessionNoteExtend"), 3, io);
  }, "extendSessionNoteContent");
}

// --- Phase 3: Diary From Note ---

export async function extractDiaryFromNote(
  sessionNote: { id: string; abstract: string; topicsTouched: string[]; body: string },
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<DiaryFromNoteOutput> {
  const safeContent = truncateForContext(sessionNote.body, { maxChars: 30000 });

  const prompt = fillPrompt(PROMPTS.diaryFromNote, {
    sessionId: sessionNote.id,
    topicsTouched: sessionNote.topicsTouched.join(", ") || "none",
    abstract: sessionNote.abstract,
    noteContent: safeContent,
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(DiaryFromNoteOutputSchema, prompt, configForStep(config, "diaryFromNote"), 3, io);
  }, "extractDiaryFromNote");
}

// --- Phase 3: Reflector Call 1 (Structural/Extractive) ---

export async function runReflectorCall1(
  diary: DiaryEntry,
  existingTopics: string,
  existingBullets: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<ReflectorCall1Output> {
  // Check for stubs in E2E test mode
  if (io === DEFAULT_LLM_IO) {
    const stub = nextReflectorStub<ReflectorCall1Output>();
    if (stub) return stub;
  }

  const prompt = fillPrompt(PROMPTS.reflectorCall1, {
    status: diary.status,
    accomplishments: diary.accomplishments.length > 0
      ? diary.accomplishments.map(a => `- ${a}`).join("\n")
      : "- (none recorded)",
    decisions: diary.decisions.length > 0
      ? diary.decisions.map(d => `- ${d}`).join("\n")
      : "- (none recorded)",
    challenges: diary.challenges.length > 0
      ? diary.challenges.map(c => `- ${c}`).join("\n")
      : "- (none recorded)",
    keyLearnings: diary.keyLearnings.length > 0
      ? diary.keyLearnings.map(k => `- ${k}`).join("\n")
      : "- (none recorded)",
    existingTopics: truncateForContext(existingTopics, { maxChars: 10000 }),
    existingBullets: truncateForContext(existingBullets, { maxChars: 20000 }),
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(ReflectorCall1OutputSchema, prompt, configForStep(config, "reflectorCall1"), 3, io);
  }, "runReflectorCall1");
}

// --- Phase 3: Reflector Call 2 (Generative/Narrative) ---

export async function runReflectorCall2(
  diary: DiaryEntry,
  sessionNote: string,
  knowledgePages: string,
  availableTopics: string,
  sessionId: string,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<ReflectorCall2Output> {
  const diaryText = `Status: ${diary.status}
Accomplishments: ${diary.accomplishments.join(", ") || "(none)"}
Decisions: ${diary.decisions.join(", ") || "(none)"}
Challenges: ${diary.challenges.join(", ") || "(none)"}
Key Learnings: ${diary.keyLearnings.join(", ") || "(none)"}
Tags: ${diary.tags.join(", ") || "(none)"}`;

  const prompt = fillPrompt(PROMPTS.reflectorCall2, {
    diaryText,
    sessionNote: truncateForContext(sessionNote, { maxChars: 30000 }),
    knowledgePages: truncateForContext(knowledgePages, { maxChars: 30000 }),
    availableTopics,
    sessionId,
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(ReflectorCall2OutputSchema, prompt, configForStep(config, "reflectorCall2"), 3, io);
  }, "runReflectorCall2");
}

// --- Daily Digest Synthesis (Haiku) ---

export interface DigestSessionInput {
  sessionId: string;
  title: string;
  abstract: string;
  project: string;
  topics: string[];
  decisions: string[];
  challenges: string[];
  openQuestions: string[];
}

export interface DigestPipelineResults {
  bulletsAdded: string[]; // full bullet text
  bulletsHelpful: string[]; // bullet IDs marked helpful
  bulletsHarmful: string[]; // bullet IDs marked harmful
  knowledgePagesUpdated: string[]; // topic slugs
  errors: string[];
}

/**
 * Extract a project name from a session's source_session path.
 * e.g., "~/.claude/projects/-Users-dev-Coding-my-project/uuid.jsonl" → "my-project"
 */
export function projectFromSourcePath(sourcePath: string): string {
  if (!sourcePath) return "unknown";
  try {
    const dirName = path.basename(path.dirname(sourcePath));
    const segments = dirName.split("-").filter(Boolean);
    const codingIdx = segments.findIndex(s => s.toLowerCase() === "coding");
    if (codingIdx >= 0 && codingIdx < segments.length - 1) {
      return segments.slice(codingIdx + 1).join("-");
    }
    return segments.slice(-2).join("-");
  } catch {
    return "unknown";
  }
}

export async function generateDailyDigest(
  sessions: DigestSessionInput[],
  pipelineResults: DigestPipelineResults,
  config: Config,
  io: LLMIO = DEFAULT_LLM_IO
): Promise<DigestSynthesisOutput> {
  if (sessions.length === 0) {
    return { summary: "No sessions processed today.", topics_touched: [] };
  }

  const sessionSummaries = sessions.map(s => {
    const lines = [`[${s.project}] "${s.title}" — ${s.abstract}`];
    lines.push(`  Topics: ${s.topics.join(", ") || "(none)"}`);
    if (s.decisions.length > 0) {
      lines.push(`  Decisions: ${s.decisions.slice(0, 3).join("; ")}`);
    }
    if (s.challenges.length > 0) {
      lines.push(`  Challenges: ${s.challenges.slice(0, 3).join("; ")}`);
    }
    if (s.openQuestions.length > 0) {
      lines.push(`  Open: ${s.openQuestions.slice(0, 2).join("; ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  const pipelineLines: string[] = [];
  if (pipelineResults.bulletsAdded.length > 0) {
    pipelineLines.push(`Playbook bullets added (${pipelineResults.bulletsAdded.length}):`);
    for (const b of pipelineResults.bulletsAdded.slice(0, 10)) {
      pipelineLines.push(`  - ${b}`);
    }
  }
  if (pipelineResults.bulletsHelpful.length > 0) {
    pipelineLines.push(`Bullets reinforced: ${pipelineResults.bulletsHelpful.join(", ")}`);
  }
  if (pipelineResults.bulletsHarmful.length > 0) {
    pipelineLines.push(`Bullets flagged harmful: ${pipelineResults.bulletsHarmful.join(", ")}`);
  }
  if (pipelineResults.knowledgePagesUpdated.length > 0) {
    pipelineLines.push(`Knowledge pages updated: ${pipelineResults.knowledgePagesUpdated.join(", ")}`);
  }
  if (pipelineResults.errors.length > 0) {
    pipelineLines.push(`Errors: ${pipelineResults.errors.slice(0, 3).join("; ")}`);
  }

  const prompt = fillPrompt(PROMPTS.digestSynthesis, {
    sessionSummaries,
    pipelineResults: pipelineLines.join("\n") || "No pipeline changes.",
  });

  return llmWithRetry(async () => {
    return generateObjectSafe(DigestSynthesisOutputSchema, prompt, configForStep(config, "digestSynthesis"), 3, io);
  }, "generateDailyDigest");
}

// --- Multi-Provider Fallback ---

const FALLBACK_ORDER: LLMProvider[] = ["anthropic", "openai", "google", "ollama"];

const FALLBACK_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.2:3b",
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

  // Ollama is always considered available when explicitly configured as the primary provider
  // since it uses a base URL (defaults to localhost:11434) rather than an API key.
  const primaryIsOllama = primaryProvider === "ollama";
  if (availableProviders.includes(primaryProvider) || apiKeyOverride !== undefined || primaryIsOllama) {
    providerOrder.push({ provider: primaryProvider, model: primaryModel, apiKey: apiKeyOverride });
  }

  for (const fallback of FALLBACK_ORDER) {
    if (fallback !== primaryProvider && availableProviders.includes(fallback)) {
      providerOrder.push({ provider: fallback, model: FALLBACK_MODELS[fallback] });
    }
  }

  if (providerOrder.length === 0) {
    throw new Error(
      "No LLM providers available. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or OLLAMA_BASE_URL"
    );
  }

  const errors: Array<{ provider: string; error: string }> = [];

  for (let i = 0; i < providerOrder.length; i++) {
    const { provider, model, apiKey } = providerOrder[i];
    const isLastProvider = i === providerOrder.length - 1;

    try {
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
