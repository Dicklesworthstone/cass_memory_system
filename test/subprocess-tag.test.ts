// Regression tests for #76: `cm reflect` must not ingest transcripts of its
// own `claude -p` / codex / gemini subprocess calls.
//
// The tag is established at spawn time (a cm-owned cwd + a private payload
// marker piped with the prompt), so these tests assert on the tag rather than
// on any "looks internal" heuristic.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import {
  CM_SUBPROCESS_PAYLOAD_BEGIN,
  CM_SUBPROCESS_PAYLOAD_END,
  DEFAULT_CLI_SUBPROCESS_CWD,
  containsCmSubprocessPayload,
  cmSubprocessPathFragments,
  isCmSubprocessTranscriptPath,
  isValidCliSubprocessCwd,
  resolveCliSubprocessCwd,
  slugifyProjectDir,
  stripCmSubprocessPayloads,
  tagCmSubprocessPrompt,
} from "../src/subprocess-tag.js";
import { findUnprocessedSessions, type CassRunner } from "../src/cass.js";
import { extractRuleIdsFromTranscript } from "../src/outcome.js";
import { ConfigSchema } from "../src/types.js";

const HOME = process.env.HOME || os.homedir();

/** The transcript directory an agent CLI creates for cm's own subprocess cwd. */
function defaultSubprocessSlug(): string {
  return slugifyProjectDir(path.join(HOME, ".cass-memory", "llm-subprocess-cwd"));
}

function timelineRunner(sessions: Array<{ path: string; agent?: string }>): CassRunner {
  const output = JSON.stringify({
    groups: [
      {
        date: "2026-09-09",
        sessions: sessions.map((s, i) => ({
          path: s.path,
          agent: s.agent ?? "claude_code",
          message_count: 4,
          start_time: `0${i}:00`,
          end_time: `0${i}:30`,
        })),
      },
    ],
  });
  return {
    execFile: async () => ({ stdout: output, stderr: "" }),
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
  } as unknown as CassRunner;
}

describe("#76 subprocess tagging — slug derivation", () => {
  it("reproduces the agent-CLI project-directory slug (every non-alnum char becomes '-')", () => {
    // Verified against a real `claude -p` run: cwd
    // /Users/<u>/.cass-memory/llm-subprocess-cwd produced the transcript
    // directory ~/.claude/projects/-Users-<u>--cass-memory-llm-subprocess-cwd/
    expect(slugifyProjectDir("/home/ubuntu/.cass-memory/llm-subprocess-cwd")).toBe(
      "-home-ubuntu--cass-memory-llm-subprocess-cwd"
    );
    expect(slugifyProjectDir("/Users/j/projects/cass_memory_system")).toBe(
      "-Users-j-projects-cass-memory-system"
    );
    expect(slugifyProjectDir("/Users/j/projects/asimposium.org")).toBe(
      "-Users-j-projects-asimposium-org"
    );
  });

  it("defaults to a cm-owned directory and expands ~", () => {
    expect(DEFAULT_CLI_SUBPROCESS_CWD).toBe("~/.cass-memory/llm-subprocess-cwd");
    expect(resolveCliSubprocessCwd(undefined)).toBe(
      path.join(HOME, ".cass-memory", "llm-subprocess-cwd")
    );
    expect(resolveCliSubprocessCwd("~/.cass-memory/other")).toBe(
      path.join(HOME, ".cass-memory", "other")
    );
  });

  it("rejects a relative cwd, which would produce a different slug per launch directory", () => {
    expect(isValidCliSubprocessCwd("~/.cass-memory/llm-subprocess-cwd")).toBe(true);
    expect(isValidCliSubprocessCwd("/var/lib/cm/llm")).toBe(true);
    expect(isValidCliSubprocessCwd("")).toBe(true);
    expect(isValidCliSubprocessCwd("llm-cwd")).toBe(false);
    expect(isValidCliSubprocessCwd("./llm-cwd")).toBe(false);
    expect(isValidCliSubprocessCwd("../llm-cwd")).toBe(false);

    // The config schema rejects it outright...
    expect(ConfigSchema.safeParse({ cliSubprocessCwd: "./llm-cwd" }).success).toBe(false);
    // ...and a hand-built Config falls back to the default rather than to a
    // path that moves with process.cwd().
    expect(resolveCliSubprocessCwd("./llm-cwd")).toBe(
      path.join(HOME, ".cass-memory", "llm-subprocess-cwd")
    );
  });

  it("accepts the default config and keeps the documented default value", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.cliSubprocessCwd).toBe(DEFAULT_CLI_SUBPROCESS_CWD);
    // The literal shipped in sessionExcludePatterns must match the real slug.
    const slug = defaultSubprocessSlug();
    const shipped = parsed.sessionExcludePatterns.find((p) =>
      p.includes("cass-memory-llm-subprocess-cwd")
    );
    expect(shipped).toBeDefined();
    expect(`${HOME}/.claude/projects/${slug}/x.jsonl`.toLowerCase()).toContain(
      shipped!.toLowerCase()
    );
  });

  it("treats an empty configured cwd as 'inherit cm's cwd' and emits no path tag", () => {
    expect(resolveCliSubprocessCwd("")).toBeNull();
    expect(resolveCliSubprocessCwd("   ")).toBeNull();
    expect(cmSubprocessPathFragments("")).toEqual([]);
    expect(isCmSubprocessTranscriptPath("/anything/at/all.jsonl", "")).toBe(false);
  });
});

describe("#76 subprocess tagging — path recognition", () => {
  const slug = defaultSubprocessSlug();

  it("recognises a transcript written by a cm subprocess call", () => {
    const p = `${HOME}/.claude/projects/${slug}/1b9b154e-5c58-42c9-86fe-6da074c33682.jsonl`;
    expect(isCmSubprocessTranscriptPath(p, undefined)).toBe(true);
  });

  it("recognises the same path with Windows separators", () => {
    const p = `C:\\Users\\u\\.claude\\projects\\${slug}\\abc.jsonl`;
    expect(isCmSubprocessTranscriptPath(p, undefined)).toBe(true);
  });

  it("does NOT match a real project whose slug merely contains the marker as a prefix", () => {
    // The fragment is anchored as a whole path segment, so a sibling directory
    // that starts with the same characters is left alone.
    const p = `${HOME}/.claude/projects/${slug}-user-notes/abc.jsonl`;
    expect(isCmSubprocessTranscriptPath(p, undefined)).toBe(false);
  });

  it("does NOT match an ordinary session, including one whose cwd is $HOME", () => {
    // The reporter's workaround excluded the whole `-home-ubuntu` slug, which
    // also drops the sessions of anyone whose project cwd genuinely is $HOME.
    expect(isCmSubprocessTranscriptPath("/home/ubuntu/.claude/projects/-home-ubuntu/s.jsonl", undefined)).toBe(false);
    expect(isCmSubprocessTranscriptPath("/home/u/.claude/projects/-home-u-projects-app/s.jsonl", undefined)).toBe(false);
    expect(isCmSubprocessTranscriptPath("", undefined)).toBe(false);
  });

  it("follows a relocated cliSubprocessCwd", () => {
    const custom = "~/.cass-memory/elsewhere";
    const customSlug = slugifyProjectDir(path.join(HOME, ".cass-memory", "elsewhere"));
    expect(isCmSubprocessTranscriptPath(`${HOME}/.claude/projects/${customSlug}/x.jsonl`, custom)).toBe(true);
    // ...and stops matching the default location once moved.
    expect(isCmSubprocessTranscriptPath(`${HOME}/.claude/projects/${slug}/x.jsonl`, custom)).toBe(false);
  });
});

describe("#76 session discovery excludes cm's own subprocess transcripts", () => {
  const slug = defaultSubprocessSlug();
  const ownPath = `${HOME}/.claude/projects/${slug}/aaaa.jsonl`;
  const realPath = `${HOME}/.claude/projects/-home-ubuntu/bbbb.jsonl`;

  it("drops a cm subprocess transcript and keeps a genuine session beside it", async () => {
    const runner = timelineRunner([{ path: ownPath }, { path: realPath }]);
    const result = await findUnprocessedSessions(new Set(), {}, "cass", runner);
    expect(result.map((s) => s.path)).toEqual([realPath]);
  });

  it("keeps excluding them under sessionIncludeAll (the loop must not be re-openable)", async () => {
    const runner = timelineRunner([{ path: ownPath }, { path: realPath }]);
    const result = await findUnprocessedSessions(
      new Set(),
      { includeAll: true, excludePatterns: [] },
      "cass",
      runner
    );
    expect(result.map((s) => s.path)).toEqual([realPath]);
  });

  it("keeps excluding them when a config pins its own sessionExcludePatterns", async () => {
    const runner = timelineRunner([{ path: ownPath }, { path: realPath }]);
    const result = await findUnprocessedSessions(
      new Set(),
      { excludePatterns: ["something-unrelated"] },
      "cass",
      runner
    );
    expect(result.map((s) => s.path)).toEqual([realPath]);
  });

  it("does not consume the maxSessions budget with cm's own transcripts", async () => {
    const own = Array.from({ length: 5 }, (_, i) => ({
      path: `${HOME}/.claude/projects/${slug}/own-${i}.jsonl`,
    }));
    const runner = timelineRunner([...own, { path: realPath }]);
    const result = await findUnprocessedSessions(new Set(), { maxSessions: 5 }, "cass", runner);
    expect(result.map((s) => s.path)).toEqual([realPath]);
  });

  it("still discovers genuine sessions when cliSubprocessCwd is disabled", async () => {
    const runner = timelineRunner([{ path: ownPath }, { path: realPath }]);
    const result = await findUnprocessedSessions(new Set(), { cliSubprocessCwd: "" }, "cass", runner);
    expect(result.map((s) => s.path)).toEqual([ownPath, realPath]);
  });
});

describe("#76 payload marker", () => {
  it("brackets the prompt and leaves the JSON instruction outside", () => {
    const tagged = tagCmSubprocessPrompt("REFLECTOR PROMPT\nb-abc123 rule text");
    expect(tagged.startsWith(CM_SUBPROCESS_PAYLOAD_BEGIN)).toBe(true);
    expect(tagged.endsWith(CM_SUBPROCESS_PAYLOAD_END)).toBe(true);
    expect(containsCmSubprocessPayload(tagged)).toBe(true);
  });

  it("does not fire on an ordinary transcript", () => {
    expect(containsCmSubprocessPayload("I ran cm reflect and it worked, b-abc123 helped")).toBe(false);
    expect(containsCmSubprocessPayload("")).toBe(false);
  });

  it("strips the payload region, leaving surrounding real content intact", () => {
    const content = [
      "user: real work before",
      tagCmSubprocessPrompt("playbook: b-aaa111, b-bbb222"),
      "assistant: real work after",
    ].join("\n");
    const stripped = stripCmSubprocessPayloads(content);
    expect(stripped).toContain("real work before");
    expect(stripped).toContain("real work after");
    expect(stripped).not.toContain("b-aaa111");
    expect(stripped).not.toContain(CM_SUBPROCESS_PAYLOAD_BEGIN);
  });

  it("strips every payload when a transcript holds several calls", () => {
    const content = [
      tagCmSubprocessPrompt("diary prompt b-aaa111"),
      "keep me",
      tagCmSubprocessPrompt("reflector prompt b-bbb222"),
      "keep me too",
    ].join("\n");
    const stripped = stripCmSubprocessPayloads(content);
    expect(stripped).toContain("keep me");
    expect(stripped).toContain("keep me too");
    expect(stripped).not.toContain("b-aaa111");
    expect(stripped).not.toContain("b-bbb222");
  });

  it("drops the remainder when a payload is truncated mid-transcript", () => {
    const content = `real work\n${CM_SUBPROCESS_PAYLOAD_BEGIN}\nplaybook b-ccc333 (cut off here`;
    const stripped = stripCmSubprocessPayloads(content);
    expect(stripped).toContain("real work");
    expect(stripped).not.toContain("b-ccc333");
  });

  it("returns untagged content unchanged", () => {
    const content = "plain transcript citing b-ddd444";
    expect(stripCmSubprocessPayloads(content)).toBe(content);
  });
});

describe("#76 auto-outcome guard", () => {
  it("does not grade rule ids that appear only inside cm's own prompt payload", () => {
    // This is the measured symptom: the reflector prompt embeds the whole
    // playbook, so every bullet id looked 'cited' and earned an outcome.
    const transcript = [
      "user: fix the flaky test",
      tagCmSubprocessPrompt(
        "Existing playbook:\n- b-aaa111 always run the linter\n- b-bbb222 prefer explicit imports"
      ),
      "assistant: done",
    ].join("\n");

    expect(extractRuleIdsFromTranscript(transcript).sort()).toEqual(["b-aaa111", "b-bbb222"]);
    expect(extractRuleIdsFromTranscript(stripCmSubprocessPayloads(transcript))).toEqual([]);
  });

  it("still grades a rule id the agent actually cited outside the payload", () => {
    const transcript = [
      "user: fix the flaky test",
      "assistant: following b-aaa111, running the linter first",
      tagCmSubprocessPrompt("Existing playbook:\n- b-aaa111 always run the linter\n- b-bbb222 prefer explicit imports"),
    ].join("\n");

    expect(extractRuleIdsFromTranscript(stripCmSubprocessPayloads(transcript))).toEqual(["b-aaa111"]);
  });
});
