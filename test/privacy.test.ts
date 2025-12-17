import { describe, test, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import { privacyCommand } from "../src/commands/privacy.js";
import type { CassRunner } from "../src/cass.js";
import { getDefaultConfig } from "../src/config.js";
import type { Config } from "../src/types.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";

function createCassRunnerForTimeline(stdout: string): CassRunner {
  return {
    execFile: async (_file, args) => {
      const cmd = args[0] ?? "";
      if (cmd !== "timeline") throw new Error(`Unexpected cass execFile command: ${cmd}`);
      return { stdout, stderr: "" };
    },
    spawnSync: (_file, args) => {
      const cmd = args[0] ?? "";
      if (cmd === "--version") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn: (() => {
      throw new Error("spawn not implemented in cass runner stub");
    }) as any,
  };
}

async function seedGlobalConfig(env: TestEnv, overrides: Partial<Config>): Promise<void> {
  const base = getDefaultConfig();
  const next: Config = {
    ...base,
    ...overrides,
    crossAgent: {
      ...base.crossAgent,
      ...(overrides.crossAgent || {}),
    },
    remoteCass: {
      ...base.remoteCass,
      ...(overrides.remoteCass || {}),
    },
    sanitization: {
      ...base.sanitization,
      ...(overrides.sanitization || {}),
    },
    scoring: {
      ...base.scoring,
      ...(overrides.scoring || {}),
    },
    budget: {
      ...base.budget,
      ...(overrides.budget || {}),
    },
  };

  await writeFile(env.configPath, JSON.stringify(next, null, 2));
}

async function captureConsoleOutput<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    stdoutLines.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    stderrLines.push(args.map(String).join(" "));
  };

  try {
    const result = await fn();
    return { result, stdout: stdoutLines.join("\n").trim(), stderr: stderrLines.join("\n").trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("privacy command (unit)", () => {
  test("status --json reports cass unavailable without depending on cass binary", async () => {
    await withTempCassHome(async (env) => {
      await seedGlobalConfig(env, { cassPath: "/__missing__/cass" });

      const { stdout } = await captureConsoleOutput(() => privacyCommand("status", [], { json: true, days: 30 }));
      const parsed = JSON.parse(stdout) as any;

      expect(parsed.success).toBeTrue();
      expect(parsed.data.crossAgent.enabled).toBeFalse();
      expect(parsed.data.cass.available).toBeFalse();
      expect(parsed.data.cass.timelineDays).toBe(30);
      expect(parsed.data.cass.sessionCountsByAgent).toBeNull();
      expect(parsed.data.notes.enable).toContain("privacy enable");
    }, "privacy-status");
  });

  test("enable --json uses default allowlist when cass is unavailable", async () => {
    await withTempCassHome(async (env) => {
      await seedGlobalConfig(env, { cassPath: "/__missing__/cass" });

      const { stdout } = await captureConsoleOutput(() => privacyCommand("enable", [], { json: true, days: 7 }));
      const parsed = JSON.parse(stdout) as any;

      expect(parsed.success).toBeTrue();
      expect(parsed.data.crossAgent.enabled).toBeTrue();
      expect(parsed.data.crossAgent.consentGiven).toBeTrue();
      expect(typeof parsed.data.crossAgent.consentDate).toBe("string");
      expect(parsed.data.crossAgent.agents).toEqual(["claude", "cursor", "codex", "aider", "pi_agent"]);

      const persisted = JSON.parse(await readFile(env.configPath, "utf-8"));
      expect(persisted.crossAgent.enabled).toBeTrue();
      expect(persisted.crossAgent.agents).toEqual(["claude", "cursor", "codex", "aider", "pi_agent"]);
    }, "privacy-enable-default");
  });

  test("enable --json normalizes, dedupes, and sorts requested agents", async () => {
    await withTempCassHome(async (env) => {
      await seedGlobalConfig(env, { cassPath: "/__missing__/cass" });

      const { stdout } = await captureConsoleOutput(() =>
        privacyCommand("enable", [" Cursor ", "claude", "CODEX", "claude"], { json: true })
      );
      const parsed = JSON.parse(stdout) as any;

      expect(parsed.data.crossAgent.agents).toEqual(["claude", "codex", "cursor"]);
    }, "privacy-enable-requested");
  });

  test("allow and deny mutate allowlist deterministically", async () => {
    await withTempCassHome(async (env) => {
      await seedGlobalConfig(env, {
        cassPath: "/__missing__/cass",
        crossAgent: { enabled: true, consentGiven: true, agents: ["Codex", "claude"], auditLog: true },
      });

      const allowOut = await captureConsoleOutput(() => privacyCommand("allow", [" Cursor "], { json: true }));
      const allowed = JSON.parse(allowOut.stdout) as any;
      expect(allowed.data.crossAgent.agents).toEqual(["claude", "codex", "cursor"]);

      const denyOut = await captureConsoleOutput(() => privacyCommand("deny", ["codex"], { json: true }));
      const denied = JSON.parse(denyOut.stdout) as any;
      expect(denied.data.crossAgent.agents).toEqual(["claude", "cursor"]);

      const persisted = JSON.parse(await readFile(env.configPath, "utf-8"));
      expect(persisted.crossAgent.agents).toEqual(["claude", "cursor"]);
    }, "privacy-allow-deny");
  });

  test("status --json returns per-agent session counts when cass is available", async () => {
    await withTempCassHome(async (env) => {
      const timeline = JSON.stringify({
        groups: [
          {
            date: "2025-01-01",
            sessions: [
              { path: "/sessions/s1.jsonl", agent: "Claude" },
              { path: "/sessions/s2.jsonl", agent: "Cursor" },
              { path: "/sessions/s3.jsonl", agent: "Cursor" },
            ],
          },
        ],
      });

      const runner = createCassRunnerForTimeline(timeline);
      await seedGlobalConfig(env, { cassPath: "cass" });

      const { stdout } = await captureConsoleOutput(() =>
        privacyCommand("status", [], { json: true, days: 14 }, { cassRunner: runner })
      );
      const parsed = JSON.parse(stdout) as any;

      expect(parsed.data.cass.available).toBeTrue();
      expect(parsed.data.cass.sessionCountsByAgent).toEqual({ claude: 1, cursor: 2 });
    }, "privacy-status-cass");
  });
});
