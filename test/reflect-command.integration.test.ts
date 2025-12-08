import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

import { reflectCommand } from "../src/commands/reflect.js";
import { withTempCassHome, writeFileInDir } from "./helpers/temp.js";
import { createEmptyPlaybook } from "../src/playbook.js";
import { getProcessedLogPath } from "../src/tracking.js";

describe("reflectCommand integration (real modules, stubbed via env)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Ensure no test-specific env leaks into other suites
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("processes a provided session, writes playbook, and records processed log", async () => {
    await withTempCassHome(async (env) => {
      // Make sure HOME points at isolated dir for this test
      process.env.HOME = env.home;

      // Seed an empty playbook at the default path
      await fs.mkdir(path.dirname(env.playbookPath), { recursive: true });
      await fs.writeFile(env.playbookPath, yaml.stringify(createEmptyPlaybook("integration-test")));

      // Write a minimal config that disables validation (avoids LLM) and points to our playbook
      const testConfig = {
        playbookPath: env.playbookPath,
        cassPath: "__missing__", // forces cassExport fallback to file read
        validationEnabled: false,
        provider: "anthropic",
        model: "test-model",
        sessionLookbackDays: 1
      };
      await fs.writeFile(env.configPath, JSON.stringify(testConfig, null, 2));

      // Create a fake session file with enough content for reflection
      const sessionContent = "coding session content with plenty of detail to exceed the 50 character threshold used by the reflector";
      const sessionPath = await writeFileInDir(env.home, "sessions/session-1.jsonl", sessionContent);

      // Stub reflector output so no LLM call occurs
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            { type: "add", bullet: { content: "Reflect Rule", category: "testing" }, reason: "stubbed reflection" }
          ]
        }
      ]);
      process.env.CASS_MEMORY_LLM = "none";

      // Run the command against the single session
      await reflectCommand({ session: sessionPath, json: true });

      // Verify playbook was updated with curated bullet
      const saved = yaml.parse(await fs.readFile(env.playbookPath, "utf-8"));
      const contents = (saved.bullets || []).map((b: any) => b.content);
      expect(contents).toContain("Reflect Rule");

      // Verify processed log captured the session
      const logPath = getProcessedLogPath();
      const logContent = await fs.readFile(logPath, "utf-8");
      expect(logContent).toContain(sessionPath);
    });
  });
});
