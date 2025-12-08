import { 
  Playbook, 
  PlaybookBullet, 
  DiaryEntry, 
  Config, 
  FeedbackEvent,
  PlaybookBulletSchema
} from "../../src/types.js";
import { generateBulletId, generateDiaryId, now } from "../../src/utils.js";

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const defaults: Config = {
    schema_version: 1,
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    cassPath: "cass",
    playbookPath: "/tmp/playbook.yaml",
    diaryDir: "/tmp/diary",
    maxReflectorIterations: 3,
    autoReflect: false,
    dedupSimilarityThreshold: 0.85,
    pruneHarmfulThreshold: 3,
    defaultDecayHalfLife: 90,
    maxBulletsInContext: 50,
    maxHistoryInContext: 10,
    sessionLookbackDays: 7,
    validationLookbackDays: 90,
    relatedSessionsDays: 30,
    minRelevanceScore: 0.1,
    maxRelatedSessions: 5,
    validationEnabled: true,
    enrichWithCrossAgent: true,
    semanticSearchEnabled: false,
    verbose: false,
    jsonOutput: false,
    sanitization: {
      enabled: true,
      extraPatterns: [],
      auditLog: false,
      auditLevel: "info"
    },
    budget: {
      dailyLimit: 1.0,
      monthlyLimit: 10.0,
      warningThreshold: 80,
      currency: "USD"
    },
    scoring: {
      decayHalfLifeDays: 90,
      harmfulMultiplier: 4,
      minFeedbackForActive: 3,
      minHelpfulForProven: 10,
      maxHarmfulRatioForProven: 0.1
    }
  };

  return {
    ...defaults,
    ...overrides,
    sanitization: {
      ...defaults.sanitization,
      ...(overrides.sanitization || {})
    },
    budget: {
      ...defaults.budget,
      ...(overrides.budget || {})
    },
    scoring: {
      ...defaults.scoring,
      ...(overrides.scoring || {})
    }
  };
}

export function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: generateBulletId(),
    content: "Test content",
    category: "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: false,
    scope: "global",
    state: "draft",
    maturity: "candidate",
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    tags: [],
    sourceSessions: [],
    sourceAgents: [],
    createdAt: now(),
    updatedAt: now(),
    deprecated: false,
    pinned: false,
    confidenceDecayHalfLifeDays: 90,
    ...overrides
  };
}

export function createTestDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  const sessionPath = overrides.sessionPath || "/tmp/session.jsonl";
  return {
    id: generateDiaryId(sessionPath),
    sessionPath,
    timestamp: now(),
    agent: "claude",
    status: "success",
    accomplishments: [],
    decisions: [],
    challenges: [],
    preferences: [],
    keyLearnings: [],
    tags: [],
    searchAnchors: [],
    relatedSessions: [],
    ...overrides
  };
}

export function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: now(),
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    deprecatedPatterns: [],
    bullets
  };
}

export function createTestFeedbackEvent(type: "helpful" | "harmful", daysAgo = 0): FeedbackEvent {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);

  return {
    type,
    timestamp: date.toISOString(),
    sessionPath: "/tmp/session.jsonl"
  };
}

/**
 * Create a feedback event with optional overrides.
 * More flexible than createTestFeedbackEvent - allows partial overrides.
 */
export function createFeedbackEvent(
  type: "helpful" | "harmful",
  overrides: Partial<Omit<FeedbackEvent, "type">> = {}
): FeedbackEvent {
  return {
    type,
    timestamp: overrides.timestamp || now(),
    sessionPath: overrides.sessionPath || "/tmp/session.jsonl",
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.context ? { context: overrides.context } : {})
  };
}

export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
