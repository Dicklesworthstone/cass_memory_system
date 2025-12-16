/**
 * Onboarding state management for tracking progress across sessions.
 *
 * This module provides persistence for onboarding progress, enabling agents
 * to resume where they left off if their context window fills up mid-onboarding.
 *
 * State is stored in ~/.cass-memory/onboarding-state.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveGlobalDir, atomicWrite, warn } from "./utils.js";

// Schema version for future migrations
const STATE_VERSION = 1;

/**
 * Schema for a processed session entry
 */
const ProcessedSessionSchema = z.object({
  path: z.string(),
  processedAt: z.string(), // ISO8601
  rulesExtracted: z.number().int().min(0),
  skipped: z.boolean().optional(), // True if marked done without extracting rules
});

export type ProcessedSession = z.infer<typeof ProcessedSessionSchema>;

/**
 * Schema for onboarding state
 */
const OnboardStateSchema = z.object({
  version: z.number().int(),
  startedAt: z.string(), // ISO8601
  lastUpdatedAt: z.string(), // ISO8601
  processedSessions: z.array(ProcessedSessionSchema),
  stats: z.object({
    totalSessionsProcessed: z.number().int().min(0),
    totalRulesExtracted: z.number().int().min(0),
  }),
});

export type OnboardState = z.infer<typeof OnboardStateSchema>;

/**
 * Create an empty onboarding state
 */
export function createEmptyState(): OnboardState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    startedAt: now,
    lastUpdatedAt: now,
    processedSessions: [],
    stats: {
      totalSessionsProcessed: 0,
      totalRulesExtracted: 0,
    },
  };
}

/**
 * Get the path to the onboarding state file
 */
export function getStatePath(): string {
  return path.join(resolveGlobalDir(), "onboarding-state.json");
}

/**
 * Load onboarding state from disk.
 * Returns empty state if file doesn't exist or is invalid.
 */
export async function loadOnboardState(): Promise<OnboardState> {
  const statePath = getStatePath();

  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);

    const result = OnboardStateSchema.safeParse(parsed);
    if (!result.success) {
      warn(`[onboard] Invalid state file; starting fresh (${statePath})`);
      return createEmptyState();
    }

    // Check version for future migrations
    if (result.data.version !== STATE_VERSION) {
      warn(`[onboard] State version mismatch (${result.data.version} vs ${STATE_VERSION}); starting fresh`);
      return createEmptyState();
    }

    return result.data;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      warn(`[onboard] Failed to load state (${statePath}): ${err.message}`);
    }
    return createEmptyState();
  }
}

/**
 * Save onboarding state to disk atomically.
 */
export async function saveOnboardState(state: OnboardState): Promise<void> {
  const statePath = getStatePath();

  // Update lastUpdatedAt
  state.lastUpdatedAt = new Date().toISOString();

  // Recompute stats from processedSessions for consistency
  state.stats = {
    totalSessionsProcessed: state.processedSessions.length,
    totalRulesExtracted: state.processedSessions.reduce(
      (sum, s) => sum + s.rulesExtracted,
      0
    ),
  };

  try {
    await atomicWrite(statePath, JSON.stringify(state, null, 2));
  } catch (err: any) {
    warn(`[onboard] Failed to save state (${statePath}): ${err.message}`);
    throw err;
  }
}

/**
 * Check if a session has already been processed
 */
export function isSessionProcessed(state: OnboardState, sessionPath: string): boolean {
  // Normalize path for comparison
  const normalizedPath = path.resolve(sessionPath);
  return state.processedSessions.some(
    (s) => path.resolve(s.path) === normalizedPath
  );
}

/**
 * Mark a session as processed
 */
export async function markSessionProcessed(
  sessionPath: string,
  rulesExtracted: number,
  options: { skipped?: boolean } = {}
): Promise<OnboardState> {
  const state = await loadOnboardState();
  const normalizedPath = path.resolve(sessionPath);

  // Check if already processed (idempotent)
  const existingIndex = state.processedSessions.findIndex(
    (s) => path.resolve(s.path) === normalizedPath
  );

  const entry: ProcessedSession = {
    path: sessionPath,
    processedAt: new Date().toISOString(),
    rulesExtracted,
    skipped: options.skipped,
  };

  if (existingIndex >= 0) {
    // Update existing entry
    state.processedSessions[existingIndex] = entry;
  } else {
    // Add new entry
    state.processedSessions.push(entry);
  }

  await saveOnboardState(state);
  return state;
}

/**
 * Reset onboarding state (overwrite with empty state).
 */
export async function resetOnboardState(): Promise<void> {
  await saveOnboardState(createEmptyState());
}

/**
 * Get a summary of onboarding progress
 */
export interface OnboardProgress {
  sessionsProcessed: number;
  rulesExtracted: number;
  startedAt: string | null;
  lastActivity: string | null;
  hasStarted: boolean;
}

export async function getOnboardProgress(): Promise<OnboardProgress> {
  const state = await loadOnboardState();

  // Check if we have any actual progress
  const hasStarted = state.processedSessions.length > 0;

  return {
    sessionsProcessed: state.stats.totalSessionsProcessed,
    rulesExtracted: state.stats.totalRulesExtracted,
    startedAt: hasStarted ? state.startedAt : null,
    lastActivity: hasStarted ? state.lastUpdatedAt : null,
    hasStarted,
  };
}

/**
 * Filter out already-processed sessions from a list
 */
export function filterUnprocessedSessions<T extends { path: string }>(
  sessions: T[],
  state: OnboardState
): T[] {
  const processedPaths = new Set(
    state.processedSessions.map((s) => path.resolve(s.path))
  );

  return sessions.filter(
    (session) => !processedPaths.has(path.resolve(session.path))
  );
}
