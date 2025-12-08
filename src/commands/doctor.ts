import { loadConfig } from "../config.js";
import { cassAvailable, cassStats } from "../cass.js";
import { fileExists, resolveRepoDir } from "../utils.js";
import { isLLMAvailable } from "../llm.js";
import { SECRET_PATTERNS, compileExtraPatterns } from "../security.js";
import chalk from "chalk";
import path from "node:path";

type CheckStatus = "pass" | "warn" | "fail";
type OverallStatus = "healthy" | "degraded" | "unhealthy";
type PatternMatch = { pattern: string; sample: string; replacement: string; suggestion?: string };

function statusIcon(status: CheckStatus): string {
  if (status === "pass") return "✅";
  if (status === "warn") return "⚠️ ";
  return "❌";
}

function nextOverallStatus(current: OverallStatus, status: CheckStatus): OverallStatus {
  if (status === "fail") return "unhealthy";
  if (status === "warn" && current !== "unhealthy") return "degraded";
  return current;
}

function testPatternBreadth(
  patterns: Array<{ pattern: RegExp; replacement: string }>,
  samples: string[]
): { matches: PatternMatch[]; tested: number } {
  const matches: PatternMatch[] = [];
  const tested = patterns.length * samples.length;

  for (const { pattern, replacement } of patterns) {
    for (const sample of samples) {
      pattern.lastIndex = 0;
      if (pattern.test(sample)) {
        const patternStr = pattern.toString();
        const suggestion = patternStr.includes("token")
          ? "Consider anchoring token with delimiters, e.g. /token[\"\\s:=]+/i"
          : "Consider tightening with explicit delimiters around secrets";
        matches.push({ pattern: patternStr, sample, replacement, suggestion });
      }
    }
  }

  return { matches, tested };
}

export async function doctorCommand(options: { json?: boolean; fix?: boolean }): Promise<void> {
  const config = await loadConfig();
  const checks: Array<{ category: string; status: CheckStatus; message: string; details?: unknown }> = [];

  // 1) cass integration
  const cassOk = cassAvailable(config.cassPath);
  checks.push({
    category: "Cass Integration",
    status: cassOk ? "pass" : "fail",
    message: cassOk ? "cass CLI found" : "cass CLI not found",
    details: cassOk ? await cassStats(config.cassPath) : undefined,
  });

  // 2) Storage
  const playbookExists = await fileExists(config.playbookPath);
  const diaryDirExists = await fileExists(config.diaryDir);
  checks.push({
    category: "Storage",
    status: playbookExists && diaryDirExists ? "pass" : "warn",
    message: `Playbook: ${playbookExists ? "Found" : "Missing"}, Diary: ${diaryDirExists ? "Found" : "Missing"}`,
  });

  // 3) LLM config
  const hasApiKey = isLLMAvailable(config.provider) || !!config.apiKey;
  checks.push({
    category: "LLM Configuration",
    status: hasApiKey ? "pass" : "fail",
    message: `Provider: ${config.provider}, API Key: ${hasApiKey ? "Set" : "Missing"}`,
  });

  // 4) Repo-level .cass/ structure (if in a git repo)
  const cassDir = await resolveRepoDir();
  if (cassDir) {
    const repoPlaybookExists = await fileExists(path.join(cassDir, "playbook.yaml"));
    const repoToxicExists = await fileExists(path.join(cassDir, "toxic.log"));

    const hasStructure = repoPlaybookExists || repoToxicExists;
    const isComplete = repoPlaybookExists && repoToxicExists;

    let status: CheckStatus = "pass";
    let message = "";

    if (!hasStructure) {
      status = "warn";
      message = "Not initialized. Run `cm init --repo` to enable project-level memory.";
    } else if (!isComplete) {
      status = "warn";
      const missing: string[] = [];
      if (!repoPlaybookExists) missing.push("playbook.yaml");
      if (!repoToxicExists) missing.push("toxic.log");
      message = `Partial setup. Missing: ${missing.join(", ")}. Run \`cm init --repo --force\` to complete.`;
    } else {
      message = "Complete (.cass/playbook.yaml and .cass/toxic.log present)";
    }

    checks.push({
      category: "Repo .cass/ Structure",
      status,
      message,
      details: {
        cassDir,
        playbookExists: repoPlaybookExists,
        toxicLogExists: repoToxicExists,
      },
    });
  } else {
    checks.push({
      category: "Repo .cass/ Structure",
      status: "warn",
      message: "Not in a git repository. Repo-level memory not available.",
    });
  }

  // 5) Sanitization breadth (detect over-broad regexes)
  if (!config.sanitization?.enabled) {
    checks.push({
      category: "Sanitization Pattern Health",
      status: "warn",
      message: "Sanitization disabled; breadth checks skipped",
    });
  } else {
    const benignSamples = [
      "The tokenizer splits text into tokens",
      "Bearer of bad news",
      "This is a password-protected file",
      "The API key concept is important",
    ];

    const builtInResult = testPatternBreadth(SECRET_PATTERNS, benignSamples);
    const extraPatterns = compileExtraPatterns(config.sanitization.extraPatterns);
    const extraResult = testPatternBreadth(
      extraPatterns.map((p) => ({ pattern: p, replacement: "[REDACTED_CUSTOM]" })),
      benignSamples
    );

    const totalMatches = builtInResult.matches.length + extraResult.matches.length;
    const totalTested = builtInResult.tested + extraResult.tested;
    const falsePositiveRate = totalTested > 0 ? totalMatches / totalTested : 0;

    checks.push({
      category: "Sanitization Pattern Health",
      status: totalMatches > 0 ? "warn" : "pass",
      message:
        totalMatches > 0
          ? `Potential broad patterns detected (${totalMatches} benign hits, ~${(falsePositiveRate * 100).toFixed(1)}% est. FP)`
          : "All patterns passed benign breadth checks",
      details: {
        benignSamples,
        builtInMatches: builtInResult.matches,
        extraMatches: extraResult.matches,
        falsePositiveRate,
      },
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  console.log(chalk.bold("\n🏥 System Health Check\n"));
  let overallStatus: OverallStatus = "healthy";
  for (const check of checks) {
    console.log(`${statusIcon(check.status)} ${chalk.bold(check.category)}: ${check.message}`);
    overallStatus = nextOverallStatus(overallStatus, check.status);

    if (check.category === "Sanitization Pattern Health" && check.details && (check.details as any).builtInMatches) {
      const details = check.details as {
        builtInMatches: PatternMatch[];
        extraMatches: PatternMatch[];
      };
      const allMatches = [...(details.builtInMatches || []), ...(details.extraMatches || [])];
      if (allMatches.length > 0) {
        console.log(chalk.yellow("  Potentially broad patterns:"));
        for (const m of allMatches) {
          console.log(chalk.yellow(`  - ${m.pattern} matched "${m.sample}" (replacement: ${m.replacement})`));
          if (m.suggestion) {
            console.log(chalk.yellow(`    Suggestion: ${m.suggestion}`));
          }
        }
      }
    }
  }

  console.log("");
  if (overallStatus === "healthy") console.log(chalk.green("System is healthy ready to rock! 🚀"));
  else if (overallStatus === "degraded") console.log(chalk.yellow("System is running in degraded mode."));
  else console.log(chalk.red("System has critical issues."));
}