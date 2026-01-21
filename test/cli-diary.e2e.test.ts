/**
 * E2E Tests for CLI diary command - Session diary generation
 *
 * Tests the `cm diary` command for:
 * - Raw mode (no cass dependency)
 * - JSON output including savedTo
 * - Human output with save-only behavior
 * - Error handling for missing sessions
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { diaryCommand } from "../src/commands/diary.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

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
    }
  };
}

describe("E2E: CLI diary command", () => {
  it("writes diary from raw session and returns JSON with savedTo", async () => {
    const log = createE2ELogger("diary: raw json");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    const originalLLM = process.env.CASS_MEMORY_LLM;
    process.env.CASS_MEMORY_LLM = "none";

    try {
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const sessionPath = path.join(env.home, "session.jsonl");
          const sessionLines = [
            JSON.stringify({ role: "user", content: "Please fix the bug" }),
            JSON.stringify({ role: "assistant", content: "Working on it" })
          ].join("\n");
          await writeFile(sessionPath, sessionLines, "utf-8");

          const capture = captureConsole();
          try {
            await diaryCommand(sessionPath, { raw: true, json: true, save: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("json-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.command).toBe("diary");
          expect(payload.data?.diary?.sessionPath).toBe(sessionPath);
          expect(typeof payload.data?.savedTo).toBe("string");
        }, "diary-raw-json");
      });
    } finally {
      if (originalLLM === undefined) {
        delete process.env.CASS_MEMORY_LLM;
      } else {
        process.env.CASS_MEMORY_LLM = originalLLM;
      }
    }
  });

  it("prints save-only message when --save is used without --json", async () => {
    const log = createE2ELogger("diary: save only");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    const originalLLM = process.env.CASS_MEMORY_LLM;
    process.env.CASS_MEMORY_LLM = "none";

    try {
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const sessionPath = path.join(env.home, "session.jsonl");
          const sessionLines = [
            JSON.stringify({ role: "user", content: "Summarize changes" }),
            JSON.stringify({ role: "assistant", content: "Done" })
          ].join("\n");
          await writeFile(sessionPath, sessionLines, "utf-8");

          const capture = captureConsole();
          try {
            await diaryCommand(sessionPath, { raw: true, save: true });
          } finally {
            capture.restore();
          }

          const allOutput = capture.logs.join("\n");
          log.snapshot("output", { logs: capture.logs, errors: capture.errors });

          expect(allOutput).toContain("Saved diary");
          expect(allOutput).not.toContain("Diary:");
        }, "diary-save-only");
      });
    } finally {
      if (originalLLM === undefined) {
        delete process.env.CASS_MEMORY_LLM;
      } else {
        process.env.CASS_MEMORY_LLM = originalLLM;
      }
    }
  });

  it("reports missing session file", async () => {
    const log = createE2ELogger("diary: missing session");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const missingPath = path.join(env.home, "missing.jsonl");

        const capture = captureConsole();
        try {
          await diaryCommand(missingPath, { raw: true });
        } finally {
          capture.restore();
        }

        const output = [...capture.logs, ...capture.errors].join("\n");
        log.snapshot("error-output", { logs: capture.logs, errors: capture.errors });
        expect(output).toContain("Session file not found");
      }, "diary-missing-session");
    });
  });

  it("reports error for empty session path", async () => {
    const log = createE2ELogger("diary: empty path");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const capture = captureConsole();
        try {
          await diaryCommand("", { raw: true });
        } finally {
          capture.restore();
        }

        const output = [...capture.logs, ...capture.errors].join("\n");
        log.snapshot("error-output", { logs: capture.logs, errors: capture.errors });
        expect(output).toContain("Session file not found");
      }, "diary-empty-path");
    });
  });

  it("reports error when path is a directory not a file", async () => {
    const log = createE2ELogger("diary: path is directory");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        // Use the temp directory itself as path
        const capture = captureConsole();
        try {
          await diaryCommand(env.home, { raw: true });
        } finally {
          capture.restore();
        }

        const output = [...capture.logs, ...capture.errors].join("\n");
        log.snapshot("error-output", { logs: capture.logs, errors: capture.errors });
        expect(output).toContain("Session file not found");
      }, "diary-is-directory");
    });
  });

  it("reports error for missing session file in JSON mode", async () => {
    const log = createE2ELogger("diary: missing session JSON");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const missingPath = path.join(env.home, "missing.jsonl");

        const capture = captureConsole();
        try {
          await diaryCommand(missingPath, { raw: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("json-error", { logs: capture.logs, errors: capture.errors });

        // Should output valid JSON error
        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
        expect(parsed.error.message).toContain("Session file not found");
      }, "diary-missing-json");
    });
  });

  it("outputs human-readable diary with all fields populated", async () => {
    const log = createE2ELogger("diary: human readable full");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    const originalLLM = process.env.CASS_MEMORY_LLM;
    process.env.CASS_MEMORY_LLM = "none";

    try {
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          // Create a rich session that will produce a diary with various fields
          const sessionPath = path.join(env.home, "session.jsonl");
          const sessionLines = [
            JSON.stringify({ role: "user", content: "Please fix the authentication bug in the login module" }),
            JSON.stringify({ role: "assistant", content: "I'll analyze the authentication issue and fix it." }),
            JSON.stringify({ role: "user", content: "Thanks! Also add some tests please." }),
            JSON.stringify({ role: "assistant", content: "Fixed the bug and added comprehensive tests. The issue was with token expiry validation." })
          ].join("\n");
          await writeFile(sessionPath, sessionLines, "utf-8");

          const capture = captureConsole();
          try {
            // Use default options (human readable, no save)
            await diaryCommand(sessionPath, { raw: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          log.snapshot("human-output", { logs: capture.logs, errors: capture.errors });

          // Should have diary header
          expect(output).toContain("Diary:");
          // Should show session info
          expect(output).toContain("Session:");
          expect(output).toContain("Agent:");
          expect(output).toContain("Timestamp:");
          expect(output).toContain("Status:");
        }, "diary-human-full");
      });
    } finally {
      if (originalLLM === undefined) {
        delete process.env.CASS_MEMORY_LLM;
      } else {
        process.env.CASS_MEMORY_LLM = originalLLM;
      }
    }
  });

  it("handles different file extensions in raw mode", async () => {
    const log = createE2ELogger("diary: different extensions");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    const originalLLM = process.env.CASS_MEMORY_LLM;
    process.env.CASS_MEMORY_LLM = "none";

    try {
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          // Test with .md extension
          const mdPath = path.join(env.home, "session.md");
          const mdContent = `# Session Log

## User
Fix the bug

## Assistant
Done!`;
          await writeFile(mdPath, mdContent, "utf-8");

          const capture = captureConsole();
          try {
            await diaryCommand(mdPath, { raw: true, json: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("md-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.data?.diary?.sessionPath).toBe(mdPath);
        }, "diary-md-extension");
      });
    } finally {
      if (originalLLM === undefined) {
        delete process.env.CASS_MEMORY_LLM;
      } else {
        process.env.CASS_MEMORY_LLM = originalLLM;
      }
    }
  });

  it("handles plain text files without formatting", async () => {
    const log = createE2ELogger("diary: plain text");
    log.setRepro("bun test test/cli-diary.e2e.test.ts");

    const originalLLM = process.env.CASS_MEMORY_LLM;
    process.env.CASS_MEMORY_LLM = "none";

    try {
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          // Test with .txt extension (not formatted)
          const txtPath = path.join(env.home, "session.txt");
          const txtContent = `User: Fix the bug
Assistant: Done!`;
          await writeFile(txtPath, txtContent, "utf-8");

          const capture = captureConsole();
          try {
            await diaryCommand(txtPath, { raw: true, json: true });
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          const payload = JSON.parse(output);
          log.snapshot("txt-output", payload);

          expect(payload.success).toBe(true);
          expect(payload.data?.diary?.sessionPath).toBe(txtPath);
        }, "diary-txt-extension");
      });
    } finally {
      if (originalLLM === undefined) {
        delete process.env.CASS_MEMORY_LLM;
      } else {
        process.env.CASS_MEMORY_LLM = originalLLM;
      }
    }
  });
});

describe("E2E: diary validateSessionPath", () => {
  it("returns null for empty path", async () => {
    const { validateSessionPath } = await import("../src/commands/diary.js");

    expect(await validateSessionPath("")).toBeNull();
    expect(await validateSessionPath("  ")).toBeNull();
  });

  it("returns null for non-existent path", async () => {
    const { validateSessionPath } = await import("../src/commands/diary.js");

    expect(await validateSessionPath("/nonexistent/path/file.jsonl")).toBeNull();
  });

  it("returns null for directory path", async () => {
    const { validateSessionPath } = await import("../src/commands/diary.js");

    await withTempCassHome(async (env) => {
      expect(await validateSessionPath(env.home)).toBeNull();
    }, "validate-dir");
  });

  it("returns expanded path for valid file", async () => {
    const { validateSessionPath } = await import("../src/commands/diary.js");

    await withTempCassHome(async (env) => {
      const sessionPath = path.join(env.home, "session.jsonl");
      await writeFile(sessionPath, "{}", "utf-8");

      const result = await validateSessionPath(sessionPath);
      expect(result).toBe(sessionPath);
    }, "validate-valid");
  });
});

describe("E2E: diary handleDiaryOutput", () => {
  it("outputs diary with accomplishments", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output accomplishments");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-123",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: ["Fixed auth bug", "Added tests"],
          decisions: [],
          challenges: [],
          keyLearnings: [],
          preferences: [],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Accomplishments");
        expect(output).toContain("Fixed auth bug");
        expect(output).toContain("Added tests");
      }, "diary-accomplishments");
    });
  });

  it("outputs diary with decisions", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output decisions");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-456",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: [],
          decisions: ["Used JWT for auth", "Chose PostgreSQL"],
          challenges: [],
          keyLearnings: [],
          preferences: [],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Decisions");
        expect(output).toContain("Used JWT for auth");
      }, "diary-decisions");
    });
  });

  it("outputs diary with challenges", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output challenges");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-789",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "mixed" as const,
          accomplishments: [],
          decisions: [],
          challenges: ["Type errors in legacy code", "Flaky tests"],
          keyLearnings: [],
          preferences: [],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Challenges");
        expect(output).toContain("Type errors in legacy code");
      }, "diary-challenges");
    });
  });

  it("outputs diary with key learnings", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output keyLearnings");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-learn",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: [],
          decisions: [],
          challenges: [],
          keyLearnings: ["Always check token expiry", "Use parameterized queries"],
          preferences: [],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Key Learnings");
        expect(output).toContain("Always check token expiry");
      }, "diary-keylearnings");
    });
  });

  it("outputs diary with preferences", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output preferences");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-prefs",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: [],
          decisions: [],
          challenges: [],
          keyLearnings: [],
          preferences: ["Prefers TypeScript", "Uses functional style"],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Preferences");
        expect(output).toContain("Prefers TypeScript");
      }, "diary-preferences");
    });
  });

  it("outputs diary with tags", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output tags");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-tags",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: [],
          decisions: [],
          challenges: [],
          keyLearnings: [],
          preferences: [],
          tags: ["auth", "security", "typescript"],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Tags:");
        expect(output).toContain("auth");
        expect(output).toContain("security");
      }, "diary-tags");
    });
  });

  it("outputs diary with related sessions", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: output related sessions");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const diary = {
          id: "diary-test-related",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "success" as const,
          accomplishments: [],
          decisions: [],
          challenges: [],
          keyLearnings: [],
          preferences: [],
          tags: [],
          relatedSessions: [
            { agent: "cursor", sessionPath: "/cursor/session1.jsonl", snippet: "Fixed similar auth issue in another project last week" }
          ],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(diary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("output", output);

        expect(output).toContain("Related Sessions:");
        expect(output).toContain("cursor:");
      }, "diary-related");
    });
  });

  it("shows status color based on success/failure/mixed", async () => {
    const { handleDiaryOutput } = await import("../src/commands/diary.js");
    const log = createE2ELogger("diary: status colors");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        // Test failure status
        const failureDiary = {
          id: "diary-failure",
          sessionPath: "/test/session.jsonl",
          agent: "claude",
          workspace: "/test/workspace",
          timestamp: "2024-01-01T00:00:00Z",
          status: "failure" as const,
          accomplishments: [],
          decisions: [],
          challenges: [],
          keyLearnings: [],
          preferences: [],
          tags: [],
          relatedSessions: [],
          searchAnchors: []
        };

        const config = {
          diaryDir: env.home
        } as any;

        const capture = captureConsole();
        try {
          await handleDiaryOutput(failureDiary, {}, config, { command: "diary", startedAtMs: Date.now() });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("failure-output", output);

        expect(output).toContain("Status:");
        expect(output).toContain("failure");
      }, "diary-status-failure");
    });
  });
});
