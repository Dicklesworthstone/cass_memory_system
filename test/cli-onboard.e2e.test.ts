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
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { onboardCommand } from "../src/commands/onboard.js";
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
});
