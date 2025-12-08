import fs from "node:fs/promises";
import path from "node:path";
import { expandPath } from "./utils.js";

/** Maximum age in milliseconds for a lock file before it's considered stale */
const STALE_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

/**
 * Global set of currently held lock paths.
 * Used for cleanup during graceful shutdown.
 */
const activeLocks = new Set<string>();

/**
 * Get a copy of currently active lock paths.
 * Useful for debugging and shutdown cleanup.
 */
export function getActiveLocks(): string[] {
  return [...activeLocks];
}

/**
 * Release all currently held locks.
 * Called during graceful shutdown to prevent orphaned locks.
 * @returns Number of locks released
 */
export async function releaseAllLocks(): Promise<number> {
  let released = 0;
  for (const lockPath of activeLocks) {
    try {
      await fs.rm(lockPath, { recursive: true, force: true });
      released++;
    } catch {
      // Best effort - continue with other locks
    }
  }
  activeLocks.clear();
  return released;
}

/**
 * Check if a lock dir is stale (older than threshold).
 */
async function isLockStale(lockPath: string, thresholdMs = STALE_LOCK_THRESHOLD_MS): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > thresholdMs;
  } catch {
    return false;
  }
}

/**
 * Try to clean up a stale lock dir.
 */
async function tryRemoveStaleLock(lockPath: string, thresholdMs = STALE_LOCK_THRESHOLD_MS): Promise<boolean> {
  try {
    if (await isLockStale(lockPath, thresholdMs)) {
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
  const staleThreshold = options.staleLockThresholdMs ?? STALE_LOCK_THRESHOLD_MS;
  // Use .lock.d to clearly indicate directory
  const lockPath = `${expandPath(targetPath)}.lock.d`;
  const pid = process.pid.toString();

  for (let i = 0; i < maxRetries; i++) {
    try {
      // mkdir is atomic
      await fs.mkdir(lockPath);

      // Track this lock for graceful shutdown cleanup
      activeLocks.add(lockPath);

      // Write metadata inside (best effort, doesn't affect lock validity)
      try {
        await fs.writeFile(`${lockPath}/pid`, pid);
      } catch {}

      // Start heartbeat to keep lock fresh during long operations
      const heartbeat = setInterval(async () => {
        try {
          const now = new Date();
          await fs.utimes(lockPath, now, now);
        } catch {
          // Best effort
        }
      }, 10000); // 10 seconds < 30s threshold
      if (typeof (heartbeat as any).unref === "function") {
        (heartbeat as any).unref();
      }

      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
        // Remove from tracking before releasing
        activeLocks.delete(lockPath);
        try {
          await fs.rm(lockPath, { recursive: true, force: true });
        } catch {}
      }
    } catch (err: any) {
      if (err.code === "EEXIST") {
        if (await tryRemoveStaleLock(lockPath, staleThreshold)) {
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      if (err.code === "ENOENT") {
        // Parent path missing; create with platform-safe dirname
        const dir = path.dirname(lockPath);
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not acquire lock for ${targetPath} after ${maxRetries} retries.`);
}
