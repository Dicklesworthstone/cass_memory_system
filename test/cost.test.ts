import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkBudget, getUsageStats, recordCost } from "../src/cost.js";
import { now } from "../src/utils.js";
import { createTestConfig } from "./helpers/index.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-cost-"));
  try {
    // Mock homedir for the test process
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    await run(dir);
    process.env.HOME = originalHome;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Cost Tracking & Optimization", () => {
  it("updates total.json correctly with daily/monthly/allTime stats", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();

      await recordCost(config, {
        provider: "openai",
        model: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 100,
        context: "test",
      });

      const costDir = path.join(dir, ".cass-memory", "cost");
      const totalPath = path.join(costDir, "total.json");

      const total = JSON.parse(await fs.readFile(totalPath, "utf-8"));

      expect(total.allTime).toBeGreaterThan(0);
      expect(total.currentDay).toBeDefined();
      expect(total.currentDay.cost).toBe(total.allTime);
      expect(total.currentMonth).toBeDefined();
      expect(total.currentMonth.cost).toBe(total.allTime);

      const today = new Date().toISOString().slice(0, 10);
      expect(total.currentDay.day).toBe(today);
    });
  });

  it("accumulates costs across multiple calls", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();

      // First call
      await recordCost(config, {
        provider: "openai",
        model: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 100, // Cost X
        context: "test 1",
      });

      // Second call
      await recordCost(config, {
        provider: "openai",
        model: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 100, // Cost X
        context: "test 2",
      });

      const costDir = path.join(dir, ".cass-memory", "cost");
      const totalPath = path.join(costDir, "total.json");
      const total = JSON.parse(await fs.readFile(totalPath, "utf-8"));

      // Should be roughly double the single cost
      // 1000 in, 100 out on gpt-4o (2.5/1M input, 10/1M output)
      // 1 call = (1000/1e6 * 2.5) + (100/1e6 * 10) = 0.0025 + 0.001 = 0.0035
      // 2 calls = 0.0070
      expect(total.allTime).toBeCloseTo(0.007, 5);
      expect(total.currentDay.cost).toBeCloseTo(0.007, 5);
    });
  });

  it("resets daily stats when day changes", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();
      const costDir = path.join(dir, ".cass-memory", "cost");
      await fs.mkdir(costDir, { recursive: true });

      // Simulate yesterday's usage in total.json
      const yesterday = "2020-01-01";
      await fs.writeFile(
        path.join(costDir, "total.json"),
        JSON.stringify({
          allTime: 10.0,
          lastUpdated: "2020-01-01T12:00:00Z",
          currentDay: { day: yesterday, cost: 5.0 },
          currentMonth: { month: "2020-01", cost: 10.0 },
        }),
      );

      // Record cost today
      await recordCost(config, {
        provider: "openai",
        model: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 100,
        context: "test",
      });

      const total = JSON.parse(await fs.readFile(path.join(costDir, "total.json"), "utf-8"));
      const today = new Date().toISOString().slice(0, 10);

      expect(total.currentDay.day).toBe(today);
      expect(total.currentDay.cost).toBeLessThan(5.0); // Should be reset to just this op (~0.0035)
      expect(total.allTime).toBeGreaterThan(10.0); // Accumulates
    });
  });

  it("checkBudget reads from total.json without scanning logs", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig({
        budget: { dailyLimit: 1.0, monthlyLimit: 100.0, warningThreshold: 80, currency: "USD" },
      });

      const costDir = path.join(dir, ".cass-memory", "cost");
      await fs.mkdir(costDir, { recursive: true });

      // Create total.json indicating budget exceeded
      const today = new Date().toISOString().slice(0, 10);
      await fs.writeFile(
        path.join(costDir, "total.json"),
        JSON.stringify({
          allTime: 50.0,
          lastUpdated: now(),
          currentDay: { day: today, cost: 2.0 }, // Exceeds 1.0 limit
          currentMonth: { month: today.slice(0, 7), cost: 5.0 },
        }),
      );

      const result = await checkBudget(config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily budget exceeded");
    });
  });

  it("checkBudget allows operation if total.json is missing", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig({
        budget: { dailyLimit: 1.0, monthlyLimit: 100.0, warningThreshold: 80, currency: "USD" },
      });

      const result = await checkBudget(config);
      expect(result.allowed).toBe(true);
    });
  });

  it("checkBudget treats 0 limits as unlimited", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig({
        budget: { dailyLimit: 0, monthlyLimit: 0, warningThreshold: 80, currency: "USD" },
      });

      const costDir = path.join(dir, ".cass-memory", "cost");
      await fs.mkdir(costDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      await fs.writeFile(
        path.join(costDir, "total.json"),
        JSON.stringify({
          allTime: 999.0,
          lastUpdated: now(),
          currentDay: { day: today, cost: 999.0 },
          currentMonth: { month: today.slice(0, 7), cost: 999.0 },
        }),
      );

      const result = await checkBudget(config);
      expect(result.allowed).toBe(true);
    });
  });
});
