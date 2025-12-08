import fs from "node:fs/promises";
import path from "node:path";
import { ProcessedEntry, ProcessedEntrySchema } from "./types.js";
import { ensureDir, fileExists } from "./utils.js";

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
      const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));
      
      for (const line of lines) {
        const [id, sessionPath, processedAt, deltasProposed, deltasApplied] = line.split("\t");
        if (sessionPath) {
          this.entries.set(sessionPath, {
            sessionPath,
            processedAt,
            diaryId: id,
            deltasGenerated: parseInt(deltasProposed || "0")
          });
        }
      }
    } catch (error) {
      console.error(`Failed to load processed log: ${error}`);
    }
  }

  async save(): Promise<void> {
    await ensureDir(path.dirname(this.logPath));
    
    const header = "# id\tsessionPath\tprocessedAt\tdeltasProposed\tdeltasApplied";
    const lines = [header];
    
    for (const entry of this.entries.values()) {
      lines.push(`${entry.diaryId || "-"}\t${entry.sessionPath}\t${entry.processedAt}\t${entry.deltasGenerated}\t0`);
    }
    
    await fs.writeFile(this.logPath, lines.join("\n"), "utf-8");
  }

  has(sessionPath: string): boolean {
    return this.entries.has(sessionPath);
  }

  add(entry: ProcessedEntry): void {
    this.entries.set(entry.sessionPath, entry);
  }
}
