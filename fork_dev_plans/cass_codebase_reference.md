# Codebase Reference

Living document of everything we know about the codebase. **Read this before modifying any file.** Update when you discover new facts.

Last updated: 2026-03-24 (post-Phase 4)

---

## cm.ts — CLI Entry Point (1,088 lines)

### Structure
- **Lines 1–27:** Imports from command modules + utilities
- **Lines 31–38:** Global signal handlers (SIGINT/SIGTERM graceful exit)
- **Line 40–860:** `createProgram()` — builds Commander.js program with all commands
- **Line 865:** `applyGlobalEnvFromArgv()` — environment variable setup from CLI args
- **Lines 924–955:** Help text formatters (`formatMainHelpBanner()`, `formatMainHelpEpilog()`, `formatCommandExamples()`)
- **Line 966:** `inferCommandFromArgv()` — command inference from argv
- **Line 982:** `handleCliError()` — error handling dispatcher (JSON vs human)
- **Line 1059:** Main entry point — handles `--info`/`--examples` flags, creates program, parses async

### Commands (26 active — 24 from Phase 1 + `snapshot` in Phase 2 + `topic` in Phase 4)
All follow the pattern:
```typescript
program.command("<name>")
  .description("...")
  .option(...)
  .action(async (opts: any) => await <commandFunction>(opts))
```

### Removed in Phase 1
`starters`, `quickstart`, `guard`, `trauma` (parent + 5 subcommands), `--trauma` option on audit, `--starter` option on init.

---

## types.ts — All Zod Schemas (1,074 lines)

### Core Enums (lines 7–53)
- `HarmfulReasonEnum`, `SessionStatusEnum` ("success" | "failure" | "mixed")
- `BulletScopeEnum` ("global" | "workspace" | "language" | "framework" | "task")
- `BulletTypeEnum` ("rule" | "anti-pattern"), `BulletKindEnum` ("project_convention" | "stack_pattern" | "workflow_rule" | "anti_pattern"), `BulletSourceEnum`, `BulletStateEnum`
- `BulletMaturityEnum` ("candidate" | "established" | "proven" | "deprecated")
- `LLMProviderEnum` ("openai" | "anthropic" | "google" | "ollama")

### Key CASS Schemas
- **PlaybookBulletSchema (~line 65):** 30+ fields — id, scope, category, content, source, type, kind, state, maturity, helpfulCount, harmfulCount, feedbackEvents, embedding, effectiveScore, etc.
- **FeedbackEventSchema (~line 51):** type (helpful/harmful), timestamp, sessionPath, reason, context, decayedValue
- **PlaybookDeltaSchema (~line 159):** Discriminated union — Add, Helpful, Harmful, Replace, Deprecate, Merge
- **DiaryEntrySchema (~line 266):** id, sessionPath, timestamp, agent, workspace, status, accomplishments[], decisions[], challenges[], keyLearnings[], tags[], searchAnchors[]
- **PlaybookSchema (~line 222):** schema_version, name, description, metadata, deprecatedPatterns[], bullets[]
- **ContextResultSchema:** task, relevantBullets, antiPatterns, searchResults (renamed from historySnippets in Phase 4, now KnowledgeSearchHit[]), deprecatedWarnings, formattedPrompt. Phase 4 optional fields: topicExcerpts, recentSessions, relatedTopics, suggestedDeepDives, lastReflectionRun
- **ValidationResultSchema:** delta, valid, verdict (ACCEPT/REJECT/REFINE/ACCEPT_WITH_CAUTION), confidence, evidence[]

### ConfigSchema (lines 364–429)
Key defaults (post-Phase 1):
- `provider`: "anthropic", `model`: "claude-sonnet-4-20250514"
- `cassPath`: "cass"
- `playbookPath`: "~/.memory-system/playbook.yaml"
- `diaryDir`: "~/.memory-system/diary"
- `semanticSearchEnabled`: **true** (changed from false in Phase 1)
- `budget`: dailyLimit=**0.50**, monthlyLimit=**10.00** (changed from 0.10/2.00 in Phase 1)
- New Phase 1 path fields (lines 416–422): `sessionNotesDir`, `knowledgeDir`, `digestsDir`, `notesDir`, `searchDbPath`, `stateJsonPath`, `topicsJsonPath`
- New Phase 1 tuning fields (lines 424–428): `periodicJobIntervalHours` (4), `knowledgePageBloatThreshold` (5000), `staleTopicIgnoreDays` (30), `transcriptRetentionDays` (30)
- `pipelineModels` (post-Phase 5): per-step model overrides. Defaults: sessionNoteCreate/Extend/diaryFromNote/reflectorCall1 → `claude-haiku-4-5-20251001`, reflectorCall2/knowledgeGen → "" (uses config.model, i.e. Sonnet)

### Phase 1 Knowledge System Types (lines 906–1045)
- **`ConfidenceTierEnum`** — "verified" | "inferred" | "uncertain"
- **`TopicSourceEnum`** — "user" | "system"
- **`SubPageSchema`** — slug, name, description
- **`TopicSchema`** — slug, name, description, source, created, subpages: SubPage[] (default [])
- **`TopicsFileSchema`** — { topics: Topic[] }
- **`SessionNoteSchema`** — id, source_session, last_offset, created, last_updated, abstract, topics_touched, processed, user_edited
- **`KnowledgePageSchema`** — topic, description, source, created, last_updated
- **`DailyDigestSchema`** — date (YYYY-MM-DD), sessions count, topics_touched
- **`UserNoteSchema`** — id, title, created, topics, ingest, starred
- **`TopicSuggestionSchema`** — slug, name, description, source (literal "system"), created, suggested_from_session
- **`KnowledgePageAppendDeltaSchema`** — type "knowledge_page_append", topic_slug, section_id, section_title, content, confidence, source_session, added_date, related_bullets
- **`DigestUpdateDeltaSchema`** — type "digest_update", date, content, sessions_covered
- **`TopicSuggestionDeltaSchema`** — type "topic_suggestion", slug, name, description, suggested_from_session
- **`KnowledgeDeltaSchema`** — discriminated union of the above 3 delta types
- **`ProcessingStateSchema`** — sessions (record of per-session state), lastReflectionRun, lastIndexUpdate, lastPeriodicJobRun (Phase 4)

### Phase 4 Types
- **`KnowledgeSearchHitSchema`** — type (knowledge|session_note|digest|transcript|playbook), id, snippet, score, title?. Replaces CassSearchHit in ContextResult.
- **`TopicExcerptSchema`** — topic, slug, sections[{title, preview}]
- **`RecentSessionSchema`** — id, date, abstract, note_text
- **`RelatedTopicSchema`** — slug, name, description, similarity
- **`ReviewQueueItemSchema`** — Discriminated union on `type`: cold_start_suggestion, bloated_page, stale_topic, user_flag, topic_suggestion
- **`ReviewQueueSchema`** — { schema_version: z.literal(1), items: ReviewQueueItem[] }

### Delta Type Design
Two discriminated unions on `type` field:
- **`PlaybookDeltaSchema`** — existing CASS deltas (add, helpful, harmful, replace, deprecate, merge)
- **`KnowledgeDeltaSchema`** — new memory system deltas (knowledge_page_append, digest_update, topic_suggestion)

### Schemas Registry (lines 1049–1074)
All schemas exported via `Schemas` const object. Phase 1 additions at lines 1064–1072.

---

## search.ts — SQLite FTS5 Search Index (346 lines) — NEW

### Purpose
SQLite-based full-text search index. **SQLite is the search index, files are the source of truth.** Uses `bun:sqlite` (built-in, zero external deps).

### Key Exports
- **`SearchIndex` class** — main search index implementation
- **`openSearchIndex(dbPath)`** — convenience factory
- **`SearchHit`** interface — { table, id, snippet, rank }
- **`SessionRow`, `KnowledgeRow`, `TranscriptChunk`, `NoteRow`, `DigestRow`** — input types

### Schema (lines 21–72)
```sql
sessions (id, date, abstract, filepath, processed, last_offset, created_at, updated_at)
session_topics (session_id, topic_slug)  -- join table
fts_knowledge (topic, section_title, content)  -- FTS5 with porter stemmer
fts_sessions (id, abstract, content)
fts_transcripts (session_id, chunk_offset, content)
fts_notes (id, title, content)
fts_digests (date, content)
meta (key, value)  -- schema version tracking
```

### SearchIndex Methods
- **Session CRUD:** `upsertSession()`, `setSessionTopics()`, `getSession()`, `getUnprocessedSessions()`
- **FTS Indexing:** `indexKnowledge()`, `indexSession()`, `indexTranscriptChunk()`, `indexNote()`, `indexDigest()`
- **Search:** `search(query, { tables?, limit? })` — cross-table FTS5 search, returns ranked `SearchHit[]`
- **Lifecycle:** `clearAllFts()`, `close()`, `raw` (database accessor)

### Implementation Notes
- WAL mode enabled for concurrent read safety with Electron app
- Porter stemming + unicode61 tokenizer for all FTS5 tables
- FTS query: each word wrapped in quotes to prevent syntax errors
- Dedup on re-index: DELETE existing then INSERT (not upsert for FTS5)

---

## session-notes.ts — Session Note Generation (~700 lines) — NEW (Phase 2)

### Purpose
Core module for the session note lifecycle: discovering transcripts, reading from byte offsets, generating/extending notes via LLM or agent-provided content, managing processing state, and indexing into SQLite FTS.

### Key Exports
- **`processTranscript(scan, config, options)`** — main entry point: generates or extends a session note from a TranscriptScanResult
- **`processAllTranscripts(config, options)`** — batch processing for the periodic job
- **`scanForModifiedTranscripts(config)`** — discovers transcripts with new content since last offset
- **`findBestTranscriptForCwd(scans, cwd?)`** — project-scoped matching: filters scans to transcripts in the matching project directory (normalizes path encoding), sorts by mtime (newest first). Used by cm_snapshot/CLI snapshot when no explicit session ID is provided. Falls back to all scans sorted by mtime if no project matches.
- **`discoverTranscripts()`** — finds `.jsonl` files in `~/.claude/projects/`
- **`readTranscriptFromOffset(filePath, offset)`** — byte-level offset reading
- **`formatTranscriptChunk(raw)`** — custom JSONL formatter optimized for session notes (NOT diary.ts formatRawSession)
- **`loadSessionNote(sessionId, config)` / `writeSessionNote(...)`** — session note file I/O with locking
- **`parseSessionNote(raw)` / `serializeSessionNote(fm, body)`** — YAML frontmatter parse/serialize
- **`loadProcessingState(config)` / `saveProcessingState(state, config)`** — state.json CRUD
- **`sessionIdFromPath(transcriptPath)`** — UUID extraction or hash-based ID generation
- **`SessionNoteCreateOutputSchema` / `SessionNoteAppendOutputSchema`** — Zod schemas for LLM output

### Content Generation Paths
`processTranscript()` supports three paths via `GenerateNoteOptions`:
1. **Agent-provided** (`agentContent` set): Claude Code generates the note during the session via `cm_snapshot` MCP tool. No API cost. Highest quality. Primary path. Title derived from first sentence of abstract. Uses `findBestTranscriptForCwd()` to match to the correct transcript (project-scoped + mtime sorting) — prevents cross-project contamination.
2. **LLM-generated** (default): Reads raw transcript, makes API call via llm.ts (Haiku). For large transcripts (>60K chars), uses map-reduce: chunk → Haiku summarize each → Sonnet synthesize. LLM generates title.
3. **Raw** (`raw: true`): Extracts metadata from transcript without LLM. Last-resort fallback. Body capped at 30K chars.

All paths share file writing, state tracking, offset management, and FTS indexing. Offset-based dedup. `user_edited` no longer blocks appending — system only appends, never modifies existing content. `processed` flag only reset on substantial new content (>500 chars).

### Session Note Schema
Frontmatter includes: id, **title** (3-8 words, editable), source_session, last_offset, created, last_updated, abstract, topics_touched, processed, user_edited.

### No-Backfill
`installedAt` timestamp in state.json. `scanForModifiedTranscripts` skips transcripts with mtime before installedAt.

### Custom Transcript Formatter (`formatTranscriptChunk`)
Replaces upstream `formatRawSession` (diary.ts) for session note generation. Key differences:
- **Drops** meta entries: queue-operation, file-history-snapshot, progress, session_meta
- **Summarizes** tool_use as one-liners: `> Read: .../file.ts`, `> Edit: .../file.ts — "old code..."`, `> Bash: description`
- **Drops** tool_result contents (tool name + args are sufficient context)
- **Keeps** user text, assistant text, thinking blocks (truncated to 500 chars)
- **Strips** XML tags (ide_selection, ide_opened_file, system-reminder)
- Helper functions: `summarizeToolUse()` (handles Read, Write, Edit, Bash, Grep, Glob, TodoWrite, Agent, Skill, ToolSearch + generic fallback), `shortenPath()`, `stripXmlTags()`

### Abstract Extraction (`extractAbstractFromJsonl`)
Used by the raw fallback path. Reads JSONL in 256KB chunks to handle multi-MB base64 image entries. Scans for `"type":"user"` entries, extracts first substantive text (>15 chars, stripped of XML tags). Checks up to 30 user messages before giving up.

### Dependencies
Imports from: types.ts, llm.ts (generateSessionNoteContent, extendSessionNoteContent), utils.ts, lock.ts, search.ts (types only). No longer imports from diary.ts.

### Circular Import Note
session-notes.ts exports Zod schemas that llm.ts imports. llm.ts exports LLM functions that session-notes.ts imports. This works because the schemas are pure Zod objects with no runtime dependency on session-notes functions.

---

## commands/snapshot.ts — Snapshot CLI Command (~130 lines) — NEW (Phase 2)

### Purpose
CLI command for `cm snapshot`. Wraps `processTranscript`/`processAllTranscripts` with JSON/human output formatting.

### Exports
- **`snapshotCommand(opts)`** — handles `--session`, `--max-sessions`, `--raw`, `--abstract`, `--topics`, `--content`, `--json` flags

---

## cass.ts — External Binary Interface (1,175 lines)

### Decision: DO NOT TOUCH
Leave untouched. Binary is already optional — graceful degradation handles absence. Binary calls become dead code as search.ts and direct file reading come online.

### Key Exports (binary wrappers)
`cassAvailable`, `handleCassUnavailable`, `cassNeedsIndex`, `cassIndex`, `cassSearch`, `safeCassSearchWithDegraded`, `safeCassSearch`, `cassExport`, `cassExpand`, `cassStats`, `cassTimeline`, `findUnprocessedSessions`

### Non-Binary Exports (KEEP — useful for Phase 2+)
- `handleSessionExportFailure` — direct file reading fallback (.jsonl, .json, .md)
- `formatSessionEntry`, `coerceContent`, `joinMessages` — format parsing
- `parseCassJsonOutput` — robust JSON parsing with NDJSON fallback
- `CassRunner` interface — dependency injection for testability

### Modules Importing from cass.ts (12 after Phase 1 deletions)
orchestrator.ts, validate.ts, diary.ts, audit.ts, commands/context.ts, commands/serve.ts, commands/doctor.ts, commands/audit.ts, commands/onboard.ts, commands/privacy.ts, commands/validate.ts, commands/init.ts

---

## config.ts — Configuration (305 lines)

### Exports
- `getDefaultConfig()` (line 16) — parses {} through ConfigSchema → fully populated Config
- `getSanitizeConfig(config?)` (line 39) — sanitization config with defaults
- `loadConfig(cliOverrides?)` (line 160) — main loader with full precedence chain
- `saveConfig(config)` (line 302) — atomic write to `~/.memory-system/config.json`
- `DEFAULT_CONFIG` (line 37) — deprecated constant, same as `getDefaultConfig()`

### Config Loading Precedence
```
defaults (ConfigSchema) → globalConfig (~/.memory-system/config.json)
→ envOverrides (CASS_PATH, OLLAMA_BASE_URL, *_BASE_URL)
→ repoConfig (.cass/config.json|yaml|yml) with security filters
→ cliOverrides (CLI flags)
```

### Repo Config Security Filters
Repo configs CANNOT override: `cassPath`, `playbookPath`, `diaryDir`, `crossAgent`, `remoteCass`, `apiKey`, `budget`, `sanitization`. Can only add `sanitization.extraPatterns`.

### LLM Config Migration (line 68)
Deprecated `{ llm: { provider, model } }` → canonical `{ provider, model }` at top level. Warns once per process.

---

## utils.ts — Core Utilities (3,423 lines)

### Path Functions
- **`resolveGlobalDir()` (line 1070):** Returns `expandPath("~/.memory-system")`
- **`resolveRepoDir()` (line 1065):** Returns `path.join(gitRoot, ".cass")`
- **`expandPath(p)` (~line 890):** Expands `~` to home dir
- **`ensureGlobalStructure()` (line 1074):** Creates `~/.memory-system/` with subdirs: `diary`, `reflections`, `embeddings`, `cost`, `session-notes`, `knowledge`, `digests`, `notes`. Creates files: `config.json`, `playbook.yaml`, `blocked.log`, `usage.jsonl`.

### File Operations
- `atomicWrite(filePath, content)` — temp file → atomic rename, mode 0o600
- `withLock(filePath, operation)` — async file locking, delegates to `lock.ts`
- `fileExists(filePath)` — async existence check with ~ expansion
- `ensureDir(dir)` — recursive mkdir with ~ expansion

### Text Processing
- `tokenize(text)` — regex tokenizer preserving technical terms
- `jaccardSimilarity(a, b)` / `jaccardSimilaritySets(a, b)` — similarity 0.0-1.0
- `extractKeywords(text)` — top 10 keywords by frequency, stop-word filtered
- `hashContent(content)` — SHA256 truncated to 16 chars
- `truncateForContext(result, options)` — truncates ContextResult with strategies

### ID Generation
- `generateBulletId()` — format: `b-{base36timestamp}-{random6chars}`
- `generateDiaryId(sessionPath, content?)` — format: `diary-{hash}`

### Other Notable Exports
- `getVersion()`, `getCliName()` — CLI metadata
- `scoreBulletRelevance()` — bullet scoring for context retrieval
- `parseInlineFeedback()`, `inlineFeedbackToDeltas()` — `[cass: helpful b-xyz]` annotation parsing
- `setupGracefulShutdown()`, `isShutdownInProgress()`, `onShutdown()`, `getAbortSignal()` — shutdown management
- `normalizeYamlKeys()`, `snakeToCamel()`, `camelToSnakeKeys()` — case conversion
- `log()`, `error()`, `warn()`, `isJsonOutput()`, `printJson()` — output utilities

---

## orchestrator.ts — Pipeline Coordination (454 lines)

### Exports
- `orchestrateReflection(config, options): Promise<ReflectionOutcome>` — lines 79–454
- `ReflectionOptions` interface — days, maxSessions, agent, workspace, session, dryRun, onProgress, io
- `ReflectionOutcome` interface — sessionsProcessed, deltasGenerated, globalResult, repoResult, errors, autoOutcome

### Imports (12 local modules — central hub)
types, playbook, tracking, cass, diary, reflect, validate, llm (type), curate, utils, lock, outcome

### Pipeline Flow
1. Setup — resolve paths, ensure reflections dir
2. Lock — acquire workspace serialization lock via `withLock()`
3. Playbook snapshot — `loadMergedPlaybook(config)` for LLM context
4. Discovery — `findUnprocessedSessions()` or use specific session
5. Reflection loop (per session): generateDiary → cassExport → reflectOnSession → validateDelta → auto-outcome
6. Dry-run check — return early if dryRun
7. Delta preprocessing — decompose "merge" deltas into add/deprecate pairs
8. Delta routing — partition into global vs repo deltas
9. Merge with locking — reload playbooks under lock, `curatePlaybook()`, save
10. Processed log + auto-outcome recording

### Only One Consumer
`src/commands/reflect.ts` imports from orchestrator.ts and periodic-job.ts (Phase 4). `src/periodic-job.ts` also imports from orchestrator.ts.

---

## Modules Kept As-Is (no Phase 1 changes)

| File | ~Lines | Purpose |
|------|--------|---------|
| `src/scoring.ts` | 230 | Confidence decay, maturity progression |
| `src/sanitize.ts` | 244 | PII/secret removal before LLM calls |
| `src/lock.ts` | 273 | File-level locking for concurrent write safety |
| `src/output.ts` | 224 | Terminal output formatting |
| `src/progress.ts` | 268 | Progress reporting for periodic job |
| `src/llm.ts` | ~890 | Multi-provider LLM abstraction (Vercel AI SDK). Phase 2: added session note prompts. Post-Phase 5: added `configForStep(config, step)` for per-step Haiku/Sonnet routing, fixed prompt enum values. |
| `src/cost.ts` | 221 | Budget tracking with daily/monthly limits |
| `src/playbook.ts` | 702 | Playbook CRUD, YAML load/save/merge |
| `src/gap-analysis.ts` | 298 | Rule archetype categorization, coverage gaps |
| `src/rule-validation.ts` | 313 | Semantic validation, category mismatch detection |
| `src/semantic.ts` | 780 | Local embeddings (Transformers.js, all-MiniLM-L6-v2) |
| `src/cass.ts` | 1175 | External binary interface (DO NOT TOUCH) |
| `src/onboard-state.ts` | ~240 | Onboarding state (kept — commands/onboard.ts depends on it) |

## Modules Modified in Phases 3-4

| File | Phase | Key Changes |
|------|-------|-------------|
| `src/reflect.ts` | 3 | Split into two LLM calls (bullets + prose) |
| `src/validate.ts` | 3 | Three-source evidence model |
| `src/curate.ts` | 3 | New KnowledgeDelta type handlers |
| `src/diary.ts` | 3 | Generate from session notes instead of raw transcripts |
| `src/orchestrator.ts` | 3+4 | New pipeline steps for knowledge pages. Phase 4: extended re-indexing (session notes + digests + lastIndexUpdate) |
| `src/outcome.ts` | 3 | Knowledge page section tracking |
| `src/tracking.ts` | 3 | New event types |
| `src/commands/serve.ts` | 2+4 | Phase 2: `cm_snapshot` tool. Phase 4: `cm_detail` (path-safe file reading, section extraction), `cm_search` (FTS + playbook search, scope filtering), `memory_search` deprecated alias, 5 new MCP resources (cm://topics, cm://knowledge/{topic}, cm://digest/{date}, cm://today, cm://status). Updated cm_context/cm_feedback descriptions. |
| `src/commands/context.ts` | 4+post | Tiered retrieval: full knowledge pages (body-matched, auto-include at rel≥0.4) + summaries + user notes + relevance-filtered session summaries. Word-boundary keyword matching + semantic + body content matching. FTS OR semantics. Stop word filtering for session relevance. |
| `src/commands/reflect.ts` | 4 | Added `--full` flag → invokes `runPeriodicJob()` instead of `orchestrateReflection()` |
| `src/commands/mcp-stdio.ts` | 4 | Wired `maybeRunPeriodicJobBackground()` at server start |

---

## Global Claude Code Configuration (outside repo)

| File | Purpose |
|------|---------|
| `~/.claude/.mcp.json` | Registers `cass-memory` MCP server globally (stdio transport via `scripts/mcp-stdio.sh`) |
| `~/.claude/CLAUDE.md` | Global instructions — MANDATORY `cm_snapshot` instruction for all sessions |
| `~/.claude/commands/snapshot.md` | `/snapshot` slash command — manual trigger for session note capture |

These files live outside the repo but are critical to the capture pipeline. The MCP server and CLAUDE.md instruction ensure session notes are captured in every Claude Code session, regardless of which project is active.

---

## Modules Deleted in Phase 1

`src/trauma.ts`, `src/trauma_guard_script.ts`, `src/starters.ts`, `src/commands/guard.ts`, `src/commands/starters.ts`, `src/commands/quickstart.ts`, `src/commands/trauma.ts` + 11 test files.

---

## Dependency Graph

### Key Import Chains
- **orchestrator.ts** → types, playbook, tracking, cass, diary, reflect, validate, llm, curate, utils, lock, outcome, session-notes, knowledge-page, search (15 modules post-Phase 3)
- **periodic-job.ts** → types, utils, session-notes, orchestrator, review-queue, knowledge-page, cost (Phase 4)
- **commands/serve.ts** → context, mark, outcome, config, playbook, diary, cass, utils, scoring, types, search, knowledge-page, session-notes, fs, path (Phase 4 additions)
- **commands/context.ts** → config, playbook, utils, types, search, knowledge-page, session-notes, semantic (Phase 4 additions)
- **commands/reflect.ts** → config, orchestrator, periodic-job, cost, utils, output, progress, types (Phase 4: added periodic-job)
- **curate.ts** → semantic, scoring, types, utils, knowledge-page
- **validate.ts** → semantic, cass, types, search, utils
- **reflect.ts** → llm, types, utils
- **llm.ts** → cost (checkBudget, recordCost), types (Zod schemas)
- **knowledge-page.ts** → types, utils, lock, semantic, review-queue (Phase 4: added semantic, review-queue)
- **config.ts** → types, utils
- **Everything** → utils, types

### Import Pattern
All internal imports use `.js` extension (ESM): `import { foo } from "./bar.js"`

---

## Test Infrastructure

- **Runner:** Bun test
- **Directory:** `test/` (~130 files post-Phase 1)
- **Setup:** `test/setup.ts`
- **Helpers:** `test/helpers/` — `temp.ts` (isolated HOME environments), `factories.ts` (test data builders), `e2e-logger.ts`, `git.ts`
- **Fixtures:** `test/fixtures/`
- **Naming:** `.e2e.test.ts` (spawn CLI), `.integration.test.ts` (multi-module), `.test.ts` (unit)
- **Baseline:** 2461 pass, 46 fail (all in serve-stats/serve-command.test.ts — pre-existing), 3 skip (post-Phase 4)
- **Phase 3 test files:** `test/phase3-reflect.test.ts` (10), `test/phase3-validate.test.ts` (14), `test/knowledge-page.test.ts` (17)
- **Phase 4 test files:** `test/phase4-context.test.ts` (15), `test/phase4-search.test.ts` (29), `test/phase4-topics.test.ts` (12), `test/phase4-periodic-job.test.ts` (7)

---

## knowledge-page.ts — Knowledge Page I/O (NEW, Phase 3, rewritten post-Phase 5)

### Knowledge Page Model
**Current model (post-Phase 5):** Single cohesive markdown document per sub-page. LLM revises the full page body on each update. No section-level HTML comment metadata.

**Directory model:** Each topic is a directory `knowledge/{slug}/` with sub-pages `{sub-page}.md`. `_index.md` is the main page.

### Key Exports
- **parseKnowledgePage() / serializeKnowledgePage():** Still work for backward compat with old section-based pages.
- **loadKnowledgePage(slug, config, subPage?) / writeKnowledgePage():** Directory-aware I/O.
- **updatePageContent(delta, topic, config):** Primary write path — replaces page body with revised content, indexes into FTS.
- **createTopicDirectory(topic, config):** Creates `knowledge/{slug}/_index.md`.
- **addSubPage(topicSlug, subPageSlug, name, description, config):** Adds sub-page definition + creates file.
- **listSubPages(slug, config):** Lists .md files in topic directory.
- **addTopic() / removeTopic() / listTopicsWithMetadata():** Topic CRUD.
- **addTopicSuggestion():** Routes to review queue (not auto-create).

### Phase 4 Additions
- **addTopic(slug, name, description, source, config):** Writes to topics.json via withLock + atomicWrite. Returns `{added: true}` or `{added: false, reason}` (doesn't throw for duplicates).
- **removeTopic(slug, config, {force?}):** Only removes system topics unless `force: true`. Returns `{removed: true}` or `{removed: false, reason}`.
- **listTopicsWithMetadata(config):** Joins topics.json with knowledge page frontmatter. Returns sectionCount, wordCount, lastUpdated per topic.
- **coldStartTopic(slug, description, config):** Embeds description via semantic.ts, searches existing knowledge pages + session notes by cosine similarity (threshold 0.3), writes top-10 matches to review queue.

---

## review-queue.ts — Review Queue I/O (NEW, Phase 4)

- **loadReviewQueue(config) / saveReviewQueue(queue, config):** File I/O with `withLock()` + `atomicWrite()`. Stored at `~/.memory-system/review-queue.json`.
- **appendReviewItems(items, config):** Deduplicates by composite key `(type, target_topic, source)` via `compositeKey()` helper. Returns `{added: N}`.
- **dismissReviewItem(id, config) / approveReviewItem(id, config):** Status updates (`pending` → `dismissed`/`approved`).
- **flagContent(targetPath, config, {section?, reason?, topic?}):** Creates `user_flag` review queue item with dedup. (Phase 5 pre-work)
- **ReviewQueueItemSchema:** Discriminated union on `type`: `cold_start_suggestion`, `bloated_page`, `stale_topic`, `user_flag` (Phase 5). Each has `id`, `status`, `created`, `target_topic` + type-specific `data`/`source`.

---

## periodic-job.ts — Periodic Job System (NEW, Phase 4)

### Lock System
- **tryAcquirePeriodicJobLock(config):** Writes `{pid, startedAt}` to `~/.memory-system/.periodic-job.lock` using `wx` flag (atomic create-or-fail). Returns `{acquired: true}` or `{acquired: false, reason}`. Detects stale locks >15 minutes old.
- **releasePeriodicJobLock(config):** Unlinks lock file.

### Timer
- **shouldRunPeriodicJob(config):** Compares `lastPeriodicJobRun` in state.json vs `config.periodicJobIntervalHours` (default 24h).

### Full Pipeline
- **runPeriodicJob(config, {dryRun?, verbose?}):** Lock → budget check → processAllTranscripts → orchestrateReflection → cleanup (flag bloated pages >5000 words, stale system topics >30 days with 0 sections → review queue) → update lastPeriodicJobRun → release lock (in finally).
- **maybeRunPeriodicJobBackground(config):** Fire-and-forget Promise, called once at MCP server start. Checks if overdue, runs in background. Errors logged, never crashes server.

### Imports
- orchestrator.ts (orchestrateReflection), session-notes.ts (processAllTranscripts, loadProcessingState, saveProcessingState), knowledge-page.ts (listTopicsWithMetadata, loadTopics), review-queue.ts (appendReviewItems), cost.ts (checkBudget)

---

## commands/topic.ts — Topic CLI (NEW, Phase 4)

- **topicCommand(subcommand, args, opts):** Handles `cm topic add|list|remove`.
- `add`: Creates topic via addTopic(), runs coldStartTopic() if description provided, outputs suggestions.
- `list`: Shows topics with metadata (section count, word count, last updated).
- `remove`: Removes topic. Force required for user-created topics.
- Imports `loadConfig` from `config.ts` (NOT utils.ts — common gotcha).

---

## user-notes.ts — User Note CRUD (NEW, Phase 5 pre-work)

- **createUserNote(title, body, config, {topics?}):** Generates `note-{timestamp36}-{random6}` ID, writes to `~/.memory-system/notes/{id}.md` with YAML frontmatter + body via withLock + atomicWrite.
- **loadUserNote(id, config):** Returns `{ frontmatter: UserNote, body, raw }` or null.
- **saveUserNote(id, frontmatter, body, config):** Full overwrite with locking.
- **deleteUserNote(id, config):** fs.unlink, returns boolean.
- **listUserNotes(config):** Reads all .md from notes dir, parses frontmatter only, sorts by created desc.
- **parseUserNote(raw) / serializeUserNote(fm, body):** YAML frontmatter parse/serialize following session-notes.ts patterns.

---

## starred.ts — Starred Items Index (NEW, Phase 5 pre-work)

- Uses separate `~/.memory-system/starred.json` (NOT frontmatter) to avoid triggering `user_edited` semantics.
- **StarredItemSchema:** `{ path, section?, starred_at }` with Zod validation.
- **starItem(path, config, {section?}):** Dedup by composite `path::section` key, withLock + atomicWrite.
- **unstarItem(path, config, {section?}):** Removes by composite key.
- **isStarred(path, config, {section?}):** Boolean check.
- **loadStarred(config):** Returns all starred items.

---

## Electron App (NEW, Phase 5)

### Directory: `electron/`
Separate package with its own `package.json` (Node.js, not Bun). Built with electron-vite.

### Main Process (`electron/src/main/`)
| File | Purpose |
|------|---------|
| `index.ts` | App lifecycle, BrowserWindow (contextIsolation: true, nodeIntegration: false) |
| `ipc-handlers.ts` | 20 IPC handlers routing to file-reader, search, cli-bridge, file-ops |
| `file-reader.ts` | 12 reader functions + ported frontmatter/knowledge page parsers. Cross-platform via os.homedir(). Path traversal security on saveFile(). |
| `search.ts` | better-sqlite3 readonly FTS5 search across fts_knowledge, fts_sessions, fts_digests, fts_notes, fts_transcripts. Transcripts scored 0.5x. reopenSearchDb() for watcher. |
| `cli-bridge.ts` | `spawn('bun', ['run', CM_PATH, ...args, '--json'])` for topic add/remove and reflection |
| `file-ops.ts` | Direct mutations: review queue (approve/dismiss/flag), starred (star/unstar), user notes (create/save/delete) |
| `watcher.ts` | chokidar on ~/.memory-system/, 500ms awaitWriteFinish, 300ms debounce, ignores lock/cache/tmp |
| `types.ts` | Display-oriented TypeScript interfaces for IPC layer (no Zod) |
| `claude.ts` | Anthropic API: conversation state, 2 locally-fulfilled tools (search_knowledge_base, read_document), agentic loop (max 5 iterations). Requires ANTHROPIC_API_KEY env var. (Phase 5c) |

### Preload (`electron/src/preload/`)
- `index.ts` — contextBridge exposing ~28 typed IPC methods (25 from 5a/5b + 3 Claude from 5c). Exports `ElectronAPI` type.

### Renderer (`electron/src/renderer/`)
| File | Purpose |
|------|---------|
| `App.tsx` | Root layout: search bar, sidebar, content router (7 view types), Claude dialog, status bar, dialog modals |
| `stores/ui-store.ts` | Zustand: 5 sidebar tabs, 7 content view types, search/edit/reflection/dialog state |
| `hooks/*.ts` | 10 TanStack Query hooks (topics, knowledge-page, session-notes, digests, search, status, review-queue, starred, user-notes, file-watcher) |
| `components/layout/SearchBar.tsx` | Cmd+K, debounced FTS, keyboard nav, type-badged results dropdown |
| `components/layout/Sidebar.tsx` | 5 tabs (Topics, Recent, Starred, Notes, Review) with review badge count |
| `components/layout/StatusBar.tsx` | Last reflection time, topic count, unprocessed count, Run Reflection button, animated progress bar during reflection |
| `components/sidebar/*.tsx` | EncyclopediaTab (filterable), RecentTab (grouped by date), StarredTab, MyNotesTab, ReviewQueueTab |
| `components/content/KnowledgePage.tsx` | Confidence stripes + badges, section metadata, ActionToolbar on hover |
| `components/content/SessionNote.tsx` | Header card with topic tags + status badges |
| `components/content/DigestView.tsx` | Date header + markdown |
| `components/content/UserNote.tsx` | Inline title editing, delete confirmation |
| `components/content/ReviewQueue.tsx` | Grouped by type, approve/dismiss actions |
| `components/content/Editor.tsx` | Textarea with save/cancel, query invalidation |
| `components/content/MarkdownRenderer.tsx` | react-markdown + remark-gfm + rehype-highlight |
| `components/actions/ActionToolbar.tsx` | Verify, invalidate, flag, star on knowledge sections |
| `components/actions/InvalidateDialog.tsx` | Modal: reason → wraps in [INVALIDATED] annotation |
| `components/actions/FlagDialog.tsx` | Modal: reason → creates user_flag in review queue |
| `components/claude/ClaudeDialog.tsx` | Collapsible panel (Cmd+J), chat with Claude, markdown responses, tool usage badges, thinking animation. Requires ANTHROPIC_API_KEY. (Phase 5c) |
| `styles/global.css` | "Archival Precision" theme: warm dark tones, JetBrains Mono metadata, DM Sans body, amber accent, confidence tier stripes. ~1200 lines covering all components. |

### Build
- `electron-vite build` from `electron/` directory
- Outputs: `out/main/` (31KB), `out/preload/` (2.8KB), `out/renderer/` (1.4MB JS + 37KB CSS)
- **Gotcha:** better-sqlite3 on macOS needs `SDKROOT=$(xcrun --show-sdk-path) LDFLAGS="-L$(xcrun --show-sdk-path)/usr/lib" npm install`

### Dependencies
electron, electron-vite, better-sqlite3, chokidar, @tanstack/react-query, zustand, react 19, react-dom, react-markdown, remark-gfm, rehype-highlight, @anthropic-ai/sdk
