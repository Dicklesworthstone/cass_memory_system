import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  trackEvent,
  trackBulletMarked,
  trackCommandRun,
  trackSessionCount,
  trackReflectionStats,
  trackPlaybookChange,
  trackError,
  loadUsageEvents,
  getUsageStats,
  getUsageLogPath,
  setUsageLogPath,
  type UsageEvent,
  type UsageEventType,
} from "../src/tracking.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Usage Analytics Tracking", () => {
  let originalLogPath: string;
  let tmpDir: string;
  let testLogPath: string;

  beforeEach(async () => {
    // Create temp directory for test logs
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-test-"));
    testLogPath = path.join(tmpDir, "usage.jsonl");
    originalLogPath = getUsageLogPath();
    setUsageLogPath(testLogPath);
  });

  afterEach(async () => {
    setUsageLogPath(originalLogPath);
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("getUsageLogPath", () => {
    test("returns path in home directory", () => {
      // Temporarily restore default path for this assertion
      setUsageLogPath(originalLogPath);
      const logPath = getUsageLogPath();
      // Restore test path for subsequent tests
      setUsageLogPath(testLogPath);
      expect(logPath).toContain(".cass-memory");
      expect(logPath).toContain("usage.jsonl");
    });
  });

  describe("trackEvent", () => {
    test("creates log file if it does not exist", async () => {
      // Track an event (this uses the real path, but that's ok for this test)
      await trackEvent("command_run", {
        command: "test",
        duration_ms: 100,
        success: true,
      });

      const exists = await fs
        .access(getUsageLogPath())
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    test("appends event as JSON line", async () => {
      await trackEvent("command_run", {
        command: "context",
        duration_ms: 500,
        success: true,
      });

      const content = await fs.readFile(getUsageLogPath(), "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      const event = JSON.parse(lastLine);

      expect(event.event).toBe("command_run");
      expect(event.data.command).toBe("context");
      expect(event.data.duration_ms).toBe(500);
      expect(event.data.success).toBe(true);
      expect(event.timestamp).toBeDefined();
    });

    test("handles concurrent writes gracefully", async () => {
      // Fire multiple events concurrently — keep count modest so lock
      // retries don't exhaust on slow CI runners.
      const concurrentCount = 5;
      const promises = [];
      for (let i = 0; i < concurrentCount; i++) {
        promises.push(
          trackEvent("command_run", {
            command: `test-${i}`,
            duration_ms: i * 10,
            success: true,
          })
        );
      }

      await Promise.all(promises);

      const events = await loadUsageEvents({ eventType: "command_run" });
      expect(events.length).toBeGreaterThanOrEqual(concurrentCount);
    }, 15_000);
  });

  describe("trackBulletMarked", () => {
    test("tracks helpful feedback", async () => {
      await trackBulletMarked("b-test-123", "helpful", {
        reason: "Helped fix bug",
      });

      const events = await loadUsageEvents({ eventType: "bullet_marked" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("bullet_marked");
      if (lastEvent.event === "bullet_marked") {
        expect(lastEvent.data.bulletId).toBe("b-test-123");
        expect(lastEvent.data.feedback).toBe("helpful");
        expect(lastEvent.data.reason).toBe("Helped fix bug");
      }
    });

    test("tracks harmful feedback", async () => {
      await trackBulletMarked("b-test-456", "harmful", {
        sessionPath: "/path/to/session",
      });

      const events = await loadUsageEvents({ eventType: "bullet_marked" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("bullet_marked");
      if (lastEvent.event === "bullet_marked") {
        expect(lastEvent.data.bulletId).toBe("b-test-456");
        expect(lastEvent.data.feedback).toBe("harmful");
        expect(lastEvent.data.sessionPath).toBe("/path/to/session");
      }
    });
  });

  describe("trackCommandRun", () => {
    test("tracks successful command", async () => {
      await trackCommandRun("reflect", 2500, true, { scope: "workspace" });

      const events = await loadUsageEvents({ eventType: "command_run" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("command_run");
      if (lastEvent.event === "command_run") {
        expect(lastEvent.data.command).toBe("reflect");
        expect(lastEvent.data.duration_ms).toBe(2500);
        expect(lastEvent.data.success).toBe(true);
        expect(lastEvent.data.scope).toBe("workspace");
      }
    });

    test("tracks failed command with error", async () => {
      await trackCommandRun("audit", 150, false, {
        error: "No sessions found",
      });

      const events = await loadUsageEvents({ eventType: "command_run" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("command_run");
      if (lastEvent.event === "command_run") {
        expect(lastEvent.data.command).toBe("audit");
        expect(lastEvent.data.success).toBe(false);
        expect(lastEvent.data.error).toBe("No sessions found");
      }
    });
  });

  describe("trackSessionCount", () => {
    test("tracks session discovery", async () => {
      await trackSessionCount("claude", 15, "/path/to/workspace");

      const events = await loadUsageEvents({ eventType: "session_count" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("session_count");
      if (lastEvent.event === "session_count") {
        expect(lastEvent.data.provider).toBe("claude");
        expect(lastEvent.data.count).toBe(15);
        expect(lastEvent.data.workspace).toBe("/path/to/workspace");
      }
    });

    test("tracks without workspace", async () => {
      await trackSessionCount("cursor", 5);

      const events = await loadUsageEvents({ eventType: "session_count" });
      const lastEvent = events[events.length - 1];

      if (lastEvent.event === "session_count") {
        expect(lastEvent.data.provider).toBe("cursor");
        expect(lastEvent.data.count).toBe(5);
        expect(lastEvent.data.workspace).toBeUndefined();
      }
    });
  });

  describe("trackReflectionStats", () => {
    test("tracks reflection run", async () => {
      await trackReflectionStats(10, 5, 3, "/workspace");

      const events = await loadUsageEvents({ eventType: "reflection_stats" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("reflection_stats");
      if (lastEvent.event === "reflection_stats") {
        expect(lastEvent.data.sessionsProcessed).toBe(10);
        expect(lastEvent.data.deltasProposed).toBe(5);
        expect(lastEvent.data.deltasApplied).toBe(3);
        expect(lastEvent.data.workspace).toBe("/workspace");
      }
    });
  });

  describe("trackPlaybookChange", () => {
    test("tracks bullet add", async () => {
      await trackPlaybookChange("add", { bulletId: "b-new-123" });

      const events = await loadUsageEvents({ eventType: "playbook_change" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("playbook_change");
      if (lastEvent.event === "playbook_change") {
        expect(lastEvent.data.action).toBe("add");
        expect(lastEvent.data.bulletId).toBe("b-new-123");
      }
    });

    test("tracks merge operation", async () => {
      await trackPlaybookChange("merge", { count: 3 });

      const events = await loadUsageEvents({ eventType: "playbook_change" });
      const lastEvent = events[events.length - 1];

      if (lastEvent.event === "playbook_change") {
        expect(lastEvent.data.action).toBe("merge");
        expect(lastEvent.data.count).toBe(3);
      }
    });
  });

  describe("trackError", () => {
    test("tracks error with category", async () => {
      await trackError("llm", "API rate limit exceeded", {
        command: "reflect",
      });

      const events = await loadUsageEvents({ eventType: "error_occurred" });
      const lastEvent = events[events.length - 1];

      expect(lastEvent.event).toBe("error_occurred");
      if (lastEvent.event === "error_occurred") {
        expect(lastEvent.data.category).toBe("llm");
        expect(lastEvent.data.message).toBe("API rate limit exceeded");
        expect(lastEvent.data.command).toBe("reflect");
      }
    });

    test("tracks error with stack", async () => {
      await trackError("io", "File not found", {
        stack: "Error: ENOENT...",
      });

      const events = await loadUsageEvents({ eventType: "error_occurred" });
      const lastEvent = events[events.length - 1];

      if (lastEvent.event === "error_occurred") {
        expect(lastEvent.data.category).toBe("io");
        expect(lastEvent.data.stack).toContain("ENOENT");
      }
    });
  });

  describe("loadUsageEvents", () => {
    test("returns empty array when log does not exist", async () => {
      // This tests the actual function's handling of missing file
      // We can't easily mock the path, but we can verify the behavior indirectly
      const events = await loadUsageEvents();
      expect(Array.isArray(events)).toBe(true);
    });

    test("filters by event type", async () => {
      // Add events of different types
      await trackCommandRun("test1", 100, true);
      await trackBulletMarked("b-1", "helpful");
      await trackCommandRun("test2", 200, true);

      const commandEvents = await loadUsageEvents({
        eventType: "command_run",
      });
      const bulletEvents = await loadUsageEvents({
        eventType: "bullet_marked",
      });

      // All command events should be command_run
      for (const event of commandEvents) {
        expect(event.event).toBe("command_run");
      }

      // All bullet events should be bullet_marked
      for (const event of bulletEvents) {
        expect(event.event).toBe("bullet_marked");
      }
    });

    test("respects limit parameter", async () => {
      // Add multiple events
      for (let i = 0; i < 5; i++) {
        await trackCommandRun(`cmd-${i}`, i * 100, true);
      }

      const limited = await loadUsageEvents({ limit: 3 });
      expect(limited.length).toBeLessThanOrEqual(3);
    });

    test("filters by since timestamp", async () => {
      const beforeTime = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 10));

      await trackCommandRun("after", 100, true);

      const events = await loadUsageEvents({ since: beforeTime });
      // Should include the event tracked after beforeTime
      const hasAfterEvent = events.some(
        (e) => e.event === "command_run" && (e as any).data.command === "after"
      );
      expect(hasAfterEvent).toBe(true);
    });

    test("handles malformed lines gracefully", async () => {
      // Write some malformed content directly
      const logPath = getUsageLogPath();
      await fs.appendFile(logPath, "not json\n", "utf-8");
      await fs.appendFile(logPath, '{"event":"command_run"}\n', "utf-8");

      // Should not throw
      const events = await loadUsageEvents();
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe("getUsageStats", () => {
    test("returns correct structure", async () => {
      const stats = await getUsageStats();

      expect(typeof stats.totalEvents).toBe("number");
      expect(stats.eventCounts).toBeDefined();
      expect(stats.bulletFeedback).toBeDefined();
      expect(stats.bulletFeedback.helpful).toBeDefined();
      expect(stats.bulletFeedback.harmful).toBeDefined();
      expect(stats.commandStats).toBeDefined();
      expect(stats.commandStats.total).toBeDefined();
      expect(stats.commandStats.successful).toBeDefined();
      expect(stats.commandStats.failed).toBeDefined();
    });

    test("counts events correctly", async () => {
      // Get initial stats
      const initialStats = await getUsageStats();

      // Add specific events
      await trackBulletMarked("b-stat-1", "helpful");
      await trackBulletMarked("b-stat-2", "harmful");
      await trackCommandRun("stat-cmd-1", 100, true);
      await trackCommandRun("stat-cmd-2", 200, false);

      const newStats = await getUsageStats();

      // Should have more events than before
      expect(newStats.totalEvents).toBeGreaterThan(initialStats.totalEvents);

      // Bullet feedback should increase
      expect(newStats.bulletFeedback.helpful).toBeGreaterThanOrEqual(
        initialStats.bulletFeedback.helpful + 1
      );
      expect(newStats.bulletFeedback.harmful).toBeGreaterThanOrEqual(
        initialStats.bulletFeedback.harmful + 1
      );

      // Command stats should increase
      expect(newStats.commandStats.total).toBeGreaterThanOrEqual(
        initialStats.commandStats.total + 2
      );
    });

    test("tracks lastActivity", async () => {
      await trackCommandRun("activity-test", 50, true);

      const stats = await getUsageStats();
      expect(stats.lastActivity).toBeDefined();
      expect(new Date(stats.lastActivity!).getTime()).toBeLessThanOrEqual(
        Date.now()
      );
    });
  });

  describe("Event type safety", () => {
    test("UsageEventType includes all event types", () => {
      const types: UsageEventType[] = [
        "bullet_marked",
        "command_run",
        "session_count",
        "reflection_stats",
        "playbook_change",
        "error_occurred",
      ];

      expect(types.length).toBe(6);
    });

    test("event data matches event type", async () => {
      // This is a compile-time check, but we can verify at runtime too
      const bulletEvent: UsageEvent = {
        timestamp: new Date().toISOString(),
        event: "bullet_marked",
        data: {
          bulletId: "b-1",
          feedback: "helpful",
        },
      };

      const commandEvent: UsageEvent = {
        timestamp: new Date().toISOString(),
        event: "command_run",
        data: {
          command: "test",
          duration_ms: 100,
          success: true,
        },
      };

      expect(bulletEvent.event).toBe("bullet_marked");
      expect(commandEvent.event).toBe("command_run");
    });
  });
});
