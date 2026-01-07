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
});
