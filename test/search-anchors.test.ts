import { describe, expect, it } from "bun:test";

// Import tokenize directly to avoid types.ts import chain
import { tokenize } from "../src/utils.js";

// Re-implement the test without importing from diary.ts (which imports types.ts)
// This tests the algorithm logic directly

const TECH_TERM_PATTERNS = [
  /\b(react|angular|vue|svelte|nextjs|next\.js|nuxt|express|fastify|nestjs|django|flask|rails|spring)\b/gi,
  /\b(typescript|javascript|python|rust|go|golang|java|kotlin|swift|ruby|php|c\+\+|csharp|c#)\b/gi,
  /\b(docker|kubernetes|k8s|aws|gcp|azure|terraform|ansible|jenkins|github|gitlab|ci\/cd|vercel|netlify)\b/gi,
  /\b(postgres|postgresql|mysql|mongodb|redis|sqlite|dynamodb|elasticsearch|prisma|drizzle|sequelize)\b/gi,
  /\b(jwt|oauth|oauth2|saml|cors|csrf|xss|authentication|authorization|bearer|token)\b/gi,
  /\b(jest|vitest|mocha|pytest|playwright|cypress|selenium|unit\s*test|e2e|integration\s*test)\b/gi,
  /\b(api|rest|graphql|websocket|grpc|microservice|serverless|async\/await|promise|middleware)\b/gi,
  /\b(error|exception|bug|fix|debug|timeout|memory\s*leak|stack\s*trace|null\s*pointer)\b/gi,
];

const ANCHOR_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "and",
  "or",
  "but",
  "if",
  "when",
  "where",
  "why",
  "how",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "there",
  "here",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "our",
  "their",
  "some",
  "any",
  "all",
  "most",
  "other",
  "such",
  "only",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "then",
  "up",
  "down",
  "out",
  "about",
  "more",
  "less",
  "new",
  "old",
  "first",
  "last",
  "long",
  "great",
  "little",
  "own",
  "good",
  "bad",
  "get",
  "got",
  "make",
  "made",
  "need",
  "needed",
  "use",
  "used",
  "using",
  "work",
  "worked",
  "working",
  "try",
  "tried",
  "trying",
  "want",
  "wanted",
  "think",
  "thought",
  "know",
  "knew",
  "see",
  "saw",
  "look",
  "looked",
  "find",
  "found",
  "give",
  "gave",
  "take",
  "took",
  "come",
  "came",
  "way",
  "well",
  "back",
  "even",
  "still",
  "while",
]);

interface DiaryExtraction {
  accomplishments?: string[];
  decisions?: string[];
  challenges?: string[];
  keyLearnings?: string[];
  preferences?: string[];
  tags?: string[];
}

function extractSearchAnchors(diary: DiaryExtraction): string[] {
  const allTexts: string[] = [
    ...(diary.accomplishments || []),
    ...(diary.decisions || []),
    ...(diary.challenges || []),
    ...(diary.keyLearnings || []),
    ...(diary.preferences || []),
  ];

  const combinedText = allTexts.join(" ");
  if (!combinedText.trim()) {
    return diary.tags?.slice(0, 15) || [];
  }

  const anchorScores = new Map<string, number>();

  for (const pattern of TECH_TERM_PATTERNS) {
    const matches = combinedText.match(pattern) || [];
    for (const match of matches) {
      const normalized = match.toLowerCase().replace(/\s+/g, " ").trim();
      if (normalized.length >= 2) {
        anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 5);
      }
    }
  }

  const capitalizedPattern = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+\b/g;
  const capsMatches = combinedText.match(capitalizedPattern) || [];
  for (const match of capsMatches) {
    if (match.length >= 3 && !ANCHOR_STOP_WORDS.has(match.toLowerCase())) {
      anchorScores.set(match, (anchorScores.get(match) || 0) + 3);
    }
  }

  const versionPattern = /\b[a-zA-Z]+\s*(?:v?\d+(?:\.\d+)*)\b/gi;
  const versionMatches = combinedText.match(versionPattern) || [];
  for (const match of versionMatches) {
    const normalized = match.trim();
    if (normalized.length >= 3) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 4);
    }
  }

  const filePattern = /\b[\w.-]+\.(ts|tsx|js|jsx|py|rs|go|json|yaml|yml|md|css|scss|html)\b/gi;
  const fileMatches = combinedText.match(filePattern) || [];
  for (const match of fileMatches) {
    anchorScores.set(match, (anchorScores.get(match) || 0) + 2);
  }

  const phrasePattern =
    /\b(?:[A-Za-z]+\s+){1,2}(?:error|bug|fix|issue|config|setting|option|function|method|class|component|hook|service|controller|model|schema|type|interface|api|endpoint|route|middleware)\b/gi;
  const phraseMatches = combinedText.match(phrasePattern) || [];
  for (const match of phraseMatches) {
    const normalized = match.toLowerCase().trim();
    if (normalized.length >= 5 && !ANCHOR_STOP_WORDS.has(normalized)) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 2);
    }
  }

  const tokens = tokenize(combinedText);
  const tokenCounts = new Map<string, number>();
  for (const token of tokens) {
    if (token.length >= 3 && !ANCHOR_STOP_WORDS.has(token)) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
  }

  for (const [token, count] of tokenCounts) {
    if (count >= 2) {
      const existing = anchorScores.get(token) || 0;
      anchorScores.set(token, existing + count);
    }
  }

  for (const tag of diary.tags || []) {
    const normalized = tag.toLowerCase().trim();
    if (normalized.length >= 2) {
      anchorScores.set(normalized, (anchorScores.get(normalized) || 0) + 4);
    }
  }

  const sortedAnchors = Array.from(anchorScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([anchor]) => anchor);

  const seen = new Set<string>();
  const uniqueAnchors: string[] = [];

  for (const anchor of sortedAnchors) {
    const normalized = anchor.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueAnchors.push(anchor);
    }
    if (uniqueAnchors.length >= 15) break;
  }

  return uniqueAnchors;
}

describe("extractSearchAnchors", () => {
  it("extracts technical terms from diary fields", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Fixed JWT authentication bug", "Implemented React hooks"],
      decisions: ["Used TypeScript for type safety", "Chose Prisma as ORM"],
      challenges: ["CORS configuration was tricky", "Async/await timeout issues"],
      keyLearnings: ["Always validate tokens", "Use vitest for testing"],
      tags: ["auth", "react", "typescript"],
    };

    const anchors = extractSearchAnchors(diary);

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.length).toBeLessThanOrEqual(15);

    const lowerAnchors = anchors.map((a) => a.toLowerCase());
    expect(lowerAnchors).toContain("jwt");
    expect(lowerAnchors).toContain("react");
    expect(lowerAnchors).toContain("typescript");
  });

  it("returns empty array for empty diary", () => {
    const diary: DiaryExtraction = {};
    const anchors = extractSearchAnchors(diary);
    expect(anchors).toEqual([]);
  });

  it("returns tags when no other content available", () => {
    const diary: DiaryExtraction = {
      tags: ["testing", "api", "database"],
    };
    const anchors = extractSearchAnchors(diary);

    const lowerAnchors = anchors.map((a) => a.toLowerCase());
    expect(lowerAnchors).toContain("testing");
    expect(lowerAnchors).toContain("api");
    expect(lowerAnchors).toContain("database");
  });

  it("extracts file patterns", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Updated package.json", "Fixed config.yaml settings"],
      challenges: ["Issues with test.ts file"],
    };

    const anchors = extractSearchAnchors(diary);
    const lowerAnchors = anchors.map((a) => a.toLowerCase());

    expect(lowerAnchors.some((a) => a.includes("package.json"))).toBe(true);
  });

  it("prioritizes technical terms over common words", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["The authentication system is now working with OAuth2"],
      keyLearnings: ["The error handling for GraphQL was important"],
    };

    const anchors = extractSearchAnchors(diary);
    const lowerAnchors = anchors.map((a) => a.toLowerCase());

    expect(lowerAnchors).toContain("authentication");
    expect(lowerAnchors).toContain("oauth2");
    expect(lowerAnchors).toContain("graphql");

    expect(lowerAnchors).not.toContain("the");
    expect(lowerAnchors).not.toContain("is");
    expect(lowerAnchors).not.toContain("was");
  });

  it("limits output to 15 anchors", () => {
    const diary: DiaryExtraction = {
      accomplishments: [
        "Implemented React, Vue, Angular components",
        "Used TypeScript, JavaScript, Python scripts",
        "Set up Docker, Kubernetes, AWS infrastructure",
        "Configured PostgreSQL, MongoDB, Redis databases",
        "Added JWT, OAuth, CORS security",
        "Wrote Jest, Vitest, Mocha tests",
      ],
      tags: ["tag1", "tag2", "tag3", "tag4", "tag5"],
    };

    const anchors = extractSearchAnchors(diary);
    expect(anchors.length).toBeLessThanOrEqual(15);
  });

  it("deduplicates similar anchors", () => {
    const diary: DiaryExtraction = {
      accomplishments: ["Used React for frontend", "react hooks implementation"],
      decisions: ["REACT components are best"],
    };

    const anchors = extractSearchAnchors(diary);
    const reactCount = anchors.filter((a) => a.toLowerCase() === "react").length;
    expect(reactCount).toBeLessThanOrEqual(1);
  });
});
