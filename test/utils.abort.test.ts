import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  AbortError,
  checkAbort,
  isAborted,
  requestAbort,
  resetAbort,
  getAbortSignal,
  createTimeoutSignal,
  combineAbortSignals,
  withAbortCheck,
  withAbortableSequence,
} from "../src/utils.js";

describe("AbortController Integration", () => {
  // Reset abort state before each test
  beforeEach(() => {
    resetAbort();
  });

  describe("AbortError", () => {
    test("creates error with default message", () => {
      const error = new AbortError();
      expect(error.message).toBe("Operation aborted");
      expect(error.reason).toBe("Operation aborted");
      expect(error.name).toBe("AbortError");
    });

    test("creates error with custom message", () => {
      const error = new AbortError("User cancelled");
      expect(error.message).toBe("User cancelled");
      expect(error.reason).toBe("User cancelled");
    });

    test("is instance of Error", () => {
      const error = new AbortError();
      expect(error instanceof Error).toBe(true);
      expect(error instanceof AbortError).toBe(true);
    });

    test("has stack trace", () => {
      const error = new AbortError("Test");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("AbortError");
    });
  });

  describe("checkAbort", () => {
    test("does not throw when not aborted", () => {
      expect(() => checkAbort()).not.toThrow();
    });

    test("throws AbortError when aborted", () => {
      requestAbort();
      expect(() => checkAbort()).toThrow(AbortError);
    });

    test("throws with correct message", () => {
      requestAbort();
      try {
        checkAbort();
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AbortError);
        expect((e as AbortError).message).toContain("cancelled");
      }
    });
  });

  describe("isAborted", () => {
    test("returns false when not aborted", () => {
      expect(isAborted()).toBe(false);
    });

    test("returns true when aborted", () => {
      requestAbort();
      expect(isAborted()).toBe(true);
    });
  });

  describe("requestAbort", () => {
    test("sets abort flag", () => {
      expect(isAborted()).toBe(false);
      requestAbort();
      expect(isAborted()).toBe(true);
    });

    test("accepts optional reason", () => {
      requestAbort("User pressed Ctrl+C");
      expect(isAborted()).toBe(true);
    });

    test("multiple calls are safe", () => {
      requestAbort();
      requestAbort();
      requestAbort();
      expect(isAborted()).toBe(true);
    });
  });

  describe("resetAbort", () => {
    test("clears abort flag", () => {
      requestAbort();
      expect(isAborted()).toBe(true);
      resetAbort();
      expect(isAborted()).toBe(false);
    });

    test("allows new abort after reset", () => {
      requestAbort();
      resetAbort();
      expect(isAborted()).toBe(false);
      requestAbort();
      expect(isAborted()).toBe(true);
    });
  });

  describe("getAbortSignal", () => {
    test("returns an AbortSignal", () => {
      const signal = getAbortSignal();
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    test("signal is not aborted initially", () => {
      const signal = getAbortSignal();
      expect(signal.aborted).toBe(false);
    });

    test("signal is aborted after requestAbort", () => {
      const signal = getAbortSignal();
      requestAbort();
      expect(signal.aborted).toBe(true);
    });

    test("new signal after reset is not aborted", () => {
      requestAbort();
      resetAbort();
      const signal = getAbortSignal();
      expect(signal.aborted).toBe(false);
    });
  });

  describe("createTimeoutSignal", () => {
    test("returns an AbortSignal", () => {
      const signal = createTimeoutSignal(1000);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    test("signal is not immediately aborted", () => {
      const signal = createTimeoutSignal(1000);
      expect(signal.aborted).toBe(false);
    });

    test("signal aborts after timeout", async () => {
      const signal = createTimeoutSignal(50);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signal.aborted).toBe(true);
    });
  });

  describe("combineAbortSignals", () => {
    test("returns an AbortSignal", () => {
      const signal = combineAbortSignals([
        getAbortSignal(),
        createTimeoutSignal(1000),
      ]);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    test("is not aborted when no source is aborted", () => {
      const signal = combineAbortSignals([
        getAbortSignal(),
        createTimeoutSignal(1000),
      ]);
      expect(signal.aborted).toBe(false);
    });

    test("is aborted when any source is aborted", () => {
      requestAbort();
      const signal = combineAbortSignals([
        getAbortSignal(),
        createTimeoutSignal(10000),
      ]);
      expect(signal.aborted).toBe(true);
    });
  });

  describe("withAbortCheck", () => {
    test("executes operation when not aborted", async () => {
      const result = await withAbortCheck(async () => "success");
      expect(result).toBe("success");
    });

    test("throws before operation if already aborted", async () => {
      requestAbort();
      await expect(withAbortCheck(async () => "success")).rejects.toThrow(
        AbortError
      );
    });

    test("throws after operation if aborted during", async () => {
      // Start operation, abort during, check throws after
      const promise = withAbortCheck(async () => {
        requestAbort();
        return "success";
      });
      await expect(promise).rejects.toThrow(AbortError);
    });

    test("returns operation result", async () => {
      const result = await withAbortCheck(async () => {
        return { data: 42 };
      });
      expect(result).toEqual({ data: 42 });
    });

    test("works with checkIntervalMs option", async () => {
      const result = await withAbortCheck(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "done";
        },
        10
      );
      expect(result).toBe("done");
    });
  });

  describe("withAbortableSequence", () => {
    test("processes all items when not aborted", async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await withAbortableSequence(items, async (n) => n * 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    test("provides index to processor", async () => {
      const items = ["a", "b", "c"];
      const results = await withAbortableSequence(
        items,
        async (item, index) => `${item}${index}`
      );
      expect(results).toEqual(["a0", "b1", "c2"]);
    });

    test("aborts between items", async () => {
      const items = [1, 2, 3, 4, 5];
      const processed: number[] = [];

      await expect(
        withAbortableSequence(items, async (n) => {
          if (n === 3) requestAbort();
          processed.push(n);
          return n;
        })
      ).rejects.toThrow(AbortError);

      // Should have processed items 1 and 2, then aborted before checking item 3
      // Actually, item 3 is processed because abort is checked BEFORE processing
      // So: check(ok) -> process 1 -> check(ok) -> process 2 -> check(ok) -> process 3 (aborts here)
      // Then check throws at start of next iteration
      expect(processed).toEqual([1, 2, 3]);
    });

    test("throws if already aborted", async () => {
      requestAbort();
      await expect(
        withAbortableSequence([1, 2, 3], async (n) => n)
      ).rejects.toThrow(AbortError);
    });

    test("handles empty array", async () => {
      const results = await withAbortableSequence([], async (n: number) => n);
      expect(results).toEqual([]);
    });

    test("handles single item", async () => {
      const results = await withAbortableSequence([42], async (n) => n * 2);
      expect(results).toEqual([84]);
    });
  });

  describe("Integration with fetch", () => {
    test("abort signal can be used with Promise.race", async () => {
      // Simulate using abort signal with a promise
      const signal = getAbortSignal();

      const operationPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => resolve("completed"), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new AbortError("Aborted"));
        });
      });

      // Should complete normally
      const result = await operationPromise;
      expect(result).toBe("completed");
    });

    test("abort signal cancels pending operation", async () => {
      const signal = getAbortSignal();

      const operationPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => resolve("completed"), 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new AbortError("Aborted"));
        });
      });

      // Abort after 50ms
      setTimeout(() => requestAbort(), 50);

      await expect(operationPromise).rejects.toThrow(AbortError);
    });
  });

  describe("Error categorization integration", () => {
    test("AbortError is categorized as user_input", async () => {
      // Import categorizeError
      const { categorizeError } = await import("../src/utils.js");
      const error = new AbortError("Operation cancelled");
      expect(categorizeError(error)).toBe("user_input");
    });
  });
});
