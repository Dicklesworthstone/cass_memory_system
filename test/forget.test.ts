/**
 * Unit tests for forget command
 *
 * Tests:
 * - Forget a bullet (deprecate + add to blocked log)
 * - Forget with invert flag (creates anti-pattern)
 * - Error handling for missing reason
 * - Error handling for non-existent bullet
 * - JSON output format
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import yaml from "yaml";
import { join } from "node:path";
import { Playbook, PlaybookBullet } from "../src/types.js";
import { forgetCommand } from "../src/commands/forget.js";
import { withTempCassHome } from "./helpers/temp.js";

// Test helper to create a bullet
function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: overrides.id || "b-test123",
    content: "Test bullet content",
    category: "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: false,
    scope: "global",
    source: "learned",
    tags: [],
    state: "active",
    maturity: "candidate",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceSessions: [],
    sourceAgents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    ...overrides,
    confidenceDecayHalfLifeDays: overrides.confidenceDecayHalfLifeDays ?? 90
  };
}

// Test helper to create a playbook
function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    deprecatedPatterns: [],
    bullets
  };
}

describe("forget command - Unit Tests", () => {
  test("requires reason flag", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget1" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(env.configPath, JSON.stringify({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir
      }));

      process.exitCode = 0;

      await forgetCommand("b-forget1", { reason: undefined });

      expect(process.exitCode).toBe(2);
    });
  });

  test("forgets bullet and adds to blocked log", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget2", content: "Use var for all variables" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(env.configPath, JSON.stringify({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir
      }));

      process.exitCode = 0;

      await forgetCommand("b-forget2", { reason: "var is deprecated in modern JS" });

      expect(process.exitCode).toBe(0);

      // Check playbook - bullet should be deprecated
      const updatedPlaybook = yaml.parse(readFileSync(env.playbookPath, "utf-8")) as Playbook;
      const deprecatedBullet = updatedPlaybook.bullets.find(b => b.id === "b-forget2");
      expect(deprecatedBullet).toBeDefined();
      expect(deprecatedBullet?.deprecated).toBe(true);
      expect(deprecatedBullet?.deprecationReason).toBe("var is deprecated in modern JS");

      // Check blocked log - entry should exist
      const blockedLogPath = join(env.cassMemoryDir, "blocked.log");
      expect(existsSync(blockedLogPath)).toBe(true);
      const blockedLog = readFileSync(blockedLogPath, "utf-8");
      const entry = JSON.parse(blockedLog.trim());
      expect(entry.id).toBe("b-forget2");
      expect(entry.reason).toBe("var is deprecated in modern JS");
    });
  });

  test("forgets bullet with invert flag creates anti-pattern", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({
        id: "b-forget3",
        content: "Always use synchronous file operations",
        category: "performance",
        tags: ["io"]
      });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(env.configPath, JSON.stringify({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir
      }));

      process.exitCode = 0;

      await forgetCommand("b-forget3", {
        reason: "Synchronous operations block the event loop",
        invert: true
      });

      expect(process.exitCode).toBe(0);

      // Check playbook
      const updatedPlaybook = yaml.parse(readFileSync(env.playbookPath, "utf-8")) as Playbook;

      // Original should be deprecated
      const original = updatedPlaybook.bullets.find(b => b.id === "b-forget3");
      expect(original?.deprecated).toBe(true);

      // Anti-pattern should be created
      const antiPattern = updatedPlaybook.bullets.find(b => b.isNegative === true);
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID:");
      expect(antiPattern?.content).toContain("Always use synchronous file operations");
      expect(antiPattern?.tags).toContain("inverted");
      expect(antiPattern?.category).toBe("performance");
    });
  });

  test("returns error for non-existent bullet", async () => {
    await withTempCassHome(async (env) => {
      const playbook = createTestPlaybook([]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(env.configPath, JSON.stringify({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir
      }));

      process.exitCode = 0;

      await forgetCommand("b-nonexistent", { reason: "Testing" });

      expect(process.exitCode).toBe(2);
    });
  });

  test("JSON output includes bulletId and action", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget-json" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(env.configPath, JSON.stringify({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir
      }));

      process.exitCode = 0;

      // Capture console.log output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));

      await forgetCommand("b-forget-json", { reason: "Test reason", json: true });

      console.log = originalLog;

      expect(process.exitCode).toBe(0);

      // Parse JSON output - standard envelope with data payload
      const output = JSON.parse(logs.join("")) as { success: boolean; command: string; data: any };
      expect(output.success).toBe(true);
      expect(output.command).toBe("forget");
      expect(output.data.bulletId).toBe("b-forget-json");
      expect(output.data.action).toBe("forgotten");
    });
  });
});
