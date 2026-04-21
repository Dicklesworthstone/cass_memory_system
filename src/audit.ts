import { Config, Playbook, AuditViolation } from "./types.js";
import { cassExport, type CassRunner } from "./cass.js";
import { PROMPTS, llmWithFallback, fillPrompt, type LLMIO } from "./llm.js";
import { z } from "zod";
import { warn, truncateForContext } from "./utils.js";
import { getActiveBullets } from "./playbook.js";

export async function scanSessionsForViolations(
  sessions: string[],
  playbook: Playbook,
  config: Config,
  io?: LLMIO,
  cassRunner?: CassRunner
): Promise<AuditViolation[]> {
  const violations: AuditViolation[] = [];
  // Use getActiveBullets for consistent filtering (includes maturity !== "deprecated")
  const activeBullets = getActiveBullets(playbook);
  
  const CONCURRENCY = 3;
  // OpenAI strict-mode schema requirements (issue #44):
  //   - every property must appear in the `required` array
  //   - optional fields must use a null union (`.nullable()`, not `.optional()`)
  //   - every object must set `additionalProperties: false` (via `.strict()`)
  // Violating any of these yields HTTP 400 on OpenAI-compatible gateways that
  // enforce the documented strict semantics.
  const AuditOutputSchema = z.object({
    results: z.array(z.object({
      ruleId: z.string(),
      status: z.enum(["followed", "violated", "not_applicable"]).nullable(),
      evidence: z.string()
    }).strict()),
    summary: z.string().nullable()
  }).strict();

  // Warn if rule count is high
  if (activeBullets.length > 100) {
    warn(`Audit running with ${activeBullets.length} rules. This may exceed context limits or degrade performance.`);
  }

  // Pre-generate rules list string once (optimization)
  const rulesList = activeBullets.map(b => `- [${b.id}] ${b.content}`).join("\n");

  // Simple concurrency batching
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const chunk = sessions.slice(i, i + CONCURRENCY);
    
    await Promise.all(chunk.map(async (sessionPath) => {
      try {
        // Pass config to ensure sanitization overrides are respected
        const content = cassRunner
          ? await cassExport(sessionPath, "text", config.cassPath, config, cassRunner)
          : await cassExport(sessionPath, "text", config.cassPath, config);
        if (!content) return;

        // Truncate session content to ensure rules fit
        // Reserve 10k chars for rules + overhead if possible
        const maxContentChars = Math.max(5000, 30000 - rulesList.length);
        const safeContent = truncateForContext(content, { maxChars: maxContentChars });

        const prompt = fillPrompt(PROMPTS.audit, {
          sessionContent: safeContent,
          rulesToCheck: rulesList
        });

        // Use fallback for resilience
        const result = await llmWithFallback(
          AuditOutputSchema,
          prompt,
          config,
          io
        );

        for (const res of result.results) {
          if (res.status === "violated") {
            const bullet = activeBullets.find(b => b.id === res.ruleId);
            if (bullet) {
              violations.push({
                bulletId: bullet.id,
                bulletContent: bullet.content,
                sessionPath,
                evidence: res.evidence,
                severity: bullet.maturity === "proven" ? "high" : "medium",
                timestamp: new Date().toISOString()
              });
            }
          }
        }

      } catch (e: any) {
        warn(`Audit failed for ${sessionPath}: ${e.message}`);
      }
    }));
  }

  return violations;
}
