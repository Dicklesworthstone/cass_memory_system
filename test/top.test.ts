/**
 * Unit tests for top command
 *
 * Covers:
 * - Ranking by effective score
 * - count limit
 * - scope/category filters
 * - JSON output contract
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";

import { topCommand } from "../src/commands/top.js";
import {
  createTestBullet,
  createTestFeedbackEvent,
  createTestPlaybook,
} from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function captureConsoleLog<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
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
          topCommand(10, { json: true, scope: "workspace", category: "quality" }),
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
    const badScope = await captureConsoleLog(() =>
      topCommand(10, { json: true, scope: "nope" as any }),
    );
    const badScopePayload = JSON.parse(badScope.output) as any;
    expect(badScopePayload.success).toBe(false);
    expect(badScopePayload.command).toBe("top");
    expect(badScopePayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);
  });

  test("fails fast on empty category string", async () => {
    process.exitCode = 0;
    const { output } = await captureConsoleLog(() => topCommand(10, { json: true, category: "" }));
    const payload = JSON.parse(output) as any;
    expect(payload.success).toBe(false);
    expect(payload.command).toBe("top");
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.message).toContain("category");
    expect(process.exitCode).toBe(2);
  });
});

describe("top command - Human Output", () => {
  test("shows ranked bullets in human-readable format", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const t = new Date().toISOString();
        const high = createTestBullet({
          id: "b-human-high",
          category: "Workflow",
          scope: "global",
          state: "active",
          maturity: "established",
          content: "A high-scoring rule for workflow",
          helpfulCount: 5,
          harmfulCount: 0,
          feedbackEvents: [
            createTestFeedbackEvent("helpful", { timestamp: t }),
            createTestFeedbackEvent("helpful", { timestamp: t }),
          ],
        });
        const low = createTestBullet({
          id: "b-human-low",
          category: "Workflow",
          scope: "global",
          state: "active",
          maturity: "candidate",
          content: "A lower-scoring rule",
          helpfulCount: 1,
          harmfulCount: 0,
          feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: t })],
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([high, low])));

        const { output } = await captureConsoleLog(() => topCommand(10, {}));

        // Should show TOP header
        expect(output).toContain("TOP");
        // Should show bullet IDs
        expect(output).toContain("b-human-high");
        expect(output).toContain("b-human-low");
        // Should show ranking numbers
        expect(output).toContain("1.");
        expect(output).toContain("2.");
        // Should show score keyword
        expect(output).toContain("score");
        // Should show maturity
        expect(output).toContain("established");
        expect(output).toContain("candidate");
        // Should show category
        expect(output).toContain("Workflow");
        // Should show feedback info
        expect(output).toContain("helpful");
        expect(output).toContain("harmful");
      });
    });
  });

  test("shows empty state when no bullets match", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const bullet = createTestBullet({
          id: "b-global-only",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "Global rule",
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        // Filter by workspace scope when no workspace bullets exist
        const { output } = await captureConsoleLog(() => topCommand(10, { scope: "workspace" }));

        expect(output).toContain("No bullets found matching the criteria");
        expect(output).toContain("scope=workspace");
      });
    });
  });

  test("shows empty state with category filter", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const bullet = createTestBullet({
          id: "b-workflow",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "A workflow rule",
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        // Filter by category that doesn't exist
        const { output } = await captureConsoleLog(() => topCommand(10, { category: "security" }));

        expect(output).toContain("No bullets found matching the criteria");
        expect(output).toContain("category=security");
      });
    });
  });

  test("shows filter description when filters applied", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const bullet = createTestBullet({
          id: "b-filtered",
          category: "Security",
          scope: "global",
          state: "active",
          content: "A security rule",
          helpfulCount: 2,
          feedbackEvents: [
            createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          ],
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        const { output } = await captureConsoleLog(() =>
          topCommand(10, { scope: "global", category: "security" }),
        );

        expect(output).toContain("scope: global");
        expect(output).toContain("category: security");
      });
    });
  });

  test("shows tip about inspecting bullets", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const bullet = createTestBullet({
          id: "b-tip",
          category: "Workflow",
          scope: "global",
          state: "active",
          content: "Rule content",
          helpfulCount: 1,
          feedbackEvents: [
            createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          ],
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

        const { output } = await captureConsoleLog(() => topCommand(5, {}));

        // Should show tip about playbook get and why commands
        expect(output).toContain("playbook get");
        expect(output).toContain("why");
      });
    });
  });

  test("shows correct score coloring based on score value", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const t = new Date().toISOString();
        // Create bullet with high score (should be green-ish)
        const highScore = createTestBullet({
          id: "b-high-score",
          category: "Workflow",
          scope: "global",
          state: "active",
          maturity: "established",
          content: "High score rule",
          helpfulCount: 15,
          harmfulCount: 0,
          feedbackEvents: Array.from({ length: 15 }, () =>
            createTestFeedbackEvent("helpful", { timestamp: t }),
          ),
        });

        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([highScore])));

        const { output } = await captureConsoleLog(() => topCommand(5, {}));

        // Should contain the score display
        expect(output).toContain("score");
        expect(output).toContain("b-high-score");
      });
    });
  });
});
