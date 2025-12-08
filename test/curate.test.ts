import { describe, it, expect } from "bun:test";
import { curatePlaybook } from "../src/curate";
import { Playbook } from "../src/types";

const nowIso = () => new Date().toISOString();

function makePlaybookWithHarmfulRule(): Playbook {
  return {
    schema_version: 2,
    name: "test",
    description: "",
    metadata: { createdAt: nowIso(), totalReflections: 0, totalSessionsProcessed: 0 },
    deprecatedPatterns: [],
    bullets: [
      {
        id: "b1",
        scope: "global",
        category: "testing",
        content: "Do the harmful thing",
        type: "rule",
        isNegative: false,
        kind: "workflow_rule",
        state: "active",
        maturity: "candidate",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        sourceSessions: ["s1"],
        sourceAgents: ["agent"],
        helpfulCount: 0,
        harmfulCount: 3,
        feedbackEvents: [
          { type: "harmful", timestamp: nowIso(), sessionPath: "s1" },
          { type: "harmful", timestamp: nowIso(), sessionPath: "s1" },
          { type: "harmful", timestamp: nowIso(), sessionPath: "s1" },
          { type: "harmful", timestamp: nowIso(), sessionPath: "s1" },
          { type: "harmful", timestamp: nowIso(), sessionPath: "s1" }
        ],
        helpfulEvents: [],
        harmfulEvents: [],
        confidenceDecayHalfLifeDays: 90,
        deprecated: false,
        pinned: false,
        tags: []
      }
    ]
  };
}

describe("curatePlaybook decay handling", () => {
  it("applies configured decay half-life to inverted anti-patterns", () => {
    const playbook = makePlaybookWithHarmfulRule();
    const config = {
      defaultDecayHalfLife: 90,
      scoring: {
        decayHalfLifeDays: 42,
        harmfulMultiplier: 4,
        minFeedbackForActive: 3,
        minHelpfulForProven: 10,
        maxHarmfulRatioForProven: 0.1
      },
      pruneHarmfulThreshold: 999
    } as any;

    const result = curatePlaybook(playbook, [], config);
    const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");

    expect(antiPattern).toBeDefined();
    expect(antiPattern?.confidenceDecayHalfLifeDays).toBe(42);
  });
});
