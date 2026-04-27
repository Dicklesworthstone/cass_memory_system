# CASS Memory System - Comprehensive Implementation Plan

## The "Best of All Worlds" Hybrid Design

This document synthesizes the best elements from four AI proposals (Claude, GPT Pro, Gemini, Grok) to create **cass-memory**: a universal, agent-agnostic reflection and memory system for coding agents. The system implements the ACE (Agentic Context Engineering) framework on top of cass's cross-agent session search capabilities.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Core Architecture](#core-architecture)
3. [Data Models](#data-models)
4. [CLI Commands](#cli-commands)
5. [The Reflection Pipeline](#the-reflection-pipeline)
6. [Integration with cass](#integration-with-cass)
7. [LLM Integration](#llm-integration)
8. [Storage & Persistence](#storage--persistence)
9. [Agent Integration](#agent-integration)
10. [Implementation Roadmap](#implementation-roadmap)
11. [Comparison with Individual Proposals](#comparison-with-individual-proposals)

---

## Executive Summary

### The Problem

AI coding agents accumulate valuable knowledge through sessions: debugging strategies, code patterns, user preferences, project-specific insights. But this knowledge is:

1. **Trapped in sessions** - Each session ends, context is lost
2. **Agent-specific** - Claude Code doesn't know what Cursor learned
3. **Unstructured** - Raw conversation logs aren't actionable
4. **Subject to collapse** - Naive summarization loses critical details

### The Solution

A three-layer memory architecture combining:

| Layer | Role | Implementation |
|-------|------|----------------|
| **Episodic Memory** | Raw ground truth from all agents | `cass` search |
| **Working Memory** | Structured session summaries | Diary entries |
| **Procedural Memory** | Distilled rules with tracking | Playbook bullets |

### Key Innovations Combined

| Innovation | Source | Description |
|------------|--------|-------------|
| **Scientific Validation** | GPT Pro | Validate rules against cass history before accepting |
| **Search Pointers** | Gemini | Compact playbook entries that reference cass queries |
| **Tombstone Mechanism** | Gemini | Explicit deprecation with replacement tracking |
| **Multi-iteration Reflection** | Claude/ACE | Iterative insight extraction prevents missing insights |
| **Deterministic Curation** | Claude/ACE | No LLM rewriting of playbook to prevent collapse |
| **Cross-agent Enrichment** | All | Query cass for patterns across all indexed agents |

---

## Core Architecture

### The "Cognitive Architecture" Model (from Gemini)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EPISODIC MEMORY (cass)                           │
│   Raw session logs from all agents - the "ground truth"            │
│   Claude Code │ Codex │ Cursor │ Aider │ Gemini │ ChatGPT │ ...    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ cass search --robot
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY (Diary Layer)                     │
│   Structured session summaries bridging raw logs to rules          │
│   accomplishments │ decisions │ challenges │ preferences           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ reflect + curate
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PROCEDURAL MEMORY (Playbook)                     │
│   Distilled rules with helpful/harmful tracking                    │
│   Bullets │ Counters │ Source Tracing │ Deprecation                │
└─────────────────────────────────────────────────────────────────────┘
```

### The ACE Pipeline (Generator → Reflector → Curator)

Following the ACE paper's modular design with key enhancements:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ACE PIPELINE                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐        │
│  │  GENERATOR   │ ──▶ │  REFLECTOR   │ ──▶ │   CURATOR    │        │
│  │              │     │              │     │              │        │
│  │ Pre-task     │     │ LLM insight  │     │ Deterministic│        │
│  │ hydration    │     │ extraction   │     │ delta merge  │        │
│  │ from cass +  │     │ with multi-  │     │ (NO LLM!)    │        │
│  │ playbook     │     │ iteration    │     │              │        │
│  └──────────────┘     └──────┬───────┘     └──────────────┘        │
│                              │                                      │
│                              ▼                                      │
│                    ┌──────────────────┐                            │
│                    │    VALIDATOR     │  ← GPT Pro innovation      │
│                    │                  │                            │
│                    │ Scientific check │                            │
│                    │ against cass     │                            │
│                    │ history          │                            │
│                    └──────────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

| Principle | Source | Implementation |
|-----------|--------|----------------|
| Context collapse prevention | ACE Paper | Deterministic curation, delta-only updates |
| Scientific validation | GPT Pro | Validate rules against cass history before accepting |
| Cross-agent learning | All | Query cass for patterns across all indexed agents |
| Helpful/harmful tracking | Claude/ACE | Counter-based bullet scoring with auto-pruning |
| Search pointers | Gemini | Compact playbook entries that reference cass queries |
| Tombstone mechanism | Gemini | Explicit deprecation with replacement tracking |
| Source tracing | Claude | Track which sessions contributed each bullet |

---

## Data Models

### Diary Entry Schema

```typescript
interface DiaryEntry {
  // Identity
  id: string;                    // "diary-{hash}"
  sessionPath: string;           // Original cass session path

  // Metadata
  timestamp: string;             // ISO 8601
  agent: string;                 // "claude" | "codex" | "cursor" | etc.
  workspace?: string;            // Project directory
  duration?: number;             // Session duration in seconds

  // Core content (Claude Diary pattern)
  status: "success" | "failure" | "mixed";
  accomplishments: string[];     // What was completed
  decisions: string[];           // Design/architecture choices
  challenges: string[];          // Problems encountered
  preferences: string[];         // User style/workflow revelations
  keyLearnings: string[];        // Reusable insights

  // Cross-agent enrichment (Gemini pattern)
  relatedSessions?: {
    sessionPath: string;
    agent: string;
    relevanceScore: number;
    snippet: string;
  }[];

  // Tagging for retrieval
  tags: string[];
  searchAnchors: string[];       // "SEO for agents" - optimized search terms
}
```

### Playbook Bullet Schema (Enhanced)

```typescript
interface PlaybookBullet {
  // Identity
  id: string;                    // "b-{timestamp36}-{random}"

  // Scope (ENHANCED: 4-level hierarchy)
  scope: "global" | "workspace" | "language" | "framework" | "task";
  scopeKey?: string;             // e.g. "typescript", "nextjs", "authentication"
  workspace?: string;            // If workspace-scoped

  // Content
  category: string;              // "testing" | "git" | "debugging" | etc.
  content: string;               // The actual rule/insight
  searchPointer?: string;        // Optional cass query for details (Gemini)

  // Type (NEW: Anti-patterns as first-class citizens)
  type: "rule" | "anti-pattern"; // Anti-patterns shown in "PITFALLS TO AVOID" section
  isNegative: boolean;           // Shorthand for type === "anti-pattern"

  // Kind (NEW: Semantic classification orthogonal to category)
  kind: "project_convention"     // "Use AuthService from @/lib/auth" - repo-specific
       | "stack_pattern"         // "For React hooks, test effects with renderHook" - portable
       | "workflow_rule"         // "Run pnpm test before committing" - process
       | "anti_pattern";         // "Don't mock Router hooks directly" - pitfall

  // Lifecycle State (SIMPLIFIED: replaces complex maturity for core flow)
  state: "draft" | "active" | "retired";
  // - draft: newly proposed, not yet proven (from reflect, low confidence)
  // - active: validated and in use (included in context by default)
  // - retired: deprecated/superseded (excluded from context, kept for history)

  // Maturity (DETAILED: progressive trust within "active" state)
  maturity: "candidate" | "established" | "proven" | "deprecated";
  // candidate: 0-2 helpful marks, still proving itself
  // established: 3+ helpful, < 5 harmful ratio
  // proven: 5+ helpful, strong track record
  // deprecated: retired, superseded (state = "retired")
  promotedAt?: string;           // When moved from candidate to established

  // Tracking (ENHANCED: Event-level granularity with decay)
  helpfulCount: number;
  harmfulCount: number;
  helpfulEvents: FeedbackEvent[];   // NEW: Individual events with timestamps
  harmfulEvents: FeedbackEvent[];   // NEW: For proper decay calculation
  lastValidatedAt?: string;         // NEW: When rule was last confirmed by cass
  confidenceDecayHalfLifeDays: number; // NEW: Default 90, per-bullet configurable

  // Lifecycle
  createdAt: string;
  updatedAt: string;
  pinned: boolean;               // NEW: Never auto-prune, even if harmful
  pinnedReason?: string;         // NEW: Why it's protected

  // Provenance (ENHANCED: Store reasoning chain)
  sourceSessions: string[];      // Session paths that contributed
  sourceAgents: string[];        // Which agents contributed
  reasoning?: string;            // NEW: Why this rule was created
  derivedFrom?: {                // NEW: Evidence chain
    diaryIds: string[];
    keyEvidence: string[];       // Quotes/snippets that led to this rule
  };

  // Verification (NEW: Code-based validation)
  verification?: {
    type: "regex" | "file_exists" | "cass_query";
    pattern: string;             // e.g., "import .* from '@internal/auth'"
    mode: "exists" | "absent";
  };

  // Tagging
  tags: string[];
}

// NEW: Individual feedback event with timestamp
interface FeedbackEvent {
  timestamp: string;             // ISO 8601
  sessionPath?: string;          // Which session triggered this
  reason?: HarmfulReason;        // For harmful events
  context?: string;              // Optional explanation
}

// NEW: Structured harmful reasons for better analysis
type HarmfulReason =
  | "caused_bug"
  | "wasted_time"
  | "contradicted_requirements"
  | "wrong_context"
  | "outdated"
  | "other";
```

### Confidence Decay Algorithm (CRITICAL NEW FEATURE)

This is the **single most important enhancement** - prevents the playbook from fossilizing.

```typescript
/**
 * Calculate decayed helpful count based on recency of events.
 * A rule that was helpful 8 times in January but never since June
 * will have dramatically lower effective score by December.
 */
function getDecayedScore(
  events: FeedbackEvent[],
  halfLifeDays: number = 90,
  now: number = Date.now()
): number {
  if (events.length === 0) return 0;

  return events.reduce((sum, event) => {
    const eventTime = new Date(event.timestamp).getTime();
    const daysSinceEvent = (now - eventTime) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.pow(0.5, daysSinceEvent / halfLifeDays);
    return sum + decayFactor;
  }, 0);
}

/**
 * Calculate effective score with:
 * 1. Harmful events weighted 4× more than helpful (one mistake >> one success)
 * 2. Confidence decay based on recency
 * 3. Maturity bonus for proven rules
 */
function getEffectiveScore(bullet: PlaybookBullet): number {
  const HARMFUL_MULTIPLIER = 4;  // One harmful = 4× one helpful

  const decayedHelpful = getDecayedScore(
    bullet.helpfulEvents,
    bullet.confidenceDecayHalfLifeDays
  );
  const decayedHarmful = getDecayedScore(
    bullet.harmfulEvents,
    bullet.confidenceDecayHalfLifeDays
  );

  const baseScore = decayedHelpful - (HARMFUL_MULTIPLIER * decayedHarmful);

  // Maturity bonus
  const maturityMultiplier = {
    candidate: 0.5,
    established: 1.0,
    proven: 1.5,
    deprecated: 0
  }[bullet.maturity];

  return baseScore * maturityMultiplier;
}

/**
 * Check if a bullet should be auto-promoted based on feedback.
 */
function checkForPromotion(bullet: PlaybookBullet): BulletMaturity {
  const score = getEffectiveScore(bullet);
  const recentHelpful = bullet.helpfulEvents.filter(e =>
    daysSince(e.timestamp) < 30
  ).length;

  if (bullet.maturity === "candidate" && score >= 2 && recentHelpful >= 1) {
    return "established";
  }
  if (bullet.maturity === "established" && score >= 5 && recentHelpful >= 2) {
    return "proven";
  }
  return bullet.maturity;
}
```

### Delta Schema (for incremental updates)

```typescript
type PlaybookDelta =
  | { type: "add"; bullet: NewBulletData; reason: string; sourceSession: string }
  | { type: "helpful"; bulletId: string; sourceSession?: string }
  | { type: "harmful"; bulletId: string; sourceSession?: string; reason?: string }
  | { type: "replace"; bulletId: string; newContent: string; reason: string }
  | { type: "deprecate"; bulletId: string; reason: string; replacedBy?: string }
  | { type: "merge"; bulletIds: string[]; mergedContent: string; reason: string };

interface NewBulletData {
  category: string;
  content: string;
  tags: string[];
  searchPointer?: string;
  scope: "global" | "workspace";
  workspace?: string;
}
```

### Playbook File Schema (YAML)

```yaml
schema_version: 2
name: "project-playbook"
description: "Auto-generated from cm reflections"

metadata:
  created_at: "2025-12-01T00:00:00Z"
  last_reflection: "2025-12-07T10:00:00Z"
  total_reflections: 42
  total_sessions_processed: 156

# Deprecated patterns that should be ignored (Gemini's tombstone mechanism)
deprecated_patterns:
  - pattern: "AuthHandler"
    deprecated_at: "2025-10-01"
    reason: "Moved to AuthService v2"
    replacement: "Use AuthService from @/lib/auth"

bullets:
  - id: "b-1a2b3c4d-x7y8"
    category: "testing"
    scope: "global"
    content: |
      For React hooks, test returned values and effects separately
      using renderHook from @testing-library/react-hooks
    search_pointer: "cass search 'react hook testing renderHook'"
    helpful_count: 8
    harmful_count: 1
    tags: ["react", "testing", "hooks"]
    source_sessions:
      - "~/.claude/projects/app/session-001.jsonl:142"
      - "~/.cursor/state.vscdb:session-xyz"
    source_agents: ["claude", "cursor"]
    created_at: "2025-11-15T14:30:00Z"
    updated_at: "2025-12-05T09:00:00Z"
```

---

## CLI Commands

### Command Overview

```
cm <command> [options]

Commands:
  init              Initialize configuration and playbook
  context           Get relevant context for a task (pre-flight hydration)
  diary             Generate structured diary from a session
  reflect           Run reflection cycle on recent sessions
  validate          Validate proposed rules against cass history (GPT Pro)
  curate            Apply deltas to playbook (deterministic)
  mark              Record bullet usage (helpful/harmful)
  audit             Check sessions for rule violations
  playbook          Manage playbook entries
  project           Export playbook to AGENTS.md/CLAUDE.md
  config            Manage configuration
  serve             Run as MCP server (future)

Global Options:
  --json            Output as JSON (for agent consumption)
  --quiet           Suppress diagnostic output
  --provider        AI provider (openai, anthropic, google)
  --model           Model to use
  --help            Show help
```

### Command: `context` (Pre-flight Hydration)

**Purpose**: Generate a "mission briefing" before starting a task (Gemini's hydration concept)

```bash
# Basic usage
cm context "Fix authentication timeout bug in auth.ts"

# With options
cm context "Debug memory leak" --workspace /path/to/project --max-bullets 20 --json

# From stdin (for piping from agents)
echo "Fix CORS headers" | cm context
```

**Process**:
1. Extract search terms from task description
2. Query cass for relevant historical sessions
3. Score and filter playbook bullets by relevance
4. Check deprecated_patterns for warnings
5. Generate formatted context prompt

**Output includes**:
- Relevant playbook bullets (scored by task relevance)
- Historical session snippets from cass
- Warnings about deprecated patterns
- **Anti-patterns to avoid** (NEW: "PITFALLS" section)
- Formatted prompt with usage tracking instructions

**Structured JSON Output** (default with `--json`, critical for agent integration):

```json
{
  "task": "Fix authentication timeout bug",
  "relevantBullets": [
    {
      "id": "b-abc123",
      "content": "For auth issues, check token expiry first",
      "category": "debugging",
      "type": "rule",
      "maturity": "proven",
      "effectiveScore": 4.2,
      "lastHelpful": "2 days ago",
      "reasoning": "Learned from session-xyz when JWT expired silently"
    }
  ],
  "antiPatterns": [
    {
      "id": "b-def456",
      "content": "AVOID: Caching auth tokens without expiry check",
      "type": "anti-pattern",
      "effectiveScore": 3.1
    }
  ],
  "historySnippets": [
    {
      "sessionPath": "~/.claude/projects/myapp/session-001.jsonl",
      "agent": "claude",
      "snippet": "Fixed timeout by increasing token refresh interval...",
      "relevance": 0.82
    }
  ],
  "deprecatedWarnings": [
    "AuthHandler class was deprecated - use AuthService instead"
  ],
  "suggestedCassQueries": [
    "cass search 'authentication timeout' --days 30",
    "cass search 'token refresh' --agent claude"
  ]
}
```

**Value**: Most agent integrations (Cursor, Continue.dev, Aider, Roo Code) consume JSON better than markdown. This makes deep integration essentially free.

### Command: `diary`

**Purpose**: Generate structured diary entry from a session

```bash
# Basic usage
cm diary /path/to/session.jsonl

# With cross-agent enrichment
cm diary /path/to/session.jsonl --enrich --json
```

**Process**:
1. Load session via cass export
2. Query cass for related sessions (cross-agent enrichment)
3. LLM extraction of structured diary fields
4. Save to ~/.cass-memory/diary/

### Command: `reflect`

**Purpose**: Run full reflection cycle on recent sessions

```bash
# Default: last 7 days
cm reflect

# Custom options
cm reflect --days 14 --max-sessions 20 --agent claude,cursor

# Dry run (show deltas without applying)
cm reflect --dry-run
```

**Process**:
1. Find unprocessed sessions via cass
2. Generate diary entries (if missing)
3. Run Reflector: LLM extracts candidate deltas
4. Run Validator: Check each delta against cass history (GPT Pro pattern)
5. Run Curator: Apply validated deltas deterministically
6. Update processed.log

### Command: `validate` (Scientific Validation - GPT Pro Innovation)

**Purpose**: Validate a proposed rule against historical evidence

```bash
cm validate "Always use httpx instead of requests for HTTP calls" --json
```

**Process**:
1. Extract validation keywords from the proposed rule
2. Query cass for historical evidence (last 90 days)
3. LLM analysis: Does evidence support or contradict?
4. Return verdict with evidence citations

**Output**:
```json
{
  "rule": "Always use httpx instead of requests for HTTP calls",
  "verdict": "ACCEPT",
  "confidence": 0.85,
  "evidence": [
    {"session": "~/.claude/...", "supports": true, "snippet": "..."},
    {"session": "~/.codex/...", "supports": true, "snippet": "..."}
  ],
  "reason": "Found 4 sessions where requests caused timeout issues, 0 issues with httpx"
}
```

### Command: `mark`

**Purpose**: Record bullet usage feedback

```bash
# Mark as helpful (default)
cm mark b-abc123

# Mark as harmful with reason
cm mark b-abc123 --harmful --reason "Caused regression in tests"

# Include session for traceability
cm mark b-abc123 --helpful --session /path/to/session.jsonl
```

### Command: `audit`

**Purpose**: Scan recent sessions for patterns that violate playbook rules

```bash
cm audit --days 7 --workspace /path/to/project
```

**Output**:
```json
{
  "violations": [
    {
      "bulletId": "b-xyz789",
      "bulletContent": "Always run tests before committing",
      "sessionPath": "/path/to/session.jsonl",
      "evidence": "Commit made without test run visible in session"
    }
  ]
}
```

### Command: `playbook`

**Purpose**: Manage playbook entries

```bash
# List all bullets
cm playbook list
cm playbook list --all  # Include deprecated

# Get bullet details
cm playbook get b-abc123

# Add manually
cm playbook add --category testing --tags jest,react \
  "For React hooks, test returned values and effects separately"

# Remove (soft delete by default)
cm playbook remove b-abc123
cm playbook remove b-abc123 --hard  # Permanent delete

# Export/Import
cm playbook export --yaml > playbook.yaml
cm playbook import playbook.yaml

# Statistics
cm playbook stats
```

### Command: `project`

**Purpose**: Export playbook to agent-specific format for AGENTS.md

```bash
# Generate AGENTS.md section
cm project --format agents.md --output ./AGENTS.md

# Top N per category
cm project --format claude.md --per-category 10

# Include helpful counts
cm project --show-counts
```

### Command: `forget` (NEW: Nuclear Option for Toxic Rules)

**Purpose**: Permanently block a rule and any semantically similar future rules

```bash
cm forget b-abc123 --reason "Caused production outage"
```

**Process**:
1. Immediately deprecate the bullet
2. Add to `toxic_bullets.log` with content hash + embedding
3. On future reflections, any new bullet with >0.85 similarity is auto-rejected
4. Optionally invert to anti-pattern: `--invert` flag

```typescript
interface ToxicEntry {
  bulletId: string;
  content: string;
  contentHash: string;
  embedding?: number[];        // For semantic similarity blocking
  reason: string;
  timestamp: string;
  invertedTo?: string;         // ID of the anti-pattern created
}

async function forgetBullet(
  bulletId: string,
  reason: string,
  options: { invert?: boolean; global?: boolean }
): Promise<void> {
  const bullet = await findBullet(bulletId);
  if (!bullet) throw new Error(`Bullet not found: ${bulletId}`);

  // 1. Deprecate
  bullet.maturity = "deprecated";
  bullet.deprecationReason = `TOXIC: ${reason}`;

  // 2. Add to toxic log
  const toxicEntry: ToxicEntry = {
    bulletId,
    content: bullet.content,
    contentHash: hashContent(bullet.content),
    embedding: await embedText(bullet.content),
    reason,
    timestamp: now()
  };

  // 3. Optionally create anti-pattern
  if (options.invert) {
    const antiPattern = await invertToAntiPattern(bullet, reason);
    toxicEntry.invertedTo = antiPattern.id;
  }

  const logPath = options.global
    ? "~/.cass-memory/toxic_bullets.log"
    : "./.cass/toxic.log";

  await appendToxicLog(logPath, toxicEntry);
  await savePlaybook(playbook);

  console.log(`Bullet ${bulletId} permanently blocked.`);
  if (toxicEntry.invertedTo) {
    console.log(`Created anti-pattern: ${toxicEntry.invertedTo}`);
  }
}
```

### Command: `stats` (Playbook Health Dashboard)

**Purpose**: Display comprehensive playbook health metrics and identify maintenance needs

```bash
cm stats
cm stats --json
```

**Output Example**:
```
╭─────────────────────────────────────────────────────────╮
│              CASS-MEMORY PLAYBOOK HEALTH                │
├─────────────────────────────────────────────────────────┤
│ Total Bullets: 156 (Global: 89, Workspace: 67)          │
│                                                         │
│ BY MATURITY:                                            │
│   ● Candidate:   23 (14.7%)  ░░░░░                      │
│   ● Established: 87 (55.8%)  ████████████████           │
│   ● Proven:      34 (21.8%)  ███████                    │
│   ● Deprecated:  12 (7.7%)   ███                        │
│                                                         │
│ BY TYPE:                                                │
│   ✓ Rules:        142 (91.0%)                           │
│   ✗ Anti-patterns: 14 (9.0%)                            │
│                                                         │
│ SCORE DISTRIBUTION (decay-adjusted):                    │
│   Excellent (>10):  18  ████                            │
│   Good (5-10):      45  ██████████                      │
│   Neutral (0-5):    71  ████████████████                │
│   At Risk (<0):     10  ███  ⚠️ review needed           │
│                                                         │
│ TOP PERFORMERS:                                         │
│   1. b-abc123 (score: 24.3) "Use waitFor for async..."  │
│   2. b-def456 (score: 18.7) "Prefer httpx over..."      │
│   3. b-ghi789 (score: 15.2) "Mock external APIs..."     │
│                                                         │
│ NEEDS ATTENTION:                                        │
│   ⚠️ 10 bullets at risk of auto-deprecation             │
│   🕐 8 bullets stale (no feedback in 90+ days)          │
│   🔄 3 merge candidates detected (similar content)      │
╰─────────────────────────────────────────────────────────╯
```

**JSON Output**:
```json
{
  "total": 156,
  "byScope": { "global": 89, "workspace": 67 },
  "byMaturity": { "candidate": 23, "established": 87, "proven": 34, "deprecated": 12 },
  "byType": { "rule": 142, "anti-pattern": 14 },
  "scoreDistribution": { "excellent": 18, "good": 45, "neutral": 71, "atRisk": 10 },
  "topPerformers": [
    { "id": "b-abc123", "score": 24.3, "preview": "Use waitFor for async..." },
    { "id": "b-def456", "score": 18.7, "preview": "Prefer httpx over..." }
  ],
  "atRisk": [
    { "id": "b-xyz999", "score": -2.1, "reason": "High harmful count" }
  ],
  "stale": [
    { "id": "b-old111", "daysSinceLastFeedback": 142 }
  ],
  "mergeCandidates": [
    { "ids": ["b-aaa", "b-bbb"], "similarity": 0.92 }
  ]
}
```

**Implementation**:
```typescript
async function computeStats(playbook: Playbook): Promise<PlaybookStats> {
  const active = playbook.bullets.filter(b => b.maturity !== "deprecated");

  // Maturity distribution
  const byMaturity = {
    candidate: active.filter(b => b.maturity === "candidate").length,
    established: active.filter(b => b.maturity === "established").length,
    proven: active.filter(b => b.maturity === "proven").length,
    deprecated: playbook.bullets.filter(b => b.maturity === "deprecated").length
  };

  // Type distribution
  const byType = {
    rule: active.filter(b => b.type === "rule").length,
    antiPattern: active.filter(b => b.type === "anti-pattern").length
  };

  // Score distribution (decay-adjusted)
  const scored = active.map(b => ({ bullet: b, score: getEffectiveScore(b) }));
  const scoreDistribution = {
    excellent: scored.filter(s => s.score > 10).length,
    good: scored.filter(s => s.score > 5 && s.score <= 10).length,
    neutral: scored.filter(s => s.score >= 0 && s.score <= 5).length,
    atRisk: scored.filter(s => s.score < 0).length
  };

  // Top performers
  const topPerformers = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => ({
      id: s.bullet.id,
      score: Math.round(s.score * 10) / 10,
      preview: s.bullet.content.slice(0, 40) + "..."
    }));

  // At risk (negative score)
  const atRisk = scored
    .filter(s => s.score < 0)
    .map(s => ({
      id: s.bullet.id,
      score: Math.round(s.score * 10) / 10,
      reason: "High harmful count relative to helpful"
    }));

  // Stale (no feedback in 90+ days)
  const stale = active
    .filter(b => {
      const lastFeedback = Math.max(
        ...b.helpfulEvents.map(e => new Date(e.timestamp).getTime()),
        ...b.harmfulEvents.map(e => new Date(e.timestamp).getTime())
      );
      return daysSince(lastFeedback) > 90;
    })
    .map(b => ({
      id: b.id,
      daysSinceLastFeedback: daysSince(getLastFeedback(b))
    }));

  // Merge candidates (semantic similarity)
  const mergeCandidates = await findMergeCandidates(active, 0.85);

  return {
    total: playbook.bullets.length,
    byScope: {
      global: active.filter(b => b.scope === "global").length,
      workspace: active.filter(b => b.scope === "workspace").length
    },
    byMaturity,
    byType,
    scoreDistribution,
    topPerformers,
    atRisk,
    stale,
    mergeCandidates
  };
}
```

### Command: `doctor` (System Health Check)

**Purpose**: Single command to verify entire cass-memory setup is healthy. Essential for adoption and debugging.

```bash
cm doctor
cm doctor --json
cm doctor --fix  # Auto-fix recoverable issues
```

**Output Example**:
```
╭─────────────────────────────────────────────────────────╮
│              CASS-MEMORY HEALTH CHECK                   │
├─────────────────────────────────────────────────────────┤
│ CASS INTEGRATION                                        │
│   ✓ cass found: /usr/local/bin/cass (v0.8.2)           │
│   ✓ Index healthy (last updated: 2h ago)                │
│   ✓ 1,247 sessions indexed across 4 agents             │
│                                                         │
│ STORAGE                                                 │
│   ✓ Data directory: ~/.cass-memory (42MB)              │
│   ✓ Disk space available: 89GB                         │
│   ✓ Playbook: 156 bullets (89 global, 67 workspace)    │
│   ✓ Diary entries: 342                                  │
│                                                         │
│ LLM PROVIDERS                                           │
│   ✓ ANTHROPIC_API_KEY present                          │
│   ✗ OPENAI_API_KEY missing (optional)                  │
│   ✗ GOOGLE_API_KEY missing (optional)                  │
│                                                         │
│ CONFIGURATION                                           │
│   ✓ Config valid: ~/.cass-memory/config.json           │
│   ✓ Provider: anthropic / claude-sonnet-4-20250514     │
│                                                         │
│ SELF-TEST                                               │
│   ✓ Playbook load: 12ms                                │
│   ✓ Cass search: 45ms                                  │
│   ⚠ Sanitization test: 1 pattern may be too broad      │
│                                                         │
│ ISSUES FOUND: 1 warning                                 │
│   ⚠ SANITIZATION_PATTERN_BROAD                         │
│     Pattern /token.*/gi may redact too aggressively    │
│     Recommend: Use more specific pattern                │
╰─────────────────────────────────────────────────────────╯
```

**Implementation**:
```typescript
interface HealthCheckResult {
  overall: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheck[];
  warnings: string[];
  errors: string[];
  fixable: FixableIssue[];
}

interface HealthCheck {
  category: "cass" | "storage" | "llm" | "config" | "self_test";
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: Record<string, unknown>;
}

async function runDoctor(options: { fix?: boolean; json?: boolean }): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = [];
  const fixable: FixableIssue[] = [];

  // === CASS INTEGRATION ===
  const cassPath = await findCass();
  if (cassPath) {
    checks.push({ category: "cass", name: "cass_found", status: "pass", message: `cass found: ${cassPath}` });

    const cassVersion = await getCassVersion(cassPath);
    checks.push({ category: "cass", name: "cass_version", status: "pass", message: `Version: ${cassVersion}` });

    const indexHealth = await checkCassIndex(cassPath);
    if (indexHealth.healthy) {
      checks.push({ category: "cass", name: "index_healthy", status: "pass", message: `Index healthy (${indexHealth.sessionCount} sessions)` });
    } else {
      checks.push({ category: "cass", name: "index_healthy", status: "fail", message: "Index missing or stale" });
      fixable.push({ id: "rebuild_index", fix: () => execSync(`${cassPath} index --full`) });
    }
  } else {
    checks.push({ category: "cass", name: "cass_found", status: "fail", message: "cass not found in PATH" });
  }

  // === STORAGE ===
  const dataDir = expandPath("~/.cass-memory");
  if (await exists(dataDir)) {
    const size = await getDirSize(dataDir);
    checks.push({ category: "storage", name: "data_dir", status: "pass", message: `Data directory: ${dataDir} (${formatBytes(size)})` });

    const playbook = await loadPlaybook();
    checks.push({ category: "storage", name: "playbook", status: "pass", message: `Playbook: ${playbook.bullets.length} bullets` });
  } else {
    checks.push({ category: "storage", name: "data_dir", status: "warn", message: "Data directory not initialized" });
    fixable.push({ id: "init_data_dir", fix: () => initDataDir() });
  }

  // === LLM PROVIDERS ===
  const providers = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"];
  for (const key of providers) {
    const present = !!process.env[key];
    const required = key === "ANTHROPIC_API_KEY";  // Or check config
    checks.push({
      category: "llm",
      name: key.toLowerCase(),
      status: present ? "pass" : (required ? "fail" : "warn"),
      message: present ? `${key} present` : `${key} missing${required ? "" : " (optional)"}`
    });
  }

  // === SELF-TEST ===
  const startTime = Date.now();
  try {
    await loadPlaybook();
    checks.push({ category: "self_test", name: "playbook_load", status: "pass", message: `Playbook load: ${Date.now() - startTime}ms` });
  } catch (e) {
    checks.push({ category: "self_test", name: "playbook_load", status: "fail", message: `Playbook load failed: ${e}` });
  }

  // === AUTO-FIX ===
  if (options.fix) {
    for (const issue of fixable) {
      try {
        await issue.fix();
        console.log(`Fixed: ${issue.id}`);
      } catch (e) {
        console.error(`Failed to fix ${issue.id}: ${e}`);
      }
    }
  }

  const errors = checks.filter(c => c.status === "fail").map(c => c.message);
  const warnings = checks.filter(c => c.status === "warn").map(c => c.message);

  return {
    overall: errors.length > 0 ? "unhealthy" : warnings.length > 0 ? "degraded" : "healthy",
    checks,
    warnings,
    errors,
    fixable
  };
}
```

### Command: `top` / `stale` / `why` / `similar` (NEW: Quick Insights)

```bash
# Show most effective bullets ever
cm top 10
# Output: ranked by effective score (with decay)

# Show bullets not marked helpful in >120 days
cm stale --days 120
# Great for cleanup sessions

# Show the original evidence that created a bullet
cm why b-abc123
# Output: session snippets, diary entries, reasoning chain

# Semantic search for bullets
cm similar "useEffect dependency array"
# Output: top 5 bullets by embedding similarity
```

**Output example**:
```markdown
## Agent Playbook (auto-generated from cass-memory)

### Testing (top 5 rules)
1. [8× helpful] For React hooks, test returned values and effects separately
2. [5× helpful] Run `pnpm test` for changed files before committing
3. [3× helpful] Mock external APIs at the network layer, not the client

### Git Workflow
1. [6× helpful] Make small, atomic commits; don't mix refactors and features
2. [4× helpful] Use branch names like `feature/<area>-<summary>`
```

---

## The Reflection Pipeline

### Generator Phase (Context Retrieval)

```typescript
async function generateContext(task: string, config: Config): Promise<Context> {
  // 1. Plan searches (LLM generates 3-5 targeted queries)
  const searchPlan = await llm.generateObject({
    schema: z.object({
      queries: z.array(z.string()).max(5),
      keywords: z.array(z.string())
    }),
    prompt: `Task: "${task}". Generate search queries for cass.`
  });

  // 2. Execute cass searches in parallel
  const results = await Promise.all(
    searchPlan.queries.map(q => cassSearch(q, { limit: 5, days: 30 }))
  );

  // 3. Score playbook bullets by keyword overlap
  const bullets = scorePlaybookBullets(playbook, searchPlan.keywords);

  // 4. Check deprecated patterns for warnings
  const warnings = checkDeprecatedPatterns(results, playbook);

  return { bullets, history: results.flat(), warnings };
}
```

### Reflector Phase (Insight Extraction)

```typescript
async function reflectOnSession(
  diary: DiaryEntry,
  sessionContent: string,
  existingBullets: Bullet[],
  config: Config
): Promise<PlaybookDelta[]> {
  const allDeltas: PlaybookDelta[] = [];
  const seenHashes = new Set<string>();

  // Multi-iteration reflection (ACE pattern)
  for (let i = 0; i < config.maxReflectorIterations; i++) {
    const deltas = await llm.generateObject({
      schema: DeltaSchema,
      prompt: buildReflectorPrompt(diary, sessionContent, existingBullets, i)
    });

    // Deduplicate within this reflection
    for (const delta of deltas) {
      const hash = hashDelta(delta);
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        allDeltas.push(delta);
      }
    }

    // Early exit if no new insights
    if (deltas.length === 0) break;
  }

  return allDeltas;
}
```

### Validator Phase (Scientific Validation - GPT Pro Innovation)

This is the key innovation from GPT Pro: don't blindly accept LLM-proposed rules.

**NEW: Evidence-Count Gate (Pre-LLM Filter)**

Before invoking the LLM, apply a cheap heuristic filter based on evidence counts. This saves LLM calls and improves quality.

```typescript
interface EvidenceGateResult {
  passed: boolean;
  reason: string;
  suggestedState: "draft" | "active";
  sessionCount: number;
  successCount: number;
  failureCount: number;
}

/**
 * Pre-LLM filter: check if there's enough evidence to even consider this rule.
 * Uses simple counts from cass hits + diary status correlation.
 */
async function evidenceCountGate(
  content: string,
  config: Config
): Promise<EvidenceGateResult> {
  const keywords = extractKeywords(content);
  const hits = await cassSearch(keywords.join(" "), { limit: 20, days: 90 });

  if (hits.length === 0) {
    return {
      passed: true,  // No evidence either way - allow as draft
      reason: "No historical evidence found, proposing as draft",
      suggestedState: "draft",
      sessionCount: 0, successCount: 0, failureCount: 0
    };
  }

  // Group by unique session
  const sessions = new Set(hits.map(h => h.source_path));

  // Try to correlate with diaries to get success/failure counts
  let successCount = 0;
  let failureCount = 0;

  for (const sessionPath of sessions) {
    const diary = await findDiaryBySession(sessionPath);
    if (diary) {
      if (diary.status === "success") successCount++;
      else if (diary.status === "failure") failureCount++;
    }
  }

  // Decision logic
  const sessionCount = sessions.size;

  // Gate 1: If only 1 session, too early to generalize
  if (sessionCount === 1) {
    return {
      passed: true,
      reason: "Single session only - proposing as draft for further validation",
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  // Gate 2: If more failures than successes, reject outright
  if (failureCount > successCount && failureCount >= 2) {
    return {
      passed: false,
      reason: `Pattern appears in ${failureCount} failed sessions vs ${successCount} successful - rejecting`,
      suggestedState: "draft",
      sessionCount, successCount, failureCount
    };
  }

  // Gate 3: Strong evidence → allow as active candidate
  if (successCount >= 3 && failureCount === 0) {
    return {
      passed: true,
      reason: `Strong evidence: ${successCount} successful sessions, 0 failures`,
      suggestedState: "active",
      sessionCount, successCount, failureCount
    };
  }

  // Default: pass to LLM for refinement, suggest draft
  return {
    passed: true,
    reason: `Mixed evidence: ${sessionCount} sessions (${successCount} success, ${failureCount} failure)`,
    suggestedState: "draft",
    sessionCount, successCount, failureCount
  };
}
```

**Full Validator (with Evidence Gate)**:

```typescript
async function validateDelta(
  delta: PlaybookDelta,
  config: Config
): Promise<{ valid: boolean; reason: string; evidence: string[]; suggestedState: "draft" | "active" }> {
  // Only validate new rules
  if (delta.type !== "add") return { valid: true, reason: "N/A", evidence: [], suggestedState: "active" };

  // ========== NEW: Evidence-count gate (pre-LLM) ==========
  const gateResult = await evidenceCountGate(delta.bullet.content, config);

  if (!gateResult.passed) {
    return {
      valid: false,
      reason: gateResult.reason,
      evidence: [],
      suggestedState: "draft"
    };
  }

  // Skip LLM if evidence is overwhelming
  if (gateResult.suggestedState === "active" && gateResult.successCount >= 5) {
    return {
      valid: true,
      reason: `Auto-accepted: ${gateResult.successCount} successful sessions with no failures`,
      evidence: [],
      suggestedState: "active"
    };
  }
  // ========== End evidence gate ==========

  // Extract validation keywords
  const keywords = extractKeywords(delta.bullet.content);

  // Query cass for historical evidence (broader search)
  const history = await cassSearch(keywords.join(" "), {
    limit: 10,
    days: 90  // Look further back for validation
  });

  // LLM verdict (only called if evidence gate passed but needs refinement)
  const verdict = await llm.generateObject({
    schema: z.object({
      valid: z.boolean(),
      reason: z.string(),
      refinedContent: z.string().optional()
    }),
    prompt: `
      PROPOSED RULE: "${delta.bullet.content}"

      HISTORICAL EVIDENCE FROM CASS:
      ${formatHistory(history)}

      TASK:
      - If evidence shows this pattern FAILED multiple times: INVALID
      - If evidence supports it or is neutral: VALID
      - If rule is too generic/obvious: INVALID
      - Optionally refine the wording based on evidence
    `
  });

  return {
    valid: verdict.valid,
    reason: verdict.reason,
    evidence: history.map(h => h.snippet)
  };
}
```

### Curator Phase (Deterministic Merging - ENHANCED)

**CRITICAL: No LLM calls in curation to prevent context collapse.**

**Key Enhancements**:
1. Event-level feedback tracking with timestamps (for decay)
2. Conflict detection between new and existing rules
3. Toxic bullet filtering
4. **Anti-pattern inversion** (harmful bullets become "don't do X" instead of being deleted!)
5. Automatic maturity promotion

```typescript
interface CurationResult {
  playbook: Playbook;
  applied: number;
  skipped: number;
  conflicts: ConflictReport[];     // Rules that may contradict existing ones
  promotions: PromotionReport[];   // candidate → established → proven
  inversions: InversionReport[];   // Harmful rules converted to anti-patterns
}

function curatePlaybook(
  playbook: Playbook,
  deltas: PlaybookDelta[],
  config: Config
): CurationResult {
  let applied = 0;
  let skipped = 0;
  const conflicts: ConflictReport[] = [];
  const promotions: PromotionReport[] = [];
  const inversions: InversionReport[] = [];

  // Track content hashes for deduplication
  const existingHashes = new Set(
    playbook.bullets.map(b => hashContent(b.content))
  );

  for (const delta of deltas) {
    switch (delta.type) {
      case "add":
        if (!delta.bullet) continue;
        const hash = hashContent(delta.bullet.content);

        // 1. Check for exact duplicates
        if (existingHashes.has(hash)) {
          skipped++;
          continue;
        }

        // 2. Check for semantic duplicates (Jaccard similarity)
        const dupCheck = findSimilarBullet(playbook.bullets, delta.bullet.content, config.dedupThreshold);
        if (dupCheck.found) {
          // Boost existing instead of adding duplicate
          dupCheck.bullet!.helpfulEvents.push({
            timestamp: now(),
            sessionPath: delta.sourceSession
          });
          skipped++;
          continue;
        }

        // 3. Check against toxic log (NEW)
        if (await isToxic(delta.bullet.content, config)) {
          console.error(`[curator] Blocked toxic pattern: ${delta.bullet.content.slice(0, 50)}...`);
          skipped++;
          continue;
        }

        // 4. Detect semantic conflicts (NEW)
        const bulletConflicts = detectConflicts(delta.bullet.content, playbook.bullets);
        if (bulletConflicts.length > 0) {
          conflicts.push(...bulletConflicts);
          // Still add, but log conflict for review
        }

        // 5. Add new bullet as CANDIDATE (must earn trust)
        playbook.bullets.push({
          id: generateBulletId(),
          ...delta.bullet,
          type: "rule",
          isNegative: false,
          maturity: "candidate",  // NEW: Starts as candidate
          helpfulCount: 0,
          harmfulCount: 0,
          helpfulEvents: [],
          harmfulEvents: [],
          confidenceDecayHalfLifeDays: config.defaultDecayHalfLife || 90,
          pinned: false,
          createdAt: now(),
          updatedAt: now()
        });
        existingHashes.add(hash);
        applied++;
        break;

      case "helpful":
        const helpfulBullet = findBullet(playbook, delta.bulletId);
        if (helpfulBullet) {
          // Record event with timestamp (for decay calculation)
          helpfulBullet.helpfulEvents.push({
            timestamp: now(),
            sessionPath: delta.sourceSession,
            context: delta.context
          });
          helpfulBullet.helpfulCount = helpfulBullet.helpfulEvents.length;
          helpfulBullet.lastValidatedAt = now();
          helpfulBullet.updatedAt = now();

          // Check for promotion
          const newMaturity = checkForPromotion(helpfulBullet);
          if (newMaturity !== helpfulBullet.maturity) {
            promotions.push({
              bulletId: delta.bulletId,
              from: helpfulBullet.maturity,
              to: newMaturity
            });
            helpfulBullet.maturity = newMaturity;
            helpfulBullet.promotedAt = now();
          }
          applied++;
        }
        break;

      case "harmful":
        const harmfulBullet = findBullet(playbook, delta.bulletId);
        if (harmfulBullet) {
          // Record event with timestamp and reason
          harmfulBullet.harmfulEvents.push({
            timestamp: now(),
            sessionPath: delta.sourceSession,
            reason: delta.reason || "other",
            context: delta.context
          });
          harmfulBullet.harmfulCount = harmfulBullet.harmfulEvents.length;
          harmfulBullet.updatedAt = now();
          applied++;
        }
        break;

      case "deprecate":
        const deprecateBullet = findBullet(playbook, delta.bulletId);
        if (deprecateBullet) {
          deprecateBullet.maturity = "deprecated";
          deprecateBullet.deprecationReason = delta.reason;
          deprecateBullet.replacedBy = delta.replacedBy;
          deprecateBullet.updatedAt = now();
          applied++;
        }
        break;

      // ... handle replace, merge
    }
  }

  // AUTO-INVERSION: Convert heavily harmful → anti-patterns (DON'T DELETE!)
  // This is the key insight: harmful rules are VALUABLE as anti-patterns
  for (const bullet of playbook.bullets) {
    if (bullet.pinned) continue;  // Respect protected bullets
    if (bullet.maturity === "deprecated") continue;
    if (bullet.type === "anti-pattern") continue;

    const effectiveScore = getEffectiveScore(bullet);
    if (effectiveScore < -config.pruneThreshold) {
      // INVERT instead of delete!
      const antiPattern = invertToAntiPattern(bullet);
      playbook.bullets.push(antiPattern);

      bullet.maturity = "deprecated";
      bullet.deprecationReason = `Inverted to anti-pattern: ${antiPattern.id}`;

      inversions.push({
        originalId: bullet.id,
        originalContent: bullet.content,
        antiPatternId: antiPattern.id,
        antiPatternContent: antiPattern.content
      });

      console.error(`[curator] Inverted harmful rule ${bullet.id} → anti-pattern ${antiPattern.id}`);
    }
  }

  // Remove deprecated bullets from active list (but they're still in history)
  const beforePrune = playbook.bullets.length;
  playbook.bullets = playbook.bullets.filter(b => b.maturity !== "deprecated");
  const pruned = beforePrune - playbook.bullets.length;

  return { playbook, applied, skipped, pruned };
}
```

---

## Integration with cass

### cass API Wrapper

```typescript
interface CassSearchOptions {
  limit?: number;
  days?: number;
  agent?: string | string[];
  workspace?: string;
  fields?: "minimal" | "summary" | "full";
  maxTokens?: number;
  highlight?: boolean;
  explain?: boolean;
}

interface CassHit {
  source_path: string;
  line_number: number;
  agent: string;
  workspace: string;
  title: string;
  snippet: string;
  score: number;
  created_at: string;
}

interface CassSearchResult {
  hits: CassHit[];
  _meta?: {
    elapsed_ms: number;
    total_hits: number;
    wildcard_fallback: boolean;
  };
}

async function cassSearch(
  query: string,
  options: CassSearchOptions = {}
): Promise<CassHit[]> {
  const args = ["search", `"${query}"`, "--robot"];

  if (options.limit) args.push("--limit", String(options.limit));
  if (options.days) args.push("--days", String(options.days));
  if (options.agent) {
    const agents = Array.isArray(options.agent)
      ? options.agent.join(",")
      : options.agent;
    args.push("--agent", agents);
  }
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields);
  if (options.maxTokens) args.push("--max-tokens", String(options.maxTokens));
  if (options.highlight) args.push("--highlight");

  try {
    const result = execSync(`cass ${args.join(" ")}`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024
    });
    return JSON.parse(result).hits || [];
  } catch (e: any) {
    console.error(`[cass-memory] cass search failed: ${e.message}`);
    return [];
  }
}

async function cassExport(sessionPath: string): Promise<string | null> {
  try {
    return execSync(`cass export "${sessionPath}" --format markdown`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024
    });
  } catch {
    return null;
  }
}

async function cassTimeline(days: number): Promise<any> {
  try {
    const result = execSync(`cass timeline --days ${days} --json`, {
      encoding: "utf-8"
    });
    return JSON.parse(result);
  } catch {
    return { groups: [] };
  }
}

function cassAvailable(): boolean {
  try {
    execSync("cass health", { timeout: 100 });
    return true;
  } catch {
    return false;
  }
}
```

### Error Handling

```typescript
// cass exit codes
const CASS_EXIT_CODES = {
  0: { name: "success", retryable: false },
  2: { name: "usage_error", retryable: false },
  3: { name: "index_missing", retryable: true, action: "rebuild_index" },
  4: { name: "not_found", retryable: false },
  5: { name: "idempotency_mismatch", retryable: false },
  9: { name: "unknown", retryable: false },
  10: { name: "timeout", retryable: true, action: "reduce_limit" }
};

async function safeCassSearch(
  query: string,
  options: CassSearchOptions
): Promise<CassHit[]> {
  try {
    return await cassSearch(query, options);
  } catch (e: any) {
    const exitCode = e.status || 9;
    const errorInfo = CASS_EXIT_CODES[exitCode] || CASS_EXIT_CODES[9];

    if (errorInfo.action === "rebuild_index") {
      console.error("[cass-memory] Index missing, rebuilding...");
      execSync("cass index --full");
      return await cassSearch(query, options);
    }

    if (errorInfo.action === "reduce_limit" && options.limit && options.limit > 3) {
      console.error("[cass-memory] Timeout, reducing limit...");
      return await cassSearch(query, { ...options, limit: 3 });
    }

    console.error(`[cass-memory] cass error: ${errorInfo.name}`);
    return [];
  }
}
```

### Security: Secret Sanitization (CRITICAL)

Sessions may contain secrets (tokens, passwords, API keys). Sanitize before writing to persistent storage.

```typescript
// High-yield patterns that catch most secrets
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_ACCESS_KEY]" },
  { pattern: /[A-Za-z0-9/+=]{40}(?=\s|$|")/g, replacement: "[AWS_SECRET_KEY]" },

  // Generic API keys/tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, replacement: "[BEARER_TOKEN]" },
  { pattern: /api[_-]?key["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[API_KEY]" },
  { pattern: /token["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[TOKEN]" },

  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[PRIVATE_KEY]" },

  // Passwords in common formats
  { pattern: /password["\s:=]+["'][^"']{8,}["']/gi, replacement: 'password="[REDACTED]"' },

  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: "[GITHUB_PAT]" },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: "[GITHUB_PAT]" },

  // Slack tokens
  { pattern: /xox[baprs]-[A-Za-z0-9-]+/g, replacement: "[SLACK_TOKEN]" },

  // Database URLs with credentials
  { pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/gi, replacement: "$1://[USER]:[PASS]@" }
];

function sanitize(text: string, config: { enabled: boolean; extraPatterns?: RegExp[] }): string {
  if (!config.enabled) return text;

  let result = text;

  // Built-in patterns
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // User-configured extra patterns
  for (const pattern of config.extraPatterns || []) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}

// Apply sanitization at these points:
// 1. After cassExport, before passing to LLM
// 2. Before writing DiaryEntry to disk
// 3. Before storing content in PlaybookBullet
// 4. In context output (already sanitized if stored sanitized)
```

**Config**:
```json
{
  "sanitization": {
    "enabled": true,
    "extraPatterns": ["INTERNAL_[A-Z_]+_KEY"]
  }
}
```

---

## LLM Integration

### Provider Abstraction (Vercel AI SDK)

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import { z } from "zod";

interface Config {
  provider: "openai" | "anthropic" | "google";
  model: string;
  apiKey?: string;
}

function getModel(config: Config) {
  const apiKey = config.apiKey || getApiKeyFromEnv(config.provider);

  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey })(config.model);
    case "anthropic":
      return createAnthropic({ apiKey })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

function getApiKeyFromEnv(provider: string): string {
  const envVars: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY"
  };
  const key = process.env[envVars[provider]];
  if (!key) {
    throw new Error(`Missing ${envVars[provider]}`);
  }
  return key;
}
```

### Zod Schemas for Structured Output

```typescript
const DiarySchema = z.object({
  status: z.enum(["success", "failure", "mixed"]),
  accomplishments: z.array(z.string()).min(1).max(10),
  decisions: z.array(z.string()).max(10),
  challenges: z.array(z.string()).max(10),
  preferences: z.array(z.string()).max(10),
  keyLearnings: z.array(z.string()).max(10),
  suggestedTags: z.array(z.string()).max(10)
});

const DeltaSchema = z.object({
  deltas: z.array(z.object({
    type: z.enum(["add", "helpful", "harmful", "replace", "deprecate"]),
    bulletId: z.string().optional(),
    category: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    reason: z.string()
  })).max(20)
});

const ValidationSchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
  refinedContent: z.string().optional()
});
```

### Prompt Templates

```typescript
const PROMPTS = {
  diary: `
Analyze this coding agent session and extract structured insights.

SESSION PATH: {sessionPath}
AGENT: {agent}
WORKSPACE: {workspace}

SESSION CONTENT:
{content}

Extract:
1. ACCOMPLISHMENTS: What was completed or progressed
2. DECISIONS: Design choices, architecture decisions, tool selections
3. CHALLENGES: Problems encountered, errors hit, blockers
4. PREFERENCES: User's coding style, preferred approaches
5. KEY LEARNINGS: Insights that would help future sessions

Be SPECIFIC and ACTIONABLE. Avoid generic statements like "wrote code" or "fixed bugs".
Include specific file names, function names, error messages when available.
`,

  reflector: `
You are analyzing a coding session to extract reusable lessons for a playbook.

EXISTING PLAYBOOK BULLETS:
{existingBullets}

SESSION DIARY:
- Accomplishments: {accomplishments}
- Decisions: {decisions}
- Challenges: {challenges}
- Preferences: {preferences}
- Key Learnings: {keyLearnings}

RELATED HISTORY FROM OTHER AGENTS:
{cassHistory}

{iterationNote}

For each insight from this session, determine:
1. NEW: Novel lesson not covered by existing bullets? Create a new bullet.
2. HELPFUL: Did an existing bullet prove useful? Mark it helpful.
3. HARMFUL: Did following an existing bullet cause problems? Mark it harmful.
4. REPLACE: Should an existing bullet be updated with better info?
5. DEPRECATE: Is an existing bullet now outdated or wrong?

Guidelines:
- Be SPECIFIC. Bad: "Write tests". Good: "For React hooks, test effects separately with renderHook"
- Include concrete examples, file patterns, command flags when relevant
- Only propose deltas for genuinely reusable insights
- Consider if a bullet would help a DIFFERENT agent on a similar problem
`,

  validator: `
PROPOSED RULE: "{proposedRule}"

HISTORICAL EVIDENCE FROM CASS:
{evidence}

Analyze whether the evidence supports this rule:
- If evidence shows the pattern FAILED multiple times: INVALID with reason
- If evidence shows the pattern SUCCEEDED consistently: VALID
- If evidence is mixed or neutral: VALID with caution note
- If the rule is too obvious/generic to be useful: INVALID

You may optionally refine the wording based on the evidence.
`,

  context: `
You are generating a pre-task briefing for a coding agent.

TASK: {task}

PLAYBOOK ENTRIES (sorted by relevance):
{bullets}

HISTORICAL CONTEXT FROM SIMILAR SESSIONS:
{history}

DEPRECATED PATTERNS TO AVOID:
{deprecatedPatterns}

Generate a concise briefing that:
1. Highlights the most relevant playbook rules
2. Points to specific historical solutions
3. Warns about any deprecated patterns found
4. Suggests search queries for more context if needed
`
};
```

---

## Storage & Persistence

### Directory Structure (ENHANCED: Cascading Configuration)

**The "Team Brain" Architecture** - Memory as Code

```
# GLOBAL (User-level defaults)
~/.cass-memory/
├── config.json              # User configuration
├── playbook.yaml            # Personal playbook (preferences, shortcuts)
├── toxic_bullets.log        # NEW: Permanently blocked patterns (see "forget")
├── diary/                   # Diary entries
│   ├── 2025-12-07T10-30-00-diary-abc123.json
│   └── ...
├── reflections/             # Reflection tracking
│   ├── global.processed.log
│   └── ws-{hash}.processed.log
├── usage.jsonl              # Bullet usage log (with timestamps!)
├── embeddings/              # NEW: Local vector store for semantic search
│   └── bullets.embeddings   # Cached bullet embeddings
└── cost/                    # NEW: LLM cost tracking
    └── usage-2025-12.json

# REPO-LEVEL (Committed to Git - shared with team!)
.cass/
├── playbook.yaml            # Project-specific rules (architectural decisions)
├── config.yaml              # Project overrides (e.g., preferred categories)
└── toxic.log                # Project-level blocked patterns
```

### Cascading Configuration (NEW: "Memory as Code")

When `cm context` runs, it merges playbooks in order:

```typescript
async function loadMergedPlaybook(config: Config): Promise<Playbook> {
  // 1. Load global (user) playbook
  const globalPlaybook = await loadPlaybook(expandPath("~/.cass-memory/playbook.yaml"));

  // 2. Load repo playbook if in a git repo
  const repoPlaybook = await loadPlaybook("./.cass/playbook.yaml").catch(() => null);

  // 3. Merge with repo taking precedence for conflicts
  const merged = mergePlaybooks(globalPlaybook, repoPlaybook, {
    // Repo bullets override global bullets with same ID
    conflictResolution: "repo-wins",
    // But keep both if different IDs
    deduplication: "by-content-similarity"
  });

  // 4. Filter out toxic bullets from both levels
  const globalToxic = await loadToxicLog("~/.cass-memory/toxic_bullets.log");
  const repoToxic = await loadToxicLog("./.cass/toxic.log");
  const allToxic = [...globalToxic, ...repoToxic];

  merged.bullets = merged.bullets.filter(b =>
    !isSemanticallyToxic(b.content, allToxic)
  );

  return merged;
}
```

**Value**: A new developer (or agent) cloning the repo instantly inherits the project's memory. Architectural rules propagate automatically.

### Local Semantic Search (NEW: 5× relevance improvement)

Using `@xenova/transformers` for local embeddings (no network required):

```typescript
import { pipeline } from "@xenova/transformers";

let embedder: any = null;

async function getEmbedder() {
  if (!embedder) {
    // Uses all-MiniLM-L6-v2 by default (~23MB, runs locally)
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return embedder;
}

async function embedText(text: string): Promise<number[]> {
  const embed = await getEmbedder();
  const result = await embed(text, { pooling: "mean", normalize: true });
  return Array.from(result.data);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Enhanced bullet scoring: keyword + semantic similarity
 */
async function scoreBulletsEnhanced(
  bullets: PlaybookBullet[],
  task: string,
  config: Config
): Promise<ScoredBullet[]> {
  // 1. Keyword scoring (fast)
  const keywords = extractKeywords(task);
  const keywordScored = bullets.map(b => ({
    bullet: b,
    keywordScore: scoreBulletRelevance(b.content, b.tags, keywords)
  }));

  // 2. Semantic scoring (if embeddings available)
  const taskEmbedding = await embedText(task);
  const semanticScored = await Promise.all(
    keywordScored.map(async ({ bullet, keywordScore }) => {
      // Load or compute bullet embedding
      const bulletEmbedding = bullet.embedding || await embedText(bullet.content);

      const semanticScore = cosineSimilarity(taskEmbedding, bulletEmbedding);

      return {
        ...bullet,
        keywordScore,
        semanticScore,
        // Combined score: 40% keyword, 60% semantic
        combinedScore: (keywordScore * 0.4) + (semanticScore * 10 * 0.6),
        effectiveScore: getEffectiveScore(bullet)
      };
    })
  );

  // 3. Final ranking: combined relevance × effective score × maturity
  return semanticScored
    .filter(b => !b.deprecated)
    .sort((a, b) => {
      const aFinal = a.combinedScore * Math.max(0.1, a.effectiveScore);
      const bFinal = b.combinedScore * Math.max(0.1, b.effectiveScore);
      return bFinal - aFinal;
    });
}
```

**Cost**: One dependency (~23MB model), ~3ms per task on modern laptop
**Benefit**: Relevance jumps from ~60% to ~90% - catches synonyms and semantic matches

### Embedding Cache

```typescript
// ~/.cass-memory/embeddings/bullets.json
interface EmbeddingCache {
  version: string;
  model: string;
  bullets: Record<string, {
    contentHash: string;
    embedding: number[];
    computedAt: string;
  }>;
}

async function loadOrComputeEmbeddings(
  playbook: Playbook,
  cache: EmbeddingCache
): Promise<void> {
  for (const bullet of playbook.bullets) {
    const hash = hashContent(bullet.content);
    const cached = cache.bullets[bullet.id];

    if (cached && cached.contentHash === hash) {
      bullet.embedding = cached.embedding;
    } else {
      // Compute and cache
      bullet.embedding = await embedText(bullet.content);
      cache.bullets[bullet.id] = {
        contentHash: hash,
        embedding: bullet.embedding,
        computedAt: now()
      };
    }
  }

  await saveEmbeddingCache(cache);
}
```

### Configuration Schema

```json
{
  "schema_version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "cassPath": "cass",
  "playbookPath": "~/.cass-memory/playbook.yaml",
  "maxReflectorIterations": 3,
  "dedupSimilarityThreshold": 0.85,
  "pruneHarmfulThreshold": 3,
  "maxBulletsInContext": 50,
  "sessionLookbackDays": 7,
  "validationEnabled": true,
  "autoReflect": false,
  "enrichWithCrossAgent": true
}
```

### Processed Log Format

```
# ~/.cass-memory/reflections/global.processed.log
# One entry per line: {id}\t{timestamp}\t{source}
diary-abc123	2025-12-07T10:30:00Z	~/.claude/projects/app/session-001.jsonl
diary-def456	2025-12-07T11:00:00Z	~/.cursor/state.vscdb:session-xyz
```

---

## Agent Integration

### AGENTS.md Template

```markdown
## Memory System: cass-memory

Before starting complex tasks, retrieve relevant context:
\`\`\`bash
cm context "<task description>" --json
\`\`\`

As you work, track bullet usage:
- When a playbook rule helps: \`cm mark <bullet-id> --helpful\`
- When a playbook rule causes problems: \`cm mark <bullet-id> --harmful\`

After significant sessions:
\`\`\`bash
cm diary <session-path>
\`\`\`

### Memory Protocol

1. **PRE-FLIGHT**: Run \`cm context\` before non-trivial tasks
2. **REFERENCE**: Check playbook bullets and cite IDs when following them
   - Example: "Following [b-1a2b3c4d], I'll check the instantiated type..."
3. **FEEDBACK**: Mark bullets as helpful/harmful during work
4. **REFLECT**: After complex sessions, diary is auto-generated

### Quick Reference

\`\`\`bash
# Get context before starting
cm context "your task description" --json

# Mark a bullet as helpful
cm mark b-abc123 --helpful

# Mark a bullet as harmful
cm mark b-abc123 --harmful --reason "why"

# Search past sessions via cass
cass search "error pattern" --robot --limit 5
\`\`\`
```

### MCP Server Mode (Future)

```typescript
// Future: Run as MCP server for direct agent integration
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const server = new Server({
  name: "cass-memory",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "memory_context",
      description: "Get relevant context for a task from playbook and cass",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description" }
        },
        required: ["task"]
      }
    },
    {
      name: "memory_mark",
      description: "Mark a playbook bullet as helpful or harmful",
      inputSchema: {
        type: "object",
        properties: {
          bulletId: { type: "string" },
          helpful: { type: "boolean" },
          reason: { type: "string" }
        },
        required: ["bulletId", "helpful"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  switch (request.params.name) {
    case "memory_context":
      return getContext(request.params.arguments.task);
    case "memory_mark":
      return markBullet(
        request.params.arguments.bulletId,
        request.params.arguments.helpful,
        request.params.arguments.reason
      );
  }
});
```

#### MCP Server Architecture (design)

- Transport: HTTP-only MCP (no stdio/SSE). Use official MCP HTTP server (fastmcp-compatible) and keep a single entrypoint `src/mcp/server.ts`.
- Bootstrap: load config once, warm playbook/cass availability checks, share a logger, and expose graceful shutdown.
- Tools (V1 surface):
  - `cm_context` → wraps existing context pipeline (`contextCommand` internals) with options `{ task, top?, history?, days?, workspace? }`, returns the JSON context result.
  - `cm_mark` → wraps mark flow, input `{ bulletId, helpful, reason?, session? }`, returns updated bullet info or ack.
  - `cm_outcome` → lightweight session outcome hook `{ sessionId, outcome: "success"|"failure"|"partial", rulesUsed?: string[] }`; stores via tracking/diary hook (no LLM), returns ack.
- Resources:
  - `cm://playbook` → merged playbook snapshot (filtered to active bullets).
  - `cm://diary` → recent diary entries (bounded list, sanitized).
  - (Optional) `cm://health` → doctor-style health summary (cass availability, storage, sanitization warnings).
- Error/health:
  - Map known errors to MCP errors with codes (config invalid, cass unavailable, playbook missing); include remediation hints.
  - Degraded mode when cass unavailable: reuse `contextWithoutCass`.
- Concurrency/perf:
  - Cache config/playbook per process with invalidation hooks (fs mtime check on each request) to avoid stale data.
  - Timeouts per tool; trim snippets with existing truncate helper.
- Logging: use existing logger utilities; structured fields include `tool`, `agent`, `requestId`, `task`.
- Build/CLI: add `cass-memory serve` (bun build target) that starts the MCP HTTP server on configurable host/port/path; keep CLI entrypoints intact.
- Tests: one unit per handler (context/mark/outcome) using in-memory fixtures; one HTTP integration test that exercises tools/list + tools/call roundtrip with a temporary playbook/diary.

---

## Implementation Roadmap (Priority-Based)

### Priority Ranking Table (ROI-Based)

| Rank | Feature | Effort | Impact | Phase |
|------|---------|--------|--------|-------|
| P1 | Confidence decay + event timestamps | 2h | 20× | 1 |
| P2 | Structured JSON context output | 1h | 10× | 1 |
| P3 | Anti-pattern inversion | 1h | 8× | 2 |
| P4 | Effective score (4× harmful) | 30m | 5× | 1 |
| P5 | Maturity states | 1h | 5× | 2 |
| P6 | Cascading config (global + repo) | 2h | 4× | 2 |
| P7 | Local semantic search | 3h | 4× | 3 |
| P8 | Forget command + toxic log | 1h | 3× | 2 |
| P9 | Stats command (health dashboard) | 2h | 2× | 3 |
| **P10** | **State lifecycle (draft/active/retired)** | 1h | 10× | 1 |
| **P11** | **Evidence-count gate (pre-LLM)** | 1h | 8× | 2 |
| **P12** | **Secret sanitization** | 1h | ∞ (security) | 1 |
| **P13** | **Doctor command** | 2h | 5× (DX) | 2 |
| **P14** | **Kind enum (project/stack/workflow)** | 30m | 3× | 1 |

### Schema Naming Convention

**Decision**: Use camelCase in TypeScript, accept both camelCase and snake_case on YAML load, emit camelCase on save.

```typescript
// On load: normalize both conventions
function normalizeYamlKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(normalizeYamlKeys);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), // snake_case → camelCase
        normalizeYamlKeys(v)
      ])
    );
  }
  return obj;
}
```

### Phase 1: Foundation + High-ROI Core

- [ ] Project setup: Bun + TypeScript + Vercel AI SDK
- [ ] Enhanced types with FeedbackEvent timestamps (P1)
- [ ] Confidence decay algorithm (P1)
- [ ] **State lifecycle (draft/active/retired) (P10)**
- [ ] **Kind enum (project_convention/stack_pattern/workflow_rule/anti_pattern) (P14)**
- [ ] **Secret sanitization layer (P12) - SECURITY CRITICAL**
- [ ] Effective score calculation with 4× harmful multiplier (P4)
- [ ] Configuration management (load/save config.json)
- [ ] cass integration wrapper with error handling
- [ ] Basic CLI scaffolding with commander/clap-style parsing
- [ ] YAML playbook read/write
- [ ] Structured JSON context output (P2)

**Deliverable**: `cm init`, `cm context --json`

### Phase 2: Core Pipeline + Anti-Patterns

- [ ] Diary generation command (`diary`)
- [ ] Playbook management with maturity states (P5)
- [ ] Anti-pattern inversion in curator (P3)
- [ ] Forget command + toxic bullet log (P8)
- [ ] Cascading configuration (global + .cass/) (P6)
- [ ] Mark command with event timestamps
- [ ] Deterministic curator with decay-aware pruning
- [ ] Processed.log tracking
- [ ] **Evidence-count gate before validator (P11)**
- [ ] **Doctor command for system health (P13)**

**Deliverable**: Full diary → reflect → curate pipeline with anti-pattern learning

### Phase 3: Advanced Features + Intelligence

- [ ] Multi-iteration reflector (ACE pattern)
- [ ] Scientific validation (GPT Pro pattern)
- [ ] Local semantic search with @xenova/transformers (P7)
- [ ] Stats command - playbook health dashboard (P9)
- [ ] Cross-agent enrichment in diaries
- [ ] Semantic deduplication (Jaccard + embeddings)
- [ ] Search pointers support

**Deliverable**: Complete intelligent reflection with semantic matching

### Phase 4: Polish & Integration

- [ ] Audit command
- [ ] Project/export command (AGENTS.md generation)
- [ ] Deprecated patterns/tombstone support
- [ ] Comprehensive error handling
- [ ] Binary compilation for distribution
- [ ] Documentation and examples

**Deliverable**: Production-ready CLI

### Future Enhancements

- [ ] MCP server mode for direct agent integration
- [ ] Team playbooks with merge/conflict resolution
- [ ] Visualization of playbook evolution (decay curves, maturity transitions)
- [ ] Pattern detection across sessions
- [ ] Auto-reflection hooks (post-session triggers)
- [ ] Conflict detection between bullets

---

## Comparison with Individual Proposals

| Feature | This Plan | Claude | GPT Pro | Gemini | Grok |
|---------|-----------|--------|---------|--------|------|
| **Scientific validation** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Search pointers** | ✅ | ❌ | ❌ | ✅ | ❌ |
| **Deprecated patterns (tombstones)** | ✅ | ❌ | ❌ | ✅ | ❌ |
| **Multi-iteration reflection** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Cross-agent enrichment** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Deterministic curator** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Workspace scoping** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Hydration command** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Audit command** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Source tracing** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **YAML playbook** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **JSONL playbook option** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Usage logging** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Auto-pruning** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **MCP server (planned)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Confidence decay** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Anti-pattern inversion** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Maturity states** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Cascading config** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Local semantic search** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Stats dashboard** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Forget + toxic log** | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## Files to Create

1. **`src/cm.ts`** - Main CLI entry point (~2000 LOC)
2. **`src/types.ts`** - TypeScript interfaces and Zod schemas
3. **`src/cass.ts`** - cass integration wrapper
4. **`src/llm.ts`** - LLM provider abstraction
5. **`src/playbook.ts`** - Playbook read/write/curate
6. **`src/diary.ts`** - Diary generation
7. **`src/reflect.ts`** - Reflection pipeline
8. **`src/validate.ts`** - Scientific validation
9. **`package.json`** - Dependencies and build scripts
10. **`AGENTS.md`** - Agent integration documentation
11. **`README.md`** - User documentation

---

---

## Detailed Implementation Specifications

### File-by-File Implementation Guide

#### 1. `package.json`

```json
{
  "name": "cass-memory",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "cm": "./dist/cm.js"
  },
  "scripts": {
    "dev": "bun run src/cm.ts",
    "build": "bun build src/cm.ts --compile --outfile dist/cm",
    "build:all": "npm run build:linux && npm run build:macos && npm run build:windows",
    "build:linux": "bun build src/cm.ts --compile --target=bun-linux-x64 --outfile dist/cm-linux-x64",
    "build:macos": "bun build src/cm.ts --compile --target=bun-darwin-arm64 --outfile dist/cm-darwin-arm64",
    "build:windows": "bun build src/cm.ts --compile --target=bun-windows-x64 --outfile dist/cm-windows-x64.exe",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "@ai-sdk/google": "^1.0.0",
    "zod": "^3.23.0",
    "yaml": "^2.3.0",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  }
}
```

#### 2. `src/types.ts` - Complete Type Definitions

```typescript
import { z } from "zod";

// ============================================================================
// CONFIGURATION
// ============================================================================

export const ConfigSchema = z.object({
  schema_version: z.number().default(1),
  provider: z.enum(["openai", "anthropic", "google"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  cassPath: z.string().default("cass"),

  // Paths
  playbookPath: z.string().default("~/.cass-memory/playbook.yaml"),
  diaryDir: z.string().default("~/.cass-memory/diary"),

  // Reflection settings
  maxReflectorIterations: z.number().min(1).max(10).default(3),
  dedupSimilarityThreshold: z.number().min(0).max(1).default(0.85),
  pruneHarmfulThreshold: z.number().min(1).max(10).default(3),

  // Context settings
  maxBulletsInContext: z.number().min(5).max(200).default(50),
  maxHistoryInContext: z.number().min(3).max(50).default(10),

  // Session settings
  sessionLookbackDays: z.number().min(1).max(365).default(7),
  validationLookbackDays: z.number().min(30).max(365).default(90),

  // Feature flags
  validationEnabled: z.boolean().default(true),
  autoReflect: z.boolean().default(false),
  enrichWithCrossAgent: z.boolean().default(true),

  // Logging
  verbose: z.boolean().default(false),
  jsonOutput: z.boolean().default(false)
});

export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// DIARY ENTRIES
// ============================================================================

export const DiaryEntrySchema = z.object({
  // Identity
  id: z.string(),
  sessionPath: z.string(),

  // Metadata
  timestamp: z.string().datetime(),
  agent: z.string(),
  workspace: z.string().optional(),
  duration: z.number().optional(),

  // Core content
  status: z.enum(["success", "failure", "mixed"]),
  accomplishments: z.array(z.string()).min(1),
  decisions: z.array(z.string()),
  challenges: z.array(z.string()),
  preferences: z.array(z.string()),
  keyLearnings: z.array(z.string()),

  // Cross-agent enrichment
  relatedSessions: z.array(z.object({
    sessionPath: z.string(),
    agent: z.string(),
    relevanceScore: z.number(),
    snippet: z.string()
  })).optional(),

  // Tagging
  tags: z.array(z.string()),
  searchAnchors: z.array(z.string())
});

export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

// LLM extraction output (simpler schema for generation)
export const DiaryExtractionSchema = z.object({
  status: z.enum(["success", "failure", "mixed"]),
  accomplishments: z.array(z.string()).min(1).max(10).describe("Specific things completed. Include file names, function names."),
  decisions: z.array(z.string()).max(10).describe("Design choices with rationale"),
  challenges: z.array(z.string()).max(10).describe("Problems encountered with solutions or workarounds"),
  preferences: z.array(z.string()).max(10).describe("User style revelations"),
  keyLearnings: z.array(z.string()).max(10).describe("Reusable insights for future sessions"),
  suggestedTags: z.array(z.string()).max(10).describe("Relevant topic tags")
});

export type DiaryExtraction = z.infer<typeof DiaryExtractionSchema>;

// ============================================================================
// PLAYBOOK BULLETS
// ============================================================================

export const PlaybookBulletSchema = z.object({
  // Identity
  id: z.string(),

  // Scope
  scope: z.enum(["global", "workspace"]).default("global"),
  workspace: z.string().optional(),

  // Content
  category: z.string(),
  content: z.string().min(10).max(500),
  searchPointer: z.string().optional(),

  // Tracking
  helpfulCount: z.number().default(0),
  harmfulCount: z.number().default(0),

  // Lifecycle
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deprecated: z.boolean().default(false),
  replacedBy: z.string().optional(),
  deprecationReason: z.string().optional(),

  // Provenance
  sourceSessions: z.array(z.string()),
  sourceAgents: z.array(z.string()),

  // Tagging
  tags: z.array(z.string())
});

export type PlaybookBullet = z.infer<typeof PlaybookBulletSchema>;

// ============================================================================
// DELTAS
// ============================================================================

export const NewBulletDataSchema = z.object({
  category: z.string(),
  content: z.string().min(10).max(500),
  tags: z.array(z.string()),
  searchPointer: z.string().optional(),
  scope: z.enum(["global", "workspace"]).default("global"),
  workspace: z.string().optional()
});

export type NewBulletData = z.infer<typeof NewBulletDataSchema>;

export const DeltaSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    bullet: NewBulletDataSchema,
    reason: z.string(),
    sourceSession: z.string()
  }),
  z.object({
    type: z.literal("helpful"),
    bulletId: z.string(),
    sourceSession: z.string().optional()
  }),
  z.object({
    type: z.literal("harmful"),
    bulletId: z.string(),
    sourceSession: z.string().optional(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("replace"),
    bulletId: z.string(),
    newContent: z.string(),
    reason: z.string()
  }),
  z.object({
    type: z.literal("deprecate"),
    bulletId: z.string(),
    reason: z.string(),
    replacedBy: z.string().optional()
  }),
  z.object({
    type: z.literal("merge"),
    bulletIds: z.array(z.string()),
    mergedContent: z.string(),
    reason: z.string()
  })
]);

export type Delta = z.infer<typeof DeltaSchema>;

// LLM extraction output for reflection
export const ReflectorOutputSchema = z.object({
  deltas: z.array(z.object({
    type: z.enum(["add", "helpful", "harmful", "replace", "deprecate"]),
    bulletId: z.string().optional().describe("Required for helpful/harmful/replace/deprecate"),
    category: z.string().optional().describe("Required for add"),
    content: z.string().optional().describe("Required for add/replace"),
    tags: z.array(z.string()).optional().describe("Required for add"),
    reason: z.string().describe("Why this delta is proposed")
  })).max(20)
});

export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;

// ============================================================================
// PLAYBOOK FILE
// ============================================================================

export const DeprecatedPatternSchema = z.object({
  pattern: z.string(),
  deprecatedAt: z.string(),
  reason: z.string(),
  replacement: z.string().optional()
});

export type DeprecatedPattern = z.infer<typeof DeprecatedPatternSchema>;

export const PlaybookSchema = z.object({
  schema_version: z.number().default(2),
  name: z.string().default("playbook"),
  description: z.string().optional(),

  metadata: z.object({
    createdAt: z.string().datetime(),
    lastReflection: z.string().datetime().optional(),
    totalReflections: z.number().default(0),
    totalSessionsProcessed: z.number().default(0)
  }),

  deprecatedPatterns: z.array(DeprecatedPatternSchema).default([]),
  bullets: z.array(PlaybookBulletSchema).default([])
});

export type Playbook = z.infer<typeof PlaybookSchema>;

// ============================================================================
// CASS INTEGRATION
// ============================================================================

export interface CassSearchOptions {
  limit?: number;
  days?: number;
  agent?: string | string[];
  workspace?: string;
  fields?: "minimal" | "summary" | "full";
  maxTokens?: number;
  highlight?: boolean;
  explain?: boolean;
  timeout?: number;
}

export interface CassHit {
  source_path: string;
  line_number: number;
  agent: string;
  workspace: string;
  title: string;
  snippet: string;
  score: number;
  created_at: string;
}

export interface CassSearchResult {
  hits: CassHit[];
  _meta?: {
    elapsed_ms: number;
    total_hits: number;
    wildcard_fallback: boolean;
    query_plan?: string;
  };
}

export interface CassTimelineGroup {
  date: string;
  agents: Record<string, number>;
  total: number;
}

export interface CassTimelineResult {
  groups: CassTimelineGroup[];
}

// ============================================================================
// VALIDATION
// ============================================================================

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
  refinedContent: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export interface ValidationReport {
  proposedRule: string;
  verdict: "ACCEPT" | "REJECT" | "ACCEPT_WITH_CAUTION";
  confidence: number;
  evidence: Array<{
    sessionPath: string;
    agent: string;
    supports: boolean;
    snippet: string;
  }>;
  reason: string;
  refinedRule?: string;
}

// ============================================================================
// CONTEXT/HYDRATION
// ============================================================================

export interface ContextResult {
  task: string;
  bullets: Array<{
    id: string;
    content: string;
    category: string;
    relevanceScore: number;
    helpfulCount: number;
  }>;
  history: CassHit[];
  warnings: string[];
  formattedPrompt: string;
}

// ============================================================================
// AUDIT
// ============================================================================

export interface AuditViolation {
  bulletId: string;
  bulletContent: string;
  sessionPath: string;
  evidence: string;
  severity: "low" | "medium" | "high";
}

export interface AuditResult {
  sessionsScanned: number;
  violations: AuditViolation[];
  suggestions: string[];
}

// ============================================================================
// CLI COMMAND RESULTS
// ============================================================================

export interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}
```

#### 3. `src/utils.ts` - Utility Functions

```typescript
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";

// ============================================================================
// PATH UTILITIES
// ============================================================================

export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

export async function ensureDir(dir: string): Promise<void> {
  const expanded = expandPath(dir);
  await fs.mkdir(expanded, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(expandPath(filePath));
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// CONTENT HASHING & DEDUPLICATION
// ============================================================================

export function hashContent(content: string): string {
  return createHash("sha256")
    .update(content.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compute Jaccard similarity between two strings
 * (for semantic deduplication)
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return intersection.size / union.size;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// ============================================================================
// ID GENERATION
// ============================================================================

export function generateBulletId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `b-${timestamp}-${random}`;
}

export function generateDiaryId(sessionPath: string): string {
  const hash = hashContent(sessionPath + Date.now().toString());
  return `diary-${hash}`;
}

// ============================================================================
// DATE/TIME UTILITIES
// ============================================================================

export function now(): string {
  return new Date().toISOString();
}

export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

// ============================================================================
// TEXT UTILITIES
// ============================================================================

export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "under", "again", "further", "then", "once", "here",
    "there", "when", "where", "why", "how", "all", "each", "every",
    "both", "few", "more", "most", "other", "some", "such", "no",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "and", "but", "if", "or", "because", "until", "while", "although",
    "use", "using", "used", "always", "never", "when", "also"
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 10);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// ============================================================================
// SCORING
// ============================================================================

export function scoreBulletRelevance(
  bulletContent: string,
  bulletTags: string[],
  keywords: string[]
): number {
  let score = 0;
  const contentLower = bulletContent.toLowerCase();
  const keywordsLower = keywords.map(k => k.toLowerCase());

  // Direct keyword matches in content
  for (const keyword of keywordsLower) {
    if (contentLower.includes(keyword)) {
      score += 2;
    }
  }

  // Tag matches
  for (const tag of bulletTags) {
    if (keywordsLower.includes(tag.toLowerCase())) {
      score += 3;
    }
  }

  return score;
}

// ============================================================================
// LOGGING
// ============================================================================

export function log(message: string, verbose = false): void {
  if (verbose || process.env.CASS_MEMORY_VERBOSE) {
    console.error(`[cass-memory] ${message}`);
  }
}

export function error(message: string): void {
  console.error(`[cass-memory] ERROR: ${message}`);
}
```

#### 4. `src/cass.ts` - Complete cass Integration

```typescript
import { execSync, spawn } from "child_process";
import type { CassSearchOptions, CassHit, CassSearchResult, CassTimelineResult } from "./types";
import { log, error } from "./utils";

// ============================================================================
// CASS EXIT CODES
// ============================================================================

const CASS_EXIT_CODES: Record<number, { name: string; retryable: boolean; action?: string }> = {
  0: { name: "success", retryable: false },
  2: { name: "usage_error", retryable: false },
  3: { name: "index_missing", retryable: true, action: "rebuild_index" },
  4: { name: "not_found", retryable: false },
  5: { name: "idempotency_mismatch", retryable: false },
  9: { name: "unknown", retryable: false },
  10: { name: "timeout", retryable: true, action: "reduce_limit" }
};

// ============================================================================
// HEALTH CHECK
// ============================================================================

export function cassAvailable(cassPath = "cass"): boolean {
  try {
    execSync(`${cassPath} health`, {
      timeout: 200,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return true;
  } catch {
    return false;
  }
}

export function cassNeedsIndex(cassPath = "cass"): boolean {
  try {
    const result = execSync(`${cassPath} health`, {
      timeout: 200,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    // Exit code 0 means healthy, exit code 1 means needs rebuild
    return false;
  } catch (e: any) {
    return e.status === 1 || e.status === 3;
  }
}

// ============================================================================
// INDEX MANAGEMENT
// ============================================================================

export async function cassIndex(
  cassPath = "cass",
  options: { full?: boolean; incremental?: boolean } = {}
): Promise<void> {
  const args = ["index"];
  if (options.full) args.push("--full");
  if (options.incremental) args.push("--incremental");

  log(`Running: ${cassPath} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(cassPath, args, {
      stdio: ["inherit", "inherit", "inherit"]
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cass index failed with code ${code}`));
    });
  });
}

// ============================================================================
// SEARCH
// ============================================================================

export async function cassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass"
): Promise<CassHit[]> {
  const args = ["search", query, "--robot"];

  if (options.limit) args.push("--limit", String(options.limit));
  if (options.days) args.push("--days", String(options.days));
  if (options.agent) {
    const agents = Array.isArray(options.agent)
      ? options.agent.join(",")
      : options.agent;
    args.push("--agent", agents);
  }
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields);
  if (options.maxTokens) args.push("--max-tokens", String(options.maxTokens));
  if (options.highlight) args.push("--highlight");
  if (options.timeout) args.push("--timeout", String(options.timeout));

  log(`Running: ${cassPath} ${args.join(" ")}`);

  try {
    const result = execSync(`${cassPath} ${args.join(" ")}`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeout || 30000
    });

    const parsed: CassSearchResult = JSON.parse(result);
    return parsed.hits || [];
  } catch (e: any) {
    const exitCode = e.status || 9;
    const errorInfo = CASS_EXIT_CODES[exitCode] || CASS_EXIT_CODES[9];

    error(`cass search failed: ${errorInfo.name} (exit ${exitCode})`);

    // Handle retryable errors
    if (errorInfo.action === "rebuild_index") {
      error("Index missing, attempting rebuild...");
      await cassIndex(cassPath, { full: true });
      return cassSearch(query, options, cassPath);
    }

    if (errorInfo.action === "reduce_limit" && options.limit && options.limit > 3) {
      error("Timeout, retrying with reduced limit...");
      return cassSearch(query, { ...options, limit: 3 }, cassPath);
    }

    return [];
  }
}

/**
 * Safe search wrapper with automatic error recovery
 */
export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass"
): Promise<CassHit[]> {
  // Check if cass is available
  if (!cassAvailable(cassPath)) {
    error("cass is not available in PATH");
    return [];
  }

  // Check if index needs rebuild
  if (cassNeedsIndex(cassPath)) {
    log("Index needs rebuild, running incremental index...");
    try {
      await cassIndex(cassPath, { incremental: true });
    } catch (e) {
      error("Failed to rebuild index");
      return [];
    }
  }

  return cassSearch(query, options, cassPath);
}

// ============================================================================
// EXPORT
// ============================================================================

export async function cassExport(
  sessionPath: string,
  format: "markdown" | "json" | "text" = "markdown",
  cassPath = "cass"
): Promise<string | null> {
  try {
    const result = execSync(
      `${cassPath} export "${sessionPath}" --format ${format}`,
      {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024
      }
    );
    return result;
  } catch (e) {
    error(`Failed to export session: ${sessionPath}`);
    return null;
  }
}

// ============================================================================
// TIMELINE
// ============================================================================

export async function cassTimeline(
  days: number,
  cassPath = "cass"
): Promise<CassTimelineResult> {
  try {
    const result = execSync(
      `${cassPath} timeline --days ${days} --json`,
      { encoding: "utf-8" }
    );
    return JSON.parse(result);
  } catch {
    return { groups: [] };
  }
}

// ============================================================================
// EXPAND (context around a line)
// ============================================================================

export async function cassExpand(
  sessionPath: string,
  lineNumber: number,
  contextLines = 3,
  cassPath = "cass"
): Promise<string | null> {
  try {
    const result = execSync(
      `${cassPath} expand "${sessionPath}" -n ${lineNumber} -C ${contextLines} --json`,
      { encoding: "utf-8" }
    );
    return result;
  } catch {
    return null;
  }
}

// ============================================================================
// STATS
// ============================================================================

export interface CassStats {
  totalConversations: number;
  totalMessages: number;
  agentBreakdown: Record<string, number>;
  oldestSession: string;
  newestSession: string;
}

export async function cassStats(cassPath = "cass"): Promise<CassStats | null> {
  try {
    const result = execSync(`${cassPath} stats --json`, { encoding: "utf-8" });
    return JSON.parse(result);
  } catch {
    return null;
  }
}
```

#### 5. `src/llm.ts` - Complete LLM Integration

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { Config } from "./types";
import { error } from "./utils";

// ============================================================================
// PROVIDER SETUP
// ============================================================================

function getApiKey(provider: string): string {
  const envVars: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY"
  };

  const key = process.env[envVars[provider]];
  if (!key) {
    throw new Error(`Missing environment variable: ${envVars[provider]}`);
  }
  return key;
}

function getModel(config: Config) {
  const apiKey = getApiKey(config.provider);

  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey })(config.model);
    case "anthropic":
      return createAnthropic({ apiKey })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// ============================================================================
// PROMPTS
// ============================================================================

export const PROMPTS = {
  diary: `
You are analyzing a coding agent session to extract structured insights.

SESSION METADATA:
- Path: {sessionPath}
- Agent: {agent}
- Workspace: {workspace}

SESSION CONTENT:
{content}

INSTRUCTIONS:
Extract the following from this session. Be SPECIFIC and ACTIONABLE.
Avoid generic statements like "wrote code" or "fixed bug".
Include specific:
- File names and paths
- Function/class/component names
- Error messages and stack traces
- Commands run
- Tools used

If the session lacks information for a field, provide an empty array.
`.trim(),

  reflector: `
You are extracting reusable lessons from a coding session for a playbook.

EXISTING PLAYBOOK BULLETS (summarized by category):
{existingBullets}

SESSION DIARY:
- Status: {status}
- Accomplishments: {accomplishments}
- Decisions: {decisions}
- Challenges: {challenges}
- Preferences: {preferences}
- Key Learnings: {keyLearnings}

RELATED HISTORY FROM OTHER AGENTS (via cass):
{cassHistory}

{iterationNote}

INSTRUCTIONS:
Analyze this session and propose playbook deltas:

1. ADD: New insight not covered by existing bullets
   - Must be SPECIFIC and reusable
   - Bad: "Write tests"
   - Good: "For React async effects, wrap test assertions in waitFor()"

2. HELPFUL: Existing bullet proved useful in this session
   - Reference the bullet ID

3. HARMFUL: Following existing bullet caused problems
   - Reference the bullet ID and explain what went wrong

4. REPLACE: Existing bullet needs updated/better wording
   - Reference the bullet ID and provide new content

5. DEPRECATE: Existing bullet is outdated/wrong
   - Reference the bullet ID and explain why

Guidelines:
- Only propose deltas for genuinely reusable insights
- Consider: Would this help a DIFFERENT agent on a similar problem?
- Include concrete examples, file patterns, command flags when available
- Maximum 20 deltas per reflection
`.trim(),

  validator: `
You are validating a proposed playbook rule against historical evidence.

PROPOSED RULE:
"{proposedRule}"

HISTORICAL EVIDENCE FROM CASS (last 90 days):
{evidence}

INSTRUCTIONS:
Analyze whether the evidence supports or contradicts this rule.

Criteria:
- INVALID: Evidence shows this pattern FAILED multiple times
- INVALID: Rule is too generic/obvious to be useful
- VALID: Evidence supports it OR is neutral
- Consider refining the wording if evidence suggests improvements

Be specific in your reasoning, citing session paths when relevant.
`.trim(),

  context: `
You are generating a pre-task briefing for a coding agent.

TASK:
{task}

RELEVANT PLAYBOOK BULLETS (sorted by relevance):
{bullets}

RELATED HISTORICAL SESSIONS (from cass):
{history}

DEPRECATED PATTERNS TO AVOID:
{deprecatedPatterns}

INSTRUCTIONS:
Generate a concise briefing that:
1. Highlights the 3-5 most relevant playbook rules with their IDs
2. Points to specific historical solutions (cite session paths)
3. Warns about deprecated patterns if any were matched
4. Suggests cass search queries for more context if the task is complex

Format for agent consumption: structured, scannable, actionable.
`.trim(),

  audit: `
You are auditing a coding session for playbook rule violations.

SESSION SUMMARY:
{sessionSummary}

PLAYBOOK RULES TO CHECK:
{rules}

INSTRUCTIONS:
Identify any violations where the session clearly contradicted a playbook rule.
Only report clear violations, not minor deviations.

For each violation:
- Reference the bullet ID
- Quote specific evidence from the session
- Assess severity: low/medium/high
`.trim()
};

// ============================================================================
// GENERATION FUNCTIONS
// ============================================================================

export async function extractDiary<T extends z.ZodSchema>(
  schema: T,
  sessionContent: string,
  metadata: { sessionPath: string; agent: string; workspace?: string },
  config: Config
): Promise<z.infer<T>> {
  const prompt = PROMPTS.diary
    .replace("{sessionPath}", metadata.sessionPath)
    .replace("{agent}", metadata.agent)
    .replace("{workspace}", metadata.workspace || "unknown")
    .replace("{content}", truncateForContext(sessionContent, 50000));

  const { object } = await generateObject({
    model: getModel(config),
    schema,
    prompt,
    temperature: 0.3
  });

  return object;
}

export async function runReflector<T extends z.ZodSchema>(
  schema: T,
  diary: any,
  existingBullets: string,
  cassHistory: string,
  iteration: number,
  config: Config
): Promise<z.infer<T>> {
  const iterationNote = iteration > 0
    ? `\nThis is iteration ${iteration + 1}. Focus on insights you may have missed.`
    : "";

  const prompt = PROMPTS.reflector
    .replace("{existingBullets}", existingBullets)
    .replace("{status}", diary.status)
    .replace("{accomplishments}", JSON.stringify(diary.accomplishments))
    .replace("{decisions}", JSON.stringify(diary.decisions))
    .replace("{challenges}", JSON.stringify(diary.challenges))
    .replace("{preferences}", JSON.stringify(diary.preferences))
    .replace("{keyLearnings}", JSON.stringify(diary.keyLearnings))
    .replace("{cassHistory}", cassHistory)
    .replace("{iterationNote}", iterationNote);

  const { object } = await generateObject({
    model: getModel(config),
    schema,
    prompt,
    temperature: 0.5
  });

  return object;
}

export async function runValidator<T extends z.ZodSchema>(
  schema: T,
  proposedRule: string,
  evidence: string,
  config: Config
): Promise<z.infer<T>> {
  const prompt = PROMPTS.validator
    .replace("{proposedRule}", proposedRule)
    .replace("{evidence}", evidence);

  const { object } = await generateObject({
    model: getModel(config),
    schema,
    prompt,
    temperature: 0.2
  });

  return object;
}

export async function generateContext(
  task: string,
  bullets: string,
  history: string,
  deprecatedPatterns: string,
  config: Config
): Promise<string> {
  const prompt = PROMPTS.context
    .replace("{task}", task)
    .replace("{bullets}", bullets)
    .replace("{history}", history)
    .replace("{deprecatedPatterns}", deprecatedPatterns);

  const { text } = await generateText({
    model: getModel(config),
    prompt,
    temperature: 0.3,
    maxTokens: 2000
  });

  return text;
}

export async function generateSearchQueries(
  task: string,
  config: Config
): Promise<string[]> {
  const { object } = await generateObject({
    model: getModel(config),
    schema: z.object({
      queries: z.array(z.string()).max(5).describe("Search queries for cass")
    }),
    prompt: `
      Task: "${task}"

      Generate 3-5 diverse search queries to find relevant historical context.
      Include queries for:
      - Similar problems/errors
      - Related file types or frameworks
      - Relevant patterns or anti-patterns
    `,
    temperature: 0.5
  });

  return object.queries;
}

// ============================================================================
// UTILITIES
// ============================================================================

function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[... truncated for context limit ...]";
}
```

### Detailed Algorithm Specifications

#### Semantic Deduplication Algorithm

```typescript
/**
 * Check if a new bullet is semantically similar to existing ones
 * using Jaccard similarity on tokenized content
 */
function isDuplicateBullet(
  newContent: string,
  existingBullets: PlaybookBullet[],
  threshold: number = 0.85
): { isDuplicate: boolean; matchingBullet?: PlaybookBullet } {
  for (const bullet of existingBullets) {
    if (bullet.deprecated) continue;

    const similarity = jaccardSimilarity(newContent, bullet.content);
    if (similarity >= threshold) {
      return { isDuplicate: true, matchingBullet: bullet };
    }
  }
  return { isDuplicate: false };
}

/**
 * Group bullets by semantic similarity for potential merging
 */
function findMergeCandidates(
  bullets: PlaybookBullet[],
  minSimilarity: number = 0.7
): PlaybookBullet[][] {
  const groups: PlaybookBullet[][] = [];
  const used = new Set<string>();

  for (const bullet of bullets) {
    if (used.has(bullet.id)) continue;

    const group = [bullet];
    used.add(bullet.id);

    for (const other of bullets) {
      if (used.has(other.id)) continue;
      if (bullet.category !== other.category) continue;

      const similarity = jaccardSimilarity(bullet.content, other.content);
      if (similarity >= minSimilarity) {
        group.push(other);
        used.add(other.id);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}
```

#### Bullet Scoring Algorithm

```typescript
interface ScoredBullet extends PlaybookBullet {
  relevanceScore: number;
  confidenceScore: number;
}

function scoreBulletsForTask(
  bullets: PlaybookBullet[],
  task: string,
  taskKeywords: string[]
): ScoredBullet[] {
  return bullets
    .filter(b => !b.deprecated)
    .map(bullet => {
      // Relevance: keyword overlap
      let relevance = 0;
      const contentLower = bullet.content.toLowerCase();
      for (const keyword of taskKeywords) {
        if (contentLower.includes(keyword.toLowerCase())) {
          relevance += 2;
        }
      }
      for (const tag of bullet.tags) {
        if (taskKeywords.some(k => k.toLowerCase() === tag.toLowerCase())) {
          relevance += 3;
        }
      }

      // Confidence: helpful vs harmful ratio
      const total = bullet.helpfulCount + bullet.harmfulCount;
      const confidence = total > 0
        ? bullet.helpfulCount / total
        : 0.5;

      return {
        ...bullet,
        relevanceScore: relevance,
        confidenceScore: confidence
      };
    })
    .sort((a, b) => {
      // Primary: relevance, Secondary: confidence, Tertiary: helpful count
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      if (b.confidenceScore !== a.confidenceScore) {
        return b.confidenceScore - a.confidenceScore;
      }
      return b.helpfulCount - a.helpfulCount;
    });
}
```

#### Processed Sessions Tracking

```typescript
interface ProcessedEntry {
  id: string;
  sessionPath: string;
  processedAt: string;
  diaryId?: string;
  deltasProposed: number;
  deltasApplied: number;
}

class ProcessedLog {
  private entries: Map<string, ProcessedEntry> = new Map();
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = expandPath(logPath);
  }

  async load(): Promise<void> {
    if (!(await fileExists(this.logPath))) return;

    const content = await fs.readFile(this.logPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length >= 2) {
        this.entries.set(parts[1], {
          id: parts[0],
          sessionPath: parts[1],
          processedAt: parts[2] || now(),
          deltasProposed: parseInt(parts[3]) || 0,
          deltasApplied: parseInt(parts[4]) || 0
        });
      }
    }
  }

  async save(): Promise<void> {
    const lines = ["# cass-memory processed sessions log"];
    for (const entry of this.entries.values()) {
      lines.push([
        entry.id,
        entry.sessionPath,
        entry.processedAt,
        entry.deltasProposed,
        entry.deltasApplied
      ].join("\t"));
    }
    await fs.writeFile(this.logPath, lines.join("\n"));
  }

  isProcessed(sessionPath: string): boolean {
    return this.entries.has(sessionPath);
  }

  markProcessed(entry: ProcessedEntry): void {
    this.entries.set(entry.sessionPath, entry);
  }

  getUnprocessedSessions(allSessions: string[]): string[] {
    return allSessions.filter(s => !this.isProcessed(s));
  }
}
```

---

## Edge Cases and Error Handling

### 1. cass Unavailability

**Scenario**: cass is not installed, not in PATH, or crashes

```typescript
// Edge case: cass not available
async function handleCassUnavailable(): CommandResult {
  // Check if cass exists
  if (!cassAvailable()) {
    // Try common installation paths
    const commonPaths = [
      "/usr/local/bin/cass",
      "~/.cargo/bin/cass",
      "~/.local/bin/cass"
    ];

    for (const p of commonPaths) {
      if (await fileExists(p)) {
        // Update config with found path
        return { success: true, message: `Found cass at ${p}` };
      }
    }

    return {
      success: false,
      error: "cass not found",
      message: `Install cass from https://github.com/Dicklesworthstone/coding_agent_session_search
               or set CASS_PATH environment variable`
    };
  }
}

// Graceful degradation when cass fails
async function contextWithoutCass(task: string, config: Config): Promise<ContextResult> {
  console.error("[cass-memory] Warning: cass unavailable, using playbook only");

  // Still useful without cass - just return playbook bullets
  const playbook = await loadPlaybook(config);
  const keywords = extractKeywords(task);
  const bullets = scoreBulletsForTask(playbook.bullets, task, keywords);

  return {
    task,
    bullets: bullets.slice(0, config.maxBulletsInContext),
    history: [],  // Empty - no cass
    warnings: ["cass unavailable - showing playbook only"],
    formattedPrompt: formatBulletsOnly(bullets)
  };
}
```

### 2. Empty or Corrupt Playbook

**Scenario**: Playbook file doesn't exist, is empty, or has invalid YAML

```typescript
async function loadPlaybookSafe(config: Config): Promise<Playbook> {
  const playbookPath = expandPath(config.playbookPath);

  try {
    if (!(await fileExists(playbookPath))) {
      // Create new playbook
      console.error("[cass-memory] No playbook found, creating new one");
      const newPlaybook = createEmptyPlaybook();
      await savePlaybook(newPlaybook, config);
      return newPlaybook;
    }

    const content = await fs.readFile(playbookPath, "utf-8");

    if (!content.trim()) {
      // Empty file
      console.error("[cass-memory] Playbook empty, reinitializing");
      const newPlaybook = createEmptyPlaybook();
      await savePlaybook(newPlaybook, config);
      return newPlaybook;
    }

    const parsed = yaml.parse(content);
    const validated = PlaybookSchema.safeParse(parsed);

    if (!validated.success) {
      // Invalid schema - backup and recreate
      const backupPath = `${playbookPath}.backup.${Date.now()}`;
      await fs.rename(playbookPath, backupPath);
      console.error(`[cass-memory] Corrupt playbook backed up to ${backupPath}`);

      const newPlaybook = createEmptyPlaybook();
      await savePlaybook(newPlaybook, config);
      return newPlaybook;
    }

    return validated.data;

  } catch (e: any) {
    if (e.code === "EACCES") {
      throw new Error(`Permission denied reading playbook: ${playbookPath}`);
    }
    throw e;
  }
}

function createEmptyPlaybook(): Playbook {
  return {
    schema_version: 2,
    name: "playbook",
    description: "Auto-generated by cass-memory",
    metadata: {
      createdAt: now(),
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    deprecatedPatterns: [],
    bullets: []
  };
}
```

### 3. LLM API Failures

**Scenario**: API key invalid, rate limited, timeout, or unexpected response

```typescript
// Retry configuration
const LLM_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrors: [
    "rate_limit_exceeded",
    "server_error",
    "timeout",
    "overloaded"
  ]
};

async function llmWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < LLM_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (e: any) {
      lastError = e;

      // Check if retryable
      const isRetryable = LLM_RETRY_CONFIG.retryableErrors.some(
        err => e.message?.includes(err) || e.code === err
      );

      if (!isRetryable) {
        throw e;  // Not retryable, fail immediately
      }

      // Calculate backoff delay
      const delay = Math.min(
        LLM_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
        LLM_RETRY_CONFIG.maxDelayMs
      );

      console.error(
        `[cass-memory] ${operationName} failed (attempt ${attempt + 1}/${LLM_RETRY_CONFIG.maxRetries}), ` +
        `retrying in ${delay}ms: ${e.message}`
      );

      await sleep(delay);
    }
  }

  throw new Error(`${operationName} failed after ${LLM_RETRY_CONFIG.maxRetries} attempts: ${lastError?.message}`);
}

// Handling API key issues
function validateApiKey(provider: string): void {
  const envVars: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY"
  };

  const envVar = envVars[provider];
  const key = process.env[envVar];

  if (!key) {
    throw new Error(
      `Missing ${envVar} environment variable.\n` +
      `Set it with: export ${envVar}="your-api-key"\n` +
      `Or add to ~/.cass-memory/config.json`
    );
  }

  // Basic format validation
  if (provider === "openai" && !key.startsWith("sk-")) {
    console.warn("[cass-memory] Warning: OpenAI key doesn't start with 'sk-'");
  }
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    console.warn("[cass-memory] Warning: Anthropic key doesn't start with 'sk-ant-'");
  }
}

// Fallback to different provider
async function llmWithFallback<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config
): Promise<T> {
  const providers = ["anthropic", "openai", "google"];

  // Try primary provider first
  const primaryIndex = providers.indexOf(config.provider);
  const orderedProviders = [
    config.provider,
    ...providers.filter(p => p !== config.provider)
  ];

  for (const provider of orderedProviders) {
    try {
      const key = process.env[getEnvVar(provider)];
      if (!key) continue;  // Skip providers without keys

      return await generateObjectWithProvider(schema, prompt, provider, config.model);
    } catch (e: any) {
      console.error(`[cass-memory] ${provider} failed: ${e.message}`);
      continue;
    }
  }

  throw new Error("All LLM providers failed");
}
```

### 4. Session Export Failures

**Scenario**: Session file moved/deleted, corrupted, or unsupported format

```typescript
async function exportSessionSafe(
  sessionPath: string,
  cassPath: string
): Promise<{ content: string | null; error?: string }> {
  // Validate path exists
  if (!(await fileExists(sessionPath))) {
    return {
      content: null,
      error: `Session file not found: ${sessionPath}`
    };
  }

  // Check file size (avoid huge files)
  const stats = await fs.stat(sessionPath);
  const MAX_SESSION_SIZE = 50 * 1024 * 1024;  // 50MB

  if (stats.size > MAX_SESSION_SIZE) {
    return {
      content: null,
      error: `Session file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > 50MB limit)`
    };
  }

  // Try cass export
  try {
    const content = await cassExport(sessionPath, "markdown", cassPath);
    if (!content || content.length < 10) {
      return {
        content: null,
        error: "Session export returned empty content"
      };
    }
    return { content };
  } catch (e: any) {
    // Fallback: try reading raw file for supported formats
    const ext = path.extname(sessionPath).toLowerCase();

    if ([".jsonl", ".json", ".md"].includes(ext)) {
      try {
        const rawContent = await fs.readFile(sessionPath, "utf-8");
        return { content: formatRawSession(rawContent, ext) };
      } catch {
        // Fall through to error
      }
    }

    return {
      content: null,
      error: `Failed to export session: ${e.message}`
    };
  }
}

function formatRawSession(content: string, ext: string): string {
  if (ext === ".md") return content;

  if (ext === ".jsonl") {
    const lines = content.split("\n").filter(l => l.trim());
    return lines.map(line => {
      try {
        const msg = JSON.parse(line);
        return `**${msg.role || "unknown"}**: ${msg.content || JSON.stringify(msg)}`;
      } catch {
        return line;
      }
    }).join("\n\n");
  }

  if (ext === ".json") {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data.messages)) {
        return data.messages.map((m: any) =>
          `**${m.role}**: ${m.content}`
        ).join("\n\n");
      }
      return JSON.stringify(data, null, 2);
    } catch {
      return content;
    }
  }

  return content;
}
```

### 5. Concurrent Access and Race Conditions

**Scenario**: Multiple cass-memory processes running simultaneously

```typescript
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LOCK_TIMEOUT_MS = 30000;  // 30 seconds

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

function acquireLock(lockDir: string, operation: string): { acquired: boolean; holder?: LockInfo } {
  const lockFile = join(lockDir, "cass-memory.lock");

  // Ensure lock directory exists
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  // Check existing lock
  if (existsSync(lockFile)) {
    try {
      const existing: LockInfo = JSON.parse(readFileSync(lockFile, "utf-8"));

      // Check if lock is stale
      const age = Date.now() - existing.timestamp;
      if (age < LOCK_TIMEOUT_MS) {
        // Check if process is still alive
        try {
          process.kill(existing.pid, 0);  // Signal 0 = check if alive
          return { acquired: false, holder: existing };
        } catch {
          // Process is dead, lock is orphaned
          console.error(`[cass-memory] Removing orphaned lock from PID ${existing.pid}`);
        }
      } else {
        console.error(`[cass-memory] Removing stale lock (${(age / 1000).toFixed(0)}s old)`);
      }
    } catch {
      // Invalid lock file, remove it
    }
  }

  // Acquire lock
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
    operation
  };

  writeFileSync(lockFile, JSON.stringify(lockInfo));
  return { acquired: true };
}

function releaseLock(lockDir: string): void {
  const lockFile = join(lockDir, "cass-memory.lock");
  try {
    const existing: LockInfo = JSON.parse(readFileSync(lockFile, "utf-8"));
    if (existing.pid === process.pid) {
      unlinkSync(lockFile);
    }
  } catch {
    // Lock already released or by different process
  }
}

// Usage wrapper
async function withLock<T>(
  operation: string,
  fn: () => Promise<T>,
  config: Config
): Promise<T> {
  const lockDir = expandPath("~/.cass-memory");
  const lockResult = acquireLock(lockDir, operation);

  if (!lockResult.acquired) {
    throw new Error(
      `Another cass-memory process is running (PID ${lockResult.holder?.pid}, ` +
      `operation: ${lockResult.holder?.operation}). ` +
      `Wait for it to finish or remove ~/.cass-memory/cass-memory.lock`
    );
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}
```

### 6. Malformed LLM Responses

**Scenario**: LLM returns invalid JSON or doesn't match expected schema

```typescript
async function generateObjectSafe<T>(
  schema: z.ZodSchema<T>,
  prompt: string,
  config: Config,
  maxAttempts: number = 2
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: getModel(config),
        schema,
        prompt,
        temperature: 0.3 + (attempt * 0.1)  // Slightly increase temp on retry
      });

      // Validate with Zod (should be valid, but double-check)
      const parsed = schema.safeParse(object);
      if (!parsed.success) {
        throw new Error(`Schema validation failed: ${parsed.error.message}`);
      }

      return parsed.data;

    } catch (e: any) {
      lastError = e;

      // If it's a parsing error, add more explicit instructions
      if (e.message.includes("JSON") || e.message.includes("parse")) {
        prompt = `${prompt}\n\nIMPORTANT: Return ONLY valid JSON matching the schema. No markdown, no explanations.`;
      }

      console.error(`[cass-memory] LLM response invalid (attempt ${attempt + 1}): ${e.message}`);
    }
  }

  throw new Error(`Failed to get valid LLM response: ${lastError?.message}`);
}

// For diary extraction, provide defaults on failure
async function extractDiarySafe(
  sessionContent: string,
  metadata: { sessionPath: string; agent: string; workspace?: string },
  config: Config
): Promise<DiaryEntry> {
  try {
    const extraction = await extractDiary(
      DiaryExtractionSchema,
      sessionContent,
      metadata,
      config
    );

    return {
      id: generateDiaryId(metadata.sessionPath),
      sessionPath: metadata.sessionPath,
      timestamp: now(),
      agent: metadata.agent,
      workspace: metadata.workspace,
      ...extraction,
      tags: extraction.suggestedTags || [],
      searchAnchors: extractSearchAnchors(extraction)
    };

  } catch (e: any) {
    console.error(`[cass-memory] Diary extraction failed: ${e.message}`);

    // Return minimal diary with raw content
    return {
      id: generateDiaryId(metadata.sessionPath),
      sessionPath: metadata.sessionPath,
      timestamp: now(),
      agent: metadata.agent,
      workspace: metadata.workspace,
      status: "mixed",
      accomplishments: ["[Extraction failed - see raw session]"],
      decisions: [],
      challenges: [`Diary extraction error: ${e.message}`],
      preferences: [],
      keyLearnings: [],
      tags: [metadata.agent],
      searchAnchors: extractKeywords(sessionContent).slice(0, 5)
    };
  }
}
```

### 7. Disk Space and Storage Issues

**Scenario**: Disk full, permissions issues, or quota exceeded

```typescript
async function checkStorageHealth(config: Config): Promise<{
  healthy: boolean;
  warnings: string[];
  errors: string[];
}> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const baseDir = expandPath("~/.cass-memory");

  // Check directory exists and is writable
  try {
    await fs.access(baseDir, fs.constants.W_OK);
  } catch {
    try {
      await fs.mkdir(baseDir, { recursive: true });
    } catch (e: any) {
      errors.push(`Cannot create data directory: ${e.message}`);
      return { healthy: false, warnings, errors };
    }
  }

  // Check available space (platform-specific)
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const result = execSync(`df -k "${baseDir}" | tail -1`, { encoding: "utf-8" });
      const parts = result.split(/\s+/);
      const availableKB = parseInt(parts[3]) || 0;
      const availableMB = availableKB / 1024;

      if (availableMB < 10) {
        errors.push(`Very low disk space: ${availableMB.toFixed(1)}MB available`);
      } else if (availableMB < 100) {
        warnings.push(`Low disk space: ${availableMB.toFixed(1)}MB available`);
      }
    } catch {
      // Ignore df failures
    }
  }

  // Check playbook file size
  const playbookPath = expandPath(config.playbookPath);
  try {
    const stats = await fs.stat(playbookPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB > 10) {
      warnings.push(`Playbook is large (${sizeMB.toFixed(1)}MB). Consider pruning old bullets.`);
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  // Check diary directory size
  const diaryDir = expandPath(config.diaryDir);
  try {
    const files = await fs.readdir(diaryDir);
    if (files.length > 1000) {
      warnings.push(`Many diary entries (${files.length}). Consider archiving old entries.`);
    }
  } catch {
    // Directory doesn't exist yet
  }

  return {
    healthy: errors.length === 0,
    warnings,
    errors
  };
}

// Auto-cleanup old entries
async function pruneOldDiaries(
  maxAgeDays: number = 90,
  config: Config
): Promise<number> {
  const diaryDir = expandPath(config.diaryDir);
  const cutoff = daysAgo(maxAgeDays);
  let pruned = 0;

  try {
    const files = await fs.readdir(diaryDir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = join(diaryDir, file);
      const stats = await fs.stat(filePath);

      if (stats.mtime < cutoff) {
        await fs.unlink(filePath);
        pruned++;
      }
    }
  } catch {
    // Ignore errors
  }

  return pruned;
}
```

### 8. Invalid User Input

**Scenario**: User provides malformed task, invalid bullet ID, bad paths

```typescript
// Input validation utilities
const VALIDATORS = {
  bulletId: (id: string): boolean => {
    return /^b-[a-z0-9]+-[a-z0-9]+$/i.test(id);
  },

  sessionPath: (path: string): boolean => {
    // Basic path validation
    if (!path || path.length > 4096) return false;
    if (path.includes("\0")) return false;  // Null bytes
    return true;
  },

  task: (task: string): boolean => {
    if (!task || task.length < 3) return false;
    if (task.length > 2000) return false;
    return true;
  },

  category: (cat: string): boolean => {
    return /^[a-z][a-z0-9_-]{0,49}$/i.test(cat);
  }
};

function validateInput(
  type: keyof typeof VALIDATORS,
  value: string,
  fieldName: string
): void {
  if (!VALIDATORS[type](value)) {
    const hints: Record<string, string> = {
      bulletId: "Bullet IDs look like: b-1a2b3c4d-x7y8",
      sessionPath: "Provide a valid file path",
      task: "Task should be 3-2000 characters",
      category: "Category should be alphanumeric (e.g., testing, git)"
    };

    throw new Error(`Invalid ${fieldName}: ${value}. ${hints[type] || ""}`);
  }
}

// Safe argument parsing
function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const command = args[0] || "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith("-")) {
        flags[key] = nextArg;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}
```

### 9. Cross-Platform Issues

**Scenario**: Path separators, line endings, encoding differences

```typescript
// Platform-aware utilities
const PLATFORM = {
  isWindows: process.platform === "win32",
  isMac: process.platform === "darwin",
  isLinux: process.platform === "linux",

  pathSep: process.platform === "win32" ? "\\" : "/",

  // Normalize paths for consistency
  normalizePath(p: string): string {
    // Expand home directory
    if (p.startsWith("~/")) {
      p = join(homedir(), p.slice(2));
    }

    // Normalize separators
    if (this.isWindows) {
      p = p.replace(/\//g, "\\");
    } else {
      p = p.replace(/\\/g, "/");
    }

    return path.normalize(p);
  },

  // Get data directory
  getDataDir(): string {
    if (this.isWindows) {
      return process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "cass-memory")
        : join(homedir(), ".cass-memory");
    }
    if (this.isMac) {
      return join(homedir(), "Library", "Application Support", "cass-memory");
    }
    // Linux/other
    return process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "cass-memory")
      : join(homedir(), ".local", "share", "cass-memory");
  }
};

// Handle line endings
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Safe UTF-8 reading
async function readFileUtf8(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);

  // Detect BOM and remove
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3).toString("utf-8");
  }

  return buffer.toString("utf-8");
}
```

### 10. Graceful Shutdown and Interrupts

**Scenario**: User presses Ctrl+C, process receives SIGTERM

```typescript
// Cleanup handlers
const cleanupHandlers: (() => Promise<void>)[] = [];

function registerCleanup(handler: () => Promise<void>): void {
  cleanupHandlers.push(handler);
}

async function runCleanup(): Promise<void> {
  console.error("\n[cass-memory] Shutting down gracefully...");

  for (const handler of cleanupHandlers) {
    try {
      await handler();
    } catch (e) {
      console.error(`[cass-memory] Cleanup error: ${e}`);
    }
  }
}

// Signal handlers
process.on("SIGINT", async () => {
  await runCleanup();
  process.exit(130);  // 128 + signal number
});

process.on("SIGTERM", async () => {
  await runCleanup();
  process.exit(143);
});

// For long operations, check if we should abort
let shouldAbort = false;

process.on("SIGINT", () => {
  shouldAbort = true;
});

async function reflectWithAbort(
  sessions: string[],
  config: Config
): Promise<{ completed: number; aborted: boolean }> {
  let completed = 0;

  for (const session of sessions) {
    if (shouldAbort) {
      console.error("[cass-memory] Aborting reflection (Ctrl+C received)");
      return { completed, aborted: true };
    }

    await reflectOnSession(session, config);
    completed++;
  }

  return { completed, aborted: false };
}
```

---

## Testing Strategy

### Test Categories Overview

| Category | Focus | Framework |
|----------|-------|-----------|
| Unit Tests | Individual functions, pure logic | `bun test` |
| Integration Tests | cass interaction, file I/O | `bun test` + fixtures |
| LLM Tests | Mocked LLM responses | `bun test` + mocks |
| E2E Tests | Full command workflows | Shell scripts |
| Property Tests | Edge cases, fuzzing | `fast-check` |

### 1. Unit Tests (`tests/unit/`)

#### `tests/unit/utils.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import {
  hashContent,
  jaccardSimilarity,
  generateBulletId,
  expandPath,
  extractKeywords,
  scoreBulletRelevance
} from "../src/utils";

describe("hashContent", () => {
  test("produces consistent hash for same content", () => {
    const hash1 = hashContent("test content");
    const hash2 = hashContent("test content");
    expect(hash1).toBe(hash2);
  });

  test("normalizes whitespace", () => {
    const hash1 = hashContent("test  content");
    const hash2 = hashContent("test content");
    expect(hash1).toBe(hash2);
  });

  test("is case insensitive", () => {
    const hash1 = hashContent("Test Content");
    const hash2 = hashContent("test content");
    expect(hash1).toBe(hash2);
  });

  test("produces 16-character hex string", () => {
    const hash = hashContent("any content");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("jaccardSimilarity", () => {
  test("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1.0);
  });

  test("returns 0.0 for completely different strings", () => {
    expect(jaccardSimilarity("abc def ghi", "xyz uvw rst")).toBe(0.0);
  });

  test("returns correct similarity for partial overlap", () => {
    // "hello world" and "hello there" share "hello"
    const sim = jaccardSimilarity("hello world", "hello there");
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.7);
  });

  test("handles empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);  // NaN handled as 0
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });

  test("is symmetric", () => {
    const sim1 = jaccardSimilarity("one two three", "two three four");
    const sim2 = jaccardSimilarity("two three four", "one two three");
    expect(sim1).toBe(sim2);
  });
});

describe("generateBulletId", () => {
  test("produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateBulletId());
    }
    expect(ids.size).toBe(100);
  });

  test("matches expected format", () => {
    const id = generateBulletId();
    expect(id).toMatch(/^b-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("expandPath", () => {
  test("expands ~ to home directory", () => {
    const expanded = expandPath("~/test");
    expect(expanded).not.toContain("~");
    expect(expanded).toContain("test");
  });

  test("leaves absolute paths unchanged", () => {
    const path = "/absolute/path";
    expect(expandPath(path)).toBe(path);
  });

  test("leaves relative paths unchanged", () => {
    const path = "./relative/path";
    expect(expandPath(path)).toBe(path);
  });
});

describe("extractKeywords", () => {
  test("removes common stop words", () => {
    const keywords = extractKeywords("the quick brown fox is running");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("is");
    expect(keywords).toContain("quick");
    expect(keywords).toContain("brown");
    expect(keywords).toContain("fox");
  });

  test("limits to 10 keywords", () => {
    const longText = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
    const keywords = extractKeywords(longText);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });

  test("handles special characters", () => {
    const keywords = extractKeywords("React-hooks testing @testing-library");
    expect(keywords.some(k => k.includes("react") || k.includes("hooks"))).toBe(true);
  });
});

describe("scoreBulletRelevance", () => {
  test("scores higher for keyword matches in content", () => {
    const score = scoreBulletRelevance(
      "Use React hooks for state management",
      ["react"],
      ["react", "hooks"]
    );
    expect(score).toBeGreaterThan(0);
  });

  test("scores higher for tag matches", () => {
    const scoreWithTag = scoreBulletRelevance("Generic content", ["react"], ["react"]);
    const scoreWithoutTag = scoreBulletRelevance("Generic content", [], ["react"]);
    expect(scoreWithTag).toBeGreaterThan(scoreWithoutTag);
  });

  test("returns 0 for no matches", () => {
    const score = scoreBulletRelevance("Python testing", ["python"], ["react", "hooks"]);
    expect(score).toBe(0);
  });
});
```

#### `tests/unit/playbook.test.ts`

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import {
  createEmptyPlaybook,
  addBullet,
  updateBulletCounter,
  deprecateBullet,
  findBullet,
  isDuplicateBullet,
  curatePlaybook
} from "../src/playbook";
import type { Playbook, Delta } from "../src/types";

describe("createEmptyPlaybook", () => {
  test("creates valid playbook structure", () => {
    const playbook = createEmptyPlaybook();
    expect(playbook.schema_version).toBe(2);
    expect(playbook.bullets).toEqual([]);
    expect(playbook.deprecatedPatterns).toEqual([]);
    expect(playbook.metadata.totalReflections).toBe(0);
  });
});

describe("addBullet", () => {
  let playbook: Playbook;

  beforeEach(() => {
    playbook = createEmptyPlaybook();
  });

  test("adds bullet with generated ID", () => {
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Use Jest for React testing",
      tags: ["react", "testing"]
    }, "session-path");

    expect(bullet.id).toMatch(/^b-/);
    expect(playbook.bullets.length).toBe(1);
  });

  test("initializes counters to zero", () => {
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Test content",
      tags: []
    }, "session-path");

    expect(bullet.helpfulCount).toBe(0);
    expect(bullet.harmfulCount).toBe(0);
  });

  test("sets source session and agent", () => {
    const bullet = addBullet(playbook, {
      category: "git",
      content: "Make atomic commits",
      tags: ["git"]
    }, "/path/to/claude/session.jsonl");

    expect(bullet.sourceSessions).toContain("/path/to/claude/session.jsonl");
  });
});

describe("updateBulletCounter", () => {
  let playbook: Playbook;
  let bulletId: string;

  beforeEach(() => {
    playbook = createEmptyPlaybook();
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Test bullet",
      tags: []
    }, "session");
    bulletId = bullet.id;
  });

  test("increments helpful count", () => {
    updateBulletCounter(playbook, bulletId, "helpful");
    const bullet = findBullet(playbook, bulletId);
    expect(bullet?.helpfulCount).toBe(1);
  });

  test("increments harmful count", () => {
    updateBulletCounter(playbook, bulletId, "harmful");
    const bullet = findBullet(playbook, bulletId);
    expect(bullet?.harmfulCount).toBe(1);
  });

  test("handles non-existent bullet gracefully", () => {
    expect(() => {
      updateBulletCounter(playbook, "non-existent-id", "helpful");
    }).not.toThrow();
  });
});

describe("deprecateBullet", () => {
  let playbook: Playbook;
  let bulletId: string;

  beforeEach(() => {
    playbook = createEmptyPlaybook();
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Old pattern",
      tags: []
    }, "session");
    bulletId = bullet.id;
  });

  test("marks bullet as deprecated", () => {
    deprecateBullet(playbook, bulletId, "Superseded by better approach");
    const bullet = findBullet(playbook, bulletId);
    expect(bullet?.deprecated).toBe(true);
    expect(bullet?.deprecationReason).toBe("Superseded by better approach");
  });

  test("sets replacement ID when provided", () => {
    const newBullet = addBullet(playbook, {
      category: "testing",
      content: "New pattern",
      tags: []
    }, "session");

    deprecateBullet(playbook, bulletId, "Replaced", newBullet.id);
    const oldBullet = findBullet(playbook, bulletId);
    expect(oldBullet?.replacedBy).toBe(newBullet.id);
  });
});

describe("isDuplicateBullet", () => {
  let playbook: Playbook;

  beforeEach(() => {
    playbook = createEmptyPlaybook();
    addBullet(playbook, {
      category: "testing",
      content: "Use React Testing Library for component tests",
      tags: ["react", "testing"]
    }, "session");
  });

  test("detects exact duplicate", () => {
    const result = isDuplicateBullet(
      "Use React Testing Library for component tests",
      playbook.bullets,
      0.85
    );
    expect(result.isDuplicate).toBe(true);
  });

  test("detects near duplicate", () => {
    const result = isDuplicateBullet(
      "Use React Testing Library for testing React components",
      playbook.bullets,
      0.7
    );
    expect(result.isDuplicate).toBe(true);
  });

  test("allows distinct content", () => {
    const result = isDuplicateBullet(
      "Use Jest for Python testing",
      playbook.bullets,
      0.85
    );
    expect(result.isDuplicate).toBe(false);
  });

  test("ignores deprecated bullets", () => {
    const bullet = playbook.bullets[0];
    bullet.deprecated = true;

    const result = isDuplicateBullet(
      "Use React Testing Library for component tests",
      playbook.bullets,
      0.85
    );
    expect(result.isDuplicate).toBe(false);
  });
});

describe("curatePlaybook", () => {
  let playbook: Playbook;

  beforeEach(() => {
    playbook = createEmptyPlaybook();
  });

  test("applies add deltas", () => {
    const deltas: Delta[] = [{
      type: "add",
      bullet: {
        category: "testing",
        content: "New testing rule",
        tags: ["testing"],
        scope: "global"
      },
      reason: "Learned from session",
      sourceSession: "/path/to/session"
    }];

    const result = curatePlaybook(playbook, deltas, { dedupThreshold: 0.85, pruneThreshold: 3 });
    expect(result.applied).toBe(1);
    expect(playbook.bullets.length).toBe(1);
  });

  test("skips duplicate add deltas", () => {
    addBullet(playbook, {
      category: "testing",
      content: "Existing testing rule",
      tags: ["testing"]
    }, "existing-session");

    const deltas: Delta[] = [{
      type: "add",
      bullet: {
        category: "testing",
        content: "Existing testing rule",  // Same content
        tags: ["testing"],
        scope: "global"
      },
      reason: "Duplicate",
      sourceSession: "/path/to/session"
    }];

    const result = curatePlaybook(playbook, deltas, { dedupThreshold: 0.85, pruneThreshold: 3 });
    expect(result.skipped).toBe(1);
    expect(playbook.bullets.length).toBe(1);  // Still just the original
  });

  test("auto-prunes heavily harmful bullets", () => {
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Bad advice",
      tags: []
    }, "session");

    // Mark as harmful 5 times
    for (let i = 0; i < 5; i++) {
      updateBulletCounter(playbook, bullet.id, "harmful");
    }

    const deltas: Delta[] = [];  // No new deltas, just trigger pruning
    curatePlaybook(playbook, deltas, { dedupThreshold: 0.85, pruneThreshold: 3 });

    // Bullet should be pruned (5 harmful > 3 threshold)
    expect(playbook.bullets.length).toBe(0);
  });
});
```

#### `tests/unit/validators.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { VALIDATORS, validateInput } from "../src/validators";

describe("bulletId validator", () => {
  test("accepts valid bullet IDs", () => {
    expect(VALIDATORS.bulletId("b-abc123-xyz789")).toBe(true);
    expect(VALIDATORS.bulletId("b-1a2b3c4d-e5f6")).toBe(true);
  });

  test("rejects invalid bullet IDs", () => {
    expect(VALIDATORS.bulletId("abc123")).toBe(false);
    expect(VALIDATORS.bulletId("b-")).toBe(false);
    expect(VALIDATORS.bulletId("")).toBe(false);
    expect(VALIDATORS.bulletId("b-abc")).toBe(false);  // Missing second part
  });
});

describe("sessionPath validator", () => {
  test("accepts valid paths", () => {
    expect(VALIDATORS.sessionPath("/path/to/session.jsonl")).toBe(true);
    expect(VALIDATORS.sessionPath("./relative/path.json")).toBe(true);
    expect(VALIDATORS.sessionPath("~/home/path")).toBe(true);
  });

  test("rejects invalid paths", () => {
    expect(VALIDATORS.sessionPath("")).toBe(false);
    expect(VALIDATORS.sessionPath("path\0with\0nulls")).toBe(false);
    expect(VALIDATORS.sessionPath("x".repeat(5000))).toBe(false);  // Too long
  });
});

describe("task validator", () => {
  test("accepts valid task descriptions", () => {
    expect(VALIDATORS.task("Fix the authentication bug")).toBe(true);
    expect(VALIDATORS.task("abc")).toBe(true);  // Minimum 3 chars
  });

  test("rejects invalid tasks", () => {
    expect(VALIDATORS.task("ab")).toBe(false);  // Too short
    expect(VALIDATORS.task("")).toBe(false);
    expect(VALIDATORS.task("x".repeat(2001))).toBe(false);  // Too long
  });
});

describe("category validator", () => {
  test("accepts valid categories", () => {
    expect(VALIDATORS.category("testing")).toBe(true);
    expect(VALIDATORS.category("git-workflow")).toBe(true);
    expect(VALIDATORS.category("code_quality")).toBe(true);
  });

  test("rejects invalid categories", () => {
    expect(VALIDATORS.category("")).toBe(false);
    expect(VALIDATORS.category("123abc")).toBe(false);  // Must start with letter
    expect(VALIDATORS.category("with spaces")).toBe(false);
    expect(VALIDATORS.category("x".repeat(51))).toBe(false);  // Too long
  });
});

describe("validateInput", () => {
  test("throws descriptive error for invalid input", () => {
    expect(() => {
      validateInput("bulletId", "invalid", "bullet ID");
    }).toThrow(/Invalid bullet ID.*Bullet IDs look like/);
  });

  test("does not throw for valid input", () => {
    expect(() => {
      validateInput("bulletId", "b-abc123-xyz789", "bullet ID");
    }).not.toThrow();
  });
});
```

### 2. Integration Tests (`tests/integration/`)

#### `tests/integration/cass.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cassAvailable, cassSearch, cassExport, cassTimeline } from "../src/cass";
import * as fs from "fs/promises";
import * as path from "path";

// Skip if cass not available
const SKIP_CASS = !cassAvailable();

describe("cass integration", () => {
  if (SKIP_CASS) {
    test.skip("cass not available", () => {});
    return;
  }

  test("health check returns true when cass is installed", () => {
    expect(cassAvailable()).toBe(true);
  });

  test("search returns array of hits", async () => {
    const hits = await cassSearch("test", { limit: 3 });
    expect(Array.isArray(hits)).toBe(true);
    // May be empty if no matches, but should not throw
  });

  test("search with filters works", async () => {
    const hits = await cassSearch("function", {
      limit: 5,
      days: 30,
      agent: "claude"
    });
    expect(Array.isArray(hits)).toBe(true);
    // If we got hits, they should be from claude
    if (hits.length > 0) {
      expect(hits.every(h => h.agent === "claude")).toBe(true);
    }
  });

  test("timeline returns grouped data", async () => {
    const timeline = await cassTimeline(7);
    expect(timeline).toHaveProperty("groups");
    expect(Array.isArray(timeline.groups)).toBe(true);
  });

  test("handles empty search results gracefully", async () => {
    const hits = await cassSearch("xyznonexistentquery12345", { limit: 1 });
    expect(hits).toEqual([]);
  });
});
```

#### `tests/integration/playbook-persistence.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadPlaybook, savePlaybook, createEmptyPlaybook, addBullet } from "../src/playbook";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("playbook persistence", () => {
  let tempDir: string;
  let config: { playbookPath: string };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-memory-test-"));
    config = { playbookPath: path.join(tempDir, "playbook.yaml") };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("saves and loads playbook correctly", async () => {
    const playbook = createEmptyPlaybook();
    addBullet(playbook, {
      category: "testing",
      content: "Test persistence",
      tags: ["test"]
    }, "session-path");

    await savePlaybook(playbook, config);
    const loaded = await loadPlaybook(config);

    expect(loaded.bullets.length).toBe(1);
    expect(loaded.bullets[0].content).toBe("Test persistence");
  });

  test("creates new playbook if file doesn't exist", async () => {
    const loaded = await loadPlaybook(config);
    expect(loaded.schema_version).toBe(2);
    expect(loaded.bullets).toEqual([]);
  });

  test("handles corrupt YAML gracefully", async () => {
    await fs.writeFile(config.playbookPath, "invalid: yaml: content: [unclosed");

    const loaded = await loadPlaybook(config);
    // Should recover with empty playbook and backup the corrupt one
    expect(loaded.bullets).toEqual([]);

    // Check backup was created
    const files = await fs.readdir(tempDir);
    expect(files.some(f => f.includes(".backup"))).toBe(true);
  });

  test("preserves all bullet fields through save/load cycle", async () => {
    const playbook = createEmptyPlaybook();
    const bullet = addBullet(playbook, {
      category: "testing",
      content: "Full field test",
      tags: ["a", "b"],
      searchPointer: "cass search 'test'",
      scope: "workspace",
      workspace: "/path/to/workspace"
    }, "session-path");

    bullet.helpfulCount = 5;
    bullet.harmfulCount = 2;

    await savePlaybook(playbook, config);
    const loaded = await loadPlaybook(config);
    const loadedBullet = loaded.bullets[0];

    expect(loadedBullet.helpfulCount).toBe(5);
    expect(loadedBullet.harmfulCount).toBe(2);
    expect(loadedBullet.searchPointer).toBe("cass search 'test'");
    expect(loadedBullet.scope).toBe("workspace");
    expect(loadedBullet.tags).toEqual(["a", "b"]);
  });
});
```

### 3. LLM Mock Tests (`tests/llm/`)

#### `tests/llm/diary-extraction.test.ts`

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { extractDiary } from "../src/llm";
import { DiaryExtractionSchema } from "../src/types";

// Mock the AI SDK
const mockGenerateObject = mock(() => ({
  object: {
    status: "success",
    accomplishments: ["Implemented user authentication"],
    decisions: ["Use JWT for session tokens"],
    challenges: ["Rate limiting was complex"],
    preferences: [],
    keyLearnings: ["Always validate token expiry"],
    suggestedTags: ["auth", "jwt", "security"]
  }
}));

mock.module("ai", () => ({
  generateObject: mockGenerateObject
}));

describe("diary extraction", () => {
  beforeEach(() => {
    mockGenerateObject.mockClear();
  });

  test("extracts structured diary from session content", async () => {
    const config = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
    const sessionContent = "User: Implement auth\nAssistant: I'll create JWT tokens...";

    const result = await extractDiary(
      DiaryExtractionSchema,
      sessionContent,
      { sessionPath: "/test", agent: "claude" },
      config
    );

    expect(result.status).toBe("success");
    expect(result.accomplishments.length).toBeGreaterThan(0);
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("passes session metadata to prompt", async () => {
    const config = { provider: "anthropic", model: "claude-sonnet-4-20250514" };

    await extractDiary(
      DiaryExtractionSchema,
      "session content",
      { sessionPath: "/path/to/session.jsonl", agent: "cursor", workspace: "/my/project" },
      config
    );

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain("/path/to/session.jsonl");
    expect(call.prompt).toContain("cursor");
    expect(call.prompt).toContain("/my/project");
  });
});
```

#### `tests/llm/reflector.test.ts`

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { runReflector } from "../src/llm";
import { ReflectorOutputSchema } from "../src/types";

const mockGenerateObject = mock(() => ({
  object: {
    deltas: [
      {
        type: "add",
        category: "testing",
        content: "Use waitFor for async assertions in React tests",
        tags: ["react", "testing"],
        reason: "Session showed async timing issues"
      },
      {
        type: "helpful",
        bulletId: "b-existing-123",
        reason: "Used existing git commit rule successfully"
      }
    ]
  }
}));

mock.module("ai", () => ({
  generateObject: mockGenerateObject
}));

describe("reflector", () => {
  beforeEach(() => {
    mockGenerateObject.mockClear();
  });

  test("generates deltas from session diary", async () => {
    const config = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
    const diary = {
      status: "success",
      accomplishments: ["Fixed React test"],
      decisions: [],
      challenges: ["Async timing issues"],
      preferences: [],
      keyLearnings: ["waitFor is essential"]
    };

    const result = await runReflector(
      ReflectorOutputSchema,
      diary,
      "EXISTING BULLETS:\n- [b-existing-123] Make atomic commits",
      "CASS HISTORY: Similar async issues in session-456",
      0,  // First iteration
      config
    );

    expect(result.deltas.length).toBe(2);
    expect(result.deltas[0].type).toBe("add");
    expect(result.deltas[1].type).toBe("helpful");
  });

  test("adjusts prompt for subsequent iterations", async () => {
    const config = { provider: "anthropic", model: "claude-sonnet-4-20250514" };

    await runReflector(
      ReflectorOutputSchema,
      { status: "success", accomplishments: [], decisions: [], challenges: [], preferences: [], keyLearnings: [] },
      "",
      "",
      2,  // Third iteration
      config
    );

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain("iteration 3");
    expect(call.prompt).toContain("insights you may have missed");
  });
});
```

### 4. E2E Tests (`tests/e2e/`)

#### `tests/e2e/commands.test.sh`

```bash
#!/bin/bash
set -e

# E2E test suite for cass-memory CLI

CASS_MEMORY="./dist/cass-memory"
TEST_DIR=$(mktemp -d)
export CASS_MEMORY_HOME="$TEST_DIR"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "=== E2E Tests for cass-memory ==="

# Test 1: init command
echo "Test 1: init command..."
$CASS_MEMORY init
[ -f "$TEST_DIR/config.json" ] && echo "  PASS: config.json created"
[ -f "$TEST_DIR/playbook.yaml" ] && echo "  PASS: playbook.yaml created"

# Test 2: config show
echo "Test 2: config show..."
OUTPUT=$($CASS_MEMORY config show --json)
echo "$OUTPUT" | jq -e '.provider' > /dev/null && echo "  PASS: config show returns JSON"

# Test 3: playbook list (empty)
echo "Test 3: playbook list..."
OUTPUT=$($CASS_MEMORY playbook list --json)
echo "$OUTPUT" | jq -e '.bullets | length == 0' > /dev/null && echo "  PASS: empty playbook"

# Test 4: playbook add
echo "Test 4: playbook add..."
$CASS_MEMORY playbook add --category testing --tags react,jest "Use waitFor for async tests"
OUTPUT=$($CASS_MEMORY playbook list --json)
echo "$OUTPUT" | jq -e '.bullets | length == 1' > /dev/null && echo "  PASS: bullet added"

# Test 5: mark helpful
echo "Test 5: mark helpful..."
BULLET_ID=$(echo "$OUTPUT" | jq -r '.bullets[0].id')
$CASS_MEMORY mark "$BULLET_ID" --helpful
OUTPUT=$($CASS_MEMORY playbook get "$BULLET_ID" --json)
echo "$OUTPUT" | jq -e '.helpfulCount == 1' > /dev/null && echo "  PASS: helpful count incremented"

# Test 6: context (requires cass)
echo "Test 6: context command..."
if command -v cass &> /dev/null; then
  OUTPUT=$($CASS_MEMORY context "Fix React test" --json 2>/dev/null || echo '{}')
  echo "$OUTPUT" | jq -e '.bullets' > /dev/null && echo "  PASS: context returns bullets"
else
  echo "  SKIP: cass not available"
fi

# Test 7: JSON output format
echo "Test 7: JSON output..."
OUTPUT=$($CASS_MEMORY playbook list --json)
echo "$OUTPUT" | jq . > /dev/null && echo "  PASS: valid JSON output"

# Test 8: help command
echo "Test 8: help command..."
$CASS_MEMORY --help | grep -q "context" && echo "  PASS: help shows commands"

echo ""
echo "=== All E2E tests passed ==="
```

### 5. Property-Based Tests (`tests/property/`)

#### `tests/property/deduplication.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { jaccardSimilarity, hashContent } from "../src/utils";
import { isDuplicateBullet, createEmptyPlaybook, addBullet } from "../src/playbook";

describe("property-based tests", () => {
  test("jaccardSimilarity is symmetric", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return jaccardSimilarity(a, b) === jaccardSimilarity(b, a);
      })
    );
  });

  test("jaccardSimilarity returns value in [0, 1]", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sim = jaccardSimilarity(a, b);
        return sim >= 0 && sim <= 1;
      })
    );
  });

  test("identical strings have similarity 1.0", () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => s.length > 5),  // Need some tokens
        (s) => {
          return jaccardSimilarity(s, s) === 1.0;
        }
      )
    );
  });

  test("hashContent is deterministic", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return hashContent(s) === hashContent(s);
      })
    );
  });

  test("different content produces different hashes (usually)", () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => s.length > 10),
        fc.string().filter(s => s.length > 10),
        (a, b) => {
          if (a.toLowerCase().trim() === b.toLowerCase().trim()) {
            return true;  // Skip equivalent strings
          }
          // Very low probability of collision
          return hashContent(a) !== hashContent(b);
        }
      )
    );
  });

  test("exact duplicates are always detected", () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => s.length > 20),  // Need substantial content
        (content) => {
          const playbook = createEmptyPlaybook();
          addBullet(playbook, {
            category: "test",
            content,
            tags: []
          }, "session");

          const result = isDuplicateBullet(content, playbook.bullets, 0.85);
          return result.isDuplicate === true;
        }
      )
    );
  });
});
```

### 6. Test Configuration

#### `bunfig.toml`

```toml
[test]
preload = ["./tests/setup.ts"]
timeout = 30000
coverageThreshold = {
  line = 80,
  function = 80,
  branch = 70
}

[test.coverage]
skipFiles = [
  "**/node_modules/**",
  "**/tests/**"
]
```

#### `tests/setup.ts`

```typescript
import { beforeAll, afterAll } from "bun:test";

// Global test setup
beforeAll(() => {
  // Set test environment
  process.env.CASS_MEMORY_TEST = "1";
  process.env.CASS_MEMORY_VERBOSE = "0";
});

afterAll(() => {
  // Cleanup
  delete process.env.CASS_MEMORY_TEST;
});
```

### 7. Test Running Scripts

#### `package.json` test scripts

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "test:llm": "bun test tests/llm",
    "test:e2e": "bash tests/e2e/commands.test.sh",
    "test:property": "bun test tests/property",
    "test:coverage": "bun test --coverage",
    "test:watch": "bun test --watch"
  }
}
```

### Test Fixtures

#### `tests/fixtures/session.jsonl`

```jsonl
{"role":"user","content":"Help me write a React hook for authentication"}
{"role":"assistant","content":"I'll create a useAuth hook..."}
{"role":"user","content":"Add token refresh"}
{"role":"assistant","content":"Adding automatic token refresh with useEffect..."}
```

#### `tests/fixtures/playbook.yaml`

```yaml
schema_version: 2
name: test-playbook
metadata:
  createdAt: "2025-01-01T00:00:00Z"
  totalReflections: 5
  totalSessionsProcessed: 10
bullets:
  - id: "b-test-001"
    category: testing
    content: "Use React Testing Library for component tests"
    scope: global
    helpfulCount: 3
    harmfulCount: 0
    tags: ["react", "testing"]
    sourceSessions: ["session-1"]
    sourceAgents: ["claude"]
    createdAt: "2025-01-01T00:00:00Z"
    updatedAt: "2025-01-01T00:00:00Z"
    deprecated: false
```

---

## V1 Scope Gate (cass_memory_system-4fj7)

**Goal:** freeze a small, shippable V1 that delivers “context on demand” with zero setup and no LLM requirement; everything else is V2/V3.

### What “V1 complete” means
- Zero-config works on a clean machine (global + repo defaults auto-created).
- Context CLI returns rules + history when cass is available and degrades gracefully when cass/LLM are absent.
- Manual feedback loop (`cm mark`) present; cost controls on by default with safe budgets.
- MCP server exposes `cm_context`, `cm_feedback`, `cm_outcome` so agents can self-serve memory.
- Docs show the 5-command surface, install/build steps, degraded-mode expectations, and MCP quickstart.

### V1 checklist
- [x] MCP tools live and documented: `cm_context`, `cm_feedback`, `cm_outcome`.
- [x] Budget config surfaced (daily/monthly caps, default local-only).
- [x] Context: argv+stdin parsing, JSON/human output, degraded-mode warnings.
- [x] Reflect: session discovery, diary → reflect → validate → curate flow; dry-run + JSON.
- [x] Playbook ops: list/add/remove; deprecated patterns respected; toxic blocklists applied.
- [x] Graceful degradation verified (no cass, no playbook, no LLM, offline).
- [x] Binaries: bun --compile targets (linux-x64, darwin-arm64, windows-x64) with `--help`/`--version`.
- [x] Dev loop docs: bun --watch, typecheck/watch, test/watch.

### Nice-to-have (push to V2+)
- Semantic search/embeddings; cross-agent sharing.
- Advanced maturity/decay tuning UI; richer auto-promotion/demotion.
- Team playbooks, cloud sync, webhooks, IDE plugins, API surface.

### Milestone slices
1) **Agent surface**: ship MCP tools + outcome logging hooks so agents can request context and report results.
2) **Resilience**: prove all degraded modes render actionable guidance, not failures.
3) **Budget safety**: defaults keep LLM off; caps enforced when enabled.
4) **Distribution**: cross-platform binaries built and documented.
5) **Docs**: single path to “run context in <5 minutes,” including MCP snippet.

### Tracking (beads mapping)
(All items below were completed and closed as of **2025-12-14**.)
- MCP surface: cass_memory_system-8nsd
- Context CLI polish (stdin/argv, degraded messaging): cass_memory_system-dpuu, cass_memory_system-qt2q
- Budget/cost controls: cass_memory_system-zex2
- Degradation guarantees: cass_memory_system-c8w5
- V1 command surface clarity: cass_memory_system-nf0v
- Binary builds: cass_memory_system-iqat
- Dev workflow docs: cass_memory_system-4hey
- Scope governance (this bead): cass_memory_system-4fj7

### Quick status snapshot (as of 2025-12-14)
- Agent surface: DONE (8nsd closed)
- Context polish: DONE (dpuu + qt2q closed)
- Budget/cost: DONE (zex2 closed)
- Degradation: DONE (c8w5 closed)
- Command surface: DONE (nf0v closed)
- Binaries: DONE (iqat closed)
- Dev docs: DONE (4hey closed)

---

## Testing Gap Analysis (cass_memory_system-f63a)

**Purpose:** Identify remaining gaps for unit tests without mocks, so we can prioritize coverage that unblocks integration/e2e epics.

### Scope
- Target pure functions in `scoring.ts`, `playbook.ts`, `config.ts`, `utils.ts`, `types.ts`, `security.ts`, `tracking.ts`, `lock.ts`.
- Real file I/O permitted via temp dirs; no mocking of internal modules. Only mock external LLM/network when unavoidable.
- Aligns with epics: u64s (unit tests), 8dxr (integration tests), q3h2/m7np (full coverage).

### Gaps (draft)
- **scoring.ts**: Decay edge cases (future timestamps, negative half-life guard), maturity transitions with mixed feedback ratios.
- **playbook.ts**: Toxic-blocklist pruning and semantic duplicate detection; pinning behavior; shouldAutoPrune thresholds.
- **config.ts**: Cascading merges with nested overrides; budget defaults; sanitization overrides.
- **utils.ts**: resolveRepoDir in non-git dirs; generateSuggestedQueries edge cases (no keywords); formatLastHelpful with malformed timestamps.
- **security.ts**: Secret patterns coverage for less-common tokens; ensure auditLog flag behavior.
- **tracking.ts/lock.ts**: Concurrent lock attempts and stale lock cleanup on temp fs.

### Deliverables
- Checklist of concrete test cases per module (to be turned into bun tests).
- Minimal helpers/factories list (temp dir factory, bullet factory) to avoid mocking.
- Mapping of which gaps block which epics/tasks (u64s, 8dxr, q3h2, m7np).

### Next steps
1) Draft per-module case list (living in this plan) and sync with test owners.
2) Land helper/factory stubs in `test/helpers/` once reservations clear.
3) Implement highest-impact unit tests first: scoring → playbook → config → utils.

### Per-module test cases (draft)
- **scoring.ts**
  - calculateDecayedValue: today ≈1.0; 90d half-life ≈0.5 at 90d; future timestamp >1 guard; negative/zero half-life handled safely.
  - getEffectiveScore: harmful multiplier applied; maturity multipliers (candidate 0.5x, established 1x, proven 1.5x, deprecated 0x).
  - checkForPromotion/Demotion: promotion with 3+ feedback; demotion when score negative; auto-deprecate when score < -pruneHarmfulThreshold; pinned bullet not demoted.
  - isStale: no feedback uses createdAt; malformed timestamp handled gracefully.
- **playbook.ts**
  - isSemanticallyToxic filters bullets using Jaccard >0.85 and exact hash.
  - shouldAutoPrune respects pinned bullets and harmful ratio thresholds.
  - findSimilarBullet returns highest-similarity bullet; ignores deprecated/retired.
  - addBullet extracts agent from session path; sets timestamps; confidence half-life override.
- **config.ts**
  - loadConfig merges global+repo+CLI; budget defaults present; sanitization merge order.
  - detectRepoContext returns inRepo=false outside git.
  - normalizeConfigKeys converts snake_case to camelCase on nested keys.
  - getSanitizeConfig falls back to defaults when partial config provided.
- **utils.ts**
  - resolveRepoDir returns null outside git; expandPath handles ~ and relative.
  - generateSuggestedQueries when no keywords returns empty; when keywords present returns unique suggestions with days/agent filters.
  - formatLastHelpful tolerates invalid timestamps; prefers helpfulEvents over feedbackEvents.
  - checkDeprecatedPatterns matches regex-style and plain patterns once per warning.
- **security.ts**
  - sanitizeContent removes AWS keys, bearer tokens, PATs, DB URLs, private keys; extraPatterns honored; auditLog flag gated.
  - ensureSanitizedDiary prevents secrets in diary saving.
- **tracking.ts / lock.ts**
  - withLock handles concurrent access (second caller waits/fails gracefully).
  - Stale lock detection deletes expired lock file.
  - Tracking processedSessions persists and reloads; corrupted state recovers to empty.

### Helper/factory stubs to land (TBD once test/** free)
- `test/helpers/temp.ts`: `withTempDir(name, fn)` using mkdtemp + recursive cleanup; yields paths for repo/global dirs.
- `test/helpers/factories.ts`:
  - `makeBullet(opts)` with defaults (candidate, no feedback).
  - `makeFeedback({type, daysAgo, reason})` to generate timestamped events.
  - `makeConfig(overrides)` seeded from DEFAULT_CONFIG with budget/sanitization defaults.
- `test/helpers/fixtures.ts`: loaders for sample playbook/diary YAML/JSON in-memory (no network).
- `test/helpers/logger.ts`: noop logger with opt-in debug piping to console for flaky-case debugging (guarded by env).

---

## Conclusion

This plan combines the best elements from all four AI proposals:

1. **From Claude**: Multi-iteration reflection, deterministic curation, YAML playbooks, source tracing
2. **From GPT Pro**: Scientific validation against cass history before accepting rules
3. **From Gemini**: Hydration/context command, search pointers, tombstone mechanism for deprecated patterns
4. **From Grok**: Clear ACE pipeline mapping, cross-agent pattern emphasis

The result is a comprehensive, agent-agnostic memory system that learns from all coding agents while preventing context collapse and ensuring rule quality through evidence-based validation.
