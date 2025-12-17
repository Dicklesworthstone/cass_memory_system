/**
 * Unit tests for `src/cm.ts` CLI router.
 *
 * Goal: cover command registration, help/version wiring, and error formatting
 * in-process (so Bun coverage can include `src/cm.ts`).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createProgram, hasJsonFlag, handleCliError } from "../src/cm.js";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function captureConsole<T>(fn: () => T): { result: T; logs: string[]; errors: string[] } {
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

  try {
    return { result: fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function captureProcessOutput<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";

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

  (process.stdout.write as any) = captureWrite("stdout");
  (process.stderr.write as any) = captureWrite("stderr");

  try {
    return { result: fn(), stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } finally {
    (process.stdout.write as any) = originalOut;
    (process.stderr.write as any) = originalErr;
  }
}

describe("cm.ts CLI router (unit)", () => {
  test("createProgram wires name + version from package.json", () => {
    withEnv({ CASS_MEMORY_CLI_NAME: "cm-test" }, () => {
      const program = createProgram(["bun", "src/cm.ts"]);
      expect(program.name()).toBe("cm-test");
      expect(program.version()).toBe(PACKAGE_JSON.version);
    });
  });

  test("registers expected top-level commands", () => {
    const program = createProgram(["bun", "src/cm.ts"]);
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining([
      "init",
      "context",
      "similar",
      "mark",
      "playbook",
      "stats",
      "top",
      "stale",
      "why",
      "undo",
      "usage",
      "validate",
      "doctor",
      "reflect",
      "forget",
      "audit",
      "project",
      "starters",
      "quickstart",
      "privacy",
      "serve",
      "outcome",
      "outcome-apply",
      "onboard",
    ]));
  });

  test("registers playbook subcommands", () => {
    const program = createProgram(["bun", "src/cm.ts"]);
    const playbook = program.commands.find((cmd) => cmd.name() === "playbook");
    expect(playbook).toBeTruthy();

    const subNames = playbook!.commands.map((cmd) => cmd.name());
    expect(subNames).toEqual(expect.arrayContaining(["list", "add", "remove", "get", "export", "import"]));
  });

  test("registers onboarding subcommands", () => {
    const program = createProgram(["bun", "src/cm.ts"]);
    const onboard = program.commands.find((cmd) => cmd.name() === "onboard");
    expect(onboard).toBeTruthy();

    const subNames = onboard!.commands.map((cmd) => cmd.name());
    expect(subNames).toEqual(expect.arrayContaining([
      "status",
      "gaps",
      "sample",
      "read",
      "prompt",
      "guided",
      "mark-done",
      "reset",
    ]));
  });

  test("adds global flags and -j alias to help", () => {
    const program = createProgram(["bun", "src/cm.ts"]);
    const { stdout } = captureProcessOutput(() => program.outputHelp());

    expect(stdout).toContain("Start here (agents):");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("Global options:");
    expect(stdout).toContain("--no-color");
    expect(stdout).toContain("--no-emoji");
    expect(stdout).toContain("--width <n>");
    expect(stdout).toContain("--verbose");

    const context = program.commands.find((cmd) => cmd.name() === "context");
    expect(context).toBeTruthy();
    expect(context!.helpInformation()).toContain("-j, --json");
  });
});

describe("cm.ts argv detection helpers (unit)", () => {
  test("hasJsonFlag detects --json and -j", () => {
    expect(hasJsonFlag(["bun", "src/cm.ts", "--json"])).toBe(true);
    expect(hasJsonFlag(["bun", "src/cm.ts", "-j"])).toBe(true);
  });

  test("hasJsonFlag detects --format json forms", () => {
    expect(hasJsonFlag(["bun", "src/cm.ts", "context", "task", "--format", "json"])).toBe(true);
    expect(hasJsonFlag(["bun", "src/cm.ts", "context", "task", "--format=json"])).toBe(true);
  });

  test("hasJsonFlag does not treat option values as command tokens", () => {
    expect(
      hasJsonFlag([
        "bun",
        "src/cm.ts",
        "--width",
        "80",
        "context",
        "task",
        "--format",
        "markdown",
        "--json",
      ])
    ).toBe(false);
  });
});

describe("cm.ts error formatting helper (unit)", () => {
  test("handleCliError emits JSON to stdout in JSON mode", () => {
    const { logs, errors } = withEnv(
      { NO_COLOR: "1", FORCE_COLOR: "0", CASS_MEMORY_CLI_NAME: "cm-test" },
      () => captureConsole(() => handleCliError(new Error("boom"), ["bun", "src/cm.ts", "--json"]))
    );

    expect(errors.length).toBe(0);
    expect(logs.length).toBe(1);

    const parsed = JSON.parse(logs[0] ?? "{}");
    expect(parsed).toHaveProperty("success", false);
    expect(parsed).toHaveProperty("error");
    expect(parsed).toHaveProperty("error.code");
  });

  test("handleCliError emits human error to stderr in human mode", () => {
    const { logs, errors } = withEnv(
      { NO_COLOR: "1", FORCE_COLOR: "0", CASS_MEMORY_CLI_NAME: "cm-test" },
      () => captureConsole(() => handleCliError(new Error("boom"), ["bun", "src/cm.ts"]))
    );

    expect(logs.length).toBe(0);
    expect(errors.join("\n")).toContain("cm-test: error:");
    expect(errors.join("\n")).toContain("boom");
  });
});
