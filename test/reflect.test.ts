import { describe, expect, test } from "bun:test";
import { reflectCommand, __test as reflectCommandTest } from "../src/commands/reflect.js";
import {
  deduplicateDeltas,
  formatBulletsForPrompt,
  hashDelta,
  reflectOnSession,
  shouldExitEarly,
} from "../src/reflect.js";
import type { PlaybookDelta } from "../src/types.js";
import {
  createTestBullet,
  createTestConfig,
  createTestDiary,
  createTestPlaybook,
} from "./helpers/factories.js";
import { withTempGitRepo } from "./helpers/git.js";
import { withLlmShim } from "./helpers/llm-shim.js";
import { withTempCassHome } from "./helpers/temp.js";

/**
 * Capture console output during async function execution.
 */
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

describe("reflectOnSession", () => {
  const config = createTestConfig();

  test("should terminate when no new insights found", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    // Use LLMIO injection instead of env var
    await withLlmShim(
      {
        reflector: { deltas: [] },
      },
      async (io) => {
        const result = await reflectOnSession(diary, playbook, config, io);
        const deltas = Array.isArray(result) ? result : (result.deltas ?? []);
        expect(deltas).toEqual([]);
      },
    );
  });

  test("should aggregate unique deltas across iterations", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    // Per-iteration responses: A, B, then A (duplicate)
    const deltaA: PlaybookDelta = {
      type: "add",
      bullet: { content: "Rule A", category: "test" },
      reason: "reason A",
      sourceSession: diary.sessionPath,
    };

    const deltaB: PlaybookDelta = {
      type: "add",
      bullet: { content: "Rule B", category: "test" },
      reason: "reason B",
      sourceSession: diary.sessionPath,
    };

    // Use a function to return different responses per iteration
    let callCount = 0;
    const iterationResponses = [{ deltas: [deltaA] }, { deltas: [deltaB] }, { deltas: [deltaA] }];

    await withLlmShim(
      {
        reflector: () => {
          const response = iterationResponses[callCount] || { deltas: [] };
          callCount++;
          return response;
        },
      },
      async (io) => {
        const result = await reflectOnSession(diary, playbook, config, io);
        const deltas = Array.isArray(result) ? result : (result.deltas ?? []);

        expect(deltas).toHaveLength(2);
        expect(deltas.map((d) => (d.type === "add" ? d.bullet.content : ""))).toContain("Rule A");
        expect(deltas.map((d) => (d.type === "add" ? d.bullet.content : ""))).toContain("Rule B");
      },
    );
  });

  test("should stop if max iterations reached", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();

    let callCount = 0;
    const iterationResponses = [
      {
        deltas: [
          {
            type: "add" as const,
            bullet: { content: "Unique", category: "test" },
            reason: "reason",
            sourceSession: diary.sessionPath,
          },
        ],
      },
      {
        deltas: [
          {
            type: "add" as const,
            bullet: { content: "Another", category: "test" },
            reason: "reason",
            sourceSession: diary.sessionPath,
          },
        ],
      },
    ];

    await withLlmShim(
      {
        reflector: () => {
          const response = iterationResponses[callCount] || { deltas: [] };
          callCount++;
          return response;
        },
      },
      async (io) => {
        const result = await reflectOnSession(
          diary,
          playbook,
          { ...config, maxReflectorIterations: 2 },
          io,
        );
        const deltas = Array.isArray(result) ? result : (result.deltas ?? []);
        expect(deltas.length).toBeGreaterThanOrEqual(2);
      },
    );
  });
});

describe("deduplicateDeltas", () => {
  test.serial("should filter exact duplicates", () => {
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { content: "content", category: "cat" },
      reason: "reason",
      sourceSession: "s1",
    };

    const existing = [delta];
    const newDeltas = [delta];

    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(0);
  });

  test.serial("should filter duplicates by content hash for adds", () => {
    const d1: PlaybookDelta = {
      type: "add",
      bullet: { content: "Same Content", category: "cat1" },
      reason: "r1",
      sourceSession: "s1",
    };

    const d2: PlaybookDelta = {
      type: "add",
      bullet: { content: "same content", category: "cat2" }, // distinct case
      reason: "r2",
      sourceSession: "s2",
    };

    const result = deduplicateDeltas([d2], [d1]);
    expect(result).toHaveLength(0); // Should match case-insensitive
  });

  test.serial("should allow distinct adds", () => {
    const d1: PlaybookDelta = {
      type: "add",
      bullet: { content: "A", category: "c" },
      reason: "r",
      sourceSession: "s",
    };
    const d2: PlaybookDelta = {
      type: "add",
      bullet: { content: "B", category: "c" },
      reason: "r",
      sourceSession: "s",
    };

    const result = deduplicateDeltas([d2], [d1]);
    expect(result).toHaveLength(1);
  });
});

describe("reflect command helpers (unit)", () => {
  test("summarizeDeltas counts delta types", () => {
    const deltas: PlaybookDelta[] = [
      { type: "add", bullet: { content: "A", category: "c" }, reason: "r", sourceSession: "s" },
      { type: "helpful", bulletId: "b-1" },
      { type: "harmful", bulletId: "b-2" },
      { type: "replace", bulletId: "b-3", newContent: "new" },
      { type: "deprecate", bulletId: "b-4", reason: "outdated" },
      { type: "merge", bulletIds: ["b-5", "b-6"], mergedContent: "merged" },
    ];

    const counts = reflectCommandTest.summarizeDeltas(deltas);
    expect(counts.add).toBe(1);
    expect(counts.helpful).toBe(1);
    expect(counts.harmful).toBe(1);
    expect(counts.replace).toBe(1);
    expect(counts.deprecate).toBe(1);
    expect(counts.merge).toBe(1);
  });

  test("summarizeDeltas returns zeros for empty array", () => {
    const counts = reflectCommandTest.summarizeDeltas([]);
    expect(counts.add).toBe(0);
    expect(counts.helpful).toBe(0);
    expect(counts.harmful).toBe(0);
    expect(counts.replace).toBe(0);
    expect(counts.deprecate).toBe(0);
    expect(counts.merge).toBe(0);
  });

  test("summarizeDeltas handles multiple deltas of same type", () => {
    const deltas: PlaybookDelta[] = [
      { type: "add", bullet: { content: "A", category: "c" }, reason: "r1", sourceSession: "s1" },
      { type: "add", bullet: { content: "B", category: "c" }, reason: "r2", sourceSession: "s2" },
      { type: "add", bullet: { content: "C", category: "c" }, reason: "r3", sourceSession: "s3" },
      { type: "helpful", bulletId: "b-1" },
      { type: "helpful", bulletId: "b-2" },
    ];

    const counts = reflectCommandTest.summarizeDeltas(deltas);
    expect(counts.add).toBe(3);
    expect(counts.helpful).toBe(2);
    expect(counts.harmful).toBe(0);
  });

  test("formatDeltaLine renders each delta type", () => {
    expect(
      reflectCommandTest.formatDeltaLine({
        type: "add",
        bullet: { content: "A", category: "cat" },
        reason: "r",
        sourceSession: "s",
      }),
    ).toContain("ADD");
    expect(reflectCommandTest.formatDeltaLine({ type: "helpful", bulletId: "b-1" })).toBe(
      "HELPFUL  b-1",
    );
    expect(reflectCommandTest.formatDeltaLine({ type: "harmful", bulletId: "b-2" })).toBe(
      "HARMFUL  b-2",
    );
    expect(
      reflectCommandTest.formatDeltaLine({
        type: "harmful",
        bulletId: "b-3",
        reason: "wasted_time",
      }),
    ).toContain("(wasted_time)");
    expect(
      reflectCommandTest.formatDeltaLine({ type: "replace", bulletId: "b-4", newContent: "new" }),
    ).toContain("REPLACE");
    expect(
      reflectCommandTest.formatDeltaLine({
        type: "deprecate",
        bulletId: "b-5",
        reason: "outdated",
      }),
    ).toContain("DEPRECATE");
    expect(
      reflectCommandTest.formatDeltaLine({
        type: "merge",
        bulletIds: ["b-6", "b-7"],
        mergedContent: "merged",
      }),
    ).toContain("MERGE");
  });

  test("formatDeltaLine includes category and content in ADD", () => {
    const line = reflectCommandTest.formatDeltaLine({
      type: "add",
      bullet: { content: "Use TypeScript for safety", category: "best-practices" },
      reason: "learned from session",
      sourceSession: "/path/to/session",
    });
    expect(line).toBe("ADD  [best-practices] Use TypeScript for safety");
  });

  test("formatDeltaLine includes bulletId and newContent in REPLACE", () => {
    const line = reflectCommandTest.formatDeltaLine({
      type: "replace",
      bulletId: "b-abc123",
      newContent: "Updated content here",
    });
    expect(line).toBe("REPLACE  b-abc123 → Updated content here");
  });

  test("formatDeltaLine includes bulletId and reason in DEPRECATE", () => {
    const line = reflectCommandTest.formatDeltaLine({
      type: "deprecate",
      bulletId: "b-old",
      reason: "superseded by newer rule",
    });
    expect(line).toBe("DEPRECATE  b-old (superseded by newer rule)");
  });

  test("formatDeltaLine lists all bullet IDs in MERGE", () => {
    const line = reflectCommandTest.formatDeltaLine({
      type: "merge",
      bulletIds: ["b-1", "b-2", "b-3"],
      mergedContent: "Combined rule content",
    });
    expect(line).toBe("MERGE  b-1, b-2, b-3 → Combined rule content");
  });

  test("formatDeltaLine handles harmful without reason", () => {
    const line = reflectCommandTest.formatDeltaLine({
      type: "harmful",
      bulletId: "b-xyz",
    });
    expect(line).toBe("HARMFUL  b-xyz");
  });
});

describe("reflect module helpers (unit)", () => {
  test("formatBulletsForPrompt handles empty playbook", () => {
    expect(formatBulletsForPrompt([])).toBe("(Playbook is empty)");
  });

  test("hashDelta normalizes merge ids and replace content", () => {
    const mergeA: PlaybookDelta = { type: "merge", bulletIds: ["b-2", "b-1"], mergedContent: "m" };
    const mergeB: PlaybookDelta = { type: "merge", bulletIds: ["b-1", "b-2"], mergedContent: "m" };
    expect(hashDelta(mergeA)).toBe(hashDelta(mergeB));

    const replaceA: PlaybookDelta = {
      type: "replace",
      bulletId: "b-3",
      newContent: " New   Content ",
    };
    const replaceB: PlaybookDelta = { type: "replace", bulletId: "b-3", newContent: "new content" };
    expect(hashDelta(replaceA)).toBe(hashDelta(replaceB));
  });

  test("shouldExitEarly respects iteration, per-iteration, and total thresholds", () => {
    const config = createTestConfig({ maxReflectorIterations: 3 });

    // Exit early when deltasThisIteration is 0
    expect(shouldExitEarly(0, 0, 0, config)).toBe(true);

    // Don't exit early when we have deltas and haven't hit limits
    // iteration=0, deltasThisIteration=1, totalDeltas=20 => continue (false)
    expect(shouldExitEarly(0, 1, 20, config)).toBe(false);

    // Exit when we've reached max iterations (iteration >= maxIterations - 1)
    // iteration=2 >= maxIterations-1=2 => exit (true)
    expect(shouldExitEarly(2, 1, 1, config)).toBe(true);

    // Normal case: haven't hit any limits => continue (false)
    expect(shouldExitEarly(0, 1, 1, config)).toBe(false);

    // Exit when totalDeltas >= 50
    expect(shouldExitEarly(0, 1, 50, config)).toBe(true);
  });
});

describe("reflectCommand input validation", () => {
  test("rejects invalid days (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ days: -5, json: true });
          const output = capture.getOutput();
          // Should have error output, not throw
          expect(output).toContain("error");
          expect(output).toContain("days");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid days (zero)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ days: 0, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid maxSessions (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ maxSessions: -10, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty agent string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ agent: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("agent");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects whitespace-only agent string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ agent: "   ", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty workspace string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ workspace: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("workspace");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty session string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await reflectCommand({ session: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("session");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid positive days", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        // Disable LLM to avoid API calls
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ days: 7, json: true });
          const output = capture.getOutput();
          // Should not contain input validation error
          expect(output).not.toContain("must be a positive integer");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts undefined options (uses defaults)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ json: true });
          const output = capture.getOutput();
          // Should process without input validation errors
          expect(output).not.toContain("must be a positive integer");
          expect(output).not.toContain("must be a non-empty string");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("reflectCommand human output", () => {
  test("shows REFLECT header and workspace info", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ workspace: "/test/workspace" });
          const output = capture.getOutput();
          expect(output).toContain("REFLECT");
          expect(output).toContain("Workspace:");
          expect(output).toContain("/test/workspace");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows session info when session specified", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ session: "/path/to/session.jsonl" });
          const output = capture.getOutput();
          expect(output).toContain("Session:");
          expect(output).toContain("/path/to/session.jsonl");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows dry-run mode indicator", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ dryRun: true });
          const output = capture.getOutput();
          expect(output).toContain("dry-run");
          expect(output).toContain("DRY RUN");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows no new sessions message when empty", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          // Use days: 1 with no sessions available (isolated test environment)
          await reflectCommand({ days: 1, maxSessions: 1 });
          const output = capture.getOutput();
          // In an isolated test environment, there are no sessions to process
          // The output should either show "No new sessions" or "0 session" or progress info
          expect(output).toMatch(/session|REFLECT/i);
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows dry-run summary with delta types", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({ dryRun: true });
          const output = capture.getOutput();
          // Should show proposed changes breakdown
          expect(output).toContain("DRY RUN");
          expect(output).toContain("Sessions processed");
          // May show delta types even if counts are 0
          const hasDeltas =
            output.includes("add") || output.includes("helpful") || output.includes("harmful");
          expect(hasDeltas || output.includes("Proposed")).toBe(true);
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("shows global workspace label when no workspace specified", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        const originalLLM = process.env.CASS_MEMORY_LLM;
        process.env.CASS_MEMORY_LLM = "none";

        const capture = captureConsole();
        try {
          await reflectCommand({});
          const output = capture.getOutput();
          expect(output).toContain("Workspace:");
          expect(output).toContain("global");
        } finally {
          capture.restore();
          process.env.CASS_MEMORY_LLM = originalLLM;
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("reflectOnSession reflector failures (#78)", () => {
  const config = createTestConfig();

  test("reports a failure when the reflector never produced deltas", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    await withLlmShim(
      { errors: { reflector: new Error("runReflector timed out after 30000ms") } },
      async (io) => {
        const result = await reflectOnSession(diary, playbook, config, io);
        expect(result.deltas).toEqual([]);
        expect(result.failure).toContain("runReflector timed out after 30000ms");
      },
    );
  });

  test("a pass that proposed nothing still counts as a completed pass", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    let calls = 0;
    await withLlmShim(
      {
        reflector: () => {
          calls++;
          if (calls > 1) throw new Error("invalid_api_key: rejected on the second pass");
          return { deltas: [] };
        },
      },
      async (io) => {
        const result = await reflectOnSession(
          diary,
          playbook,
          { ...config, maxReflectorIterations: 3 },
          io,
        );
        expect(result.deltas).toEqual([]);
        expect(result.failure).toBeUndefined();
      },
    );
  });

  test("keeps deltas from a successful pass when a later iteration fails", async () => {
    const diary = createTestDiary();
    const playbook = createTestPlaybook();
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { content: "Rule from pass one", category: "test" },
      reason: "first pass worked",
      sourceSession: diary.sessionPath,
    };
    let calls = 0;
    await withLlmShim(
      {
        reflector: () => {
          calls++;
          if (calls > 1) throw new Error("invalid_api_key: rejected on the second pass");
          return { deltas: [delta] };
        },
      },
      async (io) => {
        const result = await reflectOnSession(
          diary,
          playbook,
          { ...config, maxReflectorIterations: 3 },
          io,
        );
        expect(result.deltas.map((d) => (d.type === "add" ? d.bullet.content : d.type))).toEqual([
          "Rule from pass one",
        ]);
        expect(result.failure).toBeUndefined();
      },
    );
  });
});
