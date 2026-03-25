# cass-memory

<div align="center">
  <img src="cm_illustration.webp" alt="cass-memory - Persistent memory for AI coding agents">
</div>

![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue.svg)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6.svg)
![Status](https://img.shields.io/badge/status-alpha-purple.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Persistent memory for AI coding agents.**
Automatically captures knowledge from coding sessions, organizes it into searchable knowledge pages, and serves it back to agents in new sessions — so every session builds on what came before.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Setup — Claude Code](#setup--claude-code)
- [MCP Tools](#mcp-tools)
- [CLI Reference](#cli-reference)
- [Electron App](#electron-app)
- [Architecture](#architecture)
- [Data Model](#data-model)
- [Configuration](#configuration)
- [Development](#development)

---

## Why This Exists

AI coding agents accumulate valuable knowledge through sessions: debugging strategies, architecture decisions, project-specific patterns, error resolutions. But this knowledge is:

1. **Trapped in sessions** — each conversation ends, context is lost
2. **Unstructured** — raw transcript logs aren't actionable
3. **Not queryable** — you can't search across past sessions for "how did we set up auth?"
4. **Subject to collapse** — naive summarization loses the specific details that matter (exact error messages, config paths, version numbers)

cass-memory solves this by building a **knowledge base** from your sessions automatically. On Monday morning, you start a Claude Code session and the agent already knows what you worked on last week — not a vague summary, but the specific files changed, decisions made, gotchas discovered, and problems solved.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                      RAW TRANSCRIPTS                                │
│   Claude Code session logs (~/.claude/projects/*/*.jsonl)           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ cm_snapshot (agent-provided, no API cost)
                            │ or LLM summarization (periodic job)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SESSION NOTES                                  │
│   Verbose markdown summaries — what changed, why, gotchas           │
│   (~/.memory-system/session-notes/*.md)                             │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ reflect (periodic or manual)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│   REFLECTOR (2 LLM calls)                                           │
│   Call 1: Extract playbook bullets + topic suggestions              │
│   Call 2: Generate/revise knowledge page prose + daily digest       │
│                           │                                         │
│   VALIDATOR → CURATOR (deterministic merge, NO LLM)                 │
└───────────────────────────┬─────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      KNOWLEDGE BASE                                 │
│   Knowledge pages │ Playbook bullets │ Daily digests │ User notes   │
│   (~/.memory-system/knowledge/, playbook.yaml, digests/)            │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ cm_context (single-pass, no LLM)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NEXT SESSION                                   │
│   Agent gets: relevant knowledge pages, session summaries,          │
│   playbook rules, user notes — ranked by relevance                  │
└─────────────────────────────────────────────────────────────────────┘
```

### The Two Capture Paths

**1. Agent-provided (primary, zero API cost):** During a session, the agent calls `cm_snapshot` via MCP with a structured summary. The agent IS the LLM — it has full context and produces the highest quality notes. This is the primary path.

**2. LLM-generated (safety net):** A periodic job or PreCompact hook reads raw transcripts and uses an LLM (Haiku for cost efficiency) to generate summaries. This catches sessions where `cm_snapshot` wasn't called. Large transcripts (>60K chars) use map-reduce summarization.

### Tiered Context Retrieval

When a new session starts, `cm_context` returns knowledge ranked by relevance:

- **Tier 1 (always):** Full knowledge page content for matching topics, matching user notes, unprocessed session note summaries
- **Tier 2 (if Tier 1 is thin):** Processed session note summaries with title, abstract, topics, date
- **On-demand:** Agent calls `cm_detail` for full document content on anything that looks relevant

Matching uses keyword extraction, semantic similarity (local embeddings, no API cost), and FTS body content search. No LLM call in the retrieval path.

---

## Installation

### Prerequisites

- **[Bun](https://bun.sh/)** — runtime (install: `curl -fsSL https://bun.sh/install | bash`)
- **LLM API Key** (optional, for reflection) — set `ANTHROPIC_API_KEY` in your environment or configure in the Electron app settings

### From Source

```bash
git clone https://github.com/DylanGnatz/cass_memory_system.git
cd cass_memory_system
bun install
```

### Verify

```bash
bun run src/cm.ts --version
bun run src/cm.ts doctor
```

### Initialize

```bash
# Creates ~/.memory-system/ directory structure, config, and playbook
bun run src/cm.ts init
```

---

## Setup — Claude Code

Three things to configure so sessions are automatically captured and knowledge flows back to new sessions.

### 1. MCP Server

Add to `~/.claude/.mcp.json` (global, works across all projects):

```json
{
  "mcpServers": {
    "cass-memory": {
      "command": "/path/to/cass_memory_system/scripts/mcp-stdio.sh"
    }
  }
}
```

Replace `/path/to/cass_memory_system` with the actual path to your clone.

This gives Claude Code access to `cm_context`, `cm_snapshot`, `cm_search`, `cm_detail`, and other MCP tools.

### 2. CLAUDE.md Instructions

Add to `~/.claude/CLAUDE.md` to instruct agents to use the memory system:

```markdown
## Context Retrieval — CHECK MEMORY FIRST

Before starting any task, call `cm_context` with a description of what you're about to do.
This returns knowledge from previous sessions — knowledge pages, session note summaries,
and user notes that are relevant to your task.

If the response includes session summaries that look relevant, call `cm_detail` with the
path to read the full session note.

## Session Notes — MANDATORY

You MUST call `cm_snapshot` repeatedly throughout the conversation, not just at the end.
If context compacts before you snapshot, everything learned in this session is permanently lost.

Call it after completing each significant subtask, before any commit, and when the
conversation is getting long. Provide:
- `abstract`: 1-2 sentence summary
- `topics`: array of topic slugs in kebab-case
- `content`: verbose markdown — what changed, how it works, why, gotchas, test results

Always tell the user you took a snapshot.
```

### 3. PreCompact Hook (Safety Net)

Add to `~/.claude/settings.json` to catch sessions where `cm_snapshot` wasn't called:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/cass_memory_system/scripts/pre-compact-snapshot.sh"
          }
        ]
      }
    ]
  }
}
```

The hook uses the LLM to summarize the transcript before context compaction. It's a no-op if `cm_snapshot` already captured the session (same byte offset tracking).

---

## MCP Tools

These tools are available to agents when the MCP server is configured.

| Tool | Purpose | API Cost |
|------|---------|----------|
| `cm_context` | Get relevant knowledge for a task — knowledge pages, session summaries, playbook rules, user notes | None |
| `cm_snapshot` | Save session notes from within a conversation — agent provides the content directly | None |
| `cm_detail` | Read full content of any document (knowledge page, session note, digest) | None |
| `cm_search` | Full-text search across knowledge, sessions, digests, transcripts, playbook | None |
| `cm_feedback` | Record helpful/harmful feedback on a knowledge section or playbook rule | None |
| `cm_outcome` | Record session outcome for shown rules | None |
| `memory_reflect` | Trigger reflection pipeline on recent sessions | LLM calls |

### MCP Resources

| URI | Content |
|-----|---------|
| `cm://topics` | List of all topics with metadata |
| `cm://knowledge/{topic}` | Full knowledge page for a topic |
| `cm://digest/{date}` | Daily digest for a specific date |
| `cm://today` | Today's digest |
| `cm://status` | System status — last reflection, topic count, budget |

---

## CLI Reference

### Essential Commands

```bash
# Get context for a task (what cm_context does under the hood)
bun run src/cm.ts context "implement auth rate limiting" --json

# Generate session notes from transcripts
bun run src/cm.ts snapshot --json

# Run reflection pipeline (extract knowledge from session notes)
bun run src/cm.ts reflect --json

# Run full periodic job (scan + reflect + cleanup)
bun run src/cm.ts reflect --full --json

# System health check
bun run src/cm.ts doctor

# Show LLM cost and usage
bun run src/cm.ts usage
```

### Topic Management

```bash
# List topics
bun run src/cm.ts topic list

# Add a user-defined topic
bun run src/cm.ts topic add my-topic --name "My Topic" --description "What this covers"

# Add a sub-page to a topic
bun run src/cm.ts topic add-subpage my-topic sub-page-name --name "Sub Page" --description "..."

# Generate knowledge page for an approved topic
bun run src/cm.ts topic generate my-topic

# Remove a topic
bun run src/cm.ts topic remove my-topic
```

### Playbook Commands

```bash
# List all active rules
bun run src/cm.ts playbook list

# Add a rule manually
bun run src/cm.ts playbook add "Always run tests before committing"

# Show top rules by score
bun run src/cm.ts top 10

# Find stale rules
bun run src/cm.ts stale --days 60

# Record feedback
bun run src/cm.ts mark b-8f3a2c --helpful
bun run src/cm.ts mark b-xyz789 --harmful --reason "Caused regression"

# Export playbook
bun run src/cm.ts playbook export > backup.yaml
```

### All Commands

| Command | Purpose |
|---------|---------|
| `context <task>` | Get relevant knowledge for a task |
| `snapshot` | Generate/update session notes from transcripts |
| `reflect` | Run reflection pipeline |
| `topic` | Manage knowledge topics (add, list, remove, generate) |
| `doctor` | System health check and auto-fix |
| `playbook` | Manage playbook rules (list, add, remove, export, import) |
| `mark <id>` | Record helpful/harmful feedback |
| `similar <query>` | Find similar playbook bullets |
| `validate <rule>` | Validate a proposed rule against history |
| `stats` | Playbook health metrics |
| `usage` | LLM cost and usage statistics |
| `serve` | Run HTTP MCP server |
| `mcp-stdio` | Run MCP server over stdin/stdout (for Claude Code) |
| `outcome` | Record session outcomes |
| `audit` | Audit sessions against playbook rules |

All commands support `--json` for machine-readable output and `--help` for usage details.

---

## Electron App

A desktop app for browsing, searching, editing, and managing the knowledge base.

### Features

- **Encyclopedia tab** — Browse topics, knowledge pages, and sub-pages. Add topics, delete topics, view source provenance.
- **Recent tab** — Session notes and daily digests, sorted by date.
- **Search** — Full-text search across all content types via SQLite FTS5.
- **Starred items** — Star any content for quick access.
- **User notes** — Create and edit your own notes, linked to topics.
- **Transcript browser** — View raw transcripts, generate session notes from old sessions.
- **Review queue** — Approve/dismiss topic suggestions, flag content for review, handle contradictions.
- **Settings** — API key management, daily/monthly budget limits.
- **Run Reflection** — Trigger the reflection pipeline from the UI with progress feedback.

### Running

```bash
cd electron
npm install
npm run dev
```

The app reads from `~/.memory-system/` (same data the CLI and MCP server use). File changes are watched and auto-refreshed.

---

## Architecture

### Design Principles

- **Files are the source of truth.** SQLite is a derived search index. Knowledge pages, session notes, and digests are markdown files that humans can read and edit.
- **Curator is deterministic.** No LLM in the merge step. This prevents context collapse where the system rewrites its own knowledge.
- **cm_context is single-pass.** FTS + semantic ranking only, no LLM selection call. Avoids feedback loops.
- **Reflector is two calls.** Structural/extractive (bullets) and generative/narrative (prose) are separate because multi-objective prompts degrade on all axes.
- **Knowledge pages are single documents** revised by the LLM, not append-only sections. Contradictions are flagged for user review rather than silently accumulated.
- **All file writes use `withLock()` + `atomicWrite()`** during the periodic job to prevent partial reads from the Electron app.

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Session notes | `src/session-notes.ts` | Transcript discovery, session note generation/extension, byte-offset tracking |
| Reflection | `src/reflect.ts` | Two-call Reflector prompts (Call 1: bullets + topics, Call 2: knowledge prose + digest) |
| Validation | `src/validate.ts` | Three-source evidence gate (session notes + knowledge pages + SQLite transcripts) |
| Curation | `src/curate.ts` | Deterministic delta merge — playbook bullets + knowledge page updates + digests |
| Knowledge pages | `src/knowledge-page.ts` | Topic directory model, sub-pages, CRUD, FTS indexing |
| Knowledge gen | `src/knowledge-gen.ts` | Generate-on-approval knowledge page creation from gathered content |
| Search | `src/search.ts` | SQLite FTS5 index — knowledge, sessions, transcripts, notes, digests |
| Context | `src/commands/context.ts` | Tiered retrieval — keyword + semantic + body content matching |
| MCP server | `src/commands/serve.ts` | MCP tools and resources |
| Orchestrator | `src/orchestrator.ts` | Pipeline coordination |
| Periodic job | `src/periodic-job.ts` | Timer, lock, full pipeline runner with budget checks |
| LLM | `src/llm.ts` | Multi-provider LLM abstraction (Anthropic, OpenAI, Google, Ollama) with per-step model routing |
| Cost tracking | `src/cost.ts` | Per-model pricing, daily/monthly budget limits |
| Review queue | `src/review-queue.ts` | Topic suggestions, contradictions, bloated pages, stale topics, user flags |
| Embeddings | `src/semantic.ts` | Local embeddings via Transformers.js (all-MiniLM-L6-v2, zero API cost) |

### Pipeline Model Routing

Extractive tasks use Haiku (cheaper, fast), generative tasks use Sonnet (higher quality):

| Step | Model | Why |
|------|-------|-----|
| Session note create/extend | Haiku | Extractive — summarizing transcript content |
| Diary from note | Haiku | Structural — reformatting session note into diary |
| Reflector Call 1 (bullets) | Haiku | Extractive — pulling patterns from structured input |
| Reflector Call 2 (prose) | Sonnet | Generative — writing coherent knowledge page revisions |
| Knowledge generation | Sonnet | Generative — synthesizing knowledge from multiple sources |

### Directory Layout

```
~/.memory-system/
├── config.json              # Configuration
├── playbook.yaml            # Playbook rules
├── state.json               # Processing state (offsets, timestamps)
├── search.db                # SQLite FTS5 search index
├── starred.json             # Starred items index
├── review-queue.json        # Pending review items
├── topics.json              # Topic definitions
├── knowledge/               # Knowledge pages (one directory per topic)
│   └── {topic-slug}/
│       ├── _index.md        # Main knowledge page
│       └── {sub-page}.md    # Sub-pages
├── session-notes/           # Session note markdown files
│   └── session-{uuid}.md
├── digests/                 # Daily digests
│   └── {date}.md
├── notes/                   # User-created notes
│   └── note-{id}.md
├── diary/                   # Internal diary entries (Reflector input)
│   └── diary-{uuid}.json
└── cost/                    # LLM cost tracking logs
```

---

## Data Model

### Session Note

Markdown with YAML frontmatter. The primary artifact from each coding session.

```yaml
---
id: session-abc12345-...
title: "Fix billing webhook auth issue"
source_session: ~/.claude/projects/.../abc12345.jsonl
last_offset: 45000
created: 2026-03-24T10:00:00Z
last_updated: 2026-03-24T14:30:00Z
abstract: "Fixed HMAC validation failure in staging by rotating webhook secret"
topics_touched: ["billing-api", "webhooks", "auth"]
processed: false
user_edited: false
---

## March 24, 2026 — 10:00

### Fix Billing Webhook Auth Issue

**What changed:**
- `src/webhooks/billing.ts`: Updated HMAC validation to use rotated secret...
...
```

### Knowledge Page

Markdown with YAML frontmatter. Coherent documents per topic, revised (not appended) by the LLM.

```yaml
---
topic: billing-api
last_updated: 2026-03-24
sources:
  - session-abc12345
  - session-def67890
---

# Billing API

The billing service uses Stripe webhooks for payment event processing...
```

### Playbook Bullet

Terse, confidence-tracked rules in `playbook.yaml`:

```yaml
bullets:
  - id: b-1234-abcd
    content: "Always check token expiry before other auth debugging"
    category: debugging
    kind: workflow_rule
    maturity: established
    helpfulCount: 5
    harmfulCount: 0
    feedbackEvents: [...]
```

Rules have a 90-day confidence half-life, 4x harmful multiplier, and automatic maturity progression (`candidate` → `established` → `proven`).

### Topic

User-defined or system-suggested, with optional sub-pages:

```json
{
  "slug": "billing-api",
  "name": "Billing API",
  "description": "Stripe integration, webhook handling, payment flows",
  "source": "user",
  "subpages": [
    { "slug": "webhooks", "name": "Webhook Handling", "description": "..." }
  ]
}
```

---

## Configuration

Configuration lives at `~/.memory-system/config.json`. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `provider` | `"anthropic"` | LLM provider (anthropic, openai, google, ollama) |
| `model` | `"claude-sonnet-4-20250514"` | Default model |
| `budget.dailyLimit` | `0.50` | Daily LLM spend cap (USD) |
| `budget.monthlyLimit` | `10.00` | Monthly LLM spend cap (USD) |
| `periodicJobIntervalHours` | `24` | How often the background job runs |
| `semanticSearchEnabled` | `true` | Use local embeddings for retrieval quality |

Per-step model overrides via `pipelineModels`:

```json
{
  "pipelineModels": {
    "sessionNoteCreate": "claude-haiku-4-5-20251001",
    "reflectorCall1": "claude-haiku-4-5-20251001",
    "reflectorCall2": "",
    "knowledgeGen": ""
  }
}
```

Empty string means "use the default model" (Sonnet).

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for LLM calls |
| `OPENAI_API_KEY` | OpenAI API key (alternative provider) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google API key (alternative provider) |

---

## Development

### Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **Schemas:** Zod for all data validation
- **LLM:** Vercel AI SDK (Anthropic, OpenAI, Google, Ollama)
- **Search:** SQLite FTS5 via bun:sqlite (built-in, zero external deps)
- **Embeddings:** Transformers.js (all-MiniLM-L6-v2, local, zero API cost)
- **Tests:** Bun test runner
- **CLI:** Commander.js
- **Electron:** electron-vite + React 19 + TanStack Query + Zustand

### Running Tests

```bash
bun test                           # Full suite (~2500 tests)
bun test test/session-notes.test   # Single file
bun test --watch                   # Watch mode
```

### Project Structure

```
src/                    # All source code
├── commands/           # CLI command implementations
├── types.ts            # All Zod schemas
├── session-notes.ts    # Session note lifecycle
├── reflect.ts          # Reflector prompts
├── curate.ts           # Deterministic Curator
├── search.ts           # SQLite FTS5 search index
├── knowledge-page.ts   # Knowledge page CRUD + topic management
├── orchestrator.ts     # Pipeline coordination
├── llm.ts              # LLM abstraction + per-step routing
├── cost.ts             # Budget tracking
├── semantic.ts         # Local embeddings
└── cm.ts               # CLI entry point

electron/               # Electron desktop app
├── src/main/           # Main process (file I/O, search, IPC)
├── src/preload/        # Context bridge
└── src/renderer/       # React UI

fork_dev_plans/         # Architecture spec + implementation log
test/                   # ~2500 tests
scripts/                # MCP server launcher, PreCompact hook
```

### Key Documentation

- [Architecture Plan](fork_dev_plans/v1_prototype_architecture.md) — comprehensive spec for the full system
- [Implementation Log](fork_dev_plans/implementation_log.md) — running record of what was built, divergences from plan, gotchas
- [Codebase Reference](fork_dev_plans/cass_codebase_reference.md) — known facts about each source file

---

## Acknowledgments

Forked from [CASS (Coding Agent Session Search)](https://github.com/Dicklesworthstone/cass_memory_system) by Jeffrey Emanuel. The fork retains CASS's scoring system, playbook management, LLM abstraction, file locking, and pipeline orchestration while adding knowledge pages, session notes, topic management, tiered context retrieval, an Electron app, and a fundamentally different approach to knowledge organization.

---

## License

MIT
