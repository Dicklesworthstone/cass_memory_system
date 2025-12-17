/**
 * Unit tests for top command
 *
 * Covers:
 * - Ranking by effective score
 * - count limit
 * - scope/category filters
 * - JSON output contract
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";

import { topCommand } from "../src/commands/top.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestFeedbackEvent, createTestPlaybook } from "./helpers/factories.js";

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function captureConsoleLog<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ")
    );
  };

  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

type TopJson = {
  count: number;
  filters: { scope: string; category: string | null };
  bullets: Array<{ rank: number; id: string; score: number; scope: string; category: string }>;
};

type JsonEnvelope<T> = {
  success: boolean;
  command: string;
  timestamp: string;
  data: T;
};

describe("top command - Unit Tests", () => {
  test("returns top-ranked bullets in score order and respects count limit", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const t = new Date().toISOString();
        const high = createTestBullet({
          id: "b-top-high",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "Highest score rule",
          helpfulCount: 3,
          harmfulCount: 0,
          feedbackEvents: [
            createTestFeedbackEvent("helpful", { timestamp: t }),
            createTestFeedbackEvent("helpful", { timestamp: t }),
            createTestFeedbackEvent("helpful", { timestamp: t }),
          ],
        });
        const mid = createTestBullet({
          id: "b-top-mid",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "Middle score rule",
          helpfulCount: 1,
          harmfulCount: 0,
          feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: t })],
        });
        const low = createTestBullet({
          id: "b-top-low",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "Lowest score rule",
          helpfulCount: 0,
          harmfulCount: 1,
          feedbackEvents: [createTestFeedbackEvent("harmful", { timestamp: t })],
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([high, mid, low])));

        process.exitCode = 0;
        const { output } = await captureConsoleLog(() => topCommand(2, { json: true }));

        const payload = JSON.parse(output) as JsonEnvelope<TopJson>;
        expect(payload.success).toBe(true);
        expect(payload.command).toBe("top");
        expect(payload.data.count).toBe(2);
        expect(payload.data.filters.scope).toBe("all");
        expect(payload.data.filters.category).toBe(null);
        expect(payload.data.bullets).toHaveLength(2);
        expect(payload.data.bullets[0].rank).toBe(1);
        expect(payload.data.bullets[1].rank).toBe(2);
        expect(payload.data.bullets[0].id).toBe("b-top-high");
        expect(payload.data.bullets[1].id).toBe("b-top-mid");
        expect(payload.data.bullets[0].score).toBeGreaterThan(payload.data.bullets[1].score);
      });
    });
  });

  test("filters by scope and category (case-insensitive match on category)", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const t = new Date().toISOString();
        const global = createTestBullet({
          id: "b-top-global",
          category: "Quality",
          scope: "global",
          state: "active",
          content: "Global rule",
          feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: t })],
        });
        const workspace = createTestBullet({
          id: "b-top-workspace",
          category: "Quality",
          scope: "workspace",
          state: "active",
          content: "Workspace rule",
          feedbackEvents: [
            createTestFeedbackEvent("helpful", { timestamp: t }),
            createTestFeedbackEvent("helpful", { timestamp: t }),
          ],
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([global, workspace])));

        process.exitCode = 0;
        const { output } = await captureConsoleLog(() =>
          topCommand(10, { json: true, scope: "workspace", category: "quality" })
        );

        const payload = JSON.parse(output) as JsonEnvelope<TopJson>;
        expect(payload.success).toBe(true);
        expect(payload.data.filters.scope).toBe("workspace");
        expect(payload.data.filters.category).toBe("quality");
        expect(payload.data.count).toBe(1);
        expect(payload.data.bullets[0].id).toBe("b-top-workspace");
        expect(payload.data.bullets[0].scope).toBe("workspace");
        expect(payload.data.bullets[0].category.toLowerCase()).toBe("quality");
      });
    });
  });

  test("fails fast on invalid count and invalid scope (JSON mode)", async () => {
    process.exitCode = 0;
    const badCount = await captureConsoleLog(() => topCommand(Number.NaN as any, { json: true }));
    const badCountPayload = JSON.parse(badCount.output) as any;
    expect(badCountPayload.success).toBe(false);
    expect(badCountPayload.command).toBe("top");
    expect(badCountPayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    const badScope = await captureConsoleLog(() => topCommand(10, { json: true, scope: "nope" as any }));
    const badScopePayload = JSON.parse(badScope.output) as any;
    expect(badScopePayload.success).toBe(false);
    expect(badScopePayload.command).toBe("top");
    expect(badScopePayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);
  });
});
