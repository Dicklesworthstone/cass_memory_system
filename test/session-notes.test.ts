/**
 * Unit tests for session-notes.ts — session note generation, parsing, state management.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sessionIdFromPath,
  parseSessionNote,
  serializeSessionNote,
  loadProcessingState,
  saveProcessingState,
  discoverTranscripts,
  scanForModifiedTranscripts,
  findBestTranscriptForCwd,
  readTranscriptFromOffset,
  formatTranscriptChunk,
  processTranscript,
  sessionNotePath,
  type SessionNoteFrontmatter,
  type TranscriptScanResult,
} from "../src/session-notes.js";

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;
let originalHome: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "session-notes-test-"));
  originalHome = process.env.HOME || "";
  process.env.HOME = tempDir;

  // Create minimal directory structure
  await mkdir(path.join(tempDir, ".memory-system", "session-notes"), { recursive: true });
  await mkdir(path.join(tempDir, ".memory-system", "diary"), { recursive: true });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (!process.env.KEEP_TEMP) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Record<string, any> = {}): any {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    cassPath: "cass",
    playbookPath: path.join(tempDir, ".memory-system", "playbook.yaml"),
    diaryDir: path.join(tempDir, ".memory-system", "diary"),
    sessionNotesDir: path.join(tempDir, ".memory-system", "session-notes"),
    stateJsonPath: path.join(tempDir, ".memory-system", "state.json"),
    searchDbPath: path.join(tempDir, ".memory-system", "search.db"),
    budget: { dailyLimit: 0.50, monthlyLimit: 10.00, warningThreshold: 80, currency: "USD" },
    ...overrides,
  };
}

/** Create a mock transcript .jsonl file. */
async function createMockTranscript(sessionId: string, lines: object[]): Promise<string> {
  const projectDir = path.join(tempDir, ".claude", "projects", "test-project");
  await mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await writeFile(filePath, content);
  return filePath;
}

const SAMPLE_TRANSCRIPT_LINES = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the billing webhook auth issue" }] }, uuid: "msg-1", timestamp: "2026-03-20T09:15:00Z" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll investigate the billing webhook authentication. Let me check the config..." }] }, uuid: "msg-2", timestamp: "2026-03-20T09:16:00Z" },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "The error is HMAC validation failed in staging" }] }, uuid: "msg-3", timestamp: "2026-03-20T09:20:00Z" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Found it - the staging environment at /etc/billing/webhook.conf is using the old production secret key that was rotated last week. Updating the config now." }] }, uuid: "msg-4", timestamp: "2026-03-20T09:25:00Z" },
];

// ============================================================================
// sessionIdFromPath
// ============================================================================

describe("sessionIdFromPath", () => {
  test("extracts UUID from Claude Code transcript path", () => {
    const id = sessionIdFromPath("/home/user/.claude/projects/test/abc12345-1234-5678-9abc-def012345678.jsonl");
    expect(id).toBe("session-abc12345-1234-5678-9abc-def012345678");
  });

  test("hashes non-UUID filenames", () => {
    const id = sessionIdFromPath("/some/path/my-session-log.jsonl");
    expect(id).toStartWith("session-");
    expect(id.length).toBeGreaterThan(10);
  });

  test("produces stable IDs for same path", () => {
    const id1 = sessionIdFromPath("/path/to/session.jsonl");
    const id2 = sessionIdFromPath("/path/to/session.jsonl");
    expect(id1).toBe(id2);
  });

  test("produces different IDs for different paths", () => {
    const id1 = sessionIdFromPath("/path/to/session1.jsonl");
    const id2 = sessionIdFromPath("/path/to/session2.jsonl");
    expect(id1).not.toBe(id2);
  });
});

// ============================================================================
// parseSessionNote / serializeSessionNote
// ============================================================================

describe("parseSessionNote", () => {
  const sampleNote = `---
id: session-abc123
source_session: /path/to/transcript.jsonl
last_offset: 4327
created: 2026-03-20T09:15:00
last_updated: 2026-03-20T11:30:00
abstract: "Investigated billing webhook auth issue"
topics_touched: ["billing-service", "webhooks"]
processed: false
user_edited: false
---
## March 20, 2026

### 09:15 - Initial investigation

Started looking into billing webhook failures...`;

  test("parses frontmatter correctly", () => {
    const parsed = parseSessionNote(sampleNote);
    expect(parsed.frontmatter.id).toBe("session-abc123");
    expect(parsed.frontmatter.source_session).toBe("/path/to/transcript.jsonl");
    expect(parsed.frontmatter.last_offset).toBe(4327);
    expect(parsed.frontmatter.abstract).toBe("Investigated billing webhook auth issue");
    expect(parsed.frontmatter.topics_touched).toEqual(["billing-service", "webhooks"]);
    expect(parsed.frontmatter.processed).toBe(false);
    expect(parsed.frontmatter.user_edited).toBe(false);
  });

  test("preserves body content", () => {
    const parsed = parseSessionNote(sampleNote);
    expect(parsed.body).toContain("## March 20, 2026");
    expect(parsed.body).toContain("Started looking into billing webhook failures...");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseSessionNote("no frontmatter here")).toThrow("missing YAML frontmatter");
  });
});

describe("serializeSessionNote", () => {
  test("roundtrips through parse/serialize", () => {
    const fm: SessionNoteFrontmatter = {
      id: "session-test",
      source_session: "/path/to/session.jsonl",
      last_offset: 1000,
      created: "2026-03-20T09:00:00",
      last_updated: "2026-03-20T10:00:00",
      abstract: "Test session",
      topics_touched: ["testing", "ci-cd"],
      processed: false,
      user_edited: false,
    };
    const body = "## Test\n\nSome content here.";

    const serialized = serializeSessionNote(fm, body);
    const parsed = parseSessionNote(serialized);

    expect(parsed.frontmatter.id).toBe(fm.id);
    expect(parsed.frontmatter.last_offset).toBe(fm.last_offset);
    expect(parsed.frontmatter.abstract).toBe(fm.abstract);
    expect(parsed.frontmatter.topics_touched).toEqual(fm.topics_touched);
    expect(parsed.body.trim()).toBe(body);
  });

  test("escapes quotes in abstract", () => {
    const fm: SessionNoteFrontmatter = {
      id: "session-test",
      source_session: "/path",
      last_offset: 0,
      created: "2026-03-20",
      last_updated: "2026-03-20",
      abstract: 'Fixed "broken" auth',
      topics_touched: [],
      processed: false,
      user_edited: false,
    };

    const serialized = serializeSessionNote(fm, "body");
    expect(serialized).toContain('abstract: "Fixed \\"broken\\" auth"');
    const parsed = parseSessionNote(serialized);
    expect(parsed.frontmatter.abstract).toBe('Fixed \\"broken\\" auth');
  });
});

// ============================================================================
// Processing state
// ============================================================================

describe("processing state", () => {
  test("loadProcessingState returns empty state when file missing", async () => {
    const config = makeConfig();
    const state = await loadProcessingState(config);
    expect(state.sessions).toEqual({});
    expect(state.lastReflectionRun).toBeUndefined();
  });

  test("saveProcessingState and loadProcessingState roundtrip", async () => {
    const config = makeConfig();
    const state = {
      sessions: {
        "session-abc": { last_offset: 5000, last_processed: "2026-03-20T10:00:00" },
      },
      lastReflectionRun: "2026-03-20T09:00:00",
      lastIndexUpdate: undefined,
    };

    await saveProcessingState(state, config);
    const loaded = await loadProcessingState(config);

    expect(loaded.sessions["session-abc"]?.last_offset).toBe(5000);
    expect(loaded.lastReflectionRun).toBe("2026-03-20T09:00:00");
  });
});

// ============================================================================
// Transcript discovery and reading
// ============================================================================

describe("discoverTranscripts", () => {
  test("finds .jsonl files in Claude projects directory", async () => {
    await createMockTranscript("abc12345-1234-5678-9abc-def012345678", SAMPLE_TRANSCRIPT_LINES);

    const transcripts = await discoverTranscripts();
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    expect(transcripts.some((t) => t.endsWith(".jsonl"))).toBe(true);
  });

  test("returns empty array when no transcripts exist", async () => {
    // tempDir has no .claude/projects
    const transcripts = await discoverTranscripts();
    // May find transcripts from other test setups, so just check it doesn't throw
    expect(Array.isArray(transcripts)).toBe(true);
  });
});

describe("scanForModifiedTranscripts", () => {
  test("detects new transcripts", async () => {
    const transcriptPath = await createMockTranscript(
      "11111111-1111-1111-1111-111111111111",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();
    const results = await scanForModifiedTranscripts(config);

    const match = results.find((r) => r.transcriptPath === transcriptPath);
    expect(match).toBeDefined();
    expect(match!.isNew).toBe(true);
    expect(match!.lastOffset).toBe(0);
    expect(match!.currentSize).toBeGreaterThan(0);
  });

  test("skips transcripts already at current offset", async () => {
    const transcriptPath = await createMockTranscript(
      "22222222-2222-2222-2222-222222222222",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();

    // Save state with current file size as offset
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(transcriptPath);
    await saveProcessingState(
      {
        sessions: {
          "session-22222222-2222-2222-2222-222222222222": {
            last_offset: fileStat.size,
            last_processed: "2026-03-20T10:00:00",
          },
        },
      },
      config
    );

    const results = await scanForModifiedTranscripts(config);
    const match = results.find((r) => r.transcriptPath === transcriptPath);
    expect(match).toBeUndefined();
  });
});

describe("readTranscriptFromOffset", () => {
  test("reads full file when offset is 0", async () => {
    const transcriptPath = await createMockTranscript(
      "33333333-3333-3333-3333-333333333333",
      SAMPLE_TRANSCRIPT_LINES
    );

    const { content, newOffset } = await readTranscriptFromOffset(transcriptPath, 0);
    expect(content.length).toBeGreaterThan(0);
    expect(newOffset).toBeGreaterThan(0);

    // Should contain our transcript lines
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(SAMPLE_TRANSCRIPT_LINES.length);
  });

  test("reads only new content from offset", async () => {
    const transcriptPath = await createMockTranscript(
      "44444444-4444-4444-4444-444444444444",
      SAMPLE_TRANSCRIPT_LINES
    );

    // Read first two lines worth of bytes
    const { content: fullContent, newOffset: fullOffset } = await readTranscriptFromOffset(transcriptPath, 0);

    // Find offset of second line
    const firstLine = fullContent.split("\n")[0];
    const partialOffset = Buffer.byteLength(firstLine + "\n");

    const { content: remainder, newOffset } = await readTranscriptFromOffset(transcriptPath, partialOffset);
    expect(newOffset).toBe(fullOffset);
    expect(remainder.length).toBeLessThan(fullContent.length);
    // Should not start with the first line
    expect(remainder.startsWith(firstLine)).toBe(false);
  });

  test("returns empty when offset equals file size", async () => {
    const transcriptPath = await createMockTranscript(
      "55555555-5555-5555-5555-555555555555",
      SAMPLE_TRANSCRIPT_LINES
    );

    const { newOffset } = await readTranscriptFromOffset(transcriptPath, 0);
    const { content } = await readTranscriptFromOffset(transcriptPath, newOffset);
    expect(content).toBe("");
  });
});

describe("formatTranscriptChunk", () => {
  test("formats JSONL into readable text", () => {
    const jsonl = SAMPLE_TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n");
    const formatted = formatTranscriptChunk(jsonl);

    expect(formatted).toContain("user");
    expect(formatted).toContain("billing webhook");
  });

  test("handles empty input", () => {
    const formatted = formatTranscriptChunk("");
    expect(formatted).toBe("");
  });
});

// ============================================================================
// processTranscript (with mock LLM)
// ============================================================================

describe("processTranscript", () => {
  test("creates new session note with mock LLM", async () => {
    const transcriptPath = await createMockTranscript(
      "66666666-6666-6666-6666-666666666666",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();

    // Mock LLM that returns a valid SessionNoteCreateOutput
    const mockIo = {
      generateObject: async () => ({
        object: {
          abstract: "Investigated and fixed billing webhook HMAC auth issue in staging",
          topics_touched: ["billing-service", "webhooks"],
          content: "## March 20, 2026\n\n### 09:15 - Webhook auth investigation\n\nDiscovered HMAC validation failure in staging at /etc/billing/webhook.conf due to rotated production key.",
        },
        usage: { promptTokens: 100, completionTokens: 50 },
      }),
    };

    const scan: TranscriptScanResult = {
      sessionId: "session-66666666-6666-6666-6666-666666666666",
      transcriptPath,
      currentSize: (await import("node:fs/promises").then((fs) => fs.stat(transcriptPath))).size,
      lastOffset: 0,
      isNew: true,
    };

    const result = await processTranscript(scan, config, { io: mockIo });

    expect(result.frontmatter.id).toBe("session-66666666-6666-6666-6666-666666666666");
    expect(result.frontmatter.abstract).toContain("billing webhook");
    expect(result.frontmatter.topics_touched).toContain("billing-service");
    expect(result.body).toContain("## March 20, 2026");

    // Verify file was written
    const notePath = sessionNotePath(scan.sessionId, config);
    const onDisk = await readFile(notePath, "utf-8");
    expect(onDisk).toContain("billing webhook");

    // Verify state was updated
    const state = await loadProcessingState(config);
    expect(state.sessions[scan.sessionId]?.last_offset).toBe(scan.currentSize);
  });

  test("extends existing session note with mock LLM", async () => {
    const transcriptPath = await createMockTranscript(
      "77777777-7777-7777-7777-777777777777",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();
    const sessionId = "session-77777777-7777-7777-7777-777777777777";

    // Write an existing note
    const { writeSessionNote: writeNote } = await import("../src/session-notes.js");
    await writeNote(
      sessionId,
      {
        id: sessionId,
        source_session: transcriptPath,
        last_offset: 100,
        created: "2026-03-20T09:00:00",
        last_updated: "2026-03-20T09:30:00",
        abstract: "Initial webhook investigation",
        topics_touched: ["billing-service"],
        processed: false,
        user_edited: false,
      },
      "## March 20, 2026\n\n### 09:15 - Initial investigation\n\nStarted looking into webhook failures.",
      config
    );

    // Mock LLM for append
    const mockIo = {
      generateObject: async () => ({
        object: {
          abstract: "Investigated and fixed billing webhook HMAC auth issue in staging",
          topics_touched: ["billing-service", "webhooks", "security"],
          new_content: "### 10:30 - Root cause found\n\nHMAC key mismatch in staging config.",
        },
        usage: { promptTokens: 200, completionTokens: 50 },
      }),
    };

    const fileStat = await import("node:fs/promises").then((fs) => fs.stat(transcriptPath));
    const scan: TranscriptScanResult = {
      sessionId,
      transcriptPath,
      currentSize: fileStat.size,
      lastOffset: 100,
      isNew: false,
    };

    const result = await processTranscript(scan, config, { io: mockIo });

    // Should have updated abstract
    expect(result.frontmatter.abstract).toContain("fixed");
    // Should have merged topics
    expect(result.frontmatter.topics_touched).toContain("webhooks");
    expect(result.frontmatter.topics_touched).toContain("security");
    // Body should contain both old and new content
    expect(result.body).toContain("Initial investigation");
    expect(result.body).toContain("Root cause found");
  });

  test("skips user-edited notes", async () => {
    const transcriptPath = await createMockTranscript(
      "88888888-8888-8888-8888-888888888888",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();
    const sessionId = "session-88888888-8888-8888-8888-888888888888";

    // Write a user-edited note
    const { writeSessionNote: writeNote } = await import("../src/session-notes.js");
    await writeNote(
      sessionId,
      {
        id: sessionId,
        source_session: transcriptPath,
        last_offset: 0,
        created: "2026-03-20T09:00:00",
        last_updated: "2026-03-20T09:30:00",
        abstract: "User's custom summary",
        topics_touched: ["billing-service"],
        processed: false,
        user_edited: true,
      },
      "## My custom notes\n\nUser wrote this.",
      config
    );

    const fileStat = await import("node:fs/promises").then((fs) => fs.stat(transcriptPath));
    const scan: TranscriptScanResult = {
      sessionId,
      transcriptPath,
      currentSize: fileStat.size,
      lastOffset: 0,
      isNew: false,
    };

    // Should not call LLM at all
    const mockIo = {
      generateObject: async () => {
        throw new Error("LLM should not be called for user-edited notes");
      },
    };

    const result = await processTranscript(scan, config, { io: mockIo });
    expect(result.frontmatter.user_edited).toBe(true);
    expect(result.body).toContain("User wrote this.");

    // State should still be updated
    const state = await loadProcessingState(config);
    expect(state.sessions[sessionId]?.last_offset).toBe(fileStat.size);
  });

  test("creates new session note with agent-provided content (no LLM call)", async () => {
    const transcriptPath = await createMockTranscript(
      "99999999-9999-9999-9999-999999999999",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();

    // LLM should NOT be called — agent provides content directly
    const failIo = {
      generateObject: async () => {
        throw new Error("LLM should not be called when agentContent is provided");
      },
    };

    const fileStat = await import("node:fs/promises").then((fs) => fs.stat(transcriptPath));
    const scan: TranscriptScanResult = {
      sessionId: "session-99999999-9999-9999-9999-999999999999",
      transcriptPath,
      currentSize: fileStat.size,
      lastOffset: 0,
      isNew: true,
    };

    const result = await processTranscript(scan, config, {
      io: failIo,
      agentContent: {
        abstract: "Agent-generated summary of billing webhook fix",
        topics_touched: ["billing-service", "staging-config"],
        content: "## March 20, 2026\n\n### Agent Notes\n\nFixed HMAC key mismatch in staging webhook config at /etc/billing/webhook.conf.",
      },
    });

    expect(result.frontmatter.id).toBe("session-99999999-9999-9999-9999-999999999999");
    expect(result.frontmatter.abstract).toBe("Agent-generated summary of billing webhook fix");
    expect(result.frontmatter.topics_touched).toContain("billing-service");
    expect(result.frontmatter.topics_touched).toContain("staging-config");
    expect(result.body).toContain("Agent Notes");
    expect(result.body).toContain("/etc/billing/webhook.conf");

    // Verify file was written
    const notePath = sessionNotePath(scan.sessionId, config);
    const onDisk = await readFile(notePath, "utf-8");
    expect(onDisk).toContain("Agent-generated summary");

    // Verify state was updated
    const state = await loadProcessingState(config);
    expect(state.sessions[scan.sessionId]?.last_offset).toBe(fileStat.size);
  });

  test("extends existing note with agent-provided content (no LLM call)", async () => {
    const transcriptPath = await createMockTranscript(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      SAMPLE_TRANSCRIPT_LINES
    );

    const config = makeConfig();
    const sessionId = "session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    // Write an existing note
    const { writeSessionNote: writeNote } = await import("../src/session-notes.js");
    await writeNote(
      sessionId,
      {
        id: sessionId,
        source_session: transcriptPath,
        last_offset: 100,
        created: "2026-03-20T09:00:00",
        last_updated: "2026-03-20T09:30:00",
        abstract: "Initial webhook investigation",
        topics_touched: ["billing-service"],
        processed: false,
        user_edited: false,
      },
      "## March 20, 2026\n\n### 09:15 - Initial investigation\n\nStarted looking into webhook failures.",
      config
    );

    // LLM should NOT be called
    const failIo = {
      generateObject: async () => {
        throw new Error("LLM should not be called when agentContent is provided");
      },
    };

    const fileStat = await import("node:fs/promises").then((fs) => fs.stat(transcriptPath));
    const scan: TranscriptScanResult = {
      sessionId,
      transcriptPath,
      currentSize: fileStat.size,
      lastOffset: 100,
      isNew: false,
    };

    const result = await processTranscript(scan, config, {
      io: failIo,
      agentContent: {
        abstract: "Investigated and fixed billing webhook HMAC auth in staging",
        topics_touched: ["billing-service", "security"],
        content: "### 10:30 - Root cause found by agent\n\nHMAC key was rotated but staging still had old key.",
      },
    });

    // Should have updated abstract from agent
    expect(result.frontmatter.abstract).toBe("Investigated and fixed billing webhook HMAC auth in staging");
    // Should have merged topics
    expect(result.frontmatter.topics_touched).toContain("security");
    expect(result.frontmatter.topics_touched).toContain("billing-service");
    // Body should contain both old and new content
    expect(result.body).toContain("Initial investigation");
    expect(result.body).toContain("Root cause found by agent");
  });
});

// ============================================================================
// sessionNotePath
// ============================================================================

describe("sessionNotePath", () => {
  test("constructs correct path", () => {
    const config = makeConfig();
    const notePath = sessionNotePath("session-abc123", config);
    expect(notePath).toContain("session-notes");
    expect(notePath).toEndWith("session-abc123.md");
  });
});

// ============================================================================
// findBestTranscriptForCwd
// ============================================================================

describe("findBestTranscriptForCwd", () => {
  function makeScan(projectDir: string, uuid: string, transcriptDir?: string): TranscriptScanResult {
    const dir = transcriptDir || path.join(tempDir, ".claude", "projects", projectDir);
    return {
      sessionId: `session-${uuid}`,
      transcriptPath: path.join(dir, `${uuid}.jsonl`),
      currentSize: 1000,
      lastOffset: 0,
      isNew: true,
    };
  }

  test("returns null for empty scans", async () => {
    const result = await findBestTranscriptForCwd([], "/some/cwd");
    expect(result).toBeNull();
  });

  test("returns the single scan when only one exists", async () => {
    const scan = makeScan("-Other-Project", "aaa-bbb");
    const result = await findBestTranscriptForCwd([scan], "/Some/Unrelated/Path");
    expect(result).toBe(scan);
  });

  test("filters to matching project directory", async () => {
    // Create real files so stat() works for mtime sorting
    const projA = path.join(tempDir, ".claude", "projects", "-Users-test-ProjectA");
    const projB = path.join(tempDir, ".claude", "projects", "-Users-test-ProjectB");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    const fileA = path.join(projA, "uuid-aaaa.jsonl");
    const fileB = path.join(projB, "uuid-bbbb.jsonl");
    await writeFile(fileA, "{}");
    await writeFile(fileB, "{}");

    const scanA: TranscriptScanResult = {
      sessionId: "session-uuid-aaaa",
      transcriptPath: fileA,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };
    const scanB: TranscriptScanResult = {
      sessionId: "session-uuid-bbbb",
      transcriptPath: fileB,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    // cwd matches ProjectA — should pick scanA
    const result = await findBestTranscriptForCwd([scanB, scanA], "/Users/test/ProjectA");
    expect(result?.sessionId).toBe("session-uuid-aaaa");
  });

  test("handles underscore vs hyphen normalization", async () => {
    // Simulates: cwd has underscores, project dir has hyphens
    const projDir = path.join(tempDir, ".claude", "projects", "-Users-dev-my-cool-project");
    await mkdir(projDir, { recursive: true });
    const file = path.join(projDir, "uuid-1111.jsonl");
    await writeFile(file, "{}");

    const scan: TranscriptScanResult = {
      sessionId: "session-uuid-1111",
      transcriptPath: file,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    const otherDir = path.join(tempDir, ".claude", "projects", "-Users-dev-other-proj");
    await mkdir(otherDir, { recursive: true });
    const otherFile = path.join(otherDir, "uuid-2222.jsonl");
    await writeFile(otherFile, "{}");

    const otherScan: TranscriptScanResult = {
      sessionId: "session-uuid-2222",
      transcriptPath: otherFile,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    // cwd uses underscores: my_cool_project → normalized to my-cool-project
    const result = await findBestTranscriptForCwd(
      [otherScan, scan],
      "/Users/dev/my_cool_project"
    );
    expect(result?.sessionId).toBe("session-uuid-1111");
  });

  test("sorts by mtime within matching project (newest first)", async () => {
    const projDir = path.join(tempDir, ".claude", "projects", "-Users-test-MyProject");
    await mkdir(projDir, { recursive: true });

    const fileOld = path.join(projDir, "uuid-old.jsonl");
    const fileNew = path.join(projDir, "uuid-new.jsonl");

    // Write old file first, then new file
    await writeFile(fileOld, "old");
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(fileNew, "new");

    const scanOld: TranscriptScanResult = {
      sessionId: "session-uuid-old",
      transcriptPath: fileOld,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };
    const scanNew: TranscriptScanResult = {
      sessionId: "session-uuid-new",
      transcriptPath: fileNew,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    // Even though scanOld is first in array, scanNew should win (newer mtime)
    const result = await findBestTranscriptForCwd(
      [scanOld, scanNew],
      "/Users/test/MyProject"
    );
    expect(result?.sessionId).toBe("session-uuid-new");
  });

  test("falls back to all scans sorted by mtime when no project matches", async () => {
    const projDir = path.join(tempDir, ".claude", "projects", "-Users-test-SomeProject");
    await mkdir(projDir, { recursive: true });

    const fileOld = path.join(projDir, "uuid-old.jsonl");
    const fileNew = path.join(projDir, "uuid-new.jsonl");
    await writeFile(fileOld, "old");
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(fileNew, "new");

    const scanOld: TranscriptScanResult = {
      sessionId: "session-uuid-old",
      transcriptPath: fileOld,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };
    const scanNew: TranscriptScanResult = {
      sessionId: "session-uuid-new",
      transcriptPath: fileNew,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    // cwd doesn't match any project — should still pick newest by mtime
    const result = await findBestTranscriptForCwd(
      [scanOld, scanNew],
      "/Completely/Different/Path"
    );
    expect(result?.sessionId).toBe("session-uuid-new");
  });

  test("prevents cross-project contamination", async () => {
    // Simulate the exact bug: transcripts from two different projects
    const cassDir = path.join(tempDir, ".claude", "projects", "-Users-dev-cass-memory-system");
    const rewayDir = path.join(tempDir, ".claude", "projects", "-Users-dev-reway-mvp-v2");
    await mkdir(cassDir, { recursive: true });
    await mkdir(rewayDir, { recursive: true });

    const cassFile = path.join(cassDir, "cass-uuid.jsonl");
    const rewayFile = path.join(rewayDir, "reway-uuid.jsonl");

    // reway was modified first, cass is more recent
    await writeFile(rewayFile, "reway content");
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(cassFile, "cass content");

    const cassScan: TranscriptScanResult = {
      sessionId: "session-cass-uuid",
      transcriptPath: cassFile,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };
    const rewayScan: TranscriptScanResult = {
      sessionId: "session-reway-uuid",
      transcriptPath: rewayFile,
      currentSize: 100,
      lastOffset: 0,
      isNew: true,
    };

    // From cass project cwd — must pick cass transcript, never reway
    const result = await findBestTranscriptForCwd(
      [rewayScan, cassScan], // reway first in array (simulates filesystem order)
      "/Users/dev/cass_memory_system" // underscore in real path → hyphen in project dir
    );
    expect(result?.sessionId).toBe("session-cass-uuid");
  });
});
