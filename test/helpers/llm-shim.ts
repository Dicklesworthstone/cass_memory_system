/**
 * LLM Shim - Test helper for mocking LLM responses offline
 *
 * This shim allows tests to run without requiring actual LLM API calls.
 * It provides configurable responses for all LLM functions used in cass-memory.
 *
 * Usage:
 *   import { withLlmShim, LlmShimConfig } from "./helpers/llm-shim.js";
 *
 *   await withLlmShim({
 *     extractDiary: { status: "success", accomplishments: ["built feature"] },
 *     reflector: { deltas: [{ type: "add", bullet: { content: "test" } }] },
 *   }, async () => {
 *     // Your test code here - LLM functions will return shim data
 *   });
 */

import { mock } from "bun:test";
import type { PlaybookDelta, DiaryEntry } from "../../src/types.js";

// --- Types ---

/** Configuration for diary extraction responses */
export interface DiaryExtractShimResponse {
  status?: "success" | "failure" | "mixed";
  accomplishments?: string[];
  decisions?: string[];
  challenges?: string[];
  preferences?: string[];
  keyLearnings?: string[];
  tags?: string[];
  searchAnchors?: string[];
}

/** Configuration for reflector responses */
export interface ReflectorShimResponse {
  deltas?: Partial<PlaybookDelta>[];
  reasoning?: string;
}

/** Configuration for validator responses */
export interface ValidatorShimResponse {
  verdict?: "ACCEPT" | "REJECT" | "REFINE" | "ACCEPT_WITH_CAUTION";
  confidence?: number;
  reasoning?: string;
  refinedContent?: string;
  supportingEvidence?: string[];
}

/** Main shim configuration */
export interface LlmShimConfig {
  /** Response for extractDiary calls */
  extractDiary?: DiaryExtractShimResponse | ((content: string) => DiaryExtractShimResponse);

  /** Response for runReflector calls */
  reflector?: ReflectorShimResponse | ((diary: any, playbook: any) => ReflectorShimResponse);

  /** Response for runValidator calls */
  validator?: ValidatorShimResponse | ((delta: any, evidence: any) => ValidatorShimResponse);

  /** Simulate errors */
  errors?: {
    extractDiary?: Error;
    reflector?: Error;
    validator?: Error;
    any?: Error; // Throw this error for any LLM call
  };

  /** Delay to simulate API latency (ms) */
  delay?: number;

  /** Track all calls made */
  trackCalls?: boolean;
}

/** Call tracking for test assertions */
export interface LlmCallLog {
  extractDiary: Array<{ content: string; metadata: any; timestamp: Date }>;
  reflector: Array<{ diary: any; playbook: any; timestamp: Date }>;
  validator: Array<{ delta: any; evidence: any; timestamp: Date }>;
}

// --- Default Responses ---

export const DEFAULT_DIARY_RESPONSE: DiaryExtractShimResponse = {
  status: "success",
  accomplishments: ["Completed the requested task"],
  decisions: ["Used standard approach"],
  challenges: [],
  preferences: [],
  keyLearnings: ["Task completed successfully"],
  tags: ["general"],
  searchAnchors: ["task completion"]
};

export const DEFAULT_REFLECTOR_RESPONSE: ReflectorShimResponse = {
  deltas: [],
  reasoning: "No significant patterns detected in this session"
};

export const DEFAULT_VALIDATOR_RESPONSE: ValidatorShimResponse = {
  verdict: "ACCEPT",
  confidence: 0.8,
  reasoning: "Rule appears valid based on available evidence",
  supportingEvidence: []
};

// --- Shim Implementation ---

let currentConfig: LlmShimConfig | null = null;
let callLog: LlmCallLog | null = null;

/**
 * Get the current call log (only available when trackCalls is enabled)
 */
export function getLlmCallLog(): LlmCallLog | null {
  return callLog;
}

/**
 * Clear the call log
 */
export function clearLlmCallLog(): void {
  if (callLog) {
    callLog.extractDiary = [];
    callLog.reflector = [];
    callLog.validator = [];
  }
}

/**
 * Create a mock generateObject function that returns shim responses
 */
function createMockGenerateObject(config: LlmShimConfig) {
  return async (options: any) => {
    // Apply delay if configured
    if (config.delay) {
      await new Promise(resolve => setTimeout(resolve, config.delay));
    }

    // Check for global error
    if (config.errors?.any) {
      throw config.errors.any;
    }

    const prompt = options?.prompt || options?.messages?.[0]?.content || "";
    const schema = options?.schema;

    // Detect which LLM function is being called based on prompt content
    if (prompt.includes("diary") || prompt.includes("session") || prompt.includes("accomplishments")) {
      // extractDiary call
      if (config.errors?.extractDiary) {
        throw config.errors.extractDiary;
      }

      if (callLog) {
        callLog.extractDiary.push({
          content: prompt,
          metadata: options,
          timestamp: new Date()
        });
      }

      const response = typeof config.extractDiary === "function"
        ? config.extractDiary(prompt)
        : config.extractDiary || DEFAULT_DIARY_RESPONSE;

      return {
        object: {
          status: response.status || "success",
          accomplishments: response.accomplishments || [],
          decisions: response.decisions || [],
          challenges: response.challenges || [],
          preferences: response.preferences || [],
          keyLearnings: response.keyLearnings || [],
          tags: response.tags || [],
          searchAnchors: response.searchAnchors || []
        }
      };
    }

    if (prompt.includes("reflect") || prompt.includes("delta") || prompt.includes("playbook")) {
      // runReflector call
      if (config.errors?.reflector) {
        throw config.errors.reflector;
      }

      if (callLog) {
        callLog.reflector.push({
          diary: prompt,
          playbook: options,
          timestamp: new Date()
        });
      }

      const response = typeof config.reflector === "function"
        ? config.reflector(prompt, options)
        : config.reflector || DEFAULT_REFLECTOR_RESPONSE;

      return {
        object: {
          deltas: (response.deltas || []).map(d => ({
            type: d.type || "add",
            bullet: d.type === "add" ? {
              content: (d as any).bullet?.content || "Test rule",
              category: (d as any).bullet?.category || "general",
              scope: (d as any).bullet?.scope || "global",
              tags: (d as any).bullet?.tags || []
            } : undefined,
            bulletId: (d as any).bulletId,
            reason: (d as any).reason || "Generated from reflection",
            sourceSession: (d as any).sourceSession || "/test/session.jsonl"
          }))
        }
      };
    }

    if (prompt.includes("valid") || prompt.includes("evidence") || prompt.includes("verdict")) {
      // runValidator call
      if (config.errors?.validator) {
        throw config.errors.validator;
      }

      if (callLog) {
        callLog.validator.push({
          delta: prompt,
          evidence: options,
          timestamp: new Date()
        });
      }

      const response = typeof config.validator === "function"
        ? config.validator(prompt, options)
        : config.validator || DEFAULT_VALIDATOR_RESPONSE;

      return {
        object: {
          verdict: response.verdict || "ACCEPT",
          confidence: response.confidence ?? 0.8,
          reasoning: response.reasoning || "Validated",
          refinedContent: response.refinedContent,
          supportingEvidence: response.supportingEvidence || []
        }
      };
    }

    // Default response for unknown LLM calls
    return {
      object: {}
    };
  };
}

/**
 * Run a test function with LLM responses shimmed
 *
 * @param config - Configuration for shim responses
 * @param fn - Test function to run
 * @returns Result of the test function
 */
export async function withLlmShim<T>(
  config: LlmShimConfig,
  fn: () => Promise<T>
): Promise<T> {
  currentConfig = config;

  // Reset call log - only create if tracking is enabled
  if (config.trackCalls) {
    callLog = {
      extractDiary: [],
      reflector: [],
      validator: []
    };
  } else {
    callLog = null;
  }

  const mockGenerateObject = createMockGenerateObject(config);

  // Mock the ai module
  mock.module("ai", () => ({
    generateObject: mockGenerateObject,
    generateText: async (options: any) => ({
      text: "mocked text response"
    })
  }));

  try {
    return await fn();
  } finally {
    currentConfig = null;
    // Don't clear callLog here so tests can inspect it after withLlmShim
    mock.restore();
  }
}

// --- Convenience Helpers ---

/**
 * Create a shim config for successful diary extraction
 */
export function createDiarySuccessShim(
  accomplishments: string[] = ["Task completed"],
  learnings: string[] = ["Learned something"]
): LlmShimConfig {
  return {
    extractDiary: {
      status: "success",
      accomplishments,
      decisions: [],
      challenges: [],
      preferences: [],
      keyLearnings: learnings,
      tags: ["success"],
      searchAnchors: accomplishments
    }
  };
}

/**
 * Create a shim config for failed diary extraction
 */
export function createDiaryFailureShim(
  challenges: string[] = ["Task failed"]
): LlmShimConfig {
  return {
    extractDiary: {
      status: "failure",
      accomplishments: [],
      decisions: [],
      challenges,
      preferences: [],
      keyLearnings: [],
      tags: ["failure"],
      searchAnchors: challenges
    }
  };
}

/**
 * Create a shim config that generates add deltas
 */
export function createReflectorAddDeltaShim(
  rules: Array<{ content: string; category?: string }>
): LlmShimConfig {
  return {
    reflector: {
      deltas: rules.map(r => ({
        type: "add" as const,
        bullet: {
          content: r.content,
          category: r.category || "general"
        },
        reason: "Generated from test reflection",
        sourceSession: "/test/session.jsonl"
      }))
    }
  };
}

/**
 * Create a shim config that always rejects validation
 */
export function createValidatorRejectShim(
  reason: string = "Insufficient evidence"
): LlmShimConfig {
  return {
    validator: {
      verdict: "REJECT",
      confidence: 0.9,
      reasoning: reason,
      supportingEvidence: []
    }
  };
}

/**
 * Create a shim config for offline testing with sensible defaults
 */
export function createOfflineShim(): LlmShimConfig {
  return {
    extractDiary: DEFAULT_DIARY_RESPONSE,
    reflector: DEFAULT_REFLECTOR_RESPONSE,
    validator: DEFAULT_VALIDATOR_RESPONSE,
    trackCalls: true
  };
}

/**
 * Create a shim config that simulates LLM API errors
 */
export function createErrorShim(
  errorMessage: string = "API rate limit exceeded"
): LlmShimConfig {
  return {
    errors: {
      any: new Error(errorMessage)
    }
  };
}
