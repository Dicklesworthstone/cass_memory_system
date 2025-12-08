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
  extractAgentFromPath
} from "./utils.js";
import { z } from "zod";
import { getEffectiveScore, isStale } from "./scoring.js";

// --- Interfaces ---

export interface ToxicEntry {
  id: string;
  content: string;
  reason: string;
  forgottenAt: string;
}

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
      warn(`Playbook validation failed for ${expanded}: ${result.error.message}`);
      const backupPath = `${expanded}.backup.${Date.now()}`;
      await fs.rename(expanded, backupPath);
      warn(`Backed up corrupt playbook to ${backupPath} and creating new one.`);
      return createEmptyPlaybook();
    }
    
    return result.data;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return createEmptyPlaybook();
    }
    logError(`Failed to load playbook ${expanded}: ${err.message}`);
    throw err;
  }
}

export async function savePlaybook(playbook: Playbook, filePath: string): Promise<void> {
  playbook.metadata.lastReflection = now();
  const yamlStr = yaml.stringify(playbook);
  await atomicWrite(filePath, yamlStr);
}

// --- Cascading & Merging ---

export async function loadToxicLog(logPath: string): Promise<ToxicEntry[]> {
  const expanded = expandPath(logPath);
  if (!(await fileExists(expanded))) return [];

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
        warn(`Skipping malformed line in toxic log: ${trimmed.slice(0, 50)}...`);
      }
    }

    return entries;
  } catch (err: any) {
    warn(`Failed to read toxic log ${expanded}: ${err.message}`);
    return [];
  }
}

export async function appendToxicLog(entry: ToxicEntry, logPath: string): Promise<void> {
  const expanded = expandPath(logPath);
  await ensureDir(path.dirname(expanded));
  await fs.appendFile(expanded, JSON.stringify(entry) + "\n", "utf-8");
}

async function isSemanticallyToxic(content: string, toxicLog: ToxicEntry[]): Promise<boolean> {
  const hash = hashContent(content);
  
  for (const entry of toxicLog) {
    if (hashContent(entry.content) === hash) return true;
    if (jaccardSimilarity(content, entry.content) > 0.85) {
      log(`Blocked toxic content: "${content.slice(0, 50)}"... matches blocked "${entry.content.slice(0, 50)}"...`, true);
      return true;
    }
  }
  return false;
}

function mergePlaybooks(global: Playbook, repo: Playbook | null): Playbook {
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
  merged.deprecatedPatterns = [...global.deprecatedPatterns, ...repo.deprecatedPatterns];
  
  return merged;
}

export async function loadMergedPlaybook(config: Config): Promise<Playbook> {
  const globalPlaybook = await loadPlaybook(config.playbookPath);
  
  let repoPlaybook: Playbook | null = null;
  const repoPath = path.resolve(process.cwd(), ".cass", "playbook.yaml");
  
  if (await fileExists(repoPath)) {
    repoPlaybook = await loadPlaybook(repoPath);
  }
  
  const merged = mergePlaybooks(globalPlaybook, repoPlaybook);
  
  const globalToxic = await loadToxicLog("~/.cass-memory/toxic_bullets.log");
  const repoToxic = await loadToxicLog(path.resolve(process.cwd(), ".cass", "toxic.log"));
  const allToxic = [...globalToxic, ...repoToxic];
  
  if (allToxic.length > 0) {
    const cleanBullets: PlaybookBullet[] = [];
    for (const b of merged.bullets) {
      if (!(await isSemanticallyToxic(b.content, allToxic))) {
        cleanBullets.push(b);
      }
    }
    merged.bullets = cleanBullets;
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

  const newBullet: PlaybookBullet = {
    id: generateBulletId(),
    content: data.content,
    category: data.category,
    kind: data.kind || "workflow_rule",
    type: data.type || "rule",
    isNegative: data.isNegative || false,
    scope: data.scope || "global",
    workspace: data.workspace,
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
    if (score > 10) stats.scoreDistribution.excellent++;
    else if (score > 5) stats.scoreDistribution.good++;
    else if (score >= 0) stats.scoreDistribution.neutral++;
    else stats.scoreDistribution.atRisk++;
  }
  
  return stats;
}
