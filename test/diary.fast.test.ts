import { describe, test, expect } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { diaryCommand } from "../src/commands/diary.js";
import { formatRawSession, inferOutcome, generateDiaryFromContent } from "../src/diary.js";
import { createTestConfig, withTempCassHome, withTempDir } from "./helpers/index.js";

describe("Fast Diary Extraction", () => {
  describe("inferOutcome", () => {
    test("returns failure for content with error patterns", () => {
      expect(inferOutcome("Error: Failed to compile")).toBe("failure");
      expect(inferOutcome("The build failed with errors")).toBe("failure");
      expect(inferOutcome("TypeError: undefined is not a function")).toBe("failure");
      expect(inferOutcome("Traceback (most recent call last)")).toBe("failure");
      expect(inferOutcome("SyntaxError: Unexpected token")).toBe("failure");
    });

    test("returns success for content with success patterns", () => {
      expect(inferOutcome("Build completed successfully")).toBe("success");
      expect(inferOutcome("All tests passed")).toBe("success");
      expect(inferOutcome("Fixed the bug in the login flow")).toBe("success");
      expect(inferOutcome("The feature works correctly now")).toBe("success");
      expect(inferOutcome("Issue resolved")).toBe("success");
    });

    test("returns mixed for content with both patterns", () => {
      expect(inferOutcome("Error: Failed to compile but then it was fixed")).toBe("mixed");
      expect(inferOutcome("Had some errors but successfully resolved them")).toBe("mixed");
      expect(inferOutcome("TypeError occurred, but all tests pass now")).toBe("mixed");
    });

    test("returns success for neutral content", () => {
      expect(inferOutcome("Working on the feature")).toBe("success");
      expect(inferOutcome("Added new functionality to the app")).toBe("success");
      expect(inferOutcome("Refactored the code")).toBe("success");
    });

    test("handles empty content", () => {
      expect(inferOutcome("")).toBe("success");
    });

    test("is case insensitive", () => {
      expect(inferOutcome("ERROR: something went wrong")).toBe("failure");
      expect(inferOutcome("error: something went wrong")).toBe("failure");
      expect(inferOutcome("SUCCESSFULLY completed")).toBe("success");
      expect(inferOutcome("Successfully completed")).toBe("success");
    });

    test("detects specific error types", () => {
      expect(inferOutcome("Cannot find module 'react'")).toBe("failure");
      expect(inferOutcome("Module not found")).toBe("failure");
      expect(inferOutcome("null reference exception")).toBe("failure");
      expect(inferOutcome("RuntimeError: stack overflow")).toBe("failure");
    });

    test("detects specific success patterns", () => {
      expect(inferOutcome("Build successful")).toBe("success");
      expect(inferOutcome("All tests pass")).toBe("success");
      expect(inferOutcome("It works now")).toBe("success");
      expect(inferOutcome("Done with the implementation")).toBe("success");
    });
  });

  describe("generateDiaryFromContent", () => {
    test("throws when content is empty after sanitization", async () => {
      await withTempDir("diary-empty", async (tmp) => {
        const config = createTestConfig({ diaryDir: tmp });
        await expect(generateDiaryFromContent("/tmp/session.jsonl", "   ", config))
          .rejects
          .toThrow("Session content is empty after sanitization");
      });
    });
  });

  describe("formatRawSession", () => {
    test("returns markdown content unchanged", () => {
      const content = "# Title\n\nSome content.";
      expect(formatRawSession(content, ".md")).toBe(content);
      expect(formatRawSession(content, "md")).toBe(content);
    });

    test("formats jsonl messages and flags parse errors", () => {
      const lines = [
        JSON.stringify({ role: "user", content: "Hello" }),
        JSON.stringify({ role: "assistant", content: "Hi there" }),
        "{not:json}"
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).toContain("**user**: Hello");
      expect(formatted).toContain("**assistant**: Hi there");
      expect(formatted).toContain("[PARSE ERROR]");
    });

    test("formats jsonl messages with array content blocks", () => {
      const lines = [
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "Hello" }, { type: "text", text: "World" }]
        }),
        JSON.stringify({ role: "assistant", content: [{ text: "Ack" }] })
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).toContain("**user**: Hello\nWorld");
      expect(formatted).toContain("**assistant**: Ack");
    });

    test("skips Codex CLI session_meta entries", () => {
      const lines = [
        JSON.stringify({ type: "session_meta", session_id: "abc123", timestamp: 1234567890 }),
        JSON.stringify({ role: "user", content: "Hello" }),
        JSON.stringify({ role: "assistant", content: "Hi" })
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).not.toContain("session_meta");
      expect(formatted).not.toContain("abc123");
      expect(formatted).toContain("**user**: Hello");
      expect(formatted).toContain("**assistant**: Hi");
    });

    test("formats Codex CLI response_item with payload.message", () => {
      const lines = [
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: "I'll help with that" }
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ text: "Thanks" }] }
        })
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).toContain("**assistant**: I'll help with that");
      expect(formatted).toContain("**user**: Thanks");
    });

    test("skips response_item entries without message payload", () => {
      const lines = [
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", name: "read_file" }
        }),
        JSON.stringify({ role: "user", content: "Hello" })
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).not.toContain("function_call");
      expect(formatted).not.toContain("read_file");
      expect(formatted).toContain("**user**: Hello");
    });

    test("handles nested content property with array value", () => {
      // Test the recursion fix: when an object has content as an array
      const lines = [
        JSON.stringify({
          role: "assistant",
          content: { content: [{ text: "Nested" }, { text: "Content" }] }
        })
      ].join("\n");
      const formatted = formatRawSession(lines, ".jsonl");
      expect(formatted).toContain("**assistant**: Nested\nContent");
    });

    test("formats json messages from supported containers", () => {
      const payload = JSON.stringify({
        messages: [
          { role: "system", content: "System note" },
          { role: "user", content: "Do work" }
        ]
      });
      const formatted = formatRawSession(payload, ".json");
      expect(formatted).toContain("**system**: System note");
      expect(formatted).toContain("**user**: Do work");
    });

    test("formats json messages with array content blocks", () => {
      const payload = JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "Run tests" }] },
          { role: "assistant", content: [{ text: "Running..." }, { text: "Done" }] }
        ]
      });
      const formatted = formatRawSession(payload, ".json");
      expect(formatted).toContain("**user**: Run tests");
      expect(formatted).toContain("**assistant**: Running...\nDone");
    });

    test("returns warning for unrecognized json structure", () => {
      const payload = JSON.stringify({ foo: "bar" });
      const formatted = formatRawSession(payload, ".json");
      expect(formatted).toContain("WARNING: Unrecognized JSON structure");
    });

    test("returns parse error for invalid json", () => {
      const formatted = formatRawSession("{not valid json", ".json");
      expect(formatted).toContain("[PARSE ERROR: Invalid JSON]");
    });
  });

  describe("diaryCommand --raw", () => {
    test("uses raw file content and sanitizes secrets", async () => {
      const originalLLM = process.env.CASS_MEMORY_LLM;
      process.env.CASS_MEMORY_LLM = "none";

      try {
        await withTempCassHome(async (env) => {
          const sessionPath = path.join(env.home, "session.jsonl");
          const secret = "sk-test-12345678901234567890";
          const sessionLines = [
            JSON.stringify({ role: "user", content: `Please fix the bug. apiKey=${secret}` }),
            JSON.stringify({ role: "assistant", content: "Working on it." })
          ].join("\n");

          await writeFile(sessionPath, sessionLines, "utf-8");

          await diaryCommand(sessionPath, { raw: true, save: true, json: true });

          const diaryFiles = (await readdir(env.diaryDir)).filter((f) => f.endsWith(".json"));
          expect(diaryFiles.length).toBe(1);

          const diaryRaw = await readFile(path.join(env.diaryDir, diaryFiles[0]!), "utf-8");
          const diary = JSON.parse(diaryRaw);

          expect(diary.accomplishments[0]).toContain("[API_KEY]");
          expect(diary.accomplishments[0]).not.toContain(secret);
        });
      } finally {
        if (originalLLM === undefined) {
          delete process.env.CASS_MEMORY_LLM;
        } else {
          process.env.CASS_MEMORY_LLM = originalLLM;
        }
      }
    });
  });
});
