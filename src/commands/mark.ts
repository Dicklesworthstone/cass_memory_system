import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet } from "../playbook.js";
import { getEffectiveScore, calculateMaturityState } from "../scoring.js";
import { now, expandPath, resolveRepoDir, fileExists, printJsonResult, reportError } from "../utils.js";
import { HarmfulReason, HarmfulReasonEnum, FeedbackEvent, ErrorCode } from "../types.js";
import { withLock } from "../lock.js";
import chalk from "chalk";
import { icon } from "../output.js";
import path from "node:path";

type MarkFlags = { helpful?: boolean; harmful?: boolean; reason?: string; session?: string; json?: boolean };

/**
 * API-friendly feedback recorder (no console output, throws on error).
 */
export async function recordFeedback(
  bulletId: string,
  flags: MarkFlags
): Promise<{ type: "helpful" | "harmful"; score: number; state: string }> {
  if (!flags.helpful && !flags.harmful) {
    throw new Error("Must specify --helpful or --harmful");
  }

  const config = await loadConfig();

  const globalPath = expandPath(config.playbookPath);
  
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  const repoPlaybookExists = repoPath ? await fileExists(repoPath) : false;

  const type: "helpful" | "harmful" = flags.helpful ? "helpful" : "harmful";

  const tryRecordInPlaybook = async (
    saveTarget: string
  ): Promise<{ found: boolean; score?: number; state?: string }> => {
    return await withLock(saveTarget, async () => {
      const targetPlaybook = await loadPlaybook(saveTarget);

      const targetBullet = findBullet(targetPlaybook, bulletId);
      if (!targetBullet) return { found: false };

      let reason: HarmfulReason | undefined = undefined;
      let context: string | undefined = undefined;
      const rawReason = typeof flags.reason === "string" ? flags.reason.trim() : "";
      
      if (type === "harmful") {
        if (rawReason) {
          const parsed = HarmfulReasonEnum.safeParse(rawReason.toLowerCase());
          if (parsed.success) {
            reason = parsed.data;
          } else {
            reason = "other";
            context = rawReason;
          }
        } else {
          reason = "other";
        }
      } else if (rawReason) {
        // Optional free-text context even for helpful feedback.
        context = rawReason;
      }

      const event: FeedbackEvent = { 
        type, 
        timestamp: now(), 
        sessionPath: flags.session, 
        reason,
        ...(context ? { context } : {})
      };

      targetBullet.feedbackEvents = targetBullet.feedbackEvents || [];
      targetBullet.feedbackEvents.push(event);

      // Keep legacy counters in sync for backwards compatibility
      if (type === "helpful") {
        targetBullet.helpfulCount = (targetBullet.helpfulCount || 0) + 1;
      } else {
        targetBullet.harmfulCount = (targetBullet.harmfulCount || 0) + 1;
      }

      targetBullet.updatedAt = now();
      const newMaturity = calculateMaturityState(targetBullet, config);
      targetBullet.maturity = newMaturity;

      if (newMaturity === "deprecated" && !targetBullet.deprecated) {
          targetBullet.deprecated = true;
          targetBullet.deprecatedAt = now();
          targetBullet.state = "retired";
          targetBullet.deprecationReason = targetBullet.deprecationReason || "Automatically deprecated due to harmful feedback ratio";
      }

      await savePlaybook(targetPlaybook, saveTarget);
      
      const score = getEffectiveScore(targetBullet, config);
      const state = targetBullet.maturity;
      return { found: true, score, state };
    });
  };

  if (repoPath && repoPlaybookExists) {
    const repoResult = await tryRecordInPlaybook(repoPath);
    if (repoResult.found) {
      return { type, score: repoResult.score!, state: repoResult.state! };
    }
  }

  const globalResult = await tryRecordInPlaybook(globalPath);
  if (globalResult.found) {
    return { type, score: globalResult.score!, state: globalResult.state! };
  }

  const locations = repoPath && repoPlaybookExists ? `${repoPath} or ${globalPath}` : globalPath;
  throw new Error(`Bullet ${bulletId} not found in ${locations}.`);
}

export async function markCommand(
  bulletId: string,
  flags: MarkFlags
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "mark";
  try {
    const result = await recordFeedback(bulletId, flags);

    if (flags.json) {
      printJsonResult(
        command,
        {
          bulletId,
          type: result.type,
          newState: result.state,
          effectiveScore: result.score,
        },
        { startedAtMs }
      );
    } else {
      console.log(chalk.green(`${icon("success")} Marked bullet ${bulletId} as ${result.type}`));
      console.log(`  New State: ${result.state}`);
      console.log(`  Effective Score: ${result.score.toFixed(2)}`);
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    const code = message.includes("not found")
      ? ErrorCode.BULLET_NOT_FOUND
      : message.includes("Must specify")
        ? ErrorCode.MISSING_REQUIRED
        : ErrorCode.VALIDATION_FAILED;
    reportError(err instanceof Error ? err : message, { code, details: { bulletId }, json: flags.json, command, startedAtMs });
  }
}
