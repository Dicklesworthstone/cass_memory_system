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
  expandPath,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
} from "../utils.js";
import { analyzeScoreDistribution, getEffectiveScore, isStale } from "../scoring.js";
import { ErrorCode, type PlaybookBullet } from "../types.js";
import { openSearchIndex } from "../search.js";
import { loadTopics, loadKnowledgePage, parseKnowledgePage, serializeKnowledgePage } from "../knowledge-page.js";
import { loadProcessingState, findUnprocessedSessionNotes } from "../session-notes.js";
import fs from "node:fs/promises";
import path from "node:path";

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
    description: "Get relevant knowledge for a task. Returns full knowledge page content for matching topics, matching user notes, and session note summaries. If a session summary looks relevant, call cm_detail with path 'session-notes/{id}.md' to read the full note.",
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
    description: "Record helpful/harmful feedback for a playbook rule or knowledge page section. Use bulletId for playbook rules, or path+section for knowledge page sections.",
    inputSchema: {
      type: "object",
      properties: {
        bulletId: { type: "string", description: "Playbook bullet ID to give feedback on" },
        helpful: { type: "boolean" },
        harmful: { type: "boolean" },
        reason: { type: "string" },
        session: { type: "string" },
        path: { type: "string", description: "Knowledge page path (e.g. 'knowledge/auth-service.md') for section-level feedback" },
        section: { type: "string", description: "Section title within the knowledge page" }
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
    name: "cm_search",
    description: "Search knowledge pages, session notes, digests, transcripts, and/or playbook bullets. Uses SQLite FTS5 for ranked full-text search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        scope: { type: "string", enum: ["all", "knowledge", "sessions", "digests", "transcripts", "playbook"], default: "all", description: "Scope to search within. 'all' searches knowledge + sessions + notes + digests (not transcripts unless specified)." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        include_transcripts: { type: "boolean", default: false, description: "Include raw transcripts in results (ranked below curated content)" }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_search",
    description: "DEPRECATED: Use cm_search instead. Search playbook bullets and/or history.",
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
    name: "cm_detail",
    description: "Read a specific file from the memory system (knowledge page, session note, or digest). Optionally extract a specific section from knowledge pages.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path under ~/.memory-system/ (e.g. 'knowledge/auth-service.md', 'session-notes/abc123.md', 'digests/2026-03-24.md')" },
        section: { type: "string", description: "Optional section title to extract from a knowledge page" }
      },
      required: ["path"]
    }
  },
  {
    name: "cm_snapshot",
    description: "IMPORTANT: Call this proactively before context compaction or at the end of major tasks to preserve session knowledge. You ARE the LLM generating the note — no API key needed.\n\nFor the `content` field, write VERBOSE session notes that a human can follow without reading the code. For each subtask include:\n- Files changed: what functions/types were added or modified, HOW they work internally (mechanisms, not just names), and WHY they were designed that way\n- Decisions with rationale: what alternatives were considered and why this path was chosen\n- Problems → solutions: the error message, root cause, and exact fix\n- Gotchas: non-obvious behavior, import locations, schema quirks, type mismatches, field name surprises — these save hours in future sessions\n- Test results: counts before/after, specific failures fixed or introduced\n- Unfinished work or open questions\n\nTarget 1-2 paragraphs per subtask, not 1-2 bullet points. Too long is always better than too short — lost knowledge costs hours, extra tokens cost fractions of a cent.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Transcript file path or session ID. If omitted, processes all modified transcripts." },
        abstract: { type: "string", description: "1-2 sentence summary of the session. When provided with content, skips the LLM call." },
        topics: { type: "array", items: { type: "string" }, description: "Topic slugs covered (kebab-case, e.g. 'billing-service')" },
        content: { type: "string", description: "VERBOSE session note body in markdown. Use ## date headers and ### topic headers. For each subtask: explain what changed and HOW it works (mechanisms, not just function names), WHY decisions were made (alternatives considered), problems with root causes and fixes, gotchas with specific details (field names, import paths, schema quirks). 1-2 paragraphs per subtask minimum. Too long is better than too short." },
        maxSessions: { type: "integer", minimum: 1, maximum: 50, description: "Max transcripts to process when no session specified (default 10)", default: 10 }
      }
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
  },
  {
    uri: "cm://topics",
    name: "Topics",
    description: "List of all knowledge topics with metadata",
    mimeType: "application/json"
  },
  {
    uri: "cm://knowledge/{topic}",
    name: "Knowledge Page",
    description: "Full knowledge page for a topic (replace {topic} with topic slug)",
    mimeType: "text/markdown"
  },
  {
    uri: "cm://digest/{date}",
    name: "Daily Digest",
    description: "Daily digest for a date (replace {date} with YYYY-MM-DD)",
    mimeType: "text/markdown"
  },
  {
    uri: "cm://today",
    name: "Today's Digest",
    description: "Alias for today's daily digest",
    mimeType: "text/markdown"
  },
  {
    uri: "cm://status",
    name: "System Status",
    description: "Memory system status: last reflection run, topic count, unprocessed notes, budget",
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
      const result = context.result as any;
      // Add usage hint for the agent
      if (result.sessionSummaries?.length > 0 || result.knowledgePageSummaries?.length > 0) {
        result._hint = "To read full content, call cm_detail with the path. For session notes: 'session-notes/{id}.md' (id includes 'session-' prefix). For knowledge pages in summaries: use the path field directly (e.g. 'knowledge/gtfs/_index.md'). High-relevance knowledge pages are auto-included with full content above.";
      }
      return result;
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
    case "cm_detail": {
      assertArgs(args, { path: "string" });
      const pathCheck = validateNonEmptyString(args?.path, "path", { trim: true });
      if (!pathCheck.ok) throw new Error(pathCheck.message);

      const config = await loadConfig();
      const baseDir = expandPath("~/.memory-system");
      const resolved = path.resolve(baseDir, pathCheck.value);

      // Security: ensure resolved path stays under ~/.memory-system/
      if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new Error("Path traversal detected: path must be under ~/.memory-system/");
      }

      let content: string;
      try {
        content = await fs.readFile(resolved, "utf-8");
      } catch {
        throw new Error(`File not found: ${pathCheck.value}`);
      }

      const sectionArg = typeof args?.section === "string" ? args.section.trim() : undefined;

      // If this is a knowledge page and a section is requested, extract just that section
      if (sectionArg && resolved.includes("/knowledge/")) {
        const parsed = parseKnowledgePage(content);
        const section = parsed.sections.find(
          s => s.title.toLowerCase() === sectionArg.toLowerCase()
        );
        if (!section) {
          throw new Error(`Section "${sectionArg}" not found in ${pathCheck.value}. Available: ${parsed.sections.map(s => s.title).join(", ")}`);
        }
        return {
          path: pathCheck.value,
          content_type: "knowledge_section",
          section: section.title,
          content: section.content,
          metadata: {
            id: section.id,
            confidence: section.confidence,
            source: section.source,
            added: section.added,
          },
        };
      }

      // Determine content type from path
      let contentType = "unknown";
      if (resolved.includes("/knowledge/")) contentType = "knowledge_page";
      else if (resolved.includes("/session-notes/")) contentType = "session_note";
      else if (resolved.includes("/digests/")) contentType = "digest";

      const result: any = { path: pathCheck.value, content_type: contentType, content };

      // For knowledge pages, also return section list
      if (contentType === "knowledge_page") {
        const parsed = parseKnowledgePage(content);
        result.sections = parsed.sections.map(s => ({
          title: s.title,
          id: s.id,
          confidence: s.confidence,
        }));
      }

      return result;
    }
    case "cm_search": {
      assertArgs(args, { query: "string" });
      const queryCheck = validateNonEmptyString(args?.query, "query", { trim: true });
      if (!queryCheck.ok) throw new Error(queryCheck.message);

      const scopeCheck = validateOneOf(
        args?.scope, "scope",
        ["all", "knowledge", "sessions", "digests", "transcripts", "playbook"] as const,
        { allowUndefined: true, caseInsensitive: true }
      );
      if (!scopeCheck.ok) throw new Error(scopeCheck.message);
      const scope = scopeCheck.value ?? "all";

      const limitCheck = validatePositiveInt(args?.limit, "limit", { min: 1, max: 100, allowUndefined: true });
      if (!limitCheck.ok) throw new Error(limitCheck.message);
      const limit = limitCheck.value ?? 10;

      const includeTranscripts = Boolean(args?.include_transcripts);
      const config = await loadConfig();
      const t0 = performance.now();

      const results: Array<{ type: string; id: string; snippet: string; score: number; title?: string }> = [];

      // Playbook scope: substring match (no FTS)
      if (scope === "playbook" || scope === "all") {
        const playbook = await loadMergedPlaybook(config);
        const bullets = getActiveBullets(playbook);
        const q = queryCheck.value.toLowerCase();
        const playbookHits = bullets
          .filter(b => {
            const haystack = `${b.content} ${b.category ?? ""} ${b.scope ?? ""}`.toLowerCase();
            return haystack.includes(q);
          })
          .slice(0, limit)
          .map(b => ({
            type: "playbook" as const,
            id: b.id,
            snippet: b.content,
            score: 1.0,
            title: b.category ?? undefined,
          }));
        results.push(...playbookHits);
      }

      // FTS scopes
      if (scope !== "playbook") {
        try {
          const dbPath = expandPath(config.searchDbPath);
          const searchIndex = openSearchIndex(dbPath);
          try {
            // Map scope to FTS tables
            let tables: Array<"knowledge" | "sessions" | "notes" | "digests" | "transcripts">;
            if (scope === "all") {
              tables = ["knowledge", "sessions", "notes", "digests"];
              if (includeTranscripts) tables.push("transcripts");
            } else if (scope === "transcripts") {
              tables = ["transcripts"];
            } else {
              // Map scope name to table name
              const tableMap: Record<string, "knowledge" | "sessions" | "digests"> = {
                knowledge: "knowledge",
                sessions: "sessions",
                digests: "digests",
              };
              tables = [tableMap[scope] ?? "knowledge"];
            }

            const ftsHits = searchIndex.search(queryCheck.value, { tables, limit });
            for (const hit of ftsHits) {
              const score = hit.table === "transcripts"
                ? 1 / (1 + Math.abs(hit.rank)) * 0.5  // Transcripts ranked lower
                : 1 / (1 + Math.abs(hit.rank));
              results.push({
                type: hit.table,
                id: hit.id,
                snippet: hit.snippet,
                score,
              });
            }
          } finally {
            searchIndex.close();
          }
        } catch {
          // search.db missing or corrupt — skip FTS
        }
      }

      // Sort by score descending, deduplicate by id+type
      const seen = new Set<string>();
      const deduped = results
        .sort((a, b) => b.score - a.score)
        .filter(r => {
          const key = `${r.type}:${r.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit);

      maybeProfile("cm_search", t0);
      return { results: deduped, total: deduped.length };
    }
    case "memory_search": {
      // Deprecated alias — delegates to legacy cass-based search for backwards compat
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
    case "cm_snapshot": {
      const t0 = performance.now();
      const config = await loadConfig();
      const sessionArg = args?.session as string | undefined;
      const maxSessions = (args?.maxSessions as number) ?? 10;

      // Agent-provided content: when the agent passes abstract + content,
      // we skip the LLM call entirely. The agent IS the LLM.
      const agentContent = (args?.abstract && args?.content)
        ? {
            abstract: args.abstract as string,
            topics_touched: (args.topics as string[]) ?? [],
            content: args.content as string,
          }
        : undefined;

      const { processTranscript, processAllTranscripts, scanForModifiedTranscripts, findBestTranscriptForCwd } =
        await import("../session-notes.js");

      if (sessionArg || agentContent) {
        // Process a specific transcript (or write agent content to the most recent)
        const scans = await scanForModifiedTranscripts(config);
        let match = sessionArg
          ? scans.find(
              (s) => s.transcriptPath === sessionArg || s.sessionId === sessionArg || s.transcriptPath.includes(sessionArg)
            )
          : await findBestTranscriptForCwd(scans); // Match to current project + most recent mtime

        if (!match) {
          if (agentContent) {
            return { message: "No modified transcript found to attach agent content to.", processed: 0 };
          }
          return { message: "No modified transcript found matching the given session.", processed: 0 };
        }

        const note = await processTranscript(match, config, { agentContent });
        maybeProfile("cm_snapshot", t0);
        return {
          processed: 1,
          sessionId: note.frontmatter.id,
          abstract: note.frontmatter.abstract,
          topics: note.frontmatter.topics_touched,
          agentProvided: !!agentContent,
          message: agentContent
            ? `Session note saved for ${note.frontmatter.id} (agent-generated, no LLM call)`
            : `Session note generated for ${note.frontmatter.id}`,
        };
      } else {
        // Process all modified transcripts (periodic job path — needs API key)
        const result = await processAllTranscripts(config, { maxSessions });
        maybeProfile("cm_snapshot", t0);
        return {
          processed: result.processed.length,
          errors: result.errors.length,
          sessions: result.processed.map((n) => ({
            id: n.frontmatter.id,
            abstract: n.frontmatter.abstract,
          })),
          message: result.processed.length > 0
            ? `Generated ${result.processed.length} session note(s)`
            : "No modified transcripts found",
        };
      }
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

  // Exact match resources
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
    case "cm://topics": {
      const topics = await loadTopics(config);
      return { uri, mimeType: "application/json", data: topics };
    }
    case "cm://today": {
      const today = new Date().toISOString().slice(0, 10);
      const digestFile = path.join(expandPath(config.digestsDir), `${today}.md`);
      try {
        const content = await fs.readFile(digestFile, "utf-8");
        return { uri, mimeType: "text/markdown", text: content };
      } catch {
        return { uri, mimeType: "text/markdown", text: `No digest found for ${today}` };
      }
    }
    case "cm://status": {
      const state = await loadProcessingState(config);
      const topics = await loadTopics(config);
      const unprocessed = await findUnprocessedSessionNotes(config);
      let budget: any = null;
      try {
        const { checkBudget } = await import("../cost.js");
        budget = await checkBudget(config);
      } catch { /* budget module may not be available */ }
      return {
        uri,
        mimeType: "application/json",
        data: {
          lastPeriodicJobRun: state.lastPeriodicJobRun ?? null,
          lastIndexUpdate: state.lastIndexUpdate ?? null,
          topicCount: topics.length,
          unprocessedSessionNotes: unprocessed.length,
          budget: budget ? { exceeded: budget.exceeded, message: budget.message } : null,
        },
      };
    }
  }

  // Prefix-based matching for parameterized URIs
  if (uri.startsWith("cm://knowledge/")) {
    const topicSlug = uri.slice("cm://knowledge/".length);
    if (!topicSlug) throw new Error("Missing topic slug in URI");
    const page = await loadKnowledgePage(topicSlug, config);
    if (!page) throw new Error(`Knowledge page not found: ${topicSlug}`);
    return { uri, mimeType: "text/markdown", text: serializeKnowledgePage(page) };
  }

  if (uri.startsWith("cm://digest/")) {
    const date = uri.slice("cm://digest/".length);
    if (!date) throw new Error("Missing date in URI");
    const digestFile = path.join(expandPath(config.digestsDir), `${date}.md`);
    try {
      const content = await fs.readFile(digestFile, "utf-8");
      return { uri, mimeType: "text/markdown", text: content };
    } catch {
      throw new Error(`Digest not found for date: ${date}`);
    }
  }

  throw new Error(`Unknown resource: ${uri}`);
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
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: err?.message || "Tool call failed" }) }],
          isError: true,
        },
      };
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
