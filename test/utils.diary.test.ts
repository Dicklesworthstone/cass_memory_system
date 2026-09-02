import { describe, it, expect } from "bun:test";
import { findDiaryBySession } from "../src/diary.js";
import { generateDiaryId, extractAgentFromPath, canonicalAgentName } from "../src/utils.js";
import { createTestDiary } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

describe("utils.generateDiaryId", () => {
  it("generates unique IDs for the same session path in rapid succession", () => {
    const sessionPath = "/path/to/session.jsonl";
    const id1 = generateDiaryId(sessionPath);
    const id2 = generateDiaryId(sessionPath);
    expect(id1).not.toBe(id2);
  });

  it("generates unique IDs for different paths", () => {
    const id1 = generateDiaryId("/path/1");
    const id2 = generateDiaryId("/path/2");
    expect(id1).not.toBe(id2);
  });

  it("maintains format 'diary-<hash>'", () => {
    const id = generateDiaryId("/path/to/session.jsonl");
    expect(id).toMatch(/^diary-[a-f0-9]{16}$/);
  });
});

describe("findDiaryBySession", () => {
  it("returns matching diary by sessionPath", async () => {
    await withTempDir("utils-diary-find", async (dir) => {
      const sessionPath = "/abs/path/to/session.jsonl";
      const diary = createTestDiary({ sessionPath });
      
      // Save diary
      const diaryPath = path.join(dir, `${diary.id}.json`);
      await writeFile(diaryPath, JSON.stringify(diary));
      
      const found = await findDiaryBySession(sessionPath, dir);
      expect(found).toBeDefined();
      expect(found?.id).toBe(diary.id);
    });
  });

  it("matches when input path differs only by relative vs absolute", async () => {
    await withTempDir("utils-diary-rel", async (dir) => {
      const sessionPath = path.join(dir, "session.jsonl");
      const diary = createTestDiary({ sessionPath });
      
      const diaryPath = path.join(dir, `${diary.id}.json`);
      await writeFile(diaryPath, JSON.stringify(diary));
      
      // Input relative path
      const found = await findDiaryBySession("session.jsonl", dir);
      // Since findDiaryBySession resolves relative against diaryDir base? 
      // No, wait. The implementation uses:
      // const base = path.resolve(expandPath(diaryDir));
      // const target = path.isAbsolute(sessionPath) ? ... : path.resolve(base, sessionPath);
      // If diaryDir is the temp dir, then path.resolve(dir, "session.jsonl") matches the sessionPath we used.
      // But wait, usually sessionPath in diary is absolute.
      
      expect(found).toBeDefined();
      expect(found?.id).toBe(diary.id);
    });
  });

  it("returns null when no diary matches", async () => {
    await withTempDir("utils-diary-none", async (dir) => {
      const diary = createTestDiary({ sessionPath: "/other/session.jsonl" });
      const diaryPath = path.join(dir, `${diary.id}.json`);
      await writeFile(diaryPath, JSON.stringify(diary));
      
      const found = await findDiaryBySession("/target/session.jsonl", dir);
      expect(found).toBeNull();
    });
  });
});

describe("utils.extractAgentFromPath", () => {
  it("recognizes the classic agent stores", () => {
    expect(extractAgentFromPath("/Users/u/.claude/projects/-Users-u-repo/abc.jsonl")).toBe("claude");
    expect(extractAgentFromPath("/home/u/.cursor/sessions/x.json")).toBe("cursor");
    expect(extractAgentFromPath("/home/u/.codex/sessions/2025/x.jsonl")).toBe("codex");
    expect(extractAgentFromPath("/home/u/repo/.aider.chat.history.md")).toBe("aider");
    expect(extractAgentFromPath("/home/u/.pi/agent/sessions/ws/x.jsonl")).toBe("pi_agent");
  });

  it("recognizes OMP (Oh My Pi) session stores on POSIX and Windows paths (#73)", () => {
    expect(extractAgentFromPath("/Users/u/.omp/agent/sessions/--Users-u-repo--/2026-09-01.jsonl")).toBe("omp");
    expect(extractAgentFromPath("C:\\Users\\u\\.omp\\agent\\sessions\\ws\\s.jsonl")).toBe("omp");
    expect(extractAgentFromPath("/home/u/.local/share/omp/sessions/ws/s.jsonl")).toBe("omp");
  });

  it("recognizes Windows separators for every store", () => {
    expect(extractAgentFromPath("C:\\Users\\u\\.claude\\projects\\p\\s.jsonl")).toBe("claude");
    expect(extractAgentFromPath("C:\\Users\\u\\.pi\\agent\\sessions\\ws\\s.jsonl")).toBe("pi_agent");
    expect(extractAgentFromPath("C:\\Users\\u\\.codex\\sessions\\s.jsonl")).toBe("codex");
  });

  it("recognizes the newer agent stores", () => {
    expect(extractAgentFromPath("/home/u/.gemini/tmp/x/chats/s.json")).toBe("gemini");
    expect(extractAgentFromPath("/home/u/.prime/agent/sessions/s.jsonl")).toBe("prime_agent");
    expect(extractAgentFromPath("/home/u/.kimi-code/sessions/s.jsonl")).toBe("kimi");
    expect(extractAgentFromPath("/home/u/.local/share/opencode/opencode.db")).toBe("opencode");
    expect(extractAgentFromPath("/home/u/.grok/sessions/s.json")).toBe("grok");
  });

  it("falls back to unknown and is case-insensitive", () => {
    expect(extractAgentFromPath("/tmp/random/session.jsonl")).toBe("unknown");
    expect(extractAgentFromPath("")).toBe("unknown");
    expect(extractAgentFromPath("/Users/u/.OMP/agent/sessions/s.jsonl")).toBe("omp");
  });
});

describe("utils.canonicalAgentName", () => {
  it("folds cass and tool aliases onto cm's canonical slugs", () => {
    expect(canonicalAgentName("claude_code")).toBe("claude");
    expect(canonicalAgentName("Claude-Code")).toBe("claude");
    expect(canonicalAgentName("oh-my-pi")).toBe("omp");
    expect(canonicalAgentName("pi-agent")).toBe("pi_agent");
    expect(canonicalAgentName("codex-cli")).toBe("codex");
    expect(canonicalAgentName("gemini-cli")).toBe("gemini");
  });

  it("trims, lower-cases, and passes unknown names through", () => {
    expect(canonicalAgentName("  OMP ")).toBe("omp");
    expect(canonicalAgentName("cursor")).toBe("cursor");
    expect(canonicalAgentName("some-new-agent")).toBe("some-new-agent");
  });

  it("does not resolve Object.prototype members as aliases", () => {
    expect(canonicalAgentName("constructor")).toBe("constructor");
    expect(canonicalAgentName("__proto__")).toBe("__proto__");
    expect(canonicalAgentName("toString")).toBe("tostring");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalAgentName("")).toBe("");
    expect(canonicalAgentName("   ")).toBe("");
    expect(canonicalAgentName(undefined)).toBe("");
    expect(canonicalAgentName(null)).toBe("");
  });
});
