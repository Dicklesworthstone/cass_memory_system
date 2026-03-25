import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseKnowledgePage,
  serializeKnowledgePage,
  loadKnowledgePage,
  writeKnowledgePage,
  appendSectionToPage,
  loadTopics,
  saveTopics,
  addTopicSuggestion,
  appendToDigest,
  writeDigest,
} from "../src/knowledge-page.js";
import type { Config, KnowledgePageAppendDelta, ParsedKnowledgePage, Topic } from "../src/types.js";

function makeConfig(tmpDir: string): Config {
  return {
    knowledgeDir: path.join(tmpDir, "knowledge"),
    digestsDir: path.join(tmpDir, "digests"),
    topicsJsonPath: path.join(tmpDir, "topics.json"),
    // Minimal config fields needed
    provider: "anthropic",
    model: "test",
    playbookPath: path.join(tmpDir, "playbook.yaml"),
    diaryDir: path.join(tmpDir, "diary"),
    sessionNotesDir: path.join(tmpDir, "session-notes"),
    searchDbPath: path.join(tmpDir, "search.db"),
    stateJsonPath: path.join(tmpDir, "state.json"),
    notesDir: path.join(tmpDir, "notes"),
  } as Config;
}

const SAMPLE_PAGE = `---
topic: Billing Service
description: "Billing platform, payment processing, webhooks"
source: user
created: 2026-03-18
last_updated: 2026-03-20
---

## Webhook Configuration
<!-- id: sec-a1b2c3d4 | confidence: verified | source: session-2026-03-20-001 | added: 2026-03-20 | related_bullets: b-20260320-x7k -->

The billing service exposes webhooks at \`/api/v2/hooks/billing\`.
Consumers must validate requests using HMAC-SHA256 signatures.

## Retry Logic
<!-- id: sec-e5f6g7h8 | confidence: inferred | source: session-2026-03-19-003 | added: 2026-03-19 -->

Webhook delivery uses exponential backoff with a 5-minute cap.
`;

describe("parseKnowledgePage", () => {
  it("parses frontmatter correctly", () => {
    const page = parseKnowledgePage(SAMPLE_PAGE);
    expect(page.frontmatter.topic).toBe("Billing Service");
    expect(page.frontmatter.description).toBe("Billing platform, payment processing, webhooks");
    expect(page.frontmatter.source).toBe("user");
    expect(page.frontmatter.created).toBe("2026-03-18");
    expect(page.frontmatter.last_updated).toBe("2026-03-20");
  });

  it("parses sections with metadata comments", () => {
    const page = parseKnowledgePage(SAMPLE_PAGE);
    expect(page.sections).toHaveLength(2);

    const s1 = page.sections[0];
    expect(s1.title).toBe("Webhook Configuration");
    expect(s1.id).toBe("sec-a1b2c3d4");
    expect(s1.confidence).toBe("verified");
    expect(s1.source).toBe("session-2026-03-20-001");
    expect(s1.added).toBe("2026-03-20");
    expect(s1.related_bullets).toEqual(["b-20260320-x7k"]);
    expect(s1.content).toContain("HMAC-SHA256");

    const s2 = page.sections[1];
    expect(s2.title).toBe("Retry Logic");
    expect(s2.id).toBe("sec-e5f6g7h8");
    expect(s2.confidence).toBe("inferred");
    expect(s2.related_bullets).toEqual([]);
    expect(s2.content).toContain("exponential backoff");
  });

  it("handles sections without metadata comments", () => {
    const raw = `---
topic: Test
description: "test"
source: system
created: 2026-01-01
last_updated: 2026-01-01
---

## User-Authored Section

This section was written by a human with no metadata comment.
`;
    const page = parseKnowledgePage(raw);
    expect(page.sections).toHaveLength(1);
    expect(page.sections[0].title).toBe("User-Authored Section");
    expect(page.sections[0].id).toBe("");
    expect(page.sections[0].confidence).toBe("uncertain");
    expect(page.sections[0].content).toContain("written by a human");
  });

  it("handles blank line between heading and metadata comment (3-line lookahead)", () => {
    const raw = `---
topic: Test
description: "test"
source: system
created: 2026-01-01
last_updated: 2026-01-01
---

## Section With Gap

<!-- id: sec-gap1 | confidence: verified | source: s1 | added: 2026-01-01 -->

Content here.
`;
    const page = parseKnowledgePage(raw);
    expect(page.sections).toHaveLength(1);
    expect(page.sections[0].id).toBe("sec-gap1");
    expect(page.sections[0].confidence).toBe("verified");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseKnowledgePage("## No frontmatter\nContent")).toThrow("missing YAML frontmatter");
  });
});

describe("serializeKnowledgePage", () => {
  it("roundtrips parse → serialize → parse", () => {
    const page1 = parseKnowledgePage(SAMPLE_PAGE);
    const serialized = serializeKnowledgePage(page1);
    const page2 = parseKnowledgePage(serialized);

    expect(page2.frontmatter).toEqual(page1.frontmatter);
    expect(page2.sections).toHaveLength(page1.sections.length);
    for (let i = 0; i < page1.sections.length; i++) {
      expect(page2.sections[i].id).toBe(page1.sections[i].id);
      expect(page2.sections[i].title).toBe(page1.sections[i].title);
      expect(page2.sections[i].confidence).toBe(page1.sections[i].confidence);
      expect(page2.sections[i].source).toBe(page1.sections[i].source);
      expect(page2.sections[i].related_bullets).toEqual(page1.sections[i].related_bullets);
    }
  });
});

describe("file I/O", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "kp-test-"));
    config = makeConfig(tmpDir);
    await mkdir(path.join(tmpDir, "knowledge"), { recursive: true });
    await mkdir(path.join(tmpDir, "digests"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("load returns null for non-existent page", async () => {
    const page = await loadKnowledgePage("nonexistent", config);
    expect(page).toBeNull();
  });

  it("write and load roundtrips", async () => {
    const page = parseKnowledgePage(SAMPLE_PAGE);
    await writeKnowledgePage("billing-service", page, config);
    const loaded = await loadKnowledgePage("billing-service", config);
    expect(loaded).not.toBeNull();
    expect(loaded!.frontmatter.topic).toBe("Billing Service");
    expect(loaded!.sections).toHaveLength(2);
  });

  it("appendSectionToPage creates new page", async () => {
    const delta: KnowledgePageAppendDelta = {
      type: "knowledge_page_append",
      topic_slug: "new-topic",
      section_id: "sec-new1",
      section_title: "First Section",
      content: "This is the first section content.",
      confidence: "inferred",
      source_session: "session-001",
      added_date: "2026-03-23",
      related_bullets: [],
    };

    const topic: Topic = {
      slug: "new-topic",
      name: "New Topic",
      description: "A brand new topic",
      source: "system",
      created: "2026-03-23",
    };

    const result = await appendSectionToPage(delta, topic, config);
    expect(result.written).toBe(true);

    const loaded = await loadKnowledgePage("new-topic", config);
    expect(loaded).not.toBeNull();
    expect(loaded!.frontmatter.topic).toBe("New Topic");
    expect(loaded!.sections).toHaveLength(1);
    expect(loaded!.sections[0].id).toBe("sec-new1");
  });

  it("appendSectionToPage appends to existing page", async () => {
    const page = parseKnowledgePage(SAMPLE_PAGE);
    await writeKnowledgePage("billing-service", page, config);

    const delta: KnowledgePageAppendDelta = {
      type: "knowledge_page_append",
      topic_slug: "billing-service",
      section_id: "sec-new2",
      section_title: "Error Handling",
      content: "Webhook errors are logged to CloudWatch.",
      confidence: "verified",
      source_session: "session-002",
      added_date: "2026-03-23",
      related_bullets: ["b-123"],
    };

    // Provide a topic object — appendSectionToPage now requires it
    const topic = { slug: "billing-service", name: "Billing", description: "test", source: "user" as const, created: "2026-03-23", subpages: [] };
    const result = await appendSectionToPage(delta, topic, config);
    expect(result.written).toBe(true);

    const loaded = await loadKnowledgePage("billing-service", config);
    expect(loaded!.sections).toHaveLength(3);
    expect(loaded!.sections[2].id).toBe("sec-new2");
    expect(loaded!.sections[2].related_bullets).toEqual(["b-123"]);
  });

  it("appendSectionToPage deduplicates by source session ID", async () => {
    const page = parseKnowledgePage(SAMPLE_PAGE);
    await writeKnowledgePage("billing-service", page, config);

    const delta: KnowledgePageAppendDelta = {
      type: "knowledge_page_append",
      topic_slug: "billing-service",
      section_id: "sec-dup",
      section_title: "Webhook Configuration", // Same title as existing
      content: "Duplicate from same source.",
      confidence: "inferred",
      source_session: "session-2026-03-20-001", // Same source as existing
      added_date: "2026-03-23",
      related_bullets: [],
    };

    const topic = { slug: "billing-service", name: "Billing", description: "test", source: "user" as const, created: "2026-03-23", subpages: [] };
    const result = await appendSectionToPage(delta, topic, config);
    expect(result.written).toBe(false);
    expect(result.reason).toContain("already exists");
  });
});

describe("topics.json I/O", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "topics-test-"));
    config = makeConfig(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads empty array when file doesn't exist", async () => {
    const topics = await loadTopics(config);
    expect(topics).toEqual([]);
  });

  it("save and load roundtrips", async () => {
    const topics: Topic[] = [
      { slug: "billing", name: "Billing", description: "Payment stuff", source: "user", created: "2026-03-23" },
    ];
    await saveTopics(topics, config);
    const loaded = await loadTopics(config);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].slug).toBe("billing");
  });

  it("addTopicSuggestion queues to review queue instead of creating topic", async () => {
    const result = await addTopicSuggestion("new-slug", "New Topic", "desc", "session-1", config);
    expect(result.added).toBe(true);
    expect(result.reason).toContain("review");

    // Topic should NOT be in topics.json
    const topics = await loadTopics(config);
    expect(topics).toHaveLength(0);
  });

  it("addTopicSuggestion skips when topic already exists in topics.json", async () => {
    // Add topic directly first
    await saveTopics([{ slug: "existing", name: "Existing", description: "desc", source: "user", created: "2026-03-23", subpages: [] }], config);
    const result = await addTopicSuggestion("existing", "Existing V2", "desc", "session-2", config);
    expect(result.added).toBe(false);
    expect(result.reason).toContain("already exists");
  });
});

describe("digest I/O", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "digest-test-"));
    config = makeConfig(tmpDir);
    await mkdir(path.join(tmpDir, "digests"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates new digest file", async () => {
    await appendToDigest("2026-03-23", "Built Phase 3 reflection pipeline.", ["session-1"], config);
    const content = await readFile(path.join(tmpDir, "digests", "2026-03-23.md"), "utf-8");
    expect(content).toContain("date: 2026-03-23");
    expect(content).toContain("sessions: 1");
    expect(content).toContain("Built Phase 3");
  });

  it("writeDigest replaces content with synthesized digest", async () => {
    await writeDigest("2026-03-23", "First version.", 1, ["topic-a"], config);
    await writeDigest("2026-03-23", "Synthesized summary of 3 sessions.", 3, ["topic-a", "topic-b"], config);

    const content = await readFile(path.join(tmpDir, "digests", "2026-03-23.md"), "utf-8");
    expect(content).toContain("sessions: 3");
    expect(content).toContain("Synthesized summary");
    expect(content).toContain('"topic-a"');
    expect(content).toContain('"topic-b"');
    // First version should be replaced, not appended
    expect(content).not.toContain("First version.");
  });
});
