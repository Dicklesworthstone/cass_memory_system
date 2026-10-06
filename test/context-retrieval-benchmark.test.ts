/**
 * Retrieval benchmark for `cm context` ranking (#89).
 *
 * A realistic playbook (specific rules across many topics, plus generic
 * process rules carrying lots of helpful marks, the failure mode #89 measured)
 * and labelled queries phrased the way agents ask, with inflections.
 *
 * The incumbent ranker (pre-#89: unweighted keyword counts multiplied by the
 * raw effective score) is reconstructed here and run on the same data, so the
 * comparison is live in one invocation rather than against a remembered number.
 */
import { describe, expect, test } from "bun:test";
import { scoreBulletsKeyword, selectContextBullets } from "../src/commands/context.js";
import { getEffectiveScore } from "../src/scoring.js";
import type { FeedbackEvent, PlaybookBullet, ScoredBullet } from "../src/types.js";
import { extractKeywords, tokenize } from "../src/utils.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";

function helpful(n: number): FeedbackEvent[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    type: "helpful",
    timestamp: new Date(now - i * 86_400_000).toISOString(),
  })) as FeedbackEvent[];
}

const SPECIFIC: Array<[string, string, string[]]> = [
  ["pg-concurrent", "Create Postgres indexes with CREATE INDEX CONCURRENTLY so migrations do not lock large tables", ["postgres", "migrations"]],
  ["pg-txn", "Wrap each database migration in a transaction and make it reversible with a down step", ["postgres", "migrations"]],
  ["pg-pool", "Cap the Postgres connection pool below max_connections divided by the number of app instances", ["postgres"]],
  ["jwt-refresh", "Refresh JWT access tokens a minute before expiry; never wait for a 401 to trigger refresh", ["auth", "jwt"]],
  ["jwt-rotate", "Rotate JWT signing keys with a kid header so old tokens validate during the overlap window", ["auth", "jwt"]],
  ["oauth-state", "Always verify the OAuth state parameter on the callback to block CSRF login attacks", ["auth", "oauth"]],
  ["react-effect-deps", "List every value a React useEffect reads in its dependency array; stale closures cause ghost bugs", ["react"]],
  ["react-keys", "Use stable unique keys for React list items, never the array index when items reorder", ["react"]],
  ["react-memo", "Memoize expensive React child props with useMemo only after profiling shows a re-render cost", ["react", "performance"]],
  ["docker-layers", "Copy the lockfile and install dependencies before copying source so Docker caches the install layer", ["docker"]],
  ["docker-nonroot", "Run containers as a non-root user and drop capabilities in the Dockerfile", ["docker", "security"]],
  ["k8s-probes", "Set Kubernetes readiness probes separately from liveness probes so slow startups are not restarted", ["kubernetes"]],
  ["k8s-limits", "Give every Kubernetes pod CPU and memory requests and limits to avoid noisy-neighbor evictions", ["kubernetes"]],
  ["redis-ttl", "Put a TTL on every Redis cache key; unbounded keys eventually trigger eviction storms", ["redis", "cache"]],
  ["redis-stampede", "Prevent cache stampedes with a short lock or request coalescing when a hot Redis key expires", ["redis", "cache"]],
  ["git-rebase", "Rebase feature branches onto main before merging and resolve conflicts locally, not in the web UI", ["git"]],
  ["git-force", "Use git push --force-with-lease instead of --force so you never clobber a teammate's commits", ["git"]],
  ["ts-strict-null", "Enable strictNullChecks and narrow optional values instead of using non-null assertions", ["typescript"]],
  ["ts-zod-boundary", "Validate external JSON with zod at the boundary and derive TypeScript types from the schema", ["typescript", "validation"]],
  ["rate-limit-429", "On HTTP 429 respect the Retry-After header and back off exponentially with jitter", ["api", "http"]],
  ["timeouts", "Set explicit timeouts on outbound HTTP calls; library defaults are often infinite", ["http"]],
  ["bun-test-timeout", "Raise the bun test timeout for e2e suites in bunfig.toml instead of per-test overrides", ["bun", "testing"]],
  ["flaky-tests", "Quarantine nothing: fix flaky tests by removing shared global state and real clock dependencies", ["testing"]],
  ["log-structured", "Emit structured JSON logs with request ids so a single request can be traced across services", ["logging"]],
  ["secrets-env", "Load secrets from the environment or a secret manager; never commit .env files to git", ["security"]],
];

// Generic process advice that real playbooks accumulate and that collects
// many helpful marks because it is shown on every task (#89).
const GENERIC: Array<[string, string, number]> = [
  ["gen-tests", "Always run the full test suite before you push any change", 40],
  ["gen-small-prs", "Keep pull requests small and focused on a single change", 35],
  ["gen-read-first", "Read the surrounding code before changing it and follow its conventions", 30],
  ["gen-commit-msg", "Write commit messages that explain why the change was made", 25],
  ["gen-ask", "Ask for clarification when the task description is ambiguous", 20],
  ["gen-docs", "Update the documentation in the same change as the code it describes", 20],
];

const QUERIES: Array<[string, string]> = [
  ["add an index to a big postgres table without downtime", "pg-concurrent"],
  ["our migration locked the users table in production", "pg-concurrent"],
  ["how should database migrations be written so they can be rolled back", "pg-txn"],
  ["too many postgres connections errors after scaling up", "pg-pool"],
  ["users get logged out when their jwt expires", "jwt-refresh"],
  ["rotating the token signing key broke existing sessions", "jwt-rotate"],
  ["fix csrf in the oauth login callback", "oauth-state"],
  ["useEffect runs with stale values", "react-effect-deps"],
  ["list items lose their input state when reordered in react", "react-keys"],
  ["docker build reinstalls dependencies on every source change", "docker-layers"],
  ["container security hardening for the dockerfile", "docker-nonroot"],
  ["pods keep restarting during slow startup", "k8s-probes"],
  ["redis memory keeps growing and keys get evicted", "redis-ttl"],
  ["thundering herd when a hot cache key expires", "redis-stampede"],
  ["accidentally overwrote a colleague's commits with a force push", "git-force"],
  ["avoid non-null assertions in typescript", "ts-strict-null"],
  ["validating untrusted json payloads in typescript", "ts-zod-boundary"],
  ["api keeps returning 429 too many requests", "rate-limit-429"],
  ["requests hang forever when the upstream service is down", "timeouts"],
  ["e2e tests time out under bun", "bun-test-timeout"],
  ["trace one request across microservices in the logs", "log-structured"],
  ["where should api secrets live", "secrets-env"],
];

function playbook(): PlaybookBullet[] {
  return [
    ...SPECIFIC.map(([id, content, tags]) =>
      createTestBullet({ id, content, tags, category: tags[0], maturity: "established" }),
    ),
    ...GENERIC.map(([id, content, marks]) =>
      createTestBullet({
        id,
        content,
        category: "workflow",
        maturity: "proven",
        feedbackEvents: helpful(marks),
        helpfulCount: marks,
      }),
    ),
  ];
}

/** The pre-#89 ranker, reconstructed exactly: +3 exact token, +1 substring, +5 tag; x max(0.1, effectiveScore). */
function incumbentRank(bullets: PlaybookBullet[], keywords: string[]): ScoredBullet[] {
  const config = createTestConfig();
  const kws = Array.from(new Set(keywords.map((k) => k.toLowerCase())));
  return bullets
    .map((b) => {
      const content = b.content.toLowerCase();
      const tokens = new Set(tokenize(content));
      const tags = b.tags.map((t) => t.toLowerCase());
      let relevance = 0;
      for (const k of kws) {
        if (tokens.has(k)) relevance += 3;
        else if (content.includes(k)) relevance += 1;
        if (tags.includes(k)) relevance += 5;
      }
      const effectiveScore = getEffectiveScore(b, config);
      return {
        ...b,
        relevanceScore: relevance,
        effectiveScore,
        finalScore: relevance * Math.max(0.1, effectiveScore),
      };
    })
    .filter((b) => b.relevanceScore >= config.minRelevanceScore)
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}

function currentRank(bullets: PlaybookBullet[], keywords: string[]): ScoredBullet[] {
  const config = createTestConfig();
  const scored = scoreBulletsKeyword(bullets, keywords, config);
  return selectContextBullets(scored, {
    maxBullets: 50,
    minRelevance: config.minRelevanceScore,
    minRelativeRelevance: config.minRelativeRelevance,
    tokenBudget: 0,
  }).selected;
}

function evaluate(rank: (b: PlaybookBullet[], k: string[]) => ScoredBullet[], k: number) {
  const bullets = playbook();
  let hits = 0;
  let reciprocal = 0;
  let genericInTopK = 0;
  let genericAboveExpected = 0;
  for (const [query, expected] of QUERIES) {
    const ids = rank(bullets, extractKeywords(query)).map((b) => b.id);
    const pos = ids.indexOf(expected);
    if (pos >= 0 && pos < k) hits++;
    if (pos >= 0) reciprocal += 1 / (pos + 1);
    genericInTopK += ids.slice(0, k).filter((id) => id.startsWith("gen-")).length;
    const cutoff = pos >= 0 ? pos : ids.length;
    if (ids.slice(0, cutoff).some((id) => id.startsWith("gen-"))) genericAboveExpected++;
  }
  return {
    recallAtK: hits / QUERIES.length,
    mrr: reciprocal / QUERIES.length,
    genericInTopK,
    genericAboveExpected,
  };
}

describe("context retrieval benchmark (#89)", () => {
  const K = 3;
  const incumbent = evaluate(incumbentRank, K);
  const current = evaluate(currentRank, K);

  test("reports incumbent vs current on the same data", () => {
    // Visible in test output so a ranking change shows its real effect.
    console.log(
      `[retrieval-benchmark] recall@${K}: incumbent ${incumbent.recallAtK.toFixed(2)} -> current ${current.recallAtK.toFixed(2)}; ` +
        `MRR: ${incumbent.mrr.toFixed(2)} -> ${current.mrr.toFixed(2)}; ` +
        `generic rules in top-${K}: ${incumbent.genericInTopK} -> ${current.genericInTopK}; ` +
        `queries where a generic rule outranks the right one: ${incumbent.genericAboveExpected} -> ${current.genericAboveExpected}`,
    );
    expect(QUERIES.length).toBeGreaterThanOrEqual(20);
  });

  test("current ranking is at least as good as the incumbent on recall and MRR", () => {
    expect(current.recallAtK).toBeGreaterThanOrEqual(incumbent.recallAtK);
    expect(current.mrr).toBeGreaterThanOrEqual(incumbent.mrr);
  });

  // "Crowding out" = a generic rule ranked ABOVE the rule that answers the
  // query; a generic rule shown below the right answer costs tokens, not recall.
  test("heavily-marked generic rules do not crowd relevant ones out", () => {
    expect(current.genericInTopK).toBeLessThanOrEqual(incumbent.genericInTopK);
    expect(current.genericAboveExpected).toBeLessThanOrEqual(incumbent.genericAboveExpected);
    expect(current.genericAboveExpected).toBeLessThanOrEqual(1);
  });

  test("absolute floor: the right rule is in the top 3 for most queries", () => {
    expect(current.recallAtK).toBeGreaterThanOrEqual(0.8);
  });
});
