# Agent-Native Onboarding: Populating cass-memory Without API Costs

## The Problem

`cm reflect` uses LLM API calls to extract rules from sessions. This costs real money per token. But if you're using Claude Code via Claude Max ($100/month) or GPT via ChatGPT Pro, you've already paid for unlimited LLM usage.

**The insight**: Have the coding agent do the reflection work directly, for "free".

## The Solution: Agent-Native Reflection

Instead of:
```
cass sessions → cm reflect → LLM API ($$$) → playbook
```

Use:
```
cass sessions → agent reads → agent extracts rules → cm playbook add → playbook
```

## Step-by-Step Onboarding Process

### 1. Check Available Sessions

```bash
# Get diverse sessions across workspaces and agents
cass search "function" --robot --limit 30 | jq -r '.hits[] | "\(.agent)|\(.workspace)|\(.source_path)"' | sort -u

# Or search by workspace
cass search "*" --workspace /path/to/project --robot --limit 20
```

### 2. Export Sessions for Analysis

```bash
# Export a session to readable text
cass export "/path/to/session.jsonl" --format text | head -500

# Or as markdown for better formatting
cass export "/path/to/session.jsonl" --format markdown > session.md
```

### 3. Agent Analyzes Sessions

As the coding agent, read the exported sessions and identify:

1. **Patterns that led to success** - What approaches worked?
2. **Patterns that caused problems** - What should be avoided?
3. **Workflow insights** - How did the agent coordinate, prioritize, debug?
4. **Tool-specific knowledge** - CLI quirks, API formats, configuration patterns

### 4. Add Rules via CLI

```bash
# Add a positive rule
cm playbook add "Your rule content here" --category "category"

# Categories: debugging, testing, architecture, workflow, documentation, integration, collaboration

# Add an anti-pattern (AVOID prefix)
cm playbook add "AVOID: Description of what not to do" --category "category"
```

### 5. Verify and Test

```bash
# List all rules
cm playbook list

# Test context retrieval
cm context "your task description" --json | jq '.relevantBullets[] | {content, relevanceScore}'

# Check playbook health
cm stats --json
```

## Example Rule Extraction

From a session where an agent fixed a JSON parsing bug:

**Session excerpt:**
> "The cass search command returns `{ count, hits, ... }` but the code expected a raw array..."

**Extracted rule:**
```bash
cm playbook add "When parsing JSON output from external CLI tools, handle both raw arrays and wrapper objects like { count, hits } - APIs often evolve their response formats" --category "integration"
```

## Categories to Use

| Category | Use For |
|----------|---------|
| `debugging` | Bug investigation patterns |
| `testing` | Test writing and maintenance |
| `architecture` | Code organization patterns |
| `workflow` | Task management and prioritization |
| `documentation` | Doc writing standards |
| `integration` | External tool and API patterns |
| `collaboration` | Multi-agent coordination |
| `git` | Version control patterns |
| `security` | Security best practices |

## Batch Onboarding Script

For systematic onboarding, have the agent process sessions in batches:

```bash
#!/bin/bash
# Agent-assisted onboarding

# 1. List sessions to process
cass search "*" --robot --limit 50 | jq -r '.hits[].source_path' | sort -u > sessions.txt

# 2. For each session, agent reads and extracts rules
# (Agent does this interactively)

# 3. After extraction, check results
cm playbook list
cm stats --json
```

## Marking Feedback

When rules prove helpful or harmful during actual work:

```bash
# Mark a rule as helpful
cm mark <bullet-id> --helpful

# Mark a rule as harmful with reason
cm mark <bullet-id> --harmful --reason "Caused regression in X"
```

Or use inline comments in code:
```typescript
// [cass: helpful b-xyz123] - this rule saved debugging time
// [cass: harmful b-abc456] - this advice was wrong for our use case
```

## When to Use This vs API-Based Reflection

| Situation | Approach |
|-----------|----------|
| Initial onboarding (many sessions) | Agent-native (free) |
| Ongoing daily reflection | Either (API is fine for small batches) |
| Specific session deep-dive | Agent-native (more thorough) |
| Automated CI/CD integration | API-based (unattended) |

## Benefits

1. **Zero API cost** - Uses your existing Claude Max/GPT Pro subscription
2. **More thorough** - Agent can read full context, not just summaries
3. **Interactive** - Agent can ask clarifying questions
4. **Immediate** - No waiting for API rate limits
5. **Better rules** - Agent understands nuance better than batch API

## Limitations

1. **Requires agent time** - Not fully automated
2. **Manual process** - Each session needs explicit review
3. **No validation gate** - Rules aren't evidence-checked against cass history

## Recommended Workflow

1. **Initial onboarding**: Agent processes 20-50 diverse sessions manually
2. **Ongoing maintenance**: Mix of agent-native (complex sessions) and API-based (simple sessions)
3. **Rule refinement**: Agent periodically reviews and consolidates rules
