import { 
  Config, 
  PlaybookDelta, 
  EvidenceGateResult, 
  ValidationResult,
  ValidationEvidence
} from "./types.js";
import { runValidator } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { extractKeywords, log } from "./utils.js";

// --- Pre-LLM Gate ---

export async function evidenceCountGate(
  content: string,
  config: Config
): Promise<EvidenceGateResult> {
  const keywords = extractKeywords(content);
  const hits = await safeCassSearch(keywords.join(" "), {
    limit: 20,
    days: config.validationLookbackDays
  }, config.cassPath);

  let successCount = 0;
  let failureCount = 0;
  const sessions = new Set<string>();

  for (const hit of hits) {
    if (!hit.source_path) continue; 
    sessions.add(hit.source_path);
    
    const lower = hit.snippet.toLowerCase();
    if (lower.includes("fixed") || lower.includes("success") || lower.includes("solved")) {
      successCount++;
    } else if (lower.includes("failed") || lower.includes("error") || lower.includes("broken")) {
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
): Promise<{ valid: boolean; result?: ValidationResult; gate?: EvidenceGateResult }> {
  
  if (delta.type !== "add") return { valid: true };
  
  if (!config.validationEnabled) return { valid: true };

  const content = delta.bullet.content || "";
  if (content.length < 20) return { valid: true }; 

  // 1. Run Gate
  const gate = await evidenceCountGate(content, config);
  
  if (!gate.passed) {
    log(`Rule rejected by evidence gate: ${gate.reason}`);
    return { valid: false, gate };
  }

  if (gate.suggestedState === "active") {
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
      }
    };
  }

  // 2. Run LLM
  const keywords = extractKeywords(content);
  const evidenceHits = await safeCassSearch(keywords.join(" "), { limit: 10 }, config.cassPath);
  const formattedEvidence = formatEvidence(evidenceHits);

  const llmResult = await runValidator(content, formattedEvidence, config);

  // Convert evidence to ValidationEvidence format with confidence field
  const evidence: ValidationEvidence[] = llmResult.evidence.map(e => ({
    sessionPath: e.sessionPath,
    snippet: e.snippet,
    supports: e.supports,
    confidence: 1.0
  }));

  const supportingEvidence = evidence.filter(e => e.supports);
  const contradictingEvidence = evidence.filter(e => !e.supports);

  const validationResult: ValidationResult = {
    valid: llmResult.valid,
    verdict: llmResult.verdict,
    confidence: llmResult.confidence,
    reason: llmResult.reason,
    evidence,
    refinedRule: llmResult.suggestedRefinement,
    approved: llmResult.valid,
    supportingEvidence,
    contradictingEvidence
  };

  return {
    valid: validationResult.valid,
    result: validationResult,
    gate
  };
}