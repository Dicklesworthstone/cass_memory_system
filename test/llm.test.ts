import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import {
  getApiKey,
  validateApiKey,
  getModel,
  generateObjectSafe,
  objectGenerationOverrides,
  isLLMAvailable,
  getAvailableProviders,
  fillPrompt,
  llmWithRetry,
  llmWithFallback,
  LLM_RETRY_CONFIG,
  PROMPTS,
  type LLMIO,
  type LLMProvider
} from "../src/llm.js";
import { truncateForContext } from "../src/utils.js";
import { z } from "zod";
import { createTestConfig } from "./helpers/factories.js";

// ============================================================================
// Test Setup - Environment Variable Management
// ============================================================================

interface EnvBackup {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  AWS_ACCESS_KEY_ID?: string;
  CASS_CLI_COMMAND?: string;
}

let envBackup: EnvBackup = {};

function saveEnv() {
  envBackup = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    CASS_CLI_COMMAND: process.env.CASS_CLI_COMMAND,
  };
}

function restoreEnv() {
  const keys: Array<keyof EnvBackup> = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OLLAMA_BASE_URL",
    "AWS_ACCESS_KEY_ID",
    "CASS_CLI_COMMAND",
  ];
  for (const key of keys) {
    const value = envBackup[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearAllApiKeys() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.AWS_ACCESS_KEY_ID;
  // The cli provider is auto-detected from claude/codex/gemini binaries on
  // PATH, so "no keys" tests were not hermetic on dev machines that have
  // those tools installed. Pointing CASS_CLI_COMMAND at a nonexistent binary
  // makes resolveCliCommand() return null (it validates via Bun.which).
  process.env.CASS_CLI_COMMAND = "cass-test-nonexistent-cli-binary";
}

// ============================================================================
// getApiKey() Tests
// ============================================================================

describe("getApiKey", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("returns API key from environment for openai", () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-key-12345";
    expect(getApiKey("openai")).toBe("sk-test-openai-key-12345");
  });

  it("returns API key from environment for anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-12345";
    expect(getApiKey("anthropic")).toBe("sk-ant-test-key-12345");
  });

  it("returns API key from environment for google", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "AIzaSyTest123";
    expect(getApiKey("google")).toBe("AIzaSyTest123");
  });

  it("normalizes provider name to lowercase", () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    expect(getApiKey("OpenAI")).toBe("sk-test-key");
    expect(getApiKey("OPENAI")).toBe("sk-test-key");
    expect(getApiKey("  openai  ")).toBe("sk-test-key");
  });

  it("trims whitespace from API key", () => {
    process.env.OPENAI_API_KEY = "  sk-test-key  ";
    expect(getApiKey("openai")).toBe("sk-test-key");
  });

  it("throws error for missing API key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getApiKey("anthropic")).toThrow("ANTHROPIC_API_KEY environment variable not found");
  });

  it("throws error for empty API key", () => {
    process.env.OPENAI_API_KEY = "";
    expect(() => getApiKey("openai")).toThrow("OPENAI_API_KEY environment variable not found");
  });

  it("throws error for whitespace-only API key", () => {
    process.env.OPENAI_API_KEY = "   ";
    expect(() => getApiKey("openai")).toThrow("OPENAI_API_KEY environment variable not found");
  });

  it("throws error for unknown provider", () => {
    expect(() => getApiKey("unknown")).toThrow("Unknown LLM provider 'unknown'");
  });

  it("includes supported providers in unknown provider error", () => {
    expect(() => getApiKey("bedrock")).toThrow("Supported providers: openai, anthropic, google, ollama");
  });
});

// ============================================================================
// validateApiKey() Tests
// ============================================================================

describe("validateApiKey", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  // We capture console.error to verify warnings (warn() uses console.error)
  let warnMessages: string[] = [];
  const originalError = console.error;

  beforeEach(() => {
    warnMessages = [];
    console.error = (...args: any[]) => warnMessages.push(args.join(" "));
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("does not warn for valid OpenAI key format", () => {
    process.env.OPENAI_API_KEY = "sk-validkeyformat123456789012345678901234567890";
    validateApiKey("openai");
    expect(warnMessages.filter(m => m.includes("does not start with")).length).toBe(0);
  });

  it("warns for OpenAI key with wrong prefix", () => {
    process.env.OPENAI_API_KEY = "wrong-prefix-key-12345678901234567890";
    validateApiKey("openai");
    expect(warnMessages.some(m => m.includes("does not start with 'sk-'"))).toBe(true);
  });

  it("warns for Anthropic key with wrong prefix", () => {
    process.env.ANTHROPIC_API_KEY = "sk-wrong-anthropic-key-12345678901234567890";
    validateApiKey("anthropic");
    expect(warnMessages.some(m => m.includes("does not start with 'sk-ant-'"))).toBe(true);
  });

  it("warns for Google key with wrong prefix", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "wrong-google-key-12345678901234567890";
    validateApiKey("google");
    expect(warnMessages.some(m => m.includes("does not start with 'AIza'"))).toBe(true);
  });

  it("warns for placeholder values in key", () => {
    // The placeholders checked are lowercase: "your_api_key", "xxx", "test", "demo", "placeholder"
    // Use a long key to avoid the "short key" warning interfering with test isolation if any
    process.env.OPENAI_API_KEY = "sk-test-key-here-very-long-string-to-avoid-short-warning";
    validateApiKey("openai");
    expect(warnMessages.some(m => m.includes("placeholder"))).toBe(true);
  });

  it("warns for short API key", () => {
    process.env.OPENAI_API_KEY = "sk-short";
    validateApiKey("openai");
    expect(warnMessages.some(m => m.includes("seems too short"))).toBe(true);
  });

  it("does nothing for unknown provider", () => {
    validateApiKey("unknown");
    expect(warnMessages.length).toBe(0);
  });

  it("does nothing when API key is not set", () => {
    delete process.env.OPENAI_API_KEY;
    validateApiKey("openai");
    expect(warnMessages.length).toBe(0);
  });
});

// ============================================================================
// isLLMAvailable() Tests
// ============================================================================

describe("isLLMAvailable", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("returns true when OpenAI key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isLLMAvailable("openai")).toBe(true);
  });

  it("returns false when OpenAI key is not set", () => {
    delete process.env.OPENAI_API_KEY;
    expect(isLLMAvailable("openai")).toBe(false);
  });

  it("returns true when Anthropic key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isLLMAvailable("anthropic")).toBe(true);
  });

  it("returns false when Anthropic key is not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isLLMAvailable("anthropic")).toBe(false);
  });

  it("returns true when Google key is set", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "AIzaTest";
    expect(isLLMAvailable("google")).toBe(true);
  });

  it("returns false when Google key is not set", () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    expect(isLLMAvailable("google")).toBe(false);
  });
});

// ============================================================================
// getAvailableProviders() Tests
// ============================================================================

describe("getAvailableProviders", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("returns empty array when no keys are set", () => {
    clearAllApiKeys();
    expect(getAvailableProviders()).toEqual([]);
  });

  it("returns only providers with keys set", () => {
    clearAllApiKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getAvailableProviders()).toEqual(["openai"]);
  });

  it("returns multiple providers when multiple keys are set", () => {
    clearAllApiKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const providers = getAvailableProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers).not.toContain("google");
  });

  it("returns all providers when all keys are set", () => {
    clearAllApiKeys();
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "AIzaTest";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    const providers = getAvailableProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers).toContain("google");
    expect(providers).toContain("ollama");
    expect(providers.length).toBe(4);
  });
});

// ============================================================================
// getModel() Tests
// ============================================================================

describe("getModel", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("throws for missing API key", () => {
    clearAllApiKeys();
    expect(() => getModel({ provider: "openai", model: "gpt-4" })).toThrow();
  });

  it("accepts explicit apiKey parameter", () => {
    clearAllApiKeys();
    // This should not throw because we provide the key directly
    expect(() => getModel({
      provider: "openai",
      model: "gpt-4",
      apiKey: "sk-explicit-key"
    })).not.toThrow();
  });

  it("throws for unsupported provider", () => {
    expect(() => getModel({
      provider: "unsupported" as any,
      model: "model",
      apiKey: "key"
    })).toThrow("Unsupported provider");
  });

  it("creates OpenAI model when key is available", () => {
    process.env.OPENAI_API_KEY = "sk-test-key-12345678901234567890123456789012345678901234567890";
    const model = getModel({ provider: "openai", model: "gpt-4" });
    expect(model).toBeDefined();
  });

  it("creates Anthropic model when key is available", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-123456789012345678901234567890";
    const model = getModel({ provider: "anthropic", model: "claude-3-5-sonnet-20241022" });
    expect(model).toBeDefined();
  });

  it("creates Google model when key is available", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "AIzaSyTest1234567890123456789012345678";
    const model = getModel({ provider: "google", model: "gemini-1.5-flash" });
    expect(model).toBeDefined();
  });

  // #47 escape hatch / PR #59: `structuredOutputs` is a model-level setting
  // in @ai-sdk/openai 1.x — passing it to createOpenAI() is silently ignored.
  // Reasoning-style model ids default to structured outputs ON, so they are
  // the ids where the model-level toggle is observable.
  it("disableStructuredOutputs turns structured outputs off at the model level", () => {
    const flagOff = getModel({ provider: "openai", model: "o3", apiKey: "sk-test-key" }) as any;
    expect(flagOff.supportsStructuredOutputs).toBe(true);

    const flagOn = getModel({
      provider: "openai",
      model: "o3",
      apiKey: "sk-test-key",
      disableStructuredOutputs: true
    }) as any;
    expect(flagOn.supportsStructuredOutputs).toBe(false);
  });

  it("disableStructuredOutputs works for openai-compatible gateway model ids", () => {
    const model = getModel({
      provider: "openai",
      model: "deepseek/deepseek-chat",
      apiKey: "sk-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      disableStructuredOutputs: true
    }) as any;
    expect(model.supportsStructuredOutputs).toBe(false);
  });
});

// ============================================================================
// objectGenerationOverrides() Tests (#47 / PR #59)
// ============================================================================

describe("objectGenerationOverrides", () => {
  it("forces json mode for openai when structured outputs are disabled", () => {
    expect(objectGenerationOverrides("openai", true)).toEqual({ mode: "json" });
  });

  it("returns no override for openai when the flag is off", () => {
    expect(objectGenerationOverrides("openai", false)).toEqual({});
    expect(objectGenerationOverrides("openai", undefined)).toEqual({});
  });

  it("never overrides non-openai providers, even with the flag on", () => {
    expect(objectGenerationOverrides("anthropic", true)).toEqual({});
    expect(objectGenerationOverrides("google", true)).toEqual({});
    expect(objectGenerationOverrides("ollama", true)).toEqual({});
    expect(objectGenerationOverrides("bedrock", true)).toEqual({});
  });
});

// ============================================================================
// generateObjectSafe mode threading (#47 / PR #59)
// ============================================================================

describe("generateObjectSafe with disableStructuredOutputs", () => {
  const schema = z.object({ test: z.string() });

  function capturingIO(captured: { options: any }): LLMIO {
    return {
      generateObject: async <T>(options: any) => {
        captured.options = options;
        return { object: { test: "ok" } as T };
      }
    };
  }

  it("passes mode: json to generateObject when openai + flag on", async () => {
    const captured: { options: any } = { options: null };
    const config = createTestConfig({
      provider: "openai",
      model: "deepseek/deepseek-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      disableStructuredOutputs: true
    });

    const result = await generateObjectSafe(schema, "prompt", config, 3, capturingIO(captured));

    expect(result.test).toBe("ok");
    expect(captured.options.mode).toBe("json");
  });

  it("does not set mode when the flag is off (default openai behavior unchanged)", async () => {
    const captured: { options: any } = { options: null };
    const config = createTestConfig({ provider: "openai", model: "gpt-4o-mini" });

    await generateObjectSafe(schema, "prompt", config, 3, capturingIO(captured));

    expect(captured.options.mode).toBeUndefined();
  });

  it("does not set mode for non-openai providers even with the flag on", async () => {
    const captured: { options: any } = { options: null };
    const config = createTestConfig({ disableStructuredOutputs: true }); // anthropic default

    await generateObjectSafe(schema, "prompt", config, 3, capturingIO(captured));

    expect(captured.options.mode).toBeUndefined();
  });
});

// ============================================================================
// fillPrompt() Tests
// ============================================================================

describe("fillPrompt", () => {
  it("replaces single placeholder", () => {
    const template = "Hello {name}!";
    const result = fillPrompt(template, { name: "World" });
    expect(result).toBe("Hello World!");
  });

  it("replaces multiple different placeholders", () => {
    const template = "Hello {name}, you are {age} years old.";
    const result = fillPrompt(template, { name: "Alice", age: "30" });
    expect(result).toBe("Hello Alice, you are 30 years old.");
  });

  it("replaces repeated placeholders", () => {
    const template = "{word} {word} {word}";
    const result = fillPrompt(template, { word: "test" });
    expect(result).toBe("test test test");
  });

  it("leaves unknown placeholders unchanged", () => {
    const template = "Hello {name}, your {unknown} is ready.";
    const result = fillPrompt(template, { name: "Bob" });
    expect(result).toBe("Hello Bob, your {unknown} is ready.");
  });

  it("handles empty values", () => {
    const template = "Value: {value}";
    const result = fillPrompt(template, { value: "" });
    expect(result).toBe("Value: ");
  });

  it("handles empty template", () => {
    const result = fillPrompt("", { name: "test" });
    expect(result).toBe("");
  });

  it("handles empty values object", () => {
    const template = "No changes {here}";
    const result = fillPrompt(template, {});
    expect(result).toBe("No changes {here}");
  });

  it("handles multiline templates", () => {
    const template = `Line 1: {a}
Line 2: {b}
Line 3: {c}`;
    const result = fillPrompt(template, { a: "A", b: "B", c: "C" });
    expect(result).toBe(`Line 1: A
Line 2: B
Line 3: C`);
  });

  it("handles special regex characters in values", () => {
    const template = "Pattern: {pattern}";
    const result = fillPrompt(template, { pattern: ".*$^()[]" });
    expect(result).toBe("Pattern: .*$^()[]");
  });
});

// ============================================================================
// truncateForContext() Tests
// ============================================================================

describe("truncateForContext", () => {
  it("returns content unchanged when under limit", () => {
    const content = "Short content";
    const result = truncateForContext(content, { maxChars: 100 });
    expect(result).toBe(content);
  });

  it("returns content unchanged when at exact limit", () => {
    const content = "x".repeat(100);
    const result = truncateForContext(content, { maxChars: 100 });
    expect(result).toBe(content);
  });

  it("truncates content over limit with indicator", () => {
    const content = "x".repeat(1000);
    const result = truncateForContext(content, { maxChars: 200 });
    // The result should be smaller than original even with truncation indicator
    expect(result.length).toBeLessThan(1000);
    expect(result).toContain("truncated");
  });

  it("preserves beginning and end of content with middle strategy", () => {
    const content = "START" + "x".repeat(200) + "END";
    // With middle strategy (default), both start and end should be preserved
    const result = truncateForContext(content, { maxChars: 100, strategy: "middle" });
    expect(result).toContain("START");
    expect(result).toContain("END");
  });

  it("includes truncation marker", () => {
    const content = "x".repeat(500);
    const result = truncateForContext(content, { maxChars: 100 });
    expect(result).toContain("truncated");
  });

  it("uses default maxChars when not specified", () => {
    const shortContent = "x".repeat(100);
    const result = truncateForContext(shortContent);
    expect(result).toBe(shortContent);
  });

  it("handles very long content", () => {
    const content = "x".repeat(100000);
    const result = truncateForContext(content, { maxChars: 1000 });
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain("truncated");
  });
});

// ============================================================================
// LLM_RETRY_CONFIG Tests
// ============================================================================

describe("LLM_RETRY_CONFIG", () => {
  it("has expected retry configuration", () => {
    expect(LLM_RETRY_CONFIG.maxRetries).toBe(3);
    expect(LLM_RETRY_CONFIG.baseDelayMs).toBe(1000);
    expect(LLM_RETRY_CONFIG.maxDelayMs).toBe(30000);
    // Total default raised to 120000 (#53) so a bumped per-op timeout isn't masked
    // by the total ceiling (must be >= maxRetries * perOp). Both are env-overridable
    // via CM_LLM_TOTAL_TIMEOUT_MS / CM_LLM_TIMEOUT_MS.
    expect(LLM_RETRY_CONFIG.totalTimeoutMs).toBe(120000);
    expect(LLM_RETRY_CONFIG.perOperationTimeoutMs).toBe(30000);
  });

  it("includes common retryable error codes", () => {
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("rate_limit_exceeded");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("server_error");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("timeout");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("429");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("500");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("503");
  });
});

// ============================================================================
// llmWithRetry() Tests
// ============================================================================

describe("llmWithRetry", () => {
  let originalBaseDelay: number;

  beforeAll(() => {
    originalBaseDelay = LLM_RETRY_CONFIG.baseDelayMs;
    // Speed up tests by reducing delay
    LLM_RETRY_CONFIG.baseDelayMs = 10;
  });

  afterAll(() => {
    LLM_RETRY_CONFIG.baseDelayMs = originalBaseDelay;
  });

  it("returns result on first success", async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      return "success";
    };

    const result = await llmWithRetry(operation, "test-operation");
    expect(result).toBe("success");
    expect(callCount).toBe(1);
  });

  it("retries on retryable error and succeeds", async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      if (callCount < 2) {
        throw new Error("rate_limit_exceeded");
      }
      return "success after retry";
    };

    const result = await llmWithRetry(operation, "test-retry");
    expect(result).toBe("success after retry");
    expect(callCount).toBe(2);
  });

  it("throws immediately on non-retryable error", async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      throw new Error("invalid_api_key");
    };

    await expect(llmWithRetry(operation, "test-non-retryable")).rejects.toThrow("invalid_api_key");
    expect(callCount).toBe(1);
  });

  it("throws after max retries exhausted", async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      throw new Error("rate_limit_exceeded");
    };

    await expect(llmWithRetry(operation, "test-exhausted")).rejects.toThrow("rate_limit_exceeded");
    // Initial + 3 retries = 4 calls
    expect(callCount).toBe(4);
  });
});

// ============================================================================
// PROMPTS Tests
// ============================================================================

describe("PROMPTS", () => {
  it("has diary prompt template", () => {
    expect(PROMPTS.diary).toBeDefined();
    expect(PROMPTS.diary).toContain("{sessionPath}");
    expect(PROMPTS.diary).toContain("{agent}");
    expect(PROMPTS.diary).toContain("{content}");
  });

  it("has reflector prompt template", () => {
    expect(PROMPTS.reflector).toBeDefined();
    expect(PROMPTS.reflector).toContain("{existingBullets}");
    expect(PROMPTS.reflector).toContain("{diary}");
    expect(PROMPTS.reflector).toContain("{cassHistory}");
  });

  it("has validator prompt template", () => {
    expect(PROMPTS.validator).toBeDefined();
    expect(PROMPTS.validator).toContain("{proposedRule}");
    expect(PROMPTS.validator).toContain("{evidence}");
  });

  it("has context prompt template", () => {
    expect(PROMPTS.context).toBeDefined();
    expect(PROMPTS.context).toContain("{task}");
    expect(PROMPTS.context).toContain("{bullets}");
  });

  it("has audit prompt template", () => {
    expect(PROMPTS.audit).toBeDefined();
    expect(PROMPTS.audit).toContain("{sessionContent}");
    expect(PROMPTS.audit).toContain("{rulesToCheck}");
  });
});

// ============================================================================
// llmWithFallback() Tests
// ============================================================================

describe("llmWithFallback", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("throws when no providers are available", async () => {
    clearAllApiKeys();
    const config = createTestConfig();
    const schema = z.object({ test: z.string() });

    await expect(llmWithFallback(schema, "test prompt", config)).rejects.toThrow(
      "No LLM providers available"
    );
  });

  it("includes setup instructions in no-provider error", async () => {
    clearAllApiKeys();
    const config = createTestConfig();
    const schema = z.object({ test: z.string() });

    await expect(llmWithFallback(schema, "test prompt", config)).rejects.toThrow(
      "OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or OLLAMA_BASE_URL"
    );
  });
});

// ============================================================================
// Integration Tests (require API keys - skipped if unavailable)
// ============================================================================

describe("LLM integration (skipped if no API keys)", () => {
  // Only API-key providers that getModel() can build via the AI SDK — the
  // "cli" provider is auto-detected from binaries on PATH and getModel()
  // intentionally throws for it (use cliGenerateObject() instead).
  const sdkProviders = () =>
    getAvailableProviders().filter((p): p is "openai" | "anthropic" | "google" =>
      p === "openai" || p === "anthropic" || p === "google"
    );

  it.skipIf(sdkProviders().length === 0)("can create model for available provider", () => {
    const provider = sdkProviders()[0];
    const model = getModel({
      provider,
      model: provider === "openai" ? "gpt-4o-mini" :
             provider === "anthropic" ? "claude-3-5-sonnet-20241022" :
             "gemini-1.5-flash"
    });
    expect(model).toBeDefined();
  });
});
