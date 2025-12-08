import { describe, expect, it } from "bun:test";
import {
  FeedbackEventSchema,
  PlaybookBulletSchema,
  PlaybookSchema,
  ConfigSchema,
  DiaryEntrySchema,
  PlaybookDeltaSchema,
  AddDeltaSchema,
  HelpfulDeltaSchema,
  HarmfulDeltaSchema,
  ReplaceDeltaSchema,
  DeprecateDeltaSchema,
  MergeDeltaSchema,
  HarmfulReasonEnum,
  BulletScopeEnum,
  BulletTypeEnum,
  BulletKindEnum,
  BulletStateEnum,
  BulletMaturityEnum,
  SessionStatusEnum,
  LLMProviderEnum,
} from "../src/types.js";

// =============================================================================
// Enum Schemas
// =============================================================================
describe("Enum Schemas", () => {
  describe("HarmfulReasonEnum", () => {
    it("accepts valid harmful reasons", () => {
      const reasons = [
        "caused_bug",
        "wasted_time",
        "contradicted_requirements",
        "wrong_context",
        "outdated",
        "other",
      ];
      for (const reason of reasons) {
        expect(HarmfulReasonEnum.safeParse(reason).success).toBe(true);
      }
    });

    it("rejects invalid reasons", () => {
      expect(HarmfulReasonEnum.safeParse("invalid").success).toBe(false);
      expect(HarmfulReasonEnum.safeParse("").success).toBe(false);
    });
  });

  describe("SessionStatusEnum", () => {
    it("accepts valid session statuses", () => {
      expect(SessionStatusEnum.safeParse("success").success).toBe(true);
      expect(SessionStatusEnum.safeParse("failure").success).toBe(true);
      expect(SessionStatusEnum.safeParse("mixed").success).toBe(true);
    });

    it("rejects invalid statuses", () => {
      expect(SessionStatusEnum.safeParse("pending").success).toBe(false);
    });
  });

  describe("BulletScopeEnum", () => {
    it("accepts valid scopes", () => {
      const scopes = ["global", "workspace", "language", "framework", "task"];
      for (const scope of scopes) {
        expect(BulletScopeEnum.safeParse(scope).success).toBe(true);
      }
    });
  });

  describe("BulletTypeEnum", () => {
    it("accepts rule and anti-pattern", () => {
      expect(BulletTypeEnum.safeParse("rule").success).toBe(true);
      expect(BulletTypeEnum.safeParse("anti-pattern").success).toBe(true);
    });
  });

  describe("BulletKindEnum", () => {
    it("accepts valid kinds", () => {
      const kinds = ["project_convention", "stack_pattern", "workflow_rule", "anti_pattern"];
      for (const kind of kinds) {
        expect(BulletKindEnum.safeParse(kind).success).toBe(true);
      }
    });
  });

  describe("BulletStateEnum", () => {
    it("accepts valid states", () => {
      expect(BulletStateEnum.safeParse("draft").success).toBe(true);
      expect(BulletStateEnum.safeParse("active").success).toBe(true);
      expect(BulletStateEnum.safeParse("retired").success).toBe(true);
    });
  });

  describe("BulletMaturityEnum", () => {
    it("accepts valid maturity levels", () => {
      const levels = ["candidate", "established", "proven", "deprecated"];
      for (const level of levels) {
        expect(BulletMaturityEnum.safeParse(level).success).toBe(true);
      }
    });
  });

  describe("LLMProviderEnum", () => {
    it("accepts valid providers", () => {
      expect(LLMProviderEnum.safeParse("openai").success).toBe(true);
      expect(LLMProviderEnum.safeParse("anthropic").success).toBe(true);
      expect(LLMProviderEnum.safeParse("google").success).toBe(true);
    });
  });
});

// =============================================================================
// FeedbackEventSchema
// =============================================================================
describe("FeedbackEventSchema", () => {
  it("validates minimal helpful event", () => {
    const event = {
      type: "helpful",
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
  });

  it("validates minimal harmful event", () => {
    const event = {
      type: "harmful",
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
  });

  it("validates complete event with all fields", () => {
    const event = {
      type: "harmful",
      timestamp: "2024-01-01T00:00:00Z",
      sessionPath: "/path/to/session.jsonl",
      reason: "caused_bug",
      context: "The suggested code caused a runtime error",
      decayedValue: 0.75,
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects invalid type", () => {
    const event = {
      type: "neutral",
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects missing type", () => {
    const event = {
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const event = {
      type: "helpful",
    };
    expect(FeedbackEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts harmful event with reason", () => {
    const event = {
      type: "harmful",
      timestamp: "2024-01-01T00:00:00Z",
      reason: "outdated",
    };
    const result = FeedbackEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// PlaybookBulletSchema
// =============================================================================
describe("PlaybookBulletSchema", () => {
  const minimalBullet = {
    id: "b-123",
    category: "testing",
    content: "Always write tests",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("validates minimal bullet", () => {
    const result = PlaybookBulletSchema.safeParse(minimalBullet);
    expect(result.success).toBe(true);
  });

  it("applies default values", () => {
    const result = PlaybookBulletSchema.parse(minimalBullet);
    expect(result.scope).toBe("global");
    expect(result.type).toBe("rule");
    expect(result.isNegative).toBe(false);
    expect(result.kind).toBe("stack_pattern");
    expect(result.state).toBe("draft");
    expect(result.maturity).toBe("candidate");
    expect(result.helpfulCount).toBe(0);
    expect(result.harmfulCount).toBe(0);
    expect(result.feedbackEvents).toEqual([]);
    expect(result.confidenceDecayHalfLifeDays).toBe(90);
    expect(result.pinned).toBe(false);
    expect(result.deprecated).toBe(false);
    expect(result.sourceSessions).toEqual([]);
    expect(result.sourceAgents).toEqual([]);
    expect(result.tags).toEqual([]);
  });

  it("validates complete bullet with all fields", () => {
    const bullet = {
      ...minimalBullet,
      scope: "workspace",
      scopeKey: "my-project",
      workspace: "/path/to/workspace",
      searchPointer: "CLAUDE.md:testing",
      type: "anti-pattern",
      isNegative: true,
      kind: "workflow_rule",
      state: "active",
      maturity: "proven",
      promotedAt: "2024-06-01T00:00:00Z",
      helpfulCount: 10,
      harmfulCount: 1,
      feedbackEvents: [
        { type: "helpful", timestamp: "2024-01-15T00:00:00Z" },
      ],
      lastValidatedAt: "2024-12-01T00:00:00Z",
      confidenceDecayHalfLifeDays: 60,
      pinned: true,
      pinnedReason: "Core team rule",
      deprecated: false,
      sourceSessions: ["/session1.jsonl", "/session2.jsonl"],
      sourceAgents: ["claude", "cursor"],
      reasoning: "Tests prevent regressions",
      tags: ["testing", "best-practice"],
      embedding: [0.1, 0.2, 0.3],
      effectiveScore: 8.5,
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });

  it("rejects missing id", () => {
    const bullet = {
      category: "testing",
      content: "Always write tests",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects missing category", () => {
    const bullet = {
      id: "b-123",
      content: "Always write tests",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects missing content", () => {
    const bullet = {
      id: "b-123",
      category: "testing",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects missing createdAt", () => {
    const bullet = {
      id: "b-123",
      category: "testing",
      content: "Always write tests",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects missing updatedAt", () => {
    const bullet = {
      id: "b-123",
      category: "testing",
      content: "Always write tests",
      createdAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects invalid scope", () => {
    const bullet = {
      ...minimalBullet,
      scope: "invalid",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects invalid type", () => {
    const bullet = {
      ...minimalBullet,
      type: "invalid",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("rejects invalid maturity", () => {
    const bullet = {
      ...minimalBullet,
      maturity: "invalid",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });

  it("validates nested feedbackEvents", () => {
    const bullet = {
      ...minimalBullet,
      feedbackEvents: [
        { type: "helpful", timestamp: "2024-01-15T00:00:00Z" },
        { type: "harmful", timestamp: "2024-01-20T00:00:00Z", reason: "outdated" },
      ],
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });

  it("rejects invalid feedbackEvents", () => {
    const bullet = {
      ...minimalBullet,
      feedbackEvents: [
        { type: "invalid", timestamp: "2024-01-15T00:00:00Z" },
      ],
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(false);
  });
});

// =============================================================================
// PlaybookSchema
// =============================================================================
describe("PlaybookSchema", () => {
  const minimalMetadata = {
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("validates minimal playbook", () => {
    const playbook = {
      metadata: minimalMetadata,
    };
    const result = PlaybookSchema.safeParse(playbook);
    expect(result.success).toBe(true);
  });

  it("applies default values", () => {
    const playbook = {
      metadata: minimalMetadata,
    };
    const result = PlaybookSchema.parse(playbook);
    expect(result.schema_version).toBe(2);
    expect(result.name).toBe("playbook");
    expect(result.description).toBe("Auto-generated by cass-memory");
    expect(result.deprecatedPatterns).toEqual([]);
    expect(result.bullets).toEqual([]);
  });

  it("validates playbook with bullets", () => {
    const playbook = {
      metadata: minimalMetadata,
      bullets: [
        {
          id: "b-1",
          category: "testing",
          content: "Write tests",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "b-2",
          category: "style",
          content: "Use consistent formatting",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    expect(PlaybookSchema.safeParse(playbook).success).toBe(true);
  });

  it("validates metadata with optional fields", () => {
    const playbook = {
      metadata: {
        createdAt: "2024-01-01T00:00:00Z",
        lastReflection: "2024-12-01T00:00:00Z",
        totalReflections: 50,
        totalSessionsProcessed: 100,
      },
    };
    expect(PlaybookSchema.safeParse(playbook).success).toBe(true);
  });

  it("rejects playbook without metadata", () => {
    const playbook = {
      bullets: [],
    };
    expect(PlaybookSchema.safeParse(playbook).success).toBe(false);
  });

  it("rejects playbook with invalid bullet", () => {
    const playbook = {
      metadata: minimalMetadata,
      bullets: [
        { invalid: "bullet" },
      ],
    };
    expect(PlaybookSchema.safeParse(playbook).success).toBe(false);
  });
});

// =============================================================================
// ConfigSchema
// =============================================================================
describe("ConfigSchema", () => {
  it("validates empty config (uses all defaults)", () => {
    const config = {};
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("applies default values", () => {
    const config = {};
    const result = ConfigSchema.parse(config);
    expect(result.schema_version).toBe(1);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.cassPath).toBe("cass");
    expect(result.maxBulletsInContext).toBe(50);
    expect(result.maxHistoryInContext).toBe(10);
    expect(result.jsonOutput).toBe(false);
    expect(result.verbose).toBe(false);
    expect(result.autoReflect).toBe(false);
  });

  it("validates complete config", () => {
    const config = {
      schema_version: 1,
      provider: "openai",
      model: "gpt-4",
      cassPath: "/usr/local/bin/cass",
      playbookPath: "/home/user/.cass/playbook.yaml",
      diaryDir: "/home/user/.cass/diary",
      scoring: {
        decayHalfLifeDays: 60,
        harmfulMultiplier: 3,
      },
      maxBulletsInContext: 100,
      maxHistoryInContext: 20,
      sessionLookbackDays: 14,
      verbose: true,
      jsonOutput: true,
      apiKey: "sk-test-key",
    };
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it("validates nested scoring config", () => {
    const config = {
      scoring: {
        decayHalfLifeDays: 120,
        harmfulMultiplier: 5,
        minFeedbackForActive: 5,
        minHelpfulForProven: 15,
        maxHarmfulRatioForProven: 0.05,
      },
    };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("validates nested sanitization config", () => {
    const config = {
      sanitization: {
        enabled: true,
        extraPatterns: ["custom-pattern.*"],
        auditLog: true,
        auditLevel: "debug",
      },
    };
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it("validates nested budget config", () => {
    const config = {
      budget: {
        dailyLimit: 0.50,
        monthlyLimit: 10.00,
        warningThreshold: 90,
        currency: "EUR",
      },
    };
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects invalid provider", () => {
    const config = {
      provider: "invalid-provider",
    };
    expect(ConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects invalid sanitization audit level", () => {
    const config = {
      sanitization: {
        auditLevel: "invalid",
      },
    };
    expect(ConfigSchema.safeParse(config).success).toBe(false);
  });
});

// =============================================================================
// DiaryEntrySchema
// =============================================================================
describe("DiaryEntrySchema", () => {
  const minimalDiary = {
    id: "diary-123",
    sessionPath: "/path/to/session.jsonl",
    timestamp: "2024-01-01T00:00:00Z",
    agent: "claude",
    status: "success",
  };

  it("validates minimal diary entry", () => {
    expect(DiaryEntrySchema.safeParse(minimalDiary).success).toBe(true);
  });

  it("applies default values", () => {
    const result = DiaryEntrySchema.parse(minimalDiary);
    expect(result.accomplishments).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.challenges).toEqual([]);
    expect(result.preferences).toEqual([]);
    expect(result.keyLearnings).toEqual([]);
    expect(result.relatedSessions).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.searchAnchors).toEqual([]);
  });

  it("validates complete diary entry", () => {
    const diary = {
      ...minimalDiary,
      workspace: "/project",
      duration: 3600,
      accomplishments: ["Fixed bug", "Added tests"],
      decisions: ["Use TypeScript"],
      challenges: ["Complex API"],
      preferences: ["Prefer functional style"],
      keyLearnings: ["Learned about Zod"],
      relatedSessions: [
        {
          sessionPath: "/other/session.jsonl",
          agent: "cursor",
          relevanceScore: 0.8,
          snippet: "Related work...",
        },
      ],
      tags: ["bugfix", "testing"],
      searchAnchors: ["bug", "test", "fix"],
    };
    expect(DiaryEntrySchema.safeParse(diary).success).toBe(true);
  });

  it("rejects missing id", () => {
    const { id, ...rest } = minimalDiary;
    expect(DiaryEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing sessionPath", () => {
    const { sessionPath, ...rest } = minimalDiary;
    expect(DiaryEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects invalid status", () => {
    const diary = {
      ...minimalDiary,
      status: "invalid",
    };
    expect(DiaryEntrySchema.safeParse(diary).success).toBe(false);
  });

  it("accepts all valid statuses", () => {
    for (const status of ["success", "failure", "mixed"]) {
      const diary = { ...minimalDiary, status };
      expect(DiaryEntrySchema.safeParse(diary).success).toBe(true);
    }
  });
});

// =============================================================================
// Delta Schemas
// =============================================================================
describe("Delta Schemas", () => {
  describe("AddDeltaSchema", () => {
    it("validates add delta", () => {
      const delta = {
        type: "add",
        bullet: {
          content: "New rule",
          category: "testing",
        },
        reason: "Learned from session",
        sourceSession: "/path/session.jsonl",
      };
      expect(AddDeltaSchema.safeParse(delta).success).toBe(true);
    });

    it("rejects missing bullet", () => {
      const delta = {
        type: "add",
        reason: "Test",
        sourceSession: "/path/session.jsonl",
      };
      expect(AddDeltaSchema.safeParse(delta).success).toBe(false);
    });
  });

  describe("HelpfulDeltaSchema", () => {
    it("validates helpful delta", () => {
      const delta = {
        type: "helpful",
        bulletId: "b-123",
      };
      expect(HelpfulDeltaSchema.safeParse(delta).success).toBe(true);
    });

    it("validates with optional fields", () => {
      const delta = {
        type: "helpful",
        bulletId: "b-123",
        sourceSession: "/path/session.jsonl",
        context: "This rule helped fix a bug",
      };
      expect(HelpfulDeltaSchema.safeParse(delta).success).toBe(true);
    });
  });

  describe("HarmfulDeltaSchema", () => {
    it("validates harmful delta", () => {
      const delta = {
        type: "harmful",
        bulletId: "b-123",
      };
      expect(HarmfulDeltaSchema.safeParse(delta).success).toBe(true);
    });

    it("validates with reason", () => {
      const delta = {
        type: "harmful",
        bulletId: "b-123",
        reason: "caused_bug",
        context: "Led to a runtime error",
      };
      expect(HarmfulDeltaSchema.safeParse(delta).success).toBe(true);
    });
  });

  describe("ReplaceDeltaSchema", () => {
    it("validates replace delta", () => {
      const delta = {
        type: "replace",
        bulletId: "b-123",
        newContent: "Updated rule content",
      };
      expect(ReplaceDeltaSchema.safeParse(delta).success).toBe(true);
    });
  });

  describe("DeprecateDeltaSchema", () => {
    it("validates deprecate delta", () => {
      const delta = {
        type: "deprecate",
        bulletId: "b-123",
        reason: "No longer relevant",
      };
      expect(DeprecateDeltaSchema.safeParse(delta).success).toBe(true);
    });

    it("validates with replacedBy", () => {
      const delta = {
        type: "deprecate",
        bulletId: "b-123",
        reason: "Superseded",
        replacedBy: "b-456",
      };
      expect(DeprecateDeltaSchema.safeParse(delta).success).toBe(true);
    });
  });

  describe("MergeDeltaSchema", () => {
    it("validates merge delta", () => {
      const delta = {
        type: "merge",
        bulletIds: ["b-1", "b-2", "b-3"],
        mergedContent: "Combined rule",
      };
      expect(MergeDeltaSchema.safeParse(delta).success).toBe(true);
    });
  });

  describe("PlaybookDeltaSchema (discriminated union)", () => {
    it("validates all delta types", () => {
      const deltas = [
        { type: "add", bullet: { content: "Test", category: "test" }, reason: "R", sourceSession: "S" },
        { type: "helpful", bulletId: "b-1" },
        { type: "harmful", bulletId: "b-1" },
        { type: "replace", bulletId: "b-1", newContent: "New" },
        { type: "deprecate", bulletId: "b-1", reason: "Old" },
        { type: "merge", bulletIds: ["b-1", "b-2"], mergedContent: "Merged" },
      ];
      for (const delta of deltas) {
        expect(PlaybookDeltaSchema.safeParse(delta).success).toBe(true);
      }
    });

    it("rejects invalid delta type", () => {
      const delta = {
        type: "invalid",
        bulletId: "b-1",
      };
      expect(PlaybookDeltaSchema.safeParse(delta).success).toBe(false);
    });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================
describe("Schema Edge Cases", () => {
  it("handles empty strings in required fields", () => {
    const bullet = {
      id: "",
      category: "",
      content: "",
      createdAt: "",
      updatedAt: "",
    };
    // Should parse but with empty strings (Zod doesn't reject empty strings by default)
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });

  it("handles unicode content", () => {
    const bullet = {
      id: "b-123",
      category: "国際化",
      content: "日本語のルール 🎉",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });

  it("handles very long content", () => {
    const bullet = {
      id: "b-123",
      category: "testing",
      content: "x".repeat(10000),
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });

  it("handles numeric defaults correctly", () => {
    const config = ConfigSchema.parse({});
    expect(typeof config.maxBulletsInContext).toBe("number");
    expect(typeof config.scoring.decayHalfLifeDays).toBe("number");
    expect(typeof config.budget.dailyLimit).toBe("number");
  });

  it("handles arrays with many elements", () => {
    const bullet = {
      id: "b-123",
      category: "testing",
      content: "Test",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`),
      feedbackEvents: Array.from({ length: 100 }, (_, i) => ({
        type: i % 2 === 0 ? "helpful" : "harmful",
        timestamp: new Date(Date.now() - i * 86400000).toISOString(),
      })),
    };
    expect(PlaybookBulletSchema.safeParse(bullet).success).toBe(true);
  });
});
