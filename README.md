# cass-memory

![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue.svg)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6.svg)
![Status](https://img.shields.io/badge/status-alpha-purple.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Procedural memory for AI coding agents.**
A system that transforms scattered agent sessions into persistent, cross-agent memory—so every agent learns from every other agent's experience.

> **For Agents**: This system is designed FOR you. See [AGENTS.md Integration](#agentsmd-integration) for the blurb to add to your project.
>
> **For Operators**: Humans configure and monitor this system; agents consume it. See [Operator Guide](#operator-guide).

---

## How Agents Use This System

### The One Command You Need

```bash
cm context "<your task>" --json
```

That's it. Before starting any non-trivial task, run this command. It returns:
- **Relevant rules** from the playbook (scored by task relevance)
- **Historical context** from past sessions (yours and other agents')
- **Anti-patterns** to avoid (things that have caused problems)
- **Suggested searches** for deeper investigation

### Example

```bash
cm context "fix the authentication timeout bug" --json
```

```json
{
  "task": "fix the authentication timeout bug",
  "relevantBullets": [
    {
      "id": "b-8f3a2c",
      "content": "Always check token expiry before other auth debugging",
      "effectiveScore": 8.5,
      "maturity": "proven"
    }
  ],
  "antiPatterns": [
    {
      "id": "b-x7k9p1",
      "content": "Don't cache auth tokens without expiry validation",
      "effectiveScore": 3.2
    }
  ],
  "historySnippets": [
    {
      "source_path": "~/.claude/sessions/session-001.jsonl",
      "agent": "claude",
      "snippet": "Fixed timeout by increasing token refresh interval..."
    }
  ],
  "suggestedCassQueries": [
    "cass search 'authentication timeout' --days 30"
  ]
}
```

### When to Use It

- **Before starting any non-trivial task**: Get context first
- **When stuck on a problem**: Check if it's been solved before
- **When considering an approach**: See if there are warnings against it

### What NOT to Do

You do NOT need to:
- Run `cm reflect` (automation handles this)
- Run `cm mark` for feedback (use inline comments instead—see below)
- Manually add rules to the playbook
- Worry about the learning pipeline

The system learns from your sessions automatically. Your job is just to query context before working.

### Inline Feedback (Optional)

When a rule helps or hurts during your work, you can leave inline feedback:

```typescript
// [cass: helpful b-8f3a2c] - this rule saved me from a rabbit hole

// [cass: harmful b-x7k9p1] - this advice was wrong for our use case
```

These comments are automatically parsed during reflection and update rule confidence.

---

## Architecture Overview

### Three-Layer Memory

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EPISODIC MEMORY (cass)                           │
│   Raw session logs from all agents — the "ground truth"             │
│   Claude Code │ Codex │ Cursor │ Aider │ Gemini │ ChatGPT │ ...    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ cass search
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY (Diary)                           │
│   Structured session summaries bridging raw logs to rules           │
│   accomplishments │ decisions │ challenges │ outcomes               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ reflect + curate (automated)
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PROCEDURAL MEMORY (Playbook)                     │
│   Distilled rules with confidence tracking                          │
│   Rules │ Anti-patterns │ Feedback │ Decay                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Cross-Agent Learning

Every agent contributes to shared memory:

```
Claude Code session    →  ┐
Cursor session         →  │→  Unified Playbook  →  All agents benefit
Codex session          →  │
Aider session          →  ┘
```

A pattern discovered in Cursor **automatically** helps Claude Code on the next session.

### Confidence Decay

Rules aren't immortal. A rule helpful 8 times in January but never validated since loses confidence over time:

- **90-day half-life**: Confidence halves every 90 days without revalidation
- **4x harmful multiplier**: One mistake counts 4x as much as one success
- **Maturity progression**: candidate → established → proven (based on validation count)

### Anti-Pattern Learning

Bad rules don't just get deleted—they become **warnings**:

```
"Cache auth tokens for performance"
    ↓ (3 harmful marks)
"PITFALL: Don't cache auth tokens without expiry validation"
```

---

## AGENTS.md Integration

Add this blurb to your project's `AGENTS.md`:

```markdown
## Memory System: cass-memory

Before starting complex tasks, retrieve relevant context:

```bash
cm context "<task description>" --json
```

This returns:
- **relevantBullets**: Rules that may help with your task
- **antiPatterns**: Pitfalls to avoid
- **historySnippets**: Past sessions that solved similar problems
- **suggestedCassQueries**: Searches for deeper investigation

### Protocol

1. **START**: Run `cm context "<task>" --json` before non-trivial work
2. **WORK**: Reference rule IDs when following them (e.g., "Following b-8f3a2c, checking token expiry first...")
3. **FEEDBACK**: Leave inline comments when rules help/hurt:
   - `// [cass: helpful b-xyz] - reason`
   - `// [cass: harmful b-xyz] - reason`
4. **END**: Just finish your work. Learning happens automatically.
```

---

## Operator Guide

This section is for humans who configure and maintain the system.

### Installation

**Prebuilt binaries (recommended)**
- macOS (Apple Silicon):
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-darwin-arm64 -o cm && chmod +x cm && sudo mv cm /usr/local/bin/`
- macOS (Intel):
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-darwin-x64 -o cm && chmod +x cm && sudo mv cm /usr/local/bin/`
- Linux (x64):
  `curl -L https://github.com/Dicklesworthstone/cass_memory_system/releases/latest/download/cass-memory-linux-x64 -o cm && chmod +x cm && sudo mv cm /usr/local/bin/`
- Windows (x64):
  Download `cass-memory-windows-x64.exe` from the latest GitHub release and put it somewhere on your `%PATH%`.

**From source (Bun)**
```bash
git clone https://github.com/Dicklesworthstone/cass_memory_system.git
cd cass_memory_system
bun install
bun run build
sudo mv ./dist/cass-memory /usr/local/bin/cm
```

**Prerequisites**
- `cass` CLI installed and indexed (for history lookups)
- LLM API key set in environment (optional, for enhanced reflection)

**Verify install**
```bash
cm --version
cm doctor --json
```

### Initial Setup

```bash
# Initialize (creates global config and playbook)
cm init

# Or with a starter playbook for common patterns
cm init --starter typescript  # or: react, python, go
cm starters  # list available starters
```

### Automating Reflection

The key to the system is automated reflection. Set up a cron job or hook:

```bash
# Daily reflection on recent sessions
cm reflect --days 7 --json

# Or via cron (runs at 2am daily)
0 2 * * * /usr/local/bin/cm reflect --days 7 >> ~/.cass-memory/reflect.log 2>&1
```

For Claude Code users, add a post-session hook in `.claude/hooks.json`:
```json
{
  "post-session": ["cm reflect --days 1"]
}
```

### Commands Reference

| Command | Purpose | Audience |
|---------|---------|----------|
| `cm context "<task>" --json` | Get relevant rules + history | Agents |
| `cm quickstart` | Explain the system to an agent | Agents |
| `cm reflect --days N` | Process recent sessions into rules | Automation |
| `cm stats --json` | Playbook health metrics | Operators |
| `cm doctor --json` | System health check | Operators |
| `cm project --format agents.md` | Export for AGENTS.md | Operators |
| `cm audit --days N` | Check sessions for rule violations | Operators |
| `cm mark <id> --helpful\|--harmful` | Manual feedback (prefer inline) | Operators |
| `cm playbook` | View/manage rules | Operators |

### Configuration

Config lives at `~/.cass-memory/config.json` (global) and `.cass/config.json` (repo):

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "budget": { "daily": 0.10, "monthly": 2.00 }
  },
  "scoring": {
    "decayHalfLifeDays": 90,
    "harmfulMultiplier": 4
  },
  "features": {
    "crossAgent": false
  }
}
```

### Directory Structure

```
~/.cass-memory/                  # Global (user-level)
├── config.json                  # User configuration
├── playbook.yaml                # Personal playbook
├── diary/                       # Session summaries
└── outcomes/                    # Session outcomes

.cass/                           # Project-level (in repo)
├── config.json                  # Project overrides
├── playbook.yaml                # Project-specific rules
└── blocked.yaml                 # Anti-patterns to block
```

### Privacy & Security

- **Local by default**: All data stays on your machine
- **Secret sanitization**: API keys, tokens, passwords auto-redacted
- **No telemetry**: Zero network calls except optional LLM
- **Cross-agent is opt-in**: Must explicitly enable in config

---

## MCP Server (Advanced)

Run cass-memory as an MCP server for programmatic agent integration:

```bash
cm serve --port 3001
```

**Tools exposed:**
- `cm_context` — task → rules/history
- `cm_feedback` — record helpful/harmful
- `cm_outcome` — log session outcome

**MCP config** (`~/.config/claude/mcp.json`):
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

---

## Technical Reference

### Effective Score Calculation

```typescript
function getEffectiveScore(bullet: PlaybookBullet): number {
  const HARMFUL_MULTIPLIER = 4;
  const HALF_LIFE_DAYS = 90;

  const decayedHelpful = bullet.feedbackEvents
    .filter(e => e.type === "helpful")
    .reduce((sum, event) => {
      const daysAgo = daysSince(event.timestamp);
      return sum + Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
    }, 0);

  const decayedHarmful = bullet.feedbackEvents
    .filter(e => e.type === "harmful")
    .reduce((sum, event) => {
      const daysAgo = daysSince(event.timestamp);
      return sum + Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
    }, 0);

  return decayedHelpful - (HARMFUL_MULTIPLIER * decayedHarmful);
}
```

### ACE Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  GENERATOR   │ ──▶ │  REFLECTOR   │ ──▶ │   CURATOR    │
│              │     │              │     │              │
│ Pre-task     │     │ Pattern      │     │ Deterministic│
│ context      │     │ extraction   │     │ delta merge  │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │    VALIDATOR     │
                  │                  │
                  │ Evidence check   │
                  │ against cass     │
                  └──────────────────┘
```

- **Generator**: `cm context` hydrates rules by scoring playbook against task keywords
- **Reflector**: `cm reflect` extracts patterns from unprocessed sessions
- **Validator**: Evidence gate against cass history (optional LLM check)
- **Curator**: Deterministic merge—NO LLM (prevents context collapse)

### Maturity State Machine

```
  ┌──────────┐       ┌─────────────┐    ┌────────┐
  │ candidate│──────▶│ established │───▶│ proven │
  └──────────┘       └─────────────┘    └────────┘
       │                   │                  │
       │                   │ (harmful >25%)   │
       │                   ▼                  │
       │             ┌─────────────┐          │
       └────────────▶│ deprecated  │◀─────────┘
                     └─────────────┘
```

- **candidate → established**: 3+ helpful, low harm ratio
- **established → proven**: 5+ helpful, very low harm ratio
- **any → deprecated**: Harmful ratio exceeds 25%

### Graceful Degradation

| Condition | Behavior |
|-----------|----------|
| No cass | Playbook-only scoring, no history snippets |
| No playbook | Empty playbook, commands still work |
| No LLM | Deterministic reflection, no semantic enhancement |
| Offline | Cached playbook + local diary |

---

## Development

```bash
git clone https://github.com/Dicklesworthstone/cass_memory_system.git
cd cass_memory_system
bun install

# Dev with hot reload
bun --watch run src/cass-memory.ts <command>

# Tests
bun test
bun test --watch

# Type check
bun run typecheck

# Build all platforms
bun run build:all
```

---

## License

MIT. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

- **[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** — The foundation that makes cross-agent search possible
- **ACE Paper** — The Agentic Context Engineering framework that inspired the pipeline design
