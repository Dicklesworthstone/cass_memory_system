import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import {
  Playbook,
  PlaybookSchema,
  PlaybookBullet,
  Config,
  PlaybookBulletSchema,
  BulletMaturity
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
} from "./utils.js";
import { z } from "zod";

// --- Interfaces ---

interface ToxicEntry {
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

export async function loadPlaybook(target: Config | string): Promise<Playbook> {
  const filePath = typeof target === "string" ? target : target.playbookPath;
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
    logError(`Failed to load playbook ${expanded}: ${err.message}`);
    return createEmptyPlaybook();
  }
}

export async function savePlaybook(playbook: Playbook, target: Config | string): Promise<void> {
  const filePath = typeof target === "string" ? target : target.playbookPath;
  const expanded = expandPath(filePath);
  await ensureDir(path.dirname(expanded));
  
  // Update metadata
  playbook.metadata.lastReflection = now();
  
  const yamlStr = yaml.stringify(playbook);
  const tempPath = `${expanded}.tmp`;
  
  try {
    await fs.writeFile(tempPath, yamlStr, "utf-8");
    await fs.rename(tempPath, expanded);
  } catch (err: any) {
    logError(`Failed to save playbook to ${expanded}: ${err.message}`);
    try { await fs.unlink(tempPath); } catch {}
    throw err;
  }
}

// --- Cascading & Merging ---

async function loadToxicLog(logPath: string): Promise<ToxicEntry[]> {
  const expanded = expandPath(logPath);
  if (!(await fileExists(expanded))) return [];
  
  try {
    const content = await fs.readFile(expanded, "utf-8");
    return content
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .filter(entry => entry.id && entry.content); // Basic validation
  } catch {
    return [];
  }
}

async function isSemanticallyToxic(content: string, toxicLog: ToxicEntry[]): Promise<boolean> {
  const hash = hashContent(content);
  
  for (const entry of toxicLog) {
    // Exact match
    if (hashContent(entry.content) === hash) return true;
    
    // Semantic match (Jaccard for V1)
    if (jaccardSimilarity(content, entry.content) > 0.85) {
      log(`Blocked toxic content: "${content.slice(0, 50)}"..." matches blocked "${entry.content.slice(0, 50)}"..."`, true);
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
  
  // Add global bullets
  for (const b of global.bullets) {
    bulletMap.set(b.id, b);
  }
  
  // Add/Overwrite repo bullets
  for (const b of repo.bullets) {
    bulletMap.set(b.id, b);
  }
  
  merged.bullets = Array.from(bulletMap.values());
  
  // Merge deprecated patterns
  merged.deprecatedPatterns = [...global.deprecatedPatterns, ...repo.deprecatedPatterns];
  
  return merged;
}

export async function loadMergedPlaybook(config: Config): Promise<Playbook> {
  // 1. Load global
  const globalPlaybook = await loadPlaybook(config.playbookPath);
  
  // 2. Load repo (if exists)
  let repoPlaybook: Playbook | null = null;
  const repoPath = path.resolve(process.cwd(), ".cass", "playbook.yaml");
  if (await fileExists(repoPath)) {
    repoPlaybook = await loadPlaybook(repoPath);
  }
  
  // 3. Merge
  const merged = mergePlaybooks(globalPlaybook, repoPlaybook);
  
  // 4. Filter Toxic
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

// Helper type for partial bullet
type PartialBulletData = Partial<z.infer<typeof PlaybookBulletSchema>> & { content: string; category: string };

export function addBullet(
  playbook: Playbook, 
  data: PartialBulletData, 
  sourceSession: string
): PlaybookBullet {
  // Helper to extract agent from session path safely
  const agent = extractAgent(sourceSession); 

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
    helpfulEvents: [],
    harmfulEvents: [],
    confidenceDecayHalfLifeDays: 90,
    deprecated: false,
    pinned: false
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

// Helper since utils.ts didn't seem to have extractAgentFromPath in the write_file call I made
function extractAgent(sessionPath: string): string {
  if (sessionPath.includes(".claude")) return "claude";
  if (sessionPath.includes(".cursor")) return "cursor";
  if (sessionPath.includes(".codex")) return "codex";
  if (sessionPath.includes(".aider")) return "aider";
  return "unknown";
}