/**
 * E2E Tests for CLI quickstart command - Self-documentation for agents
 *
 * Tests the `cm quickstart` command which outputs documentation
 * designed for consumption by AI coding agents.
 */
import { describe, it, expect } from "bun:test";
import { quickstartCommand } from "../src/commands/quickstart.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

// Helper to capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
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

describe("E2E: CLI quickstart command", () => {
  describe("text output mode", () => {
    it("outputs markdown-formatted documentation", async () => {
      const log = createE2ELogger("quickstart: text output");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          log.startTimer("quickstartCommand");
          await quickstartCommand({});
          log.endTimer("quickstartCommand");
        } finally {
          capture.restore();
        }

        log.snapshot("output", { logs: capture.logs.slice(0, 10), errors: capture.errors });

        const output = capture.logs.join("\n");

        // Verify key sections are present
        expect(output).toContain("Quick Start");
        expect(output).toContain("The One Command You Need");
        expect(output).toContain("context");
        expect(output).toContain("--json");

        // Verify examples are present
        expect(output).toContain("implement JWT authentication");

        // Verify protocol is present
        expect(output).toContain("Protocol");
        expect(output).toContain("START");
        expect(output).toContain("WORK");
        expect(output).toContain("FEEDBACK");
        expect(output).toContain("END");

        // Verify inline feedback format is explained
        expect(output).toContain("[cass: helpful");
        expect(output).toContain("[cass: harmful");
      });
    });

    it("includes information about degraded mode", async () => {
      const log = createE2ELogger("quickstart: degraded mode info");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");

        // Should mention degraded mode
        expect(output.toLowerCase()).toContain("degraded");
        expect(output).toContain("doctor");
      });
    });

    it("includes solo user instructions", async () => {
      const log = createE2ELogger("quickstart: solo user info");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");

        // Should include solo user section
        expect(output).toContain("Solo Users");
        expect(output).toContain("reflect");
        expect(output).toContain("onboard");
      });
    });
  });

  describe("JSON output mode", () => {
    it("outputs valid JSON with correct structure", async () => {
      const log = createE2ELogger("quickstart: JSON output");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        log.snapshot("output", { logs: capture.logs, errors: capture.errors });

        // Find and parse JSON output
        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        expect(jsonOutput).toBeDefined();

        const parsed = JSON.parse(jsonOutput!);
        log.snapshot("parsed JSON", parsed);

        // Verify top-level structure
        expect(parsed.success).toBe(true);
        expect(parsed.command).toBe("quickstart");
        expect(parsed.data).toBeDefined();
      });
    });

    it("JSON output contains required fields", async () => {
      const log = createE2ELogger("quickstart: JSON fields");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);
        const data = parsed.data;

        log.snapshot("data fields", Object.keys(data));

        // Verify required fields
        expect(data.summary).toBeDefined();
        expect(data.oneCommand).toBeDefined();
        expect(data.whatItReturns).toBeDefined();
        expect(data.doNotDo).toBeDefined();
        expect(data.inlineFeedbackFormat).toBeDefined();
        expect(data.protocol).toBeDefined();
        expect(data.examples).toBeDefined();
      });
    });

    it("JSON oneCommand contains context command", async () => {
      const log = createE2ELogger("quickstart: oneCommand");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);

        // oneCommand should reference the context command
        expect(parsed.data.oneCommand).toContain("context");
        expect(parsed.data.oneCommand).toContain("--json");
      });
    });

    it("JSON whatItReturns lists expected fields", async () => {
      const log = createE2ELogger("quickstart: whatItReturns");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);
        const returns = parsed.data.whatItReturns;

        expect(Array.isArray(returns)).toBe(true);
        expect(returns.length).toBeGreaterThan(0);

        // Should mention key context result fields
        const joined = returns.join(" ");
        expect(joined).toContain("relevantBullets");
        expect(joined).toContain("antiPatterns");
        expect(joined).toContain("historySnippets");
      });
    });

    it("JSON protocol has all four phases", async () => {
      const log = createE2ELogger("quickstart: protocol phases");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);
        const protocol = parsed.data.protocol;

        expect(protocol.start).toBeDefined();
        expect(protocol.work).toBeDefined();
        expect(protocol.feedback).toBeDefined();
        expect(protocol.end).toBeDefined();
      });
    });

    it("JSON includes solo user section", async () => {
      const log = createE2ELogger("quickstart: solo user JSON");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);

        expect(parsed.data.soloUser).toBeDefined();
        expect(parsed.data.soloUser.manualReflection).toBeDefined();
        expect(parsed.data.soloUser.onboarding).toBeDefined();
      });
    });

    it("JSON includes expectations about degraded mode", async () => {
      const log = createE2ELogger("quickstart: expectations JSON");
      log.setRepro("bun test test/cli-quickstart.e2e.test.ts");

      await log.run(async () => {
        const capture = captureConsole();
        try {
          await quickstartCommand({ json: true });
        } finally {
          capture.restore();
        }

        const jsonOutput = capture.logs.find(l => l.startsWith("{"));
        const parsed = JSON.parse(jsonOutput!);

        expect(parsed.data.expectations).toBeDefined();
        expect(parsed.data.expectations.degradedMode).toBeDefined();
        expect(parsed.data.expectations.privacy).toBeDefined();
      });
    });
  });
});
