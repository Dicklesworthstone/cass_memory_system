import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { 
  cassAvailable, 
  handleCassUnavailable, 
  cassNeedsIndex,
  safeCassSearch,
  cassExport,
  cassExpand,
  cassTimeline,
  findUnprocessedSessions,
  CASS_EXIT_CODES
} from "../src/cass.js";
import { withTempDir, makeCassStub } from "./helpers/temp.js";
import { createTestConfig } from "./helpers/factories.js";

describe("cass.ts core functions (stubbed)", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    mock.restore();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.CASS_PATH;
  });

  it.serial("cassAvailable detects stub", async () => {
    await withTempDir("cass-available", async (dir) => {
      const cassPath = await makeCassStub(dir);
      expect(cassAvailable(cassPath)).toBe(true);
    });
  });

  it.serial("handleCassUnavailable falls back when cass missing", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    process.env.CASS_PATH = "/no/cass";
    const result = await handleCassUnavailable({ cassPath: "/no/cass", searchCommonPaths: false });
    process.env.PATH = savedPath;
    expect(result.fallbackMode).toBe("playbook-only");
    expect(result.canContinue).toBe(true);
  });

  it.serial("cassNeedsIndex returns true on INDEX_MISSING health code", async () => {
    await withTempDir("cass-health", async (dir) => {
      const cassPath = await makeCassStub(dir, { healthExit: CASS_EXIT_CODES.INDEX_MISSING });
      expect(cassNeedsIndex(cassPath)).toBe(true);
    });
  });

  it.serial("safeCassSearch parses hits from stub", async () => {
    await withTempDir("cass-search", async (dir) => {
      const hitsData = [{
        source_path: "test.ts",
        line_number: 10,
        snippet: "test code",
        agent: "claude",
        score: 0.9
      }];
      
      const cassPath = await makeCassStub(dir, { search: JSON.stringify(hitsData) });
      const config = createTestConfig();
      
      const hits = await safeCassSearch("query", { limit: 1, force: true }, cassPath, config);
      
      expect(hits).toHaveLength(1);
      expect(hits[0].source_path).toBe("test.ts");
    });
  });

  it.serial("cassExport returns content from stub", async () => {
    await withTempDir("cass-export", async (dir) => {
      const cassPath = await makeCassStub(dir, { export: "exported content" });
      const config = createTestConfig();
      
      const content = await cassExport("session.jsonl", "text", cassPath, config);
      // Stub adds newline via echo
      expect(content?.trim()).toBe("exported content");
    });
  });

  it.serial("cassExpand returns context from stub", async () => {
    await withTempDir("cass-expand", async (dir) => {
      const cassPath = await makeCassStub(dir, { expand: "expanded context" });
      const config = createTestConfig();
      
      const content = await cassExpand("session.jsonl", 10, 2, cassPath, config);
      expect(content?.trim()).toBe("expanded context");
    });
  });

  it.serial("cassTimeline returns groups parsed from stub", async () => {
    await withTempDir("cass-timeline", async (dir) => {
      const output = JSON.stringify({
        groups: [
          {
            date: "2025-01-01",
            sessions: [
              { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" }
            ]
          }
        ]
      });
      
      const cassPath = await makeCassStub(dir, { timeline: output });
      const result = await cassTimeline(7, cassPath);
      
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].date).toBe("2025-01-01");
    });
  });

  it.serial("findUnprocessedSessions respects processed set", async () => {
    await withTempDir("cass-unprocessed", async (dir) => {
      const output = JSON.stringify({
        groups: [
          {
            date: "2025-01-01",
            sessions: [
              { path: "s1.jsonl", agent: "claude", messageCount: 10, startTime: "10:00", endTime: "11:00" },
              { path: "s2.jsonl", agent: "claude", messageCount: 5, startTime: "12:00", endTime: "13:00" }
            ]
          }
        ]
      });
      
      const cassPath = await makeCassStub(dir, { timeline: output });
      const processed = new Set(["s1.jsonl"]);
      
      const result = await findUnprocessedSessions(processed, {}, cassPath);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("s2.jsonl");
    });
  });
});
