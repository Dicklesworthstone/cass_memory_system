import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { LLM_RETRY_CONFIG, llmWithRetry } from "../src/llm.js";

describe("LLM_RETRY_CONFIG", () => {
  it("has expected configuration values", () => {
    expect(LLM_RETRY_CONFIG.maxRetries).toBe(3);
    expect(LLM_RETRY_CONFIG.baseDelayMs).toBe(1000);
    expect(LLM_RETRY_CONFIG.maxDelayMs).toBe(30000);
  });

  it("includes common retryable error patterns", () => {
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("rate_limit_exceeded");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("server_error");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("timeout");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("overloaded");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("429");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("500");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("503");
  });

  it("includes network error codes", () => {
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("ETIMEDOUT");
    expect(LLM_RETRY_CONFIG.retryableErrors).toContain("ECONNRESET");
  });
});

describe("llmWithRetry", () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // llmWithRetry uses warn() which uses console.error()
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns result on successful operation", async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return Promise.resolve("success");
    };
    const result = await llmWithRetry(operation, "testOperation");

    expect(result).toBe("success");
    expect(calls).toBe(1);
  });

  it("returns result on first try without logging", async () => {
    const operation = () => Promise.resolve({ data: "test" });
    await llmWithRetry(operation, "testOperation");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("retries on rate_limit_exceeded error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        const err = new Error("rate_limit_exceeded: too many requests");
        return Promise.reject(err);
      }
      return Promise.resolve("success after retry");
    };

    const result = await llmWithRetry(operation, "testOp");

    expect(result).toBe("success after retry");
    expect(attempt).toBe(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on server_error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("server_error occurred"));
      }
      return Promise.resolve("recovered");
    };

    const result = await llmWithRetry(operation, "serverOp");
    expect(result).toBe("recovered");
    expect(attempt).toBe(2);
  });

  it("retries on timeout error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("Request timeout exceeded"));
      }
      return Promise.resolve("done");
    };

    const result = await llmWithRetry(operation, "timeoutOp");
    expect(result).toBe("done");
    expect(attempt).toBe(2);
  });

  it("retries on overloaded error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("API overloaded"));
      }
      return Promise.resolve("completed");
    };

    const result = await llmWithRetry(operation, "overloadOp");
    expect(result).toBe("completed");
    expect(attempt).toBe(2);
  });

  it("retries on HTTP 429 status code in message", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("HTTP 429 Too Many Requests"));
      }
      return Promise.resolve("ok");
    };

    const result = await llmWithRetry(operation, "http429Op");
    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("retries on ETIMEDOUT network error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        const err: any = new Error("Connection failed");
        err.code = "ETIMEDOUT";
        return Promise.reject(err);
      }
      return Promise.resolve("connected");
    };

    const result = await llmWithRetry(operation, "networkOp");
    expect(result).toBe("connected");
    expect(attempt).toBe(2);
  });

  it("retries on ECONNRESET network error", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        const err: any = new Error("Connection reset");
        err.code = "ECONNRESET";
        return Promise.reject(err);
      }
      return Promise.resolve("reconnected");
    };

    const result = await llmWithRetry(operation, "resetOp");
    expect(result).toBe("reconnected");
    expect(attempt).toBe(2);
  });

  it("retries on ETIMEDOUT in message (not just code)", async () => {
    // This tests the bug fix: uppercase patterns like "ETIMEDOUT" should match
    // when they appear in the error message, not just in err.code
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        // Error with ETIMEDOUT in message but NO err.code set
        return Promise.reject(new Error("Request failed: ETIMEDOUT"));
      }
      return Promise.resolve("recovered");
    };

    const result = await llmWithRetry(operation, "messageMatchOp");
    expect(result).toBe("recovered");
    expect(attempt).toBe(2);
  });

  it("retries up to maxRetries times then throws", async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return Promise.reject(new Error("rate_limit_exceeded"));
    };

    await expect(llmWithRetry(operation, "failingOp")).rejects.toThrow("rate_limit_exceeded");

    // maxRetries is 3, so total attempts = 1 (initial) + 3 (retries) = 4
    expect(calls).toBe(4);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
  }, 20000); // Extended timeout: 3 retries with exponential backoff = ~14s

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return Promise.reject(new Error("Invalid API key"));
    };

    await expect(llmWithRetry(operation, "invalidKeyOp")).rejects.toThrow("Invalid API key");

    expect(calls).toBe(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("does not retry syntax errors", async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return Promise.reject(new SyntaxError("Unexpected token"));
    };

    await expect(llmWithRetry(operation, "syntaxOp")).rejects.toThrow("Unexpected token");

    expect(calls).toBe(1);
  });

  it("does not retry type errors", async () => {
    let calls = 0;
    const operation = () => {
      calls++;
      return Promise.reject(new TypeError("Cannot read property"));
    };

    await expect(llmWithRetry(operation, "typeOp")).rejects.toThrow("Cannot read property");

    expect(calls).toBe(1);
  });

  it("logs retry attempts with operation name", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("server_error"));
      }
      return Promise.resolve("ok");
    };

    await llmWithRetry(operation, "myCustomOperation");

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    // warn() calls console.error(prefix, message)
    // We check the second argument for the message content
    const logMessage = consoleErrorSpy.mock.calls[0][1] as string;
    expect(logMessage).toContain("[LLM]");
    expect(logMessage).toContain("myCustomOperation");
    expect(logMessage).toContain("attempt 1");
    expect(logMessage).toContain("server_error");
    expect(logMessage).toContain("Retrying in");
  });

  it("checks error.statusCode for retryable codes", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        const err: any = new Error("Service unavailable");
        err.statusCode = 503;
        return Promise.reject(err);
      }
      return Promise.resolve("available");
    };

    const result = await llmWithRetry(operation, "statusCodeOp");
    expect(result).toBe("available");
    expect(attempt).toBe(2);
  });

  it("handles operations returning complex objects", async () => {
    const complexResult = {
      data: [1, 2, 3],
      nested: { value: "test" },
      timestamp: new Date().toISOString(),
    };

    const operation = () => Promise.resolve(complexResult);
    const result = await llmWithRetry(operation, "complexOp");

    expect(result).toEqual(complexResult);
  });

  it("handles operations returning arrays", async () => {
    const arrayResult = ["item1", "item2", "item3"];
    const operation = () => Promise.resolve(arrayResult);
    const result = await llmWithRetry(operation, "arrayOp");

    expect(result).toEqual(arrayResult);
  });

  it("handles operations returning null", async () => {
    const operation = () => Promise.resolve(null);
    const result = await llmWithRetry(operation, "nullOp");

    expect(result).toBeNull();
  });

  it("handles operations returning undefined", async () => {
    const operation = () => Promise.resolve(undefined);
    const result = await llmWithRetry(operation, "undefinedOp");

    expect(result).toBeUndefined();
  });

  it("recovers after multiple retries", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt <= 3) {
        return Promise.reject(new Error("timeout"));
      }
      return Promise.resolve("finally succeeded");
    };

    const result = await llmWithRetry(operation, "multiRetryOp");

    expect(result).toBe("finally succeeded");
    expect(attempt).toBe(4);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
  }, 20000); // Extended timeout: 3 retries with exponential backoff = ~14s

  it("case-insensitive error matching", async () => {
    let attempt = 0;
    const operation = () => {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error("RATE_LIMIT_EXCEEDED"));
      }
      return Promise.resolve("ok");
    };

    const result = await llmWithRetry(operation, "caseOp");
    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });
});

describe("llmWithRetry exponential backoff", () => {
  it("calculates delay correctly: 2^attempt * baseDelay", () => {
    // Based on implementation: delay = min(baseDelay * 2^attempt, maxDelay)
    // With baseDelay=1000, maxDelay=30000:
    // attempt 1: min(1000 * 2^1, 30000) = 2000
    // attempt 2: min(1000 * 2^2, 30000) = 4000
    // attempt 3: min(1000 * 2^3, 30000) = 8000

    const base = LLM_RETRY_CONFIG.baseDelayMs;
    const max = LLM_RETRY_CONFIG.maxDelayMs;

    expect(Math.min(base * 2 ** 1, max)).toBe(2000);
    expect(Math.min(base * 2 ** 2, max)).toBe(4000);
    expect(Math.min(base * 2 ** 3, max)).toBe(8000);
    expect(Math.min(base * 2 ** 4, max)).toBe(16000);
    expect(Math.min(base * 2 ** 5, max)).toBe(30000); // capped
    expect(Math.min(base * 2 ** 6, max)).toBe(30000); // capped
  });
});

describe("llmWithRetry total deadlines", () => {
  type Settlement<T> =
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; error: unknown }
    | { status: "watchdog" };

  async function beforeWatchdog<T>(pending: Promise<T>): Promise<Settlement<T>> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        pending.then(
          value => ({ status: "fulfilled" as const, value }),
          error => ({ status: "rejected" as const, error }),
        ),
        new Promise<Settlement<T>>(resolve => {
          timer = setTimeout(() => resolve({ status: "watchdog" }), 250);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  function expectTimeout(outcome: Settlement<unknown>, operationName: string): void {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(String(outcome.error)).toContain(operationName);
      expect(String(outcome.error)).toMatch(/timed out|timeout ceiling/);
    }
  }

  it("honors an explicit total smaller than the per-operation timeout", async () => {
    let calls = 0;
    let finish!: (value: string) => void;
    const work = new Promise<string>(resolve => { finish = resolve; });
    const timer = setTimeout(() => finish("late success"), 150);
    const run = llmWithRetry(() => {
      calls++;
      return work;
    }, "explicit-total", { perOperationTimeoutMs: 1000, totalTimeoutMs: 20 });
    try {
      expectTimeout(await beforeWatchdog(run), "explicit-total");
      expect(calls).toBe(1);
    } finally {
      clearTimeout(timer);
      finish("released");
      await run.catch(() => undefined);
    }
  });

  it("expires during backoff before the watchdog without starting another attempt", async () => {
    let calls = 0;
    const run = llmWithRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("rate_limit_exceeded");
      return "unexpected retry";
    }, "backoff-total", { perOperationTimeoutMs: 1000, totalTimeoutMs: 20 });
    try {
      expectTimeout(await beforeWatchdog(run), "backoff-total");
      expect(calls).toBe(1);
    } finally {
      // Also drain the old implementation when running this as a regression
      // probe, so a failed assertion cannot leave its two-second timer alive.
      await run.catch(() => undefined);
    }
    expect(calls).toBe(1);
  });

  it("parent cancellation interrupts a nested retry backoff", async () => {
    let calls = 0;
    let nested: Promise<string> | undefined;
    const outer = llmWithRetry(() => {
      nested = llmWithRetry(async () => {
        calls++;
        if (calls === 1) throw new Error("server_error");
        return "unexpected nested retry";
      }, "nested-backoff", { perOperationTimeoutMs: 1000, totalTimeoutMs: 1000 });
      return nested;
    }, "backoff-parent", { perOperationTimeoutMs: 20, totalTimeoutMs: 1000 });
    try {
      expectTimeout(await beforeWatchdog(outer), "backoff-parent");
      if (!nested) throw new Error("The nested retry operation never started");
      expectTimeout(await beforeWatchdog(nested), "backoff-parent");
      expect(calls).toBe(1);
    } finally {
      await outer.catch(() => undefined);
      await nested?.catch(() => undefined);
    }
    expect(calls).toBe(1);
  });

  it("parent cancellation settles a nested wrapper even when its callback ignores cancellation", async () => {
    let finish!: (value: string) => void;
    const work = new Promise<string>(resolve => { finish = resolve; });
    let calls = 0;
    let nested: Promise<string> | undefined;
    const outer = llmWithRetry(() => {
      nested = llmWithRetry(() => {
        calls++;
        return work;
      }, "uncancellable-work", { perOperationTimeoutMs: 1000, totalTimeoutMs: 1000 });
      return nested;
    }, "uncancellable-parent", { perOperationTimeoutMs: 20, totalTimeoutMs: 1000 });
    try {
      expectTimeout(await beforeWatchdog(outer), "uncancellable-parent");
      if (!nested) throw new Error("The nested retry operation never started");
      expectTimeout(await beforeWatchdog(nested), "uncancellable-parent");
      expect(calls).toBe(1);
    } finally {
      finish("late result");
      await outer.catch(() => undefined);
      await nested?.catch(() => undefined);
    }
  });

  it("rejects success delivered after the deadline while synchronous work delays timers", async () => {
    let calls = 0;
    const run = llmWithRetry(async () => {
      calls++;
      const until = performance.now() + 50;
      while (performance.now() < until) { /* model-result processing blocks the event loop */ }
      return "late synchronous success";
    }, "late-sync", { perOperationTimeoutMs: 1000, totalTimeoutMs: 10 });
    expectTimeout(await beforeWatchdog(run), "late-sync");
    expect(calls).toBe(1);
  });

  function runEnvironmentProbe(overrides: { totalTimeoutMs?: number }) {
    const script = `
import { llmWithRetry } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "llm.ts"))};
let timer;
let finish;
let calls = 0;
const work = new Promise(resolve => { finish = resolve; });
timer = setTimeout(() => finish("completed"), 80);
try {
  const value = await llmWithRetry(() => { calls++; return work; }, "env-total", ${JSON.stringify(overrides)});
  console.log(JSON.stringify({ status: "fulfilled", calls, value }));
} catch (error) {
  console.log(JSON.stringify({ status: "rejected", calls, message: String(error) }));
} finally {
  clearTimeout(timer);
  finish("released");
}
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, CM_LLM_TIMEOUT_MS: "1000", CM_LLM_TOTAL_TIMEOUT_MS: "20" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { status: string; calls: number; value?: string; message?: string };
  }

  it("honors the environment total in a freshly initialized process", () => {
    const outcome = runEnvironmentProbe({});
    expect(outcome.status).toBe("rejected");
    expect(outcome.calls).toBe(1);
    expect(outcome.message).toMatch(/timed out|timeout ceiling/);
  });

  it("lets an explicit total override the environment ceiling", () => {
    expect(runEnvironmentProbe({ totalTimeoutMs: 1000 })).toEqual({
      status: "fulfilled", calls: 1, value: "completed",
    });
  });
});
