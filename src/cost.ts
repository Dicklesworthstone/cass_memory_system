import path from "node:path";
import fs from "node:fs/promises";
import { Config } from "./types.js";
import { expandPath, ensureDir, atomicWrite, now, fileExists } from "./utils.js";

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
  
  await fs.appendFile(logPath, JSON.stringify(fullEntry) + "\n");
  
  // Update total
  await updateTotalCost(costDir, cost);
}

async function updateTotalCost(costDir: string, amount: number): Promise<void> {
  const totalPath = path.join(costDir, "total.json");
  let total = { allTime: 0, lastUpdated: now() };
  
  if (await fileExists(totalPath)) {
    try {
      total = JSON.parse(await fs.readFile(totalPath, "utf-8"));
    } catch {} // Ignore errors, assume default if file is corrupt
  }
  
  total.allTime += amount;
  total.lastUpdated = now();
  
  await atomicWrite(totalPath, JSON.stringify(total, null, 2));
}

export async function checkBudget(config: Config): Promise<{ allowed: boolean; reason?: string }> {
  const budget = config.budget;
  if (!budget) return { allowed: true }; // No budget set

  const costDir = expandPath("~/.cass-memory/cost");
  if (!(await fileExists(costDir))) return { allowed: true };

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Calculate daily and monthly usage
  // Note: This can be slow if logs are huge. Optimally we'd cache this.
  // For V1, we scan the monthly file.
  
  const logPath = path.join(costDir, `monthly-${month}.jsonl`);
  if (!(await fileExists(logPath))) return { allowed: true };

  const content = await fs.readFile(logPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  
  let dailyTotal = 0;
  let monthlyTotal = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CostEntry;
      monthlyTotal += entry.cost;
      if (entry.timestamp.startsWith(today)) {
        dailyTotal += entry.cost;
      }
    } catch {} // Ignore invalid JSON lines
  }

  if (dailyTotal >= budget.dailyLimit) {
    return { allowed: false, reason: `Daily budget exceeded ($${dailyTotal.toFixed(2)} / $${budget.dailyLimit.toFixed(2)})` };
  }

  if (monthlyTotal >= budget.monthlyLimit) {
    return { allowed: false, reason: `Monthly budget exceeded ($${monthlyTotal.toFixed(2)} / $${budget.monthlyLimit.toFixed(2)})` };
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
  // Reuse logic from checkBudget but return numbers
  const costDir = expandPath("~/.cass-memory/cost");
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  
  let dailyTotal = 0;
  let monthlyTotal = 0;
  let allTimeTotal = 0;

  // Load total
  const totalPath = path.join(costDir, "total.json");
  if (await fileExists(totalPath)) {
    try {
        const t = JSON.parse(await fs.readFile(totalPath, "utf-8"));
        allTimeTotal = t.allTime || 0;
    } catch {} // Ignore errors, assume default if file is corrupt
  }

  // Load monthly
  const logPath = path.join(costDir, `monthly-${month}.jsonl`);
  if (await fileExists(logPath)) {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CostEntry;
          monthlyTotal += entry.cost;
          if (entry.timestamp.startsWith(today)) {
            dailyTotal += entry.cost;
          }
        } catch {} // Ignore invalid JSON lines
      }
  }

  return {
    today: dailyTotal,
    month: monthlyTotal,
    total: allTimeTotal,
    dailyLimit: config.budget?.dailyLimit ?? 0,
    monthlyLimit: config.budget?.monthlyLimit ?? 0
  };
}
