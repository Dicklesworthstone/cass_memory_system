import chalk from "chalk";
import { loadConfig } from "../config.js";
import { evidenceCountGate } from "../validate.js";
import { safeCassSearch, type CassRunner } from "../cass.js";
import { extractKeywords, printJsonResult } from "../utils.js";
import { runValidator, type LLMIO } from "../llm.js";

type ValidateOptions = {
  json?: boolean;
  verbose?: boolean;
};

type ValidateDeps = {
  io?: LLMIO;
  cassRunner?: CassRunner;
};

interface ValidationOutput {
  proposedRule: string;
  verdict: "ACCEPT" | "REJECT" | "ACCEPT_WITH_CAUTION";
  confidence: number;
  reason: string;
  refinedRule?: string | null;
  evidence: Array<{ session: string; snippet: string; outcome?: string }>;
}

export async function validateCommand(
  proposedRule: string,
  options: ValidateOptions = {},
  deps: ValidateDeps = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "validate";
  if (!proposedRule || proposedRule.trim().length === 0) {
    throw new Error("Proposed rule text is required");
  }

  const config = await loadConfig();

  // Step 1: evidence-count gate (cheap heuristic)
  const gate = await evidenceCountGate(proposedRule, config, deps.cassRunner);

  // Helper to format evidence for output
  const evidenceFromHits = (hits: any[]) =>
    hits.map((h) => ({
      session: h.source_path,
      snippet: h.snippet,
      outcome: classifyOutcome(h.snippet || "")
    }));

  // Strong failure -> auto reject
  if (!gate.passed && gate.failureCount !== undefined) {
    const output: ValidationOutput = {
      proposedRule,
      verdict: "REJECT",
      confidence: 0.9,
      reason: gate.reason,
      evidence: []
    };
    return printResult(output, options, { command, startedAtMs });
  }

  // Strong success -> auto accept
  if (gate.suggestedState === "active" && gate.successCount !== undefined) {
    const output: ValidationOutput = {
      proposedRule,
      verdict: "ACCEPT",
      confidence: 0.95,
      reason: gate.reason,
      evidence: []
    };
    return printResult(output, options, { command, startedAtMs });
  }

  // No evidence -> accept as draft without LLM (avoid unnecessary calls/rejections)
  if (gate.suggestedState === "draft" && gate.sessionCount === 0) {
    const output: ValidationOutput = {
      proposedRule,
      verdict: "ACCEPT_WITH_CAUTION",
      confidence: 0.6,
      reason: gate.reason,
      evidence: []
    };
    return printResult(output, options, { command, startedAtMs });
  }

  // Step 2: Ambiguous -> gather evidence and run LLM validator
  const hits = await safeCassSearch(extractKeywords(proposedRule).join(" "), {
    limit: 10,
    days: config.validationLookbackDays
  }, config.cassPath, config, deps.cassRunner);

  const formattedEvidence = hits
    .map(
      (h) =>
        `Session: ${h.source_path}\nSnippet: "${(h.snippet || "").trim()}"\nRelevance: ${h.score ?? "n/a"}`
    )
    .join("\n---\n");

  const llmResult = await runValidator(proposedRule, formattedEvidence, config, deps.io);

  const verdict =
    llmResult.verdict === "REFINE"
      ? "ACCEPT_WITH_CAUTION"
      : llmResult.verdict;

  const confidence =
    verdict === "ACCEPT_WITH_CAUTION"
      ? Math.max(0, Math.min(1, (llmResult.confidence || 0.7) * 0.8))
      : llmResult.confidence || 0.7;

  const output: ValidationOutput = {
    proposedRule,
    verdict: verdict === "REJECT" ? "REJECT" : (verdict as ValidationOutput["verdict"]),
    confidence,
    reason: llmResult.reason,
    refinedRule: llmResult.suggestedRefinement,
    evidence: evidenceFromHits(hits)
  };

  return printResult(output, options, { command, startedAtMs });
}

function classifyOutcome(snippet: string): string {
  const lower = snippet.toLowerCase();
  if (
    lower.includes("fixed") ||
    lower.includes("resolved") ||
    lower.includes("completed") ||
    lower.includes("works now") ||
    lower.includes("success")
  ) {
    return "success";
  }
  if (
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("broken") ||
    lower.includes("regression")
  ) {
    return "failure";
  }
  return "unknown";
}

function printResult(
  result: ValidationOutput,
  options: ValidateOptions,
  meta: { command: string; startedAtMs: number }
) {
  if (options.json) {
    printJsonResult(meta.command, result, { startedAtMs: meta.startedAtMs });
    return;
  }

  const verdictColor =
    result.verdict === "ACCEPT"
      ? chalk.green
      : result.verdict === "REJECT"
      ? chalk.red
      : chalk.yellow;

  console.log(chalk.bold("\nValidation Result"));
  console.log(`Rule: ${result.proposedRule}`);
  console.log(`Verdict: ${verdictColor(result.verdict)} (confidence ${result.confidence.toFixed(2)})`);
  console.log(`Reason: ${result.reason}`);

  if (result.refinedRule) {
    console.log(chalk.bold("\nRefined Rule:"));
    console.log(result.refinedRule);
  }

  if (result.evidence.length > 0) {
    console.log(chalk.bold("\nEvidence (cass):"));
    result.evidence.slice(0, 5).forEach((e) => {
      console.log(`- ${e.session}: ${e.snippet.slice(0, 140)}... (${e.outcome})`);
    });
  }
}
