import {
  Config,
  PlaybookDelta,
  EvidenceGateResult,
  ValidationResult,
  ValidationEvidence,
  DecisionLogEntry
} from "./types.js";
import { runValidator, ValidatorResult } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { extractKeywords, log, now } from "./utils.js";

// --- Verdict Normalization ---

/**
 * Normalize LLM validator result to our internal verdict types.
 * Maps REFINE to ACCEPT_WITH_CAUTION with reduced confidence.
 */
export function normalizeValidatorVerdict(result: ValidatorResult): ValidatorResult {
  if (result.verdict === "REFINE") {
    return {
      ...result,
      verdict: "ACCEPT_WITH_CAUTION",
      valid: true,
      confidence: result.confidence * 0.8 // Reduce confidence for refined rules
    };
  }
  return result;
}

// --- Pre-LLM Gate ---

// Word boundary patterns to avoid false positives like "fixed-width" or "error handling worked"
// These patterns match the words as standalone or at phrase boundaries
const SUCCESS_PATTERNS = [
  /\bfixed\s+(the|a|an|this|that|it)\b/i,        // "fixed the bug" but not "fixed-width"
  /\bsuccessfully\b/i,                            // "successfully deployed"
  /\bsuccess\b(?!ful)/i,                          // "success" but not "successful" (needs context)
  /\bsolved\s+(the|a|an|this|that|it)\b/i,       // "solved the issue"
  /\bworking\s+now\b/i,                           // "working now"
  /\bworks\s+(now|correctly|properly)\b/i,       // "works correctly"
  /\bresolved\b/i,                                // "resolved"
];

const FAILURE_PATTERNS = [
  /\bfailed\s+(to|with)\b/i,                      // "failed to compile" but not "failed CI" (could be action)
  /\berror:/i,                                    // "error:" prefix common in logs
  /\b(threw|throws)\s+.*error\b/i,               // "threw an error"
  /\bbroken\b/i,                                  // "broken"
  /\bcrash(ed|es|ing)?\b/i,                       // "crashed", "crashes"
  /\bbug\s+(in|found|caused)\b/i,                // "bug in", "bug found"
  /\bdoesn't\s+work\b/i,                          // "doesn't work"
];

function matchesPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

export async function evidenceCountGate(
  content: string,
  config: Config
): Promise<EvidenceGateResult> {
  const keywords = extractKeywords(content);
  const hits = await safeCassSearch(keywords.join(" "), {
    limit: 20,
    days: config.validationLookbackDays
  }, config.cassPath, config);

  let successCount = 0;
  let failureCount = 0;
  const sessions = new Set<string>();

  for (const hit of hits) {
    if (!hit.source_path) continue;
    sessions.add(hit.source_path);

    const snippet = hit.snippet;
    // Use word-boundary aware patterns to reduce false positives
    if (matchesPatterns(snippet, SUCCESS_PATTERNS)) {
      successCount++;
    } else if (matchesPatterns(snippet, FAILURE_PATTERNS)) {
      failureCount++;
    }
  }

  const sessionCount = sessions.size;

  if (sessionCount === 0) {
    return {
      passed: true,
      reason: "No historical evidence found. Proposing as draft.",
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  if (successCount >= 5 && failureCount === 0) {
    return {
      passed: true,
      reason: `Strong success signal (${successCount} successes). Auto-accepting.`, 
      suggestedState: "active",
      sessionCount, successCount, failureCount
    };
  }

  if (failureCount >= 3 && successCount === 0) {
    return {
      passed: false,
      reason: `Strong failure signal (${failureCount} failures). Auto-rejecting.`, 
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  return {
    passed: true,
    reason: "Evidence found but ambiguous. Proceeding to LLM validation.",
    suggestedState: "draft",
    sessionCount, successCount, failureCount
  };
}

// --- Format Evidence for LLM ---

function formatEvidence(hits: any[]): string {
  return hits.map((h: any) => `
Session: ${h.source_path}
Snippet: "${h.snippet}"
Relevance: ${h.score}
`).join("\n---\n");
}

// --- Main Validator ---

export async function validateDelta(
  delta: PlaybookDelta,
  config: Config
): Promise<{ valid: boolean; result?: ValidationResult; gate?: EvidenceGateResult; decisionLog?: DecisionLogEntry[] }> {
  const decisionLog: DecisionLogEntry[] = [];

  if (delta.type !== "add") {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "skipped",
      reason: `Non-add delta type: ${delta.type}`,
      content: undefined
    });
    return { valid: true, decisionLog };
  }

  if (!config.validationEnabled) {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "skipped",
      reason: "Validation disabled in config",
      content: delta.bullet.content?.slice(0, 100)
    });
    return { valid: true, decisionLog };
  }

  const content = delta.bullet.content || "";
  if (content.length < 15) {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "skipped",
      reason: `Content too short (${content.length} chars < 15)`,
      content: content.slice(0, 100)
    });
    return { valid: true, decisionLog };
  }

  // 1. Run Gate
  const gate = await evidenceCountGate(content, config);

  if (!gate.passed) {
    log(`Rule rejected by evidence gate: ${gate.reason}`);
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "rejected",
      reason: gate.reason,
      content: content.slice(0, 100),
      details: { sessionCount: gate.sessionCount, successCount: gate.successCount, failureCount: gate.failureCount }
    });
    return { valid: false, gate, decisionLog };
  }

  if (gate.suggestedState === "active") {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "accepted",
      reason: `Auto-accepted by evidence gate: ${gate.reason}`,
      content: content.slice(0, 100),
      details: { sessionCount: gate.sessionCount, successCount: gate.successCount, failureCount: gate.failureCount }
    });
    return {
      valid: true,
      gate,
      result: {
        valid: true,
        verdict: "ACCEPT",
        confidence: 1.0,
        reason: gate.reason,
        evidence: [],
        approved: true,
        supportingEvidence: [],
        contradictingEvidence: []
      },
      decisionLog
    };
  }

  // Optimize: If gate suggests "draft" due to lack of evidence (0 sessions),
  // skip LLM validation (which would likely reject due to lack of evidence)
  // and accept as draft immediately.
  if (gate.suggestedState === "draft" && gate.sessionCount === 0) {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "accepted",
      reason: `Accepted as draft (new pattern/no history): ${gate.reason}`,
      content: content.slice(0, 100)
    });
    return {
        valid: true,
        gate,
        decisionLog
    };
  }

  // 2. Run LLM
  const keywords = extractKeywords(content);
  const evidenceHits = await safeCassSearch(keywords.join(" "), { limit: 10 }, config.cassPath, config);
  const formattedEvidence = formatEvidence(evidenceHits);

  const rawResult = await runValidator(content, formattedEvidence, config);
  const result = normalizeValidatorVerdict(rawResult);

  let finalVerdict = result.verdict as "ACCEPT" | "REJECT" | "ACCEPT_WITH_CAUTION" | "REFINE";

  // Map object array to string array for 'evidence' field (legacy/schema compatibility)
  const evidenceStrings = result.evidence.map(e => e.snippet);

  // Map object array to ValidationEvidence[] for supporting/contradicting
  const supporting = result.evidence.filter(e => e.supports).map(e => ({
    sessionPath: e.sessionPath,
    snippet: e.snippet,
    supports: true,
    confidence: 1.0 // Default confidence
  }));

  const contradicting = result.evidence.filter(e => !e.supports).map(e => ({
    sessionPath: e.sessionPath,
    snippet: e.snippet,
    supports: false,
    confidence: 1.0
  }));

  // Log LLM validation decision
  decisionLog.push({
    timestamp: now(),
    phase: "add",
    action: result.valid ? "accepted" : "rejected",
    reason: `LLM validation: ${finalVerdict} - ${result.reason}`,
    content: content.slice(0, 100),
    details: {
      verdict: finalVerdict,
      confidence: result.confidence,
      supportingCount: supporting.length,
      contradictingCount: contradicting.length
    }
  });

  return {
    valid: result.valid,
    result: {
      ...result, // Spread raw props
      verdict: finalVerdict, // Override verdict if normalized
      evidence: evidenceStrings, // Override evidence with string[]
      refinedRule: result.suggestedRefinement, // Map suggestedRefinement -> refinedRule
      approved: result.valid,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting
    },
    gate,
    decisionLog
  };
}
