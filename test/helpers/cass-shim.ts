/**
 * Cass CLI Shim - Test helper for mocking cass binary responses
 *
 * This shim allows E2E tests to run without requiring the actual cass binary.
 * It provides configurable responses for all cass functions.
 *
 * Usage:
 *   import { withCassShim, CassShimConfig } from "./helpers/cass-shim.js";
 *
 *   await withCassShim({
 *     available: true,
 *     searchResults: [{ ... }],
 *   }, async () => {
 *     // Your test code here - cass functions will return shim data
 *   });
 */

import { CassHit, CassTimelineResult, CassTimelineGroup } from "../../src/types.js";

// --- Types ---

export interface CassShimConfig {
  /** Whether cass should appear available */
  available?: boolean;

  /** Whether cass needs indexing */
  needsIndex?: boolean;

  /** Predefined search results to return */
  searchResults?: CassHit[];

  /** Function to generate search results based on query */
  searchHandler?: (query: string, options: CassSearchShimOptions) => CassHit[];

  /** Predefined timeline data */
  timeline?: CassTimelineResult;

  /** Export content by session path */
  exportContent?: Map<string, string>;

  /** Expand content by session path and line */
  expandContent?: Map<string, Map<number, string>>;

  /** Stats to return */
  stats?: Record<string, any>;

  /** Simulate specific errors */
  errors?: {
    search?: Error;
    export?: Error;
    timeline?: Error;
    index?: Error;
  };

  /** Delay to simulate slow responses (ms) */
  delay?: number;
}

export interface CassSearchShimOptions {
  limit?: number;
  days?: number;
  agent?: string | string[];
  workspace?: string;
  fields?: string[];
}

// --- Default Fixtures ---

export function createTestCassHit(overrides: Partial<CassHit> = {}): CassHit {
  const now = new Date().toISOString();
  return {
    source_path: overrides.source_path || "/test/sessions/session-001.jsonl",
    line_number: overrides.line_number ?? 42,
    timestamp: overrides.timestamp || now,
    agent: overrides.agent || "claude-code",
    snippet: overrides.snippet || "Test snippet content from session",
    score: overrides.score ?? 0.85,
    workspace: overrides.workspace,
    sessionPath: overrides.sessionPath || overrides.source_path || "/test/sessions/session-001.jsonl",
    ...overrides
  };
}

export function createTestTimeline(groups: Partial<CassTimelineGroup>[] = []): CassTimelineResult {
  if (groups.length === 0) {
    return {
      groups: [
        {
          date: new Date().toISOString().split("T")[0],
          sessions: [
            {
              path: "/test/sessions/session-001.jsonl",
              agent: "claude-code",
              messageCount: 50,
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString()
            }
          ]
        }
      ]
    };
  }

  return {
    groups: groups.map(g => ({
      date: g.date || new Date().toISOString().split("T")[0],
      sessions: g.sessions || []
    }))
  };
}

// --- Shim State ---

let currentShimConfig: CassShimConfig | null = null;

export function getShimConfig(): CassShimConfig | null {
  return currentShimConfig;
}

export function isShimActive(): boolean {
  return currentShimConfig !== null;
}

// --- Shim Functions ---

/**
 * Shimmed version of cassAvailable
 */
export function shimCassAvailable(): boolean {
  if (!currentShimConfig) return false;
  return currentShimConfig.available ?? true;
}

/**
 * Shimmed version of cassNeedsIndex
 */
export function shimCassNeedsIndex(): boolean {
  if (!currentShimConfig) return true;
  return currentShimConfig.needsIndex ?? false;
}

/**
 * Shimmed version of cassSearch
 */
export async function shimCassSearch(
  query: string,
  options: CassSearchShimOptions = {}
): Promise<CassHit[]> {
  if (!currentShimConfig) return [];

  // Apply delay if configured
  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  // Check for errors
  if (currentShimConfig.errors?.search) {
    throw currentShimConfig.errors.search;
  }

  // Use handler if provided
  if (currentShimConfig.searchHandler) {
    return currentShimConfig.searchHandler(query, options);
  }

  // Return predefined results with optional filtering
  let results = currentShimConfig.searchResults || [];

  // Apply limit
  if (options.limit && options.limit > 0) {
    results = results.slice(0, options.limit);
  }

  // Filter by workspace if specified
  if (options.workspace) {
    results = results.filter(r => r.workspace === options.workspace || !r.workspace);
  }

  // Filter by agent if specified
  if (options.agent) {
    const agents = Array.isArray(options.agent) ? options.agent : [options.agent];
    results = results.filter(r => agents.includes(r.agent));
  }

  return results;
}

/**
 * Shimmed version of cassExport
 */
export async function shimCassExport(
  sessionPath: string,
  format: "markdown" | "json" | "text" = "markdown"
): Promise<string | null> {
  if (!currentShimConfig) return null;

  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  if (currentShimConfig.errors?.export) {
    throw currentShimConfig.errors.export;
  }

  const content = currentShimConfig.exportContent?.get(sessionPath);
  return content ?? null;
}

/**
 * Shimmed version of cassExpand
 */
export async function shimCassExpand(
  sessionPath: string,
  lineNumber: number,
  contextLines = 3
): Promise<string | null> {
  if (!currentShimConfig) return null;

  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  const sessionExpands = currentShimConfig.expandContent?.get(sessionPath);
  if (!sessionExpands) return null;

  return sessionExpands.get(lineNumber) ?? null;
}

/**
 * Shimmed version of cassTimeline
 */
export async function shimCassTimeline(days: number): Promise<CassTimelineResult> {
  if (!currentShimConfig) return { groups: [] };

  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  if (currentShimConfig.errors?.timeline) {
    throw currentShimConfig.errors.timeline;
  }

  return currentShimConfig.timeline || { groups: [] };
}

/**
 * Shimmed version of cassStats
 */
export async function shimCassStats(): Promise<Record<string, any> | null> {
  if (!currentShimConfig) return null;

  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  return currentShimConfig.stats ?? {
    total_sessions: 10,
    total_messages: 500,
    indexed_at: new Date().toISOString()
  };
}

/**
 * Shimmed version of cassIndex
 */
export async function shimCassIndex(): Promise<void> {
  if (!currentShimConfig) return;

  if (currentShimConfig.delay) {
    await new Promise(r => setTimeout(r, currentShimConfig!.delay));
  }

  if (currentShimConfig.errors?.index) {
    throw currentShimConfig.errors.index;
  }

  // Index "succeeds" - update needsIndex state
  if (currentShimConfig) {
    currentShimConfig.needsIndex = false;
  }
}

// --- Context Manager ---

/**
 * Run callback with cass shim active.
 *
 * @param config - Configuration for the shim
 * @param fn - Callback to run with shim active
 * @returns Result of callback
 */
export async function withCassShim<T>(
  config: CassShimConfig,
  fn: () => Promise<T>
): Promise<T> {
  const previousConfig = currentShimConfig;
  currentShimConfig = config;

  try {
    return await fn();
  } finally {
    currentShimConfig = previousConfig;
  }
}

/**
 * Set shim config directly (for use in beforeEach/afterEach)
 */
export function setCassShimConfig(config: CassShimConfig | null): void {
  currentShimConfig = config;
}

/**
 * Clear shim config
 */
export function clearCassShim(): void {
  currentShimConfig = null;
}

// --- Factory Presets ---

/**
 * Create config for unavailable cass scenario
 */
export function unavailableCassConfig(): CassShimConfig {
  return {
    available: false,
    needsIndex: true,
    searchResults: [],
    timeline: { groups: [] }
  };
}

/**
 * Create config for healthy cass with sample data
 */
export function healthyCassConfig(overrides: Partial<CassShimConfig> = {}): CassShimConfig {
  return {
    available: true,
    needsIndex: false,
    searchResults: [
      createTestCassHit({ snippet: "User asked about authentication flow" }),
      createTestCassHit({ snippet: "Implemented JWT token validation", line_number: 100 }),
      createTestCassHit({ snippet: "Fixed bug in session handling", line_number: 200 })
    ],
    timeline: createTestTimeline(),
    stats: {
      total_sessions: 25,
      total_messages: 1500,
      agents: ["claude-code", "cursor", "codex"],
      indexed_at: new Date().toISOString()
    },
    ...overrides
  };
}

/**
 * Create config that simulates slow cass
 */
export function slowCassConfig(delayMs: number = 1000): CassShimConfig {
  return {
    ...healthyCassConfig(),
    delay: delayMs
  };
}

/**
 * Create config that simulates cass needing indexing
 */
export function needsIndexCassConfig(): CassShimConfig {
  return {
    available: true,
    needsIndex: true,
    searchResults: [],
    timeline: { groups: [] }
  };
}
