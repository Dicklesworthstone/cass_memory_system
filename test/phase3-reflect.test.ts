import { describe, it, expect } from "bun:test";
import {
  reflectOnSessionTwoCalls,
  formatTopicsForPrompt,
  type TwoCallReflectionResult,
} from "../src/reflect.js";
import type { DiaryEntry, Playbook, Topic, Config, PlaybookDelta, KnowledgeDelta } from "../src/types.js";
import type { LLMIO } from "../src/llm.js";

// --- Factories ---

function makeDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: "diary-test",
    sessionPath: "session-notes/test-001.md",
    timestamp: "2026-03-23T10:00:00Z",
    agent: "claude",
    status: "success",
    accomplishments: ["Implemented billing webhook handler"],
    decisions: ["Used HMAC-SHA256 for signature validation"],
    challenges: ["Initial retry logic was incorrect"],
    preferences: [],
    keyLearnings: ["Staging and production use different config paths for billing webhooks"],
    tags: ["billing", "webhooks"],
    searchAnchors: [],
    relatedSessions: [],
    ...overrides,
  };
}

function makePlaybook(bullets: Playbook["bullets"] = []): Playbook {
  return {
    schema_version: "1.0",
    name: "Test Playbook",
    description: "Test",
    metadata: { lastReflection: "" },
    bullets,
    deprecatedPatterns: [],
  };
}

function makeTopics(): Topic[] {
  return [
    { slug: "billing-service", name: "Billing Service", description: "Payment processing and webhooks", source: "user", created: "2026-03-18" },
    { slug: "deployment", name: "Deployment", description: "CI/CD and deployment processes", source: "user", created: "2026-03-18" },
  ];
}

/**
 * Create a mock LLMIO that returns predetermined responses based on prompt content.
 * Call 1 (reflectorCall1): returns bullets + topic suggestions
 * Call 2 (reflectorCall2): returns knowledge sections + digest
 */
function makeMockIO(options?: {
  call1Bullets?: number;
  call1Topics?: number;
  call2Sections?: number;
  call2Digest?: string;
}): LLMIO {
  const opts = {
    call1Bullets: options?.call1Bullets ?? 2,
    call1Topics: options?.call1Topics ?? 0,
    call2Sections: options?.call2Sections ?? 1,
    call2Digest: options?.call2Digest ?? "Implemented billing webhook handler with HMAC validation.",
  };

  let callCount = 0;

  return {
    generateObject: async ({ prompt }: any) => {
      callCount++;

      // Use call counter: Call 1 is first invocation, Call 2 is second
      if (callCount === 1) {
        // Call 1: structural/extractive
        return {
          object: {
            bullets: Array.from({ length: opts.call1Bullets }, (_, i) => ({
              content: `Test bullet ${i + 1}: Always validate HMAC signatures`,
              scope: "global",
              category: "security",
              type: "rule",
              kind: "stack_pattern",
              reasoning: "Security best practice discovered during session",
            })),
            topic_suggestions: Array.from({ length: opts.call1Topics }, (_, i) => ({
              slug: `suggested-topic-${i + 1}`,
              name: `Suggested Topic ${i + 1}`,
              description: "A suggested topic",
              reasoning: "Knowledge doesn't fit existing topics",
            })),
          },
        };
      }

      // Call 2: generative/narrative
      return {
        object: {
          page_updates: Array.from({ length: opts.call2Sections }, (_, i) => ({
            topic_slug: "billing-service",
            sub_page: "_index",
            revised_content: `# Webhook Configuration ${i + 1}\n\nThe billing service exposes webhooks at /api/v2/hooks/billing.`,
            contradictions: [],
          })),
          digest_content: opts.call2Digest,
        },
      };
    },
  };
}

// --- Tests ---

describe("formatTopicsForPrompt", () => {
  it("formats topics as bullet list", () => {
    const result = formatTopicsForPrompt(makeTopics());
    expect(result).toContain("billing-service: Billing Service");
    expect(result).toContain("deployment: Deployment");
  });

  it("returns placeholder for empty topics", () => {
    expect(formatTopicsForPrompt([])).toContain("No topics defined");
  });
});

describe("reflectOnSessionTwoCalls", () => {
  const config = {
    provider: "anthropic",
    model: "test",
    maxReflectorIterations: 1,
  } as Config;

  it("produces playbook deltas from Call 1", async () => {
    const io = makeMockIO({ call1Bullets: 3, call2Sections: 0 });
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Session note body here.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    expect(result.playbookDeltas).toHaveLength(3);
    for (const delta of result.playbookDeltas) {
      expect(delta.type).toBe("add");
      if (delta.type === "add") {
        expect(delta.sourceSession).toBe("session-notes/test-001.md");
      }
    }
  });

  it("produces knowledge deltas from Call 2", async () => {
    const io = makeMockIO({ call2Sections: 2 });
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Session note body here.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    const pageUpdates = result.knowledgeDeltas.filter(d => d.type === "knowledge_page_update");
    expect(pageUpdates.length).toBe(2);
    for (const delta of pageUpdates) {
      if (delta.type === "knowledge_page_update") {
        expect(delta.topic_slug).toBe("billing-service");
        expect(delta.source_session).toBe("test-001");
        expect(delta.revised_content).toBeTruthy();
      }
    }
  });

  it("does not produce digest deltas from Call 2 (digests are now generated separately)", async () => {
    const io = makeMockIO();
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Session note body here.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    const digestDeltas = result.knowledgeDeltas.filter(d => d.type === "digest_update");
    expect(digestDeltas).toHaveLength(0);
  });

  it("produces topic suggestion deltas from Call 1", async () => {
    const io = makeMockIO({ call1Topics: 2 });
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Session note body.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    const topicDeltas = result.knowledgeDeltas.filter(d => d.type === "topic_suggestion");
    expect(topicDeltas).toHaveLength(2);
  });

  it("deduplicates playbook deltas", async () => {
    // Two identical bullets should be deduped to one
    let callCount = 0;
    const io: LLMIO = {
      generateObject: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            object: {
              bullets: [
                { content: "Identical rule", scope: "global", category: "test", type: "pattern", kind: "learned", reasoning: "test" },
                { content: "Identical rule", scope: "global", category: "test", type: "pattern", kind: "learned", reasoning: "test" },
              ],
              topic_suggestions: [],
            },
          };
        }
        return {
          object: {
            knowledge_sections: [],
            digest_content: "",
          },
        };
      },
    };

    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Note body.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    expect(result.playbookDeltas).toHaveLength(1);
  });

  it("handles Call 1 failure gracefully (Call 2 still runs)", async () => {
    let callCount = 0;
    const io: LLMIO = {
      generateObject: async () => {
        callCount++;
        // generateObjectSafe retries up to 3 times, and llmWithRetry wraps that.
        // For non-retryable errors, it throws immediately. We need the error to
        // propagate through to reflectOnSessionTwoCalls's catch block.
        // Since "Call 1 failed" is not in the retryable errors list, it will throw after
        // generateObjectSafe exhausts its 3 attempts.
        if (callCount <= 3) throw new Error("Call 1 failed");
        return {
          object: {
            page_updates: [
              { topic_slug: "billing-service", sub_page: "_index", revised_content: "# Billing\nUpdated content.", contradictions: [] },
            ],
            digest_content: "",
          },
        };
      },
    };

    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Note body.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    expect(result.playbookDeltas).toHaveLength(0); // Call 1 failed
    expect(result.knowledgeDeltas.length).toBeGreaterThan(0); // Call 2 succeeded
    expect(result.decisionLog.some(d => d.reason.includes("Call 1 failed"))).toBe(true);
  });

  it("adds cold-start general topic when no topics exist", async () => {
    const io = makeMockIO({ call1Topics: 0, call2Sections: 1 });
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Note body.", makePlaybook(), [], // No existing topics
      "", "test-001", config, io
    );

    // Should still produce output — general topic used as fallback
    expect(result.knowledgeDeltas.length).toBeGreaterThan(0);
  });

  it("exposes call1Output for cross-referencing", async () => {
    const io = makeMockIO({ call1Bullets: 2, call1Topics: 1 });
    const result = await reflectOnSessionTwoCalls(
      makeDiary(), "Note body.", makePlaybook(), makeTopics(),
      "", "test-001", config, io
    );

    expect(result.call1Output).not.toBeNull();
    expect(result.call1Output!.bullets).toHaveLength(2);
    expect(result.call1Output!.topic_suggestions).toHaveLength(1);
  });
});
