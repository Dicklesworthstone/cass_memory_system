import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkBudget, getUsageStats, recordCost, withBudgetAdmission } from "../src/cost.js";
import { withLock } from "../src/lock.js";
import { now } from "../src/utils.js";
import { createTestConfig } from "./helpers/index.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-cost-"));
  const originalHome = process.env.HOME;
  const originalMemoryHome = process.env.CASS_MEMORY_HOME;
  try {
    // Mock homedir for the test process
    process.env.HOME = dir;
    process.env.CASS_MEMORY_HOME = path.join(dir, ".cass-memory");
    await run(dir);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMemoryHome === undefined) delete process.env.CASS_MEMORY_HOME;
    else process.env.CASS_MEMORY_HOME = originalMemoryHome;
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

      const today = new Date().toLocaleDateString("en-CA");
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
      const today = new Date().toLocaleDateString("en-CA");

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
      const today = new Date().toLocaleDateString("en-CA");
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

      const today = new Date().toLocaleDateString("en-CA");
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

  for (const contents of ["{broken", "null", "{}", '{"allTime":-1,"lastUpdated":"2026-01-01"}',
    '{"allTime":5,"lastUpdated":"yesterday"}',
    '{"allTime":0,"lastUpdated":"2026-01-01","currentDay":{"day":"2026-01-01","cost":"0"}}']) {
    it(`refuses spending and preserves malformed totals: ${contents}`, async () => {
      await withTempDir(async (dir) => {
        const config = createTestConfig();
        const costDir = path.join(dir, ".cass-memory", "cost");
        await fs.mkdir(costDir, { recursive: true });
        const totalPath = path.join(costDir, "total.json");
        await fs.writeFile(totalPath, contents);
        const budget = await checkBudget(config);
        expect(budget.allowed).toBe(false);
        expect(budget.reason).toContain("Budget accounting unavailable");
        await expect(recordCost(config, { provider: "openai", model: "gpt-4o", tokensIn: 1000,
          tokensOut: 0, context: "test" })).rejects.toThrow();
        expect(await fs.readFile(totalPath, "utf8")).toBe(contents);
      });
    });
  }

  it("does not treat an unreadable totals path or missing totals with logs as zero usage", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();
      const costDir = path.join(dir, ".cass-memory", "cost");
      const totalPath = path.join(costDir, "total.json");
      await fs.mkdir(totalPath, { recursive: true });
      expect((await checkBudget(config)).allowed).toBe(false);
      await fs.rename(totalPath, path.join(costDir, "saved-unreadable-totals"));
      await fs.writeFile(path.join(costDir, "monthly-2026-01.jsonl"), '{"cost":10}\n');
      const budget = await checkBudget(config);
      expect(budget.allowed).toBe(false);
      expect(budget.reason).toContain("totals are missing but usage logs exist");
    });
  });

  it("serializes direct accounting writers without losing charges or leaving another writer's marker", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();
      await Promise.all(Array.from({ length: 8 }, () => recordCost(config, {
        provider: "openai", model: "gpt-4o", tokensIn: 1000, tokensOut: 0, context: "concurrent accounting",
      })));
      const stats = await getUsageStats(config);
      expect(stats.today).toBeCloseTo(0.02);
      expect(stats.month).toBeCloseTo(0.02);
      expect(stats.total).toBeCloseTo(0.02);
      const costDir = path.join(dir, ".cass-memory", "cost");
      const rows = (await fs.readFile(path.join(costDir, `monthly-${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")).trim().split("\n");
      expect(rows).toHaveLength(8);
      expect((await fs.readdir(costDir)).some(name => name.includes("pending"))).toBe(false);
    });
  });

  it("keeps a failed ledger transaction closed after the original write obstacle is repaired", async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();
      const costDir = path.join(dir, ".cass-memory", "cost");
      const logPath = path.join(costDir, `monthly-${new Date().toISOString().slice(0, 7)}.jsonl`);
      // Seed valid totals before blocking the append itself.
      await recordCost(config, { provider: "openai", model: "gpt-4o", tokensIn: 0, tokensOut: 0, context: "seed" });
      await fs.rename(logPath, `${logPath}.saved`);
      await fs.mkdir(logPath);
      await expect(recordCost(config, { provider: "openai", model: "gpt-4o", tokensIn: 1000,
        tokensOut: 0, context: "charged request" })).rejects.toThrow();
      await fs.rename(logPath, `${logPath}.repaired`);
      const budget = await checkBudget(config);
      expect(budget.allowed).toBe(false);
      expect(budget.reason).toContain("accounting-pending.json");
      expect(await fs.readFile(path.join(costDir, "accounting-pending.json"), "utf8")).toContain("startedAt");
    });
  });

  for (const heldLock of ["admission", "total.json"]) {
  it(`expires admission waiting on ${heldLock} without starting a late callback`, async () => {
    await withTempDir(async (dir) => {
      const config = createTestConfig();
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const holder = withLock(path.join(dir, ".cass-memory", "cost", heldLock), async () => {
        entered();
        await hold;
      });
      await ready;
      let calls = 0;
      try {
        await expect(withBudgetAdmission(config, async () => { calls++; }, { timeoutMs: 20 }))
          .rejects.toThrow("admission timed out");
      } finally {
        release();
        await holder;
      }
      await withBudgetAdmission(config, async () => undefined);
      expect(calls).toBe(0);
    });
  });
  }
});

// cm releases up to December 2025 wrote total.json with only allTime and
// lastUpdated (budgets came from the monthly usage logs). Upgrading must keep
// such a ledger working without understating spend in the current period.
describe("totals written before daily and monthly sums", () => {
  const budget = (dailyLimit: number, monthlyLimit: number) =>
    createTestConfig({ budget: { dailyLimit, monthlyLimit, warningThreshold: 80, currency: "USD" } });
  const charge = { provider: "openai", model: "gpt-4o", tokensIn: 1000, tokensOut: 0, context: "test" };
  const logLine = (timestamp: string, cost: number) =>
    JSON.stringify({ provider: "anthropic", model: "claude-3", tokensIn: 10, tokensOut: 5, timestamp, cost }) + "\n";

  async function seedLedger(dir: string, total: string, logs: Record<string, string>): Promise<string> {
    const costDir = path.join(dir, ".cass-memory", "cost");
    await fs.mkdir(costDir, { recursive: true });
    await fs.writeFile(path.join(costDir, "total.json"), total);
    for (const [name, contents] of Object.entries(logs)) {
      await fs.writeFile(path.join(costDir, name), contents);
    }
    return costDir;
  }

  async function withClock<T>(iso: string, tz: string, run: () => Promise<T>): Promise<T> {
    const originalTz = process.env.TZ;
    process.env.TZ = tz;
    setSystemTime(new Date(iso));
    try {
      return await run();
    } finally {
      setSystemTime();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  }

  it("accepts an old ledger last charged in an earlier month and keeps its all-time spend", async () => {
    await withTempDir(async (dir) => {
      const legacy = '{\n  "allTime": 0.00025,\n  "lastUpdated": "2025-12-08T02:06:36.881Z"\n}';
      const costDir = await seedLedger(dir, legacy, {
        "monthly-2025-12.jsonl": logLine("2025-12-08T02:06:36.874Z", 0.000125) +
          logLine("2025-12-08T02:06:36.881Z", 0.000125),
      });

      expect(await checkBudget(budget(1, 10))).toEqual({ allowed: true });
      const stats = await getUsageStats(budget(1, 10));
      expect([stats.today, stats.month, stats.total]).toEqual([0, 0, 0.00025]);

      await recordCost(createTestConfig(), charge);
      const total = JSON.parse(await fs.readFile(path.join(costDir, "total.json"), "utf-8"));
      const today = new Date().toLocaleDateString("en-CA");
      expect(total.allTime).toBeCloseTo(0.00275, 10);
      expect(total.currentDay).toEqual({ day: today, cost: 0.0025 });
      expect(total.currentMonth).toEqual({ month: today.slice(0, 7), cost: 0.0025 });
    });
  });

  it("rebuilds today's and this month's spend from the usage logs when the old ledger was charged today", async () => {
    await withTempDir(async (dir) => {
      await withClock("2026-10-15T12:30:00.000Z", "UTC", async () => {
        const costDir = await seedLedger(dir, '{"allTime":7,"lastUpdated":"2026-10-15T12:20:00.000Z"}', {
          "monthly-2026-09.jsonl": logLine("2026-09-20T12:00:00.000Z", 4),
          "monthly-2026-10.jsonl": logLine("2026-10-08T12:30:00.000Z", 1) + logLine("2026-10-15T12:20:00.000Z", 2),
        });

        expect(await checkBudget(budget(1.5, 100))).toEqual({
          allowed: false, reason: "Daily budget exceeded ($2.00 / $1.50)",
        });
        expect(await checkBudget(budget(0, 2.5))).toEqual({
          allowed: false, reason: "Monthly budget exceeded ($3.00 / $2.50)",
        });
        expect(await checkBudget(budget(2.5, 3.5))).toEqual({ allowed: true });
        const stats = await getUsageStats(budget(0, 0));
        expect([stats.today, stats.month, stats.total]).toEqual([2, 3, 7]);

        // The next charge persists the rebuilt sums instead of restarting them at 0.
        await recordCost(createTestConfig(), charge);
        const total = JSON.parse(await fs.readFile(path.join(costDir, "total.json"), "utf-8"));
        expect(total.allTime).toBeCloseTo(7.0025, 10);
        expect(total.currentDay.day).toBe("2026-10-15");
        expect(total.currentDay.cost).toBeCloseTo(2.0025, 10);
        expect(total.currentMonth.month).toBe("2026-10");
        expect(total.currentMonth.cost).toBeCloseTo(3.0025, 10);
      });
    });
  });

  it("charges only the month when the old ledger was last charged earlier this month", async () => {
    await withTempDir(async (dir) => {
      await withClock("2026-10-15T12:30:00.000Z", "UTC", async () => {
        await seedLedger(dir, '{"allTime":5,"lastUpdated":"2026-10-08T12:30:00.000Z"}', {
          "monthly-2026-10.jsonl": logLine("2026-10-08T12:30:00.000Z", 1),
        });
        expect(await checkBudget(budget(0.5, 100))).toEqual({ allowed: true });
        expect((await checkBudget(budget(0, 1))).reason).toBe("Monthly budget exceeded ($1.00 / $1.00)");
      });
    });
  });

  it("counts a local month's charges that were logged under the next UTC month", async () => {
    await withTempDir(async (dir) => {
      // 01:00Z on Nov 1 is still Oct 31 in New York, but was logged in the November file.
      await withClock("2026-11-01T02:00:00.000Z", "America/New_York", async () => {
        await seedLedger(dir, '{"allTime":3,"lastUpdated":"2026-11-01T01:00:00.000Z"}', {
          "monthly-2026-10.jsonl": logLine("2026-10-31T12:00:00.000Z", 1),
          "monthly-2026-11.jsonl": logLine("2026-11-01T01:00:00.000Z", 2),
        });
        const stats = await getUsageStats(budget(0, 0));
        expect([stats.today, stats.month]).toEqual([3, 3]);
      });
    });
  });

  for (const [label, logs, reason] of [
    ["no usage log covers the period", {}, "no usage log covers the current period"],
    ["a usage log entry is unreadable", { "monthly-2026-10.jsonl": '{"timestamp":"2026-10-15T12:20:00.000Z","cost":2\n' },
      "Invalid usage entry"],
  ] as const) {
    it(`keeps refusing an old ledger charged today when ${label}`, async () => {
      await withTempDir(async (dir) => {
        await withClock("2026-10-15T12:30:00.000Z", "UTC", async () => {
          const legacy = '{"allTime":7,"lastUpdated":"2026-10-15T12:20:00.000Z"}';
          const costDir = await seedLedger(dir, legacy, logs);
          const result = await checkBudget(budget(0, 0));
          expect(result.allowed).toBe(false);
          expect(result.reason).toContain(reason);
          await expect(recordCost(createTestConfig(), charge)).rejects.toThrow(reason);
          expect(await fs.readFile(path.join(costDir, "total.json"), "utf8")).toBe(legacy);
        });
      });
    });
  }
});
