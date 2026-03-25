/**
 * session-notes.ts — Session note generation from raw transcripts.
 *
 * This is the compression boundary where information either survives or dies.
 * Every downstream artifact (diary entries, knowledge pages, bullets, digests)
 * is derived from session notes.
 *
 * Two generation paths:
 *   1. Periodic job: scans transcripts on disk, reads from last offset, generates/extends notes
 *   2. cm_snapshot: manually triggered by agent or user for on-demand note generation
 *
 * Session notes are append-only markdown files with YAML frontmatter.
 * Files are the source of truth; SQLite is just the search index.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config, ProcessingState, SessionProcessingState } from "./types.js";
import { ProcessingStateSchema } from "./types.js";
// formatRawSession from diary.ts no longer used — replaced by formatTranscriptChunk
import { generateSessionNoteContent, extendSessionNoteContent, generateObjectSafe, configForStep } from "./llm.js";
import type { LLMIO } from "./llm.js";
import {
  expandPath,
  resolveGlobalDir,
  atomicWrite,
  ensureDir,
  log,
  warn,
  error as logError,
  now,
  hashContent,
} from "./utils.js";
import { withLock } from "./lock.js";
import type { SearchIndex, TranscriptChunk } from "./search.js";

// ============================================================================
// TYPES
// ============================================================================

/** Parsed session note with frontmatter and body separated. */
export interface ParsedSessionNote {
  frontmatter: SessionNoteFrontmatter;
  body: string;
  raw: string;
}

export interface SessionNoteFrontmatter {
  id: string;
  title: string;
  source_session: string;
  last_offset: number;
  created: string;
  last_updated: string;
  abstract: string;
  topics_touched: string[];
  processed: boolean;
  user_edited: boolean;
}

/** Result of scanning for modified transcripts. */
export interface TranscriptScanResult {
  sessionId: string;
  transcriptPath: string;
  currentSize: number;
  lastOffset: number;
  isNew: boolean;
}

/** LLM output schema for creating a new session note. */
export const SessionNoteCreateOutputSchema = z.object({
  title: z.string().describe("Short display name for the session (3-8 words, e.g. 'Fix billing webhook HMAC validation', 'Phase 3 reflection pipeline build')"),
  abstract: z.string().describe("1-2 sentence summary of the full session"),
  topics_touched: z.array(z.string()).describe("Topic slugs covered in this session (kebab-case, e.g. 'billing-service', 'auth-setup')"),
  content: z.string().describe("The session note body in markdown. Use ## date — time headers (e.g. '## March 25, 2026 — 14:30'), ### topic headers. Include specific facts, decisions, outcomes, error messages, file paths."),
});

export type SessionNoteCreateOutput = z.infer<typeof SessionNoteCreateOutputSchema>;

/** LLM output schema for extending an existing session note. */
export const SessionNoteAppendOutputSchema = z.object({
  abstract: z.string().describe("Updated 1-2 sentence summary covering the FULL note including new content"),
  topics_touched: z.array(z.string()).describe("Updated list of all topic slugs, including any new topics from the appended content"),
  new_content: z.string().describe("ONLY the new section(s) to append. Start with a context resumption sentence. Add a date — time header (e.g. '## March 25, 2026 — 14:30') if the day or time period changed. Do NOT repeat existing content."),
});

export type SessionNoteAppendOutput = z.infer<typeof SessionNoteAppendOutputSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

/** Known transcript directories for supported agents. */
const TRANSCRIPT_DIRS = [
  "~/.claude/projects",
];

// ============================================================================
// STATE MANAGEMENT (state.json)
// ============================================================================

export async function loadProcessingState(config: Config): Promise<ProcessingState> {
  const statePath = expandPath(config.stateJsonPath);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return ProcessingStateSchema.parse(JSON.parse(raw));
  } catch {
    return { sessions: {}, lastReflectionRun: undefined, lastIndexUpdate: undefined };
  }
}

export async function saveProcessingState(state: ProcessingState, config: Config): Promise<void> {
  const statePath = expandPath(config.stateJsonPath);
  await ensureDir(path.dirname(statePath));
  await withLock(statePath, async () => {
    await atomicWrite(statePath, JSON.stringify(state, null, 2));
  });
}

// ============================================================================
// TRANSCRIPT DISCOVERY & READING
// ============================================================================

/**
 * Discover all session transcript .jsonl files across known agent directories.
 * Returns paths to transcript files.
 */
export async function discoverTranscripts(): Promise<string[]> {
  const transcripts: string[] = [];

  for (const dirTemplate of TRANSCRIPT_DIRS) {
    const dir = expandPath(dirTemplate);
    try {
      const projectDirs = await fs.readdir(dir, { withFileTypes: true });
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = path.join(dir, projectDir.name);
        const files = await fs.readdir(projectPath, { withFileTypes: true });
        for (const file of files) {
          if (file.name.endsWith(".jsonl") && file.isFile()) {
            transcripts.push(path.join(projectPath, file.name));
          }
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — skip
    }
  }

  return transcripts;
}

/**
 * Scan for transcripts with new content since last processed offset.
 */
export async function scanForModifiedTranscripts(
  config: Config,
  options?: { includeOld?: boolean }
): Promise<TranscriptScanResult[]> {
  const state = await loadProcessingState(config);
  const transcripts = await discoverTranscripts();
  const results: TranscriptScanResult[] = [];

  // On first run, record installedAt timestamp. Transcripts created before
  // this date are "old" and won't get automatic session note generation
  // (user can manually trigger via transcript browser).
  if (!state.installedAt) {
    state.installedAt = new Date().toISOString();
    await saveProcessingState(state, config);
    log(`First run detected. Set installedAt: ${state.installedAt}`);
  }
  const installedAt = new Date(state.installedAt).getTime();

  for (const transcriptPath of transcripts) {
    try {
      const stat = await fs.stat(transcriptPath);
      const currentSize = stat.size;
      const sessionId = sessionIdFromPath(transcriptPath);
      const sessionState = state.sessions[sessionId];
      const lastOffset = sessionState?.last_offset ?? 0;

      if (currentSize > lastOffset) {
        const isNew = lastOffset === 0;

        // Skip old transcripts (created before installation) unless explicitly requested.
        // This prevents expensive backfill of 100+ old transcripts on first run.
        // Old transcripts can be processed manually via the transcript browser.
        if (isNew && !options?.includeOld) {
          const transcriptMtime = stat.mtimeMs;
          if (transcriptMtime < installedAt) {
            // Record offset so we don't re-scan, but don't create a session note
            state.sessions[sessionId] = {
              last_offset: currentSize,
              last_processed: new Date().toISOString(),
            };
            continue;
          }
        }

        results.push({
          sessionId,
          transcriptPath,
          currentSize,
          lastOffset,
          isNew,
        });
      }
    } catch {
      // File disappeared between discovery and stat — skip
    }
  }

  // Save state with any skipped old transcripts recorded
  await saveProcessingState(state, config);

  return results;
}

/**
 * Normalize a path or project directory name to a canonical form for comparison.
 * Claude Code encodes working directories as project dir names by replacing
 * path separators and other non-alphanumeric characters with hyphens.
 * We normalize both sides the same way so they can be compared.
 */
function normalizePathForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/**
 * Find the best transcript match for the current working directory.
 *
 * Used by cm_snapshot when no explicit session ID is specified. Instead of
 * blindly picking scans[0] (which is filesystem-order across ALL projects),
 * this function:
 *   1. Filters to transcripts whose project directory matches `cwd`
 *   2. Sorts by file modification time (newest first)
 *
 * The active conversation's transcript is the most recently modified file
 * in its project directory, so this reliably picks the correct transcript.
 *
 * Falls back to all scans sorted by mtime if no project match is found.
 */
export async function findBestTranscriptForCwd(
  scans: TranscriptScanResult[],
  cwd?: string
): Promise<TranscriptScanResult | null> {
  if (scans.length === 0) return null;
  if (scans.length === 1) return scans[0];

  const effectiveCwd = cwd || process.cwd();
  const normalizedCwd = normalizePathForMatch(effectiveCwd);

  // Filter to transcripts whose project directory matches the cwd.
  // Transcript paths look like: ~/.claude/projects/{project-dir}/{uuid}.jsonl
  // where {project-dir} is the encoded working directory.
  const projectMatches = scans.filter((s) => {
    const projectDir = path.basename(path.dirname(s.transcriptPath));
    return normalizePathForMatch(projectDir) === normalizedCwd;
  });

  const candidates = projectMatches.length > 0 ? projectMatches : scans;

  // Sort by file modification time (newest first).
  // The active conversation's transcript was just written to (the cm_snapshot
  // call itself appears in it), so it has the most recent mtime.
  const withMtime = await Promise.all(
    candidates.map(async (s) => {
      try {
        const stat = await fs.stat(s.transcriptPath);
        return { scan: s, mtime: stat.mtimeMs };
      } catch {
        return { scan: s, mtime: 0 };
      }
    })
  );

  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0]?.scan ?? null;
}

/**
 * Read raw transcript content from a byte offset.
 * Returns the raw JSONL text from the offset onward.
 */
export async function readTranscriptFromOffset(
  filePath: string,
  offset: number
): Promise<{ content: string; newOffset: number }> {
  const fileHandle = await fs.open(filePath, "r");
  try {
    const stat = await fileHandle.stat();
    const bytesToRead = stat.size - offset;
    if (bytesToRead <= 0) return { content: "", newOffset: offset };

    const buffer = Buffer.alloc(bytesToRead);
    await fileHandle.read(buffer, 0, bytesToRead, offset);
    const content = buffer.toString("utf-8");

    return { content, newOffset: stat.size };
  } finally {
    await fileHandle.close();
  }
}

/**
 * Format a JSONL transcript chunk into a compact, human-readable session note.
 *
 * Unlike formatRawSession (designed for CASS diary entries), this formatter is
 * optimized for session notes:
 *   - Drops meta entries (queue-operation, file-history-snapshot, progress)
 *   - Summarizes tool_use as one-liners (Read: path, Edit: path, Bash: command)
 *   - Drops tool_result contents (tool name + args are enough context)
 *   - Keeps user text and assistant text
 *   - Keeps thinking blocks (high signal for decisions/reasoning)
 *   - Strips XML tags (ide_selection, system-reminder, etc.)
 */
export function formatTranscriptChunk(rawContent: string): string {
  if (!rawContent.trim()) return "";

  const lines = rawContent.split("\n").filter((l) => l.trim());
  const output: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const formatted = formatSessionEntry(entry);
      if (formatted) output.push(formatted);
    } catch {
      // Skip malformed lines
    }
  }

  return output.join("\n\n");
}

/** Format a single JSONL entry for session note output. Returns null to skip. */
function formatSessionEntry(entry: any): string | null {
  const type = entry.type;

  // Drop pure noise
  if (type === "queue-operation" || type === "file-history-snapshot" ||
      type === "progress" || type === "session_meta") {
    return null;
  }

  if (type === "user" || type === "human") {
    return formatUserEntry(entry.message);
  }

  if (type === "assistant") {
    return formatAssistantEntry(entry.message);
  }

  // Unknown type — skip rather than output noise
  return null;
}

/** Format a user message. Extracts text, drops tool_results. */
function formatUserEntry(msg: any): string | null {
  if (!msg?.content) return null;

  if (typeof msg.content === "string") {
    const cleaned = stripXmlTags(msg.content).trim();
    return cleaned ? `**user**: ${cleaned}` : null;
  }

  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const block of msg.content) {
      // Keep text blocks (the actual user message)
      if (block.type === "text" && typeof block.text === "string") {
        const cleaned = stripXmlTags(block.text).trim();
        if (cleaned) texts.push(cleaned);
      }
      // Drop tool_result blocks — the tool_use summary is enough
      // Drop image blocks — note that an image was shared
      if (block.type === "image") {
        texts.push("[image attached]");
      }
    }
    if (texts.length === 0) return null;
    return `**user**: ${texts.join("\n")}`;
  }

  return null;
}

/** Format an assistant message. Summarizes tool_use, keeps text and thinking. */
function formatAssistantEntry(msg: any): string | null {
  if (!msg?.content) return null;

  if (typeof msg.content === "string") {
    const text = msg.content.trim();
    return text ? `**assistant**: ${text}` : null;
  }

  if (Array.isArray(msg.content)) {
    const parts: string[] = [];

    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text) parts.push(text);
      }

      if (block.type === "thinking" && typeof block.thinking === "string") {
        // Keep thinking — it contains decisions and reasoning
        const thinking = block.thinking.trim();
        if (thinking.length > 50) {
          // Truncate very long thinking blocks but preserve the key content
          const truncated = thinking.length > 500
            ? thinking.slice(0, 500) + "..."
            : thinking;
          parts.push(`*thinking*: ${truncated}`);
        }
      }

      if (block.type === "tool_use") {
        const summary = summarizeToolUse(block.name, block.input);
        if (summary) parts.push(`> ${summary}`);
      }
    }

    if (parts.length === 0) return null;
    return `**assistant**: ${parts.join("\n")}`;
  }

  return null;
}

/** Produce a one-line summary of a tool call. */
function summarizeToolUse(name: string, input: any): string | null {
  if (!input) return `${name}`;

  switch (name) {
    case "Read":
      return `Read: ${shortenPath(input.file_path)}${input.offset ? ` (from line ${input.offset})` : ""}`;

    case "Write":
      return `Write: ${shortenPath(input.file_path)}`;

    case "Edit": {
      const file = shortenPath(input.file_path);
      const old_str = typeof input.old_string === "string" ? input.old_string : "";
      const preview = old_str.split("\n")[0]?.slice(0, 60);
      return `Edit: ${file}${preview ? ` — "${preview}..."` : ""}`;
    }

    case "Bash": {
      const cmd = input.command || "";
      const desc = input.description || "";
      // Use description if available (more readable), otherwise truncate command
      const display = desc || (cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd);
      return `Bash: ${display}`;
    }

    case "Grep":
      return `Grep: "${input.pattern}"${input.path ? ` in ${shortenPath(input.path)}` : ""}`;

    case "Glob":
      return `Glob: ${input.pattern}${input.path ? ` in ${shortenPath(input.path)}` : ""}`;

    case "TodoWrite":
      // Summarize the todo items rather than dump the full array
      if (Array.isArray(input.todos)) {
        const items = input.todos
          .filter((t: any) => t.status === "in_progress" || t.status === "pending")
          .map((t: any) => t.content)
          .slice(0, 3);
        return items.length > 0
          ? `TodoWrite: ${items.join("; ")}${input.todos.length > 3 ? `; +${input.todos.length - 3} more` : ""}`
          : `TodoWrite: ${input.todos.length} items`;
      }
      return "TodoWrite";

    case "Agent":
      return `Agent(${input.subagent_type || "general"}): ${input.description || ""}`;

    case "Skill":
      return `Skill: ${input.skill}${input.args ? ` ${input.args}` : ""}`;

    case "ToolSearch":
      return `ToolSearch: ${input.query}`;

    default:
      // Unknown tool — show name + first string arg
      const firstArg = Object.values(input).find((v) => typeof v === "string");
      return `${name}${firstArg ? `: ${String(firstArg).slice(0, 80)}` : ""}`;
  }
}

/** Shorten a file path for display (keep last 3 segments). */
function shortenPath(p: string | undefined): string {
  if (!p) return "[unknown]";
  const segments = p.split("/");
  return segments.length > 3 ? ".../" + segments.slice(-3).join("/") : p;
}

/** Strip XML tags like <ide_selection>, <system-reminder>, etc. */
function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
}

// ============================================================================
// SESSION NOTE I/O
// ============================================================================

/**
 * Generate a deterministic session ID from a transcript path.
 * Format: session-{hash} where hash is derived from the path.
 */
export function sessionIdFromPath(transcriptPath: string): string {
  // For Claude Code: extract the UUID from the filename
  const basename = path.basename(transcriptPath, ".jsonl");
  // If it looks like a UUID, use it directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename)) {
    return `session-${basename}`;
  }
  // Otherwise hash the full path for a stable ID
  return `session-${hashContent(transcriptPath).slice(0, 16)}`;
}

/**
 * Parse a session note markdown file into frontmatter + body.
 */
export function parseSessionNote(raw: string): ParsedSessionNote {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("Session note missing YAML frontmatter");
  }

  const fmLines = fmMatch[1].split("\n");
  const fm: Record<string, any> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    // Parse YAML-like values
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("[")) {
      // Simple array parsing for topics_touched
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
      }
    }

    fm[key] = value;
  }

  return {
    frontmatter: {
      id: fm.id || "",
      title: fm.title || "",
      source_session: fm.source_session || "",
      last_offset: fm.last_offset || 0,
      created: fm.created || "",
      last_updated: fm.last_updated || "",
      abstract: fm.abstract || "",
      topics_touched: Array.isArray(fm.topics_touched) ? fm.topics_touched : [],
      processed: fm.processed === true,
      user_edited: fm.user_edited === true,
    },
    body: fmMatch[2],
    raw,
  };
}

/**
 * Serialize a session note to markdown with YAML frontmatter.
 */
export function serializeSessionNote(frontmatter: SessionNoteFrontmatter, body: string): string {
  const topicsStr = JSON.stringify(frontmatter.topics_touched);
  return `---
id: ${frontmatter.id}
title: "${(frontmatter.title || "").replace(/"/g, '\\"')}"
source_session: ${frontmatter.source_session}
last_offset: ${frontmatter.last_offset}
created: ${frontmatter.created}
last_updated: ${frontmatter.last_updated}
abstract: "${frontmatter.abstract.replace(/"/g, '\\"')}"
topics_touched: ${topicsStr}
processed: ${frontmatter.processed}
user_edited: ${frontmatter.user_edited}
---
${body}`;
}

/**
 * Load an existing session note from disk. Returns null if not found.
 */
export async function loadSessionNote(
  sessionId: string,
  config: Config
): Promise<ParsedSessionNote | null> {
  const notePath = sessionNotePath(sessionId, config);
  try {
    const raw = await fs.readFile(notePath, "utf-8");
    return parseSessionNote(raw);
  } catch {
    return null;
  }
}

/**
 * Write a session note to disk with locking.
 */
export async function writeSessionNote(
  sessionId: string,
  frontmatter: SessionNoteFrontmatter,
  body: string,
  config: Config
): Promise<string> {
  const notePath = sessionNotePath(sessionId, config);
  await ensureDir(path.dirname(notePath));
  const content = serializeSessionNote(frontmatter, body);
  await withLock(notePath, async () => {
    await atomicWrite(notePath, content);
  });
  return notePath;
}

/** Resolve the file path for a session note. */
export function sessionNotePath(sessionId: string, config: Config): string {
  return path.join(expandPath(config.sessionNotesDir), `${sessionId}.md`);
}

/**
 * Find session notes that haven't been processed by the reflection pipeline.
 * Returns parsed notes with processed: false, sorted by creation date (oldest first).
 */
export async function findUnprocessedSessionNotes(
  config: Config,
  maxNotes = 10
): Promise<ParsedSessionNote[]> {
  const dir = expandPath(config.sessionNotesDir);
  const results: ParsedSessionNote[] = [];

  try {
    const files = await fs.readdir(dir);
    const mdFiles = files.filter(f => f.endsWith(".md"));

    for (const file of mdFiles) {
      if (results.length >= maxNotes) break;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const note = parseSessionNote(raw);
        if (!note.frontmatter.processed) {
          results.push(note);
        }
      } catch {
        // Skip malformed notes
      }
    }

    // Sort oldest first (process in chronological order)
    results.sort((a, b) =>
      new Date(a.frontmatter.created).getTime() - new Date(b.frontmatter.created).getTime()
    );
  } catch {
    // session-notes dir may not exist yet
  }

  return results;
}

/**
 * Mark a session note as processed by updating its frontmatter.
 */
export async function markSessionNoteProcessed(
  sessionId: string,
  config: Config
): Promise<void> {
  const note = await loadSessionNote(sessionId, config);
  if (!note) return;

  note.frontmatter.processed = true;
  note.frontmatter.last_updated = new Date().toISOString();
  await writeSessionNote(sessionId, note.frontmatter, note.body, config);
}

// ============================================================================
// SESSION NOTE GENERATION
// ============================================================================

export interface GenerateNoteOptions {
  /** Override for testing / manual snapshot. */
  io?: LLMIO;
  /** Search index for transcript chunk indexing. Optional. */
  searchIndex?: SearchIndex;
  /**
   * Agent-provided note content. When set, skips the LLM call entirely and
   * uses this content directly. This is the primary path for cm_snapshot called
   * from Claude Code — the agent has synthesized understanding in its context
   * window and produces higher quality notes than a separate LLM call on raw
   * transcript. Falls back to LLM call when not provided (periodic job path).
   */
  agentContent?: {
    abstract: string;
    topics_touched: string[];
    /** Full note body (for new notes) or new section to append (for existing notes). */
    content: string;
  };
  /**
   * Raw extraction mode. When true, creates a session note from the formatted
   * transcript text without any LLM call. Extracts basic metadata (first user
   * message as abstract, project path as topic). Used by the PreCompact hook
   * when no API key is available. The note can be enriched later by the
   * Reflector when an API key is configured.
   */
  raw?: boolean;
}

/**
 * Generate or extend a session note from a transcript scan result.
 *
 * Two content generation paths:
 *   1. Agent-provided (options.agentContent): Claude Code generates the note during
 *      the session. Higher quality, no API key needed. Used by cm_snapshot MCP tool.
 *   2. LLM-generated (default): Reads raw transcript and makes a separate API call.
 *      Used by the periodic job. Requires API key or Ollama.
 */

// ============================================================================
// MAP-REDUCE SUMMARIZATION FOR LARGE TRANSCRIPTS
// ============================================================================

const ChunkSummarySchema = z.object({
  summary: z.string().describe("Concise summary of this transcript chunk (2-5 sentences). Focus on specific facts, decisions, outcomes, file paths, error messages."),
  topics: z.array(z.string()).describe("Topic slugs mentioned in this chunk (kebab-case)"),
});

const CHUNK_SUMMARY_PROMPT = `Summarize this portion of a coding session transcript. Extract specific facts, decisions, outcomes, file paths, error messages, and external URLs. Be concise but preserve all important details.

<transcript_chunk>
{chunk}
</transcript_chunk>

Respond with a summary and topic slugs.`;

const REDUCE_PROMPT = `You are combining chunk summaries from a long coding session into a single coherent session note.

<chunk_summaries>
{summaries}
</chunk_summaries>

<transcript_path>
{transcriptPath}
</transcript_path>

Write a complete session note that synthesizes all chunks. Use ## date — time headers. Include specific facts, decisions, outcomes, error messages, file paths, and external URLs from across the entire session. Deduplicate — if the same fact appears in multiple chunks, write it once.

Respond with JSON:
{
  "title": "Short display name (3-8 words)",
  "abstract": "1-2 sentence summary of the full session",
  "topics_touched": ["topic-slug-1", "topic-slug-2"],
  "content": "The markdown body of the session note"
}`;

/**
 * Map-reduce summarization for large transcripts.
 * Splits the formatted transcript into chunks, summarizes each with Haiku,
 * then combines summaries into a final session note with Sonnet.
 *
 * Only used when formattedChunk exceeds MAX_LLM_CHUNK_CHARS.
 * Small transcripts use the single-call path in generateSessionNoteContent.
 */
async function summarizeLargeTranscript(
  formattedChunk: string,
  transcriptPath: string,
  config: Config,
): Promise<SessionNoteCreateOutput> {
  const CHUNK_SIZE = 25_000; // ~6K tokens per chunk
  const chunks: string[] = [];

  // Split into chunks at paragraph boundaries
  let pos = 0;
  while (pos < formattedChunk.length) {
    let end = Math.min(pos + CHUNK_SIZE, formattedChunk.length);
    // Try to break at a double newline for cleaner boundaries
    if (end < formattedChunk.length) {
      const searchStart = Math.max(end - 2000, pos);
      const region = formattedChunk.slice(searchStart, end);
      const lastBreak = region.lastIndexOf('\n\n');
      if (lastBreak > 0) end = searchStart + lastBreak;
    }
    chunks.push(formattedChunk.slice(pos, end));
    pos = end;
  }

  log(`Map-reduce: splitting ${Math.round(formattedChunk.length / 1000)}K chars into ${chunks.length} chunks`);

  // MAP: summarize each chunk with Haiku
  const haikuConfig = configForStep(config, "sessionNoteCreate"); // Uses Haiku
  const chunkSummaries: string[] = [];
  const allTopics: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const prompt = CHUNK_SUMMARY_PROMPT.replace("{chunk}", chunks[i]);
      const result = await generateObjectSafe(ChunkSummarySchema, prompt, haikuConfig);
      chunkSummaries.push(`[Chunk ${i + 1}/${chunks.length}]\n${result.summary}`);
      allTopics.push(...result.topics);
      log(`Map-reduce: chunk ${i + 1}/${chunks.length} summarized`);
    } catch (err) {
      warn(`Map-reduce: chunk ${i + 1} failed: ${err}`);
      // Include a raw excerpt as fallback
      chunkSummaries.push(`[Chunk ${i + 1}/${chunks.length} — summary failed]\n${chunks[i].slice(0, 500)}`);
    }
  }

  // REDUCE: combine summaries into final session note with Sonnet
  log(`Map-reduce: reducing ${chunkSummaries.length} summaries into final note`);
  const reducePrompt = REDUCE_PROMPT
    .replace("{summaries}", chunkSummaries.join("\n\n"))
    .replace("{transcriptPath}", transcriptPath);

  // Use Sonnet for the synthesis step (generative, needs quality)
  const sonnetConfig = configForStep(config, "reflectorCall2"); // Falls back to Sonnet
  const finalConfig = sonnetConfig.model ? sonnetConfig : config; // Ensure we have a model

  const output = await generateObjectSafe(
    SessionNoteCreateOutputSchema,
    reducePrompt,
    finalConfig,
  );

  // Merge topics from all chunks
  const mergedTopics = dedupeTopics([...output.topics_touched, ...allTopics]);

  return {
    abstract: output.abstract,
    topics_touched: mergedTopics,
    content: output.content,
  };
}

export async function processTranscript(
  scan: TranscriptScanResult,
  config: Config,
  options: GenerateNoteOptions = {}
): Promise<ParsedSessionNote> {
  const { io, searchIndex, agentContent, raw } = options;

  // 1. Read the new transcript chunk (always — needed for FTS indexing)
  const { content: rawChunk, newOffset } = await readTranscriptFromOffset(
    scan.transcriptPath,
    scan.lastOffset
  );

  if (!rawChunk.trim() && !agentContent) {
    throw new Error(`No new content in transcript: ${scan.transcriptPath}`);
  }

  // 2. Format the raw JSONL into readable text (for FTS + LLM fallback)
  const formattedChunk = rawChunk.trim() ? formatTranscriptChunk(rawChunk) : "";

  // Cap formatted chunk for LLM calls — full version used for FTS, truncated for LLM.
  // 30K chars ≈ 7.5K tokens, leaving room for prompt overhead within rate limits.
  const MAX_LLM_CHUNK_CHARS = 30_000;
  const llmChunk = formattedChunk.length > MAX_LLM_CHUNK_CHARS
    ? formattedChunk.slice(0, MAX_LLM_CHUNK_CHARS) + "\n\n[... transcript truncated for processing]"
    : formattedChunk;

  // 3. Index transcript chunk into FTS if search index provided
  if (searchIndex && formattedChunk.trim()) {
    const chunk: TranscriptChunk = {
      session_id: scan.sessionId,
      chunk_offset: String(scan.lastOffset),
      content: formattedChunk,
    };
    searchIndex.indexTranscriptChunk(chunk);
  }

  // 4. Load existing note (if any)
  const existingNote = await loadSessionNote(scan.sessionId, config);

  // 5. user_edited notes still receive appended content — the system
  // only appends, never modifies existing content, so user edits are safe.

  let result: ParsedSessionNote;

  if (existingNote) {
    // 6a. Extend existing note
    let appendAbstract: string;
    let appendTopics: string[];
    let appendContent: string;

    if (agentContent) {
      // Agent-provided content — use directly
      appendAbstract = agentContent.abstract;
      appendTopics = agentContent.topics_touched;
      appendContent = agentContent.content;
    } else if (raw) {
      // Raw extraction — no LLM, append formatted transcript text
      if (!formattedChunk.trim()) {
        throw new Error(`Transcript chunk is empty after formatting: ${scan.transcriptPath}`);
      }
      const extracted = extractRawMetadata(formattedChunk, scan.transcriptPath);
      // Keep existing abstract for extends — the raw chunk is a continuation
      appendAbstract = existingNote.frontmatter.abstract;
      appendTopics = extracted.topics;
      appendContent = extracted.content;
    } else {
      // LLM-generated content
      if (!formattedChunk.trim()) {
        throw new Error(`Transcript chunk is empty after formatting: ${scan.transcriptPath}`);
      }

      if (formattedChunk.length > MAX_LLM_CHUNK_CHARS * 2) {
        // Large new chunk — use map-reduce on just the new content
        log(`Large append (${Math.round(formattedChunk.length / 1000)}K chars) — using map-reduce`);
        const mapReduceOutput = await summarizeLargeTranscript(formattedChunk, scan.transcriptPath, config);
        appendAbstract = mapReduceOutput.abstract;
        appendTopics = mapReduceOutput.topics_touched;
        appendContent = mapReduceOutput.content;
      } else {
        // Normal size — single LLM call
        const appendOutput = await extendSessionNoteContent(
          existingNote.body.slice(-MAX_LLM_CHUNK_CHARS),
          llmChunk,
          existingNote.frontmatter.abstract,
          config,
          io
        );
        appendAbstract = appendOutput.abstract;
        appendTopics = appendOutput.topics_touched;
        appendContent = appendOutput.new_content;
      }
    }

    // Only reset processed if the new content is substantial (>500 chars).
    // Small appends (metadata updates, short additions) don't warrant re-processing
    // through the full Reflector pipeline.
    const hasSubstantialNewContent = appendContent.trim().length > 500;

    const updatedFrontmatter: SessionNoteFrontmatter = {
      ...existingNote.frontmatter,
      last_offset: newOffset,
      last_updated: now(),
      abstract: appendAbstract,
      topics_touched: dedupeTopics([
        ...existingNote.frontmatter.topics_touched,
        ...appendTopics,
      ]),
      processed: hasSubstantialNewContent ? false : existingNote.frontmatter.processed,
    };

    const updatedBody = existingNote.body.trimEnd() + "\n\n" + appendContent;

    await writeSessionNote(scan.sessionId, updatedFrontmatter, updatedBody, config);

    result = {
      frontmatter: updatedFrontmatter,
      body: updatedBody,
      raw: serializeSessionNote(updatedFrontmatter, updatedBody),
    };
  } else {
    // 6b. Create new note
    let createTitle: string;
    let createAbstract: string;
    let createTopics: string[];
    let createContent: string;

    if (agentContent) {
      // Agent-provided content — derive title from abstract
      createTitle = agentContent.abstract.split(/[.!?]/)[0].slice(0, 60) || "Session note";
      createAbstract = agentContent.abstract;
      createTopics = agentContent.topics_touched;
      createContent = agentContent.content;
    } else if (raw) {
      // Raw extraction — no LLM, use project name as title
      if (!formattedChunk.trim()) {
        throw new Error(`Transcript chunk is empty after formatting: ${scan.transcriptPath}`);
      }
      const extracted = extractRawMetadata(formattedChunk, scan.transcriptPath);
      createTitle = "Raw capture";
      createAbstract = extracted.abstract;
      createTopics = extracted.topics;
      createContent = extracted.content;
    } else {
      // LLM-generated content
      if (!formattedChunk.trim()) {
        throw new Error(`Transcript chunk is empty after formatting: ${scan.transcriptPath}`);
      }

      let createOutput: SessionNoteCreateOutput;
      if (formattedChunk.length > MAX_LLM_CHUNK_CHARS * 2) {
        log(`Large transcript (${Math.round(formattedChunk.length / 1000)}K chars) — using map-reduce summarization`);
        createOutput = await summarizeLargeTranscript(formattedChunk, scan.transcriptPath, config);
      } else {
        createOutput = await generateSessionNoteContent(llmChunk, scan.transcriptPath, config, io);
      }
      createTitle = createOutput.title || createOutput.abstract.split(/[.!?]/)[0].slice(0, 60);
      createAbstract = createOutput.abstract;
      createTopics = createOutput.topics_touched;
      createContent = createOutput.content;
    }

    const frontmatter: SessionNoteFrontmatter = {
      id: scan.sessionId,
      title: createTitle,
      source_session: scan.transcriptPath,
      last_offset: newOffset,
      created: now(),
      last_updated: now(),
      abstract: createAbstract,
      topics_touched: dedupeTopics(createTopics),
      processed: false,
      user_edited: false,
    };

    await writeSessionNote(scan.sessionId, frontmatter, createContent, config);

    result = {
      frontmatter,
      body: createContent,
      raw: serializeSessionNote(frontmatter, createContent),
    };
  }

  // 7. Update processing state
  const state = await loadProcessingState(config);
  state.sessions[scan.sessionId] = {
    last_offset: newOffset,
    last_processed: now(),
  };
  await saveProcessingState(state, config);

  // 8. Index session note into FTS if search index provided
  if (searchIndex) {
    searchIndex.indexSession({
      id: scan.sessionId,
      abstract: result.frontmatter.abstract,
      content: result.body,
    });
    if (result.frontmatter.topics_touched.length > 0) {
      searchIndex.setSessionTopics(scan.sessionId, result.frontmatter.topics_touched);
    }
  }

  return result;
}

/**
 * Process all modified transcripts. Main entry point for the periodic job.
 */
export async function processAllTranscripts(
  config: Config,
  options: GenerateNoteOptions & { maxSessions?: number } = {}
): Promise<{ processed: ParsedSessionNote[]; errors: Array<{ sessionId: string; error: string }> }> {
  const scans = await scanForModifiedTranscripts(config);
  const limit = options.maxSessions ?? 10;
  const toProcess = scans.slice(0, limit);

  const processed: ParsedSessionNote[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];

  for (const scan of toProcess) {
    try {
      const note = await processTranscript(scan, config, options);
      processed.push(note);
      log(`Processed session note: ${scan.sessionId}`);
    } catch (err: any) {
      const msg = err.message || String(err);
      logError(`Failed to process ${scan.sessionId}: ${msg}`);
      errors.push({ sessionId: scan.sessionId, error: msg });
    }
  }

  return { processed, errors };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Scan a JSONL transcript file for the first substantive user message.
 * Reads in chunks to avoid loading multi-megabyte base64 image lines into
 * memory all at once. Processes complete lines and stops as soon as it finds
 * a user message with actual text content.
 */
function extractAbstractFromJsonl(transcriptPath: string): string {
  const fsSync = require("node:fs");
  const fd = fsSync.openSync(transcriptPath, "r");
  try {
    const stat = fsSync.fstatSync(fd);
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    let offset = 0;
    let remainder = "";
    let userMessagesChecked = 0;

    while (offset < stat.size && userMessagesChecked < 30) {
      const toRead = Math.min(CHUNK_SIZE, stat.size - offset);
      const buf = Buffer.alloc(toRead);
      fsSync.readSync(fd, buf, 0, toRead, offset);
      offset += toRead;

      const chunk = remainder + buf.toString("utf-8");
      const lines = chunk.split("\n");
      // Last element may be incomplete — save for next chunk
      remainder = lines.pop() || "";

      for (const line of lines) {
        // Quick pre-filter: skip lines that can't be user messages
        if (!line.includes('"type":"user"') && !line.includes('"type":"human"')) continue;
        userMessagesChecked++;
        if (userMessagesChecked > 30) break;

        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "human") continue;
          const msg = entry.message;
          if (!msg) continue;

          const result = extractTextFromMessage(msg);
          if (result) return result;
        } catch { /* skip malformed lines */ }
      }
    }
  } finally {
    fsSync.closeSync(fd);
  }

  return "Session transcript (not yet summarized)";
}

/** Extract first substantive text from a user message content field. */
function extractTextFromMessage(msg: { content: string | Array<{ type: string; text?: string }> }): string | null {
  const texts: string[] = [];
  if (typeof msg.content === "string") {
    texts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
  }

  for (const raw of texts) {
    // Strip XML tags (ide_selection, ide_opened_file, system-reminder, etc.)
    const cleaned = raw.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
    if (cleaned.length > 15) {
      return cleaned.length > 150 ? cleaned.slice(0, 147) + "..." : cleaned;
    }
  }
  return null;
}

/** Check if a line looks like tool output rather than user-written text. */
function isToolArtifact(text: string): boolean {
  return /^\d+[→│]/.test(text) || text.startsWith("```") || text.startsWith("#") || text.startsWith("[empty]");
}

function dedupeTopics(topics: string[]): string[] {
  return [...new Set(topics.map((t) => t.toLowerCase().trim()).filter(Boolean))];
}

/**
 * Extract basic metadata from a formatted transcript without an LLM.
 * Used in --raw mode when no API key is available.
 */
function extractRawMetadata(
  formattedChunk: string,
  transcriptPath: string
): { abstract: string; topics: string[]; content: string } {
  // Extract abstract from first substantive user message by parsing raw JSONL.
  // JSONL lines with base64 images can be megabytes, so we scan in chunks
  // and only JSON.parse lines that look like user messages.
  let abstract = "Session transcript (not yet summarized)";
  try {
    abstract = extractAbstractFromJsonl(transcriptPath);
  } catch { /* fall back to default abstract */ }

  // Extract topic from the project directory path
  // e.g. ~/.claude/projects/-Users-dylangnatz-Coding-my-project/abc.jsonl → "my-project"
  const topics: string[] = [];
  const dirName = path.basename(path.dirname(transcriptPath));
  // Claude Code project dirs look like: -Users-name-Coding-project-name
  const segments = dirName.split("-").filter(Boolean);
  if (segments.length >= 3) {
    // Take everything after the path prefix (Users, name, Coding, ...)
    // Find "Coding" or similar marker, take what follows
    const codingIdx = segments.findIndex((s) => /^(coding|projects|repos|src|dev|code)$/i.test(s));
    if (codingIdx >= 0 && codingIdx < segments.length - 1) {
      topics.push(segments.slice(codingIdx + 1).join("-").toLowerCase());
    } else {
      // Fallback: use last 2 segments
      topics.push(segments.slice(-2).join("-").toLowerCase());
    }
  }

  // Use the formatted transcript as the note body, with a header.
  // Cap at 30K chars to prevent massive notes from raw transcript dumps.
  const now = new Date();
  const timestamp = `${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} — ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const cappedChunk = formattedChunk.length > 30_000
    ? formattedChunk.slice(0, 30_000) + "\n\n[... transcript truncated — full content available in raw transcript file]"
    : formattedChunk;
  const content = `## ${timestamp} — Raw transcript capture\n\n> This note was auto-captured before context compaction. It has not been summarized by an LLM yet.\n\n${cappedChunk}`;

  return { abstract, topics, content };
}
