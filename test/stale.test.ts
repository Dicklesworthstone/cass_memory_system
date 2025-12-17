import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

import { staleCommand } from "../src/commands/stale.js";
import {
  createTestBullet,
  createTestFeedbackEvent,
  createTestPlaybook,
  withTempCassHome,
  withTempGitRepo,
} from "./helpers/index.js";

async function writePlaybookFile(file: string, playbook: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, yaml.stringify(playbook), "utf-8");
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write;

  process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
    output += typeof chunk === "string" ? chunk : chunk.toString(encoding);
    if (typeof cb === "function") cb();
    return true;
  };

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output.trim();
}

describe("staleCommand", () => {
  it("outputs stale bullets as JSON sorted by staleness", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const now = Date.now();
          const dayMs = 86_400_000;
          const isoDaysAgo = (days: number) => new Date(now - days * dayMs).toISOString();

          const noFeedback = createTestBullet({
            id: "b-no-feedback",
            content: "No feedback; should use creation date for staleness.",
            createdAt: isoDaysAgo(200),
            updatedAt: isoDaysAgo(200),
            feedbackEvents: [],
            scope: "global",
            maturity: "candidate",
          });

          const oldFeedback = createTestBullet({
            id: "b-old-feedback",
            content: "Has older feedback; should use most recent feedback timestamp.",
            createdAt: isoDaysAgo(250),
            updatedAt: isoDaysAgo(1),
            feedbackEvents: [
              createTestFeedbackEvent("helpful", { timestamp: isoDaysAgo(120) }),
              createTestFeedbackEvent("harmful", { timestamp: isoDaysAgo(100) }),
            ],
            scope: "global",
            maturity: "established",
          });

          const recentFeedback = createTestBullet({
            id: "b-recent",
            content: "Has recent feedback; should NOT be stale for threshold=90.",
            createdAt: isoDaysAgo(250),
            updatedAt: isoDaysAgo(1),
            feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: isoDaysAgo(10) })],
            scope: "global",
            maturity: "candidate",
          });

          const playbook = createTestPlaybook([noFeedback, oldFeedback, recentFeedback]);
          await writePlaybookFile(env.playbookPath, playbook);

          const stdout = await captureStdout(() =>
            staleCommand({ days: 90, scope: "all", json: true })
          );

          const parsed = JSON.parse(stdout) as any;
          expect(parsed.success).toBe(true);
          expect(parsed.command).toBe("stale");
          expect(parsed.data.threshold).toBe(90);
          expect(parsed.data.count).toBe(2);
          expect(parsed.data.totalActive).toBe(3);
          expect(parsed.data.filters).toEqual({ scope: "all" });

          const ids = parsed.data.bullets.map((b: any) => b.id);
          expect(ids).toEqual(["b-no-feedback", "b-old-feedback"]);

          const old = parsed.data.bullets.find((b: any) => b.id === "b-old-feedback");
          expect(old.lastFeedback.action).toBe("harmful");
          expect(old.lastFeedback.timestamp).toBe(isoDaysAgo(100));
          expect(old.daysSinceLastFeedback).toBeGreaterThanOrEqual(100);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("supports scope filtering", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const now = Date.now();
          const dayMs = 86_400_000;
          const isoDaysAgo = (days: number) => new Date(now - days * dayMs).toISOString();

          const globalStale = createTestBullet({
            id: "b-global",
            createdAt: isoDaysAgo(200),
            updatedAt: isoDaysAgo(200),
            feedbackEvents: [],
            scope: "global",
          });

          const workspaceStale = createTestBullet({
            id: "b-workspace",
            createdAt: isoDaysAgo(200),
            updatedAt: isoDaysAgo(200),
            feedbackEvents: [],
            scope: "workspace",
          });

          await writePlaybookFile(env.playbookPath, createTestPlaybook([globalStale, workspaceStale]));

          const globalOut = JSON.parse(
            await captureStdout(() => staleCommand({ days: 90, scope: "global", json: true }))
          ) as any;
          expect(globalOut.data.count).toBe(1);
          expect(globalOut.data.bullets[0].id).toBe("b-global");

          const workspaceOut = JSON.parse(
            await captureStdout(() => staleCommand({ days: 90, scope: "workspace", json: true }))
          ) as any;
          expect(workspaceOut.data.count).toBe(1);
          expect(workspaceOut.data.bullets[0].id).toBe("b-workspace");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("generates actionable recommendations in JSON output", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const now = Date.now();
          const dayMs = 86_400_000;
          const isoDaysAgo = (days: number) => new Date(now - days * dayMs).toISOString();

          const negativeScore = createTestBullet({
            id: "b-negative",
            createdAt: isoDaysAgo(30),
            updatedAt: isoDaysAgo(1),
            maturity: "established",
            feedbackEvents: [createTestFeedbackEvent("harmful", { timestamp: isoDaysAgo(10) })],
          });

          const veryStaleCandidate = createTestBullet({
            id: "b-stale-candidate",
            createdAt: isoDaysAgo(220),
            updatedAt: isoDaysAgo(220),
            maturity: "candidate",
            feedbackEvents: [],
          });

          await writePlaybookFile(
            env.playbookPath,
            createTestPlaybook([negativeScore, veryStaleCandidate])
          );

          const parsed = JSON.parse(
            await captureStdout(() => staleCommand({ days: 1, scope: "all", json: true }))
          ) as any;

          const byId = new Map<string, any>(parsed.data.bullets.map((b: any) => [b.id, b]));
          expect(byId.get("b-negative")?.recommendation).toContain("cm forget b-negative");
          expect(byId.get("b-stale-candidate")?.recommendation).toContain(
            "playbook remove b-stale-candidate"
          );
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("prints a helpful message when no stale bullets are found", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const originalNoColor = process.env.NO_COLOR;
        const originalNoEmoji = process.env.CASS_MEMORY_NO_EMOJI;
        process.env.NO_COLOR = "1";
        process.env.CASS_MEMORY_NO_EMOJI = "1";

        try {
          const now = Date.now();
          const dayMs = 86_400_000;
          const isoDaysAgo = (days: number) => new Date(now - days * dayMs).toISOString();

          const recent = createTestBullet({
            id: "b-recent",
            createdAt: isoDaysAgo(30),
            updatedAt: isoDaysAgo(1),
            feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: isoDaysAgo(1) })],
          });

          await writePlaybookFile(env.playbookPath, createTestPlaybook([recent]));

          const out = await captureStdout(() => staleCommand({ days: 90, scope: "all" }));
          expect(out).toContain("No stale bullets found.");
          expect(out).toContain("Try 'cm stale --days 0'");
        } finally {
          process.env.NO_COLOR = originalNoColor;
          process.env.CASS_MEMORY_NO_EMOJI = originalNoEmoji;
          process.chdir(originalCwd);
        }
      });
    });
  });
});
