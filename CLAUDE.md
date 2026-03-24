# Memory System — CASS Fork

## What This Is

A persistent memory system for LLM-assisted development. Forked from CASS (Coding Agent Session Search). Automatically captures knowledge from coding sessions, organizes it by topic into knowledge pages, and makes it queryable by agents (via MCP) and humans (via Electron app).

**Architecture plan:** [fork_dev_plans/v1_prototype_architecture.md](fork_dev_plans/v1_prototype_architecture.md) — this is the comprehensive spec. Read it before making architectural decisions.

**CASS codebase reference:** [fork_dev_plans/cass_codebase_reference.md](fork_dev_plans/cass_codebase_reference.md) — living document of what we know about the upstream CASS code. **Read this before modifying any preexisting CASS file.** Update it whenever you discover new facts about the codebase (function signatures, import chains, gotchas, line numbers, etc.).

## Core Pipeline

```
Raw transcript → Session note (.md, human-readable, append-only)
                      ↓
                 Diary entry (JSON, internal scaffold for Reflector)
                      ↓
                 Reflector Call 1: bullets + topic suggestions
                 Reflector Call 2: knowledge page prose + digest
                      ↓
                 Validator (3-source: session notes + knowledge pages + SQLite transcripts)
                      ↓
                 Curator (deterministic merge, NO LLM)
                      ↓
                 Knowledge pages + Playbook bullets + Daily digests
                      ↓
                 cm_context serves knowledge to next session (single-pass, no LLM)
```

## Key Design Decisions (Do Not Deviate Without Asking)

- **Reflector is two calls, not one.** Structural/extractive (bullets) and generative/narrative (prose) are separate because multi-objective prompts degrade on all axes.
- **Curator is deterministic.** No LLM rewriting of playbook or knowledge pages. This prevents context collapse.
- **Knowledge page dedup uses source session ID**, not semantic similarity. Different sources → always keep both. Same source → semantic dedup. This avoids silent information loss.
- **cm_context is single-pass.** FTS + semantic ranking only, no LLM selection call. Avoids feedback loops where bad retrieval → bad sessions → bad knowledge → worse retrieval.
- **Session note generator reads the full existing note** when appending. Not just the last N tokens.
- **Session note generator does NOT auto-invalidate.** The Validator catches contradictions; the user decides via review queue.
- **SQLite is the search index, files are the data.** Never store knowledge page sections as rows with confidence columns. SQLite is derived, markdown files are source of truth.
- **Reflector Call 2 sees full knowledge pages** but prompt guardrail anchors to session note as primary source: "Extract new information from the session — do not paraphrase existing knowledge page content."
- **All file writes use `withLock()` + `atomicWrite()`** during periodic job to prevent partial reads from Electron app.

## Build Phases

Current phase and status tracked in [fork_dev_plans/implementation_log.md](fork_dev_plans/implementation_log.md).

1. **Fork + Strip + Data Foundation** — Clean fork, extended types, SQLite search module
2. **Session Note Generation** — Transcript → session notes. Prompt iteration on real data.
3. **Reflection Pipeline** — Notes → diary → Reflector → Validator → Curator → knowledge pages
4. **Context Retrieval + Topics** — cm_context, topic management, periodic job timer
5. **Electron App** — UI for browsing, searching, editing knowledge base
6. **Integration Testing** — Full loop with real sessions

## Working With This Codebase

### Tech Stack
- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Schemas:** Zod for all data validation
- **LLM:** Vercel AI SDK (Anthropic, OpenAI, Google, Ollama)
- **Search:** SQLite FTS5 via bun:sqlite (built-in, zero external deps)
- **Embeddings:** Transformers.js (`all-MiniLM-L6-v2`, local, zero API cost)
- **Tests:** Bun test runner
- **CLI:** Commander.js (entry point: `src/cm.ts`)

### Key Directories
- `src/` — All source code
- `src/commands/` — CLI command implementations
- `~/.memory-system/` — Runtime data (knowledge pages, session notes, playbook, SQLite, etc.)
- `fork_dev_plans/` — Architecture spec and implementation log

### Running
```bash
bun test                    # Run tests
bun run src/cm.ts context "task description"   # Test context retrieval
bun run src/cm.ts reflect   # Trigger reflection
bun run src/cm.ts doctor    # Health checks
```

### Files You'll Touch Most
- `src/types.ts` — All Zod schemas. New types go here first.
- `src/orchestrator.ts` — Pipeline coordination. Where phases chain together.
- `src/reflect.ts` — Reflector prompts. Two-call split lives here.
- `src/curate.ts` — Deterministic Curator. New delta type handlers here.
- `src/search.ts` — SQLite FTS5 search index. Index/query knowledge, sessions, transcripts, notes, digests.
- `src/commands/context.ts` — cm_context retrieval logic.
- `src/commands/serve.ts` — MCP server tools and resources.
- `src/cm.ts` — CLI entry point. Update when adding/removing commands.

## Memory System — MANDATORY

IMPORTANT: You MUST call the `cm_snapshot` MCP tool at these points:
1. When you notice your context is getting large (before compaction happens)
2. At the end of any major task, feature, or debugging session
3. Before making a commit or opening a PR
4. If the user says they're done or wrapping up

This is how session knowledge is preserved across context boundaries. If you skip this,
the work done in this session will be lost.

When calling `cm_snapshot`, provide ALL of these fields:
- `abstract`: 1-2 sentence summary of what was accomplished this session
- `topics`: array of topic slugs in kebab-case (e.g. ["auth-setup", "billing-api"])
- `content`: markdown body capturing the essential knowledge from this session:
  - What was built or changed (with specific file paths)
  - Key decisions made and why
  - Problems encountered and how they were resolved
  - Any unfinished work or open questions

Do NOT wait to be asked. Do NOT skip this step. This is as important as committing code.

## Rules for the Agent

### CASS Codebase Knowledge
Before modifying any preexisting CASS file:
1. Read [fork_dev_plans/cass_codebase_reference.md](fork_dev_plans/cass_codebase_reference.md) for known facts about that file
2. If the file isn't documented there yet, read it thoroughly and add your findings before making changes
3. After any modification reveals new facts (import chains, gotchas, undocumented behavior), update the reference

This prevents us from breaking upstream code we don't fully understand.

### Starting a Phase
When asked to begin or continue a build phase, first:
1. Read [fork_dev_plans/implementation_log.md](fork_dev_plans/implementation_log.md) for prior work and open questions
2. Read the relevant section of [fork_dev_plans/v1_prototype_architecture.md](fork_dev_plans/v1_prototype_architecture.md)
3. Read [fork_dev_plans/cass_codebase_reference.md](fork_dev_plans/cass_codebase_reference.md) for known facts about files you'll touch
4. Briefly state your plan for the phase — what you'll do, in what order — and get confirmation before writing code

### Ask Before Deciding
When you encounter a decision not covered by the architecture plan — **ask the user**. Do not make assumptions about:
- Prompt wording for LLM calls (session note generator, Reflector, Validator, diary generator)
- Data format choices that differ from the plan
- Whether to simplify or skip a planned feature
- Anything involving the Electron app's UX behavior
- Trade-offs between quality and token cost

If the plan says X but the code suggests Y would be better, explain the conflict and ask.

### Implementation Log
Maintain [fork_dev_plans/implementation_log.md](fork_dev_plans/implementation_log.md) as a running record. After completing each significant piece of work, append an entry:

```markdown
### [Phase X] Description of what was done
**Date:** YYYY-MM-DD
**Files changed:** list of files
**Differs from plan:** Yes/No — if yes, explain what changed and why
**Gotchas encountered:** anything surprising, non-obvious, or that would trip up the next session
**Open questions:** anything unresolved that needs a decision
```

This log is critical for multi-session continuity. Future sessions read it to understand what's been built, what diverged from the plan, and what's unresolved.

### Validation Checkpoints
At the end of each build phase, tell the user exactly how to validate the work:
- What commands to run
- What output to expect
- What to manually inspect
- What "good" looks like vs warning signs

Format as a checklist the user can walk through:
```markdown
## Validation: Phase N
- [ ] `bun test` — all existing tests pass
- [ ] `bun run src/cm.ts doctor` — no errors
- [ ] Manual: inspect ~/.memory-system/knowledge/topic-name.md — sections have `id`, `confidence`, `source` metadata
- [ ] Manual: run cm_context with a real task, verify relevant results returned
```

### Code Style
- Prefer editing existing CASS files over creating new ones (except `search.ts` which is genuinely new)
- Match existing CASS patterns: Zod schemas in types.ts, CLI commands in commands/, prompts in llm.ts
- All LLM outputs validated against Zod schemas with retries (existing pattern in llm.ts)
- Use existing utilities from utils.ts — don't reinvent hashing, tokenization, keyword extraction
- Keep tests passing at every commit. Run `bun test` after changes.

### What NOT to Do
- Don't remove the `cost.ts` budget system — it guards the unsupervised periodic job
- Don't make the Curator use LLM calls — it must remain deterministic
- Don't store derived data in SQLite as source of truth — files are the source of truth
- Don't feed Reflector output back as Reflector input without the prompt guardrail
- Don't auto-invalidate session notes — contradictions go through the Validator → review queue
- Don't skip `withLock()` on file writes during the periodic job
- Don't add an LLM call to cm_context retrieval (deferred to v2)
