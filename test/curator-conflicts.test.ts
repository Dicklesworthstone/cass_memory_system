import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { detectConflicts, findBulletConflicts, splitDirectiveClauses } from "../src/curate.js";
import type { PlaybookBullet } from "../src/types.js";
import { withTempDir } from "./helpers/temp.js";

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
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
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
      bullet("Always cache tokens without expiry"),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason.toLowerCase()).toContain("conflict");
  });

  it("does not treat an exception as an instruction to do the opposite", () => {
    const conflicts = detectConflicts("Always sanitize logs before storing", [
      bullet("Sanitize logs except when running locally"),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("allows a requirement to be satisfied while respecting an additional restriction", () => {
    const conflicts = detectConflicts("Never cache tokens without expiry", [
      bullet("Must cache tokens to improve speed"),
    ]);
    // Both instructions can be followed by caching tokens with an expiry.
    expect(conflicts).toEqual([]);
  });

  it("does not flag when overlap is low", () => {
    const conflicts = detectConflicts("Always sanitize logs", [
      bullet("Document API with OpenAPI"),
    ]);
    expect(conflicts.length).toBe(0);
  });
});

describe("issue #95 regression cases", () => {
  // The report provides abbreviated excerpts, not the complete playbook or
  // full rule texts. Keep these exact excerpts separate from the complete,
  // synthetic reproductions below; their omitted clauses are not known.
  const reportedExcerpts: Array<[string, string, string]> = [
    [
      "base revision and nightly-regression investigation",
      "When reviewing whether a change caused a defect, reproduce the defect against the base revision too...",
      "Before attributing or excluding responsibility for a nightly regression, establish the actual last-green and first-red revisions...",
    ],
    [
      "isolated test execution and review-tool file selection",
      "When a required full-suite run times out, run the directly changed test file separately...",
      "When testing uncommitted changes through tools/review/pool.py, supply the edited files with --include...",
    ],
    [
      "floating-point validation and the review blocking threshold",
      "When converting exact or bounded values to float, re-check finiteness after rounding...",
      "Apply the review contract's blocking threshold explicitly...",
    ],
  ];

  for (const [name, a, b] of reportedExcerpts) {
    it(`accepts the reported compatible excerpts: ${name}`, () => {
      expect(detectConflicts(a, [bullet(b)])).toEqual([]);
      expect(detectConflicts(b, [bullet(a)])).toEqual([]);
    });
  }

  const compatibleInstructions: Array<[string, string, string]> = [
    [
      "reproducing a defect and withholding premature blame",
      "Reproduce the defect on the base revision before attributing responsibility.",
      "Never attribute responsibility for the defect without reproducing it on the base revision.",
    ],
    [
      "establishing regression boundaries and withholding premature conclusions",
      "Always establish the last-green and first-red revisions before excluding responsibility for a nightly regression.",
      "Do not exclude responsibility for a nightly regression without establishing the last-green and first-red revisions.",
    ],
    [
      "running the changed test and selecting the changed test for review",
      "When a required full-suite run times out, run the changed test file separately.",
      "Never omit the changed test file when supplying edited files to the review tool.",
    ],
    [
      "numeric validation and review classification sharing generic terms",
      "Always validate bounded values before applying the conversion threshold.",
      "Never classify a review finding as blocking without applying the review threshold.",
    ],
  ];

  for (const [name, a, b] of compatibleInstructions) {
    it(`keeps complete complementary instructions compatible: ${name}`, () => {
      expect(detectConflicts(a, [bullet(b)])).toEqual([]);
      expect(detectConflicts(b, [bullet(a)])).toEqual([]);
    });
  }
});

describe("contradiction evidence", () => {
  const compatiblePairs: Array<[string, string, string]> = [
    ["different actions", "Always run regression tests", "Never delete regression tests"],
    ["different objects", "Always run integration tests", "Never run unit tests"],
    ["different environments", "Always deploy to staging", "Never deploy to production"],
    [
      "different actors",
      "Clients must retry failed requests",
      "Servers must not retry failed requests",
    ],
    [
      "negation in a relative clause",
      "Always use fixtures that do not contain secrets",
      "Use fixtures for tests",
    ],
    [
      "negation in an explanation",
      "Always run tests to avoid deployment failures",
      "Run tests before deployment",
    ],
    [
      "negation in a coordinated clause",
      "Always run regression tests, and never commit credentials",
      "Always run regression tests",
    ],
    [
      "an unrelated sentence",
      "Always run regression tests. Never commit credentials.",
      "Run regression tests before pushing",
    ],
    ["double negation", "Never skip regression tests", "Always run regression tests"],
    ["negated disabling", "Do not disable input validation", "Always enable input validation"],
    ["negated enabling", "Do not enable debug logging", "Always disable debug logging"],
    [
      "opposite conditional scopes",
      "When the network is available, enable remote caching",
      "When the network is unavailable, disable remote caching",
    ],
    [
      "opposite conditional truth values",
      "If the tests pass, deploy the release",
      "If the tests do not pass, do not deploy the release",
    ],
    [
      "a positive conditional exception",
      "Use local fixtures unless integration testing is required",
      "Use local fixtures for unit tests",
    ],
    [
      "a negative conditional exception",
      "Never deploy the release unless tests pass",
      "Deploy the release when tests pass",
    ],
    [
      "the same restriction using only-if and unless",
      "Only deploy the release if tests pass",
      "Never deploy the release unless tests pass",
    ],
    [
      "an additional prerequisite",
      "Run regression tests before deployment",
      "Run regression tests only when the test environment is ready",
    ],
    [
      "a prohibition on a subset and a compatible broader requirement",
      "Never delete production logs",
      "Delete logs to free disk space",
    ],
    [
      "a numeric adjective distinguishing objects",
      "Always enable HTTP/2 support",
      "Never enable HTTP/1 support",
    ],
    [
      "negation inside a quoted example",
      'Document the message "Do not run tests" in the troubleshooting guide',
      "Always run tests",
    ],
    [
      "a quoted example containing sentence boundaries",
      'Document the message "Stop. Never run regression tests. Done." in the guide',
      "Always run regression tests",
    ],
    [
      "a code example containing clause separators",
      "Document `message; never run regression tests; done` in the guide",
      "Always run regression tests",
    ],
    [
      "a contraction inside a single-quoted example",
      "Document 'Don't panic. Never run tests. Done' in the guide",
      "Always run tests",
    ],
    [
      "a contraction inside a curly-quoted example",
      "Document ‘Don’t panic. Never run tests. Done’ in the guide",
      "Always run tests",
    ],
    [
      "a necessary condition without a duty to act",
      "Only deploy the release if tests pass",
      "Never deploy the release",
    ],
    [
      "a suffix prerequisite without a duty to act",
      "Cache tokens only when expiry is configured",
      "Never cache tokens",
    ],
    [
      "modal negation in an indirect question",
      "Document why clients must retry failed requests",
      "Document why clients must not retry failed requests",
    ],
    ["distinct case-sensitive code identifiers", "Always use `ModeA`", "Never use `modea`"],
    [
      "opposite temporal qualifiers",
      "Always run tests after deployment",
      "Never run tests before deployment",
    ],
    [
      "stopping a process versus preventing a failure",
      "Never stop servers",
      "Stop servers from crashing",
    ],
    [
      "retaining data versus preventing its disclosure",
      "Never keep logs",
      "Keep logs from leaking",
    ],
    [
      "a nested parenthetical example",
      "Document (an example (from a previous guide). Never run tests. End)",
      "Always run tests",
    ],
    [
      "conditions shared across clauses of the same sentence",
      "When offline, run local tests; always enable local caching",
      "When online, never enable local caching",
    ],
  ];

  for (const [name, a, b] of compatiblePairs) {
    it(`does not assert a contradiction from ${name}`, () => {
      expect(detectConflicts(a, [bullet(b)])).toEqual([]);
      expect(detectConflicts(b, [bullet(a)])).toEqual([]);
    });
  }

  const opposingPairs: Array<[string, string, string]> = [
    ["direct imperatives", "Run regression tests", "Do not run regression tests"],
    ["always and never", "Always commit generated lockfiles", "Never commit generated lockfiles"],
    ["contractions", "Commit generated lockfiles", "Don't commit generated lockfiles"],
    ["curly contractions", "Commit generated lockfiles", "Don’t commit generated lockfiles"],
    [
      "modal negation",
      "Migrations must drop unused columns",
      "Migrations must not drop unused columns",
    ],
    ["avoiding an action", "Always sanitize user input", "Avoid sanitizing user input"],
    ["enable and disable", "Enable input validation", "Disable input validation"],
    [
      "matching prefix conditions",
      "When tests fail, block deployment",
      "When tests fail, do not block deployment",
    ],
    [
      "matching suffix conditions",
      "Block deployment when tests fail",
      "Do not block deployment when tests fail",
    ],
    [
      "a blanket prohibition and a specific action",
      "Never drop columns",
      "Drop unused columns",
    ],
    [
      "explicitly universal guidance and a scoped opposite",
      "Always sanitize logs",
      "Never sanitize logs when running locally",
    ],
    ["negation of skipping", "Never skip regression tests", "Always skip regression tests"],
    [
      "a blanket prohibition and a temporal specialization",
      "Never run tests",
      "Run tests before deployment",
    ],
    [
      "a blanket prohibition and an additional action qualifier",
      "Never commit generated lockfiles",
      "Commit generated lockfiles with dependency changes",
    ],
    [
      "matching conditions shared across clauses",
      "When offline, run local tests; always enable local caching",
      "When offline, never enable local caching",
    ],
  ];

  for (const [name, a, b] of opposingPairs) {
    it(`preserves direct contradiction detection for ${name}`, () => {
      const forward = detectConflicts(a, [bullet(b)]);
      const reverse = detectConflicts(b, [bullet(a)]);
      expect(forward).toHaveLength(1);
      expect(reverse).toHaveLength(1);
      expect(forward[0].reason.toLowerCase()).toContain("conflict");
      expect(reverse[0].reason.toLowerCase()).toContain("conflict");
    });
  }

  it("returns the actual opposing clauses as evidence, not unrelated clauses", () => {
    const a = { ...bullet("Always run regression tests; never commit credentials"), id: "b-a" };
    const b = { ...bullet("Never run regression tests; always document new APIs"), id: "b-b" };
    const pairs = findBulletConflicts([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].evidence.kind).toBe("opposite-directives");
    expect(pairs[0].evidence.aClause).toBe("Always run regression tests");
    expect(pairs[0].evidence.bClause).toBe("Never run regression tests");
    expect(pairs[0].evidence.action).toBeTruthy();
  });

  it("deduplicates multiple opposing clauses into one pair in deterministic input order", () => {
    const a = { ...bullet("Always run regression tests; always commit lockfiles"), id: "b-a" };
    const b = { ...bullet("Never run regression tests; never commit lockfiles"), id: "b-b" };
    const c = { ...bullet("Never commit lockfiles"), id: "b-c" };
    const pairs = findBulletConflicts([a, b, c]);
    expect(pairs.map(({ a, b }) => [a.id, b.id])).toEqual([
      ["b-a", "b-b"],
      ["b-a", "b-c"],
    ]);
    expect(findBulletConflicts([a, b, c])).toEqual(pairs);
  });

  it("skips all inactive representations while still checking draft candidates", () => {
    const a = { ...bullet("Always run regression tests"), id: "b-a", state: "draft" as const };
    const b = { ...bullet("Never run regression tests"), id: "b-b", state: "draft" as const };
    const retired = { ...b, id: "b-retired", state: "retired" as const };
    const deprecated = { ...b, id: "b-deprecated", deprecated: true };
    const maturity = { ...b, id: "b-maturity", maturity: "deprecated" as const };
    const bullets = [a, b, retired, deprecated, maturity];
    expect(findBulletConflicts(bullets).map(({ a, b }) => [a.id, b.id])).toEqual([["b-a", "b-b"]]);
    expect(detectConflicts(a.content, bullets).map(({ id }) => id)).toEqual(["b-b"]);
  });

  it("finds one genuine pair among thousands of rules sharing topic words", () => {
    const bullets = Array.from({ length: 3000 }, (_, index) => ({
      ...bullet(`Always validate service-${index} request payloads`),
      id: `b-service-${index}`,
    }));
    bullets.push({ ...bullet("Never validate service-1729 request payloads"), id: "b-opposite" });
    const pairs = findBulletConflicts(bullets);
    expect(pairs.length).toBe(1);
    expect(pairs.map(({ a, b }) => [a.id, b.id])).toEqual([["b-service-1729", "b-opposite"]]);
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

describe("conflict applicability from rule scope", () => {
  const scoped = (id: string, content: string, scope: Partial<PlaybookBullet>) => ({
    ...bullet(content), id, ...scope,
  });
  const positive = "Always commit generated lockfiles";
  const negative = "Never commit generated lockfiles";

  it("does not report opposing text from separate workspaces", () => {
    const a = scoped("b-a", positive, { scope: "workspace", workspace: "/scope-a" });
    const b = scoped("b-b", negative, { scope: "workspace", workspace: "/scope-b" });
    expect(findBulletConflicts([a, b])).toEqual([]);
    expect(detectConflicts(a.content, [b], a)).toEqual([]);
    expect(detectConflicts(b.content, [a], b)).toEqual([]);
  });

  it("preserves same-workspace, descendant-workspace and global opposition", () => {
    const a = scoped("b-a", positive, { scope: "workspace", workspace: "/scope-a" });
    for (const scope of [
      { scope: "workspace" as const, workspace: "/scope-a" },
      { scope: "workspace" as const, workspace: "/scope-a/src" },
      { scope: "global" as const },
    ]) {
      const b = scoped("b-b", negative, scope);
      expect(findBulletConflicts([a, b])).toHaveLength(1);
      expect(detectConflicts(a.content, [b], a)).toHaveLength(1);
      expect(detectConflicts(b.content, [a], b)).toHaveLength(1);
    }
  });

  it("does not infer the identity of a workspace rule with no workspace path", () => {
    const a = scoped("b-a", positive, { scope: "workspace", workspace: undefined });
    const b = scoped("b-b", negative, { scope: "global" });
    expect(findBulletConflicts([a, b])).toEqual([]);
    expect(detectConflicts(a.content, [b], a)).toEqual([]);
  });

  it("does not cross a nested independent repository boundary", async () => {
    await withTempDir("conflict-scope", async (dir) => {
      const nested = path.join(dir, "vendor", "other-project");
      await mkdir(path.join(dir, ".git"));
      await mkdir(path.join(nested, ".git"), { recursive: true });
      const a = scoped("b-a", positive, { scope: "workspace", workspace: dir });
      const b = scoped("b-b", negative, { scope: "workspace", workspace: nested });
      expect(findBulletConflicts([a, b])).toEqual([]);
    });
  });

  for (const scope of ["language", "framework", "task"] as const) {
    it(`respects distinct explicit ${scope} selectors`, () => {
      const a = scoped("b-a", positive, { scope, scopeKey: "scope-a" });
      const b = scoped("b-b", negative, { scope, scopeKey: "scope-b" });
      expect(findBulletConflicts([a, b])).toEqual([]);
      expect(detectConflicts(a.content, [b], a)).toEqual([]);
      expect(findBulletConflicts([a, { ...b, scopeKey: "scope-a" }])).toHaveLength(1);
      expect(findBulletConflicts([a, { ...b, scope: "global" }])).toHaveLength(1);
    });
  }
});
