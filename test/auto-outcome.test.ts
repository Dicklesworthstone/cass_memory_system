/**
 * Unit tests for auto-outcome recording in reflect pipeline.
 *
 * Tests the new functions added to outcome.ts:
 * - extractRuleIdsFromTranscript: Extracts bullet IDs from session content
 * - classifySessionOutcome: Classifies session outcome via heuristics
 *
 * And the integration in orchestrator.ts:
 * - Auto-recording outcomes during reflection
 * - Inline feedback extraction during reflection
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import {
  buildTranscriptEvidence,
  classifySessionOutcome,
  detectSentiment,
  extractRuleIdsFromTranscript,
  loadOutcomes,
  scoreImplicitFeedback,
} from "../src/outcome.js";
import { orchestrateReflection, type ReflectionOutcome } from "../src/orchestrator.js";
import { loadPlaybook, savePlaybook } from "../src/playbook.js";
import { CM_SUBPROCESS_PAYLOAD_BEGIN, CM_SUBPROCESS_PAYLOAD_END, tagCmSubprocessPrompt } from "../src/subprocess-tag.js";
import type { DiaryEntry } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withLlmShim } from "./helpers/llm-shim.js";
import { withTempCassHome } from "./helpers/temp.js";

// --- extractRuleIdsFromTranscript ---

describe("extractRuleIdsFromTranscript", () => {
  it("returns empty array for empty/null content", () => {
    expect(extractRuleIdsFromTranscript("")).toEqual([]);
    expect(extractRuleIdsFromTranscript(null as any)).toEqual([]);
    expect(extractRuleIdsFromTranscript(undefined as any)).toEqual([]);
  });

  it("extracts single rule ID", () => {
    const content = "Following rule b-m2x1k5-abc123 for this task";
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-m2x1k5-abc123"]);
  });

  it("extracts multiple rule IDs", () => {
    const content = `
      Using b-m2x1k5-abc123 and b-n3y2l6-def456 from the playbook.
      Also referencing b-o4z3m7-ghi789 for context.
    `;
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("b-m2x1k5-abc123");
    expect(ids).toContain("b-n3y2l6-def456");
    expect(ids).toContain("b-o4z3m7-ghi789");
  });

  it("deduplicates repeated IDs", () => {
    const content = `
      Following b-abc123-xyz for auth. Still using b-abc123-xyz here.
      And b-abc123-xyz again in the conclusion.
    `;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-abc123-xyz"]);
  });

  it("extracts IDs from JSON context output", () => {
    const content = `{"id": "b-m2x1k5-abc123", "content": "Always use strict mode"}`;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-m2x1k5-abc123"]);
  });

  it("extracts IDs from bracketed format", () => {
    const content = `[b-8f3a2c-xyz] ★ Always validate user input (3+ / 0-)`;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-8f3a2c-xyz"]);
  });

  it("extracts IDs from inline feedback comments", () => {
    const content = `
      // [cass: helpful b-8f3a2c] - saved debugging time
      function doStuff() {
        // [cass: harmful b-x7k9p1] - wrong advice
      }
    `;
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toContain("b-8f3a2c");
    expect(ids).toContain("b-x7k9p1");
  });

  it("handles short-form IDs (6+ chars)", () => {
    const content = "Referencing b-abc123 from the playbook";
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-abc123"]);
  });

  it("does not match too-short segments", () => {
    // "b-to" should not match (only 2 chars after b-)
    const content = "going from a-to-b-to-c quickly";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match common words like b-tree, b-tag", () => {
    const content = "Use a b-tree data structure with b-tag elements";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match pure-alpha words like b-spline, b-factor", () => {
    // These are 6+ chars but have no digits — real IDs always have digits
    const content = "Use b-spline curves and compute the b-factor coefficient";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match 5-char segments that could be short words", () => {
    const content = "the b-value and b-point were set";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("lowercases all IDs for consistency", () => {
    const content = "Using B-ABC123-XYZ and b-abc123-xyz";
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toEqual(["b-abc123-xyz"]);
  });

  it("handles content without any rule IDs", () => {
    const content = "Just a normal conversation about coding best practices.";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match UUID fragments (regression for #46)", () => {
    // Session paths often contain canonical UUIDs. The previous regex used
    // `\b` which matched at the boundary between `0` and `b` inside a UUID,
    // yielding a false-positive extraction like `b-9695-acef9cb0bbdc`.
    const content =
      "session at ~/.claude/projects/foo/00b8018e-2cd7-4e0b-9695-acef9cb0bbdc.jsonl mentioned";
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).not.toContain("b-9695-acef9cb0bbdc");
    expect(ids).toEqual([]);
  });

  it("does not match hex-string fragments preceded by hex digits", () => {
    // Belt-and-suspenders: any hex digit ahead of `b-` should block the match.
    const content = "sha 0123456789abcdef0b-cafef00d12 referenced";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("still matches valid bullet IDs adjacent to punctuation/whitespace", () => {
    // Real bullet IDs from Date.now().toString(36) + randomBytes look like this.
    // They typically appear at line start, after whitespace, or after `:`/`[`,
    // none of which are hex digits, so the lookbehind permits them.
    const content = "rule b-mn3ot59c-nny4gb applied";
    expect(extractRuleIdsFromTranscript(content)).toContain("b-mn3ot59c-nny4gb");
  });
});

// --- classifySessionOutcome ---

describe("buildTranscriptEvidence", () => {
  const config = createTestConfig();
  const session = "/tmp/evidence-session.jsonl";
  const first = { role: "user", content: "Apply b-evidence1 to verify the exporter with deterministic fixtures." };
  const second = { role: "user", content: "Apply b-evidence2 to the independent tokenizer requirement." };

  it("keeps per-rule evidence stable across full-history and incremental batches", () => {
    const prefix = buildTranscriptEvidence(session, [first], config, { startRecord: 0, ruleIds: ["b-evidence1"] });
    const whole = buildTranscriptEvidence(session, [first, second], config, {
      startRecord: 0, ruleIds: ["b-evidence1", "b-evidence2"],
    });
    const suffix = buildTranscriptEvidence(session, [first, second], config, {
      startRecord: 1, ruleIds: ["b-evidence1", "b-evidence2"],
    });
    expect(whole[0]).toEqual(prefix[0]);
    expect(suffix).toEqual([whole[1]]);
    expect(suffix[0].ruleId).toBe("b-evidence2");
  });

  it("counts identical-record occurrences over the full stream instead of resetting at the suffix", () => {
    const records = [first, { role: "assistant", content: "Complete." }, first];
    const whole = buildTranscriptEvidence(session, records, config, { startRecord: 0, ruleIds: ["b-evidence1"] });
    const suffix = buildTranscriptEvidence(session, records, config, { startRecord: 2, ruleIds: ["b-evidence1"] });
    expect(whole[0].recordKeys).toHaveLength(2);
    expect(whole[0].recordKeys[0]).not.toBe(whole[0].recordKeys[1]);
    expect(suffix[0].recordKeys).toEqual([whole[0].recordKeys[1]]);
  });

  it("ignores object key order and position shifts while retaining original record differences", () => {
    const record = { ...first, metadata: { a: 1, nested: { x: 1, y: 2 }, b: 2 } };
    const reordered = { metadata: { b: 2, nested: { y: 2, x: 1 }, a: 1 }, content: first.content, role: first.role };
    const options = { startRecord: 0, ruleIds: ["b-evidence1"] };
    const initial = buildTranscriptEvidence(session, [record], config, options);
    expect(buildTranscriptEvidence(session, [second, reordered], config, options)).toEqual(initial);
    expect(buildTranscriptEvidence(session, [{ ...record, content: first.content.toUpperCase() }], config, options))
      .not.toEqual(initial);
  });

  it("keeps raw-record identity across privacy policies but only attributes visible rule mentions", () => {
    const record = { ...first, content: `${first.content} PRIVATE_MARKER` };
    const options = { startRecord: 0, ruleIds: ["b-evidence1"] };
    const stricter = createTestConfig({ sanitization: { ...config.sanitization, extraPatterns: ["PRIVATE_MARKER"] } });
    const initial = buildTranscriptEvidence(session, [record], config, options);
    expect(buildTranscriptEvidence(session, [record], stricter, options)).toEqual(initial);
    expect(JSON.stringify(initial)).not.toContain("PRIVATE_MARKER");
    const hideRule = createTestConfig({ sanitization: { ...config.sanitization, extraPatterns: ["b-evidence1"] } });
    expect(buildTranscriptEvidence(session, [record], hideRule, options)).toEqual([]);
  });

  it("does not attribute metadata, private subprocess payloads, or unrequested rules", () => {
    const records = [
      { role: "user", content: "Ordinary content without any cited rule.", metadata: { ruleId: "b-evidence1" } },
      { role: "user", content: tagCmSubprocessPrompt("Reflect on b-evidence1 in cm's private prompt.") },
      second,
    ];
    expect(buildTranscriptEvidence(session, records, config, { startRecord: 0, ruleIds: ["b-evidence1"] })).toEqual([]);
  });

  it("excludes a payload spanning records even when its marker is before the graded suffix", () => {
    const records = [
      { role: "user", content: CM_SUBPROCESS_PAYLOAD_BEGIN },
      { role: "user", content: "The private prompt contains b-evidence1." },
      { role: "user", content: CM_SUBPROCESS_PAYLOAD_END },
      first,
    ];
    for (const startRecord of [0, 1, 3]) {
      expect(buildTranscriptEvidence(session, records, config, { startRecord, ruleIds: ["b-evidence1"] })).toEqual([]);
    }
  });

  it("canonicalizes session aliases while separating distinct transcript files", async () => {
    await withTempCassHome(async env => {
      const original = path.join(env.home, "original.jsonl");
      const alias = path.join(env.home, "alias.jsonl");
      const distinct = path.join(env.home, "distinct.jsonl");
      await fs.writeFile(original, JSON.stringify(first) + "\n");
      await fs.writeFile(distinct, JSON.stringify(first) + "\n");
      await fs.symlink(original, alias);
      const options = { startRecord: 0, ruleIds: ["b-evidence1"] };
      const initial = buildTranscriptEvidence(original, [first], config, options);
      expect(buildTranscriptEvidence(alias, [first], config, options)).toEqual(initial);
      expect(buildTranscriptEvidence(distinct, [first], config, options)).not.toEqual(initial);
    });
  });

  it("abstains without records or with an empty suffix and rejects invalid boundaries", () => {
    const options = { startRecord: 0, ruleIds: ["b-evidence1"] };
    expect(buildTranscriptEvidence(session, [], config, options)).toEqual([]);
    expect(buildTranscriptEvidence(session, [first], config, { ...options, startRecord: 1 })).toEqual([]);
    for (const startRecord of [-1, 0.5, 2, Number.NaN]) {
      expect(() => buildTranscriptEvidence(session, [first], config, { ...options, startRecord })).toThrow("full record stream");
    }
  });
});

describe("persisted automatic evidence across reflection boundaries", () => {
  type RecordLine = { role: string; content: string; cwd?: string };
  const prefix: RecordLine[] = [
    { role: "user", content: "Follow b-evidence1 to implement the exporter and verify its exact output with deterministic fixtures." },
    { role: "assistant", content: "The exporter is complete and all tests passed. Perfect, thanks!" },
  ];
  const appended = (ruleId: string): RecordLine[] => [
    { role: "user", content: `Follow ${ruleId} to implement a new compression option and verify its independent requirements.` },
    { role: "assistant", content: "The compression option is complete and all tests passed. Perfect, thanks!" },
  ];

  async function withReflection(run: (fixture: {
    workspace: string;
    playbookPath: string;
    beforeReflector: (callback: () => void) => void;
    write: (records: RecordLine[]) => Promise<void>;
    reflect: (options?: { workspace?: string; force?: boolean }) => Promise<ReflectionOutcome>;
    read: () => ReturnType<typeof loadPlaybook>;
    outcomes: () => ReturnType<typeof loadOutcomes>;
  }) => Promise<void>, textOnly = false) {
    await withTempCassHome(async env => {
      const originalCwd = process.cwd();
      const savedEnv = new Map(["CASS_MEMORY_LLM", "CASS_MEMORY_HOME", "CASS_PATH"].map(name => [name, process.env[name]]));
      process.env.CASS_MEMORY_LLM = "none";
      process.env.CASS_MEMORY_HOME = env.cassMemoryDir;
      delete process.env.CASS_PATH;
      try {
        const workspace = path.join(env.home, "project");
        await fs.mkdir(workspace);
        process.chdir(workspace);
        const sessionPath = path.join(env.home, textOnly ? "session.md" : "session.jsonl");
        const config = createTestConfig({
          playbookPath: env.playbookPath, diaryDir: env.diaryDir,
          cassPath: "/__missing__/cass", validationEnabled: false, semanticSearchEnabled: false,
        });
        await savePlaybook(createTestPlaybook([
          createTestBullet({ id: "b-evidence1", content: "Verify exporter output using deterministic fixtures.", state: "active" }),
          createTestBullet({ id: "b-evidence2", content: "Verify tokenizer behavior against its requirements.", state: "active" }),
        ]), config.playbookPath);
        const write = (records: RecordLine[]) => fs.writeFile(sessionPath, records.map(record =>
          textOnly ? record.content : JSON.stringify({ ...record, cwd: workspace }),
        ).join("\n") + "\n");
        await write(prefix);
        let beforeReflector: (() => void) | undefined;
        await withLlmShim({ reflector: () => { beforeReflector?.(); return { deltas: [] }; } }, async io => {
          await run({
            workspace, playbookPath: config.playbookPath, write,
            beforeReflector: callback => { beforeReflector = callback; },
            reflect: options => orchestrateReflection(config, { session: sessionPath, io, ...options }),
            read: () => loadPlaybook(config.playbookPath),
            outcomes: () => loadOutcomes(config, 100, workspace),
          });
        });
      } finally {
        process.chdir(originalCwd);
        for (const [name, value] of savedEnv) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }, "automatic-evidence-reflection");
  }

  it.each(["global first", "workspace first"])("does not count unchanged history twice (%s)", async order => {
    await withReflection(async ({ workspace, reflect, read, outcomes }) => {
      const scoped = { workspace };
      const first = await reflect(order === "global first" ? {} : scoped);
      const second = await reflect(order === "global first" ? scoped : {});
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
      expect(first.autoOutcome?.feedbackApplied).toBe(1);
      expect(second.autoOutcome?.feedbackApplied).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 0]);
      expect(await outcomes()).toHaveLength(2);
      for (const options of [{ force: true }, { workspace, force: true }]) {
        expect((await reflect(options)).errors).toEqual([]);
      }
      expect((await read()).bullets[0].feedbackEvents).toHaveLength(1);
      expect(await outcomes()).toHaveLength(2);
    });
  });

  it("credits only the newly mentioned rule across overlapping global and workspace history", async () => {
    await withReflection(async ({ workspace, write, reflect, read }) => {
      expect((await reflect()).autoOutcome?.feedbackApplied).toBe(1);
      await write([...prefix, ...appended("b-evidence2")]);
      expect((await reflect({ workspace })).autoOutcome?.feedbackApplied).toBe(1);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 1]);
      expect((await reflect()).autoOutcome?.feedbackApplied).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 1]);
    });
  });

  it("credits genuine appended use of the same rule once even when both logs reflect it", async () => {
    await withReflection(async ({ workspace, write, reflect, read }) => {
      expect((await reflect()).autoOutcome?.feedbackApplied).toBe(1);
      await write([...prefix, ...appended("b-evidence1")]);
      expect((await reflect({ force: true })).autoOutcome?.feedbackApplied).toBe(1);
      expect((await reflect({ workspace })).autoOutcome?.feedbackApplied).toBe(0);
      expect((await reflect({ force: true })).errors).toEqual([]);
      const bullet = (await read()).bullets[0];
      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.feedbackEvents).toHaveLength(2);
      expect(new Set(bullet.feedbackEvents.flatMap(event => event.transcriptEvidenceKeys ?? [])).size).toBe(2);
    });
  });

  it("does not grade shifted old turns when a forced transcript has been rewritten", async () => {
    await withReflection(async ({ write, reflect, read, outcomes }) => {
      expect((await reflect()).autoOutcome?.feedbackApplied).toBe(1);
      await write([
        { role: "user", content: "A transport header was inserted before the unchanged transcript." },
        { role: "assistant", content: "Only the transcript container changed; no new task was performed." },
        ...prefix,
      ]);
      const forced = await reflect({ force: true });
      expect(forced.errors).toEqual([]);
      expect(forced.sessionsProcessed).toBe(1);
      expect((await read()).bullets[0].helpfulCount).toBe(1);
      // A rewrite does not establish a new grading boundary, even when the
      // evidence key layer would also prevent a duplicate feedback event.
      expect(await outcomes()).toHaveLength(1);
    });
  });

  it("abstains from automatic feedback when no original structured records are available", async () => {
    await withReflection(async ({ reflect, read, outcomes }) => {
      const result = await reflect();
      expect(result.errors).toEqual([]);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.autoOutcome?.feedbackApplied ?? 0).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([0, 0]);
      expect((await outcomes()).every(record => record.transcriptEvidence?.length === 0)).toBe(true);
    }, true);
  });

  it("excludes a foreign workspace rule while crediting applicable global guidance", async () => {
    await withReflection(async ({ workspace, playbookPath, write, reflect, read, outcomes }) => {
      const foreignWorkspace = path.join(path.dirname(workspace), "foreign-project");
      await fs.mkdir(foreignWorkspace);
      const playbook = await read();
      playbook.bullets[0].scope = "workspace";
      playbook.bullets[0].workspace = foreignWorkspace;
      await savePlaybook(playbook, playbookPath);
      await write([
        { ...prefix[0], content: `${prefix[0].content} Also follow the applicable global rule b-evidence2.` },
        prefix[1],
      ]);

      const result = await reflect();
      expect(result.errors).toEqual([]);
      expect(result.autoOutcome?.feedbackApplied).toBe(1);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([0, 1]);
      const recorded = await outcomes();
      expect(recorded).toHaveLength(1);
      expect(recorded[0].rulesUsed).toEqual(["b-evidence2"]);
      expect(recorded[0].ruleTargets).toEqual([{ ruleId: "b-evidence2", playbookPath }]);
      expect(recorded[0].transcriptEvidence?.map(entry => entry.ruleId)).toEqual(["b-evidence2"]);
    });
  });

  it("pins automatic feedback to the observed owner when a repository adds a shadowing ID during reflection", async () => {
    await withReflection(async ({ workspace, playbookPath, beforeReflector, reflect, read, outcomes }) => {
      expect(Bun.spawnSync(["git", "init", "--quiet", workspace]).exitCode).toBe(0);
      const repoPath = path.join(workspace, ".cass", "playbook.yaml");
      await fs.mkdir(path.dirname(repoPath));
      await savePlaybook(createTestPlaybook([]), repoPath);
      beforeReflector(() => {
        // The snapshot already contains the global rule. Simulate another
        // writer introducing an unrelated local owner before preparation.
        writeFileSync(repoPath, yaml.stringify(createTestPlaybook([createTestBullet({
          id: "b-evidence1", content: "A new unrelated repository instruction.", state: "active",
        })])));
      });

      const result = await reflect();
      expect(result.errors).toEqual([]);
      expect(result.autoOutcome?.feedbackApplied).toBe(1);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 0]);
      expect((await loadPlaybook(repoPath)).bullets[0].helpfulCount).toBe(0);
      const recorded = await outcomes();
      expect(recorded).toHaveLength(1);
      expect(recorded[0].ruleTargets).toEqual([{ ruleId: "b-evidence1", playbookPath }]);
    });
  });
});

function makeDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: "test-diary-1",
    sessionPath: "/path/to/session.jsonl",
    timestamp: new Date().toISOString(),
    agent: "claude",
    status: "success",
    accomplishments: ["Fixed the login bug"],
    decisions: [],
    challenges: [],
    preferences: [],
    keyLearnings: ["Always check null pointers"],
    relatedSessions: [],
    tags: [],
    searchAnchors: [],
    ...overrides,
  };
}

describe("classifySessionOutcome", () => {
  it("returns null when no rule IDs provided", () => {
    const result = classifySessionOutcome("some content", makeDiary(), []);
    expect(result).toBeNull();
  });

  it("maps diary success status to success outcome", () => {
    const content = "Everything went smoothly, thanks!";
    const result = classifySessionOutcome(content, makeDiary({ status: "success" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("success");
    expect(result!.sentiment).toBe("positive");
  });

  it("maps diary failure status to failure outcome", () => {
    const content = "That doesn't work at all, try again";
    const result = classifySessionOutcome(content, makeDiary({ status: "failure" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("failure");
    expect(result!.sentiment).toBe("negative");
  });

  it("maps diary mixed status to mixed outcome", () => {
    const content = "Partially done, some issues remain";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("mixed");
  });

  it("includes all rule IDs in rulesUsed", () => {
    const ruleIds = ["b-abc123", "b-def456", "b-ghi789"];
    const result = classifySessionOutcome("good work", makeDiary(), ruleIds);
    expect(result!.rulesUsed).toEqual(ruleIds);
  });

  it("detects errors in content", () => {
    const content = `
      Error: Cannot read property 'x' of undefined
      Error: Connection refused
      Exception thrown at line 42
      Failed to compile module
    `;
    const result = classifySessionOutcome(content, makeDiary({ status: "failure" }), ["b-abc123"]);
    expect(result!.errorCount).toBeGreaterThan(0);
  });

  it("detects retries in content", () => {
    const content = "Let me try again with a different approach. Retrying the build now.";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result!.hadRetries).toBe(true);
  });

  it("detects tool rejections in content", () => {
    const content = "The user denied the tool call. Permission denied for file write.";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result!.errorCount).toBeGreaterThan(0);
  });

  it("uses tail of content for sentiment (more recent is more relevant)", () => {
    // Negative at the start, positive at the end
    const content = "That doesn't work. " + "x".repeat(5000) + " Thanks, looks good!";
    const result = classifySessionOutcome(content, makeDiary(), ["b-abc123"]);
    // The tail should capture the positive sentiment
    expect(result!.sentiment).toBe("positive");
  });

  it("uses first accomplishment as task", () => {
    const diary = makeDiary({ accomplishments: ["Implemented OAuth flow", "Added tests"] });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.task).toBe("Implemented OAuth flow");
  });

  it("falls back to keyLearnings when no accomplishments", () => {
    const diary = makeDiary({
      accomplishments: [],
      keyLearnings: ["TypeScript generics are tricky"],
    });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.task).toBe("TypeScript generics are tricky");
  });

  it("includes sessionId from diary", () => {
    const diary = makeDiary({ sessionPath: "/sessions/test-session.jsonl" });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.sessionId).toBe("/sessions/test-session.jsonl");
  });

  it("includes duration from diary", () => {
    const diary = makeDiary({ duration: 300 });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.durationSec).toBe(300);
  });

  it("marks the outcome as auto-graded (rules were harvested, not cited) [#56]", () => {
    // Auto-extracted rule sets are largely the rules `cm context` injected, so
    // the classified outcome must carry autoGraded:true to trigger the stricter
    // harm-attribution policy / blast-radius guard in scoreImplicitFeedback.
    const result = classifySessionOutcome("done", makeDiary(), ["b-abc123", "b-def456"]);
    expect(result!.autoGraded).toBe(true);
  });

  it("does not condemn the injected rule set on a mixed/error session [#56]", () => {
    // End-to-end through the auto path: a mixed session that injected many rules
    // and hit a couple of error mentions must not yield a harmful verdict.
    const injected = Array.from({ length: 30 }, (_, i) => `b-inject${i}0`);
    const content = "Working... Error: boom\nError: boom again\n" + injected.join(" ");
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), injected);
    expect(result!.autoGraded).toBe(true);
    const scored = scoreImplicitFeedback(result!);
    expect(scored?.type).not.toBe("harmful");
  });
});

// --- Enhanced detectSentiment ---

describe("detectSentiment (enhanced patterns)", () => {
  it("detects 'lgtm' as positive", () => {
    expect(detectSentiment("LGTM, ship it!")).toBe("positive");
  });

  it("detects 'looks good' as positive", () => {
    expect(detectSentiment("This looks good to me")).toBe("positive");
  });

  it("detects 'nice work' as positive", () => {
    expect(detectSentiment("Nice work on this fix")).toBe("positive");
  });

  it("detects 'well done' as positive", () => {
    expect(detectSentiment("Well done!")).toBe("positive");
  });

  it("detects 'ship it' as positive", () => {
    expect(detectSentiment("Ship it!")).toBe("positive");
  });

  it("detects 'revert' as negative", () => {
    expect(detectSentiment("We need to revert this change")).toBe("negative");
  });

  it("detects 'don't do that' as negative", () => {
    expect(detectSentiment("Don't do that again")).toBe("negative");
  });

  it("detects 'that's not right' as negative", () => {
    expect(detectSentiment("That's not right at all")).toBe("negative");
  });

  it("detects 'start over' as negative", () => {
    expect(detectSentiment("Let's start over from scratch")).toBe("negative");
  });

  it("detects 'rollback' as negative", () => {
    expect(detectSentiment("We need to rollback the deploy")).toBe("negative");
  });
});
