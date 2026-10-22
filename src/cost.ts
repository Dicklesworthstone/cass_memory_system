import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "./lock.js";
import { icon } from "./output.js";
import type { Config } from "./types.js";
import {
  atomicWrite,
  ensureDir,
  now,
  resolveGlobalDir,
} from "./utils.js";

export interface CostEntry {
  timestamp: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: string;
}

// Approximate costs per 1M tokens (as of mid 2026)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Anthropic — current aliases
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  // Anthropic — legacy/retired snapshots (kept so old cost logs still price)
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },

  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },

  // Google
  "gemini-1.5-pro": { input: 3.5, output: 10.5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 }, // Estimate
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = MODEL_COSTS[model] || { input: 5.0, output: 15.0 }; // Default to reasonably high
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

export async function recordCost(
  config: Config,
  entry: Omit<CostEntry, "timestamp" | "cost">,
): Promise<void> {
  const cost = estimateCost(entry.model, entry.tokensIn, entry.tokensOut);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error("Reported usage must have a finite, non-negative cost");
  }
  const fullEntry: CostEntry = {
    ...entry,
    timestamp: now(),
    cost,
  };

  const costDir = path.join(resolveGlobalDir(), "cost");
  await ensureDir(costDir);

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const logPath = path.join(costDir, `monthly-${month}.jsonl`);

  // Security: Do not log the full context (prompt) to disk as it may contain secrets
  const { context, ...logEntry } = fullEntry;

  // All writers, including callers outside the LLM admission guard, use one
  // accounting lock. A partial append/update must not reopen stale headroom.
  const totalPath = path.join(costDir, "total.json");
  const pendingPath = path.join(costDir, "accounting-pending.json");
  await withLock(totalPath, async () => {
    await assertNoPending(pendingPath);
    const total = await readTotalCost(costDir);
    await writePendingMarker(pendingPath);

    const log = await fs.open(logPath, "a", 0o600);
    try {
      await log.writeFile(JSON.stringify(logEntry) + "\n");
      await log.sync();
    } finally {
      await log.close();
    }
    await updateTotalCost(totalPath, total, cost);
    await fs.unlink(pendingPath);
  });
}

interface TotalCostData {
  allTime: number;
  lastUpdated: string;
  currentMonth?: { month: string; cost: number };
  currentDay?: { day: string; cost: number };
}

const validCost = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

async function updateTotalCost(totalPath: string, total: TotalCostData, amount: number): Promise<void> {
  const nowIso = now();
  const date = new Date();
  const today = date.toLocaleDateString("en-CA");
  const month = today.slice(0, 7); // YYYY-MM

  total.allTime += amount;
  if (!total.currentMonth || total.currentMonth.month !== month) {
    total.currentMonth = { month, cost: 0 };
  }
  total.currentMonth.cost += amount;
  if (!total.currentDay || total.currentDay.day !== today) {
    total.currentDay = { day: today, cost: 0 };
  }
  total.currentDay.cost += amount;
  total.lastUpdated = nowIso;

  await atomicWrite(totalPath, JSON.stringify(total, null, 2));
  const file = await fs.open(totalPath, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function assertNoPending(pendingPath: string): Promise<void> {
  try {
    await fs.lstat(pendingPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Unsettled usage accounting at ${pendingPath}; reconcile the cost ledger before making further requests`);
}

async function writePendingMarker(pendingPath: string): Promise<void> {
  const file = await fs.open(pendingPath, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ startedAt: now(), pid: process.pid }));
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readTotalCost(costDir: string): Promise<TotalCostData> {
  const totalPath = path.join(costDir, "total.json");
  let raw: string;
  try {
    raw = await fs.readFile(totalPath, "utf-8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    let names: string[];
    try {
      names = await fs.readdir(costDir);
    } catch (directoryError: any) {
      if (directoryError?.code !== "ENOENT") throw directoryError;
      names = [];
    }
    if (names.some(name => /^monthly-.*\.jsonl$/.test(name))) {
      throw new Error("Cost totals are missing but usage logs exist; reconcile the cost ledger before making further requests");
    }
    return { allTime: 0, lastUpdated: now() };
  }

  const total = JSON.parse(raw) as TotalCostData | null;
  if (!total || !validCost(total.allTime) || typeof total.lastUpdated !== "string" ||
    !Number.isFinite(Date.parse(total.lastUpdated)) ||
    (total.currentDay !== undefined && (!total.currentDay ||
      typeof total.currentDay.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(total.currentDay.day) ||
      !validCost(total.currentDay.cost))) ||
    (total.currentMonth !== undefined && (!total.currentMonth ||
      typeof total.currentMonth.month !== "string" || !/^\d{4}-\d{2}$/.test(total.currentMonth.month) ||
      !validCost(total.currentMonth.cost)))) {
    throw new Error(`Invalid cost totals in ${totalPath}`);
  }
  if (total.allTime > 0 && (!total.currentDay || !total.currentMonth)) {
    await restoreCurrentPeriods(costDir, total);
  }
  return total;
}

/**
 * Totals written before cm kept daily and monthly sums (cm releases up to
 * December 2025) hold only `allTime` and `lastUpdated`; budgets were enforced
 * from the per-request usage logs instead. Every charge bumps `lastUpdated`,
 * so a period that began after it has no recorded spend. Spend in a period
 * that may include charges is rebuilt from those logs, never assumed to be 0.
 * The caller persists the result with its next charge.
 */
async function restoreCurrentPeriods(costDir: string, total: TotalCostData): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA");
  const month = today.slice(0, 7);
  const lastChargeDay = new Date(total.lastUpdated).toLocaleDateString("en-CA");
  const dayMayHaveSpend = !total.currentDay && lastChargeDay >= today;
  const monthMayHaveSpend = !total.currentMonth && lastChargeDay.slice(0, 7) >= month;
  const logged = dayMayHaveSpend || monthMayHaveSpend
    ? await sumLoggedSpend(costDir, today)
    : { day: 0, month: 0 };
  total.currentDay ??= { day: today, cost: dayMayHaveSpend ? logged.day : 0 };
  total.currentMonth ??= { month, cost: monthMayHaveSpend ? logged.month : 0 };
}

/** Sum the usage logs' charges on the local calendar day `today` and its month. */
async function sumLoggedSpend(costDir: string, today: string): Promise<{ day: number; month: number }> {
  const month = today.slice(0, 7);
  // Logs are named for the UTC month of each charge, so one local month can
  // draw on the UTC months on either side of it.
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const logNames = [-1, 0, 1].map(offset =>
    `monthly-${new Date(Date.UTC(year, monthIndex + offset, 1)).toISOString().slice(0, 7)}.jsonl`);

  let sawLog = false;
  let day = 0;
  let monthSum = 0;
  for (const name of logNames) {
    const logPath = path.join(costDir, name);
    let raw: string;
    try {
      raw = await fs.readFile(logPath, "utf-8");
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    sawLog = true;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: { timestamp?: unknown; cost?: unknown } | null;
      try {
        entry = JSON.parse(line);
      } catch {
        entry = null;
      }
      const chargedAt = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      if (!entry || !Number.isFinite(chargedAt) || !validCost(entry.cost)) {
        throw new Error(`Invalid usage entry in ${logPath}; reconcile the cost ledger before making further requests`);
      }
      const chargedDay = new Date(chargedAt).toLocaleDateString("en-CA");
      if (chargedDay.slice(0, 7) === month) monthSum += entry.cost;
      if (chargedDay === today) day += entry.cost;
    }
  }
  if (!sawLog) {
    throw new Error("Cost totals predate daily and monthly tracking and no usage log covers the current period; reconcile the cost ledger before making further requests");
  }
  return { day, month: monthSum };
}

async function checkBudgetAt(config: Config, costDir: string): Promise<{ allowed: boolean; reason?: string }> {
  try {
    await assertNoPending(path.join(costDir, "admission-pending.json"));
    await assertNoPending(path.join(costDir, "accounting-pending.json"));
    const total = await readTotalCost(costDir);
    const budget = config.budget;
    if (!budget) return { allowed: true };
    const date = new Date();
    const today = date.toLocaleDateString("en-CA");
    const month = today.slice(0, 7);

    // Verify dates match current time to avoid using stale stats
    const dailyCost = total.currentDay?.day === today ? total.currentDay.cost || 0 : 0;
    const monthlyCost = total.currentMonth?.month === month ? total.currentMonth.cost || 0 : 0;

    // A limit of 0 (or less) means "no limit" (consistent with usage formatting).
    if (budget.dailyLimit > 0 && dailyCost >= budget.dailyLimit) {
      return {
        allowed: false,
        reason: `Daily budget exceeded ($${dailyCost.toFixed(2)} / $${budget.dailyLimit.toFixed(2)})`,
      };
    }

    if (budget.monthlyLimit > 0 && monthlyCost >= budget.monthlyLimit) {
      return {
        allowed: false,
        reason: `Monthly budget exceeded ($${monthlyCost.toFixed(2)} / $${budget.monthlyLimit.toFixed(2)})`,
      };
    }
  } catch (err) {
    return { allowed: false, reason: `Budget accounting unavailable: ${err}` };
  }

  return { allowed: true };
}

export async function checkBudget(config: Config): Promise<{ allowed: boolean; reason?: string }> {
  return checkBudgetAt(config, path.join(resolveGlobalDir(), "cost"));
}

/** Terminal: retrying admission/accounting failures could spend untracked money. */
export class BudgetAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BudgetAdmissionError";
  }
}

/**
 * Serialize API spending across every workspace sharing a cost home. The
 * callback must settle reported usage before resolving; a rejection leaves a
 * durable marker so a failed accounting write cannot authorize the next call.
 * Provider failures whose usage was settled should be returned as values.
 * This enforces recorded-spend thresholds, not a pre-request cost reservation:
 * one response may still take the estimate past a configured limit.
 */
export async function withBudgetAdmission<T>(
  config: Config,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const costDir = path.join(resolveGlobalDir(), "cost");
  const pendingPath = path.join(costDir, "admission-pending.json");
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    controller.abort(new BudgetAdmissionError(`LLM budget admission timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let operationStarted = false;

  try {
    return await withLock(path.join(costDir, "admission"), async () => {
      await withLock(path.join(costDir, "total.json"), async () => {
        const budget = await checkBudgetAt(config, costDir);
        if (!budget.allowed) throw new BudgetAdmissionError(`LLM budget exceeded or unavailable: ${budget.reason}`);
        controller.signal.throwIfAborted();
        await writePendingMarker(pendingPath);
      }, { signal: controller.signal });

      if (controller.signal.aborted) {
        await fs.unlink(pendingPath);
        controller.signal.throwIfAborted();
      }
      // Only admission has this deadline, including the ledger check. The
      // provider's actual promise retains the lock through usage settlement.
      clearTimeout(timer);
      operationStarted = true;
      const result = await operation();
      try {
        await fs.unlink(pendingPath);
      } catch (error) {
        throw new BudgetAdmissionError("Failed to settle LLM budget admission; refusing further requests", { cause: error });
      }
      return result;
    }, { signal: controller.signal, retries: Math.ceil(timeoutMs / 25) + 2, delay: 25 });
  } catch (error) {
    if (operationStarted || error instanceof BudgetAdmissionError) throw error;
    if (options.signal?.aborted) options.signal.throwIfAborted();
    throw new BudgetAdmissionError(`Unable to admit LLM request: ${error}`, { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function getUsageStats(config: Config): Promise<{
  today: number;
  month: number;
  total: number;
  dailyLimit: number;
  monthlyLimit: number;
}> {
  const costDir = path.join(resolveGlobalDir(), "cost");

  let dailyTotal = 0;
  let monthlyTotal = 0;
  let allTimeTotal = 0;

  try {
    // Same reader as budget admission, so the report matches what is enforced.
    const total = await readTotalCost(costDir);
    const date = new Date();
    const today = date.toLocaleDateString("en-CA");
    const month = today.slice(0, 7);

    allTimeTotal = total.allTime;

    if (total.currentDay?.day === today) {
      dailyTotal = total.currentDay.cost;
    }

    if (total.currentMonth?.month === month) {
      monthlyTotal = total.currentMonth.cost;
    }
  } catch {}

  return {
    today: dailyTotal,
    month: monthlyTotal,
    total: allTimeTotal,
    dailyLimit: config.budget?.dailyLimit ?? 0,
    monthlyLimit: config.budget?.monthlyLimit ?? 0,
  };
}

/**
 * Format a cost summary string for display after LLM operations.
 * Shows operation cost and current budget consumption.
 */
export function formatCostSummary(
  operationCost: number,
  stats: { today: number; month: number; dailyLimit: number; monthlyLimit: number },
): string {
  const parts: string[] = [];

  // Operation cost
  parts.push(`Cost: $${operationCost.toFixed(4)}`);

  // Daily usage
  if (stats.dailyLimit > 0) {
    const dailyPercent = ((stats.today / stats.dailyLimit) * 100).toFixed(0);
    const warning = icon("warning");
    const dailyWarning = stats.today >= stats.dailyLimit * 0.8 && warning ? ` ${warning}` : "";
    parts.push(
      `Daily: $${stats.today.toFixed(2)}/$${stats.dailyLimit.toFixed(2)} (${dailyPercent}%)${dailyWarning}`,
    );
  }

  // Monthly usage
  if (stats.monthlyLimit > 0) {
    const monthlyPercent = ((stats.month / stats.monthlyLimit) * 100).toFixed(0);
    parts.push(
      `Monthly: $${stats.month.toFixed(2)}/$${stats.monthlyLimit.toFixed(2)} (${monthlyPercent}%)`,
    );
  }

  return parts.join(", ");
}
