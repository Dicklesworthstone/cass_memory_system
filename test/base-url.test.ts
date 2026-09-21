import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { getModel, type LLMProvider } from "../src/llm.js";
import { ConfigSchema } from "../src/types.js";
import { createTestConfig } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

// ============================================================================
// Environment Variable Management
// ============================================================================

interface EnvBackup {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  GOOGLE_BASE_URL?: string;
}

let envBackup: EnvBackup = {};

function saveEnv() {
  envBackup = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL,
  };
}

function restoreEnv() {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearBaseUrlEnvVars() {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.GOOGLE_BASE_URL;
}

// ============================================================================
// ConfigSchema baseUrl field
// ============================================================================

describe("ConfigSchema baseUrl field", () => {
  it("accepts baseUrl as optional string", () => {
    const result = ConfigSchema.safeParse({
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBe("https://openrouter.ai/api/v1");
    }
  });

  it("defaults to undefined when not set", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBeUndefined();
    }
  });

  it("does not break existing config when baseUrl is omitted", () => {
    const result = ConfigSchema.safeParse({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openai");
      expect(result.data.model).toBe("gpt-4o-mini");
      expect(result.data.baseUrl).toBeUndefined();
    }
  });
});

// ============================================================================
// loadConfig baseUrl handling
// ============================================================================

describe("loadConfig baseUrl", () => {
  beforeEach(() => {
    saveEnv();
    clearBaseUrlEnvVars();
  });
  afterEach(() => restoreEnv());

  it("loads baseUrl from global config file", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "openai",
          model: "gpt-4o-mini",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
      );

      const config = await loadConfig();
      expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    });
  });

  it("uses OPENAI_BASE_URL env var as fallback when config has no baseUrl", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, JSON.stringify({ provider: "openai", model: "gpt-4o-mini" }));

      process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";

      const config = await loadConfig();
      expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
    });
  });

  it("uses ANTHROPIC_BASE_URL env var as fallback", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-20250514" }),
      );

      process.env.ANTHROPIC_BASE_URL = "https://custom-anthropic.example.com/v1";

      const config = await loadConfig();
      expect(config.baseUrl).toBe("https://custom-anthropic.example.com/v1");
    });
  });

  it("uses GOOGLE_BASE_URL env var as fallback", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({ provider: "google", model: "gemini-1.5-flash" }),
      );

      process.env.GOOGLE_BASE_URL = "https://custom-google.example.com/v1";

      const config = await loadConfig();
      expect(config.baseUrl).toBe("https://custom-google.example.com/v1");
    });
  });

  it("config baseUrl takes precedence over env var", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "openai",
          model: "gpt-4o-mini",
          baseUrl: "https://from-config.example.com/v1",
        }),
      );

      process.env.OPENAI_BASE_URL = "https://from-env.example.com/v1";

      const config = await loadConfig();
      expect(config.baseUrl).toBe("https://from-config.example.com/v1");
    });
  });

  it("default behavior unchanged when neither config nor env var set", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, JSON.stringify({ provider: "openai", model: "gpt-4o-mini" }));

      const config = await loadConfig();
      expect(config.baseUrl).toBeUndefined();
    });
  });

  it("CLI override baseUrl takes precedence over config and env", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.configPath,
        JSON.stringify({
          provider: "openai",
          model: "gpt-4o-mini",
          baseUrl: "https://from-config.example.com/v1",
        }),
      );

      process.env.OPENAI_BASE_URL = "https://from-env.example.com/v1";

      const config = await loadConfig({
        baseUrl: "https://from-cli.example.com/v1",
      });
      expect(config.baseUrl).toBe("https://from-cli.example.com/v1");
    });
  });
});

// ============================================================================
// getModel baseUrl passthrough
// ============================================================================

describe("getModel with baseUrl", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("creates OpenAI model with custom baseUrl without throwing", () => {
    const model = getModel({
      provider: "openai",
      model: "anthropic/claude-haiku-4-5",
      apiKey: "sk-or-v1-test-key-for-openrouter-12345678901234567890",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(model).toBeDefined();
    expect(model.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("creates Anthropic model with custom baseUrl without throwing", () => {
    const model = getModel({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test-key-for-custom-endpoint-12345678901234567890",
      baseUrl: "https://custom-anthropic.example.com/v1",
    });
    expect(model).toBeDefined();
  });

  it("creates Google model with custom baseUrl without throwing", () => {
    const model = getModel({
      provider: "google",
      model: "gemini-1.5-flash",
      apiKey: "AIzaSyTest1234567890123456789012345678",
      baseUrl: "https://custom-google.example.com/v1",
    });
    expect(model).toBeDefined();
  });

  it("creates model without baseUrl (default behavior unchanged)", () => {
    const model = getModel({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test-key-for-default-behavior-12345678901234567890",
    });
    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-4o-mini");
  });

  it("ignores baseUrl for ollama provider", () => {
    // Ollama uses its own ollamaBaseUrl, not the generic baseUrl
    const model = getModel({
      provider: "ollama",
      model: "llama3.2:3b",
      baseUrl: "https://should-be-ignored.example.com/v1",
      ollamaBaseUrl: "http://localhost:11434",
    });
    expect(model).toBeDefined();
  });
});

// ============================================================================
// createTestConfig factory includes baseUrl
// ============================================================================

describe("createTestConfig baseUrl", () => {
  it("defaults to undefined baseUrl", () => {
    const config = createTestConfig();
    expect(config.baseUrl).toBeUndefined();
  });

  it("accepts baseUrl override", () => {
    const config = createTestConfig({
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

// ============================================================================
// End-to-end: OpenRouter-style config
// ============================================================================

describe("OpenRouter-style configuration", () => {
  it("full OpenRouter config parses correctly", () => {
    const result = ConfigSchema.safeParse({
      provider: "openai",
      model: "anthropic/claude-haiku-4-5",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openai");
      expect(result.data.model).toBe("anthropic/claude-haiku-4-5");
      expect(result.data.baseUrl).toBe("https://openrouter.ai/api/v1");
    }
  });

  it("full Azure OpenAI config parses correctly", () => {
    const result = ConfigSchema.safeParse({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBe(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      );
    }
  });
});
