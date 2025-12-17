/**
 * Workflow E2E: Playbook migration scenario
 *
 * Per bead cass_memory_system-xex1:
 * create old-schema playbook → doctor --fix → verify data preserved + new schema fields available
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";
import { doctorCommand } from "../src/commands/doctor.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig } from "./helpers/factories.js";

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
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
    warns.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    warns,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

async function snapshotFile(
  log: ReturnType<typeof createE2ELogger>,
  name: string,
  filePath: string
): Promise<void> {
  const contents = await readFile(filePath, "utf-8").catch(() => "");
  log.snapshot(name, contents);
}

describe("Workflow E2E: playbook migration", () => {
  it.serial("old schema → doctor --fix migrates → data preserved", async () => {
    const log = createE2ELogger("workflow-migration");
    log.setRepro("bun test test/workflow-migration.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env: TestEnv) => {
        const config = createTestConfig({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          cassPath: "__nonexistent__",
          validationEnabled: false,
          semanticSearchEnabled: false,
          remoteCass: { enabled: false, hosts: [] },
        });
        await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");

        const createdAt = new Date("2025-01-01T00:00:00.000Z").toISOString();
        const bulletCreatedAt = new Date("2025-01-02T00:00:00.000Z").toISOString();
        const bulletId = "b-old-schema-001";
        const bulletContent = "Prefer deterministic, offline tests for CLI workflows.";

        // Simulate an older schema playbook (schema_version: 1) with minimal bullet shape.
        const oldPlaybook = {
          schema_version: 1,
          name: "legacy-playbook",
          description: "Legacy playbook used before schema v2",
          metadata: { createdAt },
          bullets: [
            {
              id: bulletId,
              content: bulletContent,
              category: "testing",
              createdAt: bulletCreatedAt,
              updatedAt: bulletCreatedAt,
            },
          ],
        };
        await writeFile(env.playbookPath, yaml.stringify(oldPlaybook), "utf-8");
        await snapshotFile(log, "playbook.before", env.playbookPath);

        // doctor --fix should migrate schema version and materialize defaults without losing data.
        const capture = captureConsole();
        try {
          await doctorCommand({ json: true, fix: true });
        } finally {
          capture.restore();
        }

        const doctorStdout = capture.logs.join("\n");
        log.snapshot("doctor.stdout", doctorStdout);
        const doctorPayload = JSON.parse(doctorStdout) as any;
        expect(doctorPayload.success).toBe(true);

        await snapshotFile(log, "playbook.after", env.playbookPath);
        const migrated = yaml.parse(await readFile(env.playbookPath, "utf-8")) as any;

        expect(Number(migrated.schema_version ?? 0)).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(migrated.deprecatedPatterns)).toBe(true);
        expect(Array.isArray(migrated.bullets)).toBe(true);

        const bullet = migrated.bullets.find((b: any) => b?.id === bulletId);
        expect(bullet).toBeDefined();
        expect(bullet.content).toBe(bulletContent);
        expect(bullet.category).toBe("testing");

        // "New features available": defaults materialized
        expect(typeof bullet.scope).toBe("string");
        expect(typeof bullet.kind).toBe("string");
        expect(typeof bullet.type).toBe("string");
        expect(typeof bullet.helpfulCount).toBe("number");
        expect(typeof bullet.harmfulCount).toBe("number");
      }, "cass-migration");
    });
  });
});

