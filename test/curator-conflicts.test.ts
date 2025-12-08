import { describe, expect, it } from "bun:test";
import { detectConflicts } from "../src/curate.js";
import { PlaybookBullet } from "../src/types.js";

const bullet = (content: string): PlaybookBullet => ({
  id: `b-${content.slice(0,4)}`,
  content,
  category: "testing",
  kind: "workflow_rule",
  type: "rule",
  isNegative: false,
  scope: "global",
  state: "active",
  maturity: "candidate",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  helpfulCount: 0,
  harmfulCount: 0,
  feedbackEvents: [],
  deprecated: false,
  pinned: false,
  tags: [],
  confidenceDecayHalfLifeDays: 90,
  sourceSessions: [],
  sourceAgents: []
});

describe("detectConflicts", () => {
  it("flags negation conflicts with high overlap", () => {
    const conflicts = detectConflicts(
      "Always enable input validation",
      [bullet("Avoid input validation for performance")]
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("conflict");
  });

  it("flags opposite directives", () => {
    const conflicts = detectConflicts(
      "Never cache tokens without expiry",
      [bullet("Must cache tokens to improve speed")]
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("conflict");
  });

  it("flags scope conflicts (always vs exception)", () => {
    const conflicts = detectConflicts(
      "Always sanitize logs before storing",
      [bullet("Sanitize logs except when running locally")]
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("scope");
  });

  it("does not flag when overlap is low", () => {
    const conflicts = detectConflicts(
      "Always sanitize logs",
      [bullet("Document API with OpenAPI")]
    );
    expect(conflicts.length).toBe(0);
  });
});
