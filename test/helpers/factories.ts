import { Playbook, PlaybookBullet, Config, DiaryEntry } from "../../src/types.js";

let bulletCounter = 0;

export function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  const now = new Date().toISOString();
  const id = overrides.id ?? `b-${Date.now()}-${bulletCounter++}`;

  return {
    id,
    scope: "global",
    category: overrides.category ?? "testing",
    content: overrides.content ?? "Test rule content",
    type: "rule",
    isNegative: false,
    kind: "stack_pattern",
    state: overrides.state ?? "draft",
    maturity: overrides.maturity ?? "candidate",
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    feedbackEvents: overrides.feedbackEvents ?? [],
    confidenceDecayHalfLifeDays: overrides.confidenceDecayHalfLifeDays ?? 90,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    sourceSessions: overrides.sourceSessions ?? [],
    sourceAgents: overrides.sourceAgents ?? [],
    tags: overrides.tags ?? [],
    pinned: overrides.pinned ?? false,
    deprecated: overrides.deprecated ?? false,
    ...overrides,
  };
}

export function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    metadata: {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalReflections: 0,
      lastReflection: undefined,
    },
    bullets,
  };
}

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const now = new Date().toISOString();
  return {
    provider: "openai",
    model: "gpt-4",
    apiKey: "test-key",
    cassPath: "cass",
    home: process.env.HOME || ".",
    cwd: process.cwd(),
    maxBulletsInContext: 10,
    maxHistoryInContext: 10,
    sessionLookbackDays: 30,
    pruneHarmfulThreshold: 3,
    decayHalfLifeDays: 90,
    maturityPromotionThreshold: 3,
    maturityProvenThreshold: 10,
    harmfulMultiplier: 4,
    createdAt: now,
    updatedAt: now,
    jsonOutput: false,
    ...overrides,
  } as Config;
}

export function createTestDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `diary-${Date.now()}`,
    sessionPath: overrides.sessionPath ?? "/tmp/session.jsonl",
    timestamp: overrides.timestamp ?? now,
    agent: overrides.agent ?? "claude",
    workspace: overrides.workspace ?? "repo",
    status: overrides.status ?? "success",
    accomplishments: overrides.accomplishments ?? ["did a thing"],
    decisions: overrides.decisions ?? [],
    challenges: overrides.challenges ?? [],
    preferences: overrides.preferences ?? [],
    keyLearnings: overrides.keyLearnings ?? [],
    tags: overrides.tags ?? [],
    searchAnchors: overrides.searchAnchors ?? [],
    relatedSessions: overrides.relatedSessions ?? [],
  };
}

export function assertBulletMatches(actual: PlaybookBullet, expected: Partial<PlaybookBullet>): void {
  for (const [key, value] of Object.entries(expected)) {
    // @ts-expect-error dynamic key
    const actualValue = actual[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (JSON.stringify(value) !== JSON.stringify(actualValue)) {
        throw new Error(`Bullet mismatch on ${key}: expected ${JSON.stringify(value)} got ${JSON.stringify(actualValue)}`);
      }
    } else if (actualValue !== value) {
      throw new Error(`Bullet mismatch on ${key}: expected ${value} got ${actualValue}`);
    }
  }
}
