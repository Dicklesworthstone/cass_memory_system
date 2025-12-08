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

**Agent Commands** (designed for AI agents):

| Command | Purpose |
|---------|---------|
| `cm context "<task>" --json` | Get relevant rules + history for a task |
| `cm quickstart --json` | Explain the system (self-documentation) |

**Playbook Commands** (inspect and manage rules):

| Command | Purpose |
|---------|---------|
| `cm playbook list` | List active rules |
| `cm playbook get <id>` | Get detailed info for a rule |
| `cm playbook add "<content>"` | Add a new rule |
| `cm playbook remove <id>` | Deprecate a rule |
| `cm playbook export` | Export playbook as YAML |
| `cm playbook import <file>` | Import playbook from file |
| `cm top [N]` | Show N most effective bullets (default 10) |
| `cm stale --days N` | Find bullets without feedback in N days |
| `cm why <id>` | Show bullet origin evidence and reasoning |
| `cm stats --json` | Playbook health metrics |

**Learning Commands** (feedback and reflection):

| Command | Purpose |
|---------|---------|
| `cm reflect --days N` | Process recent sessions into rules |
| `cm mark <id> --helpful\|--harmful` | Manual feedback (prefer inline comments) |
| `cm outcome --status success\|failure\|mixed --rules <ids>` | Record session outcome |
| `cm outcome-apply` | Apply recorded outcomes to playbook |
| `cm validate "<rule>"` | Validate a proposed rule against history |
| `cm forget <id> --reason "<why>"` | Deprecate a rule permanently |
| `cm audit --days N` | Check sessions for rule violations |

**System Commands** (setup and diagnostics):

| Command | Purpose |
|---------|---------|
| `cm init` | Initialize configuration and playbook |
| `cm init --starter <name>` | Initialize with a starter playbook |
| `cm starters` | List available starter playbooks |
| `cm doctor --fix` | Check system health, optionally fix issues |
| `cm project --format agents.md` | Export rules for AGENTS.md |
| `cm usage` | Show LLM cost and usage statistics |
| `cm serve --port N` | Run MCP server for agent integration |

### Configuration

Config lives at `~/.cass-memory/config.json` (global) and `.cass/config.json` (repo).
Repo config overrides global config. Command-line flags override both.

**Environment Variables:**

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | API key for Anthropic (Claude) |
| `OPENAI_API_KEY` | API key for OpenAI |
| `GOOGLE_GENERATIVE_AI_API_KEY` | API key for Google Gemini |

**LLM Settings:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | string | `"anthropic"` | LLM provider: `anthropic`, `openai`, `google` |
| `model` | string | `"claude-sonnet-4-20250514"` | Model to use for reflection |
| `budget.dailyLimit` | number | `0.10` | Max daily LLM spend (USD) |
| `budget.monthlyLimit` | number | `2.00` | Max monthly LLM spend (USD) |

**Scoring Settings:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scoring.decayHalfLifeDays` | number | `90` | Days for feedback to decay to half value |
| `scoring.harmfulMultiplier` | number | `4` | Weight harmful feedback N× more than helpful |
| `scoring.minFeedbackForActive` | number | `3` | Min feedback to consider bullet "active" |
| `scoring.minHelpfulForProven` | number | `10` | Min helpful marks for "proven" status |
| `scoring.maxHarmfulRatioForProven` | number | `0.1` | Max harmful ratio for "proven" (10%) |

**Context Settings:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxBulletsInContext` | number | `50` | Max rules to return in context |
| `maxHistoryInContext` | number | `10` | Max history snippets to return |
| `sessionLookbackDays` | number | `7` | Days to search for related sessions |
| `minRelevanceScore` | number | `0.1` | Min relevance to include a bullet |

**Behavior Settings:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoReflect` | boolean | `false` | Auto-run reflection after sessions |
| `validationEnabled` | boolean | `true` | Validate new rules against history |
| `enrichWithCrossAgent` | boolean | `true` | Include other agents' sessions |
| `semanticSearchEnabled` | boolean | `false` | Enable embedding-based search |
| `dedupSimilarityThreshold` | number | `0.85` | Threshold for duplicate detection |

**Example config.json:**

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "budget": { "dailyLimit": 0.50, "monthlyLimit": 10.00 },
  "scoring": {
    "decayHalfLifeDays": 60,
    "harmfulMultiplier": 5
  },
  "maxBulletsInContext": 30,
  "enrichWithCrossAgent": false
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

## Troubleshooting

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `cass not found` | cass CLI not installed | Install from [cass repo](https://github.com/Dicklesworthstone/coding_agent_session_search) |
| `API key missing` | No LLM API key set | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` environment variable |
| `Playbook corrupt` | Invalid YAML in playbook | Run `cm doctor --fix` to attempt recovery |
| `Rate limited` | Too many LLM requests | Wait for retry (exponential backoff is automatic) |
| `Budget exceeded` | Daily/monthly limit hit | Check `cm usage`, adjust limits in config |
| `Config invalid` | Malformed config file | Validate JSON/YAML syntax, check schema |
| `Session not found` | Path doesn't exist | Verify path with `cass sessions` |

### Diagnostic Commands

```bash
# Check system health
cm doctor --json

# Verify configuration
cm doctor --fix

# Check LLM budget status
cm usage

# List playbook health
cm stats --json
```

### Recovery Steps

**Corrupted playbook:**
```bash
# 1. Check for backup
ls ~/.cass-memory/playbook.yaml.backup.*

# 2. Run doctor to diagnose
cm doctor

# 3. If needed, re-initialize
cm init --force
```

**Missing API key:**
```bash
# For Anthropic (recommended)
export ANTHROPIC_API_KEY="sk-ant-..."

# For OpenAI
export OPENAI_API_KEY="sk-..."

# Add to shell profile for persistence
echo 'export ANTHROPIC_API_KEY="..."' >> ~/.zshrc
```

**LLM-free mode:**
```bash
# Run without LLM calls (limited functionality)
CASS_MEMORY_LLM=none cm context "task" --json
```

---

## License

MIT. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

- **[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** — The foundation that makes cross-agent search possible
- **ACE Paper** — The Agentic Context Engineering framework that inspired the pipeline design
