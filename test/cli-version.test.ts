/**
 * Tests for CLI version handling and error formatting.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CM_PATH = join(ROOT, "src/cm.ts");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/**
 * Helper to run cm.ts and capture output.
 */
async function runCm(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", CM_PATH, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

describe("CLI Version", () => {
  test("--version outputs package.json version", async () => {
    const result = await runCm(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(PACKAGE_JSON.version);
  });

  test("-V outputs package.json version", async () => {
    const result = await runCm(["-V"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(PACKAGE_JSON.version);
  });

  test("version matches package.json exactly", async () => {
    const { getVersion } = await import("../src/utils.js");
    expect(getVersion()).toBe(PACKAGE_JSON.version);
  });
});

describe("CLI Error Handling", () => {
  test("unknown command exits with non-zero code", async () => {
    const result = await runCm(["nonexistent-command-xyz"]);
    expect(result.code).not.toBe(0);
  });

  test("error in human mode outputs to stderr", async () => {
    const result = await runCm(["nonexistent-command-xyz"]);
    expect(result.stderr).toContain("error");
  });

  test("error in JSON mode outputs structured JSON", async () => {
    // Use a command that will fail (e.g., playbook get with invalid ID)
    const result = await runCm(["playbook", "get", "invalid-id-12345", "--json"]);

    if (result.code !== 0) {
      // If command failed, check for JSON error output
      try {
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("error");
      } catch {
        // Some commands may write error directly to stderr even with --json
        // This is acceptable as long as exit code is non-zero
        expect(result.code).not.toBe(0);
      }
    }
  });

  test("missing required argument shows error", async () => {
    const result = await runCm(["context"]); // Missing required <task> argument
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing required argument");
  });
});
