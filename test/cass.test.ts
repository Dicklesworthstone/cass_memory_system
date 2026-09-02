import { describe, it, expect } from "bun:test";
import {
  cassAvailable,
  handleCassUnavailable,
  cassNeedsIndex,
  safeCassSearch,
  safeCassSearchWithDegraded,
  cassExport,
  cassExpand,
  cassTimeline,
  findUnprocessedSessions,
  CASS_EXIT_CODES,
  type CassRunner,
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
    options?: { maxBuffer?: number; timeout?: number }
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
      runner
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
            { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
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
      timeout: 30 * 1000,
    });
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

      expect(result).toEqual({ groups: [] });
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
            { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
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
            { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
            { path: "s2.jsonl", agent: "claude", messageCount: 5, startTime: "12:00", endTime: "13:00" },
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

  it("findUnprocessedSessions returns cass's agent attribution per session (#73)", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            { path: "/home/u/.omp/agent/sessions/ws/s1.jsonl", agent: "omp", messageCount: 10, startTime: "10:00", endTime: "11:00" },
            { path: "/home/u/.claude/projects/p/s2.jsonl", agent: "claude_code", messageCount: 5, startTime: "12:00", endTime: "13:00" },
            { path: "/home/u/somewhere/s3.jsonl", messageCount: 5, startTime: "12:00", endTime: "13:00" },
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
            { path: "s1.jsonl", agent: "claude_code", messageCount: 10, startTime: "10:00", endTime: "11:00" },
            { path: "s2.jsonl", agent: "omp", messageCount: 5, startTime: "12:00", endTime: "13:00" },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });

    const claude = await findUnprocessedSessions(new Set(), { agent: "claude" }, "cass", runner);
    expect(claude.map((s) => s.path)).toEqual(["s1.jsonl"]);

    const claudeCode = await findUnprocessedSessions(new Set(), { agent: "claude_code" }, "cass", runner);
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
            { path: "s1.jsonl", agent: "Claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
            { path: "s2.jsonl", agent: "cursor", messageCount: 5, startTime: "12:00", endTime: "13:00" },
          ],
        },
      ],
    });

    const runner = createCassRunnerStub({ execStdout: { timeline: output } });
    const processed = new Set<string>();

    const result = await findUnprocessedSessions(processed, { agent: "  cLaUdE  " }, "cass", runner);

    expect(result.map((s) => s.path)).toEqual(["s1.jsonl"]);
  });

  it("findUnprocessedSessions ignores invalid maxSessions (e.g. negative) instead of slicing from end", async () => {
    const output = JSON.stringify({
      groups: [
        {
          date: "2025-01-01",
          sessions: [
            { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
            { path: "s2.jsonl", agent: "claude", messageCount: 5, startTime: "12:00", endTime: "13:00" },
            { path: "s3.jsonl", agent: "claude", messageCount: 5, startTime: "14:00", endTime: "15:00" },
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
