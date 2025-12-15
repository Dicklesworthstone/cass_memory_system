/**
 * Global test setup for cass-memory test suite
 *
 * This file is preloaded before all tests via bunfig.toml:
 * [test]
 * preload = ["./test/setup.ts"]
 *
 * Provides:
 * - Environment variable isolation for tests
 * - Global test configuration
 * - Cleanup handlers
 */
import { beforeAll, afterAll, afterEach } from "bun:test";

// Store original environment to restore after tests
const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  // Save original environment values
  originalEnv.CASS_MEMORY_TEST = process.env.CASS_MEMORY_TEST;
  originalEnv.CASS_MEMORY_VERBOSE = process.env.CASS_MEMORY_VERBOSE;
  originalEnv.HOME = process.env.HOME;
  originalEnv.CASS_PATH = process.env.CASS_PATH;
  originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  originalEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

  // Set test environment flags
  process.env.CASS_MEMORY_TEST = "1";
  process.env.CASS_MEMORY_VERBOSE = "0";

  // Suppress console output during tests unless DEBUG is set
  if (!process.env.DEBUG) {
    // Tests can still capture console via their own mocks
  }
});

afterAll(() => {
  // Restore original environment
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Ensure the overall test process exits cleanly when the suite passes.
  process.exitCode = undefined;
});

afterEach(() => {
  // Some command tests intentionally set process.exitCode to simulate CLI failures.
  // Ensure it never leaks across tests (and doesn't force bun test to exit non-zero).
  process.exitCode = undefined;
});

// Global timeout for tests (can be overridden per-test)
// Bun default is 5000ms, increase for E2E tests
if (typeof globalThis.Bun !== "undefined") {
  // @ts-ignore - Bun-specific test configuration
  globalThis.testTimeout = 30000;
}

// Export helper for tests that need to check if we're in test mode
export function isTestMode(): boolean {
  return process.env.CASS_MEMORY_TEST === "1";
}

// Export helper to check if verbose logging is enabled
export function isVerboseMode(): boolean {
  return process.env.CASS_MEMORY_VERBOSE === "1" || process.env.DEBUG === "1";
}

// Export helper to check if we should keep temp files for debugging
export function shouldKeepTempFiles(): boolean {
  return process.env.KEEP_TEMP === "1";
}

// Export helper to check if we should keep log files
export function shouldKeepLogs(): boolean {
  return process.env.KEEP_LOGS === "1";
}
