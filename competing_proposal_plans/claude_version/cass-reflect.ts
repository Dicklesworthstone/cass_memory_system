#!/usr/bin/env bun
/**
 * cass-reflect: Agent-Agnostic Reflection & Memory System
 * 
 * A CLI tool that implements the ACE (Agentic Context Engineering) pattern
 * for any coding agent. Uses cass for episodic memory retrieval and any
 * LLM provider via Vercel AI SDK for reflection.
 * 
 * Usage:
 *   bun run cass-reflect.ts <command> [options]
 * 
 * Or compile to standalone:
 *   bun build --compile --minify cass-reflect.ts --outfile cass-reflect
 * 
 * Commands:
 *   context     - Retrieve relevant context from cass for current task
 *   diary       - Generate diary entry from a session
 *   reflect     - Run reflection cycle on recent sessions
 *   curate      - Merge delta entries into playbook (deterministic)
 *   audit       - Check sessions against playbook rules
 *   mark        - Record bullet usage (helpful/harmful)
 *   playbook    - Manage playbook entries
 *   init        - Initialize configuration and playbook
 */

import { execSync, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join, dirname, basename } from "path";

// Vercel AI SDK imports - these are the only external dependencies
import { generateText, generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

// ============================================================================
// CONFIGURATION & TYPES
// ============================================================================

const VERSION = "0.1.0";
const CONFIG_DIR = join(homedir(), ".cass-reflect");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_PLAYBOOK = join(CONFIG_DIR, "playbook.yaml");
const USAGE_LOG = join(CONFIG_DIR, "usage.jsonl");

interface Config {
  provider: "openai" | "anthropic" | "google";
  model: string;
  apiKey?: string; // Falls back to env vars
  cassPath: string;
  playbookPath: string;
  maxReflectorIterations: number;
  dedupSimilarityThreshold: number;
  pruneHarmfulThreshold: number;
  maxBulletsInContext: number;
  sessionLookbackDays: number;
}

const DEFAULT_CONFIG: Config = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  cassPath: "cass",
  playbookPath: DEFAULT_PLAYBOOK,
  maxReflectorIterations: 3,
  dedupSimilarityThreshold: 0.85,
  pruneHarmfulThreshold: 3,
  maxBulletsInContext: 50,
  sessionLookbackDays: 7,
};

interface Bullet {
  id: string;
  category: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  helpfulCount: number;
  harmfulCount: number;
  sourceSessions: string[];
  tags: string[];
  deprecated?: boolean;
  replacedBy?: string;
}

interface Playbook {
  schemaVersion: number;
  name: string;
  description: string;
  bullets: Bullet[];
  metadata: {
    lastReflection: string;
    totalReflections: number;
    createdAt: string;
  };
}

interface DiaryEntry {
  sessionPath: string;
  timestamp: string;
  agent: string;
  workspace: string;
  accomplishments: string[];
  decisions: string[];
  challenges: string[];
  preferences: string[];
  keyLearnings: string[];
  bulletUsage: { id: string; helpful: boolean }[];
}

interface BulletDelta {
  type: "new" | "helpful" | "harmful" | "replace" | "deprecate";
  bulletId?: string;
  newBullet?: Omit<Bullet, "id" | "createdAt" | "updatedAt" | "helpfulCount" | "harmfulCount">;
  newContent?: string;
  reason?: string;
  sourceSession?: string;
}

interface ReflectionResult {
  sessionPath: string;
  diary: DiaryEntry;
  deltas: BulletDelta[];
  reflectorIterations: number;
}

interface CassSearchResult {
  hits: Array<{
    source_path: string;
    line_number: number;
    agent: string;
    workspace: string;
    title: string;
    snippet: string;
    score: number;
    created_at: string;
  }>;
  _meta?: {
    elapsed_ms: number;
    total_hits: number;
    wildcard_fallback: boolean;
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig(): Config {
  ensureConfigDir();
  if (existsSync(CONFIG_FILE)) {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (err: any) {
      console.warn(`Invalid config JSON at ${CONFIG_FILE}: ${err?.message || err}`);
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadPlaybook(path: string): Playbook {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      name: "default",
      description: "Auto-generated playbook",
      bullets: [],
      metadata: {
        lastReflection: new Date().toISOString(),
        totalReflections: 0,
        createdAt: new Date().toISOString(),
      },
    };
  }
  const raw = readFileSync(path, "utf-8");
  // Simple YAML parsing for our schema (or use a proper parser)
  return parsePlaybookYaml(raw);
}

function savePlaybook(path: string, playbook: Playbook): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, serializePlaybookYaml(playbook));
}

function generateBulletId(): string {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content.toLowerCase().trim()).digest("hex").slice(0, 16);
}

// Simple YAML serialization for playbook (avoid external deps)
function serializePlaybookYaml(playbook: Playbook): string {
  const lines: string[] = [
    `schema_version: ${playbook.schemaVersion}`,
    `name: "${playbook.name}"`,
    `description: "${playbook.description}"`,
    "",
    "metadata:",
    `  last_reflection: "${playbook.metadata.lastReflection}"`,
    `  total_reflections: ${playbook.metadata.totalReflections}`,
    `  created_at: "${playbook.metadata.createdAt}"`,
    "",
    "bullets:",
  ];

  for (const b of playbook.bullets) {
    lines.push(`  - id: "${b.id}"`);
    lines.push(`    category: "${b.category}"`);
    lines.push(`    content: |`);
    for (const line of b.content.split("\n")) {
      lines.push(`      ${line}`);
    }
    lines.push(`    created_at: "${b.createdAt}"`);
    lines.push(`    updated_at: "${b.updatedAt}"`);
    lines.push(`    helpful_count: ${b.helpfulCount}`);
    lines.push(`    harmful_count: ${b.harmfulCount}`);
    lines.push(`    tags: [${b.tags.map(t => `"${t}"`).join(", ")}]`);
    lines.push(`    source_sessions:`);
    for (const s of b.sourceSessions) {
      lines.push(`      - "${s}"`);
    }
    if (b.deprecated) {
      lines.push(`    deprecated: true`);
      if (b.replacedBy) {
        lines.push(`    replaced_by: "${b.replacedBy}"`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Simple YAML parsing (handles our specific schema)
function parsePlaybookYaml(yaml: string): Playbook {
  // For production, use a proper YAML parser. This is a simplified version.
  try {
    // Try JSON first (we also support JSON playbooks)
    if (yaml.trim().startsWith("{")) {
      return JSON.parse(yaml);
    }
  } catch {}

  const playbook: Playbook = {
    schemaVersion: 1,
    name: "default",
    description: "",
    bullets: [],
    metadata: {
      lastReflection: new Date().toISOString(),
      totalReflections: 0,
      createdAt: new Date().toISOString(),
    },
  };

  // Basic YAML parsing - extract bullet blocks
  const bulletMatches = yaml.matchAll(/- id: "([^"]+)"([\s\S]*?)(?=\n  - id:|$)/g);
  
  for (const match of bulletMatches) {
    const block = match[0];
    const bullet: Bullet = {
      id: match[1],
      category: extractYamlField(block, "category") || "general",
      content: extractYamlMultiline(block, "content") || "",
      createdAt: extractYamlField(block, "created_at") || new Date().toISOString(),
      updatedAt: extractYamlField(block, "updated_at") || new Date().toISOString(),
      helpfulCount: parseInt(extractYamlField(block, "helpful_count") || "0", 10),
      harmfulCount: parseInt(extractYamlField(block, "harmful_count") || "0", 10),
      tags: extractYamlArray(block, "tags"),
      sourceSessions: extractYamlArray(block, "source_sessions"),
      deprecated: extractYamlField(block, "deprecated") === "true",
      replacedBy: extractYamlField(block, "replaced_by"),
    };
    playbook.bullets.push(bullet);
  }

  // Extract metadata
  playbook.name = extractYamlField(yaml, "name") || "default";
  playbook.description = extractYamlField(yaml, "description") || "";
  playbook.schemaVersion = parseInt(extractYamlField(yaml, "schema_version") || "1", 10);

  const metadataMatch = yaml.match(/metadata:([\s\S]*?)(?=\nbullets:|$)/);
  if (metadataMatch) {
    const meta = metadataMatch[1];
    playbook.metadata.lastReflection = extractYamlField(meta, "last_reflection") || playbook.metadata.lastReflection;
    playbook.metadata.totalReflections = parseInt(extractYamlField(meta, "total_reflections") || "0", 10);
    playbook.metadata.createdAt = extractYamlField(meta, "created_at") || playbook.metadata.createdAt;
  }

  return playbook;
}

function extractYamlField(block: string, field: string): string | undefined {
  const match = block.match(new RegExp(`${field}:\\s*"?([^"\\n]+)"?`));
  return match?.[1]?.trim();
}

function extractYamlMultiline(block: string, field: string): string | undefined {
  const match = block.match(new RegExp(`${field}:\\s*\\|([\\s\\S]*?)(?=\\n\\s+\\w+:|$)`));
  if (match) {
    return match[1].split("\n").map(l => l.trim()).filter(Boolean).join("\n");
  }
  return extractYamlField(block, field);
}

function extractYamlArray(block: string, field: string): string[] {
  // Handle inline array: tags: ["a", "b"]
  const inlineMatch = block.match(new RegExp(`${field}:\\s*\\[([^\\]]+)\\]`));
  if (inlineMatch) {
    return inlineMatch[1].split(",").map(s => s.trim().replace(/"/g, "")).filter(Boolean);
  }
  
  // Handle block array
  const blockMatch = block.match(new RegExp(`${field}:([\\s\\S]*?)(?=\\n\\s+\\w+:|$)`));
  if (blockMatch) {
    const items = blockMatch[1].match(/-\s*"?([^"\\n]+)"?/g);
    return items?.map(i => i.replace(/^-\s*"?/, "").replace(/"?$/, "").trim()) || [];
  }
  
  return [];
}

function logUsage(entry: { bulletId: string; helpful: boolean; sessionPath?: string; timestamp: string }): void {
  ensureConfigDir();
  appendFileSync(USAGE_LOG, JSON.stringify(entry) + "\n");
}

// ============================================================================
// CASS INTEGRATION
// ============================================================================

function cassAvailable(config: Config): boolean {
  try {
    execSync(`${config.cassPath} --version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function cassSearch(config: Config, query: string, options: {
  limit?: number;
  days?: number;
  agent?: string;
  workspace?: string;
}): CassSearchResult {
  const args = ["search", `"${query}"`, "--robot"];
  
  if (options.limit) args.push("--limit", String(options.limit));
  if (options.days) args.push("--days", String(options.days));
  if (options.agent) args.push("--agent", options.agent);
  if (options.workspace) args.push("--workspace", options.workspace);

  try {
    const result = execSync(`${config.cassPath} ${args.join(" ")}`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
    return JSON.parse(result);
  } catch (e: any) {
    // Return empty results on error
    console.error(`[cass-reflect] cass search failed: ${e.message}`);
    return { hits: [] };
  }
}

function cassTimeline(config: Config, options: { days?: number; groupBy?: string }): any {
  const args = ["timeline", "--robot"];
  if (options.days) args.push("--days", String(options.days));
  if (options.groupBy) args.push("--group-by", options.groupBy);

  try {
    const result = execSync(`${config.cassPath} ${args.join(" ")}`, { encoding: "utf-8" });
    return JSON.parse(result);
  } catch {
    return { groups: [] };
  }
}

function cassExport(config: Config, sessionPath: string): any {
  try {
    const result = execSync(`${config.cassPath} export "${sessionPath}" --format json`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(result);
  } catch (e: any) {
    console.error(`[cass-reflect] cass export failed: ${e.message}`);
    return null;
  }
}

function cassView(config: Config, sessionPath: string, lineNumber?: number): any {
  const args = ["view", `"${sessionPath}"`, "--json"];
  if (lineNumber) args.push("-n", String(lineNumber));

  try {
    const result = execSync(`${config.cassPath} ${args.join(" ")}`, { encoding: "utf-8" });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// ============================================================================
// LLM INTEGRATION (Vercel AI SDK)
// ============================================================================

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
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
  };
  const key = process.env[envVars[provider]];
  if (!key) {
    throw new Error(`No API key found. Set ${envVars[provider]} or configure in ${CONFIG_FILE}`);
  }
  return key;
}

// ============================================================================
// CORE REFLECTION LOGIC
// ============================================================================

const DiarySchema = z.object({
  accomplishments: z.array(z.string()).describe("What was accomplished in this session"),
  decisions: z.array(z.string()).describe("Key design/architecture decisions made"),
  challenges: z.array(z.string()).describe("Problems encountered and how they were addressed"),
  preferences: z.array(z.string()).describe("User preferences revealed (coding style, tools, patterns)"),
  keyLearnings: z.array(z.string()).describe("Important insights that could help future sessions"),
  suggestedTags: z.array(z.string()).describe("Tags for categorizing this session"),
});

const DeltaSchema = z.object({
  deltas: z.array(z.object({
    type: z.enum(["new", "helpful", "harmful", "replace", "deprecate"]),
    bulletId: z.string().optional().describe("ID of existing bullet (for helpful/harmful/replace/deprecate)"),
    category: z.string().optional().describe("Category for new bullets"),
    content: z.string().optional().describe("Content for new bullets or replacement content"),
    tags: z.array(z.string()).optional().describe("Tags for new bullets"),
    reason: z.string().describe("Why this delta is proposed"),
  })),
});

async function generateDiary(
  config: Config,
  sessionContent: string,
  sessionPath: string,
  agent: string,
  workspace: string,
): Promise<DiaryEntry> {
  const model = getModel(config);

  const { object } = await generateObject({
    model,
    schema: DiarySchema,
    prompt: `Analyze this coding agent session and extract structured insights.

SESSION PATH: ${sessionPath}
AGENT: ${agent}
WORKSPACE: ${workspace}

SESSION CONTENT:
${sessionContent.slice(0, 100000)} ${sessionContent.length > 100000 ? "\n[...truncated...]" : ""}

Extract:
1. ACCOMPLISHMENTS: What was completed or progressed
2. DECISIONS: Design choices, architecture decisions, tool selections
3. CHALLENGES: Problems encountered, errors hit, blockers
4. PREFERENCES: User's coding style, preferred approaches, tool preferences
5. KEY LEARNINGS: Insights that would help future sessions on similar tasks

Be specific and actionable. Avoid generic statements like "wrote code" or "fixed bugs".
Include specific file names, function names, error messages, and solutions when available.`,
  });

  return {
    sessionPath,
    timestamp: new Date().toISOString(),
    agent,
    workspace,
    accomplishments: object.accomplishments,
    decisions: object.decisions,
    challenges: object.challenges,
    preferences: object.preferences,
    keyLearnings: object.keyLearnings,
    bulletUsage: [],
  };
}

async function generateDeltas(
  config: Config,
  diary: DiaryEntry,
  sessionContent: string,
  existingBullets: Bullet[],
  iteration: number,
): Promise<BulletDelta[]> {
  const model = getModel(config);

  const bulletsContext = existingBullets
    .filter(b => !b.deprecated)
    .slice(0, config.maxBulletsInContext)
    .map(b => `[${b.id}] (${b.category}) ${b.content} [helpful:${b.helpfulCount}, harmful:${b.harmfulCount}]`)
    .join("\n");

  const prompt = `You are analyzing a coding session to extract reusable lessons for a playbook.

EXISTING PLAYBOOK BULLETS:
${bulletsContext || "(empty playbook)"}

SESSION DIARY:
- Accomplishments: ${diary.accomplishments.join("; ")}
- Decisions: ${diary.decisions.join("; ")}
- Challenges: ${diary.challenges.join("; ")}
- Preferences: ${diary.preferences.join("; ")}
- Key Learnings: ${diary.keyLearnings.join("; ")}

SESSION CONTENT (excerpt):
${sessionContent.slice(0, 50000)}

${iteration > 1 ? `This is iteration ${iteration}. Focus on insights you may have missed.` : ""}

For each insight from this session, determine:
1. NEW: Is this a novel lesson not covered by existing bullets? Create a new bullet.
2. HELPFUL: Did an existing bullet prove useful in this session? Mark it helpful.
3. HARMFUL: Did following an existing bullet cause problems? Mark it harmful.
4. REPLACE: Should an existing bullet be updated with better information?
5. DEPRECATE: Is an existing bullet now outdated or wrong?

Guidelines:
- Be SPECIFIC. Bad: "Write tests". Good: "For React hooks, test the returned values and effects separately using renderHook from @testing-library/react-hooks"
- Include concrete examples, file patterns, command flags when relevant
- Only propose deltas for genuinely reusable insights, not one-off solutions
- Consider if a bullet would help a different agent working on a similar problem`;

  const { object } = await generateObject({
    model,
    schema: DeltaSchema,
    prompt,
  });

  return object.deltas.map(d => ({
    type: d.type,
    bulletId: d.bulletId,
    newBullet: d.type === "new" ? {
      category: d.category || "general",
      content: d.content || "",
      tags: d.tags || [],
      sourceSessions: [diary.sessionPath],
    } : undefined,
    newContent: d.type === "replace" ? d.content : undefined,
    reason: d.reason,
    sourceSession: diary.sessionPath,
  }));
}

async function runReflection(
  config: Config,
  sessionPath: string,
  sessionContent: string,
  agent: string,
  workspace: string,
  playbook: Playbook,
): Promise<ReflectionResult> {
  // Generate diary first
  const diary = await generateDiary(config, sessionContent, sessionPath, agent, workspace);

  // Iterative delta generation (ACE pattern)
  let allDeltas: BulletDelta[] = [];
  const seenContentHashes = new Set<string>();

  for (let i = 1; i <= config.maxReflectorIterations; i++) {
    const deltas = await generateDeltas(config, diary, sessionContent, playbook.bullets, i);
    
    // Deduplicate within this reflection
    for (const delta of deltas) {
      if (delta.type === "new" && delta.newBullet) {
        const hash = hashContent(delta.newBullet.content);
        if (!seenContentHashes.has(hash)) {
          seenContentHashes.add(hash);
          allDeltas.push(delta);
        }
      } else {
        allDeltas.push(delta);
      }
    }

    // Early exit if no new insights
    if (deltas.length === 0) break;
  }

  return {
    sessionPath,
    diary,
    deltas: allDeltas,
    reflectorIterations: config.maxReflectorIterations,
  };
}

// ============================================================================
// DETERMINISTIC CURATION (No LLM)
// ============================================================================

function curatePlaybook(
  playbook: Playbook,
  deltas: BulletDelta[],
  config: Config,
): { playbook: Playbook; applied: number; skipped: number } {
  const updated = structuredClone(playbook);
  let applied = 0;
  let skipped = 0;

  // Track content hashes of existing bullets for dedup
  const existingHashes = new Set(
    updated.bullets.map(b => hashContent(b.content))
  );

  for (const delta of deltas) {
    switch (delta.type) {
      case "new":
        if (delta.newBullet) {
          const hash = hashContent(delta.newBullet.content);
          
          // Check for semantic duplicates (simple hash-based for now)
          if (existingHashes.has(hash)) {
            skipped++;
            continue;
          }

          // Check similarity with existing bullets (basic substring check)
          const isDuplicate = updated.bullets.some(b => {
            const similarity = computeSimpleSimilarity(b.content, delta.newBullet!.content);
            return similarity > config.dedupSimilarityThreshold;
          });

          if (isDuplicate) {
            skipped++;
            continue;
          }

          const newBullet: Bullet = {
            id: generateBulletId(),
            category: delta.newBullet.category,
            content: delta.newBullet.content,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            helpfulCount: 0,
            harmfulCount: 0,
            tags: delta.newBullet.tags,
            sourceSessions: delta.newBullet.sourceSessions,
          };

          updated.bullets.push(newBullet);
          existingHashes.add(hash);
          applied++;
        }
        break;

      case "helpful":
        if (delta.bulletId) {
          const bullet = updated.bullets.find(b => b.id === delta.bulletId);
          if (bullet) {
            bullet.helpfulCount++;
            bullet.updatedAt = new Date().toISOString();
            if (delta.sourceSession && !bullet.sourceSessions.includes(delta.sourceSession)) {
              bullet.sourceSessions.push(delta.sourceSession);
            }
            applied++;
          }
        }
        break;

      case "harmful":
        if (delta.bulletId) {
          const bullet = updated.bullets.find(b => b.id === delta.bulletId);
          if (bullet) {
            bullet.harmfulCount++;
            bullet.updatedAt = new Date().toISOString();
            applied++;
          }
        }
        break;

      case "replace":
        if (delta.bulletId && delta.newContent) {
          const bullet = updated.bullets.find(b => b.id === delta.bulletId);
          if (bullet) {
            bullet.content = delta.newContent;
            bullet.updatedAt = new Date().toISOString();
            applied++;
          }
        }
        break;

      case "deprecate":
        if (delta.bulletId) {
          const bullet = updated.bullets.find(b => b.id === delta.bulletId);
          if (bullet) {
            bullet.deprecated = true;
            bullet.updatedAt = new Date().toISOString();
            applied++;
          }
        }
        break;
    }
  }

  // Prune bullets where harmful exceeds helpful by threshold
  const beforePrune = updated.bullets.length;
  updated.bullets = updated.bullets.filter(b => {
    if (b.deprecated) return true; // Keep deprecated for history
    const score = b.helpfulCount - b.harmfulCount;
    return score > -config.pruneHarmfulThreshold;
  });
  const pruned = beforePrune - updated.bullets.length;
  if (pruned > 0) {
    console.error(`[cass-reflect] Pruned ${pruned} bullets with negative scores`);
  }

  // Update metadata
  updated.metadata.lastReflection = new Date().toISOString();
  updated.metadata.totalReflections++;

  return { playbook: updated, applied, skipped };
}

function computeSimpleSimilarity(a: string, b: string): number {
  // Simple Jaccard similarity on words
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  
  return intersection / union;
}

// ============================================================================
// CONTEXT RETRIEVAL FOR AGENTS
// ============================================================================

async function getContextForTask(
  config: Config,
  task: string,
  playbook: Playbook,
  options: {
    maxBullets?: number;
    maxHistoryResults?: number;
    workspace?: string;
  } = {},
): Promise<{
  relevantBullets: Bullet[];
  historicalContext: CassSearchResult["hits"];
  prompt: string;
}> {
  const maxBullets = options.maxBullets || config.maxBulletsInContext;
  const maxHistory = options.maxHistoryResults || 10;

  // Extract key terms from task for search
  const searchTerms = extractSearchTerms(task);

  // Search cass for relevant history
  let historicalContext: CassSearchResult["hits"] = [];
  if (cassAvailable(config) && searchTerms.length > 0) {
    const results = cassSearch(config, searchTerms.join(" "), {
      limit: maxHistory,
      days: config.sessionLookbackDays,
      workspace: options.workspace,
    });
    historicalContext = results.hits || [];
  }

  // Score bullets by relevance to task
  const scoredBullets = playbook.bullets
    .filter(b => !b.deprecated)
    .map(b => ({
      bullet: b,
      score: scoreBulletRelevance(b, task, searchTerms),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBullets);

  const relevantBullets = scoredBullets.map(s => s.bullet);

  // Generate context prompt
  const bulletsSection = relevantBullets.length > 0
    ? relevantBullets.map(b => 
        `[${b.id}] (${b.category}) ${b.content}`
      ).join("\n")
    : "(No relevant playbook entries)";

  const historySection = historicalContext.length > 0
    ? historicalContext.map(h =>
        `[${h.agent}] ${h.title || h.source_path}\n${h.snippet}`
      ).join("\n\n")
    : "(No relevant history found)";

  const prompt = `PLAYBOOK ENTRIES (mark helpful/harmful as you use them):
${bulletsSection}

RELEVANT HISTORY FROM PAST SESSIONS:
${historySection}

CURRENT TASK:
${task}

As you work, note which playbook entries were helpful or harmful using:
- [HELPFUL: bullet-id] when an entry helped
- [HARMFUL: bullet-id] when an entry caused problems`;

  return { relevantBullets, historicalContext, prompt };
}

function extractSearchTerms(text: string): string[] {
  // Extract meaningful terms for search
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why",
    "how", "all", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "and", "but", "if", "or", "because", "as", "until", "while",
    "this", "that", "these", "those", "i", "me", "my", "we", "our", "you",
    "your", "he", "him", "his", "she", "her", "it", "its", "they", "them",
    "what", "which", "who", "whom", "please", "help", "want", "need",
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 10);
}

function scoreBulletRelevance(bullet: Bullet, task: string, searchTerms: string[]): number {
  const bulletWords = new Set(
    (bullet.content + " " + bullet.tags.join(" ") + " " + bullet.category)
      .toLowerCase()
      .split(/\s+/)
  );

  let score = 0;
  
  // Term overlap
  for (const term of searchTerms) {
    if (bulletWords.has(term)) score += 2;
    // Partial match
    for (const word of bulletWords) {
      if (word.includes(term) || term.includes(word)) score += 0.5;
    }
  }

  // Boost by helpful ratio
  const totalUsage = bullet.helpfulCount + bullet.harmfulCount;
  if (totalUsage > 0) {
    const helpfulRatio = bullet.helpfulCount / totalUsage;
    score *= (0.5 + helpfulRatio); // 0.5x to 1.5x multiplier
  }

  return score;
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

async function cmdInit(args: string[]): Promise<void> {
  ensureConfigDir();
  
  const config = loadConfig();
  saveConfig(config);
  
  if (!existsSync(config.playbookPath)) {
    const playbook = loadPlaybook(config.playbookPath);
    savePlaybook(config.playbookPath, playbook);
    console.log(`Created playbook: ${config.playbookPath}`);
  }

  console.log(`Configuration initialized at: ${CONFIG_DIR}`);
  console.log(`Config file: ${CONFIG_FILE}`);
  console.log(`Playbook: ${config.playbookPath}`);
  
  if (!cassAvailable(config)) {
    console.warn("\nWarning: cass not found in PATH. Install from:");
    console.warn("https://github.com/Dicklesworthstone/coding_agent_session_search");
  }
}

async function cmdContext(args: string[]): Promise<void> {
  const config = loadConfig();
  const playbook = loadPlaybook(config.playbookPath);

  // Parse args
  let task = "";
  let workspace: string | undefined;
  let maxBullets: number | undefined;
  let maxHistory: number | undefined;
  let outputFormat = "text";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" || args[i] === "-w") {
      workspace = args[++i];
    } else if (args[i] === "--max-bullets") {
      maxBullets = parseInt(args[++i] ?? "", 10);
    } else if (args[i] === "--max-history") {
      maxHistory = parseInt(args[++i] ?? "", 10);
    } else if (args[i] === "--json") {
      outputFormat = "json";
    } else if (!args[i].startsWith("-")) {
      task = args.slice(i).join(" ");
      break;
    }
  }

  if (!task) {
    // Read from stdin if no task provided
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk as Buffer);
    }
    task = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!task) {
    console.error("Usage: cass-reflect context <task description>");
    console.error("   or: echo 'task' | cass-reflect context");
    process.exit(1);
  }

  const result = await getContextForTask(config, task, playbook, {
    workspace,
    maxBullets,
    maxHistoryResults: maxHistory,
  });

  if (outputFormat === "json") {
    console.log(JSON.stringify({
      bullets: result.relevantBullets,
      history: result.historicalContext,
      prompt: result.prompt,
    }, null, 2));
  } else {
    console.log(result.prompt);
  }
}

async function cmdDiary(args: string[]): Promise<void> {
  const config = loadConfig();

  let sessionPath = "";
  let outputFormat = "json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yaml") {
      outputFormat = "yaml";
    } else if (!args[i].startsWith("-")) {
      sessionPath = args[i];
    }
  }

  if (!sessionPath) {
    console.error("Usage: cass-reflect diary <session-path>");
    process.exit(1);
  }

  // Get session content
  let sessionContent: string;
  let agent = "unknown";
  let workspace = "";

  if (cassAvailable(config)) {
    const exported = cassExport(config, sessionPath);
    if (exported) {
      sessionContent = JSON.stringify(exported, null, 2);
      agent = exported.agent || "unknown";
      workspace = exported.workspace || "";
    } else {
      sessionContent = readFileSync(sessionPath, "utf-8");
    }
  } else {
    sessionContent = readFileSync(sessionPath, "utf-8");
  }

  const diary = await generateDiary(config, sessionContent, sessionPath, agent, workspace);

  if (outputFormat === "json") {
    console.log(JSON.stringify(diary, null, 2));
  } else {
    // Simple YAML output
    console.log(`session_path: "${diary.sessionPath}"`);
    console.log(`timestamp: "${diary.timestamp}"`);
    console.log(`agent: "${diary.agent}"`);
    console.log(`workspace: "${diary.workspace}"`);
    console.log("accomplishments:");
    diary.accomplishments.forEach(a => console.log(`  - "${a}"`));
    console.log("decisions:");
    diary.decisions.forEach(d => console.log(`  - "${d}"`));
    console.log("challenges:");
    diary.challenges.forEach(c => console.log(`  - "${c}"`));
    console.log("preferences:");
    diary.preferences.forEach(p => console.log(`  - "${p}"`));
    console.log("key_learnings:");
    diary.keyLearnings.forEach(k => console.log(`  - "${k}"`));
  }
}

async function cmdReflect(args: string[]): Promise<void> {
  const config = loadConfig();
  const playbook = loadPlaybook(config.playbookPath);

  let days = config.sessionLookbackDays;
  let agent: string | undefined;
  let workspace: string | undefined;
  let dryRun = false;
  let maxSessions = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" || args[i] === "-d") {
      days = parseInt(args[++i] ?? "", 10);
    } else if (args[i] === "--agent" || args[i] === "-a") {
      agent = args[++i];
    } else if (args[i] === "--workspace" || args[i] === "-w") {
      workspace = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--max-sessions") {
      maxSessions = parseInt(args[++i] ?? "", 10);
    }
  }

  if (!cassAvailable(config)) {
    console.error("Error: cass is required for reflection. Install from:");
    console.error("https://github.com/Dicklesworthstone/coding_agent_session_search");
    process.exit(1);
  }

  // Get recent sessions from cass
  console.error(`[cass-reflect] Searching for sessions from last ${days} days...`);
  
  const timeline = cassTimeline(config, { days, groupBy: "day" });
  const sessionPaths = new Set<string>();

  // Also search for recent activity
  const searchResults = cassSearch(config, "*", { limit: maxSessions * 2, days, agent, workspace });
  
  for (const hit of searchResults.hits || []) {
    sessionPaths.add(hit.source_path);
    if (sessionPaths.size >= maxSessions) break;
  }

  if (sessionPaths.size === 0) {
    console.error("[cass-reflect] No sessions found for reflection");
    process.exit(0);
  }

  console.error(`[cass-reflect] Found ${sessionPaths.size} sessions to reflect on`);

  const allDeltas: BulletDelta[] = [];
  const diaries: DiaryEntry[] = [];

  for (const sessionPath of sessionPaths) {
    console.error(`[cass-reflect] Reflecting on: ${basename(sessionPath)}`);
    
    try {
      const exported = cassExport(config, sessionPath);
      if (!exported) continue;

      const sessionContent = JSON.stringify(exported, null, 2);
      const result = await runReflection(
        config,
        sessionPath,
        sessionContent,
        exported.agent || "unknown",
        exported.workspace || "",
        playbook,
      );

      diaries.push(result.diary);
      allDeltas.push(...result.deltas);
      
      console.error(`[cass-reflect]   Generated ${result.deltas.length} deltas`);
    } catch (e: any) {
      console.error(`[cass-reflect]   Error: ${e.message}`);
    }
  }

  console.error(`[cass-reflect] Total deltas: ${allDeltas.length}`);

  if (dryRun) {
    console.log(JSON.stringify({ diaries, deltas: allDeltas }, null, 2));
    return;
  }

  // Apply deltas
  const { playbook: updated, applied, skipped } = curatePlaybook(playbook, allDeltas, config);
  
  console.error(`[cass-reflect] Applied ${applied} deltas, skipped ${skipped} (duplicates/low-quality)`);
  console.error(`[cass-reflect] Playbook now has ${updated.bullets.length} bullets`);

  savePlaybook(config.playbookPath, updated);
  console.error(`[cass-reflect] Saved to: ${config.playbookPath}`);

  // Output summary
  console.log(JSON.stringify({
    sessionsProcessed: sessionPaths.size,
    deltasGenerated: allDeltas.length,
    deltasApplied: applied,
    deltasSkipped: skipped,
    totalBullets: updated.bullets.length,
    playbookPath: config.playbookPath,
  }, null, 2));
}

async function cmdCurate(args: string[]): Promise<void> {
  const config = loadConfig();
  
  let deltasFile = "";
  let playbookPath = config.playbookPath;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" || args[i] === "-i") {
      deltasFile = args[++i];
    } else if (args[i] === "--playbook" || args[i] === "-p") {
      playbookPath = args[++i];
    } else if (args[i] === "--output" || args[i] === "-o") {
      outputPath = args[++i];
    }
  }

  // Read deltas from file or stdin
  let deltasJson: string;
  if (deltasFile) {
    deltasJson = readFileSync(deltasFile, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk as Buffer);
    }
    deltasJson = Buffer.concat(chunks).toString("utf-8");
  }

  let deltas: BulletDelta[] = [];
  try {
    const parsed = JSON.parse(deltasJson) as { deltas?: BulletDelta[] };
    deltas = parsed.deltas ?? [];
  } catch (err: any) {
    console.error(`Invalid deltas JSON: ${err?.message || err}`);
    process.exit(1);
  }
  const playbook = loadPlaybook(playbookPath);

  const { playbook: updated, applied, skipped } = curatePlaybook(playbook, deltas, config);

  const savePath = outputPath || playbookPath;
  savePlaybook(savePath, updated);

  console.log(JSON.stringify({
    deltasProvided: deltas.length,
    deltasApplied: applied,
    deltasSkipped: skipped,
    totalBullets: updated.bullets.length,
    savedTo: savePath,
  }, null, 2));
}

async function cmdMark(args: string[]): Promise<void> {
  const config = loadConfig();
  const playbook = loadPlaybook(config.playbookPath);

  let bulletId = "";
  let helpful = true;
  let sessionPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--harmful") {
      helpful = false;
    } else if (args[i] === "--helpful") {
      helpful = true;
    } else if (args[i] === "--session" || args[i] === "-s") {
      sessionPath = args[++i];
    } else if (!args[i].startsWith("-")) {
      bulletId = args[i];
    }
  }

  if (!bulletId) {
    console.error("Usage: cass-reflect mark <bullet-id> [--helpful|--harmful] [--session <path>]");
    process.exit(1);
  }

  const bullet = playbook.bullets.find(b => b.id === bulletId);
  if (!bullet) {
    console.error(`Bullet not found: ${bulletId}`);
    process.exit(1);
  }

  if (helpful) {
    bullet.helpfulCount++;
  } else {
    bullet.harmfulCount++;
  }
  bullet.updatedAt = new Date().toISOString();

  if (sessionPath && !bullet.sourceSessions.includes(sessionPath)) {
    bullet.sourceSessions.push(sessionPath);
  }

  savePlaybook(config.playbookPath, playbook);

  // Log usage
  logUsage({
    bulletId,
    helpful,
    sessionPath,
    timestamp: new Date().toISOString(),
  });

  console.log(JSON.stringify({
    bulletId,
    marked: helpful ? "helpful" : "harmful",
    helpfulCount: bullet.helpfulCount,
    harmfulCount: bullet.harmfulCount,
  }, null, 2));
}

async function cmdAudit(args: string[]): Promise<void> {
  const config = loadConfig();
  const playbook = loadPlaybook(config.playbookPath);

  let days = 7;
  let workspace: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" || args[i] === "-d") {
      days = parseInt(args[++i] ?? "", 10);
    } else if (args[i] === "--workspace" || args[i] === "-w") {
      workspace = args[++i];
    }
  }

  if (!cassAvailable(config)) {
    console.error("Error: cass is required for audit");
    process.exit(1);
  }

  const model = getModel(config);
  const activeBullets = playbook.bullets.filter(b => !b.deprecated);

  console.error(`[cass-reflect] Auditing ${activeBullets.length} bullets against recent sessions...`);

  const violations: Array<{
    bulletId: string;
    bulletContent: string;
    violationType: string;
    sessionPath: string;
    evidence: string;
  }> = [];

  // Search for potential violations of each bullet
  for (const bullet of activeBullets.slice(0, 20)) { // Limit to avoid too many API calls
    const searchTerms = extractSearchTerms(bullet.content);
    if (searchTerms.length === 0) continue;

    const results = cassSearch(config, searchTerms.slice(0, 3).join(" "), {
      limit: 5,
      days,
      workspace,
    });

    if (results.hits && results.hits.length > 0) {
      // Use LLM to check for violations
      const { text } = await generateText({
        model,
        prompt: `Check if this coding session snippet violates this rule:

RULE: ${bullet.content}

SESSION SNIPPET:
${results.hits.map(h => h.snippet).join("\n\n").slice(0, 5000)}

If there's a clear violation, respond with JSON: {"violated": true, "evidence": "brief explanation"}
If no violation, respond with: {"violated": false}`,
      });

      try {
        const result = JSON.parse(text);
        if (result.violated) {
          violations.push({
            bulletId: bullet.id,
            bulletContent: bullet.content,
            violationType: "rule_not_followed",
            sessionPath: results.hits[0].source_path,
            evidence: result.evidence,
          });
        }
      } catch {}
    }
  }

  console.log(JSON.stringify({
    bulletsAudited: Math.min(activeBullets.length, 20),
    daysSearched: days,
    violationsFound: violations.length,
    violations,
  }, null, 2));
}

async function cmdPlaybook(args: string[]): Promise<void> {
  const config = loadConfig();
  const subcommand = args[0] || "list";
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "list":
    case "ls": {
      const playbook = loadPlaybook(config.playbookPath);
      const showDeprecated = subArgs.includes("--all");
      const category = subArgs.find(a => !a.startsWith("-"));

      let bullets = playbook.bullets;
      if (!showDeprecated) {
        bullets = bullets.filter(b => !b.deprecated);
      }
      if (category) {
        bullets = bullets.filter(b => b.category === category);
      }

      // Sort by helpful ratio
      bullets.sort((a, b) => {
        const scoreA = a.helpfulCount - a.harmfulCount;
        const scoreB = b.helpfulCount - b.harmfulCount;
        return scoreB - scoreA;
      });

      console.log(JSON.stringify({
        total: bullets.length,
        bullets: bullets.map(b => ({
          id: b.id,
          category: b.category,
          content: b.content.slice(0, 200) + (b.content.length > 200 ? "..." : ""),
          score: b.helpfulCount - b.harmfulCount,
          helpful: b.helpfulCount,
          harmful: b.harmfulCount,
          tags: b.tags,
          deprecated: b.deprecated,
        })),
      }, null, 2));
      break;
    }

    case "get": {
      const playbook = loadPlaybook(config.playbookPath);
      const bulletId = subArgs[0];
      const bullet = playbook.bullets.find(b => b.id === bulletId);
      
      if (!bullet) {
        console.error(`Bullet not found: ${bulletId}`);
        process.exit(1);
      }
      
      console.log(JSON.stringify(bullet, null, 2));
      break;
    }

    case "add": {
      const playbook = loadPlaybook(config.playbookPath);
      
      let category = "general";
      let content = "";
      let tags: string[] = [];

      for (let i = 0; i < subArgs.length; i++) {
        if (subArgs[i] === "--category" || subArgs[i] === "-c") {
          category = subArgs[++i];
        } else if (subArgs[i] === "--tags" || subArgs[i] === "-t") {
          tags = subArgs[++i].split(",").map(t => t.trim());
        } else if (!subArgs[i].startsWith("-")) {
          content = subArgs.slice(i).join(" ");
          break;
        }
      }

      if (!content) {
        console.error("Usage: cass-reflect playbook add [--category <cat>] [--tags <t1,t2>] <content>");
        process.exit(1);
      }

      const bullet: Bullet = {
        id: generateBulletId(),
        category,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        helpfulCount: 0,
        harmfulCount: 0,
        tags,
        sourceSessions: [],
      };

      playbook.bullets.push(bullet);
      savePlaybook(config.playbookPath, playbook);

      console.log(JSON.stringify({ added: bullet }, null, 2));
      break;
    }

    case "remove":
    case "rm": {
      const playbook = loadPlaybook(config.playbookPath);
      const bulletId = subArgs[0];
      const hard = subArgs.includes("--hard");

      const idx = playbook.bullets.findIndex(b => b.id === bulletId);
      if (idx === -1) {
        console.error(`Bullet not found: ${bulletId}`);
        process.exit(1);
      }

      if (hard) {
        playbook.bullets.splice(idx, 1);
      } else {
        playbook.bullets[idx].deprecated = true;
        playbook.bullets[idx].updatedAt = new Date().toISOString();
      }

      savePlaybook(config.playbookPath, playbook);
      console.log(JSON.stringify({ removed: bulletId, hard }, null, 2));
      break;
    }

    case "export": {
      const playbook = loadPlaybook(config.playbookPath);
      const format = subArgs.includes("--yaml") ? "yaml" : "json";
      const output = subArgs.find(a => !a.startsWith("-"));

      const content = format === "yaml"
        ? serializePlaybookYaml(playbook)
        : JSON.stringify(playbook, null, 2);

      if (output) {
        writeFileSync(output, content);
        console.error(`Exported to: ${output}`);
      } else {
        console.log(content);
      }
      break;
    }

    case "import": {
      const inputPath = subArgs[0];
      if (!inputPath) {
        console.error("Usage: cass-reflect playbook import <path>");
        process.exit(1);
      }

      const content = readFileSync(inputPath, "utf-8");
      let imported: Playbook;
      if (content.trim().startsWith("{")) {
        try {
          imported = JSON.parse(content);
        } catch (err: any) {
          console.error(`Invalid playbook JSON: ${err?.message || err}`);
          process.exit(1);
        }
      } else {
        imported = parsePlaybookYaml(content);
      }

      savePlaybook(config.playbookPath, imported);
      console.log(JSON.stringify({
        imported: imported.bullets.length,
        path: config.playbookPath,
      }, null, 2));
      break;
    }

    case "stats": {
      const playbook = loadPlaybook(config.playbookPath);
      const active = playbook.bullets.filter(b => !b.deprecated);
      const deprecated = playbook.bullets.filter(b => b.deprecated);

      const categories = new Map<string, number>();
      for (const b of active) {
        categories.set(b.category, (categories.get(b.category) || 0) + 1);
      }

      const totalHelpful = active.reduce((sum, b) => sum + b.helpfulCount, 0);
      const totalHarmful = active.reduce((sum, b) => sum + b.harmfulCount, 0);

      console.log(JSON.stringify({
        total: playbook.bullets.length,
        active: active.length,
        deprecated: deprecated.length,
        categories: Object.fromEntries(categories),
        totalHelpful,
        totalHarmful,
        helpfulRatio: totalHelpful / (totalHelpful + totalHarmful || 1),
        metadata: playbook.metadata,
      }, null, 2));
      break;
    }

    default:
      console.error(`Unknown playbook command: ${subcommand}`);
      console.error("Commands: list, get, add, remove, export, import, stats");
      process.exit(1);
  }
}

async function cmdConfig(args: string[]): Promise<void> {
  const config = loadConfig();
  const subcommand = args[0] || "show";

  switch (subcommand) {
    case "show":
      console.log(JSON.stringify(config, null, 2));
      break;

    case "set": {
      const key = args[1];
      const value = args[2];
      
      if (!key || value === undefined) {
        console.error("Usage: cass-reflect config set <key> <value>");
        process.exit(1);
      }

      // Type-safe config updates
      if (key === "provider" && ["openai", "anthropic", "google"].includes(value)) {
        config.provider = value as Config["provider"];
      } else if (key === "model") {
        config.model = value;
      } else if (key === "cassPath") {
        config.cassPath = value;
      } else if (key === "playbookPath") {
        config.playbookPath = value;
      } else if (key === "maxReflectorIterations") {
        config.maxReflectorIterations = parseInt(value, 10);
      } else if (key === "dedupSimilarityThreshold") {
        config.dedupSimilarityThreshold = parseFloat(value);
      } else if (key === "pruneHarmfulThreshold") {
        config.pruneHarmfulThreshold = parseInt(value, 10);
      } else if (key === "maxBulletsInContext") {
        config.maxBulletsInContext = parseInt(value, 10);
      } else if (key === "sessionLookbackDays") {
        config.sessionLookbackDays = parseInt(value, 10);
      } else {
        console.error(`Unknown config key: ${key}`);
        process.exit(1);
      }

      saveConfig(config);
      console.log(JSON.stringify({ [key]: (config as any)[key] }, null, 2));
      break;
    }

    case "path":
      console.log(CONFIG_FILE);
      break;

    default:
      console.error(`Unknown config command: ${subcommand}`);
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
cass-reflect v${VERSION}
Agent-Agnostic Reflection & Memory System

USAGE:
  cass-reflect <command> [options]

COMMANDS:
  init                    Initialize configuration and playbook
  context <task>          Get relevant context for a task (playbook + history)
  diary <session-path>    Generate diary entry from a session
  reflect                 Run reflection cycle on recent sessions
  curate                  Merge delta entries into playbook (deterministic)
  mark <bullet-id>        Record bullet usage (helpful/harmful)
  audit                   Check sessions against playbook rules
  playbook <subcommand>   Manage playbook entries
  config <subcommand>     Manage configuration

CONTEXT OPTIONS:
  --workspace, -w <path>  Filter to specific workspace
  --max-bullets <n>       Maximum playbook entries to include
  --max-history <n>       Maximum history results to include
  --json                  Output as JSON

REFLECT OPTIONS:
  --days, -d <n>          Look back N days (default: 7)
  --agent, -a <name>      Filter to specific agent
  --workspace, -w <path>  Filter to specific workspace
  --max-sessions <n>      Maximum sessions to process
  --dry-run               Output deltas without applying

MARK OPTIONS:
  --helpful               Mark as helpful (default)
  --harmful               Mark as harmful
  --session, -s <path>    Associated session path

PLAYBOOK SUBCOMMANDS:
  list [--all] [category] List bullets
  get <id>                Get bullet details
  add [options] <content> Add new bullet
  remove <id> [--hard]    Remove/deprecate bullet
  export [--yaml] [path]  Export playbook
  import <path>           Import playbook
  stats                   Show playbook statistics

CONFIG SUBCOMMANDS:
  show                    Show current config
  set <key> <value>       Update config value
  path                    Show config file path

ENVIRONMENT:
  OPENAI_API_KEY          OpenAI API key
  ANTHROPIC_API_KEY       Anthropic API key  
  GOOGLE_GENERATIVE_AI_API_KEY  Google AI key

EXAMPLES:
  # Get context for current task
  cass-reflect context "Fix authentication bug in login.ts"
  
  # Run weekly reflection
  cass-reflect reflect --days 7
  
  # Mark a bullet as helpful
  cass-reflect mark b-abc123 --helpful
  
  # Add a manual bullet
  cass-reflect playbook add --category testing "Always run jest with --coverage"
`);
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  try {
    switch (command) {
      case "init":
        await cmdInit(commandArgs);
        break;
      case "context":
        await cmdContext(commandArgs);
        break;
      case "diary":
        await cmdDiary(commandArgs);
        break;
      case "reflect":
        await cmdReflect(commandArgs);
        break;
      case "curate":
        await cmdCurate(commandArgs);
        break;
      case "mark":
        await cmdMark(commandArgs);
        break;
      case "audit":
        await cmdAudit(commandArgs);
        break;
      case "playbook":
        await cmdPlaybook(commandArgs);
        break;
      case "config":
        await cmdConfig(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'cass-reflect --help' for usage");
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    if (process.env.DEBUG) {
      console.error(e.stack);
    }
    process.exit(1);
  }
}

main();
