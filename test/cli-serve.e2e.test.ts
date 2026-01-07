/**
 * E2E Tests for CLI serve command (MCP HTTP server).
 *
 * Covers:
 * - tools/list response without auth token
 * - auth required when MCP_HTTP_TOKEN is set
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import net from "node:net";
import { withTempCassHome } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

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
  token?: string
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
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

async function waitForServer(
  baseUrl: string,
  token?: string,
  timeoutMs = 4000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await postJson(
        baseUrl,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        token
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
  extraEnv: Record<string, string> = {}
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

  const proc = spawn("bun", ["run", "src/cm.ts", "serve", "--host", "127.0.0.1", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

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

          const unauthorized = await postJson(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list" });
          log.snapshot("unauthorized", unauthorized);
          expect(unauthorized.status).toBe(401);
          expect(unauthorized.payload?.error?.message).toBe("Unauthorized");

          const authorized = await postJson(
            baseUrl,
            { jsonrpc: "2.0", id: 2, method: "resources/list" },
            token
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
