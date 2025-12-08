import { loadConfig } from "../config.js";
import { loadMergedPlaybook } from "../playbook.js";
import { analyzeScoreDistribution, getEffectiveScore } from "../scoring.js";
import { getActiveBullets } from "../playbook.js";
import chalk from "chalk";

export async function statsCommand(options: { json?: boolean }): Promise<void> {
    const config = await loadConfig();
    const playbook = await loadMergedPlaybook(config);
    const bullets = getActiveBullets(playbook);
    const distribution = analyzeScoreDistribution(bullets, config);
  const total = bullets.length;

  const topPerformers = [...bullets]
    .sort((a, b) => getEffectiveScore(b, config) - getEffectiveScore(a, config))
    .slice(0, 5);

  const atRisk = bullets.filter(b => getEffectiveScore(b, config) < 0);

  const stats = {
    total,
    distribution,
    topPerformers: topPerformers.map(b => ({
      id: b.id,
      content: b.content,
      score: getEffectiveScore(b, config)
    })),
    atRiskCount: atRisk.length
  };

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(chalk.bold("\n📊 Playbook Statistics"));
  console.log(`Total Rules: ${total}`);
  
  console.log(chalk.bold("\nScore Distribution:"));
  console.log(`  🌟 Excellent (>10): ${distribution.excellent}`);
  console.log(`  ✅ Good (5-10):      ${distribution.good}`);
  console.log(`  ⚪ Neutral (0-5):    ${distribution.neutral}`);
  console.log(`  ⚠️  At Risk (<0):     ${distribution.atRisk}`);

  if (topPerformers.length > 0) {
    console.log(chalk.bold("\n🏆 Top Performers:"));
    topPerformers.forEach((b, i) => {
      console.log(`  ${i+1}. [${b.id}] ${b.content.slice(0, 60)}... (${getEffectiveScore(b, config).toFixed(1)})`);
    });
  }

  if (atRisk.length > 0) {
    console.log(chalk.bold(`\n⚠️  ${atRisk.length} Rules At Risk`));
    atRisk.slice(0, 3).forEach(b => {
      console.log(`  - [${b.id}] ${b.content.slice(0, 60)}... (${getEffectiveScore(b, config).toFixed(1)})`);
    });
  }
}