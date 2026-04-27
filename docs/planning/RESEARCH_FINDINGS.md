# RESEARCH FINDINGS: cass_memory_system (cm) - TOON Integration Analysis

**Researcher**: CrimsonForge (claude-code, claude-opus-4-5)
**Date**: 2026-01-24
**Bead**: bd-2a9
**Tier**: 2 (Moderate Impact - Similar to CASS: long string values in context/history limit compression)

---

## 1. Project Audit

### Architecture
cm (cass-memory) is a **Bun/TypeScript CLI tool** providing procedural memory for AI coding agents. It implements the ACE (Agent Cognitive Enhancement) framework for rule-based guidance and historical context retrieval.

### Key Files
| File | Purpose |
|------|---------|
| `src/cm.ts` (~40KB) | Main CLI entry, command definitions |
| `src/utils.ts` (~97KB) | Core utilities including `printJson()`, `printJsonResult()`, `isJsonOutput()` |
| `src/output.ts` (~6KB) | Output styling (colors, emoji, formatting) |
| `src/commands/*.ts` | Individual command implementations |
| `package.json` | Bun project config |

### Existing Output Formats
cm already supports format options via:
- `--json` / `-j` flag on most commands
- `--format <markdown|json>` on context command
- `--format <agents.md|claude.md|raw|yaml|json>` on project command

### Serialization Patterns
- **`JSON.stringify(value, null, 2)`** via `printJson()` in utils.ts:2065
- **`printJsonResult(command, data, options)`** wraps data in standard envelope:
  ```json
  {
    "success": true,
    "command": "context",
    "timestamp": "2026-01-24T00:06:12.911Z",
    "data": { ... },
    "metadata": { "executionMs": 38, "version": "0.2.3" }
  }
  ```
- **`isJsonOutput(options)`** checks for `--json` or `--format json`

### Key Data Structures

```typescript
// ContextResult (src/types.ts)
interface ContextResult {
  task: string;
  relevantBullets: ScoredBullet[];  // Array of rules with metadata
  antiPatterns: ScoredBullet[];     // Negative rules
  historySnippets: CassSearchHit[]; // Past session matches
  warnings?: string[];
  suggestedQueries?: string[];
}

// ScoredBullet - many fields per rule
interface ScoredBullet {
  id: string;
  scope: string;
  category: string;
  content: string;
  source: string;
  type: string;
  isNegative: boolean;
  kind: string;
  state: string;
  maturity: string;
  helpfulCount: number;
  harmfulCount: number;
  feedbackEvents: FeedbackEvent[];
  // ... 15+ more fields
}
```

---

## 2. Output Analysis

### Sample Output Sizes (Actual Measurements)

| Command | JSON Bytes | TOON Bytes | Byte Savings | JSON Tokens | TOON Tokens | Token Savings |
|---------|-----------|------------|--------------|-------------|-------------|---------------|
| `cm context "testing" --json` | 9,259 | ~8,400 | ~9% | ~1,794 | ~1,634 | **8.9%** |
| `cm stats --json` | 1,137 | ~850 | ~25% | ~183 | ~136 | **25.7%** |
| `cm playbook list --json` | 1,701 | ~1,400 | ~18% | ~278 | ~231 | **16.9%** |

### Key Insight: Same Pattern as CASS

Like CASS search results, cm context output contains **long string values** (rule content, history snippets, file paths) that limit tabular compression benefits.

**High savings (25%+):**
- `cm stats` - structured counts and metadata
- `cm doctor` - health check results
- Aggregation commands with numeric data

**Moderate savings (15-20%):**
- `cm playbook list` - rule listings
- `cm top` - top performers

**Low savings (<10%):**
- `cm context` - long content strings in bullets and history
- `cm similar` - similarity results with snippets

### Tabular Data Candidates

1. **`relevantBullets` array** (uniform ScoredBullet fields)
   - TOON: `relevantBullets[N]{id,scope,category,content,...}:`
   - Limited by long `content` and `reasoning` strings

2. **`historySnippets` array** (uniform CassSearchHit fields)
   - TOON: `historySnippets[N]{source_path,snippet,score,...}:`
   - Limited by long paths and snippets

3. **`topPerformers` / `mostHelpful` arrays** (stats command)
   - TOON: `topPerformers[N]{id,content,score,helpfulCount}:`
   - Better savings due to shorter content

### TOON Output Sample (cm context)

```
success: true
command: context
timestamp: "2026-01-24T00:06:12.911Z"
data:
  task: testing
  relevantBullets[1]:
    - id: b-mkoadgvs-wuezwa
      scope: global
      category: tooling
      content: Use bun for testing
      source: learned
      type: rule
      isNegative: false
      kind: workflow_rule
      state: draft
      maturity: candidate
      helpfulCount: 0
      harmfulCount: 0
      feedbackEvents[0]:
      confidenceDecayHalfLifeDays: 90
      createdAt: "2026-01-21T17:17:49.625Z"
      updatedAt: "2026-01-21T17:17:49.626Z"
      pinned: false
      deprecated: false
      sourceSessions[1]: manual-cli
      sourceAgents[1]: unknown
      tags[0]:
      relevanceScore: 3
      effectiveScore: 0
      finalScore: 0.30000000000000004
      lastHelpful: Never
      reasoning: From unknown session on 1/21/2026
  antiPatterns[0]:
  historySnippets[10]:
    - source_path: /home/ubuntu/.claude/projects/...
      line_number: 2
      agent: claude_code
      ...
metadata:
  executionMs: 38
  version: "0.2.3"
```

---

## 3. Integration Assessment

### Complexity Rating: **Simple**

cm already has the format infrastructure (`--format`, `isJsonOutput()`). Adding TOON requires:
1. Extend `--format` enum to include "toon"
2. Add TOON serialization path in `printJson()` or a new `printToon()` function
3. Pipe through `tru` binary (since @dicklesworthstone/toon npm bindings don't exist yet)

### Recommended Approach: **Pattern A - Pipe through `tru` binary**

Since there's no npm package for toon_rust yet, use the tru binary:

```typescript
// In utils.ts

import { spawnSync } from "node:child_process";

export function printToon(value: unknown): void {
  const json = JSON.stringify(value);
  const result = spawnSync("tru", [], {
    input: json,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,  // 10MB
  });

  if (result.status === 0) {
    console.log(result.stdout);
  } else {
    // Fallback to JSON if tru not available
    console.error("[cm] Warning: tru binary not found, falling back to JSON");
    printJson(value);
  }
}

export function isToonOutput(options?: { format?: string }): boolean {
  return options?.format?.toLowerCase() === "toon";
}

// Modify printJsonResult to support TOON
export function printResult<T>(
  command: string,
  data: T,
  options: JsonResultOptions & { format?: string } = {}
): void {
  const payload = buildPayload(command, data, options);

  if (isToonOutput(options)) {
    printToon(payload);
  } else {
    printJson(payload);
  }
}
```

### Alternative Approach: **Pattern B - @dicklesworthstone/toon npm package**

If/when toon bindings are published to npm (bd-1bk), integration becomes cleaner:

```typescript
import { jsonToToon } from "@dicklesworthstone/toon";

export function printToon(value: unknown): void {
  const json = JSON.stringify(value);
  console.log(jsonToToon(json));
}
```

### Key Integration Points

| File/Location | Change Required |
|---------------|-----------------|
| `src/cm.ts:102` | Extend `--format <markdown|json|toon>` |
| `src/utils.ts:2059-2067` | Add `isToonOutput()` and `printToon()` |
| `src/utils.ts:2539` | Modify `printJsonResult()` to check for TOON |
| All command files | No changes needed (they call printJsonResult) |
| `package.json` | No changes (uses tru binary) |

### Dependencies
- **Pattern A**: `tru` binary must be in PATH
- **Pattern B**: Requires @dicklesworthstone/toon npm package (bd-1bk)
- Both: No other dependencies (Bun handles child process spawning)

### Backwards Compatibility
- Zero risk: new `--format toon` value, does not affect existing formats
- `--json` still defaults to JSON
- No breaking changes

---

## 4. Token Savings Projections

| Command | JSON Tokens | TOON Tokens | Savings |
|---------|-------------|-------------|---------|
| cm context "task" | ~1,800 | ~1,634 | ~9% |
| cm stats | ~183 | ~136 | ~26% |
| cm playbook list | ~278 | ~231 | ~17% |
| cm doctor | ~200 | ~150 | ~25% |
| cm top 10 | ~400 | ~300 | ~25% |
| cm similar "query" | ~500 | ~425 | ~15% |
| Projected: large playbook (50 rules) | ~3,000 | ~2,400 | ~20% |

**Key finding**: Savings are inversely correlated with content string length. Commands with structured/numeric data get 20-26% savings; commands with long text content get 9-15%.

---

## 5. Special Considerations

### Language-Specific Notes
- cm is **Bun/TypeScript** (not Node.js - uses Bun runtime)
- Bun has native child process support via `spawnSync`
- TypeScript strict mode is enabled
- No existing @dicklesworthstone/toon npm package (bd-1bk will create one)

### TOON Effectiveness by Command

| Command | Savings | Reason |
|---------|---------|--------|
| `cm stats` | High (26%) | Structured counts, short strings |
| `cm doctor` | High (25%) | Health check booleans and counts |
| `cm top` | High (25%) | Short rule IDs and scores |
| `cm playbook list` | Medium (17%) | Rule content varies in length |
| `cm similar` | Medium (15%) | Snippets are moderate length |
| `cm context` | Low (9%) | Long history snippets and reasoning |

### Implementation Order
1. Add `printToon()` function to utils.ts using tru binary
2. Add `isToonOutput()` check alongside `isJsonOutput()`
3. Modify `printJsonResult()` to route to appropriate printer
4. Extend `--format` options in cm.ts to include "toon"
5. Add `CM_OUTPUT_FORMAT` env var support
6. Add `--stats` flag for token comparison
7. Test all commands with `--format toon`
8. Document in `--help` output

### Risk Assessment
- **Low risk**: New format option, no existing behavior changes
- **Dependency risk**: Requires `tru` binary in PATH
- **Mitigation**: Graceful fallback to JSON with warning if tru not found
- **Performance**: Process spawn overhead (~2-5ms) acceptable for CLI tool

---

## 6. Deliverables Checklist

- [x] RESEARCH_FINDINGS.md created (this file)
- [ ] Project-level beads created in .beads/
- [ ] bd-1fh (Integrate TOON into cm) updated with actual findings

---

## 7. Recommended Project-Level Beads

1. **cm-toon-utils**: Add `printToon()` and `isToonOutput()` to utils.ts
2. **cm-toon-format**: Extend `--format` enum to include "toon" in cm.ts
3. **cm-toon-env**: Add `CM_OUTPUT_FORMAT` env var support
4. **cm-toon-stats**: Add `--stats` flag for token comparison display
5. **cm-toon-fallback**: Graceful fallback if `tru` binary not in PATH
6. **cm-toon-test**: Add bun tests for TOON output
7. **cm-toon-docs**: Update CLI help text with TOON format option

---

## 8. Comparison with Other Tools

| Aspect | UBS | CASS | CM |
|--------|-----|------|-----|
| Language | Bash | Rust | Bun/TypeScript |
| Savings (typical) | 34-50% | 9-27% | 9-26% |
| Best case | Uniform findings | `--fields minimal` | `cm stats` |
| Integration method | Pipe → tru | Pipe → tru | Pipe → tru (or npm) |
| Complexity | Simple | Simple | Simple |
| Tier | 1 (High) | 2 (Moderate) | 2 (Moderate) |
| Primary savings driver | Tabular findings | Key elimination | Key elimination |
| Limiting factor | None | Long string values | Long string values |

---

# Addendum (bd-1dw) — Required Findings

**Researcher**: CalmCliff (codex-cli, gpt-5)  
**Date**: 2026-01-24  
**Bead**: bd-1dw

## 1. JSON Output + Logging Map (File/Function List)

### Output Envelope + JSON Printer (global)
- `src/utils.ts`
  - `printJson(value)` — JSON.stringify pretty-print (stdout).
  - `printJsonResult(command, data, options)` — standard envelope `{success, command, timestamp, data, metadata}`.
  - `printJsonError()` / `reportError()` — structured error envelope (stdout), human errors to stderr.
  - `isJsonOutput(options)` — true if `--json` or `--format json`.
  - `log/warn/error` — diagnostics to **stderr** (gated by `CASS_MEMORY_VERBOSE`).

### Commands that emit JSON
- `src/commands/context.ts` — `contextCommand()` uses `printJsonResult` when `--json` or `--format json`.
- `src/commands/playbook.ts` — list/add/get/export/import emit JSON via `printJsonResult`.
- `src/commands/doctor.ts` — `doctorCommand()` emits JSON in `--json` mode; diagnostics stay stderr.
- `src/commands/stats.ts`, `top.ts`, `why.ts`, `stale.ts`, `audit.ts`, `mark.ts`,
  `outcome.ts`, `usage.ts`, `quickstart.ts`, `starters.ts`, `privacy.ts`,
  `project.ts`, `diary.ts`, `validate.ts`, `onboard.ts`, `guard.ts` — all use `printJsonResult`.

### Progress/Streaming Output
- `src/progress.ts` — `createProgress()` supports `format: "text" | "json"` and **writes to stderr**.
  - JSON progress lines are already line-delimited JSON and should remain so.

### MCP Server Output (must remain JSON)
- `src/commands/serve.ts` — JSON-RPC over HTTP; tool results are JSON **by protocol**.
  - TOON must be embedded inside JSON (e.g., `data_toon`) if supported at all.

## 2. Logging / Format Selection (Current State)

There is **no** existing `*_OUTPUT_FORMAT` or `*_LOG_FORMAT` env var.  
Current output controls:
- `--json` / `-j` flags (most commands)
- `--format` for specific commands:
  - `context`: `--format markdown|json`
  - `project`: `--format agents.md|claude.md|raw|yaml|json`
- Output styling via env:
  - `NO_COLOR`, `CASS_MEMORY_NO_EMOJI`, `CASS_MEMORY_WIDTH`
  - `CASS_MEMORY_VERBOSE` for stderr diagnostics

## 3. Proposed TOON Scope

**Scope:** CLI stdout only (human defaults unchanged).  
**Non‑goals:** do **not** alter stderr diagnostics or progress JSON lines.  
**MCP:** keep JSON-RPC responses; optionally add `format=toon` to return `data_toon` inside JSON.

Rationale: MCP + hooks expect JSON envelopes; TOON must be *additive*.

## 4. Proposed Format Precedence (Add)

Recommended precedence (highest → lowest):
1. **Explicit CLI**: `--format` (or `--json` as a shorthand for `format=json`)
2. **Repo/User env**: `CM_OUTPUT_FORMAT`
3. **Global env**: `TOON_DEFAULT_FORMAT`
4. **Command default** (human text or markdown where applicable)

Notes:
- Preserve `--json` behavior as authoritative for JSON.
- Only apply env defaults to commands that already support JSON output.
- If `tru` missing and `format=toon`, warn to stderr and fallback to JSON.

## 5. Doc Insertion Points

**README.md**
- CLI Reference: document `--format toon` (and `CM_OUTPUT_FORMAT`, `TOON_DEFAULT_FORMAT`).
- MCP Server section: TOON is embedded in JSON (protocol constraint).

**AGENTS.md**
- Add short note about `--format toon` and env precedence.

**CLI Help**
- `src/cm.ts` help epilog/examples: include `--format toon`.
- `src/commands/context.ts` / `project.ts`: extend `--format` allowed values.

## 6. Fixture‑Friendly Sample Outputs

Use the standard JSON envelope from `printJsonResult()` with the following
data shapes (already exercised in tests):

**context**
- Data shape: `ContextResult` (`src/types.ts`)
- Test reference: `test/cli-context.e2e.test.ts`

**playbook**
- Data shape: arrays of `PlaybookBullet` in `playbook` commands
- Test reference: `test/cli-playbook.e2e.test.ts`, `test/playbook*.test.ts`

**doctor**
- Data shape: `doctor` payload in `src/commands/doctor.ts`
- Test reference: `test/cli-doctor.e2e.test.ts`, `test/doctor*.test.ts`

If fixtures are needed, prefer:
- `test/fixtures/playbook-*.yaml` for playbook content
- `test/fixtures/diary-*` for diary inputs
- Log snapshots in `test/logs/` (already used by E2E tests)

---

**Summary:** cm’s JSON output is centralized in `printJsonResult()` and used by nearly every command.  
TOON should be an additive CLI format only, with MCP/diagnostics preserved as JSON.
