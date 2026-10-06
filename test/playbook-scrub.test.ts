/**
 * Tests for `cm playbook scrub` (#77): removing feedback events and source
 * references by session path, with rescoring and backups.
 */
import { describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { playbookCommand } from "../src/commands/playbook.js";
import { scrubFeedbackFromSessions, sessionPathMatcher } from "../src/playbook.js";
import {
  cmSubprocessPathFragments,
  DEFAULT_CLI_SUBPROCESS_CWD,
  resolveCliSubprocessCwd,
  slugifyProjectDir,
} from "../src/subprocess-tag.js";
import type { FeedbackEvent } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

const NOW = new Date().toISOString();
const POLLUTED = "/home/u/.claude/projects/-home-u--cass-memory-llm-subprocess-cwd/abc.jsonl";
const GENUINE = "/home/u/.claude/projects/-home-u-work-app/def.jsonl";

function ev(type: "helpful" | "harmful", sessionPath?: string): FeedbackEvent {
  return { type, timestamp: NOW, ...(sessionPath ? { sessionPath } : {}) } as FeedbackEvent;
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

/** Run with cwd outside any git repo, so only the temp global playbook is a target. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

describe("sessionPathMatcher", () => {
  it("matches plain patterns as substrings", () => {
    const m = sessionPathMatcher("llm-subprocess-cwd");
    expect(m(POLLUTED)).toBe(true);
    expect(m(GENUINE)).toBe(false);
  });

  it("matches '*' patterns as whole-path globs", () => {
    const m = sessionPathMatcher("*/-home-u-work-app/*.jsonl");
    expect(m(GENUINE)).toBe(true);
    expect(m(POLLUTED)).toBe(false);
    expect(sessionPathMatcher("work-app*")(GENUINE)).toBe(false); // anchored
  });

  it("escapes regex metacharacters and normalises Windows separators", () => {
    expect(sessionPathMatcher("C:\\Users\\me\\proj (1)\\*")("C:/Users/me/proj (1)/x.jsonl")).toBe(
      true,
    );
    expect(sessionPathMatcher("a.b")("axb")).toBe(false);
  });
});

describe("scrubFeedbackFromSessions", () => {
  const config = createTestConfig();
  const matches = sessionPathMatcher("llm-subprocess-cwd");

  it("removes matching events, recounts, and re-derives maturity", () => {
    const mixed = createTestBullet({
      id: "mixed",
      maturity: "proven",
      helpfulCount: 12,
      feedbackEvents: [
        ...Array.from({ length: 10 }, () => ev("helpful", POLLUTED)),
        ev("helpful", GENUINE),
        ev("harmful", GENUINE),
      ],
      harmfulCount: 1,
    });
    const untouched = createTestBullet({ id: "clean", feedbackEvents: [ev("helpful", GENUINE)] });
    const playbook = createTestPlaybook([mixed, untouched]);

    const result = scrubFeedbackFromSessions(playbook, matches, config);

    expect(result.bulletsTouched).toBe(1);
    expect(result.eventsRemoved).toBe(10);
    expect(result.bullets.map((b) => b.id)).toEqual(["mixed"]);
    const after = playbook.bullets.find((b) => b.id === "mixed")!;
    expect(after.feedbackEvents).toHaveLength(2);
    expect(after.helpfulCount).toBe(1);
    expect(after.harmfulCount).toBe(1);
    expect(after.maturity).toBe("candidate"); // 2 events < minFeedbackForActive
    const report = result.bullets[0];
    expect(report.maturity).toEqual({ before: "proven", after: "candidate" });
    expect(report.effectiveScore.after).toBeLessThan(report.effectiveScore.before);
    expect(report.noRemainingFeedback).toBe(false);
    // Clean bullet unchanged
    expect(playbook.bullets.find((b) => b.id === "clean")!.feedbackEvents).toHaveLength(1);
  });

  it("reports bullets left with no feedback or no sources without removing them", () => {
    const onlyPolluted = createTestBullet({
      id: "orphan",
      sourceSessions: [POLLUTED],
      feedbackEvents: [ev("helpful", POLLUTED), ev("helpful", POLLUTED)],
      helpfulCount: 2,
    });
    const playbook = createTestPlaybook([onlyPolluted]);
    const result = scrubFeedbackFromSessions(playbook, matches, config);

    expect(playbook.bullets).toHaveLength(1);
    expect(playbook.bullets[0].deprecated).toBe(false);
    expect(result.sourcesRemoved).toBe(1);
    expect(result.bullets[0].noRemainingFeedback).toBe(true);
    expect(result.bullets[0].noRemainingSources).toBe(true);
    expect(playbook.bullets[0].helpfulCount).toBe(0);
  });

  it("keeps events without a sessionPath and leaves pinned maturity alone", () => {
    const pinned = createTestBullet({
      id: "pinned",
      pinned: true,
      maturity: "proven",
      feedbackEvents: [ev("helpful"), ev("helpful", POLLUTED)],
    });
    const playbook = createTestPlaybook([pinned]);
    scrubFeedbackFromSessions(playbook, matches, config);
    expect(playbook.bullets[0].feedbackEvents).toHaveLength(1);
    expect(playbook.bullets[0].maturity).toBe("proven");
  });

  it("never promotes a bullet whose stored maturity lagged its events", () => {
    const stale = createTestBullet({
      id: "stale",
      maturity: "established",
      feedbackEvents: [
        ...Array.from({ length: 20 }, () => ev("helpful", GENUINE)),
        ev("helpful", POLLUTED),
      ],
    });
    const playbook = createTestPlaybook([stale]);
    scrubFeedbackFromSessions(playbook, matches, config);
    expect(playbook.bullets[0].maturity).toBe("established");
  });

  it("is a no-op on an empty playbook", () => {
    const result = scrubFeedbackFromSessions(createTestPlaybook([]), matches, config);
    expect(result).toEqual({ bulletsTouched: 0, eventsRemoved: 0, sourcesRemoved: 0, bullets: [] });
  });
});

describe("cm playbook scrub (command)", () => {
  function pollutedPlaybook(subprocessPath: string) {
    return createTestPlaybook([
      createTestBullet({
        id: "b-polluted",
        sourceSessions: [subprocessPath],
        feedbackEvents: [ev("helpful", subprocessPath), ev("helpful", subprocessPath)],
        helpfulCount: 2,
      }),
      createTestBullet({
        id: "b-genuine",
        feedbackEvents: [ev("helpful", GENUINE)],
        helpfulCount: 1,
      }),
    ]);
  }

  it("errors when no pattern is given", async () => {
    await withTempCassHome(async (env) => {
      await inDir(env.home, async () => {
        const capture = captureConsole();
        try {
          await playbookCommand("scrub", [], { json: true });
        } finally {
          capture.restore();
        }
        const payload = JSON.parse(capture.logs.join("\n") || capture.errors.join("\n"));
        expect(payload.success).toBe(false);
      });
    });
  });

  it("--dry-run reports but writes nothing", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.playbookPath, yaml.stringify(pollutedPlaybook(POLLUTED)));
      const before = await readFile(env.playbookPath, "utf-8");
      await inDir(env.home, async () => {
        const capture = captureConsole();
        try {
          await playbookCommand("scrub", [], {
            json: true,
            dryRun: true,
            fromSessions: ["llm-subprocess-cwd"],
          });
        } finally {
          capture.restore();
        }
        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.dryRun).toBe(true);
        expect(payload.data.eventsRemoved).toBe(2);
        expect(payload.data.noRemainingFeedback).toEqual(["b-polluted"]);
        expect(payload.data.playbooks[0].backupPath).toBeNull();
      });
      expect(await readFile(env.playbookPath, "utf-8")).toBe(before);
    });
  });

  it("applies, backs up first, and --deprecate-orphans deprecates only orphans", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.playbookPath, yaml.stringify(pollutedPlaybook(POLLUTED)));
      const original = await readFile(env.playbookPath, "utf-8");
      await inDir(env.home, async () => {
        const capture = captureConsole();
        try {
          await playbookCommand("scrub", [], {
            json: true,
            fromSessions: ["*llm-subprocess-cwd*"],
            deprecateOrphans: true,
          });
        } finally {
          capture.restore();
        }
        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.deprecated).toEqual(["b-polluted"]);
        const backupPath = payload.data.playbooks[0].backupPath as string;
        expect(backupPath).toContain(".backup.");
        expect(await readFile(backupPath, "utf-8")).toBe(original);
      });

      const saved = yaml.parse(await readFile(env.playbookPath, "utf-8"));
      const polluted = saved.bullets.find((b: any) => b.id === "b-polluted");
      const genuine = saved.bullets.find((b: any) => b.id === "b-genuine");
      expect(polluted.feedbackEvents).toHaveLength(0);
      expect(polluted.deprecated).toBe(true);
      expect(genuine.deprecated).toBe(false);
      expect(genuine.feedbackEvents).toHaveLength(1);
    });
  });

  it("--cm-subprocess-calls matches the configured subprocess transcript folder", async () => {
    await withTempCassHome(async (env) => {
      // With HOME pointing at the temp env, the default cwd resolves under it.
      const cwd = resolveCliSubprocessCwd(DEFAULT_CLI_SUBPROCESS_CWD)!;
      expect(cmSubprocessPathFragments()).toEqual([`/${slugifyProjectDir(cwd)}/`]);
      const transcript = path.join(env.home, ".claude", "projects", slugifyProjectDir(cwd), "x.jsonl");
      await writeFile(env.playbookPath, yaml.stringify(pollutedPlaybook(transcript)));
      await inDir(env.home, async () => {
        const capture = captureConsole();
        try {
          await playbookCommand("scrub", [], { json: true, cmSubprocessCalls: true });
        } finally {
          capture.restore();
        }
        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.eventsRemoved).toBe(2);
        expect(payload.data.bulletsTouched).toBe(1);
      });
      const files = await readdir(path.dirname(env.playbookPath));
      expect(files.some((f) => f.includes(".backup."))).toBe(true);
    });
  });
});

describe("cm playbook scrub / conflicts human output", () => {
  function captureAll() {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: any[]) => lines.push(a.map(String).join(" "));
    console.error = (...a: any[]) => lines.push(a.map(String).join(" "));
    return {
      text: () => lines.join("\n"),
      restore: () => {
        console.log = origLog;
        console.error = origErr;
      },
    };
  }

  it("scrub dry-run lists changed bullets and orphans with next steps", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({
              id: "b-orphan",
              sourceSessions: [POLLUTED],
              feedbackEvents: [ev("helpful", POLLUTED)],
              helpfulCount: 1,
            }),
          ]),
        ),
      );
      await inDir(env.home, async () => {
        const cap = captureAll();
        try {
          await playbookCommand("scrub", [], { dryRun: true, fromSessions: ["llm-subprocess-cwd"] });
        } finally {
          cap.restore();
        }
        const out = cap.text();
        expect(out).toContain("dry run");
        expect(out).toContain("b-orphan");
        expect(out).toContain("no genuine support left");
        expect(out).toContain("--deprecate-orphans");
        expect(out).toContain("Re-run without --dry-run");
      });
    });
  });

  it("scrub with --deprecate-orphans reports what it deprecated; no playbook prints a notice", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ id: "b-o", sourceSessions: [POLLUTED], feedbackEvents: [ev("helpful", POLLUTED)] }),
          ]),
        ),
      );
      await inDir(env.home, async () => {
        const cap = captureAll();
        try {
          await playbookCommand("scrub", [], { fromSessions: ["llm-subprocess-cwd"], deprecateOrphans: true });
        } finally {
          cap.restore();
        }
        expect(cap.text()).toContain("Deprecated 1");
        expect(cap.text()).toContain("Backup:");
      });
    });
  });

  it("conflicts prints pairs with a suggestion, and a clean message when there are none", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ id: "b-y", content: "Always commit generated lockfiles", category: "git" }),
            createTestBullet({ id: "b-n", content: "Never commit generated lockfiles", category: "git" }),
          ]),
        ),
      );
      await inDir(env.home, async () => {
        let cap = captureAll();
        try {
          await playbookCommand("conflicts", [], {});
        } finally {
          cap.restore();
        }
        expect(cap.text()).toContain("PLAYBOOK CONFLICTS (1)");
        expect(cap.text()).toContain("Equal support");

        cap = captureAll();
        try {
          await playbookCommand("conflicts", [], { category: "security" });
        } finally {
          cap.restore();
        }
        expect(cap.text()).toContain("No contradicting rules");
      });
    });
  });
});
