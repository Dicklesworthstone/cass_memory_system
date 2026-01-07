/**
 * E2E Tests for CLI outcome/outcome-apply commands.
 *
 * Covers:
 * - JSON success for outcome recording
 * - JSON error for invalid input
 * - outcome-apply soft success when session not found
 * - outcome-apply applying a logged outcome
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { outcomeCommand, applyOutcomeLogCommand } from "../src/commands/outcome.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { savePlaybook, loadPlaybook, findBullet } from "../src/playbook.js";

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("E2E: CLI outcome commands", () => {
  it("records outcome and updates playbook (json)", async () => {
    const log = createE2ELogger("outcome: json success");
    log.setRepro("bun test test/cli-outcome.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const bullet = createTestBullet({ id: "b-outcome-1" });
          const playbook = createTestPlaybook([bullet]);
          await savePlaybook(playbook, env.playbookPath);

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "success",
              rules: "b-outcome-1",
              duration: 120,
              errors: 0,
              text: "Thanks, that worked",
              json: true
            });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("json-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.command).toBe("outcome");
          expect(payload.data.applied).toBe(1);
          expect(payload.data.type).toBe("helpful");
          expect(payload.data.sentiment).toBe("positive");

          const updated = await loadPlaybook(env.playbookPath);
          const updatedBullet = findBullet(updated, "b-outcome-1");
          expect(updatedBullet).toBeDefined();
          expect(updatedBullet!.helpfulCount).toBe(1);
          expect(updatedBullet!.feedbackEvents?.length).toBe(1);
        });
      }, "outcome-json-success");
    });
  });

  it("returns JSON error when rules are missing", async () => {
    const log = createE2ELogger("outcome: json error");
    log.setRepro("bun test test/cli-outcome.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const originalExitCode = process.exitCode;
          process.exitCode = 0;

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "success",
              rules: "  ",
              json: true
            });
          } finally {
            capture.restore();
            process.exitCode = originalExitCode;
          }

          const allOutput = [...capture.logs, ...capture.errors].join("\n");
          const jsonMatch = allOutput.match(/\{[^]*\}/);
          expect(jsonMatch).toBeDefined();

          const payload = JSON.parse(jsonMatch![0]);
          log.snapshot("json-error", payload);

          expect(payload.success).toBe(false);
          expect(payload.command).toBe("outcome");
          expect(payload.error?.code).toBe("MISSING_REQUIRED");
        });
      }, "outcome-json-error");
    });
  });

  it("outcome-apply reports no outcomes for session (json)", async () => {
    const log = createE2ELogger("outcome-apply: no session outcomes");
    log.setRepro("bun test test/cli-outcome.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({ session: "missing-session", json: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("json-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.command).toBe("outcome-apply");
          expect(payload.effect).toBe(false);
          expect(String(payload.reason)).toContain("No outcomes found for session missing-session");
        });
      }, "outcome-apply-missing-session");
    });
  });

  it("outcome-apply applies logged outcomes to playbook (json)", async () => {
    const log = createE2ELogger("outcome-apply: json success");
    log.setRepro("bun test test/cli-outcome.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const bullet = createTestBullet({ id: "b-outcome-apply" });
          const playbook = createTestPlaybook([bullet]);
          await savePlaybook(playbook, env.playbookPath);

          const logPath = path.join(env.cassMemoryDir, "outcomes.jsonl");
          const record = {
            sessionId: "session-apply-1",
            outcome: "success",
            rulesUsed: ["b-outcome-apply"],
            recordedAt: "2026-01-01T00:00:00.000Z",
            path: logPath
          };
          await writeFile(logPath, JSON.stringify(record) + "\n", "utf-8");

          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({ session: "session-apply-1", json: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("json-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.command).toBe("outcome-apply");
          expect(payload.data.applied).toBe(1);
          expect(payload.data.missing).toEqual([]);

          const updated = await loadPlaybook(env.playbookPath);
          const updatedBullet = findBullet(updated, "b-outcome-apply");
          expect(updatedBullet).toBeDefined();
          expect(updatedBullet!.helpfulCount).toBe(1);
          expect(updatedBullet!.feedbackEvents?.length).toBe(1);
        });
      }, "outcome-apply-json-success");
    });
  });
});
