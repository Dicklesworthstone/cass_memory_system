/**
 * E2E Tests for CLI project command - Playbook export formats
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";
import { projectCommand } from "../src/commands/project.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig, createTestPlaybook, createBullet, createFeedbackEvent } from "./helpers/factories.js";

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
    },
  };
}

async function writeTestConfig(env: TestEnv): Promise<void> {
  const config = createTestConfig({
    cassPath: "__cass_not_installed__",
    playbookPath: env.playbookPath,
    diaryDir: env.diaryDir,
    verbose: false,
    jsonOutput: false,
  });
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function snapshotFile(log: ReturnType<typeof createE2ELogger>, name: string, filePath: string): Promise<void> {
  const contents = await readFile(filePath, "utf-8").catch(() => "");
  log.snapshot(name, contents);
}

async function withNoColor<T>(fn: () => Promise<T>): Promise<T> {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
  try {
    return await fn();
  } finally {
    process.env.NO_COLOR = originalNoColor;
    process.env.FORCE_COLOR = originalForceColor;
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("E2E: CLI project command", () => {
  it.serial("exports agents.md format and applies --top per category", async () => {
    const log = createE2ELogger("cli-project: agents.md + top");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bulletSecurityHigh = createBullet({
          id: "b-proj-sec-high",
          category: "security",
          content: "Use prepared statements for SQL queries.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs }), createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 2,
        });
        const bulletSecurityLow = createBullet({
          id: "b-proj-sec-low",
          category: "security",
          content: "Low-score security rule (should be excluded by --top 1).",
          maturity: "established",
          feedbackEvents: [],
        });
        const bulletTestingHigh = createBullet({
          id: "b-proj-test-high",
          category: "testing",
          content: "Keep tests deterministic and offline.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 1,
        });
        const bulletTestingLow = createBullet({
          id: "b-proj-test-low",
          category: "testing",
          content: "Low-score testing rule (should be excluded by --top 1).",
          maturity: "established",
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bulletSecurityLow, bulletTestingLow, bulletSecurityHigh, bulletTestingHigh]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format agents.md --top 1 --json" });
              await projectCommand({ format: "agents.md", top: 1, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("project");
        expect(payload.data.format).toBe("agents.md");

        const content = payload.data.content as string;
        expect(content.startsWith("# AGENTS.md")).toBe(true);
        expect(content).toContain("## Summary");
        expect(content).toContain("## Rules");
        expect(content).toContain("### security");
        expect(content).toContain("### testing");

        expect(content).toContain("Use prepared statements for SQL queries.");
        expect(content).not.toContain("Low-score security rule (should be excluded by --top 1).");
        expect(content).toContain("Keep tests deterministic and offline.");
        expect(content).not.toContain("Low-score testing rule (should be excluded by --top 1).");
      });
    });
  });

  it.serial("exports claude.md format and applies --top per category", async () => {
    const log = createE2ELogger("cli-project: claude.md + top");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bulletA = createBullet({
          id: "b-proj-claude-a",
          category: "security",
          content: "Validate JWTs before trusting claims.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs }), createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 2,
        });
        const bulletB = createBullet({
          id: "b-proj-claude-b",
          category: "security",
          content: "Second security rule (excluded by --top 1).",
          maturity: "established",
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bulletB, bulletA]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format claude.md --top 1 --json" });
              await projectCommand({ format: "claude.md", top: 1, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);
        const content = payload.data.content as string;

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("project");
        expect(payload.data.format).toBe("claude.md");
        expect(content.startsWith("<project_rules>")).toBe(true);
        expect(content).toContain("</project_rules>");
        expect(content).toContain("## security");
        expect(content).toContain("Validate JWTs before trusting claims.");
        expect(content).not.toContain("Second security rule (excluded by --top 1).");
      });
    });
  });

  it.serial("exports raw format correctly", async () => {
    const log = createE2ELogger("cli-project: raw");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-raw-1",
          category: "testing",
          content: "Raw export includes schema and bullets.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format raw --json" });
              await projectCommand({ format: "raw", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.data.format).toBe("raw");

        const playbookJson = JSON.parse(payload.data.content);
        expect(playbookJson.schema_version).toBe(2);
        expect(Array.isArray(playbookJson.bullets)).toBe(true);
        expect(playbookJson.bullets.some((b: any) => b.id === "b-proj-raw-1")).toBe(true);
      });
    });
  });
});
