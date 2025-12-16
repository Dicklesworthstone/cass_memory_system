import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import {
  Playbook,
  PlaybookSchema,
  PlaybookBullet,
  Config,
  PlaybookBulletSchema,
  BulletMaturity,
  NewBulletData,
  PlaybookStats
} from "./types.js";
import {
  expandPath,
  ensureDir,
  fileExists,
  generateBulletId,
  now,
  log,
  warn,
  error as logError,
  hashContent,
  jaccardSimilarity,
  atomicWrite,
  extractAgentFromPath,
  resolveRepoDir,
  tokenize
} from "./utils.js";
import { z } from "zod";
import { getEffectiveScore, isStale } from "./scoring.js";
import { formatMaturityIcon } from "./output.js";

// --- Interfaces ---

export interface BlockedEntry {
  id: string;
  content: string;
  reason: string;
  forgottenAt: string;
}

/** @deprecated Use BlockedEntry instead */
export type ToxicEntry = BlockedEntry;

// --- Core Functions ---

export function createEmptyPlaybook(name = "playbook"): Playbook {
  return {
    schema_version: 2,
    name,
    description: "Auto-generated from cass-memory reflections",
    metadata: {
      createdAt: now(),
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    deprecatedPatterns: [],
    bullets: [],
  };
}

export async function loadPlaybook(filePath: string): Promise<Playbook> {
  const expanded = expandPath(filePath);
  
  if (!(await fileExists(expanded))) {
    log(`Playbook not found at ${expanded}, creating empty one.`, true);
    return createEmptyPlaybook();
  }

  try {
    const content = await fs.readFile(expanded, "utf-8");
    if (!content.trim()) return createEmptyPlaybook();
    
    const raw = yaml.parse(content);
    const result = PlaybookSchema.safeParse(raw);
    
    if (!result.success) {
      logError(`Playbook validation failed for ${expanded}: ${result.error.message}`);
      throw new Error(`Playbook at ${expanded} is invalid. Please fix it manually or remove it to reset.`);
    }
    
    return result.data;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return createEmptyPlaybook();
    }
    // Propagate validation errors so the process stops rather than overwriting data
    throw err;
  }
}

export async function savePlaybook(
  playbook: Playbook, 
  filePath: string, 
  options: { updateLastReflection?: boolean } = {}
): Promise<void> {
  if (options.updateLastReflection) {
    playbook.metadata.lastReflection = now();
  }
  const yamlStr = yaml.stringify(playbook);
  await atomicWrite(filePath, yamlStr);
}

// --- Error Recovery ---

export interface PlaybookRecoveryResult {
  playbook: Playbook;
  backupPath: string | null;
  errorType: "parse_error" | "validation_error" | "truncation" | "unknown";
  originalError: Error;
}

/**
 * Recover from a corrupt or malformed playbook file.
 *
 * Prioritizes data safety:
 * 1. Backs up the corrupt file to {path}.backup.{timestamp}
 * 2. Logs the corruption details
 * 3. Creates a fresh empty playbook
 * 4. Returns recovery result with backup location
 *
 * @param playbookPath - Path to the corrupt playbook file
 * @param error - The error that was thrown during loading
 * @returns Recovery result with new playbook and backup info
 */
export async function recoverCorruptPlaybook(
  playbookPath: string,
  error: Error
): Promise<PlaybookRecoveryResult> {
  const expanded = expandPath(playbookPath);
  let backupPath: string | null = null;

  // Determine error type for better diagnostics
  let errorType: PlaybookRecoveryResult["errorType"] = "unknown";
  if (error.message.includes("YAML") || error.message.includes("parse") || error.message.includes("Unexpected")) {
    errorType = "parse_error";
  } else if (error.message.includes("validation") || error.message.includes("invalid") || error.name === "ZodError") {
    errorType = "validation_error";
  } else if (error.message.includes("truncat") || error.message.includes("incomplete")) {
    errorType = "truncation";
  }

  // Step 1: Backup the corrupt file (never lose user data)
  try {
    if (await fileExists(expanded)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${expanded}.backup.${timestamp}`;
      await fs.copyFile(expanded, backupPath);
      log(`Backed up corrupt playbook to: ${backupPath}`, true);
    }
  } catch (backupErr: any) {
    warn(`Failed to backup corrupt playbook: ${backupErr.message}`);
    // Continue with recovery even if backup fails
  }

  // Step 2: Log the corruption details
  logError(`Playbook recovery triggered for ${expanded}`);
  logError(`Error type: ${errorType}`);
  logError(`Original error: ${error.message}`);

  if (backupPath) {
    log(`Your original data was saved to: ${backupPath}`, true);
    log(`You can attempt manual recovery by examining the backup file.`, true);
  }

  // Step 3: Create fresh empty playbook
  const newPlaybook = createEmptyPlaybook(path.basename(expanded, path.extname(expanded)));

  // Step 4: Log recovery instructions
  log(`Created new empty playbook. Previous rules need manual recovery from backup.`, true);
  log(`To recover manually:`, true);
  log(`  1. Open ${backupPath || "the backup file"}`, true);
  log(`  2. Fix any syntax errors`, true);
  log(`  3. Copy valid bullets to the new playbook`, true);

  return {
    playbook: newPlaybook,
    backupPath,
    errorType,
    originalError: error
  };
}

/**
 * Load playbook with automatic recovery on corruption.
 *
 * Use this when you want graceful degradation instead of hard failure.
 * Returns both the playbook and recovery info if recovery was needed.
 */
export async function loadPlaybookWithRecovery(
  filePath: string
): Promise<{ playbook: Playbook; recovered: boolean; recovery?: PlaybookRecoveryResult }> {
  try {
    const playbook = await loadPlaybook(filePath);
    return { playbook, recovered: false };
  } catch (err: any) {
    // Don't recover from ENOENT - that's handled by loadPlaybook
    if (err.code === "ENOENT") {
      throw err;
    }

    const recovery = await recoverCorruptPlaybook(filePath, err);
    return {
      playbook: recovery.playbook,
      recovered: true,
      recovery
    };
  }
}

// --- Cascading & Merging ---

export async function loadBlockedLog(logPath: string): Promise<ToxicEntry[]> {
  const expanded = expandPath(logPath);
  if (!(await fileExists(expanded))) {
    return [];
  }

  try {
    const content = await fs.readFile(expanded, "utf-8");
    const entries: ToxicEntry[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed);
        // Validate required fields
        if (entry.id && entry.content) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines - don't let one bad line corrupt the whole log
        warn(`Skipping malformed line in blocked log: ${trimmed.slice(0, 50)}...`);
      }
    }
    return entries;
  } catch (err: any) {
    warn(`Failed to read blocked log ${expanded}: ${err.message}`);
    return [];
  }
}

/** @deprecated Use loadBlockedLog instead */
export const loadToxicLog = loadBlockedLog;

export async function appendBlockedLog(entry: BlockedEntry, logPath: string): Promise<void> {
  const expanded = expandPath(logPath);
  await ensureDir(path.dirname(expanded));
  await fs.appendFile(expanded, JSON.stringify(entry) + "\n", "utf-8");
}

/** @deprecated Use appendBlockedLog instead */
export const appendToxicLog = appendBlockedLog;

/**
 * Remove an entry from the blocked log by bullet ID.
 * This is needed when un-deprecating a bullet that was forgotten.
 */
export async function removeFromBlockedLog(bulletId: string, logPath: string): Promise<boolean> {
  const expanded = expandPath(logPath);
  if (!(await fileExists(expanded))) {
    return false;
  }

  try {
    const content = await fs.readFile(expanded, "utf-8");
    const lines = content.split("\n");
    const filteredLines: string[] = [];
    let found = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed);
        if (entry.id === bulletId) {
          found = true;
          continue; // Skip this entry
        }
        filteredLines.push(trimmed);
      } catch {
        // Keep malformed lines to not lose data
        filteredLines.push(trimmed);
      }
    }

    if (found) {
      // Write back the filtered entries
      const newContent = filteredLines.length > 0 ? filteredLines.join("\n") + "\n" : "";
      await atomicWrite(expanded, newContent);
    }

    return found;
  } catch (err: any) {
    warn(`Failed to remove from blocked log ${expanded}: ${err.message}`);
    return false;
  }
}

export function mergePlaybooks(global: Playbook, repo: Playbook | null): Playbook {
  if (!repo) return global;
  
  const merged = createEmptyPlaybook("merged-playbook");
  merged.metadata = { ...global.metadata }; 
  
  const bulletMap = new Map<string, PlaybookBullet>();
  
  for (const b of global.bullets) {
    bulletMap.set(b.id, b);
  }
  
  for (const b of repo.bullets) {
    bulletMap.set(b.id, b);
  }
  
  merged.bullets = Array.from(bulletMap.values());
  
  // Deduplicate deprecated patterns
  const seenPatterns = new Set<string>();
  const uniqueDeprecatedPatterns: Array<z.infer<typeof import("./types.js").DeprecatedPatternSchema>> = [];
  
  for (const p of [...global.deprecatedPatterns, ...repo.deprecatedPatterns]) {
    if (!seenPatterns.has(p.pattern)) {
      seenPatterns.add(p.pattern);
      uniqueDeprecatedPatterns.push(p);
    }
  }
  
  merged.deprecatedPatterns = uniqueDeprecatedPatterns;
  
  return merged;
}

export async function loadMergedPlaybook(config: Config): Promise<Playbook> {
  const globalPlaybook = await loadPlaybook(config.playbookPath);
  
  let repoPlaybook: Playbook | null = null;
  
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  
  if (repoPath && await fileExists(repoPath)) {
    repoPlaybook = await loadPlaybook(repoPath);
  }
  
  const merged = mergePlaybooks(globalPlaybook, repoPlaybook);
  
  const globalBlocked = await loadBlockedLog("~/.cass-memory/blocked.log");
  const globalToxic = await loadBlockedLog("~/.cass-memory/toxic_bullets.log");
  
  const repoBlockedPath = repoDir ? path.join(repoDir, "blocked.log") : null;
  const repoBlocked = repoBlockedPath ? await loadBlockedLog(repoBlockedPath) : [];

  const repoToxicPath = repoDir ? path.join(repoDir, "toxic.log") : null;
  const repoToxic = repoToxicPath ? await loadBlockedLog(repoToxicPath) : [];
  
  const allBlocked = [...globalBlocked, ...globalToxic, ...repoBlocked, ...repoToxic];

  if (allBlocked.length > 0) {
    // Optimization: Deduplicate blocked entries by content hash
    const uniqueBlocked = new Map<string, BlockedEntry>();
    for (const entry of allBlocked) {
      uniqueBlocked.set(hashContent(entry.content), entry);
    }
    const deduplicatedBlocked = Array.from(uniqueBlocked.values());

    // Optimization: Pre-compute hashes and tokens for blocked entries
    const blockedMeta = deduplicatedBlocked.map(entry => ({
      entry,
      hash: hashContent(entry.content),
      tokens: new Set(tokenize(entry.content))
    }));

    for (const b of merged.bullets) {
      if (b.deprecated) continue;
      
      const bHash = hashContent(b.content);
      const bTokens = tokenize(b.content);
      const bTokenSet = new Set(bTokens);

      let isBlocked = false;

      for (const meta of blockedMeta) {
        // 1. Exact Match
        if (meta.hash === bHash) {
          isBlocked = true;
          break;
        }

        // 2. Semantic Match (Jaccard)
        if (bTokens.length === 0 || meta.tokens.size === 0) continue;

        const maxPossibleIntersection = Math.min(bTokenSet.size, meta.tokens.size);
        const minPossibleUnion = Math.max(bTokenSet.size, meta.tokens.size);
        
        // Fast skip
        if (maxPossibleIntersection / minPossibleUnion <= 0.85) continue;

        const intersectionSize = [...bTokenSet].filter(x => meta.tokens.has(x)).length;
        const unionSize = new Set([...bTokenSet, ...meta.tokens]).size;

        if (unionSize > 0 && (intersectionSize / unionSize) > 0.85) {
          log(`Blocked content: "${b.content.slice(0, 50)}"... matches blocked "${meta.entry.content.slice(0, 50)}"...`, true);
          isBlocked = true;
          break;
        }
      }

      if (isBlocked) {
        // Keep state fields consistent with other deprecations
        deprecateBullet(merged, b.id, "BLOCKED_CONTENT");
      }
    }
  }
  
  return merged;
}

// --- Bullet Management ---

export function findBullet(playbook: Playbook, id: string): PlaybookBullet | undefined {
  return playbook.bullets.find(b => b.id === id);
}

type PartialBulletData = Partial<z.infer<typeof PlaybookBulletSchema>> & { content: string; category: string };

export function addBullet(
  playbook: Playbook, 
  data: PartialBulletData, 
  sourceSession: string,
  defaultDecayHalfLifeDays: number = 90
): PlaybookBullet {
  const agent = extractAgentFromPath(sourceSession); 
  const requestedId =
    typeof data.id === "string" && data.id.trim() !== "" ? data.id.trim() : undefined;
  if (requestedId && playbook.bullets.some((b) => b.id === requestedId)) {
    throw new Error(`Bullet id already exists: ${requestedId}`);
  }

  const newBullet: PlaybookBullet = {
    id: requestedId ?? generateBulletId(),
    content: data.content,
    category: data.category,
    kind: data.kind || "workflow_rule",
    type: data.type || "rule",
    isNegative: data.isNegative || false,
    scope: data.scope || "global",
    workspace: data.workspace,
    source: data.source || "learned",
    tags: data.tags || [],
    searchPointer: data.searchPointer,
    state: "draft",
    maturity: "candidate",
    createdAt: now(),
    updatedAt: now(),
    sourceSessions: [sourceSession],
    sourceAgents: [agent],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    deprecatedAt: undefined,
    confidenceDecayHalfLifeDays: defaultDecayHalfLifeDays
  };
  
  playbook.bullets.push(newBullet);
  return newBullet;
}

export function deprecateBullet(
  playbook: Playbook,
  id: string,
  reason: string,
  replacedBy?: string
): boolean {
  const bullet = findBullet(playbook, id);
  if (!bullet) return false;
  
  bullet.deprecated = true;
  bullet.deprecatedAt = now();
  bullet.deprecationReason = reason;
  bullet.replacedBy = replacedBy;
  bullet.state = "retired";
  bullet.maturity = "deprecated";
  bullet.updatedAt = now();
  
  return true;
}

export function getActiveBullets(playbook: Playbook): PlaybookBullet[] {
  return playbook.bullets.filter(b => 
    b.state !== "retired" && 
    b.maturity !== "deprecated" && 
    !b.deprecated
  );
}

export function getBulletsByCategory(
  playbook: Playbook, 
  category: string
): PlaybookBullet[] {
  const active = getActiveBullets(playbook);
  return active.filter(b => b.category.toLowerCase() === category.toLowerCase());
}

export function exportToMarkdown(
  playbook: Playbook,
  options: { topN?: number; showCounts?: boolean; includeAntiPatterns?: boolean } = {}
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter(b => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter(b => b.type === "anti-pattern" || b.kind === "anti_pattern");

  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of rules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `## Agent Playbook (auto-generated)\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `### ${cat}\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      const count = options.showCounts ? ` (${b.helpfulCount ?? 0}+ / ${b.harmfulCount ?? 0}-)` : "";
      md += `- ${b.content}${count}\n`;
    }
    md += "\n";
  }

  if (options.includeAntiPatterns && antiPatterns.length > 0) {
    md += `### PITFALLS (Anti-Patterns)\n`;
    const slice = options.topN ? antiPatterns.slice(0, Math.ceil(options.topN / 2)) : antiPatterns;
    for (const b of slice) {
      const count = options.showCounts ? ` (${b.helpfulCount ?? 0}+ / ${b.harmfulCount ?? 0}-)` : "";
      md += `- ${b.content}${count}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Export playbook in AGENTS.md format.
 * Structured format with maturity badges and effectiveness metrics.
 */
export function exportToAgentsMd(
  playbook: Playbook,
  config: Config,
  options: { topN?: number; showCounts?: boolean } = {}
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter(b => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter(b => b.type === "anti-pattern" || b.kind === "anti_pattern");

  // Sort by effective score (highest first)
  const sortedRules = [...rules].sort((a, b) =>
    getEffectiveScore(b, config) - getEffectiveScore(a, config)
  );
  const sortedAntiPatterns = [...antiPatterns].sort((a, b) =>
    getEffectiveScore(b, config) - getEffectiveScore(a, config)
  );

  // Group by category
  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of sortedRules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `# AGENTS.md\n\n`;
  md += `> Auto-generated playbook for AI coding assistants.\n`;
  md += `> Last updated: ${new Date().toISOString().split("T")[0]}\n\n`;

  // Stats summary
  const stats = computeFullStats(playbook, config);
  md += `## Summary\n\n`;
  md += `- **Total rules**: ${stats.total}\n`;
  md += `- **Proven**: ${stats.byMaturity.proven} | **Established**: ${stats.byMaturity.established} | **Candidate**: ${stats.byMaturity.candidate}\n`;
  md += `- **Score distribution**: ${stats.scoreDistribution.excellent} excellent, ${stats.scoreDistribution.good} good, ${stats.scoreDistribution.neutral} neutral, ${stats.scoreDistribution.atRisk} at-risk\n\n`;

  md += `## Rules\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `### ${cat}\n\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      const icon = formatMaturityIcon(b.maturity);
      const iconPrefix = icon ? `${icon} ` : "";
      const score = getEffectiveScore(b, config).toFixed(1);
      const counts = options.showCounts ? ` [${b.helpfulCount ?? 0}+/${b.harmfulCount ?? 0}-]` : "";
      md += `- ${iconPrefix}${b.content}${counts} _(score: ${score})_\n`;
    }
    md += "\n";
  }

  if (sortedAntiPatterns.length > 0) {
    md += `## Anti-Patterns (AVOID)\n\n`;
    const slice = options.topN ? sortedAntiPatterns.slice(0, options.topN) : sortedAntiPatterns;
    for (const b of slice) {
      const counts = options.showCounts ? ` [${b.helpfulCount ?? 0}+/${b.harmfulCount ?? 0}-]` : "";
      md += `- ⛔ ${b.content}${counts}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Export playbook in Claude-specific format.
 * Includes context sections and Claude-optimized instructions.
 */
export function exportToClaudeMd(
  playbook: Playbook,
  config: Config,
  options: { topN?: number; showCounts?: boolean } = {}
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter(b => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter(b => b.type === "anti-pattern" || b.kind === "anti_pattern");

  // Sort by effective score (highest first)
  const sortedRules = [...rules].sort((a, b) =>
    getEffectiveScore(b, config) - getEffectiveScore(a, config)
  );

  // Group by category
  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of sortedRules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `<project_rules>\n`;
  md += `<!-- Auto-generated rules from cass-memory playbook -->\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `## ${cat}\n\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      md += `- ${b.content}\n`;
    }
    md += "\n";
  }

  if (antiPatterns.length > 0) {
    md += `## IMPORTANT: Avoid These Patterns\n\n`;
    const slice = options.topN ? antiPatterns.slice(0, options.topN) : antiPatterns;
    for (const b of slice) {
      md += `- DO NOT: ${b.content}\n`;
    }
    md += "\n";
  }

  md += `</project_rules>\n`;

  return md;
}

export function computeFullStats(playbook: Playbook, config: Config): PlaybookStats {
  const active = getActiveBullets(playbook);
  
  const stats: PlaybookStats = {
    total: active.length,
    byScope: { global: 0, workspace: 0 },
    byMaturity: { candidate: 0, established: 0, proven: 0, deprecated: 0 },
    byType: { rule: 0, antiPattern: 0 },
    scoreDistribution: { excellent: 0, good: 0, neutral: 0, atRisk: 0 }
  };
  
  for (const b of active) {
    if (b.scope === "workspace") stats.byScope.workspace++;
    else stats.byScope.global++;
    
    stats.byMaturity[b.maturity]++;
    if (b.type === "anti-pattern") stats.byType.antiPattern++;
    else stats.byType.rule++;
    
    const score = getEffectiveScore(b, config);
    // Thresholds aligned with scoring.ts analyzeScoreDistribution
    if (score >= 10) stats.scoreDistribution.excellent++;
    else if (score >= 5) stats.scoreDistribution.good++;
    else if (score >= 0) stats.scoreDistribution.neutral++;
    else stats.scoreDistribution.atRisk++;
  }
  
  return stats;
}
