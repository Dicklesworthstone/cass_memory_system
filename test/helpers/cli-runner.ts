import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Override HOME for isolated testing */
  home?: string;
}

/**
 * Run the cm CLI command and capture results.
 * Uses the built dist/index.js directly via bun.
 */
export async function runCLI(args: string[], options: RunOptions = {}): Promise<CLIResult> {
  const startTime = performance.now();
  const cliPath = resolve(import.meta.dirname, "../../dist/index.js");

  const env: Record<string, string> = {
    ...process.env,
    ...options.env,
    // Disable color for predictable output
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  if (options.home) {
    env.HOME = options.home;
    env.USERPROFILE = options.home; // Windows compat
  }

  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", cliPath, ...args], {
      cwd: options.cwd,
      env,
      timeout: options.timeout ?? 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const duration = performance.now() - startTime;
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration,
      });
    });

    proc.on("error", (err) => {
      const duration = performance.now() - startTime;
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        duration,
      });
    });
  });
}

/**
 * Parse JSON from CLI stdout, with helpful error on failure.
 */
export function parseJSONOutput<T = unknown>(result: CLIResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `Failed to parse CLI JSON output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}

/**
 * Assert CLI command succeeded (exit code 0).
 */
export function assertCLISuccess(result: CLIResult, context?: string): void {
  if (result.exitCode !== 0) {
    const msg = context ? `CLI failed: ${context}` : "CLI command failed";
    throw new Error(
      `${msg}\nExit code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}
