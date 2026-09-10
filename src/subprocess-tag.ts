// src/subprocess-tag.ts
//
// Tagging for cm's own LLM subprocess calls (#76).
//
// On `provider: cli`, every LLM call cm makes is a `claude -p` / `codex` /
// `gemini` invocation. Claude Code persists print-mode calls as ordinary
// session transcripts under `~/.claude/projects/<cwd-slug>/`, cass indexes
// those, and the next `cm reflect` then treats each two-message "extract diary
// JSON" / "run reflector" / "validate rule" call as a real work session. It
// extracts rules from cm's own prompts and auto-records outcomes against every
// bullet id the reflector prompt embedded — a closed self-grading loop.
//
// The fix is to TAG cm's own calls at spawn time so they can be recognised with
// certainty, rather than guessing from message counts or prompt shapes:
//
//  1. Path tag  — the subprocess runs in a dedicated cm-owned cwd, so its
//     transcripts land in one deterministic `~/.claude/projects/<slug>/`
//     directory that session discovery excludes unconditionally.
//  2. Payload tag — the prompt is bracketed with private marker tokens that cm
//     never writes to stdout, a log, or a playbook. Any transcript containing
//     them is a cm subprocess call. This is what covers CLI tools that do not
//     key their transcript location on the cwd (codex, gemini).
//  3. Env tag   — `CASS_MEMORY_LLM_SUBPROCESS=1` is exported into the child.
//     cm itself does not branch on this; it is there so a user's own agent
//     hooks can recognise, and cheaply opt out of, a cm-internal invocation.
//
// This module deliberately has no imports from the rest of cm so that both the
// LLM layer and the cass/session layer can depend on it without a cycle.

import os from "node:os";
import path from "node:path";

/** Env var exported into every cm LLM subprocess. */
export const CM_SUBPROCESS_ENV_VAR = "CASS_MEMORY_LLM_SUBPROCESS";
export const CM_SUBPROCESS_ENV_VALUE = "1";

/**
 * Private bracket tokens wrapped around the prompt payload cm pipes to a CLI
 * tool. The random-looking suffix is fixed on purpose: it must stay stable
 * across versions so transcripts written by an older cm are still recognised.
 *
 * These tokens are never printed by cm, never stored in a playbook, and never
 * appear in cm's own output — so their presence in a session transcript means
 * that transcript came from a cm subprocess call.
 */
export const CM_SUBPROCESS_PAYLOAD_BEGIN =
  "[[CASS-MEMORY-LLM-PAYLOAD-BEGIN:6f1d29a4-cm-internal]]";
export const CM_SUBPROCESS_PAYLOAD_END =
  "[[CASS-MEMORY-LLM-PAYLOAD-END:6f1d29a4-cm-internal]]";

/**
 * Default working directory for cm's LLM subprocesses.
 *
 * Anything under `~/.cass-memory/` is cm-owned, so a real user project can
 * never legitimately live here — which is what makes the derived transcript
 * directory safe to exclude unconditionally. Contrast with excluding the whole
 * `-home-<user>` slug, which would also drop the sessions of anyone whose
 * project cwd genuinely is `$HOME`.
 */
export const DEFAULT_CLI_SUBPROCESS_CWD = "~/.cass-memory/llm-subprocess-cwd";

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** Local `~` expansion; kept here so this module stays import-free. */
function expandHome(p: string): string {
  if (!p) return "";
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return path.join(homeDir(), p.slice(2));
  if (p.startsWith("~")) return path.join(homeDir(), p.slice(1));
  return p;
}

/** True for values `resolveCliSubprocessCwd` can turn into a stable directory. */
export function isValidCliSubprocessCwd(value: string): boolean {
  const raw = value.trim();
  if (raw === "") return true; // explicit opt-out
  return raw.startsWith("~") || path.isAbsolute(raw);
}

/**
 * Resolve the absolute cwd cm should run its LLM subprocesses in.
 *
 * An empty/whitespace-only configured value means "inherit cm's own cwd" —
 * the pre-#76 behaviour, kept as an escape hatch for anyone whose CLI tool
 * misbehaves in a fresh directory. In that mode only the payload tag applies.
 *
 * A relative value is rejected rather than resolved: `path.resolve` would key
 * it to whatever cwd cm happened to be launched from, so the derived transcript
 * slug would differ between a cron run and an interactive run and the exclusion
 * would silently stop matching. The config schema rejects these with a message;
 * this fallback keeps a hand-built Config (tests, embedders) on the default.
 */
export function resolveCliSubprocessCwd(configured?: string): string | null {
  const raw = typeof configured === "string" ? configured.trim() : undefined;
  if (raw === "") return null;
  const chosen = raw && isValidCliSubprocessCwd(raw) ? raw : DEFAULT_CLI_SUBPROCESS_CWD;
  return path.resolve(expandHome(chosen));
}

/**
 * Reproduce the slug agent CLIs derive from a working directory when they name
 * the per-project transcript folder (`~/.claude/projects/<slug>/`): every
 * character outside `[A-Za-z0-9]` becomes `-`, case preserved.
 */
export function slugifyProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Path fragments that identify a transcript written by a cm LLM subprocess.
 *
 * Matching is done on the slug as a whole path segment (`/<slug>/`) so a real
 * project whose name merely *starts with* the slug cannot be excluded by
 * accident. Callers compare against a forward-slash-normalised path, so one
 * fragment covers both separator styles.
 *
 * Verified against a real `claude -p` run on macOS: cwd
 * `~/.cass-memory/llm-subprocess-cwd` produced exactly
 * `~/.claude/projects/-Users-<user>--cass-memory-llm-subprocess-cwd/`.
 * The Windows slug shape is inferred, not measured — the payload marker is
 * what actually carries the tag there.
 */
export function cmSubprocessPathFragments(configuredCwd?: string): string[] {
  const cwd = resolveCliSubprocessCwd(configuredCwd);
  if (!cwd) return [];
  const slug = slugifyProjectDir(cwd);
  if (!slug) return [];
  return [`/${slug}/`];
}

/** True when `sessionPath` is a transcript produced by a cm LLM subprocess. */
export function isCmSubprocessTranscriptPath(
  sessionPath: string,
  configuredCwd?: string
): boolean {
  if (!sessionPath) return false;
  // Normalise Windows separators so a single comparison covers both shapes.
  const normalized = sessionPath.replace(/\\/g, "/");
  return cmSubprocessPathFragments(configuredCwd).some((f) => normalized.includes(f));
}

/** True when transcript text carries cm's private payload marker. */
export function containsCmSubprocessPayload(content: string): boolean {
  if (!content) return false;
  return content.includes(CM_SUBPROCESS_PAYLOAD_BEGIN);
}

/**
 * Remove every cm-authored prompt payload from transcript text.
 *
 * Used before scraping playbook rule ids for auto-graded outcomes: a bullet id
 * that appears only inside a prompt cm itself wrote was never "used" by an
 * agent, so it must not earn a helpful/harmful event (#76).
 *
 * An unterminated BEGIN (truncated transcript, or a tool that only captured the
 * head of the prompt) strips to the end of the text — erring towards dropping
 * cm's own content rather than grading it.
 */
export function stripCmSubprocessPayloads(content: string): string {
  if (!content || !content.includes(CM_SUBPROCESS_PAYLOAD_BEGIN)) return content;

  let out = "";
  let cursor = 0;

  while (cursor < content.length) {
    const begin = content.indexOf(CM_SUBPROCESS_PAYLOAD_BEGIN, cursor);
    if (begin === -1) {
      out += content.slice(cursor);
      break;
    }
    out += content.slice(cursor, begin);

    const endToken = content.indexOf(
      CM_SUBPROCESS_PAYLOAD_END,
      begin + CM_SUBPROCESS_PAYLOAD_BEGIN.length
    );
    if (endToken === -1) break; // unterminated: drop the remainder
    cursor = endToken + CM_SUBPROCESS_PAYLOAD_END.length;
  }

  return out;
}

/**
 * Wrap a prompt in the payload markers before it is piped to a CLI tool.
 *
 * The markers bracket only the caller's prompt — the JSON-output instructions
 * `cliGenerateObject` appends stay outside, so the last thing the model reads is
 * still "output only the JSON object".
 */
export function tagCmSubprocessPrompt(prompt: string): string {
  return [CM_SUBPROCESS_PAYLOAD_BEGIN, prompt, CM_SUBPROCESS_PAYLOAD_END].join("\n");
}
