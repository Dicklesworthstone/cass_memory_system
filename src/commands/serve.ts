import http from "node:http";
import { generateContextResult } from "./context.js";
import { recordFeedback } from "./mark.js";
import { recordOutcome } from "../outcome.js";
import { loadConfig } from "../config.js";
import { log, warn, error as logError } from "../utils.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: any }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: any } };

const TOOL_DEFS = [
  {
    name: "cm_context",
    description: "Get relevant rules and history for a task",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        workspace: { type: "string" },
        top: { type: "number" },
        history: { type: "number" },
        days: { type: "number" }
      },
      required: ["task"]
    }
  },
  {
    name: "cm_feedback",
    description: "Record helpful/harmful feedback for a rule",
    inputSchema: {
      type: "object",
      properties: {
        bulletId: { type: "string" },
        helpful: { type: "boolean" },
        harmful: { type: "boolean" },
        reason: { type: "string" },
        session: { type: "string" }
      },
      required: ["bulletId"]
    }
  },
  {
    name: "cm_outcome",
    description: "Record a session outcome with rules used",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        outcome: { type: "string", description: "success | failure | partial" },
        rulesUsed: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        task: { type: "string" },
        durationSec: { type: "number" }
      },
      required: ["sessionId", "outcome"]
    }
  }
];

async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case "cm_context": {
      if (!args?.task || typeof args.task !== "string") {
        throw new Error("cm_context requires 'task' (string)");
      }
      const context = await generateContextResult(args.task, {
        top: args?.top,
        history: args?.history,
        days: args?.days,
        workspace: args?.workspace,
        json: true
      });
      return context.result;
    }
    case "cm_feedback": {
      if (!args?.bulletId) {
        throw new Error("cm_feedback requires 'bulletId'");
      }
      const helpful = Boolean(args?.helpful);
      const harmful = Boolean(args?.harmful);
      if (!helpful && !harmful) {
        throw new Error("cm_feedback requires helpful or harmful to be set");
      }
      const result = await recordFeedback(args.bulletId, {
        helpful,
        harmful,
        reason: args?.reason,
        session: args?.session
      });
      return { success: true, ...result };
    }
    case "cm_outcome": {
      if (!args?.outcome) {
        throw new Error("cm_outcome requires 'outcome'");
      }
      if (!["success", "failure", "partial"].includes(args.outcome)) {
        throw new Error("outcome must be success | failure | partial");
      }
      if (!args?.sessionId || typeof args.sessionId !== "string") {
        throw new Error("cm_outcome requires 'sessionId'");
      }
      const config = await loadConfig();
      return recordOutcome({
        sessionId: args?.sessionId,
        outcome: args.outcome,
        rulesUsed: Array.isArray(args?.rulesUsed) ? args.rulesUsed : undefined,
        notes: typeof args?.notes === "string" ? args.notes : undefined,
        task: typeof args?.task === "string" ? args.task : undefined,
        durationSec: typeof args?.durationSec === "number" ? args.durationSec : undefined
      }, config);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildError(id: string | number | null, message: string, code = -32000, data?: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function routeRequest(body: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (body.method === "tools/list") {
    return { jsonrpc: "2.0", id: body.id ?? null, result: { tools: TOOL_DEFS } };
  }

  if (body.method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (!name) {
      return buildError(body.id ?? null, "Missing tool name", -32602);
    }

    try {
      const result = await handleToolCall(name, args);
      return { jsonrpc: "2.0", id: body.id ?? null, result };
    } catch (err: any) {
      return buildError(body.id ?? null, err?.message || "Tool call failed");
    }
  }

  return buildError(body.id ?? null, `Unsupported method: ${body.method}`, -32601);
}

export async function serveCommand(options: { port?: number; host?: string } = {}): Promise<void> {
  const port = options.port || Number(process.env.MCP_HTTP_PORT) || 3001;
  const host = options.host || process.env.MCP_HTTP_HOST || "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(raw) as JsonRpcRequest;
        const response = await routeRequest(parsed);
        res.setHeader("content-type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (err: any) {
        logError(err?.message || "Failed to process request");
        res.statusCode = 400;
        res.end(JSON.stringify(buildError(null, "Bad request", -32700)));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  log(`MCP HTTP server listening on http://${host}:${port}`, true);
  warn("Transport is HTTP-only; stdio/SSE are intentionally disabled.");
}
