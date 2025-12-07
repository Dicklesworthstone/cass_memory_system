# 🧠 cass-memory

![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue.svg)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6.svg)
![Status](https://img.shields.io/badge/status-alpha-purple.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Universal memory system for AI coding agents.**
Transforms scattered agent sessions into persistent, cross-agent procedural memory—so every agent learns from every other agent's experience.

<div align="center">

```bash
# Works immediately, zero setup required
cass context "fix the authentication timeout bug"
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
cass context "implement user authentication"
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
cass config set llm.budget.daily 0.10
cass config set llm.budget.monthly 2.00

# Works without any LLM (keyword matching)
cass context "my task"  # Free, always works

# Opt-in to LLM enhancement
cass reflect --llm      # Uses LLM, tracks cost
```

### 🔒 Privacy-First

- **Local by default**: Everything stays on your machine
- **Cross-agent is opt-in**: Must explicitly enable agent sharing
- **No telemetry**: Zero network calls except optional LLM
- **Secret sanitization**: API keys, tokens, passwords auto-redacted

---

## 🚀 Quick Start

### Installation

```bash
# Using bun (recommended)
bun install -g cass-memory

# Or from source
git clone https://github.com/user/cass-memory
cd cass-memory
bun install
bun run build
```

### Basic Usage

```bash
# Get context for a task (main command)
cass context "fix the login timeout"

# Record feedback after a rule helps/hurts
cass mark rule-123 helpful
cass mark rule-456 harmful --reason "caused test failures"

# View your playbook
cass playbook

# Check system health
cass status
```

---

## 📋 Command Reference

### Core Commands (V1)

| Command | Purpose | Example |
|---------|---------|---------|
| `context <task>` | Get relevant rules + history for a task | `cass context "debug auth"` |
| `mark <rule> <feedback>` | Record helpful/harmful feedback | `cass mark rule-123 helpful` |
| `playbook` | List, add, or remove playbook rules | `cass playbook add "Always validate JWT"` |
| `status` | Check system health and statistics | `cass status` |
| `reflect` | Extract rules from recent sessions | `cass reflect --dry-run` |

### Context Command

```bash
# Basic usage
cass context "fix authentication timeout bug"

# JSON output (for agent consumption)
cass context "debug memory leak" --json

# Limit results
cass context "refactor API" --max-rules 10 --max-history 5
```

**Output includes:**
- Relevant playbook rules (scored by task relevance)
- Historical session snippets from cass
- Anti-patterns to avoid
- Suggested cass queries for deeper research

### Mark Command

```bash
# Mark as helpful (boosts confidence)
cass mark rule-123 helpful

# Mark as harmful (reduces confidence, may trigger inversion)
cass mark rule-456 harmful --reason "caused test failures"

# Include session for traceability
cass mark rule-789 helpful --session /path/to/session.jsonl
```

### Playbook Command

```bash
# List all active rules
cass playbook

# List with details (confidence scores, sources)
cass playbook --detailed

# Add a manual rule
cass playbook add "Always run tests before committing" --category testing

# Remove a rule
cass playbook remove rule-123

# Show statistics
cass playbook stats
```

### Status Command

```bash
# Quick health check
cass status

# Detailed diagnostics
cass status --full

# JSON output
cass status --json
```

**Output:**
```
╭─────────────────────────────────────────────────────────╮
│              CASS-MEMORY STATUS                         │
├─────────────────────────────────────────────────────────┤
│ SYSTEM HEALTH: ✓ Healthy                                │
│                                                         │
│ CASS INTEGRATION                                        │
│   ✓ cass found: /usr/local/bin/cass (v0.8.2)           │
│   ✓ 1,247 sessions indexed                             │
│                                                         │
│ PLAYBOOK                                                │
│   Rules: 45 active, 12 proven, 8 at risk               │
│   Anti-patterns: 7                                      │
│                                                         │
│ RECENT ACTIVITY                                         │
│   Last reflection: 2 hours ago                          │
│   Sessions processed: 156                               │
╰─────────────────────────────────────────────────────────╯
```

---

## 🤖 Agent Integration

### MCP Server Mode

cass-memory runs as an MCP (Model Context Protocol) server for seamless agent integration:

```typescript
// Agents can call these tools directly:
await mcp.callTool("cass_context", { task: "fix auth bug" });
await mcp.callTool("cass_feedback", { ruleId: "rule-123", helpful: true });
await mcp.callTool("cass_outcome", { sessionId: "...", success: true });
```

**MCP Configuration** (`~/.config/claude/mcp.json`):
```json
{
  "mcpServers": {
    "cass-memory": {
      "command": "cass-memory",
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
cass context "<task description>" --json
```

As you work, track rule usage:
- When a playbook rule helps: `cass mark <rule-id> helpful`
- When a playbook rule causes problems: `cass mark <rule-id> harmful --reason "why"`

### Memory Protocol

1. **PRE-FLIGHT**: Run `cass context` before non-trivial tasks
2. **REFERENCE**: Cite rule IDs when following them
   - Example: "Following [rule-123], I'll check token expiry first..."
3. **FEEDBACK**: Mark rules as helpful/harmful during work
4. **REFLECT**: Run `cass reflect` periodically to extract new learnings

### Quick Reference

| Command | Purpose |
|---------|---------|
| `cass context "task"` | Get relevant rules and history |
| `cass mark rule-123 helpful` | Record positive feedback |
| `cass mark rule-123 harmful` | Record negative feedback |
| `cass playbook` | View current rules |
```

---

## 🧬 Data Models

### Playbook Bullet (Rule)

```typescript
interface PlaybookBullet {
  id: string;                    // "rule-abc123"
  content: string;               // The actual rule text
  category: string;              // "testing", "git", "auth", etc.

  // Confidence tracking
  helpfulCount: number;
  harmfulCount: number;
  effectiveScore: number;        // Decay-adjusted score

  // Lifecycle
  maturity: "candidate" | "established" | "proven";
  isBlocked: boolean;            // If true, shown as anti-pattern

  // Provenance
  sourceSessions: string[];      // Which sessions contributed
  sourceAgents: string[];        // Which agents contributed
  createdAt: string;
  lastValidatedAt: string;
}
```

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
- [x] Zero-config quick start
- [x] Context command with relevance scoring
- [x] Feedback tracking (helpful/harmful)
- [x] Basic playbook management
- [x] MCP server mode
- [x] Cost controls

### V2 (Planned)
- [ ] Confidence decay algorithm
- [ ] Anti-pattern inversion
- [ ] Semantic search (local embeddings)
- [ ] Cross-agent learning (opt-in)
- [ ] Starter playbooks for common stacks

### V3 (Future)
- [ ] Team playbooks
- [ ] Analytics dashboard
- [ ] IDE integrations
- [ ] Webhook notifications

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
git clone https://github.com/user/cass-memory
cd cass-memory
bun install
bun run dev
```

### Running Tests

```bash
bun test
bun run typecheck
```

---

## 📜 License

MIT. See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** — The foundation that makes cross-agent search possible
- **ACE Paper** — The Agentic Context Engineering framework that inspired the pipeline design
- **GPT Pro proposal** — Scientific validation pattern
- **Gemini proposal** — Search pointers and tombstone mechanism
