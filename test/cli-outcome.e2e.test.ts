/**
 * E2E Tests for CLI outcome/outcome-apply commands.
 *
 * Covers:
 * - JSON success for outcome recording
 * - JSON error for invalid input
 * - outcome-apply soft success when session not found
 * - outcome-apply applying a logged outcome
 */
import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateContextResult } from "../src/commands/context.js";
import { applyOutcomeLogCommand, outcomeCommand } from "../src/commands/outcome.js";
import { __test as serveTest } from "../src/commands/serve.js";
import { loadConfig } from "../src/config.js";
import { applyOutcomeFeedback, type OutcomeRecord } from "../src/outcome.js";
import { findBullet, loadPlaybook, savePlaybook } from "../src/playbook.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

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
    },
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

const SHARED_OUTCOME_RULE = "b-shared-outcome";

function runGit(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function withOutcomeWorkspaces(run: (env: {
  home: string;
  launch: string;
  requested: string;
  launchPlaybook: string;
  requestedPlaybook: string;
  globalPlaybook: string;
}) => Promise<void>): Promise<void> {
  await withTempCassHome(async (env) => {
    const previousMemoryHome = process.env.CASS_MEMORY_HOME;
    const previousExitCode = process.exitCode;
    process.env.CASS_MEMORY_HOME = env.cassMemoryDir;
    try {
      const launch = path.join(env.home, "launch-project");
      const requested = path.join(env.home, "requested project");
      runGit("init", "--quiet", launch);
      runGit("init", "--quiet", requested);
      const launchPlaybook = path.join(launch, ".cass", "playbook.yaml");
      const requestedPlaybook = path.join(requested, ".cass", "playbook.yaml");
      await savePlaybook(createTestPlaybook([createTestBullet({
        id: SHARED_OUTCOME_RULE, content: "Run shared global migration checks",
      })]), env.playbookPath);
      for (const [target, content] of [
        [launchPlaybook, "Run alpha migration checks"],
        [requestedPlaybook, "Run beta migration checks"],
      ]) {
        await savePlaybook(createTestPlaybook([createTestBullet({
          id: SHARED_OUTCOME_RULE, content, scope: "workspace",
        })]), target);
      }
      await writeFile(env.configPath, JSON.stringify(createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        semanticSearchEnabled: false,
      })));
      await withCwd(launch, () => run({
        home: env.home, launch, requested, launchPlaybook, requestedPlaybook,
        globalPlaybook: env.playbookPath,
      }));
    } finally {
      process.exitCode = previousExitCode;
      if (previousMemoryHome === undefined) delete process.env.CASS_MEMORY_HOME;
      else process.env.CASS_MEMORY_HOME = previousMemoryHome;
    }
  }, "outcome-workspaces");
}

async function callOutcomeTool(args: Record<string, unknown>): Promise<OutcomeRecord> {
  const response = await serveTest.routeRequest({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cm_outcome", arguments: args },
  });
  expect("error" in response).toBe(false);
  if ("error" in response) throw new Error(response.error.message);
  return JSON.parse((response.result as any).content[0].text);
}

function runOutcomeCli(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([
    process.execPath, path.join(import.meta.dir, "..", "src", "cm.ts"), ...args, "--json",
  ], { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  return { result, payload: JSON.parse(result.stdout.toString()) };
}

async function feedbackCount(playbookPath: string): Promise<number> {
  return (await loadPlaybook(playbookPath)).bullets[0].helpfulCount;
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
              json: true,
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
              json: true,
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
            path: logPath,
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

describe("E2E: outcome workspace ownership", () => {
  it("MCP records the requested workspace without learning, and CLI replay updates only its rule", async () => {
    await withOutcomeWorkspaces(async ({ launch, requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      await writeFile(path.join(requested, ".cass", "config.json"), JSON.stringify({
        scoring: { minFeedbackForActive: 1, minHelpfulForProven: 1 },
        sanitization: { extraPatterns: ["WORKSPACE_B_SECRET"] },
      }));
      const context = await generateContextResult("Run beta migration checks", { workspace: requested, history: 0 });
      expect(context.result.relevantBullets.map(b => b.content)).toEqual(["Run beta migration checks"]);
      const record = await callOutcomeTool({
        sessionId: "requested-session", outcome: "success", rulesUsed: [SHARED_OUTCOME_RULE],
        workspace: path.relative(launch, requested), notes: "WORKSPACE_B_SECRET",
      });
      expect(record.workspace).toBe(requested);
      expect(record.path).toBe(path.join(requested, ".cass", "outcomes.jsonl"));
      expect(record.notes).not.toContain("WORKSPACE_B_SECRET");
      expect(await Bun.file(path.join(launch, ".cass", "outcomes.jsonl")).exists()).toBe(false);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(requestedPlaybook)).toBe(0);

      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", requested, "--session", "requested-session");
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(globalPlaybook)).toBe(0);
      const learned = (await loadPlaybook(requestedPlaybook)).bullets[0];
      expect(learned.helpfulCount).toBe(1);
      expect(learned.maturity).toBe("proven");
      const replay = await applyOutcomeFeedback(record, await loadConfig());
      expect(replay.applied).toBe(0);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
    });
  });

  it("the CLI records and applies a relative --workspace path containing spaces", async () => {
    await withOutcomeWorkspaces(async ({ launch, requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      const { result, payload } = runOutcomeCli(launch, "outcome", "success", SHARED_OUTCOME_RULE,
        "--workspace", path.relative(launch, requested), "--session", "cli-workspace");
      expect(result.exitCode).toBe(0);
      expect(payload.success).toBe(true);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(requestedPlaybook)).toBe(1);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(globalPlaybook)).toBe(0);
      const log = await readFile(path.join(requested, ".cass", "outcomes.jsonl"), "utf8");
      expect(JSON.parse(log).workspace).toBe(requested);
      const replay = runOutcomeCli(launch, "outcome-apply", "--workspace", requested);
      expect(replay.result.exitCode).toBe(0);
      expect(replay.payload.data.applied).toBe(0);
    });
  });

  it("legacy outcome logs use the requested workspace as their ownership fallback", async () => {
    await withOutcomeWorkspaces(async ({ launch, requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      const logPath = path.join(requested, ".cass", "outcomes.jsonl");
      await writeFile(logPath, JSON.stringify({
        sessionId: "legacy-workspace", outcome: "success", rulesUsed: [SHARED_OUTCOME_RULE],
        recordedAt: new Date().toISOString(), path: logPath,
      }) + "\n");
      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", requested);
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(requestedPlaybook)).toBe(1);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(globalPlaybook)).toBe(0);
      const replay = runOutcomeCli(requested, "outcome-apply");
      expect(replay.result.exitCode).toBe(0);
      expect(replay.payload.data.applied).toBe(0);
    });
  });

  it("missing rule IDs backfill from the requested context log when session IDs collide", async () => {
    await withOutcomeWorkspaces(async ({ launch, requested, launchPlaybook, requestedPlaybook }) => {
      await generateContextResult("Run alpha migration checks", {
        workspace: launch, logContext: true, session: "shared-session", history: 0,
      });
      await generateContextResult("Run beta migration checks", {
        workspace: requested, logContext: true, session: "shared-session", history: 0,
      });
      await callOutcomeTool({ sessionId: "shared-session", outcome: "success", workspace: requested });
      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", requested);
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(requestedPlaybook)).toBe(1);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
    });
  });

  it("linked worktrees store with the retrieved owner and a later local collision cannot redirect replay", async () => {
    await withOutcomeWorkspaces(async ({ home, launch, requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      runGit("-C", requested, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--allow-empty", "--quiet", "-m", "fixture");
      const linked = path.join(home, "linked-worktree");
      runGit("-C", requested, "worktree", "add", "--detach", "--quiet", linked);
      const record = await callOutcomeTool({
        sessionId: "linked-session", outcome: "success", rulesUsed: [SHARED_OUTCOME_RULE], workspace: linked,
      });
      expect(record.path).toBe(path.join(requested, ".cass", "outcomes.jsonl"));
      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", linked);
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(requestedPlaybook)).toBe(1);
      const linkedPlaybook = path.join(linked, ".cass", "playbook.yaml");
      await savePlaybook(createTestPlaybook([createTestBullet({
        id: SHARED_OUTCOME_RULE, content: "Run independent linked checkout checks", scope: "workspace",
      })]), linkedPlaybook);
      expect((await applyOutcomeFeedback(record, await loadConfig())).applied).toBe(0);
      expect(await feedbackCount(linkedPlaybook)).toBe(0);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(globalPlaybook)).toBe(0);
    });
  });

  it("a requested directory outside Git retains global ownership when replayed from a repository", async () => {
    await withOutcomeWorkspaces(async ({ home, launch, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      const plainWorkspace = path.join(home, "plain-workspace");
      await mkdir(plainWorkspace);
      const record = await callOutcomeTool({
        sessionId: "global-session", outcome: "success", rulesUsed: [SHARED_OUTCOME_RULE], workspace: plainWorkspace,
      });
      expect(record.workspace).toBe(plainWorkspace);
      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", plainWorkspace);
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(1);
      expect(await feedbackCount(globalPlaybook)).toBe(1);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(requestedPlaybook)).toBe(0);
      expect((await applyOutcomeFeedback(record, await loadConfig())).applied).toBe(0);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
    });
  });

  it("rejects invalid workspace values before writing logs or feedback", async () => {
    await withOutcomeWorkspaces(async ({ launch, requested, launchPlaybook, requestedPlaybook }) => {
      for (const workspace of ["", "   ", null, 42]) {
        const response = await serveTest.routeRequest({
          jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "cm_outcome", arguments: { sessionId: "invalid", outcome: "success", workspace },
          },
        });
        expect("error" in response).toBe(true);
        const capture = captureConsole();
        try {
          await outcomeCommand({ status: "success", rules: SHARED_OUTCOME_RULE, workspace: workspace as any, json: true });
          await applyOutcomeLogCommand({ workspace: workspace as any, json: true });
        } finally {
          capture.restore();
        }
        expect(capture.logs).toHaveLength(2);
        for (const output of capture.logs) {
          const payload = JSON.parse(output);
          expect(payload.success).toBe(false);
          expect(payload.error.code).toBe("INVALID_INPUT");
          expect(payload.error.message).toContain("workspace");
        }
      }
      expect(await Bun.file(path.join(launch, ".cass", "outcomes.jsonl")).exists()).toBe(false);
      expect(await Bun.file(path.join(requested, ".cass", "outcomes.jsonl")).exists()).toBe(false);
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(requestedPlaybook)).toBe(0);
    });
  });

  it("bulk replay applies each recorded workspace's scoring policy from a shared worktree log", async () => {
    await withOutcomeWorkspaces(async ({ home, launch, requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      runGit("-C", requested, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--allow-empty", "--quiet", "-m", "fixture");
      const linked = path.join(home, "policy-worktree");
      runGit("-C", requested, "worktree", "add", "--detach", "--quiet", linked);
      await savePlaybook(createTestPlaybook([
        createTestBullet({ id: "b-main-policy", content: "Use main checkout checks", scope: "workspace" }),
        createTestBullet({ id: "b-linked-policy", content: "Use linked checkout checks", scope: "workspace" }),
      ]), requestedPlaybook);
      await writeFile(path.join(requested, ".cass", "config.json"), JSON.stringify({
        scoring: { minFeedbackForActive: 3, minHelpfulForProven: 10 },
      }));
      await mkdir(path.join(linked, ".cass"));
      await writeFile(path.join(linked, ".cass", "config.json"), JSON.stringify({
        scoring: { minFeedbackForActive: 1, minHelpfulForProven: 1 },
      }));
      const mainRecord = await callOutcomeTool({
        sessionId: "shared-policy-session", outcome: "success", rulesUsed: ["b-main-policy"], workspace: requested,
      });
      const linkedRecord = await callOutcomeTool({
        sessionId: "shared-policy-session", outcome: "success", rulesUsed: ["b-linked-policy"], workspace: linked,
      });
      expect(linkedRecord.path).toBe(mainRecord.path);
      const { result, payload } = runOutcomeCli(launch, "outcome-apply", "--workspace", requested,
        "--session", "shared-policy-session");
      expect(result.exitCode).toBe(0);
      expect(payload.data.applied).toBe(2);
      const learned = await loadPlaybook(requestedPlaybook);
      expect(findBullet(learned, "b-main-policy")?.maturity).toBe("candidate");
      expect(findBullet(learned, "b-linked-policy")?.maturity).toBe("proven");
      expect(await feedbackCount(launchPlaybook)).toBe(0);
      expect(await feedbackCount(globalPlaybook)).toBe(0);
      const replay = runOutcomeCli(launch, "outcome-apply", "--workspace", requested);
      expect(replay.result.exitCode).toBe(0);
      expect(replay.payload.data.applied).toBe(0);
    });
  });

  it("a failed outcome log append produces a JSON error and never applies transient feedback", async () => {
    await withOutcomeWorkspaces(async ({ requested, launchPlaybook, requestedPlaybook, globalPlaybook }) => {
      await mkdir(path.join(requested, ".cass", "outcomes.jsonl"));
      const before = await Promise.all([launchPlaybook, requestedPlaybook, globalPlaybook].map(p => readFile(p, "utf8")));
      const { result, payload } = runOutcomeCli(requested, "outcome", "success", SHARED_OUTCOME_RULE);
      expect(result.exitCode).toBe(4); // FILE_WRITE_FAILED uses the filesystem exit category.
      expect(payload.success).toBe(false);
      expect(payload.error.code).toBe("FILE_WRITE_FAILED");
      const after = await Promise.all([launchPlaybook, requestedPlaybook, globalPlaybook].map(p => readFile(p, "utf8")));
      expect(after).toEqual(before);
    });
  });

  it("advertises the outcome workspace in the MCP tool schema", async () => {
    const response = await serveTest.routeRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect("error" in response).toBe(false);
    if ("error" in response) throw new Error(response.error.message);
    const tool = (response.result as any).tools.find((entry: any) => entry.name === "cm_outcome");
    expect(tool.inputSchema.properties.workspace.type).toBe("string");
  });
});
