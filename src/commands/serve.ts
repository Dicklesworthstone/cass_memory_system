import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { generateContextResult } from "./context.js";
import { recordFeedback } from "./mark.js";
import { recordOutcome, loadOutcomes } from "../outcome.js";
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { loadAllDiaries } from "../diary.js";
import { safeCassSearch } from "../cass.js";
import {
  log,
  warn,
  error as logError,
  reportError,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
} from "../utils.js";
import { analyzeScoreDistribution, getEffectiveScore, isStale } from "../scoring.js";
import { ErrorCode, type PlaybookBullet } from "../types.js";

// Simple per-tool argument validation helper to reduce drift.
function assertArgs(args: any, required: Record<string, string>) {
  if (!args) throw new Error("missing arguments");
  for (const [key, type] of Object.entries(required)) {
    const ok =
      type === "array"
        ? Array.isArray(args[key])
        : typeof args[key] === type;
    if (!ok) {
      throw new Error(`invalid or missing '${key}' (expected ${type})`);
    }
  }
}

function maybeProfile(label: string, start: number) {
  if (process.env.MCP_PROFILING !== "1") return;
  const durMs = (performance.now() - start).toFixed(1);
  log(`[mcp] ${label} took ${durMs}ms`, true);
}

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
        limit: { type: "integer", minimum: 1, description: "Max rules to return" },
        top: { type: "integer", minimum: 1, description: "DEPRECATED: use limit" },
        history: { type: "integer", minimum: 1 },
        days: { type: "integer", minimum: 1 }
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
        outcome: { type: "string", description: "success | failure | mixed | partial" },
        rulesUsed: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        task: { type: "string" },
        durationSec: { type: "integer", minimum: 0 }
      },
      required: ["sessionId", "outcome"]
    }
  },
  {
    name: "memory_search",
    description: "Search playbook bullets and/or cass history",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        scope: { type: "string", enum: ["playbook", "cass", "both"], default: "both" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        days: { type: "integer", minimum: 1, description: "Limit cass search to lookback days" },
        agent: { type: "string", description: "Filter cass search by agent" },
        workspace: { type: "string", description: "Filter cass search by workspace" }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_reflect",
    description: "Trigger reflection on recent sessions to extract insights",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, description: "Look back this many days for sessions", default: 7 },
        maxSessions: { type: "integer", minimum: 1, maximum: 200, description: "Maximum sessions to process", default: 20 },
        dryRun: { type: "boolean", description: "If true, return proposed changes without applying", default: false },
        workspace: { type: "string", description: "Workspace path to limit session search" },
        session: { type: "string", description: "Specific session path to reflect on" }
      }
    }
  }
];

const RESOURCE_DEFS = [
  {
    uri: "cm://playbook",
    description: "Merged playbook (global + repo)"
  },
  {
    uri: "cm://diary",
    description: "Recent diary entries"
  },
  {
    uri: "cm://outcomes",
    description: "Recent recorded outcomes"
  },
  {
    uri: "cm://stats",
    name: "Playbook Stats",
    description: "Playbook health metrics",
    mimeType: "application/json"
  },
  {
    uri: "memory://stats",
    name: "Playbook Stats (alias)",
    description: "Playbook health metrics",
    mimeType: "application/json"
  }
];

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB guard to avoid runaway payloads
const MCP_HTTP_TOKEN_ENV = "MCP_HTTP_TOKEN";
const MCP_HTTP_UNSAFE_NO_TOKEN_ENV = "MCP_HTTP_UNSAFE_NO_TOKEN";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized.startsWith("127.")) return true;
  return false;
}

function getMcpHttpToken(): string | undefined {
  const raw = (process.env[MCP_HTTP_TOKEN_ENV] ?? "").trim();
  return raw ? raw : undefined;
}

function headerValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function computePlaybookStats(playbook: any, config: any) {
  const bullets: PlaybookBullet[] = playbook?.bullets || [];
  const active = getActiveBullets(playbook);

  const distribution = analyzeScoreDistribution(active, config);
  const total = bullets.length;
  const byScope = countBy(bullets, (b) => b.scope ?? "unknown");
  const byState = countBy(bullets, (b) => b.state ?? "unknown");
  const byKind = countBy(bullets, (b) => b.kind ?? "unknown");

  // Health metrics should align with scoreDistribution (active bullets only).
  const scores = active.map((b) => ({
    bullet: b,
    score: getEffectiveScore(b, config),
  }));

  const topPerformers = scores
    .filter((s) => Number.isFinite(s.score))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map(({ bullet, score }) => ({
      id: bullet.id,
      content: bullet.content,
      score,
      helpfulCount: bullet.helpfulCount || 0,
    }));

  const atRiskCount = scores.filter((s) => (s.score ?? 0) < 0).length;
  const staleCount = active.filter((b) => isStale(b, 90)).length;

  return {
    total,
    byScope,
    byState,
    byKind,
    scoreDistribution: distribution,
    topPerformers,
    atRiskCount,
    staleCount,
    generatedAt: new Date().toISOString(),
  };
}

export { computePlaybookStats };

async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case "cm_context": {
      assertArgs(args, { task: "string" });
      const taskCheck = validateNonEmptyString(args?.task, "task", { trim: true });
      if (!taskCheck.ok) throw new Error(taskCheck.message);
      const limit = validatePositiveInt(args?.limit, "limit", { min: 1, allowUndefined: true });
      if (!limit.ok) throw new Error(limit.message);
      const top = validatePositiveInt(args?.top, "top", { min: 1, allowUndefined: true });
      if (!top.ok) throw new Error(top.message);
      const history = validatePositiveInt(args?.history, "history", { min: 1, allowUndefined: true });
      if (!history.ok) throw new Error(history.message);
      const days = validatePositiveInt(args?.days, "days", { min: 1, allowUndefined: true });
      if (!days.ok) throw new Error(days.message);
      const workspace = validateNonEmptyString(args?.workspace, "workspace", { allowUndefined: true });
      if (!workspace.ok) throw new Error(workspace.message);

      const context = await generateContextResult(taskCheck.value, {
        limit: limit.value ?? top.value,
        history: history.value,
        days: days.value,
        workspace: workspace.value,
        json: true
      });
      return context.result;
    }
    case "cm_feedback": {
      assertArgs(args, { bulletId: "string" });
      const helpful = Boolean(args?.helpful);
      const harmful = Boolean(args?.harmful);
      if (helpful === harmful) {
        throw new Error("cm_feedback requires exactly one of helpful or harmful to be set");
      }
      const reason = validateNonEmptyString(args?.reason, "reason", { allowUndefined: true, trim: false });
      if (!reason.ok) throw new Error(reason.message);
      const session = validateNonEmptyString(args?.session, "session", { allowUndefined: true });
      if (!session.ok) throw new Error(session.message);
      const result = await recordFeedback(args.bulletId, {
        helpful,
        harmful,
        reason: reason.value,
        session: session.value
      });
      return { success: true, ...result };
    }
    case "cm_outcome": {
      assertArgs(args, { outcome: "string", sessionId: "string" });
      if (!["success", "failure", "mixed", "partial"].includes(args.outcome)) {
        throw new Error("outcome must be success | failure | mixed | partial");
      }
      const rulesUsed =
        Array.isArray(args?.rulesUsed)
          ? args.rulesUsed
              .filter((r: unknown): r is string => typeof r === "string" && r.trim().length > 0)
              .map((r: string) => r.trim())
          : undefined;
      const durationSec = validatePositiveInt(args?.durationSec, "durationSec", { min: 0, allowUndefined: true });
      if (!durationSec.ok) throw new Error(durationSec.message);
      const config = await loadConfig();
      return recordOutcome({
        sessionId: args?.sessionId,
        outcome: args.outcome,
        rulesUsed,
        notes: typeof args?.notes === "string" ? args.notes : undefined,
        task: typeof args?.task === "string" ? args.task : undefined,
        durationSec: durationSec.value
      }, config);
    }
    case "memory_search": {
      assertArgs(args, { query: "string" });
      const queryCheck = validateNonEmptyString(args?.query, "query", { trim: true });
      if (!queryCheck.ok) throw new Error(queryCheck.message);
      const scopeCheck = validateOneOf(args.scope, "scope", ["playbook", "cass", "both"] as const, {
        allowUndefined: true,
        caseInsensitive: true,
      });
      if (!scopeCheck.ok) throw new Error(scopeCheck.message);
      const scope: "playbook" | "cass" | "both" = scopeCheck.value ?? "both";

      const limitCheck = validatePositiveInt(args?.limit, "limit", { min: 1, max: 100, allowUndefined: true });
      if (!limitCheck.ok) throw new Error(limitCheck.message);
      const limit = limitCheck.value ?? 10;

      const daysCheck = validatePositiveInt(args?.days, "days", { min: 1, allowUndefined: true });
      if (!daysCheck.ok) throw new Error(daysCheck.message);
      const days = daysCheck.value;

      const agentCheck = validateNonEmptyString(args?.agent, "agent", { allowUndefined: true });
      if (!agentCheck.ok) throw new Error(agentCheck.message);
      const agent = agentCheck.value;

      const workspaceCheck = validateNonEmptyString(args?.workspace, "workspace", { allowUndefined: true });
      if (!workspaceCheck.ok) throw new Error(workspaceCheck.message);
      const workspace = workspaceCheck.value;
      const config = await loadConfig();

      const result: { playbook?: any[]; cass?: any[] } = {};
      const q = queryCheck.value.toLowerCase();

      if (scope === "playbook" || scope === "both") {
        const t0 = performance.now();
        const playbook = await loadMergedPlaybook(config);
        const bullets = getActiveBullets(playbook);
        result.playbook = bullets
          .filter((b) => {
            const haystack = `${b.content} ${b.category ?? ""} ${b.scope ?? ""}`.toLowerCase();
            return haystack.includes(q);
          })
          .slice(0, limit)
          .map((b) => ({
            id: b.id,
            content: b.content,
            category: b.category,
            scope: b.scope,
            maturity: b.maturity,
          }));
        maybeProfile("memory_search playbook scan", t0);
      }

      if (scope === "cass" || scope === "both") {
        const t0 = performance.now();
        const hits = await safeCassSearch(queryCheck.value, { limit, days, agent, workspace }, config.cassPath, config);
        maybeProfile("memory_search cass search", t0);
        result.cass = hits.map((h) => ({
          path: h.source_path,
          agent: h.agent,
          score: h.score,
          snippet: h.snippet,
          timestamp: h.timestamp,
        }));
      }

      return result;
    }
    case "memory_reflect": {
      const t0 = performance.now();
      const config = await loadConfig();

      const daysCheck = validatePositiveInt(args?.days, "days", { min: 1, allowUndefined: true });
      if (!daysCheck.ok) throw new Error(daysCheck.message);
      const maxSessionsCheck = validatePositiveInt(args?.maxSessions, "maxSessions", { min: 1, max: 200, allowUndefined: true });
      if (!maxSessionsCheck.ok) throw new Error(maxSessionsCheck.message);
      const days = daysCheck.value ?? 7;
      const maxSessions = maxSessionsCheck.value ?? 20;
      const dryRun = Boolean(args?.dryRun);
      const workspaceCheck = validateNonEmptyString(args?.workspace, "workspace", { allowUndefined: true });
      if (!workspaceCheck.ok) throw new Error(workspaceCheck.message);
      const sessionCheck = validateNonEmptyString(args?.session, "session", { allowUndefined: true });
      if (!sessionCheck.ok) throw new Error(sessionCheck.message);
      const workspace = workspaceCheck.value;
      const session = sessionCheck.value;

      // Delegate to orchestrator
      const outcome = await import("../orchestrator.js").then(m => m.orchestrateReflection(config, {
        days,
        maxSessions,
        dryRun,
        workspace,
        session
      }));

      // Construct response
      if (outcome.errors.length > 0) {
        // If no sessions processed but errors occurred, treat as error
        if (outcome.sessionsProcessed === 0) {
           throw new Error(`Reflection failed: ${outcome.errors.join("; ")}`);
        }
        // Otherwise, just log them (partial success)
        logError(`Reflection partial errors: ${outcome.errors.join("; ")}`);
      }

      if (dryRun) {
        const deltas = outcome.dryRunDeltas || [];
        return {
          sessionsProcessed: outcome.sessionsProcessed,
          deltasGenerated: outcome.deltasGenerated,
          deltasApplied: 0,
          dryRun: true,
          proposedDeltas: deltas.map(d => {
            const base = { type: d.type };
            if (d.type === "add") {
              return { ...base, content: d.bullet.content, category: d.bullet.category, reason: d.reason };
            }
            if (d.type === "replace") {
              return { ...base, bulletId: d.bulletId, newContent: d.newContent, reason: d.reason };
            }
            if (d.type === "merge") {
              return { ...base, bulletIds: d.bulletIds, mergedContent: d.mergedContent, reason: d.reason };
            }
            if (d.type === "deprecate") {
              return { ...base, bulletId: d.bulletId, reason: d.reason };
            }
            // helpful/harmful
            if ("bulletId" in d) {
              return { ...base, bulletId: d.bulletId, ...("reason" in d ? { reason: d.reason } : {}) };
            }
            return base;
          }),
          message: `Would apply ${outcome.deltasGenerated} changes from ${outcome.sessionsProcessed} sessions`
        };
      }

      const applied = (outcome.globalResult?.applied || 0) + (outcome.repoResult?.applied || 0);
      const skipped = (outcome.globalResult?.skipped || 0) + (outcome.repoResult?.skipped || 0);
      const inversions = (outcome.globalResult?.inversions?.length || 0) + (outcome.repoResult?.inversions?.length || 0);

      maybeProfile("memory_reflect", t0);

      return {
        sessionsProcessed: outcome.sessionsProcessed,
        deltasGenerated: outcome.deltasGenerated,
        deltasApplied: applied,
        skipped,
        inversions,
        message: outcome.deltasGenerated > 0
          ? `Applied ${applied} changes from ${outcome.sessionsProcessed} sessions`
          : "No new insights found"
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildError(id: string | number | null, message: string, code = -32000, data?: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function handleResourceRead(uri: string): Promise<any> {
  const config = await loadConfig();
  switch (uri) {
    case "cm://playbook": {
      const playbook = await loadMergedPlaybook(config);
      return { uri, mimeType: "application/json", data: playbook };
    }
    case "cm://diary": {
      const diaries = await loadAllDiaries(config.diaryDir);
      return { uri, mimeType: "application/json", data: diaries.slice(0, 50) };
    }
    case "cm://outcomes": {
      const outcomes = await loadOutcomes(config, 50);
      return { uri, mimeType: "application/json", data: outcomes };
    }
    case "cm://stats":
    case "memory://stats": {
      const playbook = await loadMergedPlaybook(config);
      const stats = computePlaybookStats(playbook, config);
      return { uri, mimeType: "application/json", data: stats };
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
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

  if (body.method === "resources/list") {
    return { jsonrpc: "2.0", id: body.id ?? null, result: { resources: RESOURCE_DEFS } };
  }

  if (body.method === "resources/read") {
    const uri = body.params?.uri;
    if (!uri) return buildError(body.id ?? null, "Missing resource uri", -32602);
    try {
      const result = await handleResourceRead(uri);
      return { jsonrpc: "2.0", id: body.id ?? null, result };
    } catch (err: any) {
      return buildError(body.id ?? null, err?.message || "Resource read failed");
    }
  }

  return buildError(body.id ?? null, `Unsupported method: ${body.method}`, -32601);
}

// Internal exports for unit tests (kept small to avoid expanding public API surface).
export const __test = {
  buildError,
  routeRequest,
  isLoopbackHost,
  headerValue,
  extractBearerToken,
};

export async function serveCommand(options: { port?: number; host?: string } = {}): Promise<void> {
  const startedAtMs = Date.now();
  const command = "serve";

  const portFromArgs = validatePositiveInt(options.port, "port", { min: 1, max: 65535, allowUndefined: true });
  if (!portFromArgs.ok) {
    reportError(portFromArgs.message, {
      code: ErrorCode.INVALID_INPUT,
      details: portFromArgs.details,
      hint: `Example: cm serve --port 8765`,
      command,
      startedAtMs,
    });
    return;
  }

  const portFromEnv = validatePositiveInt(process.env.MCP_HTTP_PORT, "MCP_HTTP_PORT", {
    min: 1,
    max: 65535,
    allowUndefined: true,
  });
  if (!portFromEnv.ok) {
    reportError(portFromEnv.message, {
      code: ErrorCode.INVALID_INPUT,
      details: portFromEnv.details,
      hint: `Unset MCP_HTTP_PORT or set it to an integer 1-65535`,
      command,
      startedAtMs,
    });
    return;
  }

  const port = portFromArgs.value ?? portFromEnv.value ?? 8765;
  // Default strictly to localhost loopback for security
  const hostFromArgs = validateNonEmptyString(options.host, "host", { allowUndefined: true });
  if (!hostFromArgs.ok) {
    reportError(hostFromArgs.message, {
      code: ErrorCode.INVALID_INPUT,
      details: hostFromArgs.details,
      hint: `Example: cm serve --host 127.0.0.1 --port ${port}`,
      command,
      startedAtMs,
    });
    return;
  }
  const hostFromEnv = validateNonEmptyString(process.env.MCP_HTTP_HOST, "MCP_HTTP_HOST", { allowUndefined: true });
  if (!hostFromEnv.ok) {
    reportError(hostFromEnv.message, {
      code: ErrorCode.INVALID_INPUT,
      details: hostFromEnv.details,
      hint: `Unset MCP_HTTP_HOST or set it to a valid hostname/IP`,
      command,
      startedAtMs,
    });
    return;
  }
  const host = hostFromArgs.value ?? hostFromEnv.value ?? "127.0.0.1";
  const token = getMcpHttpToken();
  const allowInsecureNoToken = process.env[MCP_HTTP_UNSAFE_NO_TOKEN_ENV] === "1";
  const loopback = isLoopbackHost(host);

  if (!loopback && !token && !allowInsecureNoToken) {
    reportError(
      `Refusing to bind MCP HTTP server to '${host}' without auth. Set ${MCP_HTTP_TOKEN_ENV} or use --host 127.0.0.1.`,
      {
        code: ErrorCode.INVALID_INPUT,
        details: { host, tokenEnv: MCP_HTTP_TOKEN_ENV, overrideEnv: MCP_HTTP_UNSAFE_NO_TOKEN_ENV },
        hint: `Example: ${MCP_HTTP_TOKEN_ENV}='<random>' cm serve --host ${host} --port ${port}`,
        command,
        startedAtMs,
      }
    );
    return;
  }

  if (!loopback && !token && allowInsecureNoToken) {
    warn(
      `Warning: ${MCP_HTTP_UNSAFE_NO_TOKEN_ENV}=1 disables auth while binding to '${host}'. This exposes your playbook/diary/history to the network.`
    );
  } else if (host === "0.0.0.0" && process.env.NODE_ENV !== "development") {
    warn("Warning: Binding to 0.0.0.0 exposes the server to the network. Ensure this is intended.");
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    if (token) {
      const authHeader = headerValue(req.headers.authorization);
      const bearer = extractBearerToken(authHeader);
      const xToken = headerValue(req.headers["x-mcp-token"]);
      const provided = bearer ?? (xToken ? xToken.trim() : undefined);

      if (!provided || !tokensMatch(provided, token)) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(buildError(null, "Unauthorized", -32001)));
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(buildError(null, "Payload too large", -32600)));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", async () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(raw) as JsonRpcRequest;
        const response = await routeRequest(parsed);
        res.setHeader("content-type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (err: any) {
        logError(err?.message || "Failed to process request");
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(buildError(null, "Bad request", -32700)));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const baseUrl = `http://${host}:${port}`;
  log(`MCP HTTP server listening on ${baseUrl}`, true);
  if (token) {
    log(`Auth enabled via ${MCP_HTTP_TOKEN_ENV} (send: Authorization: Bearer <token> or X-MCP-Token)`, true);
  }
  warn("Transport is HTTP-only; stdio/SSE are intentionally disabled.");
  log(`Tools: ${TOOL_DEFS.map((t) => t.name).join(", ")}`, true);
  log(`Resources: ${RESOURCE_DEFS.map((r) => r.uri).join(", ")}`, true);
  log("Example (list tools):", true);
  const authHeaderExample = token ? ` -H "authorization: Bearer <token>"` : "";
  log(
    `  curl -sS -X POST ${baseUrl} -H "content-type: application/json"${authHeaderExample} -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    true
  );
  log("Example (call cm_context):", true);
  log(
    `  curl -sS -X POST ${baseUrl} -H "content-type: application/json"${authHeaderExample} -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cm_context","arguments":{"task":"fix auth timeout","limit":5,"history":3}}}'`,
    true
  );
}
