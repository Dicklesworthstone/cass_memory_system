/**
 * Unit tests for playbook get command.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { playbookCommand } from "../src/commands/playbook.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

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
    },
  };
}

// Helper to save playbook to path
async function savePlaybookToPath(playbook: any, playbookPath: string) {
  await writeFile(playbookPath, yaml.stringify(playbook));
}

describe("playbook get command", () => {
  // Save and restore environment
  let originalEnv: Record<string, string | undefined> = {};
  let originalHome: string | undefined;

  beforeEach(() => {
    originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    originalHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api3-test-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (originalHome) {
      process.env.HOME = originalHome;
    }
  });

  it("displays bullet details for valid ID", async () => {
    await withTempDir("playbook-get", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullet = createTestBullet({
        id: "b-test123",
        content: "Always run tests before committing",
        category: "best-practice",
        maturity: "proven",
        helpfulCount: 12,
        harmfulCount: 1,
        tags: ["testing", "ci-cd"],
        sourceSessions: ["/sessions/session1.jsonl", "/sessions/session2.jsonl"],
        sourceAgents: ["claude", "cursor"],
      });
      const playbook = createTestPlaybook([bullet]);
      await savePlaybookToPath(playbook, playbookPath);

      const configPath = path.join(dir, ".cass-memory", "config.json");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(configPath, JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("get", ["b-test123"], { json: false });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      expect(output).toContain("BULLET: b-test123");
      expect(output).toContain("proven");
    });
  });

  it("shows pinned status for pinned bullets", async () => {
    await withTempDir("playbook-get", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      // Set pinned: true explicitly
      const bullet = createTestBullet({
        id: "b-pinned",
        content: "Important pinned rule",
        category: "critical",
        pinned: true,
      });
      const playbook = createTestPlaybook([bullet]);
      await savePlaybookToPath(playbook, playbookPath);

      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("get", ["b-pinned"], { json: false });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      expect(output).toContain("PINNED");
    });
  });
});
