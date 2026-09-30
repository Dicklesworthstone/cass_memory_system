import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { findDiaryBySession } from "../src/diary.js";
import {
  buildDiaryInput,
  canonicalAgentName,
  extractAgentFromPath,
  generateDiaryId,
  scanTruncatedMiddle,
} from "../src/utils.js";
import { createTestDiary } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

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
    expect(extractAgentFromPath("/Users/u/.claude/projects/-Users-u-repo/abc.jsonl")).toBe(
      "claude",
    );
    expect(extractAgentFromPath("/home/u/.cursor/sessions/x.json")).toBe("cursor");
    expect(extractAgentFromPath("/home/u/.codex/sessions/2025/x.jsonl")).toBe("codex");
    expect(extractAgentFromPath("/home/u/repo/.aider.chat.history.md")).toBe("aider");
    expect(extractAgentFromPath("/home/u/.pi/agent/sessions/ws/x.jsonl")).toBe("pi_agent");
  });

  it("recognizes OMP (Oh My Pi) session stores on POSIX and Windows paths (#73)", () => {
    expect(
      extractAgentFromPath("/Users/u/.omp/agent/sessions/--Users-u-repo--/2026-09-01.jsonl"),
    ).toBe("omp");
    expect(extractAgentFromPath("C:\\Users\\u\\.omp\\agent\\sessions\\ws\\s.jsonl")).toBe("omp");
    expect(extractAgentFromPath("/home/u/.local/share/omp/sessions/ws/s.jsonl")).toBe("omp");
  });

  it("recognizes Windows separators for every store", () => {
    expect(extractAgentFromPath("C:\\Users\\u\\.claude\\projects\\p\\s.jsonl")).toBe("claude");
    expect(extractAgentFromPath("C:\\Users\\u\\.pi\\agent\\sessions\\ws\\s.jsonl")).toBe(
      "pi_agent",
    );
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

// A filler line of ordinary agent prose with no error/correction wording.
function filler(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`[assistant] Reading module ${i} and noting how the parser hands tokens to the emitter.`);
  }
  return out.join("\n");
}

describe("utils.buildDiaryInput (#88)", () => {
  it("returns a transcript within the budget unchanged", () => {
    const text = "[user] fix the build\n[assistant] done";
    expect(buildDiaryInput(text, { maxChars: 50_000, middleScanChars: 8_000 })).toBe(text);
  });

  it("keeps head and tail and pulls signal lines from the dropped middle", () => {
    const head = `[user] HEAD-TASK: migrate the importer\n${filler(200)}`;
    const middle = [
      filler(300),
      "[assistant] Running bun test now.",
      "[tool] error: Cannot find module './legacy-importer' from src/index.ts",
      "[user] no, the legacy importer was removed last week; use src/import/v2.ts",
      filler(300),
      "[user] MIDDLE-OPENER-AFTER-ERROR please look again",
      filler(300),
    ].join("\n");
    const tail = `${filler(200)}\n[assistant] TAIL-SUMMARY: all tests pass`;
    const text = `${head}\n${middle}\n${tail}`;
    expect(text.length).toBeGreaterThan(100_000);

    const out = buildDiaryInput(text, { maxChars: 20_000, middleScanChars: 2_000 });
    expect(out).toContain("HEAD-TASK");
    expect(out).toContain("TAIL-SUMMARY");
    expect(out).toContain("Cannot find module './legacy-importer'");
    expect(out).toContain("[user] no, the legacy importer was removed");
    expect(out).toContain("excerpts from that part");
    // Head/tail budget plus the scan budget plus the fixed markers.
    expect(out.length).toBeLessThanOrEqual(20_000 + 2_000 + 400);
    // Excerpts appear in transcript order.
    expect(out.indexOf("Cannot find module")).toBeLessThan(out.indexOf("[user] no, the legacy"));
  });

  it("with middleScanChars 0 behaves as a plain head/tail cut", () => {
    const text = `${filler(500)}\n[tool] error: boom\n${filler(500)}`;
    const out = buildDiaryInput(text, { maxChars: 10_000, middleScanChars: 0 });
    expect(out).not.toContain("error: boom");
    expect(out).toContain("[...truncated:");
    expect(out.length).toBeLessThanOrEqual(10_000 + 200);
  });

  it("scales the window with maxChars", () => {
    const text = filler(3000);
    const small = buildDiaryInput(text, { maxChars: 10_000, middleScanChars: 0 });
    const large = buildDiaryInput(text, { maxChars: 100_000, middleScanChars: 0 });
    expect(large.length).toBeGreaterThan(small.length * 5);
    expect(large.length).toBeLessThanOrEqual(100_000 + 200);
  });
});

describe("utils.scanTruncatedMiddle (#88)", () => {
  it("returns nothing for plain prose or a zero budget", () => {
    expect(scanTruncatedMiddle(filler(50), 8_000)).toEqual([]);
    expect(scanTruncatedMiddle("[tool] error: x", 0)).toEqual([]);
  });

  it("ranks user corrections above agent-side errors when the budget is tight", () => {
    const errors = Array.from({ length: 40 }, (_, i) => `[tool] error: failure number ${i} in step ${i}`);
    const middle = [...errors, "[user] actually the config lives in .cass/config.yaml"].join("\n");
    const picked = scanTruncatedMiddle(middle, 200);
    expect(picked).toContain("[user] actually the config lives in .cass/config.yaml");
    expect(picked.join("\n").length + picked.length).toBeLessThanOrEqual(200);
  });

  it("includes the user turn that follows an error, even without signal words", () => {
    const middle = [
      "[tool] tests failed: 3 of 40",
      "[user] please check the fixtures directory",
      "[user] and the snapshot files",
    ].join("\n");
    const picked = scanTruncatedMiddle(middle, 8_000);
    expect(picked).toEqual(["[tool] tests failed: 3 of 40", "[user] please check the fixtures directory"]);
  });

  it("tracks the speaker across continuation lines of a multi-line user turn", () => {
    const middle = ["[user] one more thing:", "don't touch the migrations folder"].join("\n");
    expect(scanTruncatedMiddle(middle, 8_000)).toEqual(["don't touch the migrations folder"]);
    // The same soft wording from the agent is not a signal.
    const agent = ["[assistant] plan:", "don't touch the migrations folder"].join("\n");
    expect(scanTruncatedMiddle(agent, 8_000)).toEqual([]);
  });

  it("keeps a repeated error line once and clips very long lines", () => {
    const long = `[tool] error: ${"x".repeat(1000)}`;
    const middle = ["[tool] error: E0308 mismatched types", "[tool] error: E0308 mismatched types", long].join("\n");
    const picked = scanTruncatedMiddle(middle, 8_000);
    expect(picked.filter((l) => l.includes("E0308"))).toHaveLength(1);
    const clipped = picked.find((l) => l.startsWith("[tool] error: xxx"));
    expect(clipped?.length).toBe(300);
  });
});

describe("utils.scanTruncatedMiddle transcript formats (review of 30a148f)", () => {
  // `cm reflect` feeds the diary `cass export --format text` output on a
  // session's first pass (`=== USER ===` on its own line), and `cm diary`
  // feeds `--format markdown` output (`## 👤 User`). Both must be read as
  // turn starts, or user corrections never rank first.
  it("reads cass text-export turn headers", () => {
    const middle = [
      "=== ASSISTANT ===",
      "",
      "Running the suite.",
      "error: 3 tests failed",
      "",
      "=== USER ===",
      "",
      "please check the fixtures directory",
      "and don't touch the migrations folder",
      "",
      "=== ASSISTANT ===",
      "",
      "Plan: don't touch anything else.",
    ].join("\n");
    expect(scanTruncatedMiddle(middle, 8_000)).toEqual([
      "error: 3 tests failed",
      "please check the fixtures directory",
      "and don't touch the migrations folder",
    ]);
  });

  it("reads cass markdown-export turn headers", () => {
    const middle = [
      "## 🤖 Assistant",
      "",
      "Build failed with exit code 2",
      "",
      "## 👤 User",
      "",
      "use the v2 importer instead",
      "",
      "## 🤖 Assistant",
      "",
      "Sure, instead of v1 I will use v2.",
    ].join("\n");
    expect(scanTruncatedMiddle(middle, 8_000)).toEqual([
      "Build failed with exit code 2",
      "use the v2 importer instead",
    ]);
  });

  it("does not treat a markdown heading inside a user turn as a new speaker", () => {
    const middle = ["[user] here is my plan", "## Notes", "don't rename the table"].join("\n");
    expect(scanTruncatedMiddle(middle, 8_000)).toEqual(["don't rename the table"]);
  });
});
