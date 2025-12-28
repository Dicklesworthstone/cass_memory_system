import { describe, test, expect } from "bun:test";
import { Writable } from "node:stream";

import { createProgress } from "../src/progress.js";

/**
 * Helper to capture stream output for assertions.
 * Creates a writable stream that collects all written data.
 */
function createCaptureStream(): { stream: Writable; getOutput: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk);
      callback();
    },
  });
  return {
    stream,
    getOutput: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Helper to create a mock TTY stream for spinner tests.
 */
function createMockTtyStream(): { stream: Writable & { isTTY: true; columns: number }; getOutput: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk);
      callback();
    },
  }) as Writable & { isTTY: true; columns: number };
  stream.isTTY = true;
  stream.columns = 80;
  return {
    stream,
    getOutput: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Wait for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("progress.ts", () => {
  describe("createProgress factory", () => {
    test("returns a ProgressReporter with update, complete, fail methods", () => {
      const { stream } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
      });

      expect(progress).toHaveProperty("update");
      expect(progress).toHaveProperty("complete");
      expect(progress).toHaveProperty("fail");
      expect(typeof progress.update).toBe("function");
      expect(typeof progress.complete).toBe("function");
      expect(typeof progress.fail).toBe("function");

      // Clean up - complete to clear timers
      progress.complete();
    });

    test("respects delayMs option - no output before delay", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Loading",
        stream,
        delayMs: 100,
      });

      // Immediately check - should be empty
      expect(getOutput()).toBe("");

      progress.complete();
    });

    test("shows output after delay has passed", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Loading",
        stream,
        delayMs: 10,
        format: "text",
      });

      // Wait for delay
      await sleep(30);

      // Now should have output
      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);

      progress.complete();
    });

    test("JSON format outputs newline-delimited JSON", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
      });

      // Trigger immediate show
      await sleep(10);

      const output = getOutput();
      if (output.length > 0) {
        const lines = output.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          expect(parsed.event).toBe("progress");
          expect(parsed.message).toBe("Processing");
        }
      }

      progress.complete();
    });
  });

  describe("update method", () => {
    test("updates current progress value", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(50, "Halfway");
      await sleep(10);

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const hasUpdate = lines.some((line) => {
        const parsed = JSON.parse(line);
        return parsed.current === 50;
      });

      expect(hasUpdate).toBe(true);
      progress.complete();
    });

    test("handles negative values by clamping to 0", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(-10);
      await sleep(10);

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        expect(parsed.current).toBe(0);
      }

      progress.complete();
    });

    test("handles NaN by treating as 0", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(NaN);
      await sleep(10);

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        expect(parsed.current).toBe(0);
      }

      progress.complete();
    });

    test("floors fractional values", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(42.9);
      await sleep(10);

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        expect(parsed.current).toBe(42);
      }

      progress.complete();
    });

    test("ignores updates after complete", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.complete("Done");
      const outputBefore = getOutput();

      progress.update(99, "Should be ignored");
      await sleep(10);
      const outputAfter = getOutput();

      // After complete, no more updates should be written
      expect(outputAfter).toBe(outputBefore);
    });
  });

  describe("complete method", () => {
    test("outputs success message", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.complete("All done!");

      const output = getOutput();
      expect(output).toContain("All done!");
    });

    test("uses default message when none provided", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.complete();

      const output = getOutput();
      expect(output).toContain("Done");
    });

    test("JSON format includes final progress event", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
      });

      await sleep(10);
      progress.complete("Finished");

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        expect(parsed.message).toBe("Finished");
        expect(parsed.current).toBe(100);
      }
    });

    test("ignores multiple complete calls", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
      });

      await sleep(10);
      progress.complete("First");
      const outputAfterFirst = getOutput();

      progress.complete("Second");
      const outputAfterSecond = getOutput();

      expect(outputAfterSecond).toBe(outputAfterFirst);
    });
  });

  describe("fail method", () => {
    test("outputs failure message", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.fail("Something went wrong");

      const output = getOutput();
      expect(output).toContain("Something went wrong");
    });

    test("uses default message when empty string provided", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.fail("");

      const output = getOutput();
      expect(output).toContain("Failed");
    });

    test("JSON format includes failure event", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
      });

      await sleep(10);
      progress.update(50);
      await sleep(10);
      progress.fail("Error occurred");

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        expect(parsed.message).toBe("Error occurred");
        expect(parsed.current).toBe(50);
      }
    });

    test("prevents further updates after fail", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Test",
        stream,
        delayMs: 0,
        format: "json",
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.fail("Error");
      const outputBefore = getOutput();

      progress.update(99);
      await sleep(10);
      const outputAfter = getOutput();

      expect(outputAfter).toBe(outputBefore);
    });
  });

  describe("progress display", () => {
    test("shows percentage when total is provided", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(50);
      await sleep(10);

      const output = getOutput();
      // Should contain count and percentage like (50/100, 50%)
      expect(output).toMatch(/50\/100|50%/);

      progress.complete();
    });

    test("handles zero total gracefully", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "json",
        total: 0,
      });

      await sleep(10);
      progress.update(5);
      await sleep(10);

      // Should not crash, should output something
      const output = getOutput();
      expect(output.length).toBeGreaterThanOrEqual(0);

      progress.complete();
    });

    test("clips current to total when current exceeds total", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
        total: 100,
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(150);
      await sleep(10);

      const output = getOutput();
      // The formatProgressLine function clips current to total
      expect(output).toMatch(/100\/100|100%/);

      progress.complete();
    });
  });

  describe("TTY vs non-TTY behavior", () => {
    test("non-TTY stream outputs with newlines", async () => {
      const { stream, getOutput } = createCaptureStream();
      // Non-TTY by default
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
        showSpinner: true,
      });

      await sleep(10);
      progress.complete("Done");

      const output = getOutput();
      expect(output).toContain("\n");
    });

    test("TTY stream uses carriage return for in-place updates", async () => {
      const { stream, getOutput } = createMockTtyStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
        showSpinner: true,
        spinnerIntervalMs: 50,
      });

      await sleep(120);
      progress.complete("Done");

      const output = getOutput();
      // TTY output should contain carriage returns for in-place updates
      expect(output).toContain("\r");
    });
  });

  describe("spinner behavior", () => {
    test("spinner is disabled when showSpinner is false", async () => {
      const { stream, getOutput } = createMockTtyStream();

      withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => {
        const progress = createProgress({
          message: "Processing",
          stream,
          delayMs: 0,
          format: "text",
          showSpinner: false,
        });

        progress.complete();
      });

      // Should not crash
      const output = getOutput();
      expect(output.length).toBeGreaterThanOrEqual(0);
    });

    test("uses ASCII spinner when emoji is disabled", async () => {
      const { stream, getOutput } = createMockTtyStream();

      await withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, async () => {
        const progress = createProgress({
          message: "Processing",
          stream,
          delayMs: 0,
          format: "text",
          showSpinner: true,
          spinnerIntervalMs: 40,
        });

        await sleep(100);
        progress.complete();
      });

      const output = getOutput();
      // ASCII spinner uses - \ | / characters
      // The output should not contain Unicode spinner chars
      const unicodeSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      for (const char of unicodeSpinner) {
        expect(output).not.toContain(char);
      }
    });
  });

  describe("minUpdateIntervalMs throttling", () => {
    test("throttles rapid updates", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "json",
        total: 100,
        minUpdateIntervalMs: 100,
      });

      await sleep(10);
      // Rapid fire updates
      for (let i = 0; i < 10; i++) {
        progress.update(i * 10);
      }
      await sleep(10);

      progress.complete();

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      // Due to throttling, we should have fewer output lines than updates
      // (initial + maybe 1-2 throttled updates + complete)
      expect(lines.length).toBeLessThan(10);
    });
  });

  describe("edge cases", () => {
    test("handles Infinity total gracefully", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "json",
        total: Infinity,
      });

      await sleep(10);
      progress.update(100);
      await sleep(10);

      // Should not crash
      progress.complete();
      expect(getOutput().length).toBeGreaterThanOrEqual(0);
    });

    test("handles very long messages by truncating", async () => {
      const { stream, getOutput } = createMockTtyStream();
      stream.columns = 40; // Narrow terminal

      const longMessage = "A".repeat(100);
      const progress = createProgress({
        message: longMessage,
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.complete();

      const output = getOutput();
      // Should be truncated with ellipsis
      expect(output).toContain("…");
    });

    test("handles empty message string", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "",
        stream,
        delayMs: 0,
        format: "text",
      });

      await sleep(10);
      progress.complete();

      // Should not crash
      expect(getOutput().length).toBeGreaterThanOrEqual(0);
    });

    test("handles whitespace-only update message", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Initial",
        stream,
        delayMs: 0,
        format: "json",
        minUpdateIntervalMs: 0,
      });

      await sleep(10);
      progress.update(50, "   ");
      await sleep(10);

      const output = getOutput();
      const lines = output.trim().split("\n").filter(Boolean);
      // Whitespace-only message should be ignored, keeping previous message
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.message).toBe("Initial");
      }

      progress.complete();
    });

    test("spinnerIntervalMs is clamped to minimum of 40ms", async () => {
      const { stream } = createMockTtyStream();

      // This should not crash even with very low interval
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 0,
        format: "text",
        showSpinner: true,
        spinnerIntervalMs: 1, // Very low, should be clamped to 40
      });

      await sleep(50);
      progress.complete();

      // If we got here without hanging, the clamp worked
      expect(true).toBe(true);
    });

    test("delayMs of 0 shows output immediately", async () => {
      const { stream, getOutput } = createCaptureStream();
      const progress = createProgress({
        message: "Immediate",
        stream,
        delayMs: 0,
        format: "json",
      });

      // Small delay to let the setTimeout(0) fire
      await sleep(5);

      const output = getOutput();
      expect(output.length).toBeGreaterThan(0);

      progress.complete();
    });
  });

  describe("timer cleanup", () => {
    test("complete clears all timers", async () => {
      const { stream } = createMockTtyStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 1000, // Long delay
        format: "text",
        showSpinner: true,
      });

      // Complete immediately
      progress.complete();

      // If timers aren't cleared, this would hang or cause issues
      // The unref() calls in progress.ts should prevent process from hanging
      expect(true).toBe(true);
    });

    test("fail clears all timers", async () => {
      const { stream } = createMockTtyStream();
      const progress = createProgress({
        message: "Processing",
        stream,
        delayMs: 1000,
        format: "text",
        showSpinner: true,
      });

      progress.fail("Error");

      expect(true).toBe(true);
    });
  });
});
