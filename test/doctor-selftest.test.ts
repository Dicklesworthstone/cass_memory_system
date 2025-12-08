/**
 * Unit tests for runSelfTest function in doctor command.
 * Tests end-to-end smoke testing capabilities.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runSelfTest, HealthCheck } from "../src/commands/doctor.js";
import { createTestConfig } from "./helpers/factories.js";
import { withTempDir, withTempCassHome } from "./helpers/temp.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

describe("runSelfTest", () => {
  // Save and restore env vars
  let envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Helper to create valid playbook YAML
  function createValidPlaybookYaml(bulletCount = 0): string {
    const now = new Date().toISOString();
    const bullets = [];
    for (let i = 0; i < bulletCount; i++) {
      bullets.push({
        id: `b-${i}`,
        content: `Test bullet ${i}`,
        category: "testing",
        kind: "workflow_rule",
        type: "rule",
        isNegative: false,
        scope: "global",
        state: "draft",
        maturity: "candidate",
        helpfulCount: 0,
        harmfulCount: 0,
        feedbackEvents: [],
        tags: [],
        sourceSessions: [],
        sourceAgents: [],
        createdAt: now,
        updatedAt: now,
        deprecated: false,
        pinned: false,
        confidenceDecayHalfLifeDays: 90,
      });
    }
    return yaml.stringify({
      schema_version: 2,
      name: "test-playbook",
      description: "Test playbook for selftest",
      metadata: {
        createdAt: now,
        totalReflections: 0,
        totalSessionsProcessed: 0,
      },
      deprecatedPatterns: [],
      bullets,
    });
  }

  describe("Playbook Load Test", () => {
    it("reports pass for fast playbook load", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(1));

        const config = createTestConfig({ playbookPath });
        const checks = await runSelfTest(config);

        const playbookCheck = checks.find(c => c.item === "Playbook Load");
        expect(playbookCheck).toBeDefined();
        expect(playbookCheck!.category).toBe("Self-Test");
        expect(playbookCheck!.status).toBe("pass");
        expect(playbookCheck!.message).toContain("ms");
        expect(playbookCheck!.message).toContain("1 bullets");
      });
    });

    it("reports pass for empty playbook", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({ playbookPath });
        const checks = await runSelfTest(config);

        const playbookCheck = checks.find(c => c.item === "Playbook Load");
        expect(playbookCheck).toBeDefined();
        expect(playbookCheck!.status).toBe("pass");
        expect(playbookCheck!.message).toContain("0 bullets");
      });
    });

    it("creates empty playbook if not found", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "nonexistent.yaml");

        const config = createTestConfig({ playbookPath });
        const checks = await runSelfTest(config);

        const playbookCheck = checks.find(c => c.item === "Playbook Load");
        expect(playbookCheck).toBeDefined();
        // loadPlaybook creates an empty playbook if not found
        expect(playbookCheck!.status).toBe("pass");
        expect(playbookCheck!.message).toContain("0 bullets");
      });
    });
  });

  describe("Cass Search Test", () => {
    it("reports warn when cass is not available", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        // Use non-existent cass path
        const config = createTestConfig({
          playbookPath,
          cassPath: "/nonexistent/cass"
        });
        const checks = await runSelfTest(config);

        const cassCheck = checks.find(c => c.item === "Cass Search");
        expect(cassCheck).toBeDefined();
        expect(cassCheck!.status).toBe("warn");
        expect(cassCheck!.message).toContain("cass not available");
      });
    });
  });

  describe("Sanitization Test", () => {
    it("reports pass when sanitization is enabled with sufficient patterns", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          sanitization: { enabled: true, extraPatterns: [], auditLog: false }
        });
        const checks = await runSelfTest(config);

        const sanitizeCheck = checks.find(c => c.item === "Sanitization");
        expect(sanitizeCheck).toBeDefined();
        expect(sanitizeCheck!.category).toBe("Self-Test");
        // Built-in patterns should be >= 10
        expect(sanitizeCheck!.status).toBe("pass");
        expect(sanitizeCheck!.message).toContain("patterns loaded");
      });
    });

    it("reports warn when sanitization is disabled", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          sanitization: { enabled: false, extraPatterns: [], auditLog: false }
        });
        const checks = await runSelfTest(config);

        const sanitizeCheck = checks.find(c => c.item === "Sanitization");
        expect(sanitizeCheck).toBeDefined();
        expect(sanitizeCheck!.status).toBe("warn");
        expect(sanitizeCheck!.message).toBe("Disabled");
      });
    });
  });

  describe("Config Validation Test", () => {
    it("reports pass for valid config", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          diaryDir: "/tmp/diary",
          dedupSimilarityThreshold: 0.85,
          pruneHarmfulThreshold: 3,
        });
        const checks = await runSelfTest(config);

        const configCheck = checks.find(c => c.item === "Config Validation");
        expect(configCheck).toBeDefined();
        expect(configCheck!.status).toBe("pass");
        expect(configCheck!.message).toBe("Config valid");
      });
    });

    it("reports warn for invalid threshold values", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          dedupSimilarityThreshold: 1.5, // Invalid: > 1
        });
        const checks = await runSelfTest(config);

        const configCheck = checks.find(c => c.item === "Config Validation");
        expect(configCheck).toBeDefined();
        expect(configCheck!.status).toBe("warn");
        expect(configCheck!.message).toContain("issue(s) found");
        expect((configCheck!.details as any).issues).toContain("dedupSimilarityThreshold should be 0-1");
      });
    });

    it("reports warn for negative pruneHarmfulThreshold", async () => {
      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          pruneHarmfulThreshold: -1, // Invalid: negative
        });
        const checks = await runSelfTest(config);

        const configCheck = checks.find(c => c.item === "Config Validation");
        expect(configCheck).toBeDefined();
        expect(configCheck!.status).toBe("warn");
        expect((configCheck!.details as any).issues).toContain("pruneHarmfulThreshold should be non-negative");
      });
    });
  });

  describe("LLM System Test", () => {
    it("reports fail when no API keys are set", async () => {
      // Clear all API keys
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({ playbookPath, provider: "anthropic" });
        const checks = await runSelfTest(config);

        const llmCheck = checks.find(c => c.item === "LLM System");
        expect(llmCheck).toBeDefined();
        expect(llmCheck!.status).toBe("fail");
        expect(llmCheck!.message).toContain("No API keys configured");
      });
    });

    it("reports pass when API key is available for provider", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-api3-key-valid-abc123";

      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({
          playbookPath,
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022"
        });
        const checks = await runSelfTest(config);

        const llmCheck = checks.find(c => c.item === "LLM System");
        expect(llmCheck).toBeDefined();
        expect(llmCheck!.status).toBe("pass");
        expect(llmCheck!.message).toContain("anthropic");
        expect(llmCheck!.message).toContain("claude-3-5-sonnet");
      });
    });

    it("reports warn when current provider has no key but others do", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = "sk-proj-openai-key-valid";

      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({ playbookPath, provider: "anthropic" });
        const checks = await runSelfTest(config);

        const llmCheck = checks.find(c => c.item === "LLM System");
        expect(llmCheck).toBeDefined();
        expect(llmCheck!.status).toBe("warn");
        expect(llmCheck!.message).toContain("anthropic");
        expect(llmCheck!.message).toContain("not available");
        expect(llmCheck!.message).toContain("openai");
      });
    });
  });

  describe("Full Test Suite", () => {
    it("returns all 5 check categories", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-api3-key-valid-abc123";

      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({ playbookPath });
        const checks = await runSelfTest(config);

        // Should have exactly 5 checks
        expect(checks.length).toBe(5);

        // All should be in Self-Test category
        expect(checks.every(c => c.category === "Self-Test")).toBe(true);

        // Should have all 5 items
        const items = checks.map(c => c.item);
        expect(items).toContain("Playbook Load");
        expect(items).toContain("Cass Search");
        expect(items).toContain("Sanitization");
        expect(items).toContain("Config Validation");
        expect(items).toContain("LLM System");
      });
    });

    it("completes in reasonable time (<3 seconds)", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-api3-key-valid-abc123";

      await withTempDir("selftest", async (dir) => {
        const playbookPath = path.join(dir, "playbook.yaml");
        await writeFile(playbookPath, createValidPlaybookYaml(0));

        const config = createTestConfig({ playbookPath, cassPath: "/nonexistent" });

        const start = Date.now();
        await runSelfTest(config);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(3000);
      });
    });
  });
});
