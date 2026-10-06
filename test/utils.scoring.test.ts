/**
 * Unit Tests: context retrieval ranking (#89)
 *
 * - scoreLexicalRelevance: corpus-aware BM25, 0..10 scale
 * - stemToken: conservative suffix stemming
 * - getFeedbackMultiplier: bounded, damped feedback signal
 * - selectContextBullets: relevance floors, count limit, token budget
 */
import { describe, expect, test } from "bun:test";
import { scoreBulletsKeyword, selectContextBullets } from "../src/commands/context.js";
import { getFeedbackMultiplier } from "../src/scoring.js";
import type { FeedbackEvent, PlaybookBullet, ScoredBullet } from "../src/types.js";
import { scoreLexicalRelevance, stemToken } from "../src/utils.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";

const doc = (id: string, content: string, tags: string[] = []) => ({ id, content, tags });

function events(type: "helpful" | "harmful", count: number): FeedbackEvent[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, () => ({ type, timestamp: now }) as FeedbackEvent);
}

describe("stemToken", () => {
  test("strips common inflections", () => {
    expect(stemToken("deploying")).toBe("deploy");
    expect(stemToken("deployed")).toBe("deploy");
    expect(stemToken("deploys")).toBe("deploy");
    expect(stemToken("libraries")).toBe("library");
    expect(stemToken("patches")).toBe("patch");
  });

  test("leaves short, technical and -ss/-us/-is tokens alone", () => {
    expect(stemToken("bus")).toBe("bus");
    expect(stemToken("node.js")).toBe("node.js");
    expect(stemToken("user_id")).toBe("user_id");
    expect(stemToken("class")).toBe("class");
    expect(stemToken("status")).toBe("status");
    expect(stemToken("analysis")).toBe("analysis");
  });
});

describe("scoreLexicalRelevance", () => {
  test("empty corpus returns an empty map", () => {
    expect(scoreLexicalRelevance([], ["auth"]).size).toBe(0);
  });

  test("no keywords scores every doc 0", () => {
    const scores = scoreLexicalRelevance([doc("a", "use jwt"), doc("b", "use oauth")], []);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
  });

  test("non-matching docs score 0, matching docs score in (0, 10]", () => {
    const scores = scoreLexicalRelevance(
      [doc("a", "Rotate JWT signing keys monthly"), doc("b", "Prefer bun over npm")],
      ["jwt"],
    );
    expect(scores.get("b")).toBe(0);
    expect(scores.get("a")!).toBeGreaterThan(0);
    expect(scores.get("a")!).toBeLessThanOrEqual(10);
  });

  test("rare terms outweigh common ones (IDF)", () => {
    const corpus = [
      doc("rare", "Add the postgres migration behind a feature flag"),
      doc("common1", "Always run tests before committing"),
      doc("common2", "Run tests in CI and locally"),
      doc("common3", "Tests must be deterministic"),
    ];
    // Each doc matches exactly one query term; the one matching the rare term wins.
    const scores = scoreLexicalRelevance(corpus, ["tests", "postgres"]);
    expect(scores.get("rare")!).toBeGreaterThan(scores.get("common1")!);
    expect(scores.get("common1")!).toBeGreaterThan(0);
  });

  test("covering more of the query scores higher", () => {
    const corpus = [
      doc("both", "Retry flaky network calls with exponential backoff"),
      doc("one", "Network timeouts default to thirty seconds"),
      doc("none", "Use zod for schema validation"),
    ];
    const scores = scoreLexicalRelevance(corpus, ["network", "backoff"]);
    expect(scores.get("both")!).toBeGreaterThan(scores.get("one")!);
    expect(scores.get("one")!).toBeGreaterThan(0);
  });

  test("query terms absent from the corpus still count in the denominator", () => {
    const corpus = [doc("a", "Prefer bun for scripts"), doc("b", "Pin versions in CI")];
    const full = scoreLexicalRelevance(corpus, ["bun"]).get("a")!;
    const partial = scoreLexicalRelevance(corpus, ["bun", "kubernetes"]).get("a")!;
    expect(partial).toBeLessThan(full);
  });

  test("matches inflected forms via stemming and prefixes", () => {
    const corpus = [doc("a", "Deployed services need health checks"), doc("b", "Unrelated rule")];
    expect(scoreLexicalRelevance(corpus, ["deploying"]).get("a")!).toBeGreaterThan(0);
    // "auth" is a prefix of "authentication": partial match.
    const prefix = scoreLexicalRelevance(
      [doc("a", "Use authentication middleware"), doc("b", "Unrelated rule")],
      ["auth"],
    );
    expect(prefix.get("a")!).toBeGreaterThan(0);
  });

  test("tag matches count more than a single content occurrence", () => {
    const corpus = [
      doc("tagged", "Keep handlers small", ["security"]),
      doc("content", "Review security of handlers"),
      doc("other", "Unrelated rule"),
    ];
    const scores = scoreLexicalRelevance(corpus, ["security"]);
    expect(scores.get("tagged")!).toBeGreaterThan(scores.get("content")!);
  });

  test("is case insensitive", () => {
    const scores = scoreLexicalRelevance([doc("a", "TypeScript strict mode"), doc("b", "x")], [
      "TYPESCRIPT",
    ]);
    expect(scores.get("a")!).toBeGreaterThan(0);
  });
});

describe("getFeedbackMultiplier", () => {
  const config = createTestConfig();

  test("unmarked bullet is neutral", () => {
    expect(getFeedbackMultiplier(createTestBullet({ feedbackEvents: [] }), config)).toBe(1);
  });

  test("helpful marks raise it, harmful marks lower it, both bounded by feedbackWeight", () => {
    const good = getFeedbackMultiplier(
      createTestBullet({ feedbackEvents: events("helpful", 50) }),
      config,
    );
    const bad = getFeedbackMultiplier(
      createTestBullet({ feedbackEvents: events("harmful", 50) }),
      config,
    );
    expect(good).toBeGreaterThan(1);
    expect(good).toBeLessThanOrEqual(1.1);
    expect(bad).toBeLessThan(1);
    expect(bad).toBeGreaterThanOrEqual(0.9);
  });

  test("few marks move it less than many marks (damping)", () => {
    const one = getFeedbackMultiplier(createTestBullet({ feedbackEvents: events("helpful", 1) }), config);
    const many = getFeedbackMultiplier(
      createTestBullet({ feedbackEvents: events("helpful", 20) }),
      config,
    );
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThan(many);
    expect(one - 1).toBeLessThan(0.05);
  });

  test("feedbackWeight 0 ignores feedback; pinned gets full positive weight", () => {
    const zero = createTestConfig({ feedbackWeight: 0 });
    expect(
      getFeedbackMultiplier(createTestBullet({ feedbackEvents: events("harmful", 9) }), zero),
    ).toBe(1);
    expect(getFeedbackMultiplier(createTestBullet({ pinned: true }), config)).toBe(1.1);
  });
});

describe("ranking: feedback reorders, relevance decides (#89)", () => {
  test("a heavily marked, weakly relevant rule does not outrank a strongly relevant one", () => {
    const config = createTestConfig();
    const general: PlaybookBullet = createTestBullet({
      id: "general",
      content: "Always run the full test suite before you push any database change",
      feedbackEvents: events("helpful", 40),
      maturity: "proven",
    });
    const specific: PlaybookBullet = createTestBullet({
      id: "specific",
      content: "Postgres migration locks: add indexes concurrently to avoid table locks",
      feedbackEvents: [],
    });
    const filler = Array.from({ length: 6 }, (_, i) =>
      createTestBullet({ id: `filler-${i}`, content: `Unrelated guidance number ${i}` }),
    );
    const ranked = scoreBulletsKeyword(
      [general, specific, ...filler],
      ["postgres", "migration", "locks", "database"],
      config,
    );
    expect(ranked[0].id).toBe("specific");
  });

  test("among equally relevant rules, the better track record wins", () => {
    const config = createTestConfig();
    const a = createTestBullet({ id: "a", content: "Cache invalidation needs explicit keys" });
    const b = createTestBullet({
      id: "b",
      content: "Cache invalidation needs explicit keys",
      feedbackEvents: events("helpful", 10),
    });
    const ranked = scoreBulletsKeyword([a, b], ["cache", "invalidation"], config);
    expect(ranked[0].id).toBe("b");
  });
});

describe("selectContextBullets", () => {
  function scored(id: string, relevance: number, content = `rule ${id}`): ScoredBullet {
    return {
      ...createTestBullet({ id, content }),
      relevanceScore: relevance,
      effectiveScore: 0,
      finalScore: relevance,
    };
  }
  const base = { maxBullets: 10, minRelevance: 0.1, minRelativeRelevance: 0, tokenBudget: 0 };

  test("empty input returns nothing", () => {
    const { selected, stats } = selectContextBullets([], base);
    expect(selected).toEqual([]);
    expect(stats.candidates).toBe(0);
    expect(stats.returned).toBe(0);
  });

  test("applies the absolute and relative relevance floors", () => {
    const input = [scored("a", 8), scored("b", 3), scored("c", 1), scored("d", 0)];
    const { selected, stats } = selectContextBullets(input, { ...base, minRelativeRelevance: 0.25 });
    expect(selected.map((b) => b.id)).toEqual(["a", "b"]);
    expect(stats.droppedByRelevance).toBe(2);
  });

  test("caps at maxBullets", () => {
    const input = [scored("a", 5), scored("b", 4), scored("c", 3)];
    const { selected, stats } = selectContextBullets(input, { ...base, maxBullets: 2 });
    expect(selected.map((b) => b.id)).toEqual(["a", "b"]);
    expect(stats.droppedByLimit).toBe(1);
  });

  test("stops at the token budget but always keeps the top bullet", () => {
    const long = "x ".repeat(2000);
    const input = [scored("a", 5, long), scored("b", 4, long), scored("c", 3)];
    const { selected, stats } = selectContextBullets(input, { ...base, tokenBudget: 50 });
    expect(selected.map((b) => b.id)).toEqual(["a"]);
    expect(stats.droppedByTokenBudget).toBe(2);
    expect(stats.estimatedTokens).toBeGreaterThan(50);
  });

  test("budget 0 means unlimited", () => {
    const long = "x ".repeat(2000);
    const input = [scored("a", 5, long), scored("b", 4, long)];
    expect(selectContextBullets(input, base).selected).toHaveLength(2);
  });
});
