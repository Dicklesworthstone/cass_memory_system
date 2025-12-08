import { Config, Playbook, PlaybookBullet, AuditViolation } from "./types.js";
import { cassExport } from "./cass.js";
import { PROMPTS, llmWithFallback } from "./llm.js"; 
import { z } from "zod";
import { log, warn } from "./utils.js";

export async function scanSessionsForViolations(
  sessions: string[],
  playbook: Playbook,
  config: Config
): Promise<AuditViolation[]> {
  const violations: AuditViolation[] = [];
  const activeBullets = playbook.bullets.filter(b => !b.deprecated && b.state !== "retired");
  
  const CONCURRENCY = 3;
  const AuditOutputSchema = z.object({
    results: z.array(z.object({
      ruleId: z.string(),
      status: z.enum(["followed", "violated", "not_applicable"]),
      evidence: z.string()
    }))
  });

  // Simple concurrency batching
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const chunk = sessions.slice(i, i + CONCURRENCY);
    
    await Promise.all(chunk.map(async (sessionPath) => {
      try {
        // Pass config to ensure sanitization overrides are respected
        const content = await cassExport(sessionPath, "text", config.cassPath, config);
        if (!content) return;

        const rulesList = activeBullets.map(b => `- [${b.id}] ${b.content}`).join("\n");
        const safeContent = content.slice(0, 20000);

        const prompt = PROMPTS.audit
          .replace("{sessionContent}", safeContent)
          .replace("{rulesToCheck}", rulesList);

        // Use fallback for resilience
        const result = await llmWithFallback(
          AuditOutputSchema,
          prompt,
          config,
          "audit"
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