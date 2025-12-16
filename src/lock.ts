import fs from "node:fs/promises";
import path from "node:path";
import { expandPath, warn } from "./utils.js";

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
      warn(`[lock] Removed stale lock: ${lockPath}`);
      return true;
    }
  } catch {
    // Failed to remove
  }
  return false;
}

function pidIsRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the PID exists but we don't have permission to signal it.
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Try to clean up an abandoned lock dir using its pid file.
 * This is important when a process exits abruptly (e.g. process.exit inside a locked operation),
 * leaving a fresh-but-orphaned lock that would otherwise block for the stale threshold duration.
 */
async function tryRemoveAbandonedLock(lockPath: string): Promise<boolean> {
  try {
    const pidRaw = await fs.readFile(`${lockPath}/pid`, "utf-8");
    const pid = Number.parseInt(pidRaw.trim(), 10);
    if (pidIsRunning(pid)) return false;

    await fs.rm(lockPath, { recursive: true, force: true });
    warn(`[lock] Removed abandoned lock (dead PID ${pid}): ${lockPath}`);
    return true;
  } catch {
    return false;
  }
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
  const expandedTargetPath = typeof targetPath === "string" ? expandPath(targetPath) : "";
  if (!expandedTargetPath) {
    throw new Error("withLock targetPath must be a non-empty path");
  }
  // Use .lock.d to clearly indicate directory
  const lockPath = `${expandedTargetPath}.lock.d`;
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
        
        // Safety check: Verify we still own the lock before deleting
        // This prevents deleting a lock that was stolen by another process (due to staleness)
        let safeToDelete = false;
        try {
          const content = await fs.readFile(`${lockPath}/pid`, "utf-8");
          if (content.trim() === pid) {
            safeToDelete = true;
          } else {
            warn(`[lock] Lock stolen by PID ${content.trim()}, not deleting: ${lockPath}`);
          }
        } catch {
          // If we can't read the PID file (ENOENT), it implies the lock structure is gone or corrupted.
          // It's unsafe to delete the directory as it might be a fresh lock from another process 
          // (extremely narrow race: mkdir -> context switch -> us -> rm).
          // We default to NOT deleting (safeToDelete = false).
          // If we leave a zombie directory, the stale lock cleaner will handle it later.
        }

        if (safeToDelete) {
          try {
            await fs.rm(lockPath, { recursive: true, force: true });
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.code === "EEXIST") {
        if (await tryRemoveAbandonedLock(lockPath)) {
          continue;
        }
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
