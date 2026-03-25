import { z } from "zod";

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

export const BulletTypeEnum = z.enum(["rule", "anti-pattern"]);
export type BulletType = z.infer<typeof BulletTypeEnum>;

export const BulletKindEnum = z.enum([
  "project_convention",
  "stack_pattern",
  "workflow_rule",
  "anti_pattern"
]);
export type BulletKind = z.infer<typeof BulletKindEnum>;

export const BulletSourceEnum = z.enum(["learned", "community", "manual", "custom"]);
export type BulletSource = z.infer<typeof BulletSourceEnum>;

export const BulletStateEnum = z.enum(["draft", "active", "retired"]);
export type BulletState = z.infer<typeof BulletStateEnum>;

export const BulletMaturityEnum = z.enum(["candidate", "established", "proven", "deprecated"]);
export type BulletMaturity = z.infer<typeof BulletMaturityEnum>;

export const LLMProviderEnum = z.enum(["openai", "anthropic", "google", "ollama"]);
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

export const PlaybookBulletSchema = z.object({
  id: z.string(),
  scope: BulletScopeEnum.default("global"),
  scopeKey: z.string().optional(),
  workspace: z.string().optional(),
  category: z.string(),
  content: z.string(),
  source: BulletSourceEnum.default("learned"),
  searchPointer: z.string().optional(),
  type: BulletTypeEnum.default("rule"),
  isNegative: z.boolean().default(false),
  kind: BulletKindEnum.default("stack_pattern"),
  state: BulletStateEnum.default("draft"),
  maturity: BulletMaturityEnum.default("candidate"),
  promotedAt: z.string().optional(),
  helpfulCount: z.number().default(0),
  harmfulCount: z.number().default(0),
  feedbackEvents: z.array(FeedbackEventSchema).default([]),
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
  effectiveScore: z.number().optional(),
  deprecatedAt: z.string().optional()
});
export type PlaybookBullet = z.infer<typeof PlaybookBulletSchema>;

// ============================================================================
// NEW BULLET DATA
// ============================================================================

export const NewBulletDataSchema = PlaybookBulletSchema.partial().extend({
  content: z.string(),
  category: z.string()
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
// TRAUMA (PROJECT HOT STOVE)
// ============================================================================

export const TraumaSeverityEnum = z.enum(["CRITICAL", "FATAL"]);
export type TraumaSeverity = z.infer<typeof TraumaSeverityEnum>;

export const TraumaScopeEnum = z.enum(["global", "project"]);
export type TraumaScope = z.infer<typeof TraumaScopeEnum>;

export const TraumaStatusEnum = z.enum(["active", "healed"]);
export type TraumaStatus = z.infer<typeof TraumaStatusEnum>;

export const TraumaEntrySchema = z.object({
  id: z.string(),
  severity: TraumaSeverityEnum,
  pattern: z.string(), // Regex string
  scope: TraumaScopeEnum,
  projectPath: z.string().optional(), // Required if scope is project
  status: TraumaStatusEnum,
  trigger_event: z.object({
    session_path: z.string(),
    timestamp: z.string(),
    human_message: z.string().optional()
  }),
  created_at: z.string()
});
export type TraumaEntry = z.infer<typeof TraumaEntrySchema>;

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

// ============================================================================
// EMBEDDING CACHE
// ============================================================================

export const EmbeddingCacheEntrySchema = z.object({
  contentHash: z.string(),
  embedding: z.array(z.number()),
  computedAt: z.string()
});
export type EmbeddingCacheEntry = z.infer<typeof EmbeddingCacheEntrySchema>;

export const EmbeddingCacheSchema = z.object({
  version: z.string(),
  model: z.string(),
  bullets: z.record(EmbeddingCacheEntrySchema).default({})
});
export type EmbeddingCache = z.infer<typeof EmbeddingCacheSchema>;

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
  auditLevel: z.enum(["off", "info", "debug"]).default("info")
});
export type SanitizationConfig = z.infer<typeof SanitizationConfigSchema>;

export const ScoringConfigSectionSchema = z.object({
  decayHalfLifeDays: z.number().default(90),
  harmfulMultiplier: z.number().default(4),
  minFeedbackForActive: z.number().default(3),
  minHelpfulForProven: z.number().default(10),
  maxHarmfulRatioForProven: z.number().default(0.1)
});
export type ScoringConfigSection = z.infer<typeof ScoringConfigSectionSchema>;

export const BudgetConfigSchema = z.object({
  dailyLimit: z.number().default(0.50),
  monthlyLimit: z.number().default(10.00),
  warningThreshold: z.number().default(80),
  currency: z.string().default("USD")
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ============================================================================
// CROSS-AGENT PRIVACY SETTINGS
// ============================================================================

export const CrossAgentConfigSchema = z.object({
  /**
   * Master toggle for cross-agent enrichment features.
   * When false, the system will not pull in sessions from other agents for enrichment.
   */
  enabled: z.boolean().default(false),
  /**
   * Explicit user consent flag. We require this in addition to `enabled`
   * so operators can distinguish "enabled by config edit" from "explicitly consented".
   */
  consentGiven: z.boolean().default(false),
  /** ISO timestamp of when consent was granted (if any). */
  consentDate: z.string().nullable().optional(),
  /**
   * Allowlist of agent names (e.g., ["claude","cursor"]).
   * Empty means "no allowlist restriction" (all agents are allowed) when enabled.
   */
  agents: z.array(z.string()).default([]),
  /** When true, writes audit events when cross-agent enrichment occurs. */
  auditLog: z.boolean().default(true),
});
export type CrossAgentConfig = z.infer<typeof CrossAgentConfigSchema>;

// ============================================================================
// REMOTE CASS (OPTIONAL) — SSH-BASED REMOTE HISTORY
// ============================================================================

export const RemoteCassHostSchema = z.object({
  /**
   * SSH target (typically a Host alias from ~/.ssh/config).
   * Examples: "workstation", "buildbox", "user@host".
   */
  host: z.string().min(1),
  /** Optional display label (defaults to host). */
  label: z.string().min(1).optional(),
});
export type RemoteCassHost = z.infer<typeof RemoteCassHostSchema>;

export const RemoteCassConfigSchema = z.object({
  /** Master toggle (no surprise network calls). */
  enabled: z.boolean().default(false),
  /** Remote hosts to query via SSH for cass history. */
  hosts: z.array(RemoteCassHostSchema).default([]),
}).default({});
export type RemoteCassConfig = z.infer<typeof RemoteCassConfigSchema>;

export const ConfigSchema = z.object({
  schema_version: z.number().default(1),
  llm: z.object({
    provider: z.string().default("anthropic"),
    model: z.string().default("claude-sonnet-4-20250514")
  }).optional(),
  provider: LLMProviderEnum.default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  cassPath: z.string().default("cass"),
  remoteCass: RemoteCassConfigSchema.default({}),
  playbookPath: z.string().default("~/.memory-system/playbook.yaml"),
  diaryDir: z.string().default("~/.memory-system/diary"),
  scoring: ScoringConfigSectionSchema.default({}),
  maxReflectorIterations: z.number().default(3),
  autoReflect: z.boolean().default(false),
  // Session type filtering: exclude internal/auto-generated sessions from reflection
  // Patterns are matched against session paths (case-insensitive substring match)
  sessionExcludePatterns: z.array(z.string()).default([
    "prompt_suggestion",      // Claude Code internal prompt suggestions
    "prompt-suggestion",      // Alternative naming
    "auto_complete",          // Autocomplete sessions
    "auto-complete",
    "inline_completion",      // Inline completion sessions
    "inline-completion",
    "/subagents/agent-a",     // Claude Code subagent internal sessions (agent-a* pattern)
  ]),
  // Set to true to include all sessions (ignore exclusion patterns)
  sessionIncludeAll: z.boolean().default(false),
  dedupSimilarityThreshold: z.number().default(0.85),
  pruneHarmfulThreshold: z.number().default(3),
  defaultDecayHalfLife: z.number().default(90),
  maxBulletsInContext: z.number().default(50),
  maxHistoryInContext: z.number().default(10),
  sessionLookbackDays: z.number().default(7),
  validationLookbackDays: z.number().default(90),
  relatedSessionsDays: z.number().default(30),
  minRelevanceScore: z.number().default(0.1),
  maxRelatedSessions: z.number().default(5),
  validationEnabled: z.boolean().default(true),
  crossAgent: CrossAgentConfigSchema.default({}),
  semanticSearchEnabled: z.boolean().default(true),
  semanticWeight: z.number().min(0).max(1).default(0.6),
  embeddingModel: z.string().default("Xenova/all-MiniLM-L6-v2"),
  verbose: z.boolean().default(false),
  jsonOutput: z.boolean().default(false),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  sanitization: SanitizationConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),

  // Memory system directories and paths (Phase 1)
  sessionNotesDir: z.string().default("~/.memory-system/session-notes"),
  knowledgeDir: z.string().default("~/.memory-system/knowledge"),
  digestsDir: z.string().default("~/.memory-system/digests"),
  notesDir: z.string().default("~/.memory-system/notes"),
  searchDbPath: z.string().default("~/.memory-system/search.db"),
  stateJsonPath: z.string().default("~/.memory-system/state.json"),
  topicsJsonPath: z.string().default("~/.memory-system/topics.json"),

  // Memory system tuning
  periodicJobIntervalHours: z.number().default(24),
  knowledgePageBloatThreshold: z.number().default(5000),
  staleTopicIgnoreDays: z.number().default(30),
  transcriptRetentionDays: z.number().default(30),

  // Per-step model overrides for cost optimization.
  // Extractive tasks use Haiku (cheap), generative tasks use Sonnet (quality).
  pipelineModels: z.object({
    sessionNoteCreate: z.string().default("claude-haiku-4-5-20251001"),
    sessionNoteExtend: z.string().default("claude-haiku-4-5-20251001"),
    diaryFromNote: z.string().default("claude-haiku-4-5-20251001"),
    reflectorCall1: z.string().default("claude-haiku-4-5-20251001"),
    reflectorCall2: z.string().default(""), // empty = use config.model (Sonnet)
    knowledgeGen: z.string().default(""),   // empty = use config.model (Sonnet)
    digestSynthesis: z.string().default("claude-haiku-4-5-20251001"), // cheap synthesis call
  }).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// CASS INTEGRATION TYPES
// ============================================================================

export const CassHitOriginSchema = z.object({
  kind: z.enum(["local", "remote"]),
  host: z.string().min(1).optional(),
});
export type CassHitOrigin = z.infer<typeof CassHitOriginSchema>;

export const CassSearchHitSchema = z.object({
  source_path: z.string(),
  line_number: z.number(),
  agent: z.string(),
  workspace: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string(),
  score: z.number().optional(),
  created_at: z.union([z.string(), z.number()]).nullable().optional(),
  origin: CassHitOriginSchema.optional(),
}).transform(data => ({
  ...data,
  sessionPath: data.source_path,
  timestamp: data.created_at ? String(data.created_at) : undefined
}));
export type CassSearchHit = z.infer<typeof CassSearchHitSchema>;

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

// Missing exports needed by cass.ts
export interface CassTimelineGroup {
  date: string;
  sessions: Array<{
    path: string;
    agent: string;
    messageCount: number;
    startTime: string;
    endTime: string;
  }>;
}

export interface CassTimelineResult {
  groups: CassTimelineGroup[];
}

// ============================================================================
// PHASE 4 — CONTEXT RETRIEVAL + TOPIC SYSTEM
// ============================================================================

// --- Knowledge Search Hit (replaces CassSearchHit in context results) ---

export const KnowledgeSearchHitSchema = z.object({
  type: z.enum(["knowledge", "session_note", "digest", "transcript", "playbook"]),
  id: z.string(),
  snippet: z.string(),
  score: z.number(),
  title: z.string().optional(),
});
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHitSchema>;

// --- Topic Excerpts for cm_context ---

export const TopicExcerptSchema = z.object({
  topic: z.string(),
  slug: z.string(),
  sections: z.array(z.object({
    title: z.string(),
    preview: z.string(),
  })),
});
export type TopicExcerpt = z.infer<typeof TopicExcerptSchema>;

// --- Recent/Unprocessed Session for cm_context ---

export const RecentSessionSchema = z.object({
  id: z.string(),
  date: z.string(),
  abstract: z.string(),
  note_text: z.string(),
});
export type RecentSession = z.infer<typeof RecentSessionSchema>;

// --- Related Topic for cm_context ---

export const RelatedTopicSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  similarity: z.number(),
});
export type RelatedTopic = z.infer<typeof RelatedTopicSchema>;

// --- Review Queue (Phase 4 writes, Phase 5 reads+updates) ---

export const ColdStartSuggestionSourceSchema = z.object({
  type: z.enum(["knowledge_section", "session_note"]),
  topic: z.string().optional(),
  section: z.string().optional(),
  snippet: z.string(),
  similarity: z.number(),
});
export type ColdStartSuggestionSource = z.infer<typeof ColdStartSuggestionSourceSchema>;

export const ReviewQueueStatusEnum = z.enum(["pending", "approved", "dismissed"]);
export type ReviewQueueStatus = z.infer<typeof ReviewQueueStatusEnum>;

export const ColdStartSuggestionItemSchema = z.object({
  id: z.string(),
  type: z.literal("cold_start_suggestion"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string(),
  source: ColdStartSuggestionSourceSchema,
});

export const BloatedPageItemSchema = z.object({
  id: z.string(),
  type: z.literal("bloated_page"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string(),
  data: z.object({
    word_count: z.number(),
    section_count: z.number(),
  }),
});

export const StaleTopicItemSchema = z.object({
  id: z.string(),
  type: z.literal("stale_topic"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string(),
  data: z.object({
    days_ignored: z.number(),
  }),
});

export const UserFlagItemSchema = z.object({
  id: z.string(),
  type: z.literal("user_flag"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string().default(""),
  target_path: z.string(),
  target_section: z.string().optional(),
  reason: z.string().optional(),
});

export const TopicSuggestionItemSchema = z.object({
  id: z.string(),
  type: z.literal("topic_suggestion"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string(),
  data: z.object({
    name: z.string(),
    description: z.string(),
    suggested_from_session: z.string(),
  }),
});

export const ContradictionClaimSchema = z.object({
  claim: z.string(),
  source: z.string(), // session ID or "user"
  date: z.string(), // when the claim was made
  confidence: z.enum(["verified", "inferred", "uncertain"]).optional(),
  section_id: z.string().optional(), // knowledge page section ID if applicable
});
export type ContradictionClaim = z.infer<typeof ContradictionClaimSchema>;

export const ContradictionItemSchema = z.object({
  id: z.string(),
  type: z.literal("contradiction"),
  status: ReviewQueueStatusEnum.default("pending"),
  created: z.string(),
  target_topic: z.string(),
  target_section: z.string(), // the section heading where the contradiction was found
  data: z.object({
    description: z.string(), // short description of what's contradicted
    claims: z.array(ContradictionClaimSchema), // all competing assertions
  }),
});

export const ReviewQueueItemSchema = z.discriminatedUnion("type", [
  ColdStartSuggestionItemSchema,
  BloatedPageItemSchema,
  StaleTopicItemSchema,
  UserFlagItemSchema,
  TopicSuggestionItemSchema,
  ContradictionItemSchema,
]);
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueSchema = z.object({
  schema_version: z.literal(1),
  items: z.array(ReviewQueueItemSchema).default([]),
});
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;

// ============================================================================
// CONTEXT OUTPUT
// ============================================================================

export const ScoredBulletSchema = PlaybookBulletSchema.extend({
  relevanceScore: z.number(),
  effectiveScore: z.number(),
  lastHelpful: z.string().optional(),
  finalScore: z.number().optional()
});
export type ScoredBullet = z.infer<typeof ScoredBulletSchema>;

export const DegradedCassReasonSchema = z.enum(["NOT_FOUND", "INDEX_MISSING", "FTS_TABLE_MISSING", "TIMEOUT", "OTHER"]);
export type DegradedCassReason = z.infer<typeof DegradedCassReasonSchema>;

export const DegradedCassSchema = z.object({
  available: z.boolean(),
  reason: DegradedCassReasonSchema,
  message: z.string().optional(),
  suggestedFix: z.array(z.string()).optional(),
});
export type DegradedCass = z.infer<typeof DegradedCassSchema>;

export const DegradedSummarySchema = z.object({
  cass: DegradedCassSchema.optional(),
  remoteCass: z.array(DegradedCassSchema.extend({ host: z.string() })).optional(),
  semantic: z.unknown().optional(),
  llm: z.unknown().optional(),
}).partial();
export type DegradedSummary = z.infer<typeof DegradedSummarySchema>;

export const ContextResultSchema = z.object({
  task: z.string(),
  relevantBullets: z.array(ScoredBulletSchema),
  antiPatterns: z.array(ScoredBulletSchema),
  searchResults: z.array(KnowledgeSearchHitSchema).default([]),
  deprecatedWarnings: z.array(z.string()),
  suggestedCassQueries: z.array(z.string()),
  degraded: DegradedSummarySchema.optional(),
  formattedPrompt: z.string().optional(),
  traumaWarning: z.object({
    pattern: z.string(),
    reason: z.string(),
    reference: z.string()
  }).optional(),
  // Phase 4 extensions (all optional for backwards compatibility)
  topicExcerpts: z.array(TopicExcerptSchema).optional(),
  recentSessions: z.array(RecentSessionSchema).optional(),
  relatedTopics: z.array(RelatedTopicSchema).optional(),
  suggestedDeepDives: z.array(z.string()).optional(),
  lastReflectionRun: z.string().optional(),
});
export type ContextResult = z.infer<typeof ContextResultSchema>;

// ============================================================================
// DOCTOR OUTPUT
// ============================================================================

export const DoctorCheckStatusSchema = z.enum(["pass", "warn", "fail"]);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;

export const DoctorOverallStatusSchema = z.enum(["healthy", "degraded", "unhealthy"]);
export type DoctorOverallStatus = z.infer<typeof DoctorOverallStatusSchema>;

export const DoctorCheckSchema = z.object({
  category: z.string(),
  item: z.string(),
  status: DoctorCheckStatusSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorFixableIssueSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: z.string(),
  severity: z.enum(["warn", "fail"]),
  safety: z.enum(["safe", "cautious", "manual"]),
  howToFix: z.array(z.string()).optional(),
});
export type DoctorFixableIssue = z.infer<typeof DoctorFixableIssueSchema>;

export const DoctorRecommendedActionSchema = z.object({
  label: z.string(),
  command: z.string().optional(),
  reason: z.string(),
  urgency: z.enum(["high", "medium", "low"]),
});
export type DoctorRecommendedAction = z.infer<typeof DoctorRecommendedActionSchema>;

export const DoctorFixPlanSchema = z.object({
  enabled: z.boolean(),
  dryRun: z.boolean(),
  interactive: z.boolean(),
  force: z.boolean(),
  wouldApply: z.array(z.string()),
  wouldSkip: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type DoctorFixPlan = z.infer<typeof DoctorFixPlanSchema>;

export const DoctorFixResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  message: z.string(),
});
export type DoctorFixResult = z.infer<typeof DoctorFixResultSchema>;

export const DoctorResultSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  overallStatus: DoctorOverallStatusSchema,
  checks: z.array(DoctorCheckSchema),
  fixableIssues: z.array(DoctorFixableIssueSchema),
  recommendedActions: z.array(DoctorRecommendedActionSchema),
  fixPlan: DoctorFixPlanSchema.optional(),
  fixResults: z.array(DoctorFixResultSchema).optional(),
  selfTest: z.array(DoctorCheckSchema).optional(),
});
export type DoctorResult = z.infer<typeof DoctorResultSchema>;

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
  // Fixed: Added ACCEPT_WITH_CAUTION to align with usage
  verdict: z.enum(["ACCEPT", "REJECT", "REFINE", "ACCEPT_WITH_CAUTION"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.array(z.string()), 
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

// Decision log entry for tracking why curation decisions were made
export const DecisionLogEntrySchema = z.object({
  timestamp: z.string(),
  phase: z.enum(["add", "feedback", "promotion", "demotion", "inversion", "conflict", "dedup"]),
  action: z.enum(["accepted", "rejected", "skipped", "modified"]),
  bulletId: z.string().optional(),
  content: z.string().optional(),
  reason: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;

export const CurationResultSchema = z.object({
  playbook: PlaybookSchema,
  applied: z.number(),
  skipped: z.number(),
  conflicts: z.array(ConflictReportSchema),
  promotions: z.array(PromotionReportSchema),
  inversions: z.array(InversionReportSchema),
  pruned: z.number(),
  decisionLog: z.array(DecisionLogEntrySchema).optional(),
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

export const CommandResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional()
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Standard error codes for programmatic error handling.
 * Use ErrorCode.X for autocomplete-friendly access.
 * Use CMErrorCodeEnum for Zod schema validation.
 */
export const ErrorCode = {
  // Input validation errors (4xx-like)
  INVALID_INPUT: "INVALID_INPUT",
  MISSING_REQUIRED: "MISSING_REQUIRED",
  MISSING_API_KEY: "MISSING_API_KEY",
  BULLET_NOT_FOUND: "BULLET_NOT_FOUND",
  TRAUMA_NOT_FOUND: "TRAUMA_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  PLAYBOOK_NOT_FOUND: "PLAYBOOK_NOT_FOUND",
  PLAYBOOK_CORRUPT: "PLAYBOOK_CORRUPT",
  CONFIG_INVALID: "CONFIG_INVALID",

  // External service errors (5xx-like)
  NETWORK_ERROR: "NETWORK_ERROR",
  CASS_NOT_FOUND: "CASS_NOT_FOUND",
  CASS_INDEX_STALE: "CASS_INDEX_STALE",
  CASS_SEARCH_FAILED: "CASS_SEARCH_FAILED",
  SEMANTIC_SEARCH_UNAVAILABLE: "SEMANTIC_SEARCH_UNAVAILABLE",
  LLM_API_ERROR: "LLM_API_ERROR",
  LLM_RATE_LIMITED: "LLM_RATE_LIMITED",
  LLM_BUDGET_EXCEEDED: "LLM_BUDGET_EXCEEDED",

  // File system errors
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_PERMISSION_DENIED: "FILE_PERMISSION_DENIED",
  FILE_WRITE_FAILED: "FILE_WRITE_FAILED",
  LOCK_ACQUISITION_FAILED: "LOCK_ACQUISITION_FAILED",
  ALREADY_EXISTS: "ALREADY_EXISTS",

  // Operational errors
  SANITIZATION_FAILED: "SANITIZATION_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  REFLECTION_FAILED: "REFLECTION_FAILED",
  AUDIT_FAILED: "AUDIT_FAILED",

  // Generic fallbacks
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;
export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// Zod enum for schema validation (mirrors ErrorCode)
export const CMErrorCodeEnum = z.enum([
  "INVALID_INPUT",
  "MISSING_REQUIRED",
  "MISSING_API_KEY",
  "BULLET_NOT_FOUND",
  "TRAUMA_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "PLAYBOOK_NOT_FOUND",
  "PLAYBOOK_CORRUPT",
  "CONFIG_INVALID",
  "NETWORK_ERROR",
  "CASS_NOT_FOUND",
  "CASS_INDEX_STALE",
  "CASS_SEARCH_FAILED",
  "SEMANTIC_SEARCH_UNAVAILABLE",
  "LLM_API_ERROR",
  "LLM_RATE_LIMITED",
  "LLM_BUDGET_EXCEEDED",
  "FILE_NOT_FOUND",
  "FILE_PERMISSION_DENIED",
  "FILE_WRITE_FAILED",
  "LOCK_ACQUISITION_FAILED",
  "ALREADY_EXISTS",
  "SANITIZATION_FAILED",
  "VALIDATION_FAILED",
  "REFLECTION_FAILED",
  "AUDIT_FAILED",
  "INTERNAL_ERROR",
  "UNKNOWN_ERROR"
]);
export type CMErrorCode = z.infer<typeof CMErrorCodeEnum>;

export const CMErrorSchema = z.object({
  code: CMErrorCodeEnum,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  recoverable: z.boolean().default(true)
});
export type CMError = z.infer<typeof CMErrorSchema>;

export const AuditViolationSchema = z.object({
  bulletId: z.string(),
  bulletContent: z.string(),
  sessionPath: z.string(),
  evidence: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  timestamp: z.string().optional()
});
export type AuditViolation = z.infer<typeof AuditViolationSchema>;

export const AuditResultSchema = z.object({
  violations: z.array(AuditViolationSchema),
  stats: z.object({
    sessionsScanned: z.number(),
    rulesChecked: z.number(),
    violationsFound: z.number(),
    bySeverity: z.object({
      high: z.number(),
      medium: z.number(),
      low: z.number()
    })
  }),
  scannedAt: z.string()
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

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
// KNOWLEDGE SYSTEM TYPES (Phase 1 — Memory System Fork)
// ============================================================================

export const ConfidenceTierEnum = z.enum(["verified", "inferred", "uncertain"]);
export type ConfidenceTier = z.infer<typeof ConfidenceTierEnum>;

export const TopicSourceEnum = z.enum(["user", "system"]);
export type TopicSource = z.infer<typeof TopicSourceEnum>;

// --- Topic ---

export const SubPageSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
});
export type SubPage = z.infer<typeof SubPageSchema>;

export const TopicSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: TopicSourceEnum,
  created: z.string(), // ISO 8601
  subpages: z.array(SubPageSchema).default([]),
});
export type Topic = z.infer<typeof TopicSchema>;

export const TopicsFileSchema = z.object({
  topics: z.array(TopicSchema),
});
export type TopicsFile = z.infer<typeof TopicsFileSchema>;

// --- Session Note (frontmatter, content is markdown) ---

export const SessionNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""), // short display name, editable by user
  source_session: z.string(),
  last_offset: z.number().default(0),
  created: z.string(), // ISO 8601
  last_updated: z.string(), // ISO 8601
  abstract: z.string(),
  topics_touched: z.array(z.string()).default([]),
  processed: z.boolean().default(false),
  user_edited: z.boolean().default(false),
});
export type SessionNote = z.infer<typeof SessionNoteSchema>;

// --- Knowledge Page (frontmatter, sections are markdown with metadata comments) ---

export const KnowledgePageSchema = z.object({
  topic: z.string().min(1),
  description: z.string(),
  source: TopicSourceEnum,
  created: z.string(), // ISO 8601
  last_updated: z.string(), // ISO 8601
});
export type KnowledgePage = z.infer<typeof KnowledgePageSchema>;

// --- Daily Digest (frontmatter, content is markdown) ---

export const DailyDigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.number().int().nonnegative(),
  topics_touched: z.array(z.string()).default([]),
});
export type DailyDigest = z.infer<typeof DailyDigestSchema>;

// --- User Note (frontmatter, content is user-authored markdown) ---

export const UserNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  created: z.string(), // ISO 8601
  topics: z.array(z.string()).default([]),
  ingest: z.boolean().default(false),
  starred: z.boolean().default(false),
});
export type UserNote = z.infer<typeof UserNoteSchema>;

// --- Topic Suggestion ---

export const TopicSuggestionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: z.literal("system"),
  created: z.string(), // ISO 8601
  suggested_from_session: z.string(),
});
export type TopicSuggestion = z.infer<typeof TopicSuggestionSchema>;

// --- Knowledge Page Delta (Curator operations) ---

export const KnowledgePageUpdateDeltaSchema = z.object({
  type: z.literal("knowledge_page_update"),
  topic_slug: z.string().min(1),
  sub_page: z.string().default("_index"),
  revised_content: z.string(), // full revised markdown body for this sub-page
  source_session: z.string(),
  updated_date: z.string(), // ISO 8601
  contradictions: z.array(z.object({
    description: z.string(),
    existing_claim: z.string(),
    new_claim: z.string(),
  })).default([]), // flagged contradictions the LLM was unsure about
});
export type KnowledgePageUpdateDelta = z.infer<typeof KnowledgePageUpdateDeltaSchema>;

// Keep the old type name as an alias for backward compatibility in tests
export const KnowledgePageAppendDeltaSchema = KnowledgePageUpdateDeltaSchema;
export type KnowledgePageAppendDelta = KnowledgePageUpdateDelta;

export const DigestUpdateDeltaSchema = z.object({
  type: z.literal("digest_update"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string(),
  sessions_covered: z.array(z.string()),
});
export type DigestUpdateDelta = z.infer<typeof DigestUpdateDeltaSchema>;

export const TopicSuggestionDeltaSchema = z.object({
  type: z.literal("topic_suggestion"),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  suggested_from_session: z.string(),
});
export type TopicSuggestionDelta = z.infer<typeof TopicSuggestionDeltaSchema>;

export const KnowledgeDeltaSchema = z.discriminatedUnion("type", [
  KnowledgePageUpdateDeltaSchema,
  DigestUpdateDeltaSchema,
  TopicSuggestionDeltaSchema,
]);
export type KnowledgeDelta = z.infer<typeof KnowledgeDeltaSchema>;

// --- Reflector Output Schemas (Phase 3 — Two-Call Split) ---

// Call 1 output: structural/extractive — bullets + topic suggestions
export const ReflectorCall1OutputSchema = z.object({
  bullets: z.array(z.object({
    content: z.string().min(1),
    scope: BulletScopeEnum,
    category: z.string(),
    type: BulletTypeEnum,
    kind: BulletKindEnum,
    reasoning: z.string(), // why this bullet is worth extracting
  })).default([]),
  feedback: z.array(z.object({
    bulletId: z.string().min(1), // ID of existing bullet (e.g. "b-abc123")
    type: z.enum(["helpful", "harmful"]),
    reasoning: z.string(), // why this session reinforces or contradicts the bullet
  })).default([]),
  topic_suggestions: z.array(z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    reasoning: z.string(), // why this topic should exist
  })).default([]),
});
export type ReflectorCall1Output = z.infer<typeof ReflectorCall1OutputSchema>;

// Call 2 output: generative/narrative — knowledge page revisions + digest
export const ReflectorCall2OutputSchema = z.object({
  page_updates: z.array(z.object({
    topic_slug: z.string().min(1),
    sub_page: z.string().default("_index"),
    revised_content: z.string().min(1), // full revised markdown for this sub-page
    contradictions: z.array(z.object({
      description: z.string(),
      existing_claim: z.string(),
      new_claim: z.string(),
    })).default([]), // cases where the LLM couldn't determine which claim is correct
  })).default([]),
  digest_content: z.string().default(""), // deprecated: digest now generated separately via Haiku
});
export type ReflectorCall2Output = z.infer<typeof ReflectorCall2OutputSchema>;

// Daily digest synthesis output (Haiku call)
export const DigestSynthesisOutputSchema = z.object({
  summary: z.string(), // synthesized daily narrative
  topics_touched: z.array(z.string()).default([]), // aggregated topic slugs
});
export type DigestSynthesisOutput = z.infer<typeof DigestSynthesisOutputSchema>;

// Diary-from-note LLM output (structured scaffold for Reflector)
export const DiaryFromNoteOutputSchema = z.object({
  status: SessionStatusEnum,
  accomplishments: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  challenges: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  keyLearnings: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type DiaryFromNoteOutput = z.infer<typeof DiaryFromNoteOutputSchema>;

// Quality telemetry for Reflector drift detection
export const ReflectorQualityTelemetrySchema = z.object({
  sessionId: z.string(),
  timestamp: z.string(), // ISO 8601
  call1BulletsProposed: z.number().int().nonnegative(),
  call1TopicSuggestionsProposed: z.number().int().nonnegative(),
  call2SectionsProposed: z.number().int().nonnegative(),
  curatorAccepted: z.number().int().nonnegative(),
  curatorRejected: z.number().int().nonnegative(),
  driftFlags: z.array(z.object({
    newSectionId: z.string(),
    existingSectionId: z.string(),
    similarity: z.number(),
    topic: z.string(),
  })).default([]),
});
export type ReflectorQualityTelemetry = z.infer<typeof ReflectorQualityTelemetrySchema>;

// --- Knowledge Page Section (parsed from HTML comments in .md files) ---

export const KnowledgePageSectionSchema = z.object({
  id: z.string().min(1), // sec-{hash}
  title: z.string(),
  content: z.string(),
  confidence: ConfidenceTierEnum,
  source: z.string(), // session ID
  added: z.string(), // ISO date
  related_bullets: z.array(z.string()).default([]),
});
export type KnowledgePageSection = z.infer<typeof KnowledgePageSectionSchema>;

// Full parsed knowledge page (frontmatter + sections)
export const ParsedKnowledgePageSchema = z.object({
  frontmatter: KnowledgePageSchema,
  sections: z.array(KnowledgePageSectionSchema),
  raw: z.string(), // original file content for roundtrip
});
export type ParsedKnowledgePage = z.infer<typeof ParsedKnowledgePageSchema>;

// --- Processing State (state.json) ---

export const SessionProcessingStateSchema = z.object({
  last_offset: z.number().default(0),
  last_processed: z.string(), // ISO 8601
});
export type SessionProcessingState = z.infer<typeof SessionProcessingStateSchema>;

export const ProcessingStateSchema = z.object({
  sessions: z.record(z.string(), SessionProcessingStateSchema).default({}),
  lastReflectionRun: z.string().optional(),
  lastIndexUpdate: z.string().optional(),
  lastPeriodicJobRun: z.string().optional(),
  installedAt: z.string().optional(), // ISO 8601 — when the system was first run
});
export type ProcessingState = z.infer<typeof ProcessingStateSchema>;

// ============================================================================
// SCHEMA REGISTRY
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
  SearchPlan: SearchPlanSchema,
  PlaybookStats: PlaybookStatsSchema,
  ReflectionStats: ReflectionStatsSchema,
  CommandResult: CommandResultSchema,
  AuditResult: AuditResultSchema,
  // Knowledge system (Phase 1)
  SubPage: SubPageSchema,
  Topic: TopicSchema,
  TopicsFile: TopicsFileSchema,
  SessionNote: SessionNoteSchema,
  KnowledgePage: KnowledgePageSchema,
  DailyDigest: DailyDigestSchema,
  UserNote: UserNoteSchema,
  TopicSuggestion: TopicSuggestionSchema,
  KnowledgeDelta: KnowledgeDeltaSchema,
  ProcessingState: ProcessingStateSchema,
  // Reflector pipeline (Phase 3)
  ReflectorCall1Output: ReflectorCall1OutputSchema,
  ReflectorCall2Output: ReflectorCall2OutputSchema,
  DiaryFromNoteOutput: DiaryFromNoteOutputSchema,
  ReflectorQualityTelemetry: ReflectorQualityTelemetrySchema,
  KnowledgePageSection: KnowledgePageSectionSchema,
  ParsedKnowledgePage: ParsedKnowledgePageSchema,
  // Context retrieval + topic system (Phase 4)
  KnowledgeSearchHit: KnowledgeSearchHitSchema,
  TopicExcerpt: TopicExcerptSchema,
  RecentSession: RecentSessionSchema,
  RelatedTopic: RelatedTopicSchema,
  ReviewQueueItem: ReviewQueueItemSchema,
  ReviewQueue: ReviewQueueSchema,
} as const;
