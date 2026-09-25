import { describe, expect, it } from "bun:test";
import {
  CASS_EXIT_CODES,
  type CassRunner,
  cassAvailable,
  cassExpand,
  cassExport,
  cassNeedsIndex,
  cassTimeline,
  findUnprocessedSessions,
  handleCassUnavailable,
  safeCassSearch,
  safeCassSearchWithDegraded,
} from "../src/cass.js";
import { createTestConfig } from "./helpers/factories.js";

function createCassRunnerStub(opts: {
  versionOk?: boolean;
  versionErrorCode?: string;
  healthStatus?: number;
  execStdout?: Partial<Record<string, string>>;
  execError?: Partial<Record<string, { code: any; message?: string }>>;
  searchFallbackStdout?: string;
  searchFallbackStatus?: number;
  onExecFile?: (
    file: string,
    args: string[],
    options?: { maxBuffer?: number; timeout?: number },
  ) => void;
  onSpawnSync?: (file: string, args: string[]) => void;
}): CassRunner {
  return {
    execFile: async (file, args, options) => {
      opts.onExecFile?.(file, args, options);
      const cmd = args[0] ?? "";
      const err = opts.execError?.[cmd];
      if (err) {
        const e: any = new Error(err.message || `cass ${cmd} failed`);
        e.code = err.code;
        throw e;
      }

      const stdout = opts.execStdout?.[cmd];
      if (stdout === undefined) {
        throw new Error(`Unexpected cass execFile command: ${cmd}`);
      }
      return { stdout, stderr: "" };
    },
    spawnSync: (file, args) => {
      opts.onSpawnSync?.(file, args);
      const cmd = args[0];
      if (cmd === "--version") {
        if (opts.versionOk === false) {
          return {
            status: null,
            stdout: "",
            stderr: "",
            error: { code: opts.versionErrorCode || "ENOENT" },
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "health") {
        return { status: opts.healthStatus ?? 0, stdout: "", stderr: "" };
      }
      if (cmd === "search") {
        return {
          status: opts.searchFallbackStatus ?? 0,
          stdout: opts.searchFallbackStdout ?? "",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn: (() => {
      throw new Error("spawn not implemented in cass runner stub");
    }) as any,
  };
}

describe("cass.ts core functions (runner stubbed)", () => {
  it("cassAvailable returns true when version succeeds", () => {
    const runner = createCassRunnerStub({});
    expect(cassAvailable("cass", {}, runner)).toBe(true);
  });

  it("cassAvailable expands tilde paths", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = createCassRunnerStub({
      onSpawnSync: (file, args) => calls.push({ file, args }),
    });

    const originalHome = process.env.HOME;
    process.env.HOME = "/test/home";
    try {
      expect(cassAvailable("~/bin/cass", {}, runner)).toBe(true);
      expect(calls[0]?.file).toBe("/test/home/bin/cass");
      expect(calls[0]?.args[0]).toBe("--version");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("handleCassUnavailable falls back when cass missing", async () => {
    const runner = createCassRunnerStub({ versionOk: false, versionErrorCode: "ENOENT" });
    const result = await handleCassUnavailable(
      { cassPath: "/no/cass", searchCommonPaths: false },
      runner,
    );
    expect(result.fallbackMode).toBe("playbook-only");
    expect(result.canContinue).toBe(true);
  });

  it("cassNeedsIndex returns true on non-zero health code", () => {
    const runner = createCassRunnerStub({ healthStatus: CASS_EXIT_CODES.INDEX_MISSING });
    expect(cassNeedsIndex("cass", runner)).toBe(true);
  });

  it("safeCassSearch parses hits", async () => {
    const hitsData = [
      {
        source_path: "test.ts",
        line_number: 10,
        snippet: "test code",
        agent: "claude",
        score: 0.9,
      },
    ];

    const runner = createCassRunnerStub({
      execStdout: { search: JSON.stringify(hitsData) },
    });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 1, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(1);
    expect(hits[0].source_path).toBe("test.ts");
  });

  it("safeCassSearch parses hits when cass prints logs before JSON", async () => {
    const hitsData = [
      {
        source_path: "test.ts",
        line_number: 10,
        snippet: "test code",
        agent: "claude",
        score: 0.9,
      },
    ];

    const output = `[WARN] cass warning: something happened\n${JSON.stringify(hitsData)}`;
    const runner = createCassRunnerStub({ execStdout: { search: output } });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 1, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(1);
    expect(hits[0].source_path).toBe("test.ts");
  });

  it("safeCassSearch parses NDJSON (one JSON object per line)", async () => {
    const hit1 = { source_path: "a.ts", line_number: 1, snippet: "a", agent: "stub", score: 0.9 };
    const hit2 = { source_path: "b.ts", line_number: 2, snippet: "b", agent: "stub", score: 0.8 };

    const output = `${JSON.stringify(hit1)}\n${JSON.stringify(hit2)}`;
    const runner = createCassRunnerStub({ execStdout: { search: output } });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 10, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(2);
    expect(hits[0].source_path).toBe("a.ts");
    expect(hits[1].source_path).toBe("b.ts");
  });

  it("safeCassSearch parses JSON when prefixed by inline log text", async () => {
    const hitsData = [
      {
        source_path: "inline.ts",
        line_number: 3,
        snippet: "inline",
        agent: "stub",
        score: 0.7,
      },
    ];

    const output = `[INFO] cass search completed: ${JSON.stringify(hitsData)}`;
    const runner = createCassRunnerStub({ execStdout: { search: output } });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 1, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(1);
    expect(hits[0].source_path).toBe("inline.ts");
  });

  it("safeCassSearchWithDegraded classifies INDEX_MISSING (no auto-repair)", async () => {
    const runner = createCassRunnerStub({
      execError: { search: { code: CASS_EXIT_CODES.INDEX_MISSING } },
    });
    const config = createTestConfig();

    const result = await safeCassSearchWithDegraded("query", { limit: 1 }, "cass", config, runner);

    expect(result.hits).toEqual([]);
    expect(result.degraded?.reason).toBe("INDEX_MISSING");
    expect(result.degraded?.available).toBe(false);
  });

  it("cassExport returns content", async () => {
    const runner = createCassRunnerStub({ execStdout: { export: "exported content\n" } });
    const config = createTestConfig();

    const content = await cassExport("session.jsonl", "text", "cass", config, runner);
    expect(content?.trim()).toBe("exported content");
  });

  it("cassExpand returns context", async () => {
    const runner = createCassRunnerStub({ execStdout: { expand: "expanded context\n" } });
    const config = createTestConfig();

    const content = await cassExpand("session.jsonl", 10, 2, "cass", config, runner);
    expect(content?.trim()).toBe("expanded context");
  });

  it("cassTimeline returns groups parsed from JSON", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "claude",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const result = await cassTimeline(7, "cass", runner);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].date).toBe("2025-01-01");
  });

  it("cassTimeline allows large JSON output and bounds execution time", async () => {
    let capturedOptions: { maxBuffer?: number; timeout?: number } | undefined;
    const runner = createCassRunnerStub({
      execStdout: { timeline: JSON.stringify({ groups: [] }) },
      onExecFile: (_file, args, options) => {
        if (args[0] === "timeline") capturedOptions = options;
      },
    });

    await cassTimeline(365, "cass", runner);

    expect(capturedOptions).toEqual({
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120 * 1000,
    });
  });

  it("cassTimeline honors a configured timeout budget (#78)", async () => {
    let capturedOptions: { maxBuffer?: number; timeout?: number } | undefined;
    const runner = createCassRunnerStub({
      execStdout: { timeline: JSON.stringify({ groups: [] }) },
      onExecFile: (_file, args, options) => {
        if (args[0] === "timeline") capturedOptions = options;
      },
    });

    await cassTimeline(7, "cass", runner, { timeoutSeconds: 300 });
    expect(capturedOptions?.timeout).toBe(300 * 1000);

    // A nonsensical budget falls back to the default rather than disabling the timeout.
    await cassTimeline(7, "cass", runner, { timeoutSeconds: 0 });
    expect(capturedOptions?.timeout).toBe(120 * 1000);
  });

  it("cassTimeline reports the failure on the result (#78)", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const runner = createCassRunnerStub({
        execError: { timeline: { code: "ETIMEDOUT", message: "timeline timed out" } },
      });
      const result = await cassTimeline(7, "cass", runner);
      expect(result.groups).toEqual([]);
      expect(result.error).toContain("timeline timed out");
    } finally {
      console.error = originalError;
    }
  });

  it("cassTimeline surfaces execution failures on stderr", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const runner = createCassRunnerStub({
        execError: {
          timeline: {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            message: "stdout maxBuffer length exceeded",
          },
        },
      });

      const result = await cassTimeline(365, "cass", runner);

      expect(result.groups).toEqual([]);
      expect(result.error).toContain("stdout maxBuffer length exceeded");
      expect(errors.join("\n")).toContain("Timeline query failed");
      expect(errors.join("\n")).toContain("stdout maxBuffer length exceeded");
    } finally {
      console.error = originalError;
    }
  });

  it("cassTimeline tolerates leading logs before JSON", async () => {
    const output = `[INFO] cass timeline starting...\n${JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "claude",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
          ],
        },
      ],
    })}`;

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const result = await cassTimeline(7, "cass", runner);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].date).toBe("2025-01-01");
  });

  it("findUnprocessedSessions respects processed set", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "claude",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
            {
              path: "s2.jsonl",
              agent: "claude",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const processed = new Set(["s1.jsonl"]);

    const result = await findUnprocessedSessions(processed, {}, "cass", runner);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "s2.jsonl", agent: "claude" });
  });

  // #85: cass 0.8 emits `groups` from a HashMap (key order differs per run) and
  // uses `started_at` / `ended_at` (epoch ms) + `source_path` / `message_count`.
  const cass08Session = (p: string, startedAt: number | null, endedAt: number | null = null) => ({
    id: 1,
    agent: "claude_code",
    title: "t",
    started_at: startedAt,
    ended_at: endedAt,
    source_path: p,
    message_count: 7,
  });

  it("cassTimeline maps cass 0.8 started_at/ended_at epoch ms and sorts groups (#85)", async () => {
    const t1 = Date.UTC(2026, 8, 4, 23, 5);
    const t2 = Date.UTC(2026, 8, 11, 8, 30);
    const output = JSON.stringify({
      range: { start: 0, end: 1 },
      total_sessions: 2,
      groups: {
        "2026-09-11 08:00": [cass08Session("/s/b.jsonl", t2, t2 + 60_000)],
        "2026-09-04 23:00": [cass08Session("/s/a.jsonl", t1, null)],
      },
    });
    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const result = await cassTimeline(30, "cass", runner);

    expect(result.groups.map((g) => g.date)).toEqual(["2026-09-04 23:00", "2026-09-11 08:00"]);
    expect(result.groups[0].sessions[0]).toEqual({
      path: "/s/a.jsonl",
      agent: "claude_code",
      messageCount: 7,
      startTime: new Date(t1).toISOString(),
      endTime: "",
    });
    expect(result.groups[1].sessions[0].endTime).toBe(new Date(t2 + 60_000).toISOString());
  });

  it("findUnprocessedSessions picks a deterministic oldest-first batch (#85)", async () => {
    const base = Date.UTC(2026, 8, 1);
    const hour = 3_600_000;
    const sessions = {
      "2026-09-01 05:00": [cass08Session("/s/e.jsonl", base + 5 * hour)],
      "2026-09-01 01:00": [
        cass08Session("/s/b.jsonl", base + 1 * hour + 1),
        cass08Session("/s/a.jsonl", base + 1 * hour),
      ],
      "2026-09-01 03:00": [cass08Session("/s/c.jsonl", base + 3 * hour)],
      "unknown": [cass08Session("/s/z-no-time.jsonl", null)],
      "2026-09-01 04:00": [cass08Session("/s/d.jsonl", base + 4 * hour)],
    };
    const keys = Object.keys(sessions);
    // cass's HashMap emits these keys in a different order on every run.
    const permutations = [
      keys,
      [...keys].reverse(),
      [keys[2], keys[4], keys[0], keys[3], keys[1], keys[5]],
    ];

    const batches: string[][] = [];
    for (const order of permutations) {
      const groups: Record<string, unknown> = {};
      for (const k of order) groups[k!] = sessions[k as keyof typeof sessions];
      const runner = createCassRunnerStub({
        execStdout: { timeline: JSON.stringify({ groups }) },
      });
      const result = await findUnprocessedSessions(
        new Set(["/s/a.jsonl"]),
        { maxSessions: 3 },
        "cass",
        runner,
      );
      batches.push(result.map((s) => s.path));
    }

    expect(batches[0]).toEqual(["/s/b.jsonl", "/s/c.jsonl", "/s/d.jsonl"]);
    expect(batches[1]).toEqual(batches[0]);
    expect(batches[2]).toEqual(batches[0]);

    // A session with no usable start time is still discoverable, after the timed ones.
    const runner = createCassRunnerStub({
      execStdout: { timeline: JSON.stringify({ groups: sessions }) },
    });
    const all = await findUnprocessedSessions(new Set(), { maxSessions: 10 }, "cass", runner);
    expect(all.map((s) => s.path)).toEqual([
      "/s/a.jsonl",
      "/s/b.jsonl",
      "/s/c.jsonl",
      "/s/d.jsonl",
      "/s/e.jsonl",
      "/s/z-no-time.jsonl",
    ]);
  });

  it("findUnprocessedSessions returns cass's agent attribution per session (#73)", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "/home/u/.omp/agent/sessions/ws/s1.jsonl",
              agent: "omp",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
            {
              path: "/home/u/.claude/projects/p/s2.jsonl",
              agent: "claude_code",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
            {
              path: "/home/u/somewhere/s3.jsonl",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const result = await findUnprocessedSessions(new Set(), {}, "cass", runner);

    expect(result).toEqual([
      { path: "/home/u/.omp/agent/sessions/ws/s1.jsonl", agent: "omp" },
      { path: "/home/u/.claude/projects/p/s2.jsonl", agent: "claude_code" },
      { path: "/home/u/somewhere/s3.jsonl", agent: "unknown" },
    ]);
  });

  it("findUnprocessedSessions agent filter folds aliases (claude matches cass's claude_code)", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "claude_code",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
            {
              path: "s2.jsonl",
              agent: "omp",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });

    const claude = await findUnprocessedSessions(new Set(), { agent: "claude" }, "cass", runner);
    expect(claude.map((s) => s.path)).toEqual(["s1.jsonl"]);

    const claudeCode = await findUnprocessedSessions(
      new Set(),
      { agent: "claude_code" },
      "cass",
      runner,
    );
    expect(claudeCode.map((s) => s.path)).toEqual(["s1.jsonl"]);

    const omp = await findUnprocessedSessions(new Set(), { agent: "oh-my-pi" }, "cass", runner);
    expect(omp.map((s) => s.path)).toEqual(["s2.jsonl"]);
  });

  it("findUnprocessedSessions normalizes agent filter (trim + case-insensitive)", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "Claude",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
            {
              path: "s2.jsonl",
              agent: "cursor",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const processed = new Set<string>();

    const result = await findUnprocessedSessions(
      processed,
      { agent: "  cLaUdE  " },
      "cass",
      runner,
    );

    expect(result.map((s) => s.path)).toEqual(["s1.jsonl"]);
  });

  it("findUnprocessedSessions ignores invalid maxSessions (e.g. negative) instead of slicing from end", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            {
              path: "s1.jsonl",
              agent: "claude",
              messageCount: 10,
              startTime: "10:00",
              endTime: "11:00",
            },
            {
              path: "s2.jsonl",
              agent: "claude",
              messageCount: 5,
              startTime: "12:00",
              endTime: "13:00",
            },
            {
              path: "s3.jsonl",
              agent: "claude",
              messageCount: 5,
              startTime: "14:00",
              endTime: "15:00",
            },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const processed = new Set<string>();

    const result = await findUnprocessedSessions(processed, { maxSessions: -1 }, "cass", runner);

    expect(result).toHaveLength(3);
    expect(result.map((s) => s.path)).toEqual(["s1.jsonl", "s2.jsonl", "s3.jsonl"]);
  });

  it("safeCassSearch(force) parses output even when cass exits non-zero (leading logs)", async () => {
    const hitsData = [
      {
        source_path: "force.ts",
        line_number: 5,
        snippet: "force hit",
        agent: "stub",
        score: 0.9,
      },
    ];

    const output = `[WARN] cass failed but printed results anyway\n${JSON.stringify(hitsData)}`;
    const runner = createCassRunnerStub({
      execError: { search: { code: 1, message: "exit 1" } },
      searchFallbackStdout: output,
      searchFallbackStatus: 1,
    });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 5, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(1);
    expect(hits[0].source_path).toBe("force.ts");
  });

  it("safeCassSearch(force) parses NDJSON even when cass exits non-zero", async () => {
    const hit1 = { source_path: "a.ts", line_number: 1, snippet: "a", agent: "stub", score: 0.9 };
    const hit2 = { source_path: "b.ts", line_number: 2, snippet: "b", agent: "stub", score: 0.8 };

    const output = `${JSON.stringify(hit1)}\n${JSON.stringify(hit2)}`;
    const runner = createCassRunnerStub({
      execError: { search: { code: 1, message: "exit 1" } },
      searchFallbackStdout: output,
      searchFallbackStatus: 1,
    });
    const config = createTestConfig();

    const hits = await safeCassSearch("query", { limit: 10, force: true }, "cass", config, runner);

    expect(hits).toHaveLength(2);
    expect(hits[0].source_path).toBe("a.ts");
    expect(hits[1].source_path).toBe("b.ts");
  });
});

describe("findUnprocessedSessions discovery failures (#78)", () => {
  it("throws when the timeline failed and the fallback search found nothing", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const runner = createCassRunnerStub({
        execError: {
          timeline: { code: "ETIMEDOUT", message: "cass timeline timed out after 30s" },
          search: { code: "ETIMEDOUT", message: "cass search timed out" },
        },
      });
      await expect(findUnprocessedSessions(new Set(), {}, "cass", runner)).rejects.toThrow(
        /cass timeline failed \(cass timeline timed out after 30s\)/,
      );
    } finally {
      console.error = originalError;
    }
  });

  it("still returns fallback-search sessions when only the timeline failed", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const hit = {
        source_path: "/home/u/.claude/projects/p/s1.jsonl",
        line_number: 1,
        snippet: "the build is green",
        agent: "claude_code",
        score: 0.5,
      };
      const runner = createCassRunnerStub({
        execError: { timeline: { code: "ETIMEDOUT", message: "timeline timed out" } },
        execStdout: { search: JSON.stringify({ hits: [hit] }) },
      });
      const result = await findUnprocessedSessions(new Set(), {}, "cass", runner);
      expect(result.map((s) => s.path)).toEqual([hit.source_path]);
    } finally {
      console.error = originalError;
    }
  });

  it("treats a missing cass index as no sessions rather than a discovery failure", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const runner = createCassRunnerStub({
        execError: {
          timeline: { code: CASS_EXIT_CODES.INDEX_MISSING, message: "Database not found" },
          search: { code: CASS_EXIT_CODES.INDEX_MISSING, message: "Database not found" },
        },
      });
      const result = await findUnprocessedSessions(new Set(), {}, "cass", runner);
      expect(result).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  it("returns an empty list, not an error, when the timeline succeeds with no sessions", async () => {
    const runner = createCassRunnerStub({
      execStdout: {
        timeline: JSON.stringify({ groups: [] }),
        search: JSON.stringify({ hits: [] }),
      },
    });
    const result = await findUnprocessedSessions(new Set(), {}, "cass", runner);
    expect(result).toEqual([]);
  });

  it("passes the configured timeline budget through (#78)", async () => {
    let capturedTimeout: number | undefined;
    const runner = createCassRunnerStub({
      execStdout: {
        timeline: JSON.stringify({ groups: [] }),
        search: JSON.stringify({ hits: [] }),
      },
      onExecFile: (_file, args, options) => {
        if (args[0] === "timeline") capturedTimeout = options?.timeout;
      },
    });
    await findUnprocessedSessions(new Set(), { timelineTimeoutSeconds: 45 }, "cass", runner);
    expect(capturedTimeout).toBe(45 * 1000);
  });
});
