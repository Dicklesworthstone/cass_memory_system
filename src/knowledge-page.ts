// src/knowledge-page.ts
// Knowledge page file I/O: parse/serialize markdown files with HTML comment metadata.
// Knowledge pages are the source of truth; SQLite is the derived search index.

import path from "node:path";
import fs from "node:fs/promises";
import {
  Config,
  KnowledgePage,
  KnowledgePageSection,
  ParsedKnowledgePage,
  KnowledgePageAppendDelta,
  KnowledgePageUpdateDelta,
  TopicsFile,
  TopicsFileSchema,
  Topic,
  TopicSource,
  ConfidenceTier,
  ReviewQueueItem,
} from "./types.js";
import { expandPath, ensureDir, atomicWrite, log, warn } from "./utils.js";
import { withLock } from "./lock.js";
import { appendReviewItems } from "./review-queue.js";

// ============================================================================
// PARSING
// ============================================================================

/** Regex for section heading (## Title) */
const HEADING_RE = /^#{2}\s+(.+)$/;

/** Regex for metadata HTML comment */
const META_COMMENT_RE = /^<!--\s*(.+?)\s*-->$/;

/** Parse a pipe-delimited HTML comment into key-value pairs. */
function parseMetaComment(line: string): Record<string, string> | null {
  const match = line.match(META_COMMENT_RE);
  if (!match) return null;

  const pairs: Record<string, string> = {};
  for (const segment of match[1].split(" | ")) {
    const colonIdx = segment.indexOf(":");
    if (colonIdx === -1) continue;
    const key = segment.slice(0, colonIdx).trim();
    const value = segment.slice(colonIdx + 1).trim();
    if (key && value) pairs[key] = value;
  }
  return pairs;
}

/**
 * Parse a knowledge page markdown file into frontmatter + sections.
 * Handles the HTML comment metadata format with 3-line lookahead.
 */
export function parseKnowledgePage(raw: string): ParsedKnowledgePage {
  // Split frontmatter from body
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("Knowledge page missing YAML frontmatter");
  }

  const fmRaw = fmMatch[1];
  const body = fmMatch[2];

  // Parse YAML frontmatter (simple key-value, matching session-notes.ts pattern)
  const frontmatter: Record<string, any> = {};
  for (const line of fmRaw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  const fm: KnowledgePage = {
    topic: frontmatter.topic || "",
    description: frontmatter.description || "",
    source: (frontmatter.source as "user" | "system") || "system",
    created: frontmatter.created || new Date().toISOString().split("T")[0],
    last_updated: frontmatter.last_updated || new Date().toISOString().split("T")[0],
  };

  // Parse sections from body
  const sections: KnowledgePageSection[] = [];
  const lines = body.split("\n");
  let i = 0;

  while (i < lines.length) {
    const headingMatch = lines[i].match(HEADING_RE);
    if (!headingMatch) {
      i++;
      continue;
    }

    const title = headingMatch[1].trim();
    i++;

    // Scan forward up to 3 lines for metadata comment (handles blank lines)
    let meta: Record<string, string> | null = null;
    let metaLineIdx = -1;
    for (let lookahead = 0; lookahead < 3 && i + lookahead < lines.length; lookahead++) {
      const candidate = lines[i + lookahead].trim();
      if (candidate === "") continue; // skip blank lines
      meta = parseMetaComment(candidate);
      if (meta) {
        metaLineIdx = i + lookahead;
        break;
      }
      break; // Non-blank, non-comment line — stop looking
    }

    if (metaLineIdx >= 0) {
      i = metaLineIdx + 1;
    }

    // Collect content lines until next heading or EOF
    const contentLines: string[] = [];
    while (i < lines.length) {
      if (HEADING_RE.test(lines[i])) break;
      contentLines.push(lines[i]);
      i++;
    }

    // Trim leading/trailing blank lines from content
    const content = contentLines.join("\n").trim();

    sections.push({
      id: meta?.id || "",
      title,
      content,
      confidence: (meta?.confidence as ConfidenceTier) || "uncertain",
      source: meta?.source || "",
      added: meta?.added || "",
      related_bullets: meta?.related_bullets
        ? meta.related_bullets.split(",").map(s => s.trim()).filter(Boolean)
        : [],
    });
  }

  return { frontmatter: fm, sections, raw };
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/** Serialize a section metadata comment. */
function serializeMetaComment(section: KnowledgePageSection): string {
  const parts = [
    `id: ${section.id}`,
    `confidence: ${section.confidence}`,
    `source: ${section.source}`,
    `added: ${section.added}`,
  ];
  if (section.related_bullets.length > 0) {
    parts.push(`related_bullets: ${section.related_bullets.join(",")}`);
  }
  return `<!-- ${parts.join(" | ")} -->`;
}

/** Serialize YAML frontmatter for a knowledge page. */
function serializeFrontmatter(fm: KnowledgePage): string {
  return [
    "---",
    `topic: ${fm.topic}`,
    `description: "${fm.description}"`,
    `source: ${fm.source}`,
    `created: ${fm.created}`,
    `last_updated: ${fm.last_updated}`,
    "---",
  ].join("\n");
}

/** Serialize a full knowledge page to markdown. */
export function serializeKnowledgePage(page: ParsedKnowledgePage): string {
  const parts: string[] = [serializeFrontmatter(page.frontmatter)];

  for (const section of page.sections) {
    parts.push(""); // blank line before heading
    parts.push(`## ${section.title}`);
    parts.push(serializeMetaComment(section));
    parts.push("");
    parts.push(section.content);
  }

  parts.push(""); // trailing newline
  return parts.join("\n");
}

// ============================================================================
// FILE I/O — Directory Model
// Each topic is a directory: knowledge/{topic-slug}/
//   _index.md — topic overview
//   {sub-page}.md — user-defined sub-pages
// ============================================================================

/** Resolve the directory path for a topic. */
export function topicDirPath(topicSlug: string, config: Config): string {
  return path.join(expandPath(config.knowledgeDir), topicSlug);
}

/** Resolve the file path for a sub-page within a topic directory. */
export function subPagePath(topicSlug: string, subPage: string, config: Config): string {
  const slug = subPage.endsWith(".md") ? subPage : `${subPage}.md`;
  return path.join(topicDirPath(topicSlug, config), slug);
}

/** Backward compat: resolve path for old single-file format. */
export function knowledgePagePath(topicSlug: string, config: Config): string {
  return path.join(expandPath(config.knowledgeDir), `${topicSlug}.md`);
}

/**
 * Load and parse a knowledge page (sub-page or legacy single file).
 * Tries directory model first, falls back to single-file for backward compat.
 */
export async function loadKnowledgePage(
  topicSlug: string,
  config: Config,
  subPage?: string
): Promise<ParsedKnowledgePage | null> {
  const sub = subPage || "_index";
  // Try directory model first
  const dirPath = subPagePath(topicSlug, sub, config);
  try {
    const raw = await fs.readFile(dirPath, "utf-8");
    return parseKnowledgePage(raw);
  } catch {
    // Fall back to legacy single-file model
    if (!subPage || subPage === "_index") {
      const legacyPath = knowledgePagePath(topicSlug, config);
      try {
        const raw = await fs.readFile(legacyPath, "utf-8");
        return parseKnowledgePage(raw);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Write a knowledge page to a sub-page within a topic directory. */
export async function writeKnowledgePage(
  topicSlug: string,
  page: ParsedKnowledgePage,
  config: Config,
  subPage?: string
): Promise<string> {
  const sub = subPage || "_index";
  const filePath = subPagePath(topicSlug, sub, config);
  await ensureDir(path.dirname(filePath));
  const content = serializeKnowledgePage(page);
  await withLock(filePath, async () => {
    await atomicWrite(filePath, content);
  });
  return filePath;
}

/** List all sub-page files in a topic directory. Returns slugs (without .md). */
export async function listSubPages(topicSlug: string, config: Config): Promise<string[]> {
  const dirPath = topicDirPath(topicSlug, config);
  try {
    const files = await fs.readdir(dirPath);
    return files
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""))
      .sort((a, b) => {
        // _index always first
        if (a === "_index") return -1;
        if (b === "_index") return 1;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

/** Create a topic directory with _index.md. */
export async function createTopicDirectory(
  topic: Topic,
  config: Config
): Promise<string> {
  const dirPath = topicDirPath(topic.slug, config);
  await ensureDir(dirPath);

  const today = new Date().toISOString().split("T")[0];
  const indexPage: ParsedKnowledgePage = {
    frontmatter: {
      topic: topic.name,
      description: topic.description,
      source: topic.source,
      created: today,
      last_updated: today,
    },
    sections: [],
    raw: "",
  };

  await writeKnowledgePage(topic.slug, indexPage, config, "_index");
  log(`Created topic directory: ${topic.slug}/`);
  return dirPath;
}

/**
 * Append a section to a knowledge page sub-page. Creates the file if it doesn't exist.
 * Uses source-session-ID dedup: if a section from the same source session already
 * exists, skip (different sources always kept — user merges via review queue).
 *
 * Only appends to EXISTING topics. Returns { written: false } if topic not in topics.json.
 */
export async function appendSectionToPage(
  delta: KnowledgePageAppendDelta,
  topic: Topic | undefined,
  config: Config
): Promise<{ written: boolean; reason: string }> {
  // Only write to existing topics — don't create orphaned pages
  if (!topic) {
    return {
      written: false,
      reason: `Topic "${delta.topic_slug}" not in topics.json — skipping (topic must be approved first)`,
    };
  }

  const subPage = delta.sub_page || "_index";
  let page = await loadKnowledgePage(delta.topic_slug, config, subPage);

  if (!page) {
    // Create new sub-page
    const today = new Date().toISOString().split("T")[0];
    page = {
      frontmatter: {
        topic: topic.name,
        description: topic.description,
        source: topic.source,
        created: today,
        last_updated: today,
      },
      sections: [],
      raw: "",
    };
    log(`Creating new sub-page: ${delta.topic_slug}/${subPage}`);
  }

  // Source-session-ID dedup: same source → skip
  const existingFromSameSource = page.sections.find(
    s => s.source === delta.source_session && s.title === delta.section_title
  );
  if (existingFromSameSource) {
    return {
      written: false,
      reason: `Section "${delta.section_title}" from ${delta.source_session} already exists on ${delta.topic_slug}/${subPage}`,
    };
  }

  // Append section
  const newSection: KnowledgePageSection = {
    id: delta.section_id,
    title: delta.section_title,
    content: delta.content,
    confidence: delta.confidence,
    source: delta.source_session,
    added: delta.added_date,
    related_bullets: delta.related_bullets,
  };

  page.sections.push(newSection);
  page.frontmatter.last_updated = new Date().toISOString().split("T")[0];

  await writeKnowledgePage(delta.topic_slug, page, config, subPage);
  log(`Appended section "${delta.section_title}" to ${delta.topic_slug}/${subPage}`);

  return { written: true, reason: "Section appended" };
}

/**
 * Update a knowledge page sub-page with revised content.
 * Replaces the body while preserving the YAML frontmatter.
 * This is the primary write path for the new cohesive-document model.
 */
export async function updatePageContent(
  delta: KnowledgePageUpdateDelta,
  topic: Topic,
  config: Config
): Promise<{ written: boolean; reason: string }> {
  const subPage = delta.sub_page || "_index";
  let page = await loadKnowledgePage(delta.topic_slug, config, subPage);

  if (!page) {
    // Create new page with the revised content
    const today = new Date().toISOString().split("T")[0];
    page = {
      frontmatter: {
        topic: topic.name,
        description: topic.description,
        source: topic.source,
        created: today,
        last_updated: today,
      },
      sections: [], // sections will be empty — body is in revised_content
      raw: "",
    };
  }

  // Update frontmatter date
  page.frontmatter.last_updated = new Date().toISOString().split("T")[0];

  // For the new model, we store content directly as the page body.
  // Serialize frontmatter + revised content (no section metadata comments).
  const frontmatterYaml = [
    "---",
    `topic: ${page.frontmatter.topic}`,
    `description: "${page.frontmatter.description}"`,
    `source: ${page.frontmatter.source}`,
    `created: ${page.frontmatter.created}`,
    `last_updated: ${page.frontmatter.last_updated}`,
    `last_source: ${delta.source_session}`,
    "---",
  ].join("\n");

  const fullContent = `${frontmatterYaml}\n\n${delta.revised_content}`;
  const filePath = subPagePath(delta.topic_slug, subPage, config);
  await ensureDir(path.dirname(filePath));
  await withLock(filePath, async () => {
    await atomicWrite(filePath, fullContent);
  });

  // Index into FTS for search
  try {
    const { openSearchIndex } = await import("./search.js");
    const idx = openSearchIndex(config.searchDbPath);
    idx.indexKnowledge({
      topic: `${delta.topic_slug}/${subPage}`,
      section_title: topic.name,
      content: delta.revised_content,
    });
    idx.close();
  } catch { /* search index may not exist yet */ }

  log(`Updated knowledge page: ${delta.topic_slug}/${subPage} (source: ${delta.source_session})`);
  return { written: true, reason: `Page revised from ${delta.source_session}` };
}

// ============================================================================
// TOPICS.JSON I/O
// ============================================================================

/** Load topics from topics.json. Returns empty array if file doesn't exist. */
export async function loadTopics(config: Config): Promise<Topic[]> {
  const filePath = expandPath(config.topicsJsonPath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = TopicsFileSchema.parse(JSON.parse(raw));
    return parsed.topics;
  } catch {
    return [];
  }
}

/** Save topics to topics.json with locking + atomic write. */
export async function saveTopics(topics: Topic[], config: Config): Promise<void> {
  const filePath = expandPath(config.topicsJsonPath);
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify({ topics } satisfies TopicsFile, null, 2);
  await withLock(filePath, async () => {
    await atomicWrite(filePath, content);
  });
}

/**
 * Queue a topic suggestion for user review instead of auto-creating it.
 * The topic is added to the review queue as a "topic_suggestion" item.
 * Knowledge pages may still be written to knowledge/{slug}.md (orphaned from topics.json)
 * — they become visible when the user approves the topic.
 * On dismiss, the orphaned knowledge page can be cleaned up.
 */
export async function addTopicSuggestion(
  slug: string,
  name: string,
  description: string,
  suggestedFromSession: string,
  config: Config
): Promise<{ added: boolean; reason: string }> {
  const topics = await loadTopics(config);

  if (topics.some(t => t.slug === slug)) {
    return { added: false, reason: `Topic "${slug}" already exists` };
  }

  // Queue for review instead of auto-creating
  const item: ReviewQueueItem = {
    id: `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: "topic_suggestion",
    status: "pending",
    created: new Date().toISOString(),
    target_topic: slug,
    data: { name, description, suggested_from_session: suggestedFromSession },
  };

  await appendReviewItems([item], config);
  log(`Queued topic suggestion for review: ${slug}`);
  return { added: true, reason: "Topic queued for review" };
}

// ============================================================================
// DIGEST I/O
// ============================================================================

/** Resolve path for a daily digest file. */
export function digestPath(date: string, config: Config): string {
  return path.join(expandPath(config.digestsDir), `${date}.md`);
}

// ============================================================================
// TOPIC CRUD (Phase 4)
// ============================================================================

/**
 * Add a topic (user or system). Returns false if slug already exists.
 */
export async function addTopic(
  slug: string,
  name: string,
  description: string,
  source: TopicSource,
  config: Config
): Promise<{ added: boolean; reason: string }> {
  const topics = await loadTopics(config);

  if (topics.some(t => t.slug === slug)) {
    return { added: false, reason: `Topic "${slug}" already exists` };
  }

  const topic: Topic = {
    slug,
    name,
    description,
    source,
    created: new Date().toISOString(),
    subpages: [],
  };

  topics.push(topic);
  await saveTopics(topics, config);

  // Create topic directory with _index.md
  await createTopicDirectory(topic, config);

  log(`Added topic: ${slug} (${source})`);
  return { added: true, reason: "Topic added" };
}

/**
 * Add a sub-page to an existing topic.
 * Creates the sub-page definition in topics.json and the .md file.
 */
export async function addSubPage(
  topicSlug: string,
  subPageSlug: string,
  name: string,
  description: string,
  config: Config
): Promise<{ added: boolean; reason: string }> {
  const topics = await loadTopics(config);
  const topic = topics.find(t => t.slug === topicSlug);

  if (!topic) {
    return { added: false, reason: `Topic "${topicSlug}" not found` };
  }

  if (topic.subpages.some(sp => sp.slug === subPageSlug)) {
    return { added: false, reason: `Sub-page "${subPageSlug}" already exists in "${topicSlug}"` };
  }

  topic.subpages.push({ slug: subPageSlug, name, description });
  await saveTopics(topics, config);

  // Create the sub-page .md file
  const today = new Date().toISOString().split("T")[0];
  const page: ParsedKnowledgePage = {
    frontmatter: {
      topic: name,
      description,
      source: topic.source,
      created: today,
      last_updated: today,
    },
    sections: [],
    raw: "",
  };
  await writeKnowledgePage(topicSlug, page, config, subPageSlug);

  log(`Added sub-page: ${topicSlug}/${subPageSlug}`);
  return { added: true, reason: "Sub-page added" };
}

/**
 * Remove a topic from topics.json. Only system topics unless force=true.
 * Does NOT delete the knowledge page file (user may want to keep it).
 */
export async function removeTopic(
  slug: string,
  config: Config,
  options?: { force?: boolean }
): Promise<{ removed: boolean; reason: string }> {
  const topics = await loadTopics(config);
  const idx = topics.findIndex(t => t.slug === slug);

  if (idx === -1) {
    return { removed: false, reason: `Topic "${slug}" not found` };
  }

  const topic = topics[idx];
  if (topic.source === "user" && !options?.force) {
    return { removed: false, reason: `Topic "${slug}" is user-created. Use force to remove.` };
  }

  topics.splice(idx, 1);
  await saveTopics(topics, config);
  log(`Removed topic: ${slug}`);
  return { removed: true, reason: "Topic removed" };
}

/**
 * List topics with metadata from knowledge page files.
 */
export async function listTopicsWithMetadata(config: Config): Promise<Array<{
  topic: Topic;
  sectionCount: number;
  lastUpdated: string | null;
  wordCount: number;
  subPageCount: number;
}>> {
  const topics = await loadTopics(config);
  const results = [];

  for (const topic of topics) {
    let totalSections = 0;
    let totalWords = 0;
    let latestUpdate: string | null = null;

    // Read all sub-pages in the topic directory
    const subPages = await listSubPages(topic.slug, config);
    for (const sp of subPages) {
      const page = await loadKnowledgePage(topic.slug, config, sp);
      if (page) {
        totalSections += page.sections.length;
        totalWords += page.sections.reduce((sum, s) => sum + s.content.split(/\s+/).length, 0);
        if (page.frontmatter.last_updated && (!latestUpdate || page.frontmatter.last_updated > latestUpdate)) {
          latestUpdate = page.frontmatter.last_updated;
        }
      }
    }

    // Fallback: check legacy single-file format
    if (subPages.length === 0) {
      const page = await loadKnowledgePage(topic.slug, config);
      if (page) {
        totalSections = page.sections.length;
        totalWords = page.sections.reduce((sum, s) => sum + s.content.split(/\s+/).length, 0);
        latestUpdate = page.frontmatter.last_updated || null;
      }
    }

    results.push({
      topic,
      sectionCount: totalSections,
      lastUpdated: latestUpdate,
      wordCount: totalWords,
      subPageCount: subPages.length,
    });
  }

  return results;
}

/**
 * Cold-start a new topic: embed its description, find similar content in existing
 * knowledge pages and session notes, write matches to review queue.
 */
export async function coldStartTopic(
  slug: string,
  description: string,
  config: Config
): Promise<{ suggestions: Array<{ type: string; snippet: string; similarity: number }> }> {
  const suggestions: Array<{ type: string; snippet: string; similarity: number; topic?: string; section?: string }> = [];

  try {
    const { embedText, cosineSimilarity } = await import("./semantic.js");
    const descEmbedding = await embedText(description);

    // Search existing knowledge page sections
    const knowledgeDir = expandPath(config.knowledgeDir);
    let knowledgeFiles: string[] = [];
    try {
      knowledgeFiles = (await fs.readdir(knowledgeDir)).filter(f => f.endsWith(".md"));
    } catch {
      // No knowledge dir yet
    }

    for (const file of knowledgeFiles) {
      const topicSlug = file.replace(/\.md$/, "");
      if (topicSlug === slug) continue; // Don't match self

      const raw = await fs.readFile(path.join(knowledgeDir, file), "utf-8");
      try {
        const page = parseKnowledgePage(raw);
        for (const section of page.sections) {
          const sectionEmbedding = await embedText(section.content.slice(0, 500));
          const sim = cosineSimilarity(descEmbedding, sectionEmbedding);
          if (sim >= 0.3) {
            suggestions.push({
              type: "knowledge_section",
              topic: topicSlug,
              section: section.title,
              snippet: section.content.slice(0, 200),
              similarity: sim,
            });
          }
        }
      } catch {
        // Skip malformed knowledge pages
      }
    }

    // Search session notes
    const notesDir = expandPath(config.sessionNotesDir);
    let noteFiles: string[] = [];
    try {
      noteFiles = (await fs.readdir(notesDir)).filter(f => f.endsWith(".md"));
    } catch {
      // No session notes dir yet
    }

    for (const file of noteFiles.slice(0, 20)) { // Cap at 20 most recent
      const raw = await fs.readFile(path.join(notesDir, file), "utf-8");
      // Extract body after frontmatter
      const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch?.[1]?.trim() || "";
      if (!body) continue;

      const noteEmbedding = await embedText(body.slice(0, 500));
      const sim = cosineSimilarity(descEmbedding, noteEmbedding);
      if (sim >= 0.3) {
        suggestions.push({
          type: "session_note",
          snippet: body.slice(0, 200),
          similarity: sim,
        });
      }
    }

    // Sort by similarity descending, take top 10
    suggestions.sort((a, b) => b.similarity - a.similarity);
    const topSuggestions = suggestions.slice(0, 10);

    // Write to review queue
    if (topSuggestions.length > 0) {
      const reviewItems: ReviewQueueItem[] = topSuggestions.map((s, i) => ({
        id: `rq-${slug}-${Date.now()}-${i}`,
        type: "cold_start_suggestion" as const,
        status: "pending" as const,
        created: new Date().toISOString(),
        target_topic: slug,
        source: {
          type: (s.type === "knowledge_section" ? "knowledge_section" : "session_note") as "knowledge_section" | "session_note",
          topic: s.topic,
          section: s.section,
          snippet: s.snippet,
          similarity: Math.round(s.similarity * 100) / 100,
        },
      }));
      await appendReviewItems(reviewItems, config);
    }

    return { suggestions: topSuggestions };
  } catch (err) {
    warn(`Cold-start failed for topic "${slug}": ${err}`);
    return { suggestions: [] };
  }
}

// ============================================================================
// DIGEST I/O
// ============================================================================

/** Append a session paragraph to a daily digest. Creates the file if needed. */
/**
 * Write a synthesized daily digest (replaces the old append-based approach).
 * Each reflection run produces one Haiku-synthesized digest that replaces the file.
 */
export async function writeDigest(
  date: string,
  content: string,
  sessionCount: number,
  topicsTouched: string[],
  config: Config
): Promise<void> {
  const filePath = digestPath(date, config);
  await ensureDir(path.dirname(filePath));

  const topicsYaml = topicsTouched.length > 0
    ? `[${topicsTouched.map(t => `"${t}"`).join(", ")}]`
    : "[]";

  const frontmatter = [
    "---",
    `date: ${date}`,
    `sessions: ${sessionCount}`,
    `topics_touched: ${topicsYaml}`,
    "---",
  ].join("\n");

  const fullContent = `${frontmatter}\n\n${content.trim()}\n`;

  await withLock(filePath, async () => {
    await atomicWrite(filePath, fullContent);
  });
  log(`Written digest for ${date} (${sessionCount} sessions)`);
}

/** @deprecated Use writeDigest instead. Kept for backwards compatibility with curate.ts. */
export async function appendToDigest(
  date: string,
  content: string,
  sessionsCovered: string[],
  config: Config
): Promise<void> {
  await writeDigest(date, content, sessionsCovered.length, [], config);
}
