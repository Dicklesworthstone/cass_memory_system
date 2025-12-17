import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { llmWithRetry, LLM_RETRY_CONFIG } from "../src/llm.js";

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
      timestamp: new Date().toISOString()
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

    expect(Math.min(base * Math.pow(2, 1), max)).toBe(2000);
    expect(Math.min(base * Math.pow(2, 2), max)).toBe(4000);
    expect(Math.min(base * Math.pow(2, 3), max)).toBe(8000);
    expect(Math.min(base * Math.pow(2, 4), max)).toBe(16000);
    expect(Math.min(base * Math.pow(2, 5), max)).toBe(30000); // capped
    expect(Math.min(base * Math.pow(2, 6), max)).toBe(30000); // capped
  });
});
