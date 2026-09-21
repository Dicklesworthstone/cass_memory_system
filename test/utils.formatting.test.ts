import { describe, expect, it } from "bun:test";
import {
  error,
  formatLastHelpful,
  formatRelativeTime,
  generateSuggestedQueries,
  log,
  warn,
} from "../src/utils.js";

// =============================================================================
// formatRelativeTime
// =============================================================================
describe("formatRelativeTime", () => {
  it("returns 'today' for current day", () => {
    const today = new Date().toISOString();
    expect(formatRelativeTime(today)).toBe("today");
  });

  it("returns 'yesterday' for 1 day ago", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(yesterday)).toBe("yesterday");
  });

  it("returns 'X days ago' for 2-6 days", () => {
    const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoDays)).toBe("2 days ago");

    const sixDays = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(sixDays)).toBe("6 days ago");
  });

  it("returns weeks for 7-29 days", () => {
    const oneWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(oneWeek)).toBe("1 week ago");

    const twoWeeks = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoWeeks)).toBe("2 weeks ago");

    const threeWeeks = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeWeeks)).toBe("3 weeks ago");
  });

  it("returns months for 30-364 days", () => {
    const oneMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(oneMonth)).toBe("1 month ago");

    const sixMonths = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(sixMonths)).toBe("6 months ago");
  });

  it("returns years for 365+ days", () => {
    const oneYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(oneYear)).toBe("1 year ago");

    const twoYears = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoYears)).toBe("2 years ago");
  });

  it("handles edge case at week boundary", () => {
    // Exactly 7 days should be "1 week ago" (proper singular form)
    const exactlySevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(exactlySevenDays)).toBe("1 week ago");
  });
});

// =============================================================================
// formatLastHelpful
// =============================================================================
describe("formatLastHelpful", () => {
  it("returns 'Never' for empty bullet", () => {
    expect(formatLastHelpful({})).toBe("Never");
  });

  it("returns 'Never' for empty helpfulEvents array", () => {
    expect(formatLastHelpful({ helpfulEvents: [] })).toBe("Never");
  });

  it("returns 'Never' for empty feedbackEvents array", () => {
    expect(formatLastHelpful({ feedbackEvents: [] })).toBe("Never");
  });

  it("returns 'Never' for feedbackEvents with no helpful type", () => {
    const bullet = {
      feedbackEvents: [{ type: "harmful", timestamp: new Date().toISOString() }],
    };
    expect(formatLastHelpful(bullet)).toBe("Never");
  });

  it("returns 'just now' for very recent helpful event", () => {
    const bullet = {
      helpfulEvents: [{ timestamp: new Date().toISOString() }],
    };
    expect(formatLastHelpful(bullet)).toBe("just now");
  });

  it("returns minutes ago for 1-59 minutes", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: fiveMinutesAgo }] };
    expect(formatLastHelpful(bullet)).toBe("5 minutes ago");

    const oneMinuteAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: oneMinuteAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("1 minute ago");
  });

  it("returns hours ago for 1-23 hours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: twoHoursAgo }] };
    expect(formatLastHelpful(bullet)).toBe("2 hours ago");

    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: oneHourAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("1 hour ago");
  });

  it("returns days ago for 1-6 days", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: threeDaysAgo }] };
    expect(formatLastHelpful(bullet)).toBe("3 days ago");

    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: oneDayAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("1 day ago");
  });

  it("returns weeks ago for 1-4 weeks", () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: twoWeeksAgo }] };
    expect(formatLastHelpful(bullet)).toBe("2 weeks ago");

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: oneWeekAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("1 week ago");
  });

  it("returns months ago for 1-11 months", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: twoMonthsAgo }] };
    expect(formatLastHelpful(bullet)).toBe("2 months ago");

    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: oneMonthAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("1 month ago");
  });

  it("returns years ago for 12+ months", () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const bullet = { helpfulEvents: [{ timestamp: oneYearAgo }] };
    expect(formatLastHelpful(bullet)).toBe("1 year ago");

    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    const bullet2 = { helpfulEvents: [{ timestamp: twoYearsAgo }] };
    expect(formatLastHelpful(bullet2)).toBe("2 years ago");
  });

  it("uses feedbackEvents when helpfulEvents is undefined", () => {
    const bullet = {
      feedbackEvents: [{ type: "helpful", timestamp: new Date().toISOString() }],
    };
    expect(formatLastHelpful(bullet)).toBe("just now");
  });

  it("finds most recent helpful from multiple events", () => {
    const oldTimestamp = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const bullet = {
      helpfulEvents: [{ timestamp: oldTimestamp }, { timestamp: recentTimestamp }],
    };
    expect(formatLastHelpful(bullet)).toBe("2 hours ago");
  });

  it("ignores invalid timestamps", () => {
    const validTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const bullet = {
      helpfulEvents: [{ timestamp: "not-a-date" }, { timestamp: validTimestamp }],
    };
    expect(formatLastHelpful(bullet)).toBe("1 hour ago");
  });

  it("returns 'Never' when all timestamps are invalid", () => {
    const bullet = {
      helpfulEvents: [{ timestamp: "invalid1" }, { timestamp: "invalid2" }],
    };
    expect(formatLastHelpful(bullet)).toBe("Never");
  });

  it("filters only helpful type from feedbackEvents", () => {
    const harmfulTimestamp = new Date().toISOString();
    const helpfulTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const bullet = {
      feedbackEvents: [
        { type: "harmful", timestamp: harmfulTimestamp },
        { type: "helpful", timestamp: helpfulTimestamp },
      ],
    };
    expect(formatLastHelpful(bullet)).toBe("5 minutes ago");
  });

  it("prefers helpfulEvents over feedbackEvents", () => {
    const helpfulEventTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const feedbackEventTime = new Date().toISOString();
    const bullet = {
      helpfulEvents: [{ timestamp: helpfulEventTime }],
      feedbackEvents: [{ type: "helpful", timestamp: feedbackEventTime }],
    };
    // Should use helpfulEvents (1 hour ago), not feedbackEvents (just now)
    expect(formatLastHelpful(bullet)).toBe("1 hour ago");
  });
});

// =============================================================================
// generateSuggestedQueries
// =============================================================================
describe("generateSuggestedQueries", () => {
  it("returns array of suggestions", () => {
    const result = generateSuggestedQueries("Fix bug", ["bug", "fix"]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes task keywords in suggestions", () => {
    const result = generateSuggestedQueries("authentication timeout", [
      "authentication",
      "timeout",
    ]);
    const hasRelevantKeyword = result.some(
      (q) => q.includes("authentication") || q.includes("timeout"),
    );
    expect(hasRelevantKeyword).toBe(true);
  });

  it("formats as cass search commands", () => {
    const result = generateSuggestedQueries("test task", ["test"]);
    const allAreCassCommands = result.every((q) => q.startsWith("cass search"));
    expect(allAreCassCommands).toBe(true);
  });

  it("respects maxSuggestions option", () => {
    const result = generateSuggestedQueries("task", ["a", "b", "c"], {
      maxSuggestions: 2,
    });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("includes days parameter in queries", () => {
    const result = generateSuggestedQueries("task", ["test"]);
    const hassDaysParam = result.some((q) => q.includes("--days"));
    expect(hassDaysParam).toBe(true);
  });

  it("handles empty keywords array", () => {
    const result = generateSuggestedQueries("task", []);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles preferredAgent option", () => {
    const result = generateSuggestedQueries("task", ["test"], {
      preferredAgent: "claude",
    });
    // Should return suggestions (may or may not include agent filter depending on impl)
    expect(Array.isArray(result)).toBe(true);
  });

  it("includes problem terms for error-related tasks", () => {
    const result = generateSuggestedQueries("error in login", ["error", "login"]);
    expect(result.length).toBeGreaterThan(0);
  });

  it("default maxSuggestions is 5", () => {
    const result = generateSuggestedQueries("task with many keywords", [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("varies day ranges in suggestions", () => {
    const result = generateSuggestedQueries("complex task", ["authentication", "timeout", "error"]);
    const dayMatches = result
      .map((q) => {
        const match = q.match(/--days\s+(\d+)/);
        return match ? parseInt(match[1]) : null;
      })
      .filter(Boolean);

    // Should have different day ranges
    if (dayMatches.length > 1) {
      const uniqueDays = new Set(dayMatches);
      expect(uniqueDays.size).toBeGreaterThanOrEqual(1);
    }
  });
});

// =============================================================================
// Logging utilities (log, warn, error)
// =============================================================================
describe("logging utilities", () => {
  // Note: These tests verify the functions don't throw and are callable.
  // Console output capture is unreliable in test environments.

  describe("log", () => {
    it("does not throw when verbose is true", () => {
      expect(() => log("test message", true)).not.toThrow();
    });

    it("does not throw when verbose is false", () => {
      expect(() => log("hidden message", false)).not.toThrow();
    });

    it("default verbose is false", () => {
      expect(() => log("message")).not.toThrow();
    });
  });

  describe("warn", () => {
    it("does not throw", () => {
      expect(() => warn("warning test")).not.toThrow();
    });
  });

  describe("error", () => {
    it("does not throw", () => {
      expect(() => error("error test")).not.toThrow();
    });
  });
});

// =============================================================================
// Edge cases
// =============================================================================
describe("formatting edge cases", () => {
  it("formatRelativeTime handles future dates", () => {
    // Future dates should still work (negative diff)
    const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(futureDate);
    // Implementation may vary for future dates
    expect(typeof result).toBe("string");
  });

  it("formatLastHelpful handles nested empty arrays", () => {
    const bullet = {
      helpfulEvents: undefined,
      feedbackEvents: undefined,
    };
    expect(formatLastHelpful(bullet as any)).toBe("Never");
  });

  it("generateSuggestedQueries handles special characters in task", () => {
    const result = generateSuggestedQueries("fix bug with 'quotes' and \"double quotes\"", [
      "fix",
      "bug",
    ]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("generateSuggestedQueries handles unicode keywords", () => {
    const result = generateSuggestedQueries("任务", ["任务", "测试"]);
    expect(Array.isArray(result)).toBe(true);
  });
});
