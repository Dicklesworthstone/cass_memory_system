/**
 * E2E Tests for CLI onboard command.
 *
 * Covers:
 * - status JSON output
 * - gaps JSON output
 * - read JSON output
 * - mark-done JSON output
 * - reset confirmation error (JSON)
 */
import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { onboardCommand } from "../src/commands/onboard.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { withTempCassHome } from "./helpers/temp.js";

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
  };
}

describe("E2E: CLI onboard command", () => {
  it("reports status in JSON", async () => {
    const log = createE2ELogger("onboard: status json");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async () => {
        const capture = captureConsole();
        try {
          await onboardCommand({ status: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        log.snapshot("json-output", payload);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("onboard:status");
        expect(payload.data.status).toBeDefined();
        expect(payload.data.progress).toBeDefined();
        expect(payload.data.gapAnalysis).toBeDefined();
      }, "onboard-status-json");
    });
  });

  it("reports gap analysis in JSON", async () => {
    const log = createE2ELogger("onboard: gaps json");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async () => {
        const capture = captureConsole();
        try {
          await onboardCommand({ gaps: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        log.snapshot("json-output", payload);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("onboard:gaps");
        expect(typeof payload.data.gapAnalysis.totalRules).toBe("number");
      }, "onboard-gaps-json");
    });
  });

  it("exports a session for reading (json)", async () => {
    const log = createE2ELogger("onboard: read json");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const sessionPath = path.join(env.home, "session.jsonl");
        const sessionLines = [
          JSON.stringify({ role: "user", content: "Please summarize this session" }),
          JSON.stringify({ role: "assistant", content: "Working on it" }),
        ].join("\n");
        await writeFile(sessionPath, sessionLines, "utf-8");

        const capture = captureConsole();
        try {
          await onboardCommand({ read: sessionPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        log.snapshot("json-output", payload);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("onboard:read");
        expect(payload.data.sessionPath).toBe(sessionPath);
        expect(typeof payload.data.sessionContent).toBe("string");
        expect(payload.data.extractionPrompt).toContain("Session Analysis Instructions");
      }, "onboard-read-json");
    });
  });

  it("marks a session as processed (json)", async () => {
    const log = createE2ELogger("onboard: mark-done json");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const sessionPath = path.join(env.home, "processed.jsonl");

        const capture = captureConsole();
        try {
          await onboardCommand({ markDone: sessionPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        log.snapshot("json-output", payload);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("onboard:mark-done");
        expect(payload.data.sessionPath).toBe(sessionPath);
        expect(payload.data.skipped).toBe(true);
      }, "onboard-mark-done-json");
    });
  });

  it("requires confirmation for reset (json error)", async () => {
    const log = createE2ELogger("onboard: reset requires confirm");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async () => {
        const originalExitCode = process.exitCode;
        process.exitCode = 0;

        const capture = captureConsole();
        try {
          await onboardCommand({ reset: true, json: true });
        } finally {
          capture.restore();
          process.exitCode = originalExitCode;
        }

        const allOutput = [...capture.logs, ...capture.errors].join("\n");
        const jsonMatch = allOutput.match(/\{[^]*\}/);
        expect(jsonMatch).toBeDefined();

        const payload = JSON.parse(jsonMatch![0]);
        log.snapshot("json-error", payload);

        expect(payload.success).toBe(false);
        expect(payload.command).toBe("onboard:reset");
        expect(payload.error?.code).toBe("MISSING_REQUIRED");
      }, "onboard-reset-confirmation");
    });
  });

  it("reads a session in text mode (non-JSON)", async () => {
    const log = createE2ELogger("onboard: read text");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const sessionPath = path.join(env.home, "session-text.jsonl");
        const sessionLines = [
          JSON.stringify({ role: "user", content: "Help me debug this issue" }),
          JSON.stringify({ role: "assistant", content: "Let me check the logs" }),
        ].join("\n");
        await writeFile(sessionPath, sessionLines, "utf-8");

        const capture = captureConsole();
        try {
          await onboardCommand({ read: sessionPath });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("text-output", output);

        // Text mode should show session header and content
        expect(output).toContain("SESSION:");
        expect(output).toContain("analyze this session");
        expect(output).toContain("playbook add");
      }, "onboard-read-text");
    });
  });

  it("reads a session with template mode (JSON)", async () => {
    const log = createE2ELogger("onboard: read template json");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const sessionPath = path.join(env.home, "session-template.jsonl");
        const sessionLines = [
          JSON.stringify({ role: "user", content: "I need to fix a bug in the database query" }),
          JSON.stringify({ role: "assistant", content: "Let me look at the SQL" }),
          JSON.stringify({ role: "user", content: "The query is timing out" }),
          JSON.stringify({ role: "assistant", content: "Adding an index should help" }),
        ].join("\n");
        await writeFile(sessionPath, sessionLines, "utf-8");

        const capture = captureConsole();
        try {
          await onboardCommand({ read: sessionPath, template: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        log.snapshot("template-json-output", payload);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("onboard:read-template");
        expect(payload.data.metadata).toBeDefined();
        expect(payload.data.metadata.path).toBe(sessionPath);
        expect(payload.data.context).toBeDefined();
        expect(payload.data.context.suggestedFocus).toBeDefined();
        expect(payload.data.sessionContent).toBeDefined();
      }, "onboard-read-template-json");
    });
  });

  it("reads a session with template mode (text)", async () => {
    const log = createE2ELogger("onboard: read template text");
    log.setRepro("bun test test/cli-onboard.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        const sessionPath = path.join(env.home, "session-template-text.jsonl");
        const sessionLines = [
          JSON.stringify({ role: "user", content: "Debug this test failure" }),
          JSON.stringify({ role: "assistant", content: "Running tests now" }),
        ].join("\n");
        await writeFile(sessionPath, sessionLines, "utf-8");

        const capture = captureConsole();
        try {
          await onboardCommand({ read: sessionPath, template: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        log.snapshot("template-text-output", output);

        // Template text mode should show structured sections
        expect(output).toContain("SESSION ANALYSIS TEMPLATE");
        expect(output).toContain("METADATA");
        expect(output).toContain("CONTEXT");
        expect(output).toContain("SUGGESTED FOCUS");
        expect(output).toContain("SESSION CONTENT");
        expect(output).toContain("EXTRACTION INSTRUCTIONS");
      }, "onboard-read-template-text");
    });
  });
});
