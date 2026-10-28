/**
 * E2E Tests for CLI serve command (MCP HTTP server).
 *
 * Covers:
 * - tools/list response without auth token
 * - auth required when MCP_HTTP_TOKEN is set
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import yaml from "yaml";
import { CONFIG_INPUT_LIMITS, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { loadPlaybook } from "../src/playbook.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { type TestEnv, withTempCassHome } from "./helpers/temp.js";

type ServeProcess = {
  proc: ReturnType<typeof spawn>;
  baseUrl: string;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate a port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(
  baseUrl: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: res.status, payload };
}

async function waitForServer(baseUrl: string, token?: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await postJson(
        baseUrl,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        token,
      );
      if (result.status === 200) return;
    } catch {
      // keep trying until timeout
    }
    await sleep(100);
  }
  throw new Error("serve did not start in time");
}

async function startServeProcess(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<ServeProcess> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    MCP_HTTP_TOKEN: "",
    MCP_HTTP_UNSAFE_NO_TOKEN: "",
    ...extraEnv,
  };

  const proc = spawn(
    "bun",
    ["run", "src/cm.ts", "serve", "--host", "127.0.0.1", "--port", String(port)],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return { proc, baseUrl };
}

async function stopServeProcess(proc: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2000);

    proc.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.kill("SIGTERM");
  });
}

describe("E2E: CLI serve command", () => {
  it("returns tool list without auth token", async () => {
    const log = createE2ELogger("serve: tools list");
    log.setRepro("bun test test/cli-serve.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const { proc, baseUrl } = await startServeProcess(env.home);
        try {
          await waitForServer(baseUrl);
          const response = await postJson(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list" });
          log.snapshot("tools-list", response);

          expect(response.status).toBe(200);
          expect(response.payload.result?.tools?.length).toBeGreaterThan(0);
          const toolNames = response.payload.result.tools.map((t: any) => t.name);
          expect(toolNames).toContain("cm_context");
        } finally {
          await stopServeProcess(proc);
        }
      }, "serve-tools-list");
    });
  });

  it("requires auth when MCP_HTTP_TOKEN is set", async () => {
    const log = createE2ELogger("serve: auth token");
    log.setRepro("bun test test/cli-serve.e2e.test.ts");
    const token = "test-token-serve";

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const { proc, baseUrl } = await startServeProcess(env.home, { MCP_HTTP_TOKEN: token });
        try {
          await waitForServer(baseUrl, token);

          const unauthorized = await postJson(baseUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          });
          log.snapshot("unauthorized", unauthorized);
          expect(unauthorized.status).toBe(401);
          expect(unauthorized.payload?.error?.message).toBe("Unauthorized");

          const authorized = await postJson(
            baseUrl,
            { jsonrpc: "2.0", id: 2, method: "resources/list" },
            token,
          );
          log.snapshot("authorized", authorized);
          expect(authorized.status).toBe(200);
          expect(authorized.payload.result?.resources?.length).toBeGreaterThan(0);
        } finally {
          await stopServeProcess(proc);
        }
      }, "serve-auth-token");
    });
  });
});

describe("E2E: MCP reflection failure results (#99)", () => {
  const rule = "Inspect both the tool error flag and partial results after a failed reflection.";
  const reflectionEnv = {
    CASS_MEMORY_LLM: "none",
    CM_REFLECTOR_STUBS: JSON.stringify([{
      deltas: [{ type: "add", bullet: { content: rule, category: "testing" }, reason: "session evidence" }],
    }]),
  };

  async function setup(env: TestEnv, sessions: string[] = []) {
    const cassPath = path.join(env.home, "cass-fixture");
    const timeline = JSON.stringify({ groups: [{ date: "2026-10-28", sessions: sessions.map(sessionPath => ({
      path: sessionPath, agent: "claude",
    })) }] });
    await writeFile(cassPath, `#!${process.execPath}
if (process.argv[2] === "timeline") console.log(${JSON.stringify(timeline)});
else if (process.argv[2] === "export") process.exit(1);
else console.log("[]");
`, { mode: 0o755 });
    await writeFile(env.configPath, JSON.stringify(createTestConfig({
      cassPath,
      playbookPath: env.playbookPath,
      diaryDir: env.diaryDir,
      validationEnabled: false,
      semanticSearchEnabled: false,
      maxReflectorIterations: 1,
    })));
    await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook()));
  }

  async function writeSession(env: TestEnv) {
    const session = path.join(env.home, "good-session.jsonl");
    await writeFile(session, [
      { role: "user", content: "The reflection job failed but its tool response still looked successful." },
      { role: "assistant", content: "Inspect the MCP error flag and retain successful session results while retrying the failures." },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    return session;
  }

  function reflectionPayload(response: { status: number; payload: any }, failed: boolean) {
    expect(response.status).toBe(200);
    expect(response.payload.jsonrpc).toBe("2.0");
    expect(response.payload.error).toBeUndefined();
    const result = response.payload.result;
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toEqual(payload);
    expect(payload.success).toBe(!failed);
    expect(payload.globalResult?.playbook).toBeUndefined();
    expect(payload.repoResult?.playbook).toBeUndefined();
    for (const project of payload.projectResults ?? []) {
      expect(project.result.playbook).toBeUndefined();
    }
    if (failed) {
      expect(result.isError).toBe(true);
      expect(payload.error.code).toBe("REFLECTION_FAILED");
      expect(payload.errors.length).toBeGreaterThan(0);
    } else {
      expect(result.isError).toBeUndefined();
      expect(payload.error).toBeUndefined();
      expect(payload.errors).toEqual([]);
    }
    return payload;
  }

  for (const dryRun of [false, true]) {
    it(`retains uncommitted proposals from a later reflector failure${dryRun ? " in dry-run" : ""}`, async () => {
      await withTempCassHome(async env => {
        await setup(env);
        const session = await writeSession(env);
        const cliPath = path.join(env.home, "fixture-llm");
        const proposal = {
          type: "add",
          bullet: {
            content: rule, category: "testing", kind: null, type: null, isNegative: null,
            scope: null, scopeKey: null, workspace: null, searchPointer: null, tags: null,
          },
          reason: "The session exposed false success in a reflection job.", sourceSession: null,
        };
        // Run the real multi-pass loop via the supported CLI provider.
        await writeFile(cliPath, `#!${process.execPath}
const prompt = await Bun.stdin.text();
if (prompt.includes("extract reusable lessons for a playbook")) {
  if (prompt.includes("This is iteration 2.")) {
    console.error("invalid_api_key: fixture rejected the second reflection pass");
    process.exit(1);
  }
  console.log(${JSON.stringify(JSON.stringify({ deltas: [proposal] }))});
} else console.log(${JSON.stringify(JSON.stringify({
          status: "success", accomplishments: ["Investigated reflection failure reporting"],
          decisions: [], challenges: [], preferences: [],
          keyLearnings: ["Check session errors before declaring a reflection successful"], tags: ["testing"],
        }))});
`, { mode: 0o755 });
        const config = JSON.parse(await readFile(env.configPath, "utf8"));
        await writeFile(env.configPath, JSON.stringify({
          ...config, provider: "cli", cliCommand: cliPath, maxReflectorIterations: 3,
        }));
        const original = await readFile(env.playbookPath, "utf8");
        const { proc, baseUrl } = await startServeProcess(env.home, {
          CASS_MEMORY_LLM: "", CM_REFLECTOR_STUBS: "", CASS_CLI_COMMAND: cliPath,
        });
        try {
          await waitForServer(baseUrl);
          const response = await postJson(baseUrl, {
            jsonrpc: "2.0", id: 90, method: "tools/call",
            params: { name: "memory_reflect", arguments: { session, dryRun } },
          });
          const payload = reflectionPayload(response, true);
          expect(payload.sessionsProcessed).toBe(0);
          expect(payload.deltasGenerated).toBe(0);
          expect(payload.deltasApplied).toBe(0);
          expect(payload.failedSessions).toEqual([{
            sessionPath: session,
            error: expect.stringContaining("fixture rejected the second reflection pass"),
            proposedDeltas: [expect.objectContaining({
              type: "add", sourceSession: session, reason: proposal.reason,
              bullet: expect.objectContaining({ content: rule, category: "testing" }),
            })],
          }]);
          if (dryRun) expect(payload.proposedDeltas).toEqual([]);
          expect(await readFile(env.playbookPath, "utf8")).toBe(original);
          const log = new ProcessedLog(getProcessedLogPath());
          await log.load();
          expect(log.has(session)).toBe(false);
          if (dryRun) expect(log.get(session)).toBeUndefined();
          else expect(log.get(session)).toMatchObject({ status: "failed", failures: 1 });
        } finally {
          await stopServeProcess(proc);
        }
      });
    });

    it(`returns an in-band error for an oversized playbook${dryRun ? " in dry-run" : ""} and keeps the server usable`, async () => {
      await withTempCassHome(async env => {
        await setup(env);
        const session = await writeSession(env);
        const source = await open(env.playbookPath, "r+");
        await source.truncate(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
        await source.close();
        const original = await readFile(env.playbookPath);
        const { proc, baseUrl } = await startServeProcess(env.home, reflectionEnv);
        try {
          await waitForServer(baseUrl);
          const response = await postJson(baseUrl, {
            jsonrpc: "2.0", id: 100, method: "tools/call",
            params: { name: "memory_reflect", arguments: { session, dryRun } },
          });
          const payload = reflectionPayload(response, true);
          expect(payload.sessionsProcessed).toBe(0);
          expect(payload.deltasGenerated).toBe(0);
          expect(payload.deltasApplied).toBe(0);
          expect(payload.errors[0]).toContain("Input limit exceeded");
          expect(payload.errors[0]).toContain(env.playbookPath);
          expect((await stat(env.playbookPath)).size).toBe(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
          expect((await readFile(env.playbookPath)).equals(original)).toBe(true);
          const log = new ProcessedLog(getProcessedLogPath());
          await log.load();
          expect(log.has(session)).toBe(false);
          const ping = await postJson(baseUrl, { jsonrpc: "2.0", id: 101, method: "ping" });
          expect(ping.payload).toEqual({ jsonrpc: "2.0", id: 101, result: {} });
        } finally {
          await stopServeProcess(proc);
        }
      });
    });

    it(`retains successful results while flagging a mixed reflection failure${dryRun ? " in dry-run" : ""}`, async () => {
      await withTempCassHome(async env => {
        const session = await writeSession(env);
        const missing = path.join(env.home, "missing-session.jsonl");
        await setup(env, [missing, session]);
        const privateContent = "UNRELATED_PRIVATE_ARCHIVE_POLICY: " + "Keep archived records accessible. ".repeat(4096);
        await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook([
          createTestBullet({ id: "b-private-archive", content: privateContent, pinned: true }),
        ])));
        const original = await readFile(env.playbookPath, "utf8");
        const { proc, baseUrl } = await startServeProcess(env.home, reflectionEnv);
        try {
          await waitForServer(baseUrl);
          const response = await postJson(baseUrl, {
            jsonrpc: "2.0", id: 110, method: "tools/call",
            params: { name: "memory_reflect", arguments: { dryRun } },
          });
          const payload = reflectionPayload(response, true);
          expect(payload.sessionsProcessed).toBe(1);
          expect(payload.deltasGenerated).toBe(1);
          expect(payload.errors).toHaveLength(1);
          expect(payload.errors[0]).toContain(missing);
          expect(JSON.stringify(response.payload)).not.toContain("UNRELATED_PRIVATE_ARCHIVE_POLICY");
          expect(JSON.stringify(response.payload).length).toBeLessThan(16 * 1024);
          const log = new ProcessedLog(getProcessedLogPath());
          await log.load();
          if (dryRun) {
            expect(payload.deltasApplied).toBe(0);
            expect(payload.dryRun).toBe(true);
            expect(payload.proposedDeltas).toHaveLength(1);
            expect(payload.proposedDeltas[0].content).toBe(rule);
            expect(await readFile(env.playbookPath, "utf8")).toBe(original);
            expect(log.get(session)).toBeUndefined();
            expect(log.get(missing)).toBeUndefined();
          } else {
            expect(payload.deltasApplied).toBe(1);
            expect(payload.globalResult.applied).toBe(1);
            expect(payload.globalResult.skipped).toBe(0);
            expect(payload.globalResult.pruned).toBe(0);
            expect(payload.globalResult.conflicts).toEqual([]);
            expect(payload.globalResult.promotions).toEqual([]);
            expect(payload.globalResult.inversions).toEqual([]);
            expect(payload.globalResult.decisionLog).toContainEqual(expect.objectContaining({
              phase: "add", action: "accepted", content: rule,
            }));
            const saved = await loadPlaybook(env.playbookPath);
            expect(saved.bullets.map(bullet => bullet.content)).toContain(rule);
            expect(saved.bullets.find(bullet => bullet.id === "b-private-archive")?.content).toBe(privateContent);
            expect(saved.metadata.totalSessionsProcessed).toBe(1);
            expect(saved.metadata.totalReflections).toBe(1);
            expect(log.has(session)).toBe(true);
            expect(log.has(missing)).toBe(false);
            expect(log.get(missing)).toMatchObject({ status: "failed", failures: 1 });

            const rerun = await postJson(baseUrl, {
              jsonrpc: "2.0", id: 111, method: "tools/call",
              params: { name: "memory_reflect", arguments: { session } },
            });
            expect(reflectionPayload(rerun, false).sessionsProcessed).toBe(0);
            expect((await loadPlaybook(env.playbookPath)).metadata.totalSessionsProcessed).toBe(1);
          }
        } finally {
          await stopServeProcess(proc);
        }
      });
    });
  }

  it("keeps successful reflection successful with machine-readable results", async () => {
    await withTempCassHome(async env => {
      await setup(env);
      const session = await writeSession(env);
      const { proc, baseUrl } = await startServeProcess(env.home, reflectionEnv);
      try {
        await waitForServer(baseUrl);
        const response = await postJson(baseUrl, {
          jsonrpc: "2.0", id: 120, method: "tools/call",
          params: { name: "memory_reflect", arguments: { session } },
        });
        const payload = reflectionPayload(response, false);
        expect(payload.sessionsProcessed).toBe(1);
        expect(payload.deltasApplied).toBe(1);
        expect(payload.globalResult.applied).toBe(1);
        expect((await loadPlaybook(env.playbookPath)).bullets[0].content).toBe(rule);
      } finally {
        await stopServeProcess(proc);
      }
    });
  });

  it("distinguishes execution errors from invalid protocol arguments without inventing partial counts", async () => {
    await withTempCassHome(async env => {
      await setup(env);
      const { proc, baseUrl } = await startServeProcess(env.home, reflectionEnv);
      try {
        await waitForServer(baseUrl);
        const invalid = await postJson(baseUrl, {
          jsonrpc: "2.0", id: 130, method: "tools/call",
          params: { name: "memory_reflect", arguments: { days: -1 } },
        });
        expect(invalid.payload.error.message).toContain("days");
        expect(invalid.payload.result).toBeUndefined();

        const oversizedConfig = " ".repeat(CONFIG_INPUT_LIMITS.maxBytes + 1);
        await writeFile(env.configPath, oversizedConfig);
        const failed = await postJson(baseUrl, {
          jsonrpc: "2.0", id: 131, method: "tools/call",
          params: { name: "memory_reflect", arguments: {} },
        });
        const payload = reflectionPayload(failed, true);
        expect(payload.errors[0]).toContain("Input limit exceeded");
        expect(payload.errors[0]).toContain(env.configPath);
        expect(payload.sessionsProcessed).toBeUndefined();
        expect(payload.deltasApplied).toBeUndefined();
        expect(await readFile(env.configPath, "utf8")).toBe(oversizedConfig);
      } finally {
        await stopServeProcess(proc);
      }
    });
  });
});
