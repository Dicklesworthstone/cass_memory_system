import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandPath, warn } from "./utils.js";

/** Maximum age in milliseconds for a lock file before it's considered stale */
const STALE_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

/**
 * Global set of currently held lock paths.
 * Used for cleanup during graceful shutdown.
 */
const activeLocks = new Map<string, { owner: string; pid: string }>();

/**
 * Get a copy of currently active lock paths.
 * Useful for debugging and shutdown cleanup.
 */
export function getActiveLocks(): string[] {
  return [...activeLocks.keys()];
}

/**
 * Release all currently held locks.
 * Called during graceful shutdown to prevent orphaned locks.
 * @returns Number of locks released
 */
export async function releaseAllLocks(): Promise<number> {
  let released = 0;
  for (const [lockPath, meta] of activeLocks) {
    try {
      const removedByOwner = await safeRemoveLockDir(lockPath, { expectedOwner: meta.owner });
      if (removedByOwner) {
        released++;
        continue;
      }

      // Fall back to PID verification for older/corrupt lock dirs.
      const removedByPid = await safeRemoveLockDir(lockPath, { expectedPid: meta.pid });
      if (removedByPid) released++;
    } catch {
      // Best effort - continue with other locks
    }
  }
  activeLocks.clear();
  return released;
}

function looksLikeLockDirPath(lockPath: string): boolean {
  return lockPath.endsWith(".lock.d");
}

async function safeRemoveLockDir(
  lockPath: string,
  options: { expectedOwner?: string; expectedPid?: string } = {}
): Promise<boolean> {
  if (!looksLikeLockDirPath(lockPath)) {
    warn(`[lock] Refusing to remove non-lock dir: ${lockPath}`);
    return false;
  }

  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  if (options.expectedOwner) {
    try {
      const owner = await fs.readFile(`${lockPath}/owner`, "utf-8");
      if (owner.trim() !== options.expectedOwner) {
        warn(`[lock] Lock owner mismatch, not deleting: ${lockPath}`);
        return false;
      }
    } catch {
      return false;
    }
  }

  if (options.expectedPid) {
    try {
      const pid = await fs.readFile(`${lockPath}/pid`, "utf-8");
      if (pid.trim() !== options.expectedPid) {
        warn(`[lock] Lock PID mismatch, not deleting: ${lockPath}`);
        return false;
      }
    } catch {
      return false;
    }
  }

  try {
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
    if (!(await isLockStale(lockPath, thresholdMs))) return false;
    if (activeLocks.has(lockPath)) return false;

    try {
      const pidRaw = await fs.readFile(`${lockPath}/pid`, "utf-8");
      const pid = Number.parseInt(pidRaw.trim(), 10);
      // If the PID appears to still be running, treat the lock as active even if
      // the heartbeat didn't update (e.g., debugger pause, OS sleep, or event-loop stalls).
      if (pidIsRunning(pid)) return false;

      if (await safeRemoveLockDir(lockPath, { expectedPid: pidRaw.trim() })) {
        warn(`[lock] Removed stale lock: ${lockPath}`);
        return true;
      }
      return false;
    } catch {
      // If the PID file is missing/corrupt, fall back to staleness-only cleanup.
      if (await safeRemoveLockDir(lockPath)) {
        warn(`[lock] Removed stale lock (missing/corrupt PID): ${lockPath}`);
        return true;
      }
      return false;
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
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pidIsRunning(pid)) return false;

    if (!(await safeRemoveLockDir(lockPath, { expectedPid: pidRaw.trim() }))) return false;
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
  const owner = crypto.randomUUID();

  for (let i = 0; i < maxRetries; i++) {
    // Acquire lock dir (mkdir is atomic)
    try {
      await fs.mkdir(lockPath);
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        if (await tryRemoveAbandonedLock(lockPath)) {
          continue;
        }
        if (await tryRemoveStaleLock(lockPath, staleThreshold)) {
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      if (err?.code === "ENOENT") {
        // Parent path missing; create with platform-safe dirname
        const dir = path.dirname(lockPath);
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      throw err;
    }

    // Track this lock for graceful shutdown cleanup
    activeLocks.set(lockPath, { owner, pid });

    // Write metadata inside (best effort, doesn't affect lock validity)
    try {
      await fs.writeFile(`${lockPath}/pid`, pid);
    } catch {}
    try {
      await fs.writeFile(`${lockPath}/owner`, owner);
    } catch {}

    // Start heartbeat to keep lock fresh during long operations
    const heartbeat = setInterval(async () => {
      try {
        const now = new Date();
        await fs.utimes(lockPath, now, now);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          warn(`[lock] Heartbeat failed: Lock directory ${lockPath} disappeared (stolen/deleted?)`);
        }
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

      // Safety check: only delete if we still own the lock directory.
      // This prevents deleting a lock that was stolen by another process due to stale cleanup.
      if (!(await safeRemoveLockDir(lockPath, { expectedOwner: owner }))) {
        // Fall back to PID check for older lock dirs that might not have an owner marker.
        const removed = await safeRemoveLockDir(lockPath, { expectedPid: pid });
        if (!removed) {
          // Leave the directory; stale/abandoned cleanup will handle it later.
          warn(`[lock] Could not verify lock ownership; leaving lock dir: ${lockPath}`);
        }
      }
    }
  }

  throw new Error(`Could not acquire lock for ${targetPath} after ${maxRetries} retries.`);
}
