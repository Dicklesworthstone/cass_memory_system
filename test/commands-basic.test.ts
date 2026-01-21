/**
 * Unit tests for command modules that are otherwise covered only by E2E.
 * Focus: input validation + JSON output shape using real file I/O helpers.
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";

import { guardCommand } from "../src/commands/guard.js";
import { initCommand } from "../src/commands/init.js";
import { markCommand, recordFeedback } from "../src/commands/mark.js";
import { generateSimilarResults, similarCommand } from "../src/commands/similar.js";
import { startersCommand } from "../src/commands/starters.js";
import { statsCommand } from "../src/commands/stats.js";
import { traumaCommand } from "../src/commands/trauma.js";
import { usageCommand } from "../src/commands/usage.js";

import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { loadPlaybook } from "../src/playbook.js";

type Capture = {
  logs: string[];
  errors: string[];
  restore: () => void;
  output: () => string;
};

function captureConsole(): Capture {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    output: () => [...logs, ...errors].join(""),
  };
}

function parseJsonError(stdout: string): any {
  const payload = JSON.parse(stdout) as any;
  expect(payload.success).toBe(false);
  return payload.error;
}

function parseJsonSuccess(stdout: string): any {
  const payload = JSON.parse(stdout) as any;
  expect(payload.success).toBe(true);
  return payload.data;
}

async function withKeepTemp<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.KEEP_TEMP;
  process.env.KEEP_TEMP = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.KEEP_TEMP;
    } else {
      process.env.KEEP_TEMP = previous;
    }
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe("commands basic unit coverage (JSON + validation)", () => {
  test("guardCommand reports missing flags (JSON error)", async () => {
    const capture = captureConsole();
    process.exitCode = 0;
    try {
      await guardCommand({ json: true });
    } finally {
      capture.restore();
    }

    const err = parseJsonError(capture.output());
    expect(err.code).toBe("MISSING_REQUIRED");
  });

  test("guardCommand --install reports missing .claude directory (JSON error)", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const capture = captureConsole();
          process.exitCode = 0;
          try {
            await guardCommand({ install: true, json: true });
          } finally {
            capture.restore();
          }

          const err = parseJsonError(capture.output());
          expect(err.code).toBe("FILE_NOT_FOUND");
        });
      });
    });
  });

  test("initCommand refuses --force without --yes when state exists (JSON error)", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        writeFileSync(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const capture = captureConsole();
        process.exitCode = 0;
        try {
          await initCommand({ force: true, json: true });
        } finally {
          capture.restore();
        }

        const err = parseJsonError(capture.output());
        expect(err.code).toBe("MISSING_REQUIRED");
      });
    });
  });

  test("initCommand --repo reports error when not in git repo (JSON error)", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const capture = captureConsole();
          process.exitCode = 0;
          try {
            await initCommand({ repo: true, json: true });
          } finally {
            capture.restore();
          }

          const err = parseJsonError(capture.output());
          expect(err.code).toBe("CONFIG_INVALID");
        });
      });
    });
  });

  test("markCommand requires exactly one of helpful/harmful (JSON error)", async () => {
    const capture = captureConsole();
    process.exitCode = 0;
    try {
      await markCommand("b-missing-flags", { json: true });
    } finally {
      capture.restore();
    }

    const err = parseJsonError(capture.output());
    expect(err.code).toBe("MISSING_REQUIRED");
  });

  test("similarCommand rejects invalid scope (JSON error)", async () => {
    const capture = captureConsole();
    process.exitCode = 0;
    try {
      await similarCommand("find me", { json: true, scope: "bad-scope" as any });
    } finally {
      capture.restore();
    }

    const err = parseJsonError(capture.output());
    expect(err.code).toBe("INVALID_INPUT");
  });

  test("similarCommand returns JSON results for valid query", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        const bullets = [
          createTestBullet({ id: "b-logs", content: "Prefer structured logs", scope: "global" }),
          createTestBullet({ id: "b-timeouts", content: "Set explicit timeouts", scope: "workspace" }),
        ];
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

        await withCwd(env.home, async () => {
          const capture = captureConsole();
          process.exitCode = 0;
          try {
            await similarCommand("Prefer structured logs", {
              json: true,
              threshold: 0.1,
              scope: "all",
            });
          } finally {
            capture.restore();
          }

          const data = parseJsonSuccess(capture.output());
          expect(data.query).toBe("Prefer structured logs");
          expect(data.results.length).toBeGreaterThan(0);
        });
      });
    });
  });

  test("traumaCommand rejects unknown action (JSON error)", async () => {
    const capture = captureConsole();
    process.exitCode = 0;
    try {
      await traumaCommand("unknown", [], { json: true });
    } finally {
      capture.restore();
    }

    const err = parseJsonError(capture.output());
    expect(err.code).toBe("INVALID_INPUT");
  });

  test("startersCommand returns built-in starters (JSON)", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async () => {
        const capture = captureConsole();
        process.exitCode = 0;
        try {
          await startersCommand({ json: true });
        } finally {
          capture.restore();
        }

        const data = parseJsonSuccess(capture.output());
        expect(Array.isArray(data.starters)).toBe(true);
        expect(data.starters.length).toBeGreaterThan(0);
        expect(data.starters.some((s: any) => s.name === "general")).toBe(true);
      });
    });
  });

  test("statsCommand returns JSON stats for playbook (JSON)", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        const bullets = [
          createTestBullet({ id: "b-active", state: "active", maturity: "candidate", scope: "global" }),
          createTestBullet({ id: "b-retired", state: "retired", maturity: "deprecated", scope: "workspace" }),
        ];
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

        const capture = captureConsole();
        process.exitCode = 0;
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const data = parseJsonSuccess(capture.output());
        expect(data.total).toBe(2);
        expect(data.byState.active).toBe(1);
        expect(data.byState.retired).toBe(1);
      });
    });
  });

  test("usageCommand returns JSON usage stats", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        writeFileSync(
          env.configPath,
          JSON.stringify(
            { budget: { dailyLimit: 1, monthlyLimit: 2, warningThreshold: 80, currency: "USD" } },
            null,
            2
          )
        );

        const capture = captureConsole();
        process.exitCode = 0;
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        const data = parseJsonSuccess(capture.output());
        expect(typeof data.today).toBe("number");
        expect(typeof data.month).toBe("number");
        expect(typeof data.total).toBe("number");
        expect(data.dailyLimit).toBe(1);
        expect(data.monthlyLimit).toBe(2);
      });
    });
  });

  test("recordFeedback writes helpful event to playbook", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-helpful",
          content: "Prefer structured logs",
          state: "active",
          maturity: "candidate",
        });
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        await withCwd(env.home, async () => {
          const result = await recordFeedback("b-helpful", { helpful: true });
          expect(result.type).toBe("helpful");
          expect(result.state).toBe("candidate");
        });

        const updated = await loadPlaybook(env.playbookPath);
        const stored = updated.bullets.find((b) => b.id === "b-helpful");
        expect(stored).toBeDefined();
        expect(stored?.helpfulCount).toBe(1);
        expect(stored?.feedbackEvents?.[0]?.type).toBe("helpful");
      });
    });
  });

  test("recordFeedback stores harmful reason context for unknown reasons", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-harmful",
          content: "Do the risky thing",
          state: "active",
          maturity: "candidate",
        });
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        await withCwd(env.home, async () => {
          const result = await recordFeedback("b-harmful", { harmful: true, reason: "custom-context" });
          expect(result.type).toBe("harmful");
        });

        const updated = await loadPlaybook(env.playbookPath);
        const stored = updated.bullets.find((b) => b.id === "b-harmful");
        const event = stored?.feedbackEvents?.[0];
        expect(event?.reason).toBe("other");
        expect(event?.context).toBe("custom-context");
      });
    });
  });

  test("generateSimilarResults returns keyword matches in global scope", async () => {
    await withKeepTemp(async () => {
      await withTempCassHome(async (env) => {
        const bullets = [
          createTestBullet({ id: "b-logs", content: "Prefer structured logs", scope: "global" }),
          createTestBullet({ id: "b-timeouts", content: "Set explicit timeouts", scope: "workspace" }),
        ];
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

        await withCwd(env.home, async () => {
          const result = await generateSimilarResults("Prefer structured logs", {
            scope: "global",
            threshold: 0.1,
            limit: 5,
          });
          expect(result.mode).toBe("keyword");
          expect(result.results.length).toBeGreaterThan(0);
          expect(result.results[0]?.id).toBe("b-logs");
        });
      });
    });
  });
});
