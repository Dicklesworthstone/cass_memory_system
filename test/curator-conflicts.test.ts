import { describe, expect, it } from "bun:test";
import { detectConflicts, findBulletConflicts, splitDirectiveClauses } from "../src/curate.js";
import type { PlaybookBullet } from "../src/types.js";

const bullet = (content: string): PlaybookBullet => ({
  id: `b-${content.slice(0, 4)}`,
  content,
  category: "testing",
  kind: "workflow_rule",
  type: "rule",
  isNegative: false,
  scope: "global",
  source: "learned",
  state: "active",
  maturity: "candidate",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  helpfulCount: 0,
  harmfulCount: 0,
  feedbackEvents: [],
  confidenceDecayHalfLifeDays: 90,
  deprecated: false,
  pinned: false,
  tags: [],
  sourceSessions: [],
  sourceAgents: [],
});

describe("detectConflicts", () => {
  it("flags negation conflicts with high overlap", () => {
    const conflicts = detectConflicts("Always enable input validation", [
      bullet("Avoid input validation for performance"),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("conflict");
  });

  it("flags opposite directives", () => {
    const conflicts = detectConflicts("Never cache tokens without expiry", [
      bullet("Must cache tokens to improve speed"),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("conflict");
  });

  it("flags scope conflicts (always vs exception)", () => {
    const conflicts = detectConflicts("Always sanitize logs before storing", [
      bullet("Sanitize logs except when running locally"),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("scope");
  });

  it("does not flag when overlap is low", () => {
    const conflicts = detectConflicts("Always sanitize logs", [
      bullet("Document API with OpenAPI"),
    ]);
    expect(conflicts.length).toBe(0);
  });
});

describe("clause-level conflict detection", () => {
  it("does not flag rules whose negation sits in an unrelated clause (former false positives)", () => {
    const pairs: Array<[string, string]> = [
      [
        "Validate inputs at boundaries (CLI args, HTTP payloads, env) before use.",
        "Load configuration once at startup and validate required env vars; avoid reading env at runtime hotspots.",
      ],
      [
        "Emit structured logs with request/task identifiers at boundaries.",
        "Log structured context (request id, user, model) using a shared logger; avoid print.",
      ],
      [
        "Set sane timeouts and retries for all outbound network calls.",
        "Set explicit timeouts on HTTP and DB operations; never rely on defaults.",
      ],
      [
        "Use stable unique keys for lists; avoid array index keys when order can change.",
        "Use thiserror/anyhow for rich errors; avoid unwrap/expect in library code.",
      ],
    ];
    for (const [a, b] of pairs) {
      expect(detectConflicts(a, [bullet(b)])).toEqual([]);
    }
  });

  it("flags opposite directives on the same subject, including inflected forms", () => {
    expect(
      detectConflicts("Use mocks for the database in unit tests", [
        bullet("Never mock the database in unit tests; use a real temp database"),
      ]),
    ).toHaveLength(1);
    expect(
      detectConflicts("Do not commit generated lockfiles", [bullet("Always commit generated lockfiles")]),
    ).toHaveLength(1);
  });

  it("treats 'must not' as negative even though it contains 'must'", () => {
    expect(
      detectConflicts("Migrations must not drop columns", [bullet("Migrations should drop unused columns")]),
    ).toHaveLength(1);
  });

  it("splits clauses on sentence ends and semicolons but not inside node.js-style tokens", () => {
    const clauses = splitDirectiveClauses("Run node.js tests first; never skip the lint step. Done");
    expect(clauses).toHaveLength(3);
    expect(clauses[1].polarity).toBe("negative");
    expect(clauses[0].polarity).toBe("neutral");
  });

  it("findBulletConflicts reports each pair once and skips deprecated bullets", () => {
    const a = { ...bullet("Always commit generated lockfiles"), id: "b-a" };
    const b = { ...bullet("Never commit generated lockfiles"), id: "b-b" };
    const c = { ...bullet("Never commit generated lockfiles to main"), id: "b-c", deprecated: true };
    const pairs = findBulletConflicts([a, b, c]);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.id, pairs[0].b.id]).toEqual(["b-a", "b-b"]);
    expect(findBulletConflicts([])).toEqual([]);
  });
});
