import path from "node:path";
import fs from "node:fs/promises";
import { Config } from "./types.js";
import { expandPath, ensureDir, atomicWrite, now, fileExists, warn } from "./utils.js";
import { withLock } from "./lock.js";
import { icon } from "./output.js";

export interface CostEntry {
  timestamp: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: string;
}

// Approximate costs per 1M tokens (as of late 2025)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Anthropic
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
  "gemini-2.0-flash": { input: 0.10, output: 0.4 }, // Estimate
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = MODEL_COSTS[model] || { input: 5.0, output: 15.0 }; // Default to reasonably high
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

export async function recordCost(
  config: Config,
  entry: Omit<CostEntry, "timestamp" | "cost"> 
): Promise<void> {
  const cost = estimateCost(entry.model, entry.tokensIn, entry.tokensOut);
  const fullEntry: CostEntry = {
    ...entry,
    timestamp: now(),
    cost
  };

  const costDir = expandPath("~/.cass-memory/cost");
  await ensureDir(costDir);

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const logPath = path.join(costDir, `monthly-${month}.jsonl`);
  
  // Security: Do not log the full context (prompt) to disk as it may contain secrets
  const { context, ...logEntry } = fullEntry;
  
  await withLock(logPath, async () => {
    await fs.appendFile(logPath, JSON.stringify(logEntry) + "\n");
  });
  
  // Update total
  await updateTotalCost(costDir, cost);
}

interface TotalCostData {
  allTime: number;
  lastUpdated: string;
  currentMonth?: { month: string; cost: number };
  currentDay?: { day: string; cost: number };
}

async function updateTotalCost(costDir: string, amount: number): Promise<void> {
  const totalPath = path.join(costDir, "total.json");
  const nowIso = now();
  const date = new Date();
  const today = date.toLocaleDateString("en-CA");
  const month = today.slice(0, 7);  // YYYY-MM
  
  await withLock(totalPath, async () => {
    let total: TotalCostData = { allTime: 0, lastUpdated: nowIso };
    
    if (await fileExists(totalPath)) {
      try {
        total = JSON.parse(await fs.readFile(totalPath, "utf-8"));
      } catch {} 
    }
    
    // Update All Time
    total.allTime = (total.allTime || 0) + amount;
    
    // Update Monthly
    if (!total.currentMonth || total.currentMonth.month !== month) {
      total.currentMonth = { month, cost: 0 };
    }
    total.currentMonth.cost += amount;
    
    // Update Daily
    if (!total.currentDay || total.currentDay.day !== today) {
      total.currentDay = { day: today, cost: 0 };
    }
    total.currentDay.cost += amount;
    
    total.lastUpdated = nowIso;
    
    await atomicWrite(totalPath, JSON.stringify(total, null, 2));
  });
}

export async function checkBudget(config: Config): Promise<{ allowed: boolean; reason?: string }> {
  const budget = config.budget;
  if (!budget) return { allowed: true }; // No budget set

  const costDir = expandPath("~/.cass-memory/cost");
  const totalPath = path.join(costDir, "total.json");
  
  // If total.json doesn't exist, we assume 0 cost (or legacy migration could happen here, 
  // but scanning logs is expensive so we start fresh or rely on recordCost to init)
  if (!(await fileExists(totalPath))) return { allowed: true };

  try {
    const total: TotalCostData = JSON.parse(await fs.readFile(totalPath, "utf-8"));
    const date = new Date();
    const today = date.toLocaleDateString("en-CA");
    const month = today.slice(0, 7);

    // Verify dates match current time to avoid using stale stats
    const dailyCost = (total.currentDay?.day === today) ? (total.currentDay.cost || 0) : 0;
    const monthlyCost = (total.currentMonth?.month === month) ? (total.currentMonth.cost || 0) : 0;

    // A limit of 0 (or less) means "no limit" (consistent with usage formatting).
    if (budget.dailyLimit > 0 && dailyCost >= budget.dailyLimit) {
      return { allowed: false, reason: `Daily budget exceeded ($${dailyCost.toFixed(2)} / $${budget.dailyLimit.toFixed(2)})` };
    }

    if (budget.monthlyLimit > 0 && monthlyCost >= budget.monthlyLimit) {
      return { allowed: false, reason: `Monthly budget exceeded ($${monthlyCost.toFixed(2)} / $${budget.monthlyLimit.toFixed(2)})` };
    }
  } catch (err) {
    // If read fails, fail open but warn
    warn(`[cost] Failed to read budget file: ${err}`);
  }

  return { allowed: true };
}

export async function getUsageStats(config: Config): Promise<{
  today: number;
  month: number;
  total: number;
  dailyLimit: number;
  monthlyLimit: number;
}> {
  const costDir = expandPath("~/.cass-memory/cost");
  const totalPath = path.join(costDir, "total.json");
  
  let dailyTotal = 0;
  let monthlyTotal = 0;
  let allTimeTotal = 0;

  if (await fileExists(totalPath)) {
    try {
        const total: TotalCostData = JSON.parse(await fs.readFile(totalPath, "utf-8"));
        const date = new Date();
        const today = date.toLocaleDateString("en-CA");
        const month = today.slice(0, 7);

        allTimeTotal = total.allTime || 0;
        
        if (total.currentDay?.day === today) {
            dailyTotal = total.currentDay.cost || 0;
        }
        
        if (total.currentMonth?.month === month) {
            monthlyTotal = total.currentMonth.cost || 0;
        }
    } catch {} 
  }

  return {
    today: dailyTotal,
    month: monthlyTotal,
    total: allTimeTotal,
    dailyLimit: config.budget?.dailyLimit ?? 0,
    monthlyLimit: config.budget?.monthlyLimit ?? 0
  };
}

/**
 * Format a cost summary string for display after LLM operations.
 * Shows operation cost and current budget consumption.
 */
export function formatCostSummary(
  operationCost: number,
  stats: { today: number; month: number; dailyLimit: number; monthlyLimit: number }
): string {
  const parts: string[] = [];

  // Operation cost
  parts.push(`Cost: $${operationCost.toFixed(4)}`);

  // Daily usage
  if (stats.dailyLimit > 0) {
    const dailyPercent = ((stats.today / stats.dailyLimit) * 100).toFixed(0);
    const warning = icon("warning");
    const dailyWarning = stats.today >= stats.dailyLimit * 0.8 && warning ? ` ${warning}` : "";
    parts.push(`Daily: $${stats.today.toFixed(2)}/$${stats.dailyLimit.toFixed(2)} (${dailyPercent}%)${dailyWarning}`);
  }

  // Monthly usage
  if (stats.monthlyLimit > 0) {
    const monthlyPercent = ((stats.month / stats.monthlyLimit) * 100).toFixed(0);
    parts.push(`Monthly: $${stats.month.toFixed(2)}/$${stats.monthlyLimit.toFixed(2)} (${monthlyPercent}%)`);
  }

  return parts.join(", ");
}
