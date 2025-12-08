import { Playbook, PlaybookBullet, Config, DiaryEntry, FeedbackEvent } from "../../src/types.js";

let bulletCounter = 0;
let eventCounter = 0;

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

/**
 * Create a test feedback event.
 */
export function createTestFeedbackEvent(
  type: "helpful" | "harmful",
  overrides: Partial<Omit<FeedbackEvent, "type">> = {}
): FeedbackEvent {
  const now = new Date().toISOString();
  return {
    type,
    timestamp: overrides.timestamp ?? now,
    sessionPath: overrides.sessionPath ?? `/tmp/session-${eventCounter++}.jsonl`,
    context: overrides.context,
    reason: overrides.reason,
  };
}

/**
 * Create multiple feedback events with staggered timestamps.
 */
export function createFeedbackHistory(
  helpful: number,
  harmful: number,
  options: { baseDate?: Date; intervalDays?: number } = {}
): FeedbackEvent[] {
  const events: FeedbackEvent[] = [];
  const baseDate = options.baseDate ?? new Date();
  const intervalDays = options.intervalDays ?? 7;

  let currentDate = new Date(baseDate);

  for (let i = 0; i < helpful; i++) {
    events.push(createTestFeedbackEvent("helpful", {
      timestamp: currentDate.toISOString(),
    }));
    currentDate = new Date(currentDate.getTime() - intervalDays * 24 * 60 * 60 * 1000);
  }

  currentDate = new Date(baseDate.getTime() - 1000); // Slightly before base

  for (let i = 0; i < harmful; i++) {
    events.push(createTestFeedbackEvent("harmful", {
      timestamp: currentDate.toISOString(),
    }));
    currentDate = new Date(currentDate.getTime() - intervalDays * 24 * 60 * 60 * 1000);
  }

  // Sort by timestamp descending (most recent first)
  return events.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Create a bullet with specific feedback history.
 */
export function createBulletWithFeedback(
  helpful: number,
  harmful: number,
  bulletOverrides: Partial<PlaybookBullet> = {}
): PlaybookBullet {
  const events = createFeedbackHistory(helpful, harmful);
  return createTestBullet({
    feedbackEvents: events,
    helpfulCount: helpful,
    harmfulCount: harmful,
    ...bulletOverrides,
  });
}
