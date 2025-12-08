import { loadConfig, DEFAULT_CONFIG, saveConfig } from "../config.js";
import { cassAvailable, cassStats, cassSearch, safeCassSearch } from "../cass.js";
import { fileExists, resolveRepoDir, resolveGlobalDir, expandPath, checkAbort } from "../utils.js";
import { isLLMAvailable, getAvailableProviders, validateApiKey } from "../llm.js";
import { SECRET_PATTERNS, compileExtraPatterns } from "../sanitize.js";
import { loadPlaybook, savePlaybook } from "../playbook.js";
import { Config, Playbook } from "../types.js";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import readline from "node:readline";

type CheckStatus = "pass" | "warn" | "fail";
type OverallStatus = "healthy" | "degraded" | "unhealthy";
type PatternMatch = { pattern: string; sample: string; replacement: string; suggestion?: string };

/**
 * Represents an issue that can be automatically fixed.
 */
export interface FixableIssue {
  /** Unique identifier for the issue */
  id: string;
  /** Human-readable description of the issue */
  description: string;
  /** Category of the issue (e.g., "storage", "config") */
  category: string;
  /** Severity: warn = degraded but functional, fail = blocking */
  severity: "warn" | "fail";
  /** Function to apply the fix */
  fix: () => Promise<void>;
  /** Safety level for auto-apply decisions */
  safety: "safe" | "cautious" | "manual";
}

/**
 * Result of applying fixes.
 */
export interface FixResult {
  id: string;
  success: boolean;
  message: string;
}

/**
 * Options for applyFixes function.
 */
export interface ApplyFixesOptions {
  /** If true, prompt user for confirmation */
  interactive?: boolean;
  /** If true, only show what would be fixed without applying */
  dryRun?: boolean;
  /** If true, apply even cautious fixes without prompting */
  force?: boolean;
}

export interface HealthCheck {
  category: string;
  item: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
}

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

/**
 * Run end-to-end smoke tests of core functionality.
 * Returns an array of HealthCheck results for integration into doctor command.
 */
export async function runSelfTest(config: Config): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  // 1. PLAYBOOK LOAD PERFORMANCE
  const playbookPath = expandPath(config.playbookPath);
  try {
    const start = Date.now();
    const playbook = await loadPlaybook(playbookPath);
    const loadTime = Date.now() - start;
    const bulletCount = playbook.bullets?.length ?? 0;

    if (loadTime > 500) {
      checks.push({
        category: "Self-Test",
        item: "Playbook Load",
        status: "warn",
        message: `Slow: ${loadTime}ms (consider optimization)`,
        details: { loadTime, bulletCount, path: playbookPath },
      });
    } else {
      checks.push({
        category: "Self-Test",
        item: "Playbook Load",
        status: "pass",
        message: `${loadTime}ms (${bulletCount} bullets)`,
        details: { loadTime, bulletCount, path: playbookPath },
      });
    }
  } catch (err: any) {
    checks.push({
      category: "Self-Test",
      item: "Playbook Load",
      status: "fail",
      message: `Failed: ${err.message}`,
      details: { error: err.message, path: playbookPath },
    });
  }

  // 2. CASS SEARCH LATENCY
  const cassOk = cassAvailable(config.cassPath);
  if (cassOk) {
    const start = Date.now();
    try {
      // Use safeCassSearch which handles errors gracefully
      const results = await safeCassSearch("self test query", { limit: 5 }, config.cassPath);
      const searchTime = Date.now() - start;

      if (searchTime > 5000) {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "fail",
          message: `Very slow: ${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      } else if (searchTime > 2000) {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "warn",
          message: `Slow: ${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      } else {
        checks.push({
          category: "Self-Test",
          item: "Cass Search",
          status: "pass",
          message: `${searchTime}ms`,
          details: { searchTime, resultCount: results.length },
        });
      }
    } catch (err: any) {
      checks.push({
        category: "Self-Test",
        item: "Cass Search",
        status: "fail",
        message: `Search failed: ${err.message}`,
        details: { error: err.message },
      });
    }
  } else {
    checks.push({
      category: "Self-Test",
      item: "Cass Search",
      status: "warn",
      message: "Skipped (cass not available)",
      details: { cassPath: config.cassPath },
    });
  }

  // 3. SANITIZATION PATTERN BREADTH
  const patternCount = SECRET_PATTERNS.length;
  const extraPatterns = config.sanitization?.extraPatterns || [];
  const compiledExtra = compileExtraPatterns(extraPatterns);
  const totalPatterns = patternCount + compiledExtra.length;

  if (!config.sanitization?.enabled) {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "warn",
      message: "Disabled",
      details: { enabled: false },
    });
  } else if (totalPatterns < 10) {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "warn",
      message: `Only ${totalPatterns} patterns (recommend ≥10)`,
      details: { builtIn: patternCount, custom: compiledExtra.length },
    });
  } else {
    checks.push({
      category: "Self-Test",
      item: "Sanitization",
      status: "pass",
      message: `${totalPatterns} patterns loaded`,
      details: { builtIn: patternCount, custom: compiledExtra.length },
    });
  }

  // 4. CONFIG VALIDATION
  const configIssues: string[] = [];

  // Check for deprecated options
  const deprecated = ["maxContextBullets", "enableEmbeddings"];
  for (const opt of deprecated) {
    if ((config as any)[opt] !== undefined) {
      configIssues.push(`Deprecated option: ${opt}`);
    }
  }

  // Check paths are absolute or use tilde expansion
  const pathFields = ["playbookPath", "diaryDir", "cassPath"];
  for (const field of pathFields) {
    const value = (config as any)[field];
    if (value && typeof value === "string") {
      if (!value.startsWith("/") && !value.startsWith("~") && value !== "cass") {
        configIssues.push(`${field} should be absolute path`);
      }
    }
  }

  // Validate threshold values
  if (config.dedupSimilarityThreshold < 0 || config.dedupSimilarityThreshold > 1) {
    configIssues.push("dedupSimilarityThreshold should be 0-1");
  }
  if (config.pruneHarmfulThreshold < 0) {
    configIssues.push("pruneHarmfulThreshold should be non-negative");
  }

  if (configIssues.length > 0) {
    checks.push({
      category: "Self-Test",
      item: "Config Validation",
      status: "warn",
      message: `${configIssues.length} issue(s) found`,
      details: { issues: configIssues },
    });
  } else {
    checks.push({
      category: "Self-Test",
      item: "Config Validation",
      status: "pass",
      message: "Config valid",
      details: { schemaVersion: config.schema_version },
    });
  }

  // 5. LLM/EMBEDDING SYSTEM
  const availableProviders = getAvailableProviders();
  const currentProvider = config.provider;
  const hasCurrentProvider = availableProviders.includes(currentProvider);

  if (availableProviders.length === 0) {
    checks.push({
      category: "Self-Test",
      item: "LLM System",
      status: "fail",
      message: "No API keys configured",
      details: { availableProviders: [], currentProvider },
    });
  } else if (!hasCurrentProvider) {
    checks.push({
      category: "Self-Test",
      item: "LLM System",
      status: "warn",
      message: `Current provider (${currentProvider}) not available, have: ${availableProviders.join(", ")}`,
      details: { availableProviders, currentProvider },
    });
  } else {
    // Check for API key validity (format check, not actual API call)
    try {
      validateApiKey(currentProvider);
      checks.push({
        category: "Self-Test",
        item: "LLM System",
        status: "pass",
        message: `${currentProvider} (${config.model})`,
        details: {
          availableProviders,
          currentProvider,
          model: config.model,
          semanticSearchEnabled: config.semanticSearchEnabled
        },
      });
    } catch (err: any) {
      checks.push({
        category: "Self-Test",
        item: "LLM System",
        status: "warn",
        message: `${currentProvider}: ${err.message}`,
        details: { availableProviders, currentProvider, error: err.message },
      });
    }
  }

  return checks;
}

// --- Fix Detection and Application ---

/**
 * Prompt user for yes/no confirmation.
 */
async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Create fix for missing global directory.
 */
function createMissingGlobalDirFix(globalDir: string): FixableIssue {
  return {
    id: "missing-global-dir",
    description: `Create missing global directory: ${globalDir}`,
    category: "storage",
    severity: "fail",
    safety: "safe",
    fix: async () => {
      await fs.mkdir(globalDir, { recursive: true, mode: 0o700 });
    },
  };
}

/**
 * Create fix for missing global playbook.
 */
function createMissingPlaybookFix(playbookPath: string): FixableIssue {
  return {
    id: "missing-playbook",
    description: `Create empty playbook: ${playbookPath}`,
    category: "storage",
    severity: "warn",
    safety: "safe",
    fix: async () => {
      const emptyPlaybook: Playbook = {
        bullets: [],
        schema_version: 1,
      };
      await savePlaybook(playbookPath, emptyPlaybook);
    },
  };
}

/**
 * Create fix for missing diary directory.
 */
function createMissingDiaryDirFix(diaryDir: string): FixableIssue {
  return {
    id: "missing-diary-dir",
    description: `Create diary directory: ${diaryDir}`,
    category: "storage",
    severity: "warn",
    safety: "safe",
    fix: async () => {
      await fs.mkdir(diaryDir, { recursive: true, mode: 0o700 });
    },
  };
}

/**
 * Create fix for missing repo .cass directory.
 */
function createMissingRepoCassDirFix(cassDir: string): FixableIssue {
  return {
    id: "missing-repo-cass-dir",
    description: `Create repo .cass directory: ${cassDir}`,
    category: "storage",
    severity: "warn",
    safety: "safe",
    fix: async () => {
      await fs.mkdir(cassDir, { recursive: true });
      // Create .gitignore to ignore diary but track playbook
      const gitignore = `# Ignore diary (session-specific data)
diary/
# Ignore temporary files
*.tmp
`;
      await fs.writeFile(path.join(cassDir, ".gitignore"), gitignore);
    },
  };
}

/**
 * Create fix for invalid config - reset to defaults.
 */
function createResetConfigFix(configPath: string): FixableIssue {
  return {
    id: "reset-config",
    description: `Reset config to defaults (backup will be created): ${configPath}`,
    category: "config",
    severity: "fail",
    safety: "cautious",
    fix: async () => {
      // Create backup
      const exists = await fileExists(configPath);
      if (exists) {
        const backupPath = `${configPath}.backup.${Date.now()}`;
        await fs.copyFile(expandPath(configPath), backupPath);
        console.log(chalk.yellow(`  Backed up old config to: ${backupPath}`));
      }
      // Save default config
      await saveConfig(configPath, DEFAULT_CONFIG);
    },
  };
}

/**
 * Create fix for missing repo toxic.log file.
 */
function createMissingToxicLogFix(toxicPath: string): FixableIssue {
  return {
    id: "missing-toxic-log",
    description: `Create empty toxic.log: ${toxicPath}`,
    category: "storage",
    severity: "warn",
    safety: "safe",
    fix: async () => {
      await fs.writeFile(toxicPath, "");
    },
  };
}

/**
 * Detect fixable issues from health checks.
 */
export async function detectFixableIssues(): Promise<FixableIssue[]> {
  const issues: FixableIssue[] = [];
  const config = await loadConfig();

  // Check global directory
  const globalDir = resolveGlobalDir();
  const globalDirExists = await fileExists(globalDir);
  if (!globalDirExists) {
    issues.push(createMissingGlobalDirFix(globalDir));
  }

  // Check global playbook
  const globalPlaybookPath = path.join(globalDir, "playbook.yaml");
  const globalPlaybookExists = await fileExists(globalPlaybookPath);
  if (globalDirExists && !globalPlaybookExists) {
    issues.push(createMissingPlaybookFix(globalPlaybookPath));
  }

  // Check global diary directory
  const globalDiaryDir = path.join(globalDir, "diary");
  const globalDiaryExists = await fileExists(globalDiaryDir);
  if (globalDirExists && !globalDiaryExists) {
    issues.push(createMissingDiaryDirFix(globalDiaryDir));
  }

  // Check repo-level .cass structure
  const cassDir = await resolveRepoDir();
  if (cassDir) {
    const repoCassDirExists = await fileExists(cassDir);
    if (!repoCassDirExists) {
      issues.push(createMissingRepoCassDirFix(cassDir));
    } else {
      // Check for repo playbook
      const repoPlaybookPath = path.join(cassDir, "playbook.yaml");
      const repoPlaybookExists = await fileExists(repoPlaybookPath);
      if (!repoPlaybookExists) {
        issues.push(createMissingPlaybookFix(repoPlaybookPath));
      }

      // Check for toxic.log
      const toxicPath = path.join(cassDir, "toxic.log");
      const toxicExists = await fileExists(toxicPath);
      if (!toxicExists) {
        issues.push(createMissingToxicLogFix(toxicPath));
      }
    }
  }

  return issues;
}

/**
 * Apply fixes to detected issues.
 *
 * @param issues - Array of fixable issues to apply
 * @param options - Options controlling fix behavior
 * @returns Array of fix results
 *
 * @example
 * const issues = await detectFixableIssues();
 * const results = await applyFixes(issues, { interactive: true });
 */
export async function applyFixes(
  issues: FixableIssue[],
  options: ApplyFixesOptions = {}
): Promise<FixResult[]> {
  const { interactive = false, dryRun = false, force = false } = options;
  const results: FixResult[] = [];

  if (issues.length === 0) {
    console.log(chalk.green("No fixable issues found."));
    return results;
  }

  // Group by safety level
  const safeIssues = issues.filter((i) => i.safety === "safe");
  const cautiousIssues = issues.filter((i) => i.safety === "cautious");
  const manualIssues = issues.filter((i) => i.safety === "manual");

  console.log(chalk.bold(`\nFound ${issues.length} fixable issue(s):\n`));

  // List all issues
  issues.forEach((issue, i) => {
    const safetyIcon =
      issue.safety === "safe" ? "✅" : issue.safety === "cautious" ? "⚠️ " : "📝";
    const severityColor = issue.severity === "fail" ? chalk.red : chalk.yellow;
    console.log(
      `${i + 1}. ${safetyIcon} ${severityColor(`[${issue.severity}]`)} ${issue.description}`
    );
  });

  if (manualIssues.length > 0) {
    console.log(chalk.cyan("\n📝 Manual fixes required (not auto-fixable):"));
    for (const issue of manualIssues) {
      console.log(chalk.cyan(`   - ${issue.description}`));
    }
  }

  if (dryRun) {
    console.log(chalk.yellow("\n[Dry run] No changes will be made."));
    return issues.map((i) => ({
      id: i.id,
      success: false,
      message: "Dry run - not applied",
    }));
  }

  // Determine which issues to fix
  const toFix: FixableIssue[] = [];

  // Safe issues: apply unless interactive mode asks not to
  if (safeIssues.length > 0) {
    if (interactive) {
      console.log(chalk.green(`\n✅ ${safeIssues.length} safe fix(es) available`));
      const confirm = await promptConfirm("Apply safe fixes?");
      if (confirm) {
        toFix.push(...safeIssues);
      }
    } else {
      toFix.push(...safeIssues);
    }
  }

  // Cautious issues: require confirmation unless --force
  if (cautiousIssues.length > 0) {
    console.log(
      chalk.yellow(`\n⚠️  ${cautiousIssues.length} cautious fix(es) available (may modify data)`)
    );
    if (force) {
      toFix.push(...cautiousIssues);
    } else if (interactive) {
      const confirm = await promptConfirm("Apply cautious fixes?");
      if (confirm) {
        toFix.push(...cautiousIssues);
      }
    } else {
      console.log(chalk.yellow("   Use --fix --force to apply cautious fixes non-interactively"));
    }
  }

  if (toFix.length === 0) {
    console.log(chalk.yellow("\nNo fixes will be applied."));
    return results;
  }

  console.log(chalk.bold(`\nApplying ${toFix.length} fix(es)...\n`));

  // Apply fixes
  for (const issue of toFix) {
    // Check for abort between fixes
    try {
      checkAbort();
    } catch {
      console.log(chalk.yellow("\nOperation cancelled."));
      break;
    }

    try {
      console.log(`Fixing: ${issue.description}...`);
      await issue.fix();
      results.push({
        id: issue.id,
        success: true,
        message: "Fixed successfully",
      });
      console.log(chalk.green("  ✓ Fixed"));
    } catch (err: any) {
      results.push({
        id: issue.id,
        success: false,
        message: err.message,
      });
      console.log(chalk.red(`  ✗ Failed: ${err.message}`));
    }
  }

  // Summary
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(chalk.bold("\n--- Fix Summary ---"));
  console.log(chalk.green(`✓ ${succeeded} fix(es) applied successfully`));
  if (failed > 0) {
    console.log(chalk.red(`✗ ${failed} fix(es) failed`));
  }

  return results;
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

  // 2) Global Storage
  const globalDir = resolveGlobalDir();
  const globalPlaybookExists = await fileExists(path.join(globalDir, "playbook.yaml"));
  const globalConfigExists = await fileExists(path.join(globalDir, "config.json"));
  const globalDiaryExists = await fileExists(path.join(globalDir, "diary"));
  
  const missingGlobal: string[] = [];
  if (!globalPlaybookExists) missingGlobal.push("playbook.yaml");
  if (!globalConfigExists) missingGlobal.push("config.json");
  if (!globalDiaryExists) missingGlobal.push("diary/");

  checks.push({
    category: "Global Storage (~/.cass-memory)",
    status: missingGlobal.length === 0 ? "pass" : "warn",
    message: missingGlobal.length === 0 
      ? "All global files found" 
      : `Missing: ${missingGlobal.join(", ")}`,
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

  // Handle --fix option
  if (options.fix && overallStatus !== "healthy") {
    console.log(chalk.bold("\n🔧 Auto-Fix Mode\n"));
    const issues = await detectFixableIssues();
    if (issues.length > 0) {
      await applyFixes(issues, { interactive: true });
      console.log(chalk.cyan("\nRe-running health check to verify fixes...\n"));
      // Run doctor again to show updated status (non-recursive)
      await doctorCommand({ json: false, fix: false });
    } else {
      console.log(chalk.yellow("No auto-fixable issues detected."));
      console.log(chalk.cyan("Some issues may require manual intervention."));
    }
  } else if (options.fix && overallStatus === "healthy") {
    console.log(chalk.green("\nSystem is healthy, no fixes needed."));
  }
}