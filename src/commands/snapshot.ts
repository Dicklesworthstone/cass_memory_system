/**
 * snapshot.ts — CLI command for session note generation.
 *
 * Two content generation paths:
 *   1. Agent-provided (--abstract + --content): No LLM call. The calling agent
 *      generates the note content from its context window. Primary path for
 *      cm_snapshot called from Claude Code via PreCompact hook.
 *   2. LLM-generated (default): Reads raw transcript, makes API call. Requires
 *      API key or Ollama. Used by the periodic job / manual invocation.
 */

import { loadConfig } from "../config.js";
import {
  processTranscript,
  processAllTranscripts,
  scanForModifiedTranscripts,
  findBestTranscriptForCwd,
} from "../session-notes.js";
import { log, error as logError, printJson, isJsonOutput } from "../utils.js";

export async function snapshotCommand(opts: {
  session?: string;
  abstract?: string;
  topics?: string;
  content?: string;
  maxSessions?: number;
  raw?: boolean;
  json?: boolean;
}): Promise<void> {
  const config = await loadConfig();
  const json = isJsonOutput(opts);

  // Build agentContent if the caller provided abstract + content
  const agentContent = (opts.abstract && opts.content)
    ? {
        abstract: opts.abstract,
        topics_touched: opts.topics ? opts.topics.split(",").map((t) => t.trim()) : [],
        content: opts.content,
      }
    : undefined;

  try {
    if (opts.session || agentContent) {
      // Process a specific transcript (or attach agent content to most recent)
      const scans = await scanForModifiedTranscripts(config);
      let match = opts.session
        ? scans.find(
            (s) =>
              s.transcriptPath === opts.session ||
              s.sessionId === opts.session ||
              s.transcriptPath.includes(opts.session!)
          )
        : await findBestTranscriptForCwd(scans); // Match to current project + most recent mtime

      if (!match) {
        if (json) {
          printJson({ success: true, data: { processed: 0, message: "No modified transcript found." } });
        } else {
          log("No modified transcript found.");
        }
        return;
      }

      const note = await processTranscript(match, config, { agentContent, raw: opts.raw });

      if (json) {
        printJson({
          success: true,
          data: {
            processed: 1,
            sessionId: note.frontmatter.id,
            abstract: note.frontmatter.abstract,
            topics: note.frontmatter.topics_touched,
            agentProvided: !!agentContent,
          },
        });
      } else {
        const source = agentContent ? " (agent-generated)" : "";
        log(`Session note${source}: ${note.frontmatter.id}`);
        log(`  Abstract: ${note.frontmatter.abstract}`);
        if (note.frontmatter.topics_touched.length > 0) {
          log(`  Topics: ${note.frontmatter.topics_touched.join(", ")}`);
        }
      }
    } else {
      // Process all modified transcripts (periodic job path)
      const result = await processAllTranscripts(config, {
        maxSessions: opts.maxSessions ?? 10,
        raw: opts.raw,
      });

      if (json) {
        printJson({
          success: true,
          data: {
            processed: result.processed.length,
            errors: result.errors.length,
            sessions: result.processed.map((n) => ({
              id: n.frontmatter.id,
              abstract: n.frontmatter.abstract,
              topics: n.frontmatter.topics_touched,
            })),
            errorDetails: result.errors,
          },
        });
      } else {
        if (result.processed.length === 0 && result.errors.length === 0) {
          log("No modified transcripts found.");
          return;
        }

        for (const note of result.processed) {
          log(`Generated: ${note.frontmatter.id}`);
          log(`  Abstract: ${note.frontmatter.abstract}`);
        }

        if (result.errors.length > 0) {
          logError(`${result.errors.length} error(s):`);
          for (const err of result.errors) {
            logError(`  ${err.sessionId}: ${err.error}`);
          }
        }

        log(`\nProcessed ${result.processed.length} session(s), ${result.errors.length} error(s).`);
      }
    }
  } catch (err: any) {
    if (json) {
      printJson({ success: false, error: { code: "SNAPSHOT_FAILED", message: err.message } });
    } else {
      logError(`Snapshot failed: ${err.message}`);
    }
    process.exitCode = 1;
  }
}
