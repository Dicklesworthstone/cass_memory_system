import fs from "node:fs/promises";
import { expandPath } from "./utils.js";

/** Maximum age in milliseconds for a lock file before it's considered stale */
const STALE_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

/**
 * Check if a lock dir is stale (older than threshold).
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > STALE_LOCK_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * Try to clean up a stale lock dir.
 */
async function tryRemoveStaleLock(lockPath: string): Promise<boolean> {
  try {
    if (await isLockStale(lockPath)) {
      await fs.rm(lockPath, { recursive: true, force: true });
      console.warn(`[lock] Removed stale lock: ${lockPath}`);
      return true;
    }
  } catch {
    // Failed to remove
  }
  return false;
}

/**
 * Robust file lock mechanism using atomic mkdir.
 * Uses a .lock directory next to the target file.
 */
export async function withLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: { retries?: number; delay?: number; staleLockThresholdMs?: number } = {}
): Promise<T> {
  const maxRetries = options.retries ?? 20;
  const retryDelay = options.delay ?? 100;
  // Use .lock.d to clearly indicate directory
  const lockPath = `${expandPath(targetPath)}.lock.d`;
  const pid = process.pid.toString();

  for (let i = 0; i < maxRetries; i++) {
    try {
      // mkdir is atomic
      await fs.mkdir(lockPath);
      
      // Write metadata inside (best effort, doesn't affect lock validity)
      try {
        await fs.writeFile(`${lockPath}/pid`, pid);
      } catch {}

      try {
        return await operation();
      } finally {
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
        } catch {}
      }
    } catch (err: any) {
      if (err.code === "EEXIST") {
        if (await tryRemoveStaleLock(lockPath)) {
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      if (err.code === "ENOENT") {
        const dir = lockPath.substring(0, lockPath.lastIndexOf("/"));
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not acquire lock for ${targetPath} after ${maxRetries} retries.`);
}
