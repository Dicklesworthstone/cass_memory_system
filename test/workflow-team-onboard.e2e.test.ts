/**
 * Workflow E2E: Team onboarding scenario
 *
 * Per bead cass_memory_system-xex1:
 * clone repo with existing playbook → doctor → context → why <bullet-id> → mark --helpful
 */
import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { initCommand } from "../src/commands/init.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { generateContextResult } from "../src/commands/context.js";
import { whyCommand } from "../src/commands/why.js";
import { markCommand } from "../src/commands/mark.js";
import { withTempCassHome, withTempDir, type TestEnv } from "./helpers/temp.js";
import { withTempGitRepo, commitAll } from "./helpers/git.js";
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

async function patchConfigForOffline(env: TestEnv): Promise<void> {
  const raw = await readFile(env.configPath, "utf-8").catch(() => "{}");
  const config = JSON.parse(raw || "{}") as any;
  config.cassPath = "__nonexistent__";
  config.remoteCass = { enabled: false, hosts: [] };
  config.validationEnabled = false;
  config.semanticSearchEnabled = false;
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

describe("Workflow E2E: team onboarding", () => {
  it.serial("clone repo → doctor → context → why → mark helpful", async () => {
    const log = createE2ELogger("workflow-team-onboard");
    log.setRepro("bun test test/workflow-team-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempGitRepo(async (repoDir) => {
        // Seed a repo-level playbook that a new teammate would inherit.
        const now = new Date().toISOString();
        const repoBulletId = "b-repo-onboard-001";
        const repoBulletContent =
          "When you clone a repo, run `cm doctor --json` to validate setup before starting work.";

        const cassDir = path.join(repoDir, ".cass");
        await mkdir(cassDir, { recursive: true });
        await writeFile(path.join(cassDir, "blocked.log"), "", "utf-8");

        const repoPlaybook = {
          schema_version: 2,
          name: "repo-playbook",
          description: "Project rules shared via git",
          metadata: { createdAt: now, totalReflections: 0, totalSessionsProcessed: 0 },
          deprecatedPatterns: [],
          bullets: [
            {
              id: repoBulletId,
              content: repoBulletContent,
              category: "workflow",
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
        await writeFile(path.join(cassDir, "playbook.yaml"), yaml.stringify(repoPlaybook), "utf-8");
        commitAll(repoDir, "Add repo playbook");

        await withTempDir("cass-team-onboard", async (dir) => {
          const cloneDir = path.join(dir, "clone");
          log.step("Clone repo", { repoDir, cloneDir });
          execSync(`git clone "${repoDir}" "${cloneDir}"`, { stdio: "pipe" });

          await withTempCassHome(async (env) => {
            log.snapshot("env", {
              home: env.home,
              configPath: env.configPath,
              playbookPath: env.playbookPath,
              diaryDir: env.diaryDir,
              cloneDir,
            });

            // Initialize global structure for the new teammate.
            log.step("Run init (json)");
            const initCapture = captureConsole();
            try {
              await initCommand({ json: true });
            } finally {
              initCapture.restore();
            }
            const initStdout = initCapture.logs.join("\n");
            log.snapshot("init.stdout", initStdout);
            expect((JSON.parse(initStdout) as any).success).toBe(true);

            await patchConfigForOffline(env);

            // Run doctor from within the cloned repo.
            await withCwd(cloneDir, async () => {
              log.step("Run doctor inside repo (json)");
              const doctorCapture = captureConsole();
              try {
                await doctorCommand({ json: true });
              } finally {
                doctorCapture.restore();
              }
              const doctorStdout = doctorCapture.logs.join("\n");
              log.snapshot("doctor.stdout", doctorStdout);
              const doctorPayload = JSON.parse(doctorStdout) as any;
              expect(doctorPayload.success).toBe(true);
              expect(doctorPayload.data?.checks?.length ?? 0).toBeGreaterThan(0);
            });

            // Context should surface the repo-level rule.
            await withCwd(cloneDir, async () => {
              log.step("Generate context inside repo (merged playbooks)");
              const ctx = await generateContextResult("validate setup after cloning", {});
              log.snapshot("context", ctx.result);
              const hasRepoRule = ctx.result.relevantBullets.some(
                (b: any) => typeof b?.content === "string" && b.content.includes("cm doctor")
              );
              expect(hasRepoRule).toBe(true);
            });

            // why <bullet-id>
            await withCwd(cloneDir, async () => {
              log.step("Run why (json)", { repoBulletId });
              const whyCapture = captureConsole();
              try {
                await whyCommand(repoBulletId, { json: true });
              } finally {
                whyCapture.restore();
              }
              const whyStdout = whyCapture.logs.join("\n");
              log.snapshot("why.stdout", whyStdout);
              const whyPayload = JSON.parse(whyStdout) as any;
              expect(whyPayload.success).toBe(true);
              expect(whyPayload.data?.bullet?.id).toBe(repoBulletId);
            });

            // mark --helpful (should apply to repo playbook)
            await withCwd(cloneDir, async () => {
              log.step("Mark repo bullet helpful (json)", { repoBulletId });
              const markCapture = captureConsole();
              try {
                await markCommand(repoBulletId, { helpful: true, json: true });
              } finally {
                markCapture.restore();
              }
              const markStdout = markCapture.logs.join("\n");
              log.snapshot("mark.stdout", markStdout);
              const markPayload = JSON.parse(markStdout) as any;
              expect(markPayload.success).toBe(true);
            });

            const updatedRepoPlaybookRaw = await readFile(
              path.join(cloneDir, ".cass", "playbook.yaml"),
              "utf-8"
            );
            const updatedRepoPlaybook = yaml.parse(updatedRepoPlaybookRaw) as any;
            log.snapshot("repoPlaybook.afterMark", updatedRepoPlaybook);
            const bullet = (updatedRepoPlaybook?.bullets || []).find((b: any) => b?.id === repoBulletId);
            expect(bullet).toBeDefined();
            expect(Number(bullet.helpfulCount ?? 0)).toBeGreaterThanOrEqual(1);
          }, "cass-team-onboard");
        });
      }, "cass-team-onboard-repo");
    });
  });
});
