/**
 * src/types.ts - Complete TypeScript interfaces + Zod schemas for cass-memory
 * This is the core type system - everything depends on it
 */

import { z } from 'zod';

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const HarmfulReasonEnum = z.enum([
  'caused_bug',
  'wasted_time',
  'contradicted_requirements',
  'wrong_context',
  'outdated',
  'other'
]);
export type HarmfulReason = z.infer<typeof HarmfulReasonEnum>;

export const SessionStatusEnum = z.enum(['success', 'failure', 'mixed']);
export type SessionStatus = z.infer<typeof SessionStatusEnum>;

export const BulletScopeEnum = z.enum(['global', 'workspace', 'language', 'framework', 'task']);
export type BulletScope = z.infer<typeof BulletScopeEnum>;

export const BulletTypeEnum = z.enum(['rule', 'anti-pattern']);
export type BulletType = z.infer<typeof BulletTypeEnum>;

export const BulletKindEnum = z.enum([
  'project_convention',
  'stack_pattern',
  'workflow_rule',
  'anti_pattern'
]);
export type BulletKind = z.infer<typeof BulletKindEnum>;

export const BulletStateEnum = z.enum(['draft', 'active', 'retired']);
export type BulletState = z.infer<typeof BulletStateEnum>;

export const BulletMaturityEnum = z.enum(['candidate', 'established', 'proven', 'deprecated']);
export type BulletMaturity = z.infer<typeof BulletMaturityEnum>;

export const LLMProviderEnum = z.enum(['openai', 'anthropic', 'google']);
export type LLMProvider = z.infer<typeof LLMProviderEnum>;

// ============================================================================
// FEEDBACK EVENT (Critical for confidence decay - P1)
// ============================================================================

export const FeedbackEventSchema = z.object({
  type: z.enum(['helpful', 'harmful']),
  timestamp: z.string(),
  sessionPath: z.string().optional(),
  reason: HarmfulReasonEnum.optional(),
  context: z.string().optional(),
  decayedValue: z.number().optional()
});
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

// ============================================================================
// PLAYBOOK BULLET (Enhanced with all innovations)
// ============================================================================

export const PlaybookBulletSchema = z.object({
  id: z.string(),
  scope: BulletScopeEnum.default('global'),
  scopeKey: z.string().optional(),
  workspace: z.string().optional(),
  category: z.string(),
  content: z.string(),
  searchPointer: z.string().optional(),
  type: BulletTypeEnum.default('rule'),
  isNegative: z.boolean().default(false),
  kind: BulletKindEnum.default('stack_pattern'),
  state: BulletStateEnum.default('draft'),
  maturity: BulletMaturityEnum.default('candidate'),
  promotedAt: z.string().optional(),
  helpfulCount: z.number().default(0),
  harmfulCount: z.number().default(0),
  feedbackEvents: z.array(FeedbackEventSchema).default([]), // Combined events
  helpfulEvents: z.array(FeedbackEventSchema).default([]),
  harmfulEvents: z.array(FeedbackEventSchema).default([]),
  lastValidatedAt: z.string().optional(),
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
  effectiveScore: z.number().optional() // Cached computed score
});
export type PlaybookBullet = z.infer<typeof PlaybookBulletSchema>;

// ============================================================================
// NEW BULLET DATA (for delta operations)
// ============================================================================

export const NewBulletDataSchema = z.object({
  category: z.string(),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  searchPointer: z.string().optional(),
  scope: BulletScopeEnum.default('global'),
  workspace: z.string().optional(),
  kind: BulletKindEnum.default('stack_pattern'),
  type: BulletTypeEnum.default('rule')
});
export type NewBulletData = z.infer<typeof NewBulletDataSchema>;

// ============================================================================
// PLAYBOOK DELTA (for incremental updates)
// ============================================================================

export const PlaybookDeltaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    bullet: NewBulletDataSchema,
    reason: z.string(),
    sourceSession: z.string()
  }),
  z.object({
    type: z.literal('helpful'),
    bulletId: z.string(),
    sourceSession: z.string().optional()
  }),
  z.object({
    type: z.literal('harmful'),
    bulletId: z.string(),
    sourceSession: z.string().optional(),
    reason: HarmfulReasonEnum.optional(),
    context: z.string().optional()
  }),
  z.object({
    type: z.literal('replace'),
    bulletId: z.string(),
    newContent: z.string(),
    reason: z.string()
  }),
  z.object({
    type: z.literal('deprecate'),
    bulletId: z.string(),
    reason: z.string(),
    replacedBy: z.string().optional()
  }),
  z.object({
    type: z.literal('merge'),
    bulletIds: z.array(z.string()),
    mergedContent: z.string(),
    reason: z.string()
  })
]);
export type PlaybookDelta = z.infer<typeof PlaybookDeltaSchema>;

// ============================================================================
// DEPRECATED PATTERN (Tombstone mechanism)
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
  name: z.string().default('playbook'),
  description: z.string().default('Auto-generated by cass-memory'),
  metadata: PlaybookMetadataSchema,
  deprecatedPatterns: z.array(DeprecatedPatternSchema).default([]),
  bullets: z.array(PlaybookBulletSchema).default([])
});
export type Playbook = z.infer<typeof PlaybookSchema>;

// ============================================================================
// RELATED SESSION (for cross-agent enrichment)
// ============================================================================

export const RelatedSessionSchema = z.object({
  sessionPath: z.string(),
  agent: z.string(),
  relevanceScore: z.number(),
  snippet: z.string()
});
export type RelatedSession = z.infer<typeof RelatedSessionSchema>;

// ============================================================================
// DIARY ENTRY (Working Memory)
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

export const ConfigSchema = z.object({
  schema_version: z.number().default(1),
  // Nested LLM config (preferred)
  llm: z.object({
    provider: z.string().default('anthropic'),
    model: z.string().default('claude-sonnet-4-20250514')
  }).optional(),
  // Flat config (backwards compatibility)
  provider: LLMProviderEnum.default('anthropic'),
  model: z.string().default('claude-sonnet-4-20250514'),
  // Paths
  cassPath: z.string().default('cass'),
  playbookPath: z.string().default('~/.cass-memory/playbook.yaml'),
  diaryDir: z.string().default('~/.cass-memory/diary'),
  diaryPath: z.string().optional(), // Alias for diaryDir
  // Reflector settings
  maxReflectorIterations: z.number().default(3),
  autoReflect: z.boolean().default(false),
  // Thresholds
  dedupSimilarityThreshold: z.number().default(0.85),
  pruneHarmfulThreshold: z.number().default(3),
  defaultDecayHalfLife: z.number().default(90),
  // Context limits
  maxBulletsInContext: z.number().default(50),
  maxHistoryInContext: z.number().default(10),
  sessionLookbackDays: z.number().default(7),
  validationLookbackDays: z.number().default(90),
  // Feature flags
  validationEnabled: z.boolean().default(true),
  enrichWithCrossAgent: z.boolean().default(true),
  semanticSearchEnabled: z.boolean().default(false),
  verbose: z.boolean().default(false),
  jsonOutput: z.boolean().default(false),
  // Sanitization
  sanitization: z.object({
    enabled: z.boolean().default(true),
    extraPatterns: z.array(z.string()).default([])
  }).default({})
});
export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// CASS INTEGRATION TYPES
// ============================================================================

export const CassSearchHitSchema = z.object({
  sessionPath: z.string(),
  agent: z.string(),
  timestamp: z.string().optional(),
  snippet: z.string(),
  lineNumber: z.number().optional(),
  relevance: z.number().optional(),
  source_path: z.string().optional(),
  line_number: z.number().optional(),
  title: z.string().optional(),
  score: z.number().optional(),
  created_at: z.string().optional()
});
export type CassSearchHit = z.infer<typeof CassSearchHitSchema>;

// Aliases for backwards compatibility
export const CassHitSchema = CassSearchHitSchema;
export type CassHit = CassSearchHit;

export const CassSearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(CassSearchHitSchema),
  totalCount: z.number()
});
export type CassSearchResult = z.infer<typeof CassSearchResultSchema>;

export const CassSearchOptionsSchema = z.object({
  limit: z.number().default(20),
  days: z.number().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional()
});
export type CassSearchOptions = z.infer<typeof CassSearchOptionsSchema>;

// ============================================================================
// CONTEXT OUTPUT (Pre-task hydration result)
// ============================================================================

export const ScoredBulletSchema = PlaybookBulletSchema.extend({
  relevanceScore: z.number(),
  effectiveScore: z.number(),
  lastHelpful: z.string().optional()
});
export type ScoredBullet = z.infer<typeof ScoredBulletSchema>;

export const ContextResultSchema = z.object({
  task: z.string(),
  relevantBullets: z.array(ScoredBulletSchema),
  antiPatterns: z.array(ScoredBulletSchema),
  historySnippets: z.array(CassSearchHitSchema),
  deprecatedWarnings: z.array(z.string()),
  suggestedCassQueries: z.array(z.string())
});
export type ContextResult = z.infer<typeof ContextResultSchema>;

// ============================================================================
// VALIDATION TYPES (Scientific validation)
// ============================================================================

export const ValidationEvidenceSchema = z.object({
  sessionPath: z.string(),
  snippet: z.string(),
  supports: z.boolean(),
  confidence: z.number()
});
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

export const ValidationResultSchema = z.object({
  delta: PlaybookDeltaSchema,
  approved: z.boolean(),
  supportingEvidence: z.array(ValidationEvidenceSchema),
  contradictingEvidence: z.array(ValidationEvidenceSchema),
  reason: z.string()
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ============================================================================
// HEALTH CHECK TYPES
// ============================================================================

export const HealthCheckSchema = z.object({
  category: z.enum(['cass', 'storage', 'llm', 'config', 'self_test']),
  name: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
  details: z.record(z.unknown()).optional()
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthCheckResultSchema = z.object({
  overall: z.enum(['healthy', 'degraded', 'unhealthy']),
  checks: z.array(HealthCheckSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string())
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

// ============================================================================
// COMMAND RESULT & ERROR TYPES
// ============================================================================

export const CommandResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional()
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const CMErrorCodeEnum = z.enum([
  'CASS_NOT_FOUND',
  'CASS_INDEX_STALE',
  'CASS_SEARCH_FAILED',
  'PLAYBOOK_CORRUPT',
  'PLAYBOOK_NOT_FOUND',
  'CONFIG_INVALID',
  'LLM_API_ERROR',
  'LLM_RATE_LIMIT',
  'LLM_BUDGET_EXCEEDED',
  'SANITIZATION_FAILED',
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'INVALID_INPUT',
  'UNKNOWN_ERROR'
]);
export type CMErrorCode = z.infer<typeof CMErrorCodeEnum>;

export const CMErrorSchema = z.object({
  code: CMErrorCodeEnum,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  recoverable: z.boolean().default(true)
});
export type CMError = z.infer<typeof CMErrorSchema>;

// ============================================================================
// EXIT CODES
// ============================================================================

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_ARGS: 2,
  CONFIG_ERROR: 3,
  CASS_ERROR: 4,
  LLM_ERROR: 5,
  FILE_ERROR: 6,
  PERMISSION_ERROR: 7,
  BUDGET_EXCEEDED: 8
} as const;
export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

// ============================================================================
// PROCESSED LOG (Tracking reflected sessions)
// ============================================================================

export const ProcessedEntrySchema = z.object({
  sessionPath: z.string(),
  processedAt: z.string(),
  diaryId: z.string().optional(),
  deltasGenerated: z.number().default(0)
});
export type ProcessedEntry = z.infer<typeof ProcessedEntrySchema>;

// ============================================================================
// REFLECTION & PLAYBOOK STATS
// ============================================================================

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

// ============================================================================
// SEARCH PLAN (for context generation)
// ============================================================================

export const SearchPlanSchema = z.object({
  queries: z.array(z.string()).max(5),
  keywords: z.array(z.string())
});
export type SearchPlan = z.infer<typeof SearchPlanSchema>;

// ============================================================================
// EXPORTED SCHEMAS (for LLM generateObject)
// ============================================================================

export const Schemas = {
  FeedbackEvent: FeedbackEventSchema,
  PlaybookBullet: PlaybookBulletSchema,
  NewBulletData: NewBulletDataSchema,
  PlaybookDelta: PlaybookDeltaSchema,
  Playbook: PlaybookSchema,
  DiaryEntry: DiaryEntrySchema,
  Config: ConfigSchema,
  ContextResult: ContextResultSchema,
  ValidationResult: ValidationResultSchema,
  HealthCheckResult: HealthCheckResultSchema,
  SearchPlan: SearchPlanSchema,
  PlaybookStats: PlaybookStatsSchema,
  ReflectionStats: ReflectionStatsSchema
} as const;
