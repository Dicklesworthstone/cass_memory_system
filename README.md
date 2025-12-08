# 🧠 cass-memory

![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue.svg)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6.svg)
![Status](https://img.shields.io/badge/status-alpha-purple.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Universal memory system for AI coding agents.**
Transforms scattered agent sessions into persistent, cross-agent procedural memory—so every agent learns from every other agent's experience.

> **Naming Note**: `cm` is the CLI command (short for **c**ass-**m**emory).
> This is distinct from [`cass`](https://github.com/Dicklesworthstone/coding_agent_session_search) (the session search tool that `cm` builds upon).

<div align="center">

```bash
# Works immediately, zero setup required
cm context "fix the authentication timeout bug"
```

</div>

---

## 💡 Why This Exists

### The Problem

AI coding agents are brilliant in the moment but **forget everything** between sessions:

- **Lost knowledge**: That elegant auth fix from last week? Gone. The agent will solve it from scratch.
- **Agent silos**: Claude Code doesn't know what Cursor learned. Codex doesn't know what Aider discovered.
- **No learning curve**: Your 100th session with an agent isn't smarter than your 1st.
- **Context collapse**: Naive "summarize everything" approaches lose critical details.

### The Solution

**cass-memory** implements a three-layer cognitive architecture that transforms raw session logs into actionable procedural memory:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EPISODIC MEMORY (cass)                           │
│   Raw session logs from all agents — the "ground truth"             │
│   Claude Code │ Codex │ Cursor │ Aider │ Gemini │ ChatGPT │ ...    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ cass search --robot
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY (Diary)                           │
│   Structured session summaries bridging raw logs to rules           │
│   accomplishments │ decisions │ challenges │ outcomes               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ reflect + curate
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PROCEDURAL MEMORY (Playbook)                     │
│   Distilled rules with confidence tracking                          │
│   Rules │ Anti-patterns │ Feedback │ Decay                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Who Benefits

| User | Value |
|------|-------|
| **Individual developers** | Your agents get smarter over time, remembering what works |
| **Teams** | Institutional knowledge survives across tool preferences |
| **AI agents themselves** | Query their own history + all other agents' learnings |
| **Power users** | Build workflows leveraging complete coding history |

---

## ✨ Key Features

### ⚡ Zero-Config Quick Start

No setup required. Just run it:

```bash
cm context "implement user authentication"
```

**Output** (even on day one):
```
## Relevant Past Work
Found 3 sessions matching your task:
  • [2h ago] Claude Code: JWT validation debugging
  • [Yesterday] Cursor: User model schema updates
  • [3d ago] Codex: Auth middleware implementation

## Playbook Rules (2 relevant)
  1. [8× helpful] Always check token expiry before other auth debugging
  2. [5× helpful] Use httpOnly cookies for session tokens, not localStorage

## Pitfalls to Avoid
  ⚠ Don't cache auth tokens without expiry validation (caused 3 bugs)
```

### 🔄 Cross-Agent Learning

Every agent contributes to shared memory:

```
Claude Code session    →  ┐
Cursor session         →  │→  Unified Playbook  →  All agents benefit
Codex session          →  │
Aider session          →  ┘
```

A pattern discovered in Cursor **automatically** helps Claude Code on the next session.

### 📊 Confidence Decay Algorithm

Rules aren't immortal. A rule helpful 8 times in January but never validated since loses confidence over time:

```typescript
// Effective score decays with a 90-day half-life
score = helpfulEvents.reduce((sum, event) => {
  const daysAgo = daysSince(event.timestamp);
  return sum + Math.pow(0.5, daysAgo / 90);  // Half-life decay
}, 0);
```

**Visual impact:**
```
Rule validated weekly:     ████████████ (12.0) — stays strong
Rule stale for 6 months:   ███ (3.2) — fading, needs revalidation
```

### 🛡️ Anti-Pattern Learning

Bad rules don't just get deleted—they become **warnings**:

```bash
# When a rule causes problems repeatedly, it inverts:
"Cache auth tokens for performance"
    ↓ (3 harmful marks)
"⚠ PITFALL: Don't cache auth tokens without expiry validation"
```

Your agents learn what NOT to do, not just what to do.

### 💰 LLM Cost Controls

Optional LLM features respect your budget:

```bash
# Set daily/monthly limits
cm config set llm.budget.daily 0.10
cm config set llm.budget.monthly 2.00

# Works without any LLM (keyword matching)
cm context "my task"  # Free, always works

# Opt-in to LLM enhancement
cm reflect --llm      # Uses LLM, tracks cost
```

### 🔒 Privacy-First

- **Local by default**: Everything stays on your machine
- **Cross-agent is opt-in**: Must explicitly enable agent sharing
- **No telemetry**: Zero network calls except optional LLM
- **Secret sanitization**: API keys, tokens, passwords auto-redacted

---

## 🚀 Quick Start

### Installation

Pick the path that fits your environment. Prebuilt binaries are fastest; source install is available if you’re hacking on the project.

**Prebuilt binaries (recommended)**
- macOS (Apple Silicon):  
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-darwin-arm64 -o cass-memory && chmod +x cass-memory && mv cass-memory /usr/local/bin/`
- macOS (Intel):  
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-darwin-x64 -o cass-memory && chmod +x cass-memory && mv cass-memory /usr/local/bin/`
- Linux (x64):  
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-linux-x64 -o cass-memory && chmod +x cass-memory && sudo mv cass-memory /usr/local/bin/`
- Windows (x64):  
  Download `cass-memory-windows-x64.exe` from the latest GitHub release and put it somewhere on your `%PATH%` (e.g., `C:\Tools\cass-memory.exe`).

**From source (Bun)**
```bash
git clone https://github.com/Dicklesworthstone/cass_memory_system.git
cd cass_memory_system
bun install
bun run build           # produces dist/cass-memory for your platform
./dist/cass-memory --version
```

**Global CLI via Bun**
```bash
bun install -g cass-memory
cass-memory --version
```

> Note: npm/yarn/pnpm are not supported in this repo. Use Bun for installs and scripts.

**Prerequisites**
- `cass` CLI installed and indexed (for history lookups)
- LLM API key set in environment (e.g., `export ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...`) if you plan to use LLM-powered features

**Verify install**
```bash
cass-memory --version
cass-memory doctor --json   # quick health check
```

**Common troubleshooting**
- “permission denied”: ensure the binary is executable (`chmod +x cass-memory`) and on your `PATH`.
- macOS “cannot be opened because the developer cannot be verified”: run `xattr -dr com.apple.quarantine cass-memory`.
- “cass not found”: install/index the `cass` CLI, or run commands that don’t require history until it’s available.
- No LLM key: commands degrade to local/keyword behavior; set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to enable LLM features.

### Command cheat sheet
- `cass-memory init --json` — create global config/playbook (use `--force` to reinit)
- `cass-memory context "<task>" --json` — get rules + history for a task
- `cass-memory mark <rule-id> --helpful|--harmful --reason "<why>" --json` — record feedback
- `cass-memory reflect --days 7 --json` — process recent sessions into playbook deltas
- `cass-memory stats --json` — playbook health summary
- `cass-memory doctor --json` — system health check (cass, LLM keys, file perms)
- `cass-memory project --format agents.md --output AGENTS.md` — export rules for agent prompts
- `cass-memory audit --days 7 --json` — check recent sessions for rule violations

### Typical workflow
1. `cass-memory init` (once per machine/repo).
2. Before a task: `cass-memory context "<task>" --json` and read the bullets/history.
3. Do the work; when a rule helps or hurts: `cass-memory mark <rule-id> --helpful|--harmful --reason "..."`
4. Periodically: `cass-memory reflect --days 7 --json` to add/improve rules.
5. Health check: `cass-memory doctor --json`; fix anything it reports.
6. Share with teammates/agents: `cass-memory project --format agents.md --output AGENTS.md`.

### Inline examples
- Debug auth timeout: `cass-memory context "authentication timeout" --json`
- Mark a helpful rule: `cass-memory mark b-abc123 --helpful --session ~/.claude/sessions/123.jsonl --json`
- Run reflection without LLM (local-only): `CASS_MEMORY_LLM=none cass-memory reflect --days 3 --json`

```bash
# Using bun (recommended)
bun install -g cm

# Or from source
git clone https://github.com/user/cass-memory
cd cass-memory
bun install
bun run build
```

### Basic Usage

```bash
# Get context for a task (main command)
cm context "fix the login timeout"

# Record feedback after a rule helps/hurts
cm mark rule-123 helpful
cm mark rule-456 harmful --reason "caused test failures"

# View your playbook
cm playbook

# Check playbook health metrics
cm stats

# Diagnose system health
cm doctor
```

---

## 🏗️ Architecture & Data Flow

- **CLI + MCP server**: The same codebase powers the human CLI (`cm`) and MCP tools for agents. Commands are thin wrappers over modules in `src/commands/*`, keeping behavior consistent across humans and agents.
- **ACE pipeline**: Generator → Reflector → Curator → Validator. Context hydration happens first; reflection extracts patterns; validation checks evidence; curation applies deltas deterministically (no LLM rewriting).
- **Three memory layers**:
  - *Episodic* (cass): raw session logs queried via `cass search --robot`.
  - *Working* (Diary): structured session summaries under `~/.cass-memory/diary/`.
  - *Procedural* (Playbook): distilled rules in global `~/.cass-memory/playbook.yaml` plus repo `.cass/playbook.yaml`, merged at runtime.
- **Deterministic merges**: Playbooks cascade global → repo; toxic blocklists prune unsafe content; deprecated patterns stay searchable but are excluded from active rules.
- **Cass wrappers**: `src/cass.ts` handles health checks, retries, index rebuilds, and timeout fallbacks so context/reflect degrade gracefully when search is slow or missing.

## 🔬 Algorithms & Scoring

- **Keyword relevance**: Tokens from the task are matched against rule text and tags (higher weight on tags) to produce a relevance score.
- **Confidence decay**: Each feedback event decays with a half-life (default 90 days). Effective score = decayed helpful − (harmful × multiplier). Harmful multiplier defaults to 4 to penalize bad rules harder.
- **Promotion gates**: Maturity progresses from candidate → established → proven based on helpful/harmful ratios and counts; pinned rules bypass pruning.
- **Deprecated/tombstones**: Deprecated patterns remain recorded with replacement suggestions so agents avoid regressions while still seeing provenance.
- **Suggested queries**: Task keywords generate cass search commands with varying lookback windows to deepen investigation without guessing queries.

## 🛡️ Operational Modes & Graceful Degradation

- **Full**: cass available + playbook loaded + optional LLM features.
- **No cass**: Context falls back to playbook-only scoring; warnings explain degraded mode; history/suggested searches are elided.
- **No playbook**: A fresh empty playbook is synthesized so commands remain functional.
- **No LLM**: Reflection/validation run in lightweight, deterministic mode; CLI remains usable without API keys.
- **Offline**: Cached playbook plus local diary files still fuel `cm context`; failures are surfaced as user-friendly warnings, not crashes.

## 🔒 Security & Privacy Model (practical details)

- **Local-first storage**: All state lives under `~/.cass-memory` and repo-local `.cass/`; no telemetry or external calls unless you opt into LLM.
- **Secret scrubbing**: Sanitization patterns strip common key formats (AWS, PATs, Bearer tokens, DB URLs, private keys) before storing diary/playbook text or sending to LLMs.
- **Blocked content**: Project and global `toxic*.log` files prevent previously flagged patterns from re-entering the playbook (semantic match with Jaccard similarity).
- **Provenance**: Bullets carry source sessions/agents so rules can be audited; feedback events include timestamps and optional reasons.

## 📦 Build & Distribution

- **Single-binary targets (bun --compile)**: `bun build src/cass-memory.ts --compile --target=linux-x64|darwin-arm64|windows-x64 --outfile dist/cass-memory-*` produces self-contained executables—no Bun or Node runtime required.
- **Current-platform dev build**: `bun run build` emits `dist/cass-memory` for your OS; binaries stay small and expose `--help`/`--version`.
- **Release flow**: Binaries land in `dist/` for attaching to GitHub releases; naming follows `cass-memory-linux`, `cass-memory-macos`, `cass-memory-windows.exe`, plus `cass-memory` for the local build.

## 🛠️ Developer Workflow (fast feedback)

- **Hot reload**: `bun --watch run src/cass-memory.ts <command>` restarts on source changes.
- **Type safety**: `bun run typecheck` (or `tsc --noEmit`) runs continuously with `--watch`.
- **Tests**: `bun test` and `bun test --watch` cover the suite; keep a watch pane open while iterating. For per-test timing and slow-test highlighting, use the bundled reporter: `bun test --reporter ./test/helpers/reporter.ts`.
- **Lint/format**: Prefer small, surgical edits over bulk codemods; follow existing style and avoid adding new lockfiles or toolchains.
- **DX principle**: All commands should deliver value within seconds on a clean machine; degraded modes must still return helpful output instead of failing hard.

### Troubleshooting (quick fixes)
- **"cass not found"**: Install and index cass CLI (`pipx install cass` or per cass docs) then rerun `cass health`; context/history will degrade until cass is available.
- **Binary not executable / permission denied**: `chmod +x dist/cass-memory*` (or downloaded binary) and ensure it’s on your `PATH`.
- **LLM API key missing**: Export `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (or set in `~/.cass-memory/config.json`); commands run in local-only mode without keys but LLM features will be skipped.
- **Rate limited or transient LLM errors**: Retry; built-in exponential backoff is applied. If persistent, lower frequency or switch provider/model in config.
- **Invalid config/playbook**: Run `cass-memory doctor --json` to surface schema issues; fix reported fields or remove the broken file to regenerate defaults (`cass-memory init --force`).
- **"session file not found" / empty history**: Ensure cass is indexed (`cass index`) and that your sessions reside where cass expects; provide `--workspace <path>` if you keep multiple workspaces.
- **macOS quarantine warning**: `xattr -dr com.apple.quarantine cass-memory*` after download.


## 🌐 MCP Server (Agent Integration)

- Start: `cm serve --host 127.0.0.1 --port 3001` (defaults to 127.0.0.1:3001; `MCP_HTTP_HOST` / `MCP_HTTP_PORT` envs also work).
- Protocol: JSON-RPC 2.0 over HTTP POST.
- Tools:
  - `cm_context` — task → rules/history (same scoring as CLI `context`).
  - `cm_feedback` — record helpful/harmful feedback for a bullet.
  - `cm_outcome` — log session outcome (success/failure/partial) plus rules used.
- List tools:
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```
- Call example:
```json
{
  "jsonrpc": "2.0",
  "id": "ctx1",
  "method": "tools/call",
  "params": {
    "name": "cm_context",
    "arguments": { "task": "fix authentication timeout", "top": 8, "history": 5 }
  }
}
```
- Responses include `result` or `error` (with code/message). Non-POST requests return HTTP 405.
- Storage: `cm_outcome` appends to `~/.cass-memory/outcomes/outcomes.jsonl`; context/feedback use the same merged config/playbook as the CLI.
- Transport: HTTP-only by design (stdio/SSE intentionally disabled to simplify sandboxing).

---

## 📋 Command Reference

### Core Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `context <task>` | Get relevant rules + history for a task | `cm context "debug auth"` |
| `mark <rule> <feedback>` | Record helpful/harmful feedback | `cm mark rule-123 helpful` |
| `playbook` | List, add, or remove playbook rules | `cm playbook add "Always validate JWT"` |
| `stats` | Show playbook health and score distribution | `cm stats` |
| `doctor` | Diagnose system health and configuration | `cm doctor --fix` |
| `reflect` | Extract rules from recent sessions | `cm reflect --dry-run` |
| `init` | Initialize configuration (optional—zero-config works without it) | `cm init` |

### Context Command

```bash
# Basic usage
cm context "fix authentication timeout bug"

# JSON output (for agent consumption)
cm context "debug memory leak" --json

# Limit results
cm context "refactor API" --max-rules 10 --max-history 5
```

**Output includes:**
- Relevant playbook rules (scored by task relevance)
- Historical session snippets from cass
- Anti-patterns to avoid
- Suggested cass queries for deeper research

### Mark Command

```bash
# Mark as helpful (boosts confidence)
cm mark rule-123 helpful

# Mark as harmful (reduces confidence, may trigger inversion)
cm mark rule-456 harmful --reason "caused test failures"

# Include session for traceability
cm mark rule-789 helpful --session /path/to/session.jsonl
```

### Playbook Command

```bash
# List all active rules
cm playbook

# List with details (confidence scores, sources)
cm playbook --detailed

# Add a manual rule
cm playbook add "Always run tests before committing" --category testing

# Remove a rule
cm playbook remove rule-123

# Show statistics
cm playbook stats
```

### Stats Command

```bash
# Show playbook health dashboard
cm stats

# JSON output for programmatic use
cm stats --json
```

**Output:**
```
📊 Playbook Health Dashboard
Total Bullets: 45

By Scope:
  global: 32
  workspace: 13

By State:
  proven: 12
  established: 25
  candidate: 8

Score Distribution:
  🌟 Excellent (>10): 8
  ✅ Good (5-10):    15
  ⚪ Neutral (0-5):  17
  ⚠️  At Risk (<0):   5

🏆 Top Performers (effective score):
  1. [rule-abc123] Always validate JWT before... (15.2)
  2. [rule-def456] Check token expiry first... (12.8)
```

### Doctor Command

```bash
# Diagnose system health
cm doctor

# Auto-fix detected issues
cm doctor --fix

# JSON output
cm doctor --json
```

**Output:**
```
🏥 System Health Check

✅ Cass Integration: cass CLI found at /usr/local/bin/cass
✅ Storage: Playbook: Found, Diary: Found
✅ LLM Configuration: Provider: anthropic, API Key: Configured
✅ Repo .cass/ Structure: Found with playbook.yaml
⚠️  Sanitization Pattern Health: 1 potentially broad pattern
   - Bearer token pattern may cause false positives
     Suggestion: Consider tightening with explicit delimiters
```

---

## 🤖 Agent Integration

### MCP Server Mode

cass-memory runs as an MCP (Model Context Protocol) server for seamless agent integration:

```typescript
// Agents can call these tools directly:
await mcp.callTool("cm_context", { task: "fix auth bug" });
await mcp.callTool("cm_feedback", { ruleId: "rule-123", helpful: true });
await mcp.callTool("cm_outcome", { sessionId: "...", success: true });
```

**MCP Configuration** (`~/.config/claude/mcp.json`):
```json
{
  "mcpServers": {
    "cm": {
      "command": "cm",
      "args": ["serve"]
    }
  }
}
```

### AGENTS.md Integration

Add this to your project's `AGENTS.md`:

```markdown
## Memory System: cass-memory

Before starting complex tasks, retrieve relevant context:
```bash
cm context "<task description>" --json
```

As you work, track rule usage:
- When a playbook rule helps: `cm mark <rule-id> helpful`
- When a playbook rule causes problems: `cm mark <rule-id> harmful --reason "why"`

### Memory Protocol

1. **PRE-FLIGHT**: Run `cm context` before non-trivial tasks
2. **REFERENCE**: Cite rule IDs when following them
   - Example: "Following [rule-123], I'll check token expiry first..."
3. **FEEDBACK**: Mark rules as helpful/harmful during work
4. **REFLECT**: Run `cm reflect` periodically to extract new learnings

### Quick Reference

| Command | Purpose |
|---------|---------|
| `cm context "task"` | Get relevant rules and history |
| `cm mark rule-123 helpful` | Record positive feedback |
| `cm mark rule-123 harmful` | Record negative feedback |
| `cm playbook` | View current rules |
```

---

## 🧬 Data Models

### Playbook Bullet (Rule)

```typescript
interface PlaybookBullet {
  id: string;                    // "b-abc123xyz"
  content: string;               // The actual rule text
  category: string;              // "testing", "git", "auth", etc.
  kind: "rule" | "anti_pattern"; // Positive guidance vs pitfall to avoid

  // Confidence tracking (with decay)
  feedbackEvents: FeedbackEvent[];  // Full history with timestamps
  helpfulCount: number;             // Computed from feedbackEvents
  harmfulCount: number;

  // Lifecycle
  maturity: "candidate" | "established" | "proven" | "deprecated";
  state: "draft" | "active" | "retired";

  // Pinning (protection from auto-deprecation)
  pinned: boolean;
  pinnedReason?: string;

  // Provenance
  sourceSessions: string[];      // Which sessions contributed
  sourceAgents: string[];        // Which agents contributed
  createdAt: string;
  lastValidatedAt: string;
}

interface FeedbackEvent {
  type: "helpful" | "harmful";
  timestamp: string;             // ISO-8601 for decay calculation
  sessionId?: string;
  reason?: string;
}
```

#### Maturity State Machine

Rules progress through maturity states based on validation:

```
                    ┌────────────────────────────────────────┐
                    │                                        │
  ┌──────────┐      │    ┌─────────────┐    ┌────────┐      │
  │ candidate│──────┼───▶│ established │───▶│ proven │      │
  └──────────┘      │    └─────────────┘    └────────┘      │
       │            │          │                  │          │
       │            │          │ (harmful ratio   │          │
       │            │          │  exceeds 25%)    │          │
       │            │          ▼                  │          │
       │            │    ┌─────────────┐          │          │
       └────────────┼───▶│ deprecated  │◀─────────┘          │
                    │    └─────────────┘                     │
                    │          │                             │
                    │          │ (if pinned,                 │
                    │          │  stays active)              │
                    │          ▼                             │
                    │    ┌─────────────┐                     │
                    │    │   (pinned)  │ bypasses retirement │
                    │    └─────────────┘                     │
                    └────────────────────────────────────────┘
```

**Transitions:**
- **candidate → established**: 3+ helpful events, low harm ratio
- **established → proven**: 5+ helpful events, very low harm ratio
- **any → deprecated**: Harmful ratio exceeds 25% threshold (unless pinned)

### Effective Score Calculation

```typescript
function getEffectiveScore(bullet: PlaybookBullet): number {
  const HARMFUL_MULTIPLIER = 4;  // One mistake = 4× one success
  const HALF_LIFE_DAYS = 90;     // Confidence halves every 90 days

  const decayedHelpful = bullet.helpfulEvents.reduce((sum, event) => {
    const daysAgo = daysSince(event.timestamp);
    return sum + Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
  }, 0);

  const decayedHarmful = bullet.harmfulEvents.reduce((sum, event) => {
    const daysAgo = daysSince(event.timestamp);
    return sum + Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
  }, 0);

  return decayedHelpful - (HARMFUL_MULTIPLIER * decayedHarmful);
}
```

### Context Output Schema

```json
{
  "task": "fix authentication timeout",
  "rules": [
    {
      "id": "rule-abc123",
      "content": "Always check token expiry before other auth debugging",
      "category": "debugging",
      "effectiveScore": 8.5,
      "maturity": "proven",
      "relevanceScore": 0.92
    }
  ],
  "antiPatterns": [
    {
      "id": "rule-xyz789",
      "content": "AVOID: Caching auth tokens without expiry validation",
      "effectiveScore": 3.2
    }
  ],
  "history": [
    {
      "sessionPath": "~/.claude/projects/myapp/session-001.jsonl",
      "agent": "claude",
      "snippet": "Fixed timeout by increasing token refresh interval...",
      "relevance": 0.85
    }
  ],
  "suggestedQueries": [
    "cass search 'authentication timeout' --days 30",
    "cass search 'token refresh' --agent claude"
  ]
}
```

---

## 📁 Storage & Configuration

### Directory Structure

```
# Global (user-level)
~/.cass-memory/
├── config.json              # User configuration
├── playbook.json            # Personal playbook
├── diary/                   # Diary entries
│   └── *.json
├── curation-log.jsonl       # Operation history (for undo)
└── usage/                   # Cost tracking
    └── 2025-01.json

# Project-level (committed to git)
.cass/
├── playbook.json            # Project-specific rules
├── config.json              # Project overrides
└── blocked.json             # Project anti-patterns
```

### Cascading Configuration

Rules merge from multiple sources:

```
Global playbook (~/.cass-memory/playbook.json)
        ↓ merge
Project playbook (.cass/playbook.json)
        ↓ filter
Remove blocked patterns
        ↓
Final playbook for this session
```

**Value**: A new developer cloning the repo instantly inherits the project's learned knowledge.

### Configuration Options

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "budget": {
      "daily": 0.10,
      "monthly": 2.00
    }
  },
  "features": {
    "crossAgent": false,
    "semanticSearch": false
  },
  "decay": {
    "halfLifeDays": 90,
    "harmfulMultiplier": 4
  }
}
```

---

## 🔐 Security

### Secret Sanitization

All content is sanitized before storage:

```typescript
const SECRET_PATTERNS = [
  // AWS keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_ACCESS_KEY]" },

  // API tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g, replacement: "[BEARER_TOKEN]" },

  // GitHub PATs
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: "[GITHUB_PAT]" },

  // Private keys
  { pattern: /-----BEGIN.*PRIVATE KEY-----[\s\S]+?-----END.*PRIVATE KEY-----/g,
    replacement: "[PRIVATE_KEY]" },

  // Database URLs with credentials
  { pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/gi,
    replacement: "$1://[USER]:[PASS]@" }
];
```

#### Sanitization Application Points (P12)

- **After cass export, before any LLM call**: sanitize raw session content before prompting to prevent secret echoing.
- **Before persisting DiaryEntry**: run `sanitize()` on diary text so logs on disk never contain secrets.
- **Before creating PlaybookBullet**: sanitize bullet content/evidence; store only cleaned text.
- **Context output guard**: validate that hydrated bullets/snippets are already sanitized (defense in depth).

Golden rule: never send or persist unsanitized session content—sanitize upstream and verify downstream.

### Privacy Model

| Feature | Default | Privacy Impact |
|---------|---------|----------------|
| Local storage | ✅ On | All data stays on your machine |
| Cross-agent | ❌ Off | Must opt-in to share between agents |
| LLM calls | ❌ Off | Must opt-in, costs tracked |
| Telemetry | ❌ None | No analytics, no phone-home |

---

## 🔄 The ACE Pipeline

cass-memory implements the ACE (Agentic Context Engineering) pattern:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ACE PIPELINE                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐        │
│  │  GENERATOR   │ ──▶ │  REFLECTOR   │ ──▶ │   CURATOR    │        │
│  │              │     │              │     │              │        │
│  │ Pre-task     │     │ Pattern      │     │ Deterministic│        │
│  │ context from │     │ extraction   │     │ delta merge  │        │
│  │ cass +       │     │ from         │     │ (NO LLM!)    │        │
│  │ playbook     │     │ sessions     │     │              │        │
│  └──────────────┘     └──────┬───────┘     └──────────────┘        │
│                              │                                      │
│                              ▼                                      │
│                    ┌──────────────────┐                            │
│                    │    VALIDATOR     │                            │
│                    │                  │                            │
│                    │ Scientific check │                            │
│                    │ against cass     │                            │
│                    │ history          │                            │
│                    └──────────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Generator (Pre-task Hydration)

Retrieves relevant context before starting work:
- Scores playbook rules by task relevance
- Queries cass for historical solutions
- Warns about deprecated patterns

### Reflector (Pattern Extraction)

Extracts learnings from completed sessions:
- Identifies reusable patterns
- Detects when existing rules helped/hurt
- Proposes rule updates

### Validator (Scientific Validation)

Validates proposed rules against historical evidence:
- Queries cass for supporting/contradicting evidence
- Rejects rules that contradict proven patterns
- Accepts rules with strong historical support

### Curator (Deterministic Merging)

Applies validated changes to the playbook:
- **NO LLM calls** (prevents context collapse)
- Deduplicates similar rules
- Handles conflicts deterministically
- Inverts harmful rules to anti-patterns

---

## 📈 Comparison with Alternatives

### vs. Prompt Engineering

| Approach | Persistence | Cross-Agent | Learns Over Time |
|----------|-------------|-------------|------------------|
| Custom prompts | ❌ Per-session | ❌ No | ❌ No |
| AGENTS.md | ✅ In repo | ❌ No | ❌ Manual |
| cass-memory | ✅ Everywhere | ✅ Yes | ✅ Automatic |

### vs. RAG Systems

| Approach | Setup | Relevance | Confidence |
|----------|-------|-----------|------------|
| Generic RAG | Complex | Low (retrieval noise) | None |
| cass-memory | Zero-config | High (task-scored) | Tracked + decaying |

### vs. Fine-Tuning

| Approach | Cost | Iteration Speed | Reversible |
|----------|------|-----------------|------------|
| Fine-tuning | $$$ | Days | Difficult |
| cass-memory | Free | Immediate | Yes (undo) |

---

## 🛣️ Roadmap

### V1 (Current)
- [x] Zero-config quick start (works without `init`)
- [x] Context command with relevance scoring
- [x] Feedback tracking with timestamps (`feedbackEvents[]`)
- [x] Confidence decay algorithm (90-day half-life)
- [x] Anti-pattern inversion (harmful → "AVOID: ...")
- [x] Maturity state machine (candidate → established → proven)
- [x] Basic playbook management (list, add, remove, pin)
- [x] Graceful degradation (works without cass, LLM, or playbook)
- [x] Secret sanitization with pattern health checks
- [x] Multi-provider LLM fallback (anthropic → openai → google)
- [x] Cost controls

### V2 (Planned)
- [ ] MCP server mode for agent integration
- [ ] Semantic search (local embeddings)
- [ ] Cross-agent learning (opt-in)
- [ ] Starter playbooks for common stacks
- [ ] LLM cost tracking and budget controls

### V3 (Future)
- [ ] Team playbooks
- [ ] Analytics dashboard
- [ ] IDE integrations
- [ ] Webhook notifications

---

### Development Setup

```bash
git clone https://github.com/user/cass-memory
cd cass-memory
bun install

# Run directly from source (no build step)
bun run dev -- <command> [args]

# Hot reload while you edit
bun run dev:watch -- <command> [args]

# Continuous types/tests in separate terminals
bun run typecheck:watch
bun run test:watch
```

### Building Binaries

```bash
# Build host binary
bun run build

# Cross-compile
bun run build:linux
bun run build:macos-arm
bun run build:macos-x64
bun run build:windows

# All targets
bun run build:all
```

Artifacts write to `dist/` (e.g., `dist/cass-memory-darwin-arm64`, `dist/cass-memory-windows-x64.exe`).

### Running Tests

```bash
bun test
bun run typecheck
# With timing reporter
bun test --reporter ./test/helpers/reporter.ts
```

Test fixtures live under `test/fixtures/` (sample playbooks/config/diary), and reusable helpers under `test/helpers/` (`withTempDir`, factories, logger, timing reporter) to keep new tests lean and deterministic.

---

### Release Process (manual for now)

Use semantic versioning (x.y.z). Until automation lands, follow this checklist:
1. Update `package.json` version and add release notes to `CHANGELOG.md` under a dated section.
2. Run full checks: `bun run typecheck` and `bun test`.
3. Build binaries: `bun run build:all` (dist targets: darwin-arm64, darwin-x64, linux-x64, windows-x64.exe).
4. Smoke each binary: `./dist/cass-memory-* --version` and `--help` on their respective platforms.
5. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. Create GitHub release from the tag; upload the four binaries as assets and paste install commands (see Installation section).
7. (Optional) Announce release; future work: Homebrew/CI automation.

---

### Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and pending (Unreleased) changes.

---

## 📜 License

MIT. See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** — The foundation that makes cross-agent search possible
- **ACE Paper** — The Agentic Context Engineering framework that inspired the pipeline design
- **GPT Pro proposal** — Scientific validation pattern
- **Gemini proposal** — Search pointers and tombstone mechanism
