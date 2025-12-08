import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ProcessedEntry } from "./types.js";
import { ensureDir, fileExists, expandPath } from "./utils.js";

// -----------------------------------------------------------------------------
// Processed log paths
// -----------------------------------------------------------------------------

const REFLECTIONS_DIR = path.join(os.homedir(), ".cass-memory", "reflections");

export function getProcessedLogPath(workspacePath?: string): string {
  if (!workspacePath) {
    return path.join(REFLECTIONS_DIR, "global.processed.log");
  }

  const resolved = path.resolve(expandPath(workspacePath));
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return path.join(REFLECTIONS_DIR, `ws-${hash}.processed.log`);
}

export class ProcessedLog {
  private entries: Map<string, ProcessedEntry> = new Map();
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  async load(): Promise<void> {
    if (!(await fileExists(this.logPath))) return;

    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      // Resilience: Skip empty lines, comments, and malformed lines without crashing
      const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));
      
      for (const line of lines) {
        try {
          const parts = line.split("\t");
          // Basic validation: must have at least sessionPath (index 1)
          if (parts.length < 2) continue;

          const [id, sessionPath, processedAt, deltasProposed] = parts;
          if (sessionPath) {
            this.entries.set(sessionPath, {
              sessionPath,
              processedAt: processedAt || new Date().toISOString(),
              diaryId: id === "-" ? undefined : id,
              deltasGenerated: parseInt(deltasProposed || "0", 10)
            });
          }
        } catch {
          // Ignore individual malformed lines to prevent total failure
          continue;
        }
      }
    } catch (error) {
      console.error(`Failed to load processed log: ${error}`);
      // Don't rethrow - treat as empty log to fail open (safe in this context, means re-processing)
    }
  }

  async save(): Promise<void> {
    await ensureDir(path.dirname(this.logPath));
    
    const header = "# id\tsessionPath\tprocessedAt\tdeltasProposed\tdeltasApplied";
    const lines = [header];
    
    for (const entry of this.entries.values()) {
      lines.push(`${entry.diaryId || "-"}\t${entry.sessionPath}\t${entry.processedAt}\t${entry.deltasGenerated}\t0`);
    }
    
    // Use atomic write pattern manually here since tracking logic is self-contained
    const tempPath = `${this.logPath}.tmp`;
    try {
        await fs.writeFile(tempPath, lines.join("\n"), "utf-8");
        await fs.rename(tempPath, this.logPath);
    } catch (error) {
        try { await fs.unlink(tempPath); } catch {}
        throw error;
    }
  }

  has(sessionPath: string): boolean {
    return this.entries.has(sessionPath);
  }

  add(entry: ProcessedEntry): void {
    this.entries.set(entry.sessionPath, entry);
  }

  getProcessedPaths(): Set<string> {
    return new Set(this.entries.keys());
  }
}
