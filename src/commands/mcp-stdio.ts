/**
 * MCP stdio transport — speaks the MCP protocol over stdin/stdout so Claude Code
 * can launch this as a native MCP server.
 *
 * Reuses the existing routeRequest() from serve.ts for all tool/resource handling.
 * This file only adds the stdio framing (newline-delimited JSON-RPC) and the
 * initialize/initialized handshake that the MCP spec requires.
 */

import { createInterface } from "node:readline";
import { __test } from "./serve.js";

const { routeRequest } = __test;

const SERVER_INFO = {
  name: "cass-memory",
  version: "0.1.0",
};

const SERVER_CAPABILITIES = {
  tools: {},
  resources: {},
};

function sendMessage(msg: object): void {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function handleInitialize(id: string | number | null): void {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: SERVER_CAPABILITIES,
    },
  });
}

async function handleMessage(line: string): Promise<void> {
  if (!line.trim()) return;

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    sendMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const method = parsed.method;
  const id = parsed.id ?? null;

  // MCP handshake
  if (method === "initialize") {
    handleInitialize(id);
    return;
  }

  // Notification — no response expected
  if (method === "initialized" || method === "notifications/initialized") {
    return;
  }

  // Keepalive
  if (method === "ping") {
    sendMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Delegate everything else (tools/list, tools/call, resources/list, resources/read)
  // to the existing handler from serve.ts
  const response = await routeRequest(parsed);
  sendMessage(response);
}

export async function mcpStdioCommand(): Promise<void> {
  // All log output must go to stderr so stdout stays clean for MCP protocol
  console.log = (...args: any[]) => process.stderr.write(args.join(" ") + "\n");
  console.warn = (...args: any[]) => process.stderr.write(args.join(" ") + "\n");
  console.error = (...args: any[]) => process.stderr.write(args.join(" ") + "\n");

  // Track pending async handlers so we don't exit before they complete
  const pending = new Set<Promise<void>>();
  let stdinClosed = false;

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const p = handleMessage(line).catch((err: any) => {
      process.stderr.write(`[mcp-stdio] Error: ${err?.message}\n`);
    });
    pending.add(p);
    p.finally(() => {
      pending.delete(p);
      if (stdinClosed && pending.size === 0) process.exit(0);
    });
  });

  rl.on("close", () => {
    stdinClosed = true;
    if (pending.size === 0) process.exit(0);
  });

  process.stderr.write("[mcp-stdio] MCP stdio server ready\n");
}
