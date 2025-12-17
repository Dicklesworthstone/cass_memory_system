import { describe, it, expect } from "bun:test";
import { findDiaryBySession } from "../src/diary.js";
import { generateDiaryId } from "../src/utils.js";
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
