import http from "node:http";
import { performance } from "node:perf_hooks";
import { generateContextResult } from "./context.js";
import { recordFeedback } from "./mark.js";
import { recordOutcome, loadOutcomes } from "../outcome.js";
import { loadConfig } from "../config.js";
import { log, warn, error as logError } from "../utils.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, getActiveBullets } from "../playbook.js";
import { loadAllDiaries, generateDiary } from "../diary.js";
import { safeCassSearch, findUnprocessedSessions } from "../cass.js";
import { reflectOnSession } from "../reflect.js";
import { validateDelta } from "../validate.js";
import { curatePlaybook } from "../curate.js";
import { ProcessedLog, getProcessedLogPath } from "../tracking.js";
import { expandPath, now, fileExists } from "../utils.js";
import { withLock } from "../lock.js";
import { analyzeScoreDistribution, getEffectiveScore, isStale } from "../scoring.js";
import { jaccardSimilarity } from "../utils.js";
import type { PlaybookDelta, PlaybookBullet } from "../types.js";

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
        outcome: { type: "string", description: "success | failure | mixed" },
        rulesUsed: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        task: { type: "string" },
        durationSec: { type: "number" }
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
        limit: { type: "number", default: 10 },
        days: { type: "number", description: "Limit cass search to lookback days" },
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
        days: { type: "number", description: "Look back this many days for sessions", default: 7 },
        maxSessions: { type: "number", description: "Maximum sessions to process", default: 20 },
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

  const scores = bullets.map((b) => ({
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
  const staleCount = bullets.filter((b) => isStale(b, 90)).length;

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
      assertArgs(args, { bulletId: "string" });
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
      assertArgs(args, { outcome: "string", sessionId: "string" });
      if (!["success", "failure", "mixed", "partial"].includes(args.outcome)) {
        throw new Error("outcome must be success | failure | mixed | partial");
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
    case "memory_search": {
      assertArgs(args, { query: "string" });
      const scope: "playbook" | "cass" | "both" = args.scope || "both";
      const limit = typeof args?.limit === "number" ? args.limit : 10;
      const days = typeof args?.days === "number" ? args.days : undefined;
      const agent = typeof args?.agent === "string" ? args.agent : undefined;
      const workspace = typeof args?.workspace === "string" ? args.workspace : undefined;
      const config = await loadConfig();

      const result: { playbook?: any[]; cass?: any[] } = {};
      const q = args.query.toLowerCase();

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
        const hits = await safeCassSearch(args.query, { limit, days, agent, workspace }, config.cassPath, config);
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

      const days = typeof args?.days === "number" ? args.days : 7;
      const maxSessions = typeof args?.maxSessions === "number" ? args.maxSessions : 20;
      const dryRun = Boolean(args?.dryRun);
      const workspace = typeof args?.workspace === "string" ? args.workspace : undefined;
      const session = typeof args?.session === "string" ? args.session : undefined;

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
          proposedDeltas: deltas.map(d => ({
            type: d.type,
            ...(d.type === "add" ? { content: d.bullet?.content } : {}),
            ...(d.type !== "add" && "bulletId" in d ? { bulletId: d.bulletId } : {})
          })),
          message: `Would apply ${outcome.deltasGenerated} changes from ${outcome.sessionsProcessed} sessions`
        };
      }

      const applied = (outcome.globalResult?.applied || 0) + (outcome.repoResult?.applied || 0);
      const skipped = (outcome.globalResult?.skipped || 0) + (outcome.repoResult?.skipped || 0);
      const inversions = (outcome.globalResult?.inversions.length || 0) + (outcome.repoResult?.inversions.length || 0);

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

export async function serveCommand(options: { port?: number; host?: string } = {}): Promise<void> {
  const port = options.port || Number(process.env.MCP_HTTP_PORT) || 8765;
  // Default strictly to localhost loopback for security
  const host = options.host || process.env.MCP_HTTP_HOST || "127.0.0.1";

  if (host === "0.0.0.0" && process.env.NODE_ENV !== "development") {
    warn("Warning: Binding to 0.0.0.0 exposes the server to the network. Ensure this is intended.");
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    let raw = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      raw += chunk.toString();
      if (raw.length > MAX_BODY_BYTES) {
        aborted = true;
        res.statusCode = 413;
        res.end(JSON.stringify(buildError(null, "Payload too large", -32600)));
        req.destroy();
      }
    });

    req.on("end", async () => {
      if (aborted) return;
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
