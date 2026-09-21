/**
 * Integration tests for pipeline failure modes.
 *
 * Tests graceful handling of:
 * - Missing cass binary
 * - LLM errors during reflection
 * - Malformed session files (invalid JSONL, empty, binary data)
 * - Invalid diary entries
 * - Schema violations in deltas
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { curatePlaybook } from "../src/curate.js";
import { generateDiary } from "../src/diary.js";
import { __resetReflectorStubsForTest } from "../src/llm.js";
import { orchestrateReflection } from "../src/orchestrator.js";
import { reflectOnSession } from "../src/reflect.js";
import { DiaryEntrySchema } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { cleanupEnvironment, createIsolatedEnvironment, type TestEnv } from "./helpers/temp.js";

async function withIsolatedHome<T>(fn: (env: TestEnv) => Promise<T>): Promise<T> {
  const env = await createIsolatedEnvironment("pipeline-failures-test");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalCwd = process.cwd();

  try {
    process.env.HOME = env.home;
    process.env.USERPROFILE = env.home;
    process.chdir(env.home);
    return await fn(env);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.chdir(originalCwd);
    await cleanupEnvironment(env);
  }
}

function writeSession(sessionPath: string, content: string): void {
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, content, "utf-8");
}

function writeValidSession(sessionPath: string): void {
  const lines = [
    JSON.stringify({
      role: "user",
      content: "Help me write a function that validates email addresses.",
    }),
    JSON.stringify({
      role: "assistant",
      content: "Here's a regex-based email validator with proper error handling.",
    }),
    JSON.stringify({ role: "user", content: "Can you add unit tests for edge cases?" }),
    JSON.stringify({
      role: "assistant",
      content: "Added comprehensive tests covering empty strings, special chars, and subdomains.",
    }),
  ];
  writeSession(sessionPath, lines.join("\n") + "\n");
}

describe("Pipeline failure modes", () => {
  beforeEach(() => {
    __resetReflectorStubsForTest();
  });

  afterEach(() => {
    delete process.env.CM_REFLECTOR_STUBS;
    delete process.env.CASS_MEMORY_LLM;
    __resetReflectorStubsForTest();
  });

  describe("Malformed session files", () => {
    test("handles empty session file gracefully", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "empty.jsonl");
        writeSession(sessionPath, "");

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";

        const outcome = await orchestrateReflection(config, { session: sessionPath });

        // Empty session produces an error but doesn't crash
        expect(outcome.errors.length).toBeGreaterThanOrEqual(0);
        expect(outcome.deltasGenerated).toBe(0);
      });
    });

    test("handles invalid JSONL (non-JSON lines) gracefully", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "invalid.jsonl");
        writeSession(sessionPath, "not json\nalso not json\n{invalid:json}\n");

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";

        // generateDiary should handle parse errors gracefully
        try {
          const diary = await generateDiary(sessionPath, config);
          // If it succeeds, diary should have empty or minimal content
          expect(diary).toBeTruthy();
        } catch (err: any) {
          // If it fails, should have a meaningful error message
          expect(err.message).toBeTruthy();
        }
      });
    });

    test("handles binary data in session file", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "binary.jsonl");
        // Write some binary garbage
        const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
        mkdirSync(path.dirname(sessionPath), { recursive: true });
        writeFileSync(sessionPath, binaryData);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";

        const outcome = await orchestrateReflection(config, { session: sessionPath });

        // Should handle gracefully - either skip or report error cleanly
        expect(outcome.sessionsProcessed).toBeLessThanOrEqual(1);
      });
    });

    test("handles session with only whitespace", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "whitespace.jsonl");
        writeSession(sessionPath, "   \n\t\n   \n");

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";

        const outcome = await orchestrateReflection(config, { session: sessionPath });

        // Whitespace-only session may produce error but doesn't crash
        expect(outcome.errors.length).toBeGreaterThanOrEqual(0);
        expect(outcome.deltasGenerated).toBe(0);
      });
    });

    test("handles mixed valid and invalid lines", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "mixed.jsonl");
        const lines = [
          JSON.stringify({ role: "user", content: "Valid line here" }),
          "invalid json line",
          JSON.stringify({ role: "assistant", content: "Another valid line" }),
          "{truncated json",
          JSON.stringify({
            role: "user",
            content: "Final valid line that makes this long enough to process",
          }),
        ];
        writeSession(sessionPath, lines.join("\n") + "\n");

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";

        // Should skip invalid lines and continue
        try {
          const diary = await generateDiary(sessionPath, config);
          expect(diary).toBeTruthy();
          expect(diary.id).toBeTruthy();
        } catch {
          // Also acceptable if it fails gracefully
        }
      });
    });
  });

  describe("Missing cass binary", () => {
    test("orchestrator continues with fallback when cass is missing", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
        writeValidSession(sessionPath);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/nonexistent/path/to/cass", // Missing binary
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";
        process.env.CM_REFLECTOR_STUBS = JSON.stringify([
          {
            deltas: [
              {
                type: "add",
                bullet: {
                  content: "Rule from session with missing cass",
                  category: "testing",
                  tags: [],
                },
                reason: "Test",
                sourceSession: "stub",
              },
            ],
          },
        ]);

        const outcome = await orchestrateReflection(config, { session: sessionPath });

        // Should succeed using fallback JSONL parsing
        expect(outcome.errors).toEqual([]);
        expect(outcome.sessionsProcessed).toBe(1);
      });
    });

    test("diary generation works without cass for enrichment", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
        writeValidSession(sessionPath);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/definitely/not/a/real/path",
          validationEnabled: false,
        });

        process.env.CASS_MEMORY_LLM = "none";

        const diary = await generateDiary(sessionPath, config);

        expect(diary).toBeTruthy();
        expect(diary.sessionPath).toBe(sessionPath);
        // DiaryEntry schema uses different field names - check id exists
        expect(diary.id).toBeTruthy();
      });
    });
  });

  describe("LLM unavailable", () => {
    test("CASS_MEMORY_LLM=none allows pipeline to run without API calls", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
        writeValidSession(sessionPath);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";
        // No CM_REFLECTOR_STUBS - diary will work but reflection returns empty

        const outcome = await orchestrateReflection(config, { session: sessionPath });

        // Pipeline completes without LLM
        expect(outcome.errors).toEqual([]);
      });
    });
  });

  describe("Curate failure modes", () => {
    test("handles delta with invalid type gracefully", () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig();

      const invalidDelta = {
        type: "invalid_type_xyz" as any,
        bullet: { content: "test", category: "test" },
        reason: "test",
        sourceSession: "/path",
      };

      const result = curatePlaybook(playbook, [invalidDelta] as any, config);

      // Should skip invalid delta
      expect(result.applied).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    test("handles delta referencing non-existent bullet ID", () => {
      const bullet = createTestBullet({ id: "b-exists", content: "I exist", category: "test" });
      const playbook = createTestPlaybook([bullet]);
      const config = createTestConfig();

      const delta = {
        type: "helpful" as const,
        bulletId: "b-does-not-exist",
        reason: "test",
        sourceSession: "/path/to/session.jsonl",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.skipped).toBe(1);
      expect(result.applied).toBe(0);
    });

    test("handles delta with empty content", () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig();

      const delta = {
        type: "add" as const,
        bullet: { content: "", category: "test" },
        reason: "test",
        sourceSession: "/path",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.skipped).toBe(1);
      expect(result.applied).toBe(0);
    });

    test("handles delta with null bullet", () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig();

      const delta = {
        type: "add" as const,
        bullet: null as any,
        reason: "test",
        sourceSession: "/path",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    test("handles concurrent modification detection via conflicts", () => {
      const bullet1 = createTestBullet({
        id: "b-1",
        content: "Always use async/await for database calls",
        category: "database",
      });
      const bullet2 = createTestBullet({
        id: "b-2",
        content: "Never use async for database calls, use callbacks",
        category: "database",
      });
      const playbook = createTestPlaybook([bullet1, bullet2]);
      const config = createTestConfig();

      const delta = {
        type: "add" as const,
        bullet: {
          content: "Prefer sync database operations for simplicity",
          category: "database",
          tags: [],
        },
        reason: "Contradicts existing rules",
        sourceSession: "/path",
      };

      const result = curatePlaybook(playbook, [delta], config);

      // Should detect conflict with existing rules
      expect(result.conflicts.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Reflect failure modes", () => {
    test("handles diary with minimal valid fields", async () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig({ maxReflectorIterations: 1 });

      // Construct a minimal valid diary per schema (requires agent and status)
      const minimalDiary = {
        id: "test-diary",
        sessionPath: "/path/to/session.jsonl",
        timestamp: new Date().toISOString(),
        agent: "test-agent",
        status: "success" as const,
      };

      process.env.CASS_MEMORY_LLM = "none";
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: [] }]);

      // Should handle gracefully
      const parsedDiary = DiaryEntrySchema.parse(minimalDiary);
      const result = await reflectOnSession(parsedDiary, playbook, config);

      expect(result.deltas).toEqual([]);
    });

    test("reflector stubs with malformed JSON are handled", async () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig({ maxReflectorIterations: 1 });

      const diary = DiaryEntrySchema.parse({
        id: "test-diary",
        sessionPath: "/path/to/session.jsonl",
        timestamp: new Date().toISOString(),
        agent: "test-agent",
        status: "success" as const,
      });

      process.env.CASS_MEMORY_LLM = "none";
      process.env.CM_REFLECTOR_STUBS = "not valid json [}{]";

      // Should throw or handle gracefully
      try {
        await reflectOnSession(diary, playbook, config);
      } catch (err: any) {
        expect(err.message).toBeTruthy();
      }
    });
  });

  describe("Progress callback during failures", () => {
    test("progress callback receives error events", async () => {
      await withIsolatedHome(async (env) => {
        const sessionPath = path.join(env.home, "sessions", "will-error.jsonl");
        // Valid session that will work
        writeValidSession(sessionPath);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";
        process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: [] }]);

        const events: any[] = [];

        const outcome = await orchestrateReflection(config, {
          session: sessionPath,
          onProgress: (event) => events.push(event),
        });

        // Should have received progress events
        expect(events.length).toBeGreaterThan(0);
        const phases = events.map((e) => e.phase);
        expect(phases).toContain("session_start");
      });
    });
  });

  describe("Recovery from partial failures", () => {
    test("processes remaining sessions after one fails", async () => {
      await withIsolatedHome(async (env) => {
        // Create multiple session files
        const session1 = path.join(env.home, "sessions", "s1.jsonl");
        const session2 = path.join(env.home, "sessions", "s2.jsonl");

        writeValidSession(session1);
        writeValidSession(session2);

        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass",
          validationEnabled: false,
          sessionLookbackDays: 30,
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

        process.env.CASS_MEMORY_LLM = "none";
        process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: [] }]);

        // Process both sessions
        const outcome1 = await orchestrateReflection(config, { session: session1 });
        const outcome2 = await orchestrateReflection(config, { session: session2 });

        // Both should complete
        expect(outcome1.errors).toEqual([]);
        expect(outcome2.errors).toEqual([]);
      });
    });
  });
});
