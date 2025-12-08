import { z } from "zod";
import { expandPath } from "./utils.js";

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const HarmfulReasonEnum = z.enum([
  "caused_bug",
  "wasted_time",
  "contradicted_requirements",
  "wrong_context",
  "outdated",
  "other"
]);
export type HarmfulReason = z.infer<typeof HarmfulReasonEnum>;
export const HarmfulReasonSchema = HarmfulReasonEnum;

export const SessionStatusEnum = z.enum(["success", "failure", "mixed"]);
export type SessionStatus = z.infer<typeof SessionStatusEnum>;

export const BulletScopeEnum = z.enum(["global", "workspace", "language", "framework", "task"]);
export type BulletScope = z.infer<typeof BulletScopeEnum>;

/**
 * Binary classification: prescriptive (rule) vs proscriptive (anti-pattern)
 * - rule: DO this - positive guidance shown in main playbook
 * - anti-pattern: DON'T do this - warnings shown in PITFALLS section
 */
export const BulletTypeEnum = z.enum(["rule", "anti-pattern"]);
export type BulletType = z.infer<typeof BulletTypeEnum>;

/**
 * Semantic categorization of bullets by their nature and portability:
 *
 * @property project_convention - Repository-specific rules (LOW portability)
 *   Example: "Use AuthService from @/lib/auth for authentication"
 *   Applies: Only in matching workspace
 *   Characteristics: References specific files/modules/patterns in THIS project
 *
 * @property stack_pattern - Language/framework best practices (HIGH portability)
 *   Example: "For TypeScript, prefer interfaces over types for objects"
 *   Applies: Any project using that stack
 *   Characteristics: Generic best practices for the tech stack
 *
 * @property workflow_rule - Process and methodology rules (MEDIUM portability)
 *   Example: "Run pnpm test before committing"
 *   Applies: Based on team/org practices
 *   Characteristics: About HOW to work, not WHAT to code
 *
 * @property anti_pattern - Pitfalls and mistakes to avoid (VARIABLE portability)
 *   Example: "Don't mock Router hooks directly - use mockRouter utility"
 *   Display: Shown in separate PITFALLS section, not main playbook
 *   Characteristics: Negative guidance, often learned from past mistakes
 */
export const BulletKindEnum = z.enum([
  "project_convention",
  "stack_pattern",
  "workflow_rule",
  "anti_pattern"
]);
export type BulletKind = z.infer<typeof BulletKindEnum>;

export const BulletStateEnum = z.enum(["draft", "active", "retired"]);
export type BulletState = z.infer<typeof BulletStateEnum>;

export const BulletMaturityEnum = z.enum(["candidate", "established", "proven", "deprecated"]);
export type BulletMaturity = z.infer<typeof BulletMaturityEnum>;

export const LLMProviderEnum = z.enum(["openai", "anthropic", "google"]);
export type LLMProvider = z.infer<typeof LLMProviderEnum>;

// ============================================================================
// FEEDBACK EVENT
// ============================================================================

export const FeedbackEventSchema = z.object({
  type: z.enum(["helpful", "harmful"]),
  timestamp: z.string(),
  sessionPath: z.string().optional(),
  reason: HarmfulReasonEnum.optional(),
  context: z.string().optional(),
  decayedValue: z.number().optional()
});
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

// ============================================================================
// PLAYBOOK BULLET
// ============================================================================

/**
 * Base schema for PlaybookBullet without refinements.
 * Use this for .partial() and .extend() operations.
 */
const BULLET_ID_PATTERN = /^b-[a-z0-9]+-[a-z0-9]+$/;

export const PlaybookBulletBaseSchema = z.object({
  id: z.string().regex(BULLET_ID_PATTERN, "id must match b-{timestamp36}-{random}"),
  scope: BulletScopeEnum.default("global"),
  scopeKey: z.string().optional(),
  workspace: z.string().optional(),
  /** High-level grouping for organization (e.g., 'testing', 'git', 'auth') */
  category: z.string().min(1),
  /** The actual rule text shown to agents (10-500 characters) */
  content: z.string().min(10).max(500),
  /** Gemini-style search pattern for retrieving detailed examples from cass */
  searchPointer: z.string().optional(),
  /** Binary: prescriptive (rule) or proscriptive (anti-pattern) */
  type: BulletTypeEnum.default("rule"),
  /** Computed shorthand for type === 'anti-pattern' */
  isNegative: z.boolean().default(false),
  kind: BulletKindEnum.default("stack_pattern"),
  state: BulletStateEnum.default("draft"),
  maturity: BulletMaturityEnum.default("candidate"),
  promotedAt: z.string().optional(),
  /** Legacy counter - derived from feedbackEvents.filter(e => e.type === 'helpful').length */
  helpfulCount: z.number().default(0),
  /** Legacy counter - derived from feedbackEvents.filter(e => e.type === 'harmful').length */
  harmfulCount: z.number().default(0),
  /**
   * Single source of truth for feedback tracking (KEY INNOVATION).
   * Each event contains: type ('helpful'|'harmful'), timestamp, sessionPath?, reason?, context?
   * Used for confidence decay: score = sum(0.5^(ageDays/halfLife))
   */
  feedbackEvents: z.array(FeedbackEventSchema).default([]),
  /** @deprecated Use feedbackEvents - kept for schema compatibility */
  helpfulEvents: z.array(FeedbackEventSchema).default([]),
  /** @deprecated Use feedbackEvents - kept for schema compatibility */
  harmfulEvents: z.array(FeedbackEventSchema).default([]),
  /** When rule was last validated against cass history */
  lastValidatedAt: z.string().optional(),
  /**
   * Half-life in days for confidence decay.
   * - 30 days: Fast-moving tech (e.g., beta APIs)
   * - 90 days: Default for most rules
   * - 180 days: Stable patterns
   * - 365 days: Timeless principles
   */
  confidenceDecayHalfLifeDays: z.number().default(90),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinned: z.boolean().default(false),
  pinnedReason: z.string().optional(),
  deprecated: z.boolean().default(false),
  replacedBy: z.string().optional(),
  deprecationReason: z.string().optional(),
  sourceSessions: z.array(z.string()).default([]),
  sourceAgents: z.array(z.string()).default([]),
  reasoning: z.string().optional(),
  tags: z.array(z.string()).default([]),
  embedding: z.array(z.number()).optional(),
  effectiveScore: z.number().optional(),
  deprecatedAt: z.string().optional(),
  /**
   * Detailed provenance trail from diary/sessions.
   * Tracks which diaries contributed and key evidence quotes.
   */
  derivedFrom: z.object({
    /** IDs of diary entries that contributed to this rule */
    diaryIds: z.array(z.string()).default([]),
    /** Key evidence quotes from sessions supporting this rule */
    keyEvidence: z.array(z.string()).default([])
  }).optional(),
  /**
   * Automated verification specification for programmatic rule validation.
   *
   * Types:
   * - regex: Check if code pattern exists/absent in codebase
   * - file_exists: Check if specific file/module exists
   * - cass_query: Check if cass search returns results
   *
   * Mode:
   * - exists: Verification passes if pattern IS found
   * - absent: Verification passes if pattern is NOT found
   *
   * @example
   * { type: 'regex', pattern: 'TokenValidator', mode: 'exists' }
   * { type: 'file_exists', pattern: 'lib/auth.ts', mode: 'exists' }
   * { type: 'cass_query', pattern: 'vitest configuration', mode: 'exists' }
   */
  verification: z.object({
    type: z.enum(["regex", "file_exists", "cass_query"]),
    pattern: z.string(),
    mode: z.enum(["exists", "absent"])
  }).optional()
});

/**
 * PlaybookBullet schema with validation refinements.
 * Use PlaybookBulletBaseSchema for .partial() and .extend() operations.
 */
export const PlaybookBulletSchema = PlaybookBulletBaseSchema.superRefine((bullet, ctx) => {
  // Scope validation: workspace scope requires workspace to be set
  if (bullet.scope === "workspace" && !bullet.workspace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workspace"],
      message: "workspace scope requires workspace to be set",
    });
  }
  // Scope validation: language/framework/task scopes require scopeKey
  if (
    (bullet.scope === "language" ||
      bullet.scope === "framework" ||
      bullet.scope === "task") &&
    !bullet.scopeKey
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scopeKey"],
      message: `${bullet.scope} scope requires scopeKey`,
    });
  }
  // Scope validation: global/workspace scopes should not have scopeKey
  if (
    (bullet.scope === "global" || bullet.scope === "workspace") &&
    bullet.scopeKey
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scopeKey"],
      message: "scopeKey should be omitted for global/workspace scopes",
    });
  }
  // isNegative should align with type
  const shouldBeNegative = bullet.type === "anti-pattern";
  if (bullet.isNegative !== shouldBeNegative) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isNegative"],
      message: "isNegative must match type (anti-pattern => true, rule => false)",
    });
  }
});
export type PlaybookBullet = z.infer<typeof PlaybookBulletBaseSchema>;

// ============================================================================
// NEW BULLET DATA
// ============================================================================

export const NewBulletDataSchema = PlaybookBulletBaseSchema.partial().extend({
  content: z.string().min(10).max(500),
  category: z.string().min(1)
});
export type NewBulletData = z.infer<typeof NewBulletDataSchema>;

// ============================================================================
// PLAYBOOK DELTA
// ============================================================================

export const AddDeltaSchema = z.object({
  type: z.literal("add"),
  bullet: NewBulletDataSchema,
  reason: z.string(),
  sourceSession: z.string()
});

export const HelpfulDeltaSchema = z.object({
  type: z.literal("helpful"),
  bulletId: z.string(),
  sourceSession: z.string().optional(),
  context: z.string().optional()
});

export const HarmfulDeltaSchema = z.object({
  type: z.literal("harmful"),
  bulletId: z.string(),
  sourceSession: z.string().optional(),
  reason: HarmfulReasonEnum.optional(),
  context: z.string().optional()
});

export const ReplaceDeltaSchema = z.object({
  type: z.literal("replace"),
  bulletId: z.string(),
  newContent: z.string(),
  reason: z.string().optional()
});

export const DeprecateDeltaSchema = z.object({
  type: z.literal("deprecate"),
  bulletId: z.string(),
  reason: z.string(),
  replacedBy: z.string().optional()
});

export const MergeDeltaSchema = z.object({
  type: z.literal("merge"),
  bulletIds: z.array(z.string()),
  mergedContent: z.string(),
  reason: z.string().optional()
});

export const PlaybookDeltaSchema = z.discriminatedUnion("type", [
  AddDeltaSchema,
  HelpfulDeltaSchema,
  HarmfulDeltaSchema,
  ReplaceDeltaSchema,
  DeprecateDeltaSchema,
  MergeDeltaSchema,
]);
export type PlaybookDelta = z.infer<typeof PlaybookDeltaSchema>;

// ============================================================================
// DEPRECATED PATTERN
// ============================================================================

export const DeprecatedPatternSchema = z.object({
  pattern: z.string(),
  deprecatedAt: z.string(),
  reason: z.string(),
  replacement: z.string().optional()
});
export type DeprecatedPattern = z.infer<typeof DeprecatedPatternSchema>;

// ============================================================================
// PLAYBOOK METADATA & SCHEMA
// ============================================================================

export const PlaybookMetadataSchema = z.object({
  createdAt: z.string(),
  lastReflection: z.string().optional(),
  totalReflections: z.number().default(0),
  totalSessionsProcessed: z.number().default(0)
});
export type PlaybookMetadata = z.infer<typeof PlaybookMetadataSchema>;

export const PlaybookSchema = z.object({
  schema_version: z.number().default(2),
  name: z.string().default("playbook"),
  description: z.string().default("Auto-generated by cass-memory"),
  metadata: PlaybookMetadataSchema,
  deprecatedPatterns: z.array(DeprecatedPatternSchema).default([]),
  bullets: z.array(PlaybookBulletSchema).default([])
});
export type Playbook = z.infer<typeof PlaybookSchema>;

// ----------------------------------------------------------------------------
// Scope Utilities
// ----------------------------------------------------------------------------

export interface ScopeContext {
  workspace?: string;
  language?: string;
  framework?: string;
  task?: string;
}

export function isBulletInScope(bullet: PlaybookBullet, ctx: ScopeContext): boolean {
  switch (bullet.scope) {
    case "global":
      return true;
    case "workspace":
      return !!bullet.workspace && !!ctx.workspace && bullet.workspace === ctx.workspace;
    case "language":
      return !!bullet.scopeKey && !!ctx.language && bullet.scopeKey.toLowerCase() === ctx.language.toLowerCase();
    case "framework":
      return !!bullet.scopeKey && !!ctx.framework && bullet.scopeKey.toLowerCase() === ctx.framework.toLowerCase();
    case "task":
      return !!bullet.scopeKey && !!ctx.task && bullet.scopeKey.toLowerCase() === ctx.task.toLowerCase();
    default:
      return true;
  }
}

export function filterBulletsByScope(bullets: PlaybookBullet[], ctx: ScopeContext): PlaybookBullet[] {
  return bullets.filter((b) => isBulletInScope(b, ctx));
}

// ============================================================================
// RELATED SESSION
// ============================================================================

export const RelatedSessionSchema = z.object({
  sessionPath: z.string(),
  agent: z.string(),
  relevanceScore: z.number(),
  snippet: z.string()
});
export type RelatedSession = z.infer<typeof RelatedSessionSchema>;

// ============================================================================
// DIARY ENTRY
// ============================================================================

export const DiaryEntrySchema = z.object({
  id: z.string(),
  sessionPath: z.string(),
  timestamp: z.string(),
  agent: z.string(),
  workspace: z.string().optional(),
  duration: z.number().optional(),
  status: SessionStatusEnum,
  accomplishments: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  challenges: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  keyLearnings: z.array(z.string()).default([]),
  relatedSessions: z.array(RelatedSessionSchema).default([]),
  tags: z.array(z.string()).default([]),
  searchAnchors: z.array(z.string()).default([])
});
export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

// ============================================================================
// CONFIGURATION
// ============================================================================

export const SanitizationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  extraPatterns: z.array(z.string()).default([]),
  auditLog: z.boolean().default(false),
  auditLevel: z.enum(["info", "debug"]).default("info"),
});
export type SanitizationConfig = z.infer<typeof SanitizationConfigSchema>;

export const ScoringConfigSectionSchema = z.object({
  decayHalfLifeDays: z.number().min(1).max(365).default(90),
  harmfulMultiplier: z.number().min(1).max(10).default(4),
  minFeedbackForActive: z.number().min(0).max(100).default(3),
  minHelpfulForProven: z.number().min(0).max(1000).default(10),
  maxHarmfulRatioForProven: z.number().min(0).max(1).default(0.1)
});
export type ScoringConfigSection = z.infer<typeof ScoringConfigSectionSchema>;

export const BudgetConfigSchema = z.object({
  dailyLimit: z.number().min(0).default(0.10),
  monthlyLimit: z.number().min(0).default(2.00),
  warningThreshold: z.number().min(0).max(100).default(80),
  currency: z.string().default("USD"),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

const PathString = z.string().transform((p) => expandPath(p));

export const ConfigSchema = z
  .object({
    schema_version: z.number().default(1).describe("Config file version"),
    llm: z
      .object({
        provider: LLMProviderEnum.default("anthropic"),
        model: z.string().default("claude-sonnet-4-20250514"),
      })
      .optional(),
    provider: LLMProviderEnum.default("anthropic"),
    model: z.string().default("claude-sonnet-4-20250514"),
    apiKey: z.string().optional(),
    cassPath: PathString.default("cass").describe("Path to cass executable"),
    playbookPath: PathString.default("~/.cass-memory/playbook.yaml"),
    diaryDir: PathString.default("~/.cass-memory/diary"),
    diaryPath: PathString.optional(),
    scoring: ScoringConfigSectionSchema.default({}),
    budget: BudgetConfigSchema.default({}),
    maxReflectorIterations: z.number().min(1).max(10).default(3),
    autoReflect: z.boolean().default(false),
    dedupSimilarityThreshold: z.number().min(0).max(1).default(0.85),
    pruneHarmfulThreshold: z.number().min(1).max(10).default(3),
    defaultDecayHalfLife: z.number().min(1).max(365).default(90),
    maxBulletsInContext: z.number().min(5).max(200).default(50),
    maxHistoryInContext: z.number().min(3).max(50).default(10),
    sessionLookbackDays: z.number().min(1).max(365).default(7),
    validationLookbackDays: z.number().min(30).max(365).default(90),
    validationEnabled: z.boolean().default(true),
    enrichWithCrossAgent: z.boolean().default(true),
    semanticSearchEnabled: z.boolean().default(false),
    verbose: z.boolean().default(false),
    jsonOutput: z.boolean().default(false),
    sanitization: SanitizationConfigSchema.default({}),
  })
  .refine(
    (cfg) => cfg.maxBulletsInContext >= cfg.maxHistoryInContext,
    "maxBulletsInContext must be >= maxHistoryInContext"
  );
export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// CASS INTEGRATION TYPES
// ============================================================================

export const CassSearchHitSchema = z.object({
  source_path: z.string(),
  line_number: z.number(),
  agent: z.string(),
  workspace: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string(),
  score: z.number().optional(),
  created_at: z.union([z.string(), z.number()]).optional(),
}).transform(data => ({
  ...data,
  sessionPath: data.source_path,
  timestamp: data.created_at ? String(data.created_at) : undefined
}));
export type CassSearchHit = z.infer<typeof CassSearchHitSchema>;

export const CassHitSchema = CassSearchHitSchema;
export type CassHit = CassSearchHit;

export const CassSearchResultSchema = z.object({
  query: z.string().optional(),
  hits: z.array(CassSearchHitSchema),
  totalCount: z.number().optional(),
  _meta: z
    .object({
      elapsed_ms: z.number().optional(),
      total_hits: z.number().optional(),
      wildcard_fallback: z.boolean().optional(),
      query_plan: z.string().optional(),
    })
    .optional(),
});
export type CassSearchResult = z.infer<typeof CassSearchResultSchema>;

export const CassSearchOptionsSchema = z.object({
  limit: z.number().min(1).max(1000).default(20),
  days: z.number().min(1).max(365).optional(),
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  workspace: z.string().optional(),
  fields: z.array(z.string()).optional(),
  maxTokens: z.number().min(10).max(2000).optional(),
  highlight: z.boolean().optional(),
  explain: z.boolean().optional(),
  timeout: z.number().min(1000).max(60000).optional(),
});
export type CassSearchOptions = z.infer<typeof CassSearchOptionsSchema>;

// Timeline types
export const CassTimelineSessionSchema = z.object({
  path: z.string(),
  agent: z.string().optional(),
  messageCount: z.number().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type CassTimelineSession = z.infer<typeof CassTimelineSessionSchema>;

export const CassTimelineGroupSchema = z.object({
  date: z.string(),
  sessions: z.array(CassTimelineSessionSchema),
});
export type CassTimelineGroup = z.infer<typeof CassTimelineGroupSchema>;

export const CassTimelineResultSchema = z.object({
  groups: z.array(CassTimelineGroupSchema),
});
export type CassTimelineResult = z.infer<typeof CassTimelineResultSchema>;

// ============================================================================
// COMMAND RESULT & AUDIT TYPES
// ============================================================================

export const CommandResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const AuditViolationSchema = z.object({
  bulletId: z.string(),
  bulletContent: z.string(),
  sessionPath: z.string(),
  evidence: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});
export type AuditViolation = z.infer<typeof AuditViolationSchema>;

export const AuditResultSchema = z.object({
  sessionsScanned: z.number(),
  violations: z.array(AuditViolationSchema).default([]),
  suggestions: z.array(z.string()).default([]),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

export const ErrorTypeEnum = z.enum([
  "ConfigError",
  "PlaybookError",
  "CassError",
  "ValidationError",
  "LLMError",
]);
export type ErrorType = z.infer<typeof ErrorTypeEnum>;

// ============================================================================
// CONTEXT OUTPUT
// ============================================================================

export const ScoredBulletSchema = PlaybookBulletBaseSchema.extend({
  relevanceScore: z.number(),
  effectiveScore: z.number(),
  lastHelpful: z.string().optional(),
  finalScore: z.number().optional()
});
export type ScoredBullet = z.infer<typeof ScoredBulletSchema>;

export const ContextResultSchema = z.object({
  task: z.string(),
  relevantBullets: z.array(ScoredBulletSchema),
  antiPatterns: z.array(ScoredBulletSchema),
  historySnippets: z.array(CassSearchHitSchema),
  deprecatedWarnings: z.array(z.string()),
  suggestedCassQueries: z.array(z.string()),
  formattedPrompt: z.string().optional(),
});
export type ContextResult = z.infer<typeof ContextResultSchema>;

// ============================================================================
// VALIDATION TYPES
// ============================================================================

export const EvidenceGateResultSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  suggestedState: z.enum(["draft", "active", "retired"]).optional(),
  sessionCount: z.number(),
  successCount: z.number(),
  failureCount: z.number()
});
export type EvidenceGateResult = z.infer<typeof EvidenceGateResultSchema>;

export const ValidationEvidenceSchema = z.object({
  sessionPath: z.string(),
  snippet: z.string(),
  supports: z.boolean(),
  confidence: z.number()
});
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

export const ValidationResultSchema = z.object({
  delta: PlaybookDeltaSchema.optional(),
  valid: z.boolean(),
  verdict: z.enum(["ACCEPT", "REJECT", "REFINE", "ACCEPT_WITH_CAUTION"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.array(ValidationEvidenceSchema).default([]),
  refinedRule: z.string().optional(),
  approved: z.boolean().optional(),
  supportingEvidence: z.array(ValidationEvidenceSchema).default([]),
  contradictingEvidence: z.array(ValidationEvidenceSchema).default([])
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ============================================================================
// PROCESSED LOG
// ============================================================================

export const ProcessedEntrySchema = z.object({
  sessionPath: z.string(),
  processedAt: z.string(),
  diaryId: z.string().optional(),
  deltasGenerated: z.number().default(0)
});
export type ProcessedEntry = z.infer<typeof ProcessedEntrySchema>;

// ============================================================================
// REPORTS
// ============================================================================

export const ConflictReportSchema = z.object({
  newBulletContent: z.string(),
  conflictingBulletId: z.string(),
  conflictingContent: z.string(),
  reason: z.string(),
});
export type ConflictReport = z.infer<typeof ConflictReportSchema>;

export const PromotionReportSchema = z.object({
  bulletId: z.string(),
  from: BulletMaturityEnum,
  to: BulletMaturityEnum,
  reason: z.string().optional(),
});
export type PromotionReport = z.infer<typeof PromotionReportSchema>;

export const InversionReportSchema = z.object({
  originalId: z.string(),
  originalContent: z.string(),
  antiPatternId: z.string(),
  antiPatternContent: z.string(),
  bulletId: z.string().optional(),
  reason: z.string().optional() 
});
export type InversionReport = z.infer<typeof InversionReportSchema>;

export const CurationResultSchema = z.object({
  playbook: PlaybookSchema,
  applied: z.number(),
  skipped: z.number(),
  conflicts: z.array(ConflictReportSchema),
  promotions: z.array(PromotionReportSchema),
  inversions: z.array(InversionReportSchema),
  pruned: z.number(),
});
export type CurationResult = z.infer<typeof CurationResultSchema>;

// ============================================================================
// SEARCH PLAN
// ============================================================================

export const SearchPlanSchema = z.object({
  queries: z.array(z.string()).max(5),
  keywords: z.array(z.string())
});
export type SearchPlan = z.infer<typeof SearchPlanSchema>;

// ============================================================================
// STATS
// ============================================================================

export const PlaybookStatsSchema = z.object({
  total: z.number(),
  byScope: z.object({
    global: z.number(),
    workspace: z.number()
  }),
  byMaturity: z.object({
    candidate: z.number(),
    established: z.number(),
    proven: z.number(),
    deprecated: z.number()
  }),
  byType: z.object({
    rule: z.number(),
    antiPattern: z.number()
  }),
  scoreDistribution: z.object({
    excellent: z.number(),
    good: z.number(),
    neutral: z.number(),
    atRisk: z.number()
  })
});
export type PlaybookStats = z.infer<typeof PlaybookStatsSchema>;

export const ReflectionStatsSchema = z.object({
  sessionsProcessed: z.number(),
  diariesGenerated: z.number(),
  deltasProposed: z.number(),
  deltasApplied: z.number(),
  deltasRejected: z.number(),
  bulletsAdded: z.number(),
  bulletsMerged: z.number(),
  bulletsDeprecated: z.number(),
  duration: z.number(),
  timestamp: z.string()
});
export type ReflectionStats = z.infer<typeof ReflectionStatsSchema>;

// ============================================================================
// COMMAND RESULT & ERROR TYPES
// ============================================================================

/**
 * Violation severity levels for audit command.
 * - low: Stylistic deviation
 * - medium: Best practice not followed
 * - high: Security/correctness issue
 */
export const AuditSeverityEnum = z.enum(["low", "medium", "high"]);
export type AuditSeverity = z.infer<typeof AuditSeverityEnum>;

/**
 * Individual violation found by audit command.
 * Represents a rule that was violated or contradicted in a session.
 */
export const AuditViolationSchema = z.object({
  /** ID of bullet that was violated or contradicted */
  bulletId: z.string(),
  /** Text of the rule that was violated */
  bulletContent: z.string(),
  /** Path to session where violation occurred */
  sessionPath: z.string(),
  /** Excerpt showing the violation */
  evidence: z.string(),
  /** How serious the violation is */
  severity: AuditSeverityEnum
});
export type AuditViolation = z.infer<typeof AuditViolationSchema>;

/**
 * Standard return type for all CLI commands.
 * Provides consistent success/failure responses with optional data payloads.
 */
export const CommandResultSchema = z.object({
  /** True if command completed successfully */
  success: z.boolean(),
  /** Human-readable summary of result */
  message: z.string(),
  /** Optional command-specific payload (varies by command) */
  data: z.unknown().optional(),
  /** Optional error details for failures (stack trace in verbose mode) */
  error: z.string().optional()
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/**
 * Doctor/health check result for individual check items.
 */
export const HealthCheckItemSchema = z.object({
  /** Name of the check */
  name: z.string(),
  /** Whether the check passed */
  passed: z.boolean(),
  /** Human-readable status message */
  message: z.string(),
  /** Optional details or recommendations */
  details: z.string().optional()
});
export type HealthCheckItem = z.infer<typeof HealthCheckItemSchema>;

/**
 * Full health check result from doctor command.
 */
export const HealthCheckResultSchema = z.object({
  /** Overall health status */
  healthy: z.boolean(),
  /** Individual check results */
  checks: z.array(HealthCheckItemSchema),
  /** Summary of passed/failed checks */
  summary: z.object({
    passed: z.number(),
    failed: z.number(),
    total: z.number()
  })
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export const Schemas = {
  FeedbackEvent: FeedbackEventSchema,
  PlaybookBulletBase: PlaybookBulletBaseSchema,
  PlaybookBullet: PlaybookBulletSchema,
  NewBulletData: NewBulletDataSchema,
  PlaybookDelta: PlaybookDeltaSchema,
  Playbook: PlaybookSchema,
  DiaryEntry: DiaryEntrySchema,
  Config: ConfigSchema,
  ContextResult: ContextResultSchema,
  ValidationResult: ValidationResultSchema,
  SearchPlan: SearchPlanSchema,
  PlaybookStats: PlaybookStatsSchema,
  ReflectionStats: ReflectionStatsSchema,
  CommandResult: CommandResultSchema,
  AuditViolation: AuditViolationSchema,
  HealthCheckItem: HealthCheckItemSchema,
  HealthCheckResult: HealthCheckResultSchema
} as const;