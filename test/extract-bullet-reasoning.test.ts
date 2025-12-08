import { describe, expect, it } from "bun:test";
import { extractBulletReasoning } from "../src/utils.js";

describe("extractBulletReasoning", () => {
  it("returns explicit reasoning when set", () => {
    const bullet = { reasoning: "JWT expiry caused silent auth failures" };
    expect(extractBulletReasoning(bullet)).toBe("JWT expiry caused silent auth failures");
  });

  it("returns key evidence when reasoning not set", () => {
    const bullet = {
      derivedFrom: {
        keyEvidence: ["Token refresh interval was too short"]
      }
    };
    expect(extractBulletReasoning(bullet)).toBe("Token refresh interval was too short");
  });

  it("joins multiple key evidence items", () => {
    const bullet = {
      derivedFrom: {
        keyEvidence: ["First issue", "Second issue"]
      }
    };
    expect(extractBulletReasoning(bullet)).toBe("First issue; Second issue");
  });

  it("falls back to session metadata", () => {
    const bullet = {
      sourceAgents: ["claude"],
      createdAt: "2025-11-15T10:00:00Z"
    };
    expect(extractBulletReasoning(bullet)).toBe("From claude session on 11/15/2025");
  });

  it("uses derivedFrom.extractedBy when sourceAgents not available", () => {
    const bullet = {
      derivedFrom: {
        extractedBy: "cursor",
        timestamp: "2025-12-01T14:30:00Z"
      }
    };
    expect(extractBulletReasoning(bullet)).toBe("From cursor session on 12/1/2025");
  });

  it("returns 'No reasoning available' for empty bullet", () => {
    expect(extractBulletReasoning({})).toBe("No reasoning available");
  });

  it("truncates long reasoning to 200 chars", () => {
    const longReasoning = "A".repeat(250);
    const bullet = { reasoning: longReasoning };
    const result = extractBulletReasoning(bullet);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith("...")).toBe(true);
  });

  it("preserves first sentence when truncating", () => {
    // First sentence is ~30 chars, total is > 200 chars
    const bullet = {
      reasoning: "This is the first sentence. This is a much longer second sentence that goes on and on and on and continues for quite a while to exceed the maximum length limit of two hundred characters which is quite long indeed."
    };
    const result = extractBulletReasoning(bullet);
    expect(result).toBe("This is the first sentence.");
  });

  it("handles whitespace-only reasoning", () => {
    const bullet = { reasoning: "   " };
    expect(extractBulletReasoning(bullet)).toBe("No reasoning available");
  });

  it("handles empty key evidence array", () => {
    const bullet = {
      derivedFrom: { keyEvidence: [] }
    };
    expect(extractBulletReasoning(bullet)).toBe("No reasoning available");
  });

  it("filters empty strings from key evidence", () => {
    const bullet = {
      derivedFrom: {
        keyEvidence: ["", "Valid evidence", "  "]
      }
    };
    expect(extractBulletReasoning(bullet)).toBe("Valid evidence");
  });

  it("handles invalid timestamp gracefully", () => {
    const bullet = {
      sourceAgents: ["claude"],
      createdAt: "not-a-date"
    };
    expect(extractBulletReasoning(bullet)).toBe("From claude session on unknown date");
  });

  it("prefers reasoning over derivedFrom", () => {
    const bullet = {
      reasoning: "Explicit reasoning",
      derivedFrom: {
        keyEvidence: ["Key evidence that should not appear"]
      }
    };
    expect(extractBulletReasoning(bullet)).toBe("Explicit reasoning");
  });

  it("prefers derivedFrom over session metadata", () => {
    const bullet = {
      derivedFrom: {
        keyEvidence: ["Key evidence"]
      },
      sourceAgents: ["claude"],
      createdAt: "2025-11-15T10:00:00Z"
    };
    expect(extractBulletReasoning(bullet)).toBe("Key evidence");
  });

  it("handles agent only (no timestamp)", () => {
    const bullet = { sourceAgents: ["cursor"] };
    expect(extractBulletReasoning(bullet)).toBe("From cursor session on unknown date");
  });

  it("handles timestamp only (no agent)", () => {
    const bullet = { createdAt: "2025-12-07T10:00:00Z" };
    expect(extractBulletReasoning(bullet)).toBe("From unknown session on 12/7/2025");
  });
});
