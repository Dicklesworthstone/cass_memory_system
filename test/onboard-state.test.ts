/**
 * Unit tests for onboard-state module
 *
 * Tests:
 * - createEmptyState() creates proper structure
 * - loadOnboardState() handles missing, valid, and invalid files
 * - saveOnboardState() writes atomically and recomputes stats
 * - isSessionProcessed() detects processed sessions
 * - markSessionProcessed() adds/updates session entries
 * - resetOnboardState() clears all state
 * - getOnboardProgress() returns summary
 * - filterUnprocessedSessions() filters correctly
 */
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEmptyState,
  filterUnprocessedSessions,
  getOnboardProgress,
  isSessionProcessed,
  loadOnboardState,
  markSessionProcessed,
  type OnboardState,
  resetOnboardState,
  saveOnboardState,
} from "../src/onboard-state.js";
import { withTempCassHome } from "./helpers/temp.js";

describe("onboard-state - Unit Tests", () => {
  describe("createEmptyState", () => {
    test("creates valid empty state structure", () => {
      const state = createEmptyState();

      expect(state.version).toBe(1);
      expect(state.startedAt).toBeDefined();
      expect(state.lastUpdatedAt).toBeDefined();
      expect(state.processedSessions).toEqual([]);
      expect(state.stats).toEqual({
        totalSessionsProcessed: 0,
        totalRulesExtracted: 0,
      });
    });

    test("timestamps are ISO8601 format", () => {
      const state = createEmptyState();

      // Should not throw when parsed
      expect(() => new Date(state.startedAt)).not.toThrow();
      expect(() => new Date(state.lastUpdatedAt)).not.toThrow();
    });
  });

  describe("loadOnboardState", () => {
    test("returns empty state when file does not exist", async () => {
      await withTempCassHome(async () => {
        const state = await loadOnboardState();

        expect(state.version).toBe(1);
        expect(state.processedSessions).toEqual([]);
      });
    });

    test("loads valid state from disk", async () => {
      await withTempCassHome(async (env) => {
        const testState: OnboardState = {
          version: 1,
          startedAt: "2025-01-01T00:00:00Z",
          lastUpdatedAt: "2025-01-02T00:00:00Z",
          processedSessions: [
            {
              path: "/sessions/test.jsonl",
              processedAt: "2025-01-01T00:00:00Z",
              rulesExtracted: 5,
            },
          ],
          stats: {
            totalSessionsProcessed: 1,
            totalRulesExtracted: 5,
          },
        };

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        await writeFile(statePath, JSON.stringify(testState));

        const loaded = await loadOnboardState();

        expect(loaded.version).toBe(1);
        expect(loaded.processedSessions).toHaveLength(1);
        expect(loaded.processedSessions[0].rulesExtracted).toBe(5);
      });
    });

    test("returns empty state when file is invalid JSON", async () => {
      await withTempCassHome(async (env) => {
        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        await writeFile(statePath, "{ invalid json");

        const state = await loadOnboardState();

        expect(state.version).toBe(1);
        expect(state.processedSessions).toEqual([]);
      });
    });

    test("returns empty state when schema validation fails", async () => {
      await withTempCassHome(async (env) => {
        const invalidState = {
          version: 1,
          // Missing required fields
        };

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        await writeFile(statePath, JSON.stringify(invalidState));

        const state = await loadOnboardState();

        expect(state.processedSessions).toEqual([]);
      });
    });

    test("returns empty state when version mismatches", async () => {
      await withTempCassHome(async (env) => {
        const futureState: OnboardState = {
          version: 999, // Future version
          startedAt: "2025-01-01T00:00:00Z",
          lastUpdatedAt: "2025-01-02T00:00:00Z",
          processedSessions: [],
          stats: { totalSessionsProcessed: 0, totalRulesExtracted: 0 },
        };

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        await writeFile(statePath, JSON.stringify(futureState));

        const state = await loadOnboardState();

        // Should start fresh due to version mismatch
        expect(state.version).toBe(1);
      });
    });
  });

  describe("saveOnboardState", () => {
    test("saves state to disk", async () => {
      await withTempCassHome(async (env) => {
        const state = createEmptyState();
        state.processedSessions.push({
          path: "/test/session.jsonl",
          processedAt: new Date().toISOString(),
          rulesExtracted: 3,
        });

        await saveOnboardState(state);

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        const raw = await readFile(statePath, "utf-8");
        const saved = JSON.parse(raw);

        expect(saved.processedSessions).toHaveLength(1);
        expect(saved.processedSessions[0].rulesExtracted).toBe(3);
      });
    });

    test("recomputes stats from processedSessions", async () => {
      await withTempCassHome(async (env) => {
        const state = createEmptyState();
        state.processedSessions = [
          { path: "/s1.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 3 },
          { path: "/s2.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 7 },
        ];
        // Intentionally wrong stats
        state.stats = { totalSessionsProcessed: 0, totalRulesExtracted: 0 };

        await saveOnboardState(state);

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        const saved = JSON.parse(await readFile(statePath, "utf-8"));

        expect(saved.stats.totalSessionsProcessed).toBe(2);
        expect(saved.stats.totalRulesExtracted).toBe(10);
      });
    });

    test("updates lastUpdatedAt timestamp", async () => {
      await withTempCassHome(async (env) => {
        const state = createEmptyState();
        const originalTime = state.lastUpdatedAt;

        // Small delay to ensure different timestamp
        await new Promise((r) => setTimeout(r, 10));
        await saveOnboardState(state);

        const statePath = path.join(env.cassMemoryDir, "onboarding-state.json");
        const saved = JSON.parse(await readFile(statePath, "utf-8"));

        expect(saved.lastUpdatedAt).not.toBe(originalTime);
      });
    });
  });

  describe("isSessionProcessed", () => {
    test("returns true for processed session", () => {
      const state: OnboardState = {
        version: 1,
        startedAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:00Z",
        processedSessions: [
          { path: "/sessions/test.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 5 },
        ],
        stats: { totalSessionsProcessed: 1, totalRulesExtracted: 5 },
      };

      expect(isSessionProcessed(state, "/sessions/test.jsonl")).toBe(true);
    });

    test("returns false for unprocessed session", () => {
      const state = createEmptyState();

      expect(isSessionProcessed(state, "/sessions/unknown.jsonl")).toBe(false);
    });

    test("normalizes paths for comparison", () => {
      const state: OnboardState = {
        version: 1,
        startedAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:00Z",
        processedSessions: [
          { path: "/sessions/test.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 5 },
        ],
        stats: { totalSessionsProcessed: 1, totalRulesExtracted: 5 },
      };

      // Different path representation should still match after normalization
      expect(isSessionProcessed(state, "/sessions/../sessions/test.jsonl")).toBe(true);
    });
  });

  describe("markSessionProcessed", () => {
    test("adds new session to state", async () => {
      await withTempCassHome(async () => {
        const state = await markSessionProcessed("/test/session.jsonl", 5);

        expect(state.processedSessions).toHaveLength(1);
        expect(state.processedSessions[0].rulesExtracted).toBe(5);
        expect(state.stats.totalRulesExtracted).toBe(5);
      });
    });

    test("updates existing session (idempotent)", async () => {
      await withTempCassHome(async () => {
        // Mark once
        await markSessionProcessed("/test/session.jsonl", 3);

        // Mark again with different count
        const state = await markSessionProcessed("/test/session.jsonl", 7);

        expect(state.processedSessions).toHaveLength(1);
        expect(state.processedSessions[0].rulesExtracted).toBe(7);
      });
    });

    test("sets skipped flag when provided", async () => {
      await withTempCassHome(async () => {
        const state = await markSessionProcessed("/test/session.jsonl", 0, { skipped: true });

        expect(state.processedSessions[0].skipped).toBe(true);
      });
    });
  });

  describe("resetOnboardState", () => {
    test("clears all progress", async () => {
      await withTempCassHome(async () => {
        // Add some progress first
        await markSessionProcessed("/test/s1.jsonl", 5);
        await markSessionProcessed("/test/s2.jsonl", 3);

        // Reset
        await resetOnboardState();

        // Verify it's cleared
        const state = await loadOnboardState();
        expect(state.processedSessions).toEqual([]);
        expect(state.stats.totalRulesExtracted).toBe(0);
      });
    });
  });

  describe("getOnboardProgress", () => {
    test("returns hasStarted false when no progress", async () => {
      await withTempCassHome(async () => {
        const progress = await getOnboardProgress();

        expect(progress.hasStarted).toBe(false);
        expect(progress.sessionsProcessed).toBe(0);
        expect(progress.startedAt).toBeNull();
        expect(progress.lastActivity).toBeNull();
      });
    });

    test("returns progress summary when sessions processed", async () => {
      await withTempCassHome(async () => {
        await markSessionProcessed("/test/s1.jsonl", 5);
        await markSessionProcessed("/test/s2.jsonl", 3);

        const progress = await getOnboardProgress();

        expect(progress.hasStarted).toBe(true);
        expect(progress.sessionsProcessed).toBe(2);
        expect(progress.rulesExtracted).toBe(8);
        expect(progress.startedAt).not.toBeNull();
        expect(progress.lastActivity).not.toBeNull();
      });
    });
  });

  describe("filterUnprocessedSessions", () => {
    test("filters out processed sessions", () => {
      const state: OnboardState = {
        version: 1,
        startedAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:00Z",
        processedSessions: [
          { path: "/sessions/s1.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 5 },
        ],
        stats: { totalSessionsProcessed: 1, totalRulesExtracted: 5 },
      };

      const sessions = [
        { path: "/sessions/s1.jsonl", name: "s1" },
        { path: "/sessions/s2.jsonl", name: "s2" },
        { path: "/sessions/s3.jsonl", name: "s3" },
      ];

      const unprocessed = filterUnprocessedSessions(sessions, state);

      expect(unprocessed).toHaveLength(2);
      expect(unprocessed.map((s) => s.name)).toEqual(["s2", "s3"]);
    });

    test("returns all sessions when none processed", () => {
      const state = createEmptyState();

      const sessions = [{ path: "/sessions/s1.jsonl" }, { path: "/sessions/s2.jsonl" }];

      const unprocessed = filterUnprocessedSessions(sessions, state);

      expect(unprocessed).toHaveLength(2);
    });

    test("returns empty array when all processed", () => {
      const state: OnboardState = {
        version: 1,
        startedAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:00Z",
        processedSessions: [
          { path: "/sessions/s1.jsonl", processedAt: "2025-01-01T00:00:00Z", rulesExtracted: 5 },
        ],
        stats: { totalSessionsProcessed: 1, totalRulesExtracted: 5 },
      };

      const sessions = [{ path: "/sessions/s1.jsonl" }];

      const unprocessed = filterUnprocessedSessions(sessions, state);

      expect(unprocessed).toEqual([]);
    });
  });
});
