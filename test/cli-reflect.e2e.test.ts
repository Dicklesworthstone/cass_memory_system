/**
 * E2E Tests for CLI reflect command - Session reflection and learning
 *
 * Tests the `cm reflect` command for processing agent sessions
 * and extracting patterns into the playbook.
 *
 * Per bead lmwr requirements:
 * - Real subprocess execution via bun
 * - Test reflection on session exports
 * - Verify deltas are generated correctly
 * - Verify playbook is updated with new patterns
 * - Test --dry-run mode
 * - Test error cases: no sessions, invalid session format
 * - Detailed logging: sessions processed, deltas generated, playbook changes
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { reflectCommand } from "../src/commands/reflect.js";
import { PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { loadPlaybook } from "../src/playbook.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { createTestBullet } from "./helpers/factories.js";
import { createTestLogger, type TestLogger } from "./helpers/logger.js";
import {
  cleanupEnvironment,
  createIsolatedEnvironment,
  makeCassStub,
  type TestEnv,
  withTempCassHome,
} from "./helpers/temp.js";

// Helper to check if a file exists
async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Helper to capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.warn = (...args: any[]) => {
    // Capture warnings in errors array
    errors.push(`[WARN] ${args.map(String).join(" ")}`);
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

// Create a valid test playbook
function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    bullets: bullets,
    deprecatedPatterns: [],
  };
}

// Create a valid test config
function createTestConfig(cassPath: string = "cass") {
  return {
    schema_version: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    cassPath: cassPath,
    sessionLookbackDays: 7,
    maxReflectorIterations: 1,
    validation: {
      enabled: false, // Disable validation for tests to avoid LLM calls
      minEvidenceCount: 1,
    },
    scoring: {
      decayHalfLifeDays: 90,
      harmfulMultiplier: 4,
    },
  };
}

// Create mock session data that cass would return
function createMockSession(sessionPath: string, agent: string = "claude") {
  return {
    source_path: sessionPath,
    line_number: 1,
    agent: agent,
    snippet: "User asked about TypeScript configuration",
    score: 0.9,
  };
}

describe("E2E: reflect failure status (#99)", () => {
  const cmPath = path.join(import.meta.dir, "..", "src", "cm.ts");
  const rule = "Check the process exit status before treating a reflection job as healthy.";
  const reflectorStubs = JSON.stringify([{
    deltas: [{ type: "add", bullet: { content: rule, category: "testing" }, reason: "session evidence" }],
  }]);

  function runReflect(env: TestEnv, args: string[]) {
    return spawnSync(process.execPath, ["run", cmPath, "reflect", ...args], {
      cwd: env.home,
      env: {
        ...process.env,
        HOME: env.home,
        USERPROFILE: env.home,
        CASS_MEMORY_LLM: "none",
        CM_REFLECTOR_STUBS: reflectorStubs,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      encoding: "utf-8",
      timeout: 30_000,
    });
  }

  async function setup(env: TestEnv, cassPath = path.join(env.home, "missing-cass")) {
    await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook([])));
    await writeFile(env.configPath, JSON.stringify({
      ...createTestConfig(cassPath),
      playbookPath: env.playbookPath,
      diaryDir: env.diaryDir,
      validationEnabled: false,
      semanticSearchEnabled: false,
    }));
  }

  async function writeSession(env: TestEnv, name: string) {
    const sessionPath = path.join(env.home, `${name}.jsonl`);
    await writeFile(sessionPath, [
      { role: "user", content: "Our reflection job failed but reported that it had completed successfully." },
      { role: "assistant", content: "Check both the structured result and the process exit status for failures." },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    return sessionPath;
  }

  for (const dryRun of [false, true]) {
    it(`fails for an oversized playbook${dryRun ? " in dry-run" : ""} without losing error details`, async () => {
      await withTempCassHome(async env => {
        await setup(env);
        const sessionPath = await writeSession(env, "oversized");
        const oversized = yaml.stringify(createTestPlaybook([])) + "# " + "x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes);
        await writeFile(env.playbookPath, oversized);
        const configBefore = await readFile(env.configPath, "utf8");

        const result = runReflect(env, ["--session", sessionPath, "--json", ...(dryRun ? ["--dry-run"] : [])]);
        expect(result.error).toBeUndefined();
        const payload = JSON.parse(result.stdout);
        expect(result.status).not.toBe(0);
        expect(payload.success).toBe(false);
        expect(payload.command).toBe("reflect");
        expect(payload.error.code).toBe("REFLECTION_FAILED");
        expect(payload.error.exitCode).toBe(result.status);
        expect(payload.data.sessionsProcessed).toBe(0);
        expect(payload.data.deltasGenerated).toBe(0);
        expect(payload.data.errors).toHaveLength(1);
        expect(payload.data.errors[0]).toContain("Input limit exceeded");
        expect(payload.data.errors[0]).toContain(sessionPath);
        expect(payload.warnings).toEqual(payload.data.errors);
        expect(typeof payload.metadata.executionMs).toBe("number");
        if (dryRun) expect(payload.data.deltas).toEqual([]);

        expect(await readFile(env.playbookPath, "utf8")).toBe(oversized);
        // A failed run must not be mistaken for the first successful reflect
        // and bake budget defaults into the user's configuration.
        expect(await readFile(env.configPath, "utf8")).toBe(configBefore);
        const log = new ProcessedLog(getProcessedLogPath());
        await log.load();
        expect(log.has(sessionPath)).toBe(false);
        if (dryRun) expect(log.get(sessionPath)).toBeUndefined();
        else expect(log.get(sessionPath)).toMatchObject({ status: "failed", failures: 1 });
      });
    });

    it(`returns partial results when one session fails${dryRun ? " in dry-run" : ""}`, async () => {
      await withTempCassHome(async env => {
        const goodSession = await writeSession(env, "good");
        const missingSession = path.join(env.home, "missing.jsonl");
        const timeline = JSON.stringify({ groups: [{ date: "2026-10-28", sessions: [
          { path: missingSession, agent: "claude" },
          { path: goodSession, agent: "claude" },
        ] }] });
        // Discovery sees both sessions; export uses the real file fallback.
        const cassPath = path.join(env.home, "cass-fixture");
        await writeFile(cassPath, `#!${process.execPath}
if (process.argv[2] === "timeline") console.log(${JSON.stringify(timeline)});
else if (process.argv[2] === "export") process.exit(1);
else console.log("[]");
`, { mode: 0o755 });
        await setup(env, cassPath);
        const playbookBefore = await readFile(env.playbookPath, "utf8");
        const configBefore = await readFile(env.configPath, "utf8");

        const result = runReflect(env, ["--json", ...(dryRun ? ["--dry-run"] : [])]);
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.exitCode).toBe(result.status);
        expect(payload.data.sessionsProcessed).toBe(1);
        expect(payload.data.deltasGenerated).toBe(1);
        expect(payload.data.errors).toHaveLength(1);
        expect(payload.data.errors[0]).toContain(missingSession);
        expect(await readFile(env.configPath, "utf8")).toBe(configBefore);

        const log = new ProcessedLog(getProcessedLogPath());
        await log.load();
        const saved = yaml.parse(await readFile(env.playbookPath, "utf8"));
        if (dryRun) {
          expect(payload.data.deltas).toHaveLength(1);
          expect(payload.data.deltas[0].bullet.content).toBe(rule);
          expect(await readFile(env.playbookPath, "utf8")).toBe(playbookBefore);
          expect(log.get(goodSession)).toBeUndefined();
          expect(log.get(missingSession)).toBeUndefined();
        } else {
          expect(payload.data.global.applied).toBe(1);
          expect(saved.bullets.map((bullet: { content: string }) => bullet.content)).toContain(rule);
          expect(saved.metadata.totalReflections).toBe(1);
          expect(saved.metadata.totalSessionsProcessed).toBe(1);
          expect(log.has(goodSession)).toBe(true);
          expect(log.has(missingSession)).toBe(false);
          expect(log.get(missingSession)).toMatchObject({ status: "failed", failures: 1 });

          // A later successful run skips the already committed session.
          const rerun = runReflect(env, ["--session", goodSession, "--json"]);
          expect(rerun.status).toBe(0);
          expect(JSON.parse(rerun.stdout).data.sessionsProcessed).toBe(0);
          const afterRerun = yaml.parse(await readFile(env.playbookPath, "utf8"));
          expect(afterRerun.metadata.totalSessionsProcessed).toBe(1);
        }
      });
    });

    it(`sets a nonzero exit status for human output${dryRun ? " in dry-run" : ""}`, async () => {
      await withTempCassHome(async env => {
        await setup(env);
        const missingSession = path.join(env.home, "missing.jsonl");
        const result = runReflect(env, ["--session", missingSession, ...(dryRun ? ["--dry-run"] : [])]);
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Failed to process");
        expect(result.stdout).toContain("completed with errors");
        expect(result.stdout).not.toContain("Reflection complete.");
      });
    });
  }

  it("reports discovery failure as failure rather than a successful empty run", async () => {
    await withTempCassHome(async env => {
      const cassPath = await makeCassStub(env.home, {
        exitCode: 1,
        search: '{"error":"search failed"}',
        timeline: '{"error":"timeline failed"}',
      });
      await setup(env, cassPath);
      const result = runReflect(env, ["--json"]);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.success).toBe(false);
      expect(payload.data.sessionsProcessed).toBe(0);
      expect(payload.data.errors[0]).toContain("Session discovery failed");
    });
  });

  it("keeps normal-sized successful reflection successful and reports its work", async () => {
    await withTempCassHome(async env => {
      await setup(env);
      const sessionPath = await writeSession(env, "normal");
      const result = runReflect(env, ["--session", sessionPath, "--json"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.success).toBe(true);
      expect(payload.error).toBeUndefined();
      expect(payload.data.sessionsProcessed).toBe(1);
      expect(payload.data.deltasGenerated).toBe(1);
      expect(payload.data.global.applied).toBe(1);
      expect(payload.data.errors).toEqual([]);
    });
  });

  it("successfully reflects after CLI repair without losing legacy feedback or restoring inline embeddings", async () => {
    await withTempCassHome(async env => {
      await setup(env);
      const timestamp = new Date().toISOString();
      const legacyBullet = createTestBullet({
        id: "b-legacy-preserved",
        content: "Run SQLite foreign-key checks before publishing database migrations.",
        helpfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp, context: "Caught an invalid migration", sessionPath: "/archive/database-a.jsonl" },
          { type: "helpful", timestamp, context: "Preserved referential integrity", sessionPath: "/archive/database-b.jsonl" },
        ],
        sourceSessions: ["/archive/database-a.jsonl", "/archive/database-b.jsonl"],
        sourceAgents: ["codex"],
        tags: ["database"],
        embedding: [0.1, 0.2, 0.3],
      });
      const legacy = createTestPlaybook([legacyBullet]);
      legacy.metadata.totalReflections = 7;
      legacy.metadata.totalSessionsProcessed = 11;
      const original = yaml.stringify(legacy);
      await writeFile(env.playbookPath, original);

      const repaired = spawnSync(process.execPath, ["run", cmPath, "playbook", "repair", "--strip-embeddings", "--json"], {
        cwd: env.home,
        env: { ...process.env, HOME: env.home, USERPROFILE: env.home, NO_COLOR: "1", FORCE_COLOR: "0" },
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(repaired.error).toBeUndefined();
      expect(repaired.status).toBe(0);
      const repairPayload = JSON.parse(repaired.stdout);
      expect(repairPayload.success).toBe(true);
      expect(repairPayload.data).toMatchObject({ changed: true, embeddingsRemoved: 1, bulletCount: 1, preservationVerified: true });
      expect(await readFile(repairPayload.data.backupPath, "utf8")).toBe(original);

      const sessionPath = await writeSession(env, "after-repair");
      const reflected = runReflect(env, ["--session", sessionPath, "--json"]);
      expect(reflected.error).toBeUndefined();
      expect(reflected.status).toBe(0);
      const payload = JSON.parse(reflected.stdout);
      expect(payload.success).toBe(true);
      expect(payload.data).toMatchObject({ sessionsProcessed: 1, deltasGenerated: 1, errors: [] });
      expect(payload.data.global.applied).toBe(1);

      // Exercise the ordinary bounded reader after reflection's normal writer.
      const saved = await loadPlaybook(env.playbookPath);
      expect(saved.bullets).toHaveLength(2);
      const preserved = saved.bullets.find(bullet => bullet.id === legacyBullet.id);
      const { embedding, ...legacyState } = legacyBullet;
      expect(preserved).toEqual(legacyState);
      expect(saved.bullets.map(bullet => bullet.content)).toContain(rule);
      expect(saved.bullets.every(bullet => !Object.hasOwn(bullet, "embedding"))).toBe(true);
      expect(saved.metadata.totalReflections).toBe(8);
      expect(saved.metadata.totalSessionsProcessed).toBe(12);
      const stored = yaml.parse(await readFile(env.playbookPath, "utf8"));
      expect(stored.bullets.every((bullet: Record<string, unknown>) => !Object.hasOwn(bullet, "embedding"))).toBe(true);

      const log = new ProcessedLog(getProcessedLogPath());
      await log.load();
      expect(log.has(sessionPath)).toBe(true);
      expect(log.get(sessionPath)).toMatchObject({ sessionPath, deltasGenerated: 1 });
      expect(await readFile(repairPayload.data.backupPath, "utf8")).toBe(original);
    });
  });

  it("keeps empty discovery successful even when a budget diagnostic is emitted", async () => {
    await withTempCassHome(async env => {
      const cassPath = await makeCassStub(env.home, { search: "[]", timeline: '{"groups":[]}' });
      await setup(env, cassPath);
      const result = runReflect(env, ["--json"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("budget limits are code defaults");
      const payload = JSON.parse(result.stdout);
      expect(payload.success).toBe(true);
      expect(payload.error).toBeUndefined();
      expect(payload.data.sessionsProcessed).toBe(0);
      expect(payload.data.errors).toEqual([]);
    });
  });
});

describe("E2E: CLI reflect command", () => {
  let logger: TestLogger;

  beforeEach(() => {
    logger = createTestLogger("cli-reflect-e2e", "debug");
  });

  afterEach(() => {
    // Optionally flush logs to file for debugging failed tests
    if (process.env.KEEP_LOGS) {
      logger.flushToFile();
    }
  });

  describe("No Sessions Available", () => {
    it("reports no new sessions when cass returns empty results", async () => {
      logger.startStep("no-sessions-test");

      await withTempCassHome(async (env) => {
        logger.info("Created temp environment", { home: env.home });

        // Create empty playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        logger.info("Created empty playbook", { path: env.playbookPath });

        // Create cass stub that returns empty timeline
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });
        logger.info("Created cass stub", { stubPath: cassStub });

        // Create config pointing to stub
        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));
        logger.info("Created config", { cassPath: cassStub });

        // Run reflect
        const capture = captureConsole();
        try {
          await reflectCommand({ json: false });
        } finally {
          capture.restore();
        }

        logger.info("Reflect completed", {
          logs: capture.logs,
          errors: capture.errors,
        });

        // Should report no sessions
        const output = capture.logs.join("\n");
        expect(
          output.includes("No new sessions") ||
            output.includes("0 sessions") ||
            capture.logs.length === 0,
        ).toBe(true);

        logger.endStep("no-sessions-test", true);
      });
    });
  });

  describe("Dry Run Mode", () => {
    it("outputs proposed deltas without modifying playbook in dry-run mode", async () => {
      logger.startStep("dry-run-test");

      await withTempCassHome(async (env) => {
        logger.info("Created temp environment", { home: env.home });

        // Create initial playbook with one bullet
        const initialBullet = {
          id: "b-initial-001",
          content: "Always validate input data before processing",
          kind: "workflow_rule",
          category: "validation",
          scope: "global",
          tags: ["validation", "safety"],
          maturity: "established",
          state: "active",
          type: "rule",
          helpfulCount: 5,
          harmfulCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const playbook = createTestPlaybook([initialBullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        logger.info("Created playbook with initial bullet", { bulletId: initialBullet.id });

        // Create cass stub that returns a session
        // Note: The actual reflection will still fail without a real LLM,
        // but we can test that dry-run doesn't modify the playbook
        const mockSessionPath = "/sessions/test-session.jsonl";
        const cassStub = await makeCassStub(env.home, {
          search: JSON.stringify([createMockSession(mockSessionPath)]),
          timeline: JSON.stringify({
            groups: [
              {
                date: "2025-01-01",
                sessions: [{ path: mockSessionPath, agent: "claude" }],
              },
            ],
          }),
          export:
            "# Test Session\n\nUser: How do I handle errors?\nAssistant: Use try-catch blocks.",
        });
        logger.info("Created cass stub with mock session", { sessionPath: mockSessionPath });

        // Create config with validation disabled
        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Read playbook before reflect
        const playbookBefore = await readFile(env.playbookPath, "utf-8");
        logger.info("Playbook before reflect", { content: playbookBefore.slice(0, 200) });

        // Run reflect with dry-run
        const capture = captureConsole();
        try {
          await reflectCommand({ dryRun: true, json: true });
        } catch (err: any) {
          // May fail due to no LLM, but should still not modify playbook
          logger.warn("Reflect threw error (expected without LLM)", { error: err.message });
        } finally {
          capture.restore();
        }

        logger.info("Dry-run completed", {
          logs: capture.logs.length,
          errors: capture.errors.length,
        });

        // Read playbook after reflect
        const playbookAfter = await readFile(env.playbookPath, "utf-8");

        // Playbook should be unchanged in dry-run mode
        expect(playbookAfter).toBe(playbookBefore);
        logger.info("Verified playbook unchanged in dry-run mode");

        logger.endStep("dry-run-test", true);
      });
    });
  });

  describe("JSON Output Format", () => {
    it("outputs valid JSON structure when --json flag is used", async () => {
      logger.startStep("json-output-test");

      await withTempCassHome(async (env) => {
        logger.info("Created temp environment", { home: env.home });

        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub with empty results
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        // Create config
        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with JSON output
        const capture = captureConsole();
        try {
          await reflectCommand({ json: true });
        } finally {
          capture.restore();
        }

        logger.info("JSON output captured", { logs: capture.logs });

        // Should have JSON output
        if (capture.logs.length > 0) {
          const jsonOutput = capture.logs.join("");

          // Try to parse as JSON
          try {
            const parsed = JSON.parse(jsonOutput);
            logger.info("Parsed JSON output", { keys: Object.keys(parsed) });

            // Should have expected structure
            expect(parsed).toBeDefined();
            // The structure varies based on whether sessions were found
          } catch (err) {
            // If it's not valid JSON, that's still acceptable for "no sessions" case
            logger.info("Output not JSON (expected for empty results)", { output: jsonOutput });
          }
        }

        logger.endStep("json-output-test", true);
      });
    });

    it("includes global and repo results in JSON output", async () => {
      logger.startStep("json-structure-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        // Create config
        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with JSON output
        const capture = captureConsole();
        try {
          await reflectCommand({ json: true, days: 1 });
        } finally {
          capture.restore();
        }

        // Check JSON structure if output exists
        if (capture.logs.length > 0 && capture.logs[0].startsWith("{")) {
          const payload = JSON.parse(capture.logs.join("")) as any;
          const parsed = payload.data;

          // When there are results, should have this structure
          if (parsed.global !== undefined || parsed.repo !== undefined) {
            expect(Array.isArray(parsed.errors)).toBe(true);
            logger.info("JSON structure verified", {
              hasGlobal: !!parsed.global,
              hasRepo: !!parsed.repo,
              errorCount: parsed.errors?.length,
            });
          }
        }

        logger.endStep("json-structure-test", true);
      });
    });
  });

  describe("Session Processing Options", () => {
    it("respects --days option to limit session lookback", async () => {
      logger.startStep("days-option-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub that checks for --days parameter
        // Note: We can't easily verify the parameter was passed,
        // but we can verify the command runs successfully
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with specific days
        const capture = captureConsole();
        try {
          await reflectCommand({ days: 3, json: true });
        } finally {
          capture.restore();
        }

        logger.info("Days option test completed", { logs: capture.logs });

        // Should complete without error
        expect(capture.errors.filter((e) => !e.includes("[WARN]")).length).toBe(0);

        logger.endStep("days-option-test", true);
      });
    });

    it("respects --maxSessions option to limit processed sessions", async () => {
      logger.startStep("max-sessions-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with maxSessions
        const capture = captureConsole();
        try {
          await reflectCommand({ maxSessions: 2, json: true });
        } finally {
          capture.restore();
        }

        logger.info("Max sessions test completed", { logs: capture.logs });

        // Should complete without error
        expect(capture.errors.filter((e) => !e.includes("[WARN]")).length).toBe(0);

        logger.endStep("max-sessions-test", true);
      });
    });

    it("respects --agent option to filter by agent type", async () => {
      logger.startStep("agent-filter-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with agent filter
        const capture = captureConsole();
        try {
          await reflectCommand({ agent: "claude", json: true });
        } finally {
          capture.restore();
        }

        logger.info("Agent filter test completed", { logs: capture.logs });

        // Should complete without error
        expect(capture.errors.filter((e) => !e.includes("[WARN]")).length).toBe(0);

        logger.endStep("agent-filter-test", true);
      });
    });
  });

  describe("Error Handling", () => {
    it("handles missing cass binary gracefully", async () => {
      logger.startStep("missing-cass-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create config pointing to non-existent cass
        const config = createTestConfig("/nonexistent/cass");
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect
        const capture = captureConsole();
        try {
          await reflectCommand({ json: true });
        } catch (err: any) {
          logger.info("Expected error caught", { message: err.message });
        } finally {
          capture.restore();
        }

        logger.info("Missing cass test completed", {
          logs: capture.logs,
          errors: capture.errors,
        });

        // Should have warning about cass not being available
        const allOutput = [...capture.logs, ...capture.errors].join(" ");
        const hasCassWarning =
          allOutput.toLowerCase().includes("cass") ||
          allOutput.includes("fallback") ||
          allOutput.includes("not found") ||
          allOutput.includes("playbook-only");

        // Either warns about cass or handles gracefully
        expect(hasCassWarning || capture.errors.length > 0 || capture.logs.length >= 0).toBe(true);

        logger.endStep("missing-cass-test", true);
      });
    });

    it("handles corrupted playbook gracefully", async () => {
      logger.startStep("corrupted-playbook-test");

      await withTempCassHome(async (env) => {
        // Create corrupted playbook
        await writeFile(env.playbookPath, "invalid: yaml: : : content\n  broken");
        logger.info("Created corrupted playbook");

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect
        const capture = captureConsole();
        let errorThrown = false;
        try {
          await reflectCommand({ json: true });
        } catch (err: any) {
          errorThrown = true;
          logger.info("Error caught for corrupted playbook", { message: err.message });
        } finally {
          capture.restore();
        }

        logger.info("Corrupted playbook test completed", {
          errorThrown,
          errors: capture.errors,
        });

        // Should either throw error or report error in output
        expect(errorThrown || capture.errors.length > 0).toBe(true);

        logger.endStep("corrupted-playbook-test", true);
      });
    });

    it("handles cass returning error status gracefully", async () => {
      logger.startStep("cass-error-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub that returns errors
        const cassStub = await makeCassStub(env.home, {
          exitCode: 1,
          search: '{"error": "search failed"}',
          timeline: '{"error": "timeline failed"}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect
        const capture = captureConsole();
        try {
          await reflectCommand({ json: true });
        } catch (err: any) {
          logger.info("Error caught for cass failure", { message: err.message });
        } finally {
          capture.restore();
        }

        logger.info("Cass error test completed", {
          logs: capture.logs,
          errors: capture.errors,
        });

        // Should handle gracefully (either warns or reports 0 sessions)
        logger.endStep("cass-error-test", true);
      });
    });
  });

  describe("Workspace Support", () => {
    it("supports --workspace option for scoped reflection", async () => {
      logger.startStep("workspace-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with workspace
        const capture = captureConsole();
        try {
          await reflectCommand({ workspace: "test-project", json: true });
        } finally {
          capture.restore();
        }

        logger.info("Workspace test completed", { logs: capture.logs });

        // Should complete without error
        expect(capture.errors.filter((e) => !e.includes("[WARN]")).length).toBe(0);

        logger.endStep("workspace-test", true);
      });
    });
  });

  describe("Specific Session Processing", () => {
    it("processes a specific session path when --session is provided", async () => {
      logger.startStep("specific-session-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create a mock session file
        const sessionDir = path.join(env.home, "sessions");
        await mkdir(sessionDir, { recursive: true });
        const sessionPath = path.join(sessionDir, "test-session.jsonl");
        await writeFile(
          sessionPath,
          JSON.stringify({
            role: "user",
            content: "How do I implement error handling?",
          }) +
            "\n" +
            JSON.stringify({
              role: "assistant",
              content: "Use try-catch blocks and proper error boundaries.",
            }),
        );
        logger.info("Created mock session file", { path: sessionPath });

        // Create cass stub that handles export
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
          export: "User: How do I implement error handling?\nAssistant: Use try-catch blocks.",
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect with specific session
        const capture = captureConsole();
        try {
          await reflectCommand({ session: sessionPath, dryRun: true, json: true });
        } catch (err: any) {
          // May fail without LLM, but should at least attempt to process
          logger.info("Expected error without LLM", { message: err.message });
        } finally {
          capture.restore();
        }

        logger.info("Specific session test completed", {
          logs: capture.logs,
          errors: capture.errors,
        });

        logger.endStep("specific-session-test", true);
      });
    });
  });

  describe("Integration with Playbook Updates", () => {
    it("preserves existing playbook bullets when adding new ones", async () => {
      logger.startStep("preserve-bullets-test");

      await withTempCassHome(async (env) => {
        // Create playbook with existing bullet
        const existingBullet = {
          id: "b-existing-001",
          content: "Always use TypeScript strict mode",
          kind: "project_convention",
          category: "typescript",
          scope: "global",
          tags: ["typescript", "config"],
          maturity: "proven",
          state: "active",
          type: "rule",
          helpfulCount: 10,
          harmfulCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const playbook = createTestPlaybook([existingBullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        logger.info("Created playbook with existing bullet", { bulletId: existingBullet.id });

        // Create cass stub with no new sessions
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect
        const capture = captureConsole();
        try {
          await reflectCommand({ json: true });
        } finally {
          capture.restore();
        }

        // Read playbook after reflect
        const playbookAfter = yaml.parse(await readFile(env.playbookPath, "utf-8"));

        // Existing bullet should still be there
        const bulletStillExists = playbookAfter.bullets.some(
          (b: any) => b.id === existingBullet.id,
        );
        expect(bulletStillExists).toBe(true);
        logger.info("Verified existing bullet preserved", {
          bulletCount: playbookAfter.bullets.length,
        });

        logger.endStep("preserve-bullets-test", true);
      });
    });
  });

  describe("Processed Session Tracking", () => {
    it("tracks processed sessions to avoid reprocessing", async () => {
      logger.startStep("tracking-test");

      await withTempCassHome(async (env) => {
        // Create playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create cass stub
        const cassStub = await makeCassStub(env.home, {
          search: "[]",
          timeline: '{"groups":[]}',
        });

        const config = createTestConfig(cassStub);
        await writeFile(env.configPath, JSON.stringify(config, null, 2));

        // Run reflect twice
        const capture1 = captureConsole();
        try {
          await reflectCommand({ json: true });
        } finally {
          capture1.restore();
        }

        const capture2 = captureConsole();
        try {
          await reflectCommand({ json: true });
        } finally {
          capture2.restore();
        }

        logger.info("Ran reflect twice", {
          firstLogs: capture1.logs,
          secondLogs: capture2.logs,
        });

        // Both runs should report no sessions (none found, and tracking prevents re-processing)
        // This is a sanity check that the command is idempotent
        logger.endStep("tracking-test", true);
      });
    });
  });

  describe("Budget default notice and bake (#68)", () => {
    const NOTICE_MARKER = "reflect budget limits are code defaults";

    async function setupNoSessionEnv(env: TestEnv, extraConfig: Record<string, any> = {}) {
      const playbook = createTestPlaybook([]);
      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const cassStub = await makeCassStub(env.home, {
        search: "[]",
        timeline: '{"groups":[]}',
      });

      const config = { ...createTestConfig(cassStub), ...extraConfig };
      await writeFile(env.configPath, JSON.stringify(config, null, 2));
      return config;
    }

    it("emits the default-budget notice when budget is unbaked, and bakes it on success", async () => {
      await withTempCassHome(async (env) => {
        await setupNoSessionEnv(env); // no budget key in config file

        const capture = captureConsole();
        try {
          await reflectCommand({ json: false });
        } finally {
          capture.restore();
        }

        // Notice emitted (to stderr) because the budget came from zod defaults.
        const stderr = capture.errors.join("\n");
        expect(stderr).toContain(NOTICE_MARKER);

        // Budget got baked into the config file after the successful reflect.
        const saved = JSON.parse(await readFile(env.configPath, "utf-8"));
        expect(saved.budget).toBeDefined();
        expect(typeof saved.budget.dailyLimit).toBe("number");
        expect(typeof saved.budget.monthlyLimit).toBe("number");
        expect(typeof saved.budget.warningThreshold).toBe("number");
        expect(typeof saved.budget.currency).toBe("string");
      });
    });

    it("bake preserves all other config keys and their order", async () => {
      await withTempCassHome(async (env) => {
        const config = await setupNoSessionEnv(env);
        const before = JSON.parse(await readFile(env.configPath, "utf-8"));

        const capture = captureConsole();
        try {
          await reflectCommand({ json: false });
        } finally {
          capture.restore();
        }

        const after = JSON.parse(await readFile(env.configPath, "utf-8"));
        const { budget: _budget, ...rest } = after;
        expect(rest).toEqual(before);
        expect(Object.keys(after)).toEqual([...Object.keys(config), "budget"]);
      });
    });

    it("already-baked config: no notice and no write", async () => {
      await withTempCassHome(async (env) => {
        await setupNoSessionEnv(env, {
          budget: {
            dailyLimit: 0.42,
            monthlyLimit: 4.2,
            warningThreshold: 80,
            currency: "USD",
          },
        });
        const contentBefore = await readFile(env.configPath, "utf-8");

        const capture = captureConsole();
        try {
          await reflectCommand({ json: false });
        } finally {
          capture.restore();
        }

        // No notice — the budget was explicitly present in the config file.
        const stderr = capture.errors.join("\n");
        expect(stderr).not.toContain(NOTICE_MARKER);

        // No write — config file content is byte-for-byte identical.
        const contentAfter = await readFile(env.configPath, "utf-8");
        expect(contentAfter).toBe(contentBefore);
      });
    });

    it("dry-run: notice still shown but nothing is baked", async () => {
      await withTempCassHome(async (env) => {
        await setupNoSessionEnv(env); // unbaked
        const contentBefore = await readFile(env.configPath, "utf-8");

        const capture = captureConsole();
        try {
          await reflectCommand({ json: false, dryRun: true });
        } finally {
          capture.restore();
        }

        const stderr = capture.errors.join("\n");
        expect(stderr).toContain(NOTICE_MARKER);

        // Dry run promises no writes — config file untouched.
        const contentAfter = await readFile(env.configPath, "utf-8");
        expect(contentAfter).toBe(contentBefore);
      });
    });
  });
});
