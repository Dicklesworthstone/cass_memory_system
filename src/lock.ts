import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./utils.js";

const LOCK_STALE_MS = 30000; // 30 seconds
const LOCK_RETRY_MS = 500;
const LOCK_MAX_RETRIES = 20; // 10 seconds max wait

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

export class FileLock {
  private lockPath: string;
  private hasLock: boolean = false;

  constructor(targetPath: string) {
    this.lockPath = `${targetPath}.lock`;
  }

  async acquire(operation: string = "unknown"): Promise<boolean> {
    let attempts = 0;
    
    while (attempts < LOCK_MAX_RETRIES) {
      try {
        // Try to create lock directory/file atomically
        // Using mkdir as lock mechanism is atomic on POSIX and Windows
        // but for file locking we usually use open with 'wx' flags.
        // 'wx' fails if path exists.
        
        const info: LockInfo = {
          pid: process.pid,
          timestamp: Date.now(),
          operation
        };

        await fs.writeFile(this.lockPath, JSON.stringify(info), { flag: "wx" });
        this.hasLock = true;
        return true;

      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Lock exists, check staleness
          const isStale = await this.checkStale();
          if (isStale) {
            await this.forceRelease();
            continue; // Retry immediately
          }
          
          // Wait and retry
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
          attempts++;
        } else {
          throw err;
        }
      }
    }
    
    throw new Error(`Could not acquire lock on ${this.lockPath} after ${attempts} attempts`);
  }

  async release(): Promise<void> {
    if (!this.hasLock) return;
    
    try {
      await fs.unlink(this.lockPath);
      this.hasLock = false;
    } catch (err: any) {
      // Ignore if already gone
      if (err.code !== "ENOENT") throw err;
    }
  }

  private async checkStale(): Promise<boolean> {
    try {
      const content = await fs.readFile(this.lockPath, "utf-8");
      const info = JSON.parse(content) as LockInfo;
      const age = Date.now() - info.timestamp;
      
      if (age > LOCK_STALE_MS) return true;
      
      // Check if process exists
      try {
        process.kill(info.pid, 0); // Signal 0 just checks existence
        return false; // Process exists
      } catch {
        return true; // Process doesn't exist
      }
    } catch {
      return true; // Corrupt lock file
    }
  }

  private async forceRelease(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
    } catch {}
  }
}

// Helper wrapper
export async function withLock<T>(
  targetPath: string, 
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  const lock = new FileLock(targetPath);
  await lock.acquire(operation);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
