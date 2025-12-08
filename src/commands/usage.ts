import { loadConfig } from "../config.js";
import { getUsageStats } from "../cost.js";
import chalk from "chalk";

export interface UsageOptions {
  json?: boolean;
}

export async function usageCommand(options: UsageOptions = {}): Promise<void> {
  const config = await loadConfig();
  const stats = await getUsageStats(config);

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  // Human-readable output
  console.log(chalk.bold("\n📊 LLM Usage Statistics\n"));

  // Today's usage
  const todayPercent = stats.dailyLimit > 0
    ? ((stats.today / stats.dailyLimit) * 100).toFixed(1)
    : "N/A";
  const todayColor = stats.dailyLimit > 0 && stats.today >= stats.dailyLimit * 0.8
    ? chalk.yellow
    : chalk.green;
  console.log(
    `Today:    ${todayColor(`$${stats.today.toFixed(4)}`)} / $${stats.dailyLimit.toFixed(2)} (${todayPercent}%)`
  );

  // Monthly usage
  const monthPercent = stats.monthlyLimit > 0
    ? ((stats.month / stats.monthlyLimit) * 100).toFixed(1)
    : "N/A";
  const monthColor = stats.monthlyLimit > 0 && stats.month >= stats.monthlyLimit * 0.8
    ? chalk.yellow
    : chalk.green;
  console.log(
    `Month:    ${monthColor(`$${stats.month.toFixed(4)}`)} / $${stats.monthlyLimit.toFixed(2)} (${monthPercent}%)`
  );

  // All-time total
  console.log(`All-time: ${chalk.blue(`$${stats.total.toFixed(4)}`)}`);

  // Budget warnings
  if (stats.dailyLimit > 0 && stats.today >= stats.dailyLimit) {
    console.log(chalk.red("\n⚠️  Daily budget limit reached! LLM operations will be blocked."));
  } else if (stats.monthlyLimit > 0 && stats.month >= stats.monthlyLimit) {
    console.log(chalk.red("\n⚠️  Monthly budget limit reached! LLM operations will be blocked."));
  }

  // Usage progress bars
  console.log(chalk.bold("\n📈 Budget Progress\n"));
  console.log(`Daily:   ${renderProgressBar(stats.today, stats.dailyLimit)}`);
  console.log(`Monthly: ${renderProgressBar(stats.month, stats.monthlyLimit)}`);

  console.log(chalk.gray("\n💡 Configure limits in ~/.cass-memory/config.json under 'budget'"));
}

function renderProgressBar(current: number, limit: number, width: number = 30): string {
  if (limit <= 0) return chalk.gray("(no limit set)");

  const ratio = Math.min(current / limit, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (ratio >= 1) return chalk.red(bar);
  if (ratio >= 0.8) return chalk.yellow(bar);
  return chalk.green(bar);
}
