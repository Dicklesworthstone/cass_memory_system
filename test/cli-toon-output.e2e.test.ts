import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import yaml from "yaml";

import { contextCommand } from "../src/commands/context.js";
import { statsCommand } from "../src/commands/stats.js";
import { playbookCommand } from "../src/commands/playbook.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { isToonAvailable } from "../src/utils.js";
import { TestEnv, withTempCassHome } from "./helpers/temp.js";

const envKeys = [
  "CM_OUTPUT_FORMAT",
  "TOON_DEFAULT_FORMAT",
  "TOON_TRU_BIN",
  "TOON_BIN",
  "TOON_STATS",
  "CASS_PATH",
  "PATH",
] as const;

const originalEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "TOON output test playbook",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    bullets,
    deprecatedPatterns: [],
  };
}

function createTestBullet(overrides: Partial<{
  id: string;
  content: string;
  kind: string;
  category: string;
  scope: string;
  state: string;
  maturity: string;
  helpfulCount: number;
  harmfulCount: number;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "workflow_rule",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    state: overrides.state || "active",
    maturity: overrides.maturity || "candidate",
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    createdAt: now,
    updatedAt: now,
    feedbackEvents: [],
    tags: [],
  };
}

async function seedCassHome(env: TestEnv, bullets: any[] = [createTestBullet()]) {
  const config = { schema_version: 1 };
  await writeFile(env.configPath, JSON.stringify(config, null, 2));
  const playbook = createTestPlaybook(bullets);
  await writeFile(env.playbookPath, yaml.stringify(playbook));
}

function withTruUnavailable(): () => void {
  // Use require to patch the exact module instances used by utils.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const childProcess = require("child_process");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");

  const spawnSpy = spyOn(childProcess, "spawnSync").mockImplementation((...callArgs: any[]) => {
    const argv = Array.isArray(callArgs[1]) ? callArgs[1].map(String) : [];
    const sub = argv[0] ?? "";
    if (sub === "--help" || sub === "--version") {
      return {
        pid: 0,
        output: [],
        stdout: "",
        stderr: "not found",
        status: 1,
        signal: null,
        error: new Error("not found"),
      } as any;
    }
    return {
      pid: 0,
      output: [],
      stdout: "",
      stderr: "not found",
      status: 1,
      signal: null,
      error: new Error("not found"),
    } as any;
  });

  const existsSpy = spyOn(fs, "existsSync").mockImplementation(() => false);

  return () => {
    spawnSpy.mockRestore();
    existsSpy.mockRestore();
  };
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const originalLog = console.log;
  const originalError = console.error;
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const captureWrite = (sink: "stdout" | "stderr") => (chunk: any, encoding?: any, cb?: any) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    if (sink === "stdout") stdout += text;
    else stderr += text;

    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  };

  console.log = (...args: any[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: any[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  (process.stdout.write as any) = captureWrite("stdout");
  (process.stderr.write as any) = captureWrite("stderr");

  try {
    const result = await fn();
    return { result, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    (process.stdout.write as any) = originalOut;
    (process.stderr.write as any) = originalErr;
  }
}

function decodeToJson(toon: string): any {
  const decoded = spawnSync("tru", ["--decode"], { input: toon, encoding: "utf8" });
  if (decoded.error || decoded.status !== 0) {
    const message = decoded.error?.message || decoded.stderr || "unknown error";
    throw new Error(`tru --decode failed: ${message}`);
  }
  const output = String(decoded.stdout ?? "").trim();
  return JSON.parse(output);
}

describe("TOON output (CLI commands)", () => {
  describe("Fallback to JSON when tru is missing", () => {
    it("context --format toon falls back to JSON", async () => {
      await withTempCassHome(async (env) => {
        await seedCassHome(env);
        process.env.CASS_PATH = "/__missing__/cass";
        process.env.TOON_TRU_BIN = "/__missing__/tru";
        process.env.TOON_BIN = "/__missing__/tru";
        process.env.PATH = "";

        const restoreTru = withTruUnavailable();
        try {
        const { stdout, stderr } = await captureOutput(() =>
          contextCommand("test task", { format: "toon" })
        );

        expect(stderr).toContain("tru binary not found");
        expect(() => JSON.parse(stdout)).not.toThrow();
        const payload = JSON.parse(stdout);
        expect(payload.command).toBe("context");
        } finally {
          restoreTru();
        }
      });
    });

    it("stats --format toon falls back to JSON", async () => {
      await withTempCassHome(async (env) => {
        await seedCassHome(env);
        process.env.TOON_TRU_BIN = "/__missing__/tru";
        process.env.TOON_BIN = "/__missing__/tru";
        process.env.PATH = "";

        const restoreTru = withTruUnavailable();
        try {
        const { stdout, stderr } = await captureOutput(() =>
          statsCommand({ format: "toon" })
        );

        expect(stderr).toContain("tru binary not found");
        expect(() => JSON.parse(stdout)).not.toThrow();
        const payload = JSON.parse(stdout);
        expect(payload.command).toBe("stats");
        } finally {
          restoreTru();
        }
      });
    });

    it("playbook list --format toon falls back to JSON", async () => {
      await withTempCassHome(async (env) => {
        await seedCassHome(env);
        process.env.TOON_TRU_BIN = "/__missing__/tru";
        process.env.TOON_BIN = "/__missing__/tru";
        process.env.PATH = "";

        const restoreTru = withTruUnavailable();
        try {
        const { stdout, stderr } = await captureOutput(() =>
          playbookCommand("list", [], { format: "toon" })
        );

        expect(stderr).toContain("tru binary not found");
        expect(() => JSON.parse(stdout)).not.toThrow();
        const payload = JSON.parse(stdout);
        expect(payload.command).toBe("playbook:list");
        } finally {
          restoreTru();
        }
      });
    });

    it("doctor --format toon falls back to JSON", async () => {
      await withTempCassHome(async (env) => {
        await seedCassHome(env);
        process.env.TOON_TRU_BIN = "/__missing__/tru";
        process.env.TOON_BIN = "/__missing__/tru";
        process.env.PATH = "";

        const restoreTru = withTruUnavailable();
        try {
        const { stdout, stderr } = await captureOutput(() =>
          doctorCommand({ format: "toon" })
        );

        expect(stderr).toContain("tru binary not found");
        expect(() => JSON.parse(stdout)).not.toThrow();
        const payload = JSON.parse(stdout);
        expect(payload.command).toBe("doctor");
        } finally {
          restoreTru();
        }
      });
    });
  });

  describe("Roundtrip decode when tru is available", () => {
    it("decodes TOON for context, stats, playbook, and doctor", async () => {
      if (!isToonAvailable()) {
        console.log("Skipping TOON roundtrip tests - tru not installed");
        return;
      }

      await withTempCassHome(async (env) => {
        await seedCassHome(env);
        process.env.CASS_PATH = "/__missing__/cass";
        process.env.TOON_TRU_BIN = "tru";

        const contextOut = await captureOutput(() =>
          contextCommand("test task", { format: "toon" })
        );
        const contextPayload = decodeToJson(contextOut.stdout);
        expect(contextPayload.command).toBe("context");

        const statsOut = await captureOutput(() =>
          statsCommand({ format: "toon" })
        );
        const statsPayload = decodeToJson(statsOut.stdout);
        expect(statsPayload.command).toBe("stats");

        const playbookOut = await captureOutput(() =>
          playbookCommand("list", [], { format: "toon" })
        );
        const playbookPayload = decodeToJson(playbookOut.stdout);
        expect(playbookPayload.command).toBe("playbook:list");

        const doctorOut = await captureOutput(() =>
          doctorCommand({ format: "toon" })
        );
        const doctorPayload = decodeToJson(doctorOut.stdout);
        expect(doctorPayload.command).toBe("doctor");
      });
    });
  });
});
