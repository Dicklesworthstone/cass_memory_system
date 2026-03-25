import { Config, CurationResult, Playbook, PlaybookDelta, KnowledgeDelta, DecisionLogEntry, PlaybookBullet, ProcessedEntry, Topic } from "./types.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet, mergePlaybooks } from "./playbook.js";
import { ProcessedLog, getProcessedLogPath } from "./tracking.js";
import { findUnprocessedSessions, cassExport } from "./cass.js";
import { generateDiary } from "./diary.js";
import { generateDiaryFromNote } from "./diary.js";
import { reflectOnSession } from "./reflect.js";
import { reflectOnSessionTwoCalls, type TwoCallReflectionResult } from "./reflect.js";
import { validateDelta } from "./validate.js";
import { validateKnowledgeDelta, detectContradiction } from "./validate.js";
import { reportContradiction } from "./review-queue.js";
import type { LLMIO } from "./llm.js";
import { generateDailyDigest, projectFromSourcePath } from "./llm.js";
import { curatePlaybook, curateKnowledge, type KnowledgeCurationResult } from "./curate.js";
import { expandPath, log, warn, error, now, fileExists, resolveRepoDir, generateBulletId, hashContent, jaccardSimilarity, ensureDir, parseInlineFeedback } from "./utils.js";
import { withLock } from "./lock.js";
import { extractRuleIdsFromTranscript, classifySessionOutcome, recordOutcome, applyOutcomeFeedback, type OutcomeInput } from "./outcome.js";
import { findUnprocessedSessionNotes, markSessionNoteProcessed, loadProcessingState, saveProcessingState, type ParsedSessionNote } from "./session-notes.js";
import { loadTopics, loadKnowledgePage, writeDigest } from "./knowledge-page.js";
import { openSearchIndex } from "./search.js";
import path from "node:path";
import fs from "node:fs/promises";

export interface ReflectionOptions {
  days?: number;
  maxSessions?: number;
  agent?: string;
  workspace?: string;
  session?: string; // Specific session path
  dryRun?: boolean;
  onProgress?: (event: ReflectionProgressEvent) => void;
  /** Optional LLMIO for testing - bypasses env-based stubs when provided */
  io?: LLMIO;
}

export interface ReflectionOutcome {
  sessionsProcessed: number;
  deltasGenerated: number;
  globalResult?: CurationResult;
  repoResult?: CurationResult;
  dryRunDeltas?: PlaybookDelta[];
  errors: string[];
  /** Auto-recorded rule outcomes from processed sessions */
  autoOutcome?: {
    outcomesRecorded: number;
    feedbackApplied: number;
    missingRules: string[];
    inlineFeedbackDeltas: number;
  };
  /** Phase 3: Knowledge curation results */
  knowledgeResult?: KnowledgeCurationResult;
  /** Phase 3: Session notes processed via the two-call pipeline */
  sessionNotesProcessed?: number;
}

export type ReflectionProgressEvent =
  | { phase: "discovery"; totalSessions: number }
  | { phase: "session_start"; index: number; totalSessions: number; sessionPath: string }
  | { phase: "session_skip"; index: number; totalSessions: number; sessionPath: string; reason: string }
  | { phase: "session_done"; index: number; totalSessions: number; sessionPath: string; deltasGenerated: number }
  | { phase: "session_error"; index: number; totalSessions: number; sessionPath: string; error: string };

function isActiveBullet(bullet: PlaybookBullet): boolean {
  return !bullet.deprecated && bullet.maturity !== "deprecated" && bullet.state !== "retired";
}

function findFirstHashMatch(playbook: Playbook, content: string): PlaybookBullet | undefined {
  const h = hashContent(content);
  return playbook.bullets.find((b) => hashContent(b.content) === h);
}

function findBestActiveSimilarBullet(
  playbook: Playbook,
  content: string,
  threshold: number
): PlaybookBullet | undefined {
  let best: { bullet: PlaybookBullet; score: number } | undefined;
  for (const b of playbook.bullets) {
    if (!isActiveBullet(b)) continue;
    const score = jaccardSimilarity(content, b.content);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { bullet: b, score };
  }
  return best?.bullet;
}

/**
 * Core logic for the reflection loop.
 * Handles session discovery, LLM reflection, delta validation, splitting, and persistence.
 * Implements fine-grained locking to maximize concurrency.
 */
export async function orchestrateReflection(
  config: Config,
  options: ReflectionOptions
): Promise<ReflectionOutcome> {
  const logPath = expandPath(getProcessedLogPath(options.workspace));
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  const hasRepo = repoPath ? await fileExists(repoPath) : false;

  // 1. Lock the Workspace Log to serialize reflection for this specific workspace
  // Use a specific lock suffix to allow ProcessedLog internal locking to work independently
  const reflectionLockPath = `${logPath}.orchestrator`;

  // Ensure reflections directory exists before lock acquisition (fixes #14)
  // Without this, the lock can fail on fresh installs where ~/.memory-system/reflections/ doesn't exist
  await ensureDir(path.dirname(reflectionLockPath));

  return withLock(reflectionLockPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();

    // 2. Snapshot Phase: Load playbook context (without locking playbook yet)
    // We need the playbook to give context to the LLM. 
    // Stale data here is acceptable (LLM might suggest a rule that just got added, curation will dedupe).
    const snapshotPlaybook = await loadMergedPlaybook(config);

    // 3. Discovery Phase
    let sessions: string[] = [];
    const errors: string[] = [];

    if (options.session) {
      sessions = [options.session];
    } else {
      try {
        sessions = await findUnprocessedSessions(
          processedLog.getProcessedPaths(),
          {
            days: options.days || config.sessionLookbackDays,
            maxSessions: options.maxSessions || 5,
            agent: options.agent,
            excludePatterns: config.sessionExcludePatterns,
            includeAll: config.sessionIncludeAll
          },
          config.cassPath
        );
      } catch (err: any) {
        // Don't return early — Phase 3 knowledge pipeline still needs to run
        errors.push(`Session discovery failed: ${err.message}`);
      }
    }

    const unprocessed = sessions.filter(s => !processedLog.has(s));

    // Note: don't return early if unprocessed is empty — the Phase 3 knowledge
    // pipeline below also needs to run for session notes with processed: false.
    if (unprocessed.length > 0) {
      options.onProgress?.({ phase: "discovery", totalSessions: unprocessed.length });
    }

    // 4. Reflection Phase (LLM) - Done WITHOUT holding playbook locks
    const allDeltas: PlaybookDelta[] = [];
    const pendingProcessedEntries: ProcessedEntry[] = [];
    const pendingOutcomes: OutcomeInput[] = [];
    let sessionsProcessed = 0;
    let inlineFeedbackDeltaCount = 0;

    for (let i = 0; i < unprocessed.length; i++) {
      const sessionPath = unprocessed[i]!;
      options.onProgress?.({
        phase: "session_start",
        index: i + 1,
        totalSessions: unprocessed.length,
        sessionPath,
      });

      try {
        const diary = await generateDiary(sessionPath, config);

        // Quick check for empty sessions to save tokens
        const content = await cassExport(sessionPath, "text", config.cassPath, config) || "";
        if (content.length < 50) {
          options.onProgress?.({
            phase: "session_skip",
            index: i + 1,
            totalSessions: unprocessed.length,
            sessionPath,
            reason: "Session content too short",
          });

          // Mark as processed so we don't retry (defer via pendingProcessedEntries)
          pendingProcessedEntries.push({
            sessionPath,
            processedAt: now(),
            diaryId: diary.id,
            deltasGenerated: 0
          });
          continue;
        }

        const reflectResult = await reflectOnSession(diary, snapshotPlaybook, config, options.io);

        // Validation
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of reflectResult.deltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            // Apply LLM refinement if suggested
            if (validation.result?.refinedRule && delta.type === "add") {
              delta.bullet.content = validation.result.refinedRule;
            }
            validatedDeltas.push(delta);
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }

        // 4b. Auto-outcome: extract rule IDs, inline feedback, and classify session
        if (content) {
          // Parse inline feedback comments (// [cass: helpful b-xyz] - reason)
          const inlineFeedback = parseInlineFeedback(content);
          if (inlineFeedback.length > 0) {
            for (const fb of inlineFeedback) {
              const delta: PlaybookDelta = fb.type === "harmful"
                ? { type: "harmful", bulletId: fb.bulletId, sourceSession: sessionPath, reason: "other", context: fb.reason }
                : { type: "helpful", bulletId: fb.bulletId, sourceSession: sessionPath, context: fb.reason };
              allDeltas.push(delta);
            }
            inlineFeedbackDeltaCount += inlineFeedback.length;
          }

          // Extract rule IDs and classify session outcome for auto-recording.
          // Exclude IDs that already have explicit inline feedback to avoid
          // double-counting (they get direct signal from the delta above).
          const inlineFeedbackIds = new Set(inlineFeedback.map(fb => fb.bulletId.toLowerCase()));
          const ruleIds = extractRuleIdsFromTranscript(content)
            .filter(id => !inlineFeedbackIds.has(id));
          if (ruleIds.length > 0) {
            const outcomeInput = classifySessionOutcome(content, diary, ruleIds);
            if (outcomeInput) {
              pendingOutcomes.push(outcomeInput);
            }
          }
        }

        // Defer marking as processed until merge succeeds to prevent data loss
        pendingProcessedEntries.push({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });
        sessionsProcessed++;

        options.onProgress?.({
          phase: "session_done",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          deltasGenerated: validatedDeltas.length,
        });
        
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`Failed to process ${sessionPath}: ${message}`);
        options.onProgress?.({
          phase: "session_error",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          error: message,
        });
      }
    }

    let dryRunDeltas: PlaybookDelta[] | undefined;

    // Mark CASS Phase 1 sessions as processed even if no deltas generated
    if (!options.dryRun && pendingProcessedEntries.length > 0) {
      await processedLog.appendBatch(pendingProcessedEntries);
    }

    // ========================================================================
    // PHASE 3: KNOWLEDGE REFLECTION PIPELINE
    // Process session notes with processed: false through the two-call
    // Reflector → Validator → Curator pipeline.
    // ========================================================================

    let knowledgeResult: KnowledgeCurationResult | undefined;
    let sessionNotesProcessed = 0;
    const digestSessions: import("./llm.js").DigestSessionInput[] = [];
    const knowledgePagesUpdated = new Set<string>();

    try {
      const unprocessedNotes = await findUnprocessedSessionNotes(config, options.maxSessions || 5);

      if (unprocessedNotes.length > 0) {
        log(`Found ${unprocessedNotes.length} unprocessed session note(s) for knowledge reflection`);

        const existingTopics = await loadTopics(config);
        const allKnowledgeDeltas: KnowledgeDelta[] = [];

        // Collect all session note bodies for the Validator's three-source evidence
        const sessionNoteBodies = new Map<string, string>();
        for (const note of unprocessedNotes) {
          sessionNoteBodies.set(note.frontmatter.id, note.body);
        }

        for (const note of unprocessedNotes) {
          const noteId = note.frontmatter.id;
          try {
            // 1. Generate diary from session note
            const diary = await generateDiaryFromNote(
              noteId,
              note.body,
              note.frontmatter.abstract,
              note.frontmatter.topics_touched,
              config
            );

            // 1b. Collect session info for daily digest synthesis
            digestSessions.push({
              sessionId: noteId,
              title: note.frontmatter.title || "Untitled session",
              abstract: note.frontmatter.abstract,
              project: projectFromSourcePath(note.frontmatter.source_session || ""),
              topics: note.frontmatter.topics_touched,
              decisions: diary.decisions.slice(0, 3),
              challenges: diary.challenges.slice(0, 3),
              openQuestions: [], // TODO: extract from session note body if needed
            });

            // 2. Load relevant knowledge pages for Call 2 context
            const relevantTopicSlugs = new Set([
              ...note.frontmatter.topics_touched,
              ...diary.tags,
            ]);
            const knowledgePagesContent: string[] = [];
            for (const slug of relevantTopicSlugs) {
              const page = await loadKnowledgePage(slug, config);
              if (page) {
                knowledgePagesContent.push(`# ${page.frontmatter.topic}\n${page.sections.map(s => `## ${s.title}\n${s.content}`).join("\n\n")}`);
              }
            }

            // 3. Two-call reflection
            const reflectResult = await reflectOnSessionTwoCalls(
              diary,
              note.body,
              snapshotPlaybook,
              existingTopics,
              knowledgePagesContent.join("\n\n---\n\n"),
              noteId,
              config,
              options.io
            );

            // 4. Validate playbook deltas (existing path)
            for (const delta of reflectResult.playbookDeltas) {
              const validation = await validateDelta(delta, config);
              if (validation.valid) {
                if (validation.result?.refinedRule && delta.type === "add") {
                  delta.bullet.content = validation.result.refinedRule;
                }
                allDeltas.push(delta);
              }
            }

            // 5. Validate knowledge deltas
            for (const delta of reflectResult.knowledgeDeltas) {
              const validation = await validateKnowledgeDelta(delta, sessionNoteBodies, config);
              if (validation.valid) {
                // Upgrade confidence if evidence supports it
                if (validation.confidence && delta.type === "knowledge_page_append") {
                  (delta as any).confidence = validation.confidence;
                }
                allKnowledgeDeltas.push(delta);
              }
            }

            // 5b. Inline feedback + auto-outcome from session note body.
            // Same logic as CASS Phase 1 but using session note text instead of cass export.
            const noteContent = note.body;
            if (noteContent) {
              // Parse inline feedback comments (// [cass: helpful b-xyz] - reason)
              const inlineFeedback = parseInlineFeedback(noteContent);
              if (inlineFeedback.length > 0) {
                for (const fb of inlineFeedback) {
                  const delta: PlaybookDelta = fb.type === "harmful"
                    ? { type: "harmful", bulletId: fb.bulletId, sourceSession: noteId, reason: "other", context: fb.reason }
                    : { type: "helpful", bulletId: fb.bulletId, sourceSession: noteId, context: fb.reason };
                  allDeltas.push(delta);
                }
                inlineFeedbackDeltaCount += inlineFeedback.length;
              }

              // Extract rule IDs and classify session outcome for auto-recording.
              const inlineFeedbackIds = new Set(inlineFeedback.map(fb => fb.bulletId.toLowerCase()));
              const ruleIds = extractRuleIdsFromTranscript(noteContent)
                .filter(id => !inlineFeedbackIds.has(id));
              if (ruleIds.length > 0) {
                const outcomeInput = classifySessionOutcome(noteContent, diary, ruleIds);
                if (outcomeInput) {
                  pendingOutcomes.push(outcomeInput);
                }
              }
            }

            sessionNotesProcessed++;
          } catch (err: any) {
            errors.push(`Knowledge reflection failed for ${noteId}: ${err?.message || String(err)}`);
          }
        }

        // 6. Curate knowledge deltas (deterministic, no LLM)
        if (allKnowledgeDeltas.length > 0 && !options.dryRun) {
          // Reload topics in case Call 1 suggested new ones in an earlier session
          const latestTopics = await loadTopics(config);
          knowledgeResult = await curateKnowledge(allKnowledgeDeltas, latestTopics, config);
        }

        // Track which knowledge pages were updated for digest
        for (const delta of allKnowledgeDeltas) {
          if ("topic_slug" in delta && delta.topic_slug) {
            knowledgePagesUpdated.add(delta.topic_slug);
          }
        }

        // 7. Re-index knowledge pages, session notes, and digests in SQLite
        if (!options.dryRun) {
          try {
            const dbPath = expandPath(config.searchDbPath);
            const searchIndex = openSearchIndex(dbPath);
            try {
              // Re-index knowledge pages (supports both directory model and legacy flat files)
              const knowledgeDir = expandPath(config.knowledgeDir);
              const { parseKnowledgePage } = await import("./knowledge-page.js");
              const entries = await fs.readdir(knowledgeDir, { withFileTypes: true }).catch(() => []);
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  // Directory model: knowledge/{slug}/*.md
                  const subDir = path.join(knowledgeDir, entry.name);
                  const subFiles = await fs.readdir(subDir).catch(() => [] as string[]);
                  for (const subFile of subFiles) {
                    if (!subFile.endsWith(".md")) continue;
                    try {
                      const raw = await fs.readFile(path.join(subDir, subFile), "utf-8");
                      const page = parseKnowledgePage(raw);
                      for (const section of page.sections) {
                        searchIndex.indexKnowledge({
                          topic: `${entry.name}/${subFile.replace(".md", "")}`,
                          section_title: section.title,
                          content: section.content,
                        });
                      }
                    } catch { /* skip malformed */ }
                  }
                } else if (entry.name.endsWith(".md")) {
                  // Legacy flat file: knowledge/{slug}.md
                  try {
                    const raw = await fs.readFile(path.join(knowledgeDir, entry.name), "utf-8");
                    const page = parseKnowledgePage(raw);
                    for (const section of page.sections) {
                      searchIndex.indexKnowledge({
                        topic: page.frontmatter.topic,
                        section_title: section.title,
                        content: section.content,
                      });
                    }
                  } catch { /* skip malformed */ }
                }
              }

              // Re-index session notes
              const sessionNotesDir = expandPath(config.sessionNotesDir);
              const noteFiles = await fs.readdir(sessionNotesDir).catch(() => [] as string[]);
              for (const file of noteFiles) {
                if (!file.endsWith(".md")) continue;
                try {
                  const raw = await fs.readFile(path.join(sessionNotesDir, file), "utf-8");
                  const { parseSessionNote } = await import("./session-notes.js");
                  const note = parseSessionNote(raw);
                  searchIndex.indexSession(
                    note.frontmatter.id,
                    note.frontmatter.abstract,
                    note.body,
                  );
                } catch {
                  // Skip malformed notes
                }
              }

              // Re-index digests
              const digestsDir = expandPath(config.digestsDir);
              const digestFiles = await fs.readdir(digestsDir).catch(() => [] as string[]);
              for (const file of digestFiles) {
                if (!file.endsWith(".md")) continue;
                try {
                  const raw = await fs.readFile(path.join(digestsDir, file), "utf-8");
                  const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                  const body = bodyMatch?.[1]?.trim() || "";
                  const date = file.replace(/\.md$/, "");
                  if (body) {
                    searchIndex.indexDigest({ date, content: body });
                  }
                } catch {
                  // Skip malformed digests
                }
              }

              // Update lastIndexUpdate timestamp in state.json
              const state = await loadProcessingState(config);
              state.lastIndexUpdate = new Date().toISOString();
              await saveProcessingState(state, config);
            } finally {
              searchIndex.close();
            }
          } catch {
            // search.db may not exist — non-fatal
          }
        }

        // 8. Mark session notes as processed
        if (!options.dryRun) {
          for (const note of unprocessedNotes.slice(0, sessionNotesProcessed)) {
            try {
              await markSessionNoteProcessed(note.frontmatter.id, config);
            } catch (err: any) {
              warn(`Failed to mark note ${note.frontmatter.id} as processed: ${err?.message}`);
            }
          }
        }
      }
    } catch (err: any) {
      errors.push(`Knowledge reflection pipeline failed: ${err?.message || String(err)}`);
    }

    // ========================================================================
    // PLAYBOOK CURATION (runs after BOTH Phase 1 and Phase 3 generate deltas)
    // ========================================================================

    let globalResult: CurationResult | undefined;
    let repoResult: CurationResult | undefined;
    let autoOutcome: ReflectionOutcome["autoOutcome"] | undefined;

    if (options.dryRun) {
      dryRunDeltas = allDeltas;
    } else if (allDeltas.length > 0) {
      const performMerge = async () => {
        // Reload fresh playbooks under lock
        const globalPlaybook = await loadPlaybook(globalPath);
        let repoPlaybook: Playbook | null = null;
        if (hasRepo) {
          repoPlaybook = await loadPlaybook(repoPath!);
        }

        // Create fresh merged context to ensure deduplication uses up-to-date data
        const freshMerged = mergePlaybooks(globalPlaybook, repoPlaybook);

        // Pre-process deltas to decompose 'merge' operations into atomic add/deprecate actions.
        const processedDeltas: PlaybookDelta[] = [];

        for (const delta of allDeltas) {
          if (delta.type !== "merge") {
            processedDeltas.push(delta);
            continue;
          }

          const mergedContent = delta.mergedContent;
          const threshold = typeof config.dedupSimilarityThreshold === "number" ? config.dedupSimilarityThreshold : 0.85;

          const exactMatch = findFirstHashMatch(freshMerged, mergedContent);
          if (exactMatch && !isActiveBullet(exactMatch)) {
            warn(`[orchestrator] Skipping merge delta: merged content matches deprecated/blocked bullet ${exactMatch.id}`);
            continue;
          }

          const replacement =
            exactMatch && isActiveBullet(exactMatch)
              ? exactMatch
              : findBestActiveSimilarBullet(freshMerged, mergedContent, threshold);

          if (replacement) {
            for (const id of delta.bulletIds) {
              if (id === replacement.id) continue;
              processedDeltas.push({
                type: "deprecate",
                bulletId: id,
                reason: `Merged into existing ${replacement.id}`,
                replacedBy: replacement.id
              });
            }
            continue;
          }

          const newBulletId = generateBulletId();
          processedDeltas.push({
            type: "add",
            bullet: {
              id: newBulletId,
              content: mergedContent,
              category: "merged",
              tags: []
            },
            sourceSession: "merged-operation",
            reason: delta.reason || "Merged from existing rules"
          });

          for (const id of delta.bulletIds) {
            processedDeltas.push({
              type: "deprecate",
              bulletId: id,
              reason: `Merged into ${newBulletId}`,
              replacedBy: newBulletId
            });
          }
        }

        // Partition deltas (Routing Logic)
        const globalDeltas: PlaybookDelta[] = [];
        const repoDeltas: PlaybookDelta[] = [];

        for (const delta of processedDeltas) {
          let routed = false;
          if ('bulletId' in delta && delta.bulletId) {
            if (repoPlaybook && findBullet(repoPlaybook, delta.bulletId)) {
              repoDeltas.push(delta);
              routed = true;
            } else if (findBullet(globalPlaybook, delta.bulletId)) {
              globalDeltas.push(delta);
              routed = true;
            }
          }
          if (!routed) {
            globalDeltas.push(delta);
          }
        }

        // Apply Curation
        if (globalDeltas.length > 0) {
          globalResult = curatePlaybook(globalPlaybook, globalDeltas, config, freshMerged);
          await savePlaybook(globalResult.playbook, globalPath, { updateLastReflection: true });
        }

        if (repoDeltas.length > 0 && repoPlaybook && repoPath) {
          repoResult = curatePlaybook(repoPlaybook, repoDeltas, config, freshMerged);
          await savePlaybook(repoResult.playbook, repoPath, { updateLastReflection: true });
        }
      };

      // Execute Merge with Locking
      await withLock(globalPath, async () => {
        if (hasRepo && repoPath) {
          await withLock(repoPath, performMerge);
        } else {
          await performMerge();
        }
      });

      log(`Curated ${allDeltas.length} playbook delta(s)`);
    }

    // Auto-record rule outcomes (post-merge, best-effort)
    if (pendingOutcomes.length > 0) {
      try {
        const records = [];
        for (const input of pendingOutcomes) {
          const record = await recordOutcome(input, config);
          records.push(record);
        }
        const feedbackResult = await applyOutcomeFeedback(records, config);
        autoOutcome = {
          outcomesRecorded: records.length,
          feedbackApplied: feedbackResult.applied,
          missingRules: feedbackResult.missing,
          inlineFeedbackDeltas: inlineFeedbackDeltaCount,
        };
        log(`Auto-recorded ${records.length} outcome(s): ${feedbackResult.applied} feedback event(s) applied`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        errors.push(`Auto-outcome recording failed: ${msg}`);
        autoOutcome = {
          outcomesRecorded: 0,
          feedbackApplied: 0,
          missingRules: [],
          inlineFeedbackDeltas: inlineFeedbackDeltaCount,
        };
      }
    } else if (inlineFeedbackDeltaCount > 0) {
      autoOutcome = {
        outcomesRecorded: 0,
        feedbackApplied: 0,
        missingRules: [],
        inlineFeedbackDeltas: inlineFeedbackDeltaCount,
      };
    }

    // ========================================================================
    // DAILY DIGEST SYNTHESIS (Haiku)
    // Single call after all sessions are processed — synthesizes a coherent
    // daily summary with dedup, project grouping, and pipeline results.
    // ========================================================================

    if (!options.dryRun && digestSessions.length > 0) {
      try {
        // Collect bullet text for digest context
        const bulletsAdded: string[] = [];
        const bulletsHelpful: string[] = [];
        const bulletsHarmful: string[] = [];
        for (const delta of allDeltas) {
          if (delta.type === "add" && delta.bullet?.content) {
            bulletsAdded.push(delta.bullet.content);
          } else if (delta.type === "helpful" && delta.bulletId) {
            bulletsHelpful.push(delta.bulletId);
          } else if (delta.type === "harmful" && delta.bulletId) {
            bulletsHarmful.push(delta.bulletId);
          }
        }

        const digestResult = await generateDailyDigest(
          digestSessions,
          {
            bulletsAdded,
            bulletsHelpful,
            bulletsHarmful,
            knowledgePagesUpdated: [...knowledgePagesUpdated],
            errors: errors.slice(0, 3),
          },
          config,
          options.io
        );

        // Write digest to file
        const today = new Date().toISOString().split("T")[0];
        const allTopics = digestResult.topics_touched.length > 0
          ? digestResult.topics_touched
          : [...new Set(digestSessions.flatMap(s => s.topics))];
        await writeDigest(today, digestResult.summary, digestSessions.length, allTopics, config);
        log(`Generated daily digest for ${today} (${digestSessions.length} sessions)`);
      } catch (err: any) {
        errors.push(`Digest generation failed: ${err?.message || String(err)}`);
      }
    }

    return {
      sessionsProcessed,
      deltasGenerated: allDeltas.length,
      dryRunDeltas,
      globalResult,
      repoResult,
      errors,
      autoOutcome,
      knowledgeResult,
      sessionNotesProcessed: sessionNotesProcessed > 0 ? sessionNotesProcessed : undefined,
    };
  });
}
