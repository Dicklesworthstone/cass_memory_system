/**
 * Workflow E2E: New user "first week" scenario
 *
 * Per bead cass_memory_system-xex1:
 * init → quickstart → context → outcome(success) → reflect → stats → context (learning applied)
 */
import { describe, it, expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { initCommand } from "../src/commands/init.js";
import { quickstartCommand } from "../src/commands/quickstart.js";
import { generateContextResult } from "../src/commands/context.js";
import { outcomeCommand } from "../src/commands/outcome.js";
import { reflectCommand } from "../src/commands/reflect.js";
import { statsCommand } from "../src/commands/stats.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

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

async function patchConfigForOffline(env: TestEnv): Promise<void> {
  const raw = await readFile(env.configPath, "utf-8").catch(() => "{}");
  const config = JSON.parse(raw || "{}") as any;
  config.cassPath = "__nonexistent__";
  config.remoteCass = { enabled: false, hosts: [] };
  config.validationEnabled = false;
  config.semanticSearchEnabled = false;
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function withEnv<T>(
  next: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(next)) {
    prev[k] = process.env[k];
    if (typeof v === "undefined") {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (typeof v === "undefined") {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe("Workflow E2E: first week", () => {
  it.serial("init → quickstart → context → outcome → reflect → stats → context", async () => {
    const log = createE2ELogger("workflow-first-week");
    log.setRepro("bun test test/workflow-first-week.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        log.snapshot("env", {
          home: env.home,
          cassMemoryDir: env.cassMemoryDir,
          configPath: env.configPath,
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        });

        // 1) init (seed starter so we have at least one rule to reference in outcome)
        log.step("Run init with starter (general)");
        const initCapture = captureConsole();
        try {
          await initCommand({ json: true, starter: "general" });
        } finally {
          initCapture.restore();
        }

        const initStdout = initCapture.logs.join("\n");
        log.snapshot("init.stdout", initStdout);
        const initPayload = JSON.parse(initStdout) as any;
        expect(initPayload.success).toBe(true);
        expect(initPayload.data?.starter?.added ?? 0).toBeGreaterThan(0);

        await patchConfigForOffline(env);
        await snapshotFile(log, "config.afterPatch", env.configPath);
        await snapshotFile(log, "playbook.afterInit", env.playbookPath);

        // 2) quickstart (docs)
        log.step("Run quickstart (json)");
        const qsCapture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          qsCapture.restore();
        }
        const qsStdout = qsCapture.logs.join("\n");
        log.snapshot("quickstart.stdout", qsStdout);
        const qsPayload = JSON.parse(qsStdout) as any;
        expect(qsPayload.success).toBe(true);
        expect(String(qsPayload.data?.oneCommand || "")).toContain("context");

        // 3) context for a first task
        log.step("Generate context for first task");
        const context1 = await generateContextResult("write a function", {});
        log.snapshot("context.first", context1.result);
        expect(Array.isArray(context1.result.relevantBullets)).toBe(true);
        expect(context1.result.relevantBullets.length).toBeGreaterThan(0);

        const usedRuleId = String(context1.result.relevantBullets[0]?.id || "");
        expect(usedRuleId).toMatch(/^starter-|^b-/);

        // 4) outcome success (implicit feedback on a referenced rule)
        log.step("Record outcome success for referenced rule", { usedRuleId });
        const outcomeCapture = captureConsole();
        try {
          await outcomeCommand({
            session: "first-week-1",
            status: "success",
            rules: usedRuleId,
            duration: 120,
            text: "that worked",
            json: true,
          });
        } finally {
          outcomeCapture.restore();
        }

        const outcomeStdout = outcomeCapture.logs.join("\n");
        log.snapshot("outcome.stdout", outcomeStdout);
        const outcomePayload = JSON.parse(outcomeStdout) as any;
        expect(outcomePayload.success).toBe(true);

        // 5) reflect (first learning) using deterministic stubs
        const learnedContent =
          "Write a failing test for your edge cases before implementing the first version.";
        const sessionsDir = path.join(env.home, "sessions");
        await mkdir(sessionsDir, { recursive: true });
        const sessionPath = path.join(sessionsDir, "session-first-week.jsonl");
        await writeFile(
          sessionPath,
          [
            JSON.stringify({
              role: "user",
              content:
                "We need a reliable way to avoid missing edge cases when writing small functions in TypeScript.",
            }),
            JSON.stringify({
              role: "assistant",
              content:
                "Start with a failing test for edge cases, then implement the minimal function to make it pass.",
            }),
          ].join("\n") + "\n",
          "utf-8"
        );

        log.step("Run reflect on a session (stubbed deltas)", { sessionPath });
        await withEnv(
          {
            CASS_MEMORY_LLM: "none",
            CM_REFLECTOR_STUBS: JSON.stringify([
              {
                deltas: [
                  {
                    type: "add",
                    bullet: { content: learnedContent, category: "testing" },
                    reason: "Catches regressions and makes edge cases explicit early",
                    sourceSession: sessionPath,
                  },
                ],
              },
            ]),
          },
          async () => {
            const reflectCapture = captureConsole();
            try {
              await reflectCommand({ session: sessionPath, json: true });
            } finally {
              reflectCapture.restore();
            }
            const reflectStdout = reflectCapture.logs.join("\n");
            log.snapshot("reflect.stdout", reflectStdout);
            const reflectPayload = JSON.parse(reflectStdout) as any;
            expect(reflectPayload.success).toBe(true);
          }
        );

        const playbookAfterReflectRaw = await readFile(env.playbookPath, "utf-8");
        const playbookAfterReflect = yaml.parse(playbookAfterReflectRaw) as any;
        const learnedBullet = (playbookAfterReflect?.bullets || []).find(
          (b: any) => typeof b?.content === "string" && b.content === learnedContent
        );
        expect(learnedBullet).toBeDefined();
        log.snapshot("playbook.afterReflect", playbookAfterReflect);

        // 6) stats
        log.step("Run stats (json)");
        const statsCapture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          statsCapture.restore();
        }
        const statsStdout = statsCapture.logs.join("\n");
        log.snapshot("stats.stdout", statsStdout);
        const statsPayload = JSON.parse(statsStdout) as any;
        expect(statsPayload.success).toBe(true);
        expect(Number(statsPayload.data?.total ?? 0)).toBeGreaterThan(0);

        // 7) context again; verify learning applied (learned bullet shows up)
        log.step("Generate context for second task (learning applied)");
        const context2 = await generateContextResult("write failing tests for edge cases", {});
        log.snapshot("context.second", context2.result);
        expect(
          context2.result.relevantBullets.some((b: any) => b?.id === learnedBullet.id)
        ).toBe(true);
      }, "cass-first-week");
    });
  });
});

