import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { findDiaryBySession, loadAllDiaries, loadDiary } from "../src/diary.js";
import type { DiaryEntry } from "../src/types.js";
import { withTempDir } from "./helpers/index.js";

const makeDiary = (overrides: Partial<DiaryEntry>): DiaryEntry => ({
  id: overrides.id ?? "d-1",
  sessionPath: overrides.sessionPath ?? "/sessions/s1.jsonl",
  timestamp: overrides.timestamp ?? new Date().toISOString(),
  agent: overrides.agent ?? "cursor",
  workspace: overrides.workspace,
  status: overrides.status ?? "success",
  accomplishments: overrides.accomplishments ?? [],
  decisions: overrides.decisions ?? [],
  challenges: overrides.challenges ?? [],
  preferences: overrides.preferences ?? [],
  keyLearnings: overrides.keyLearnings ?? [],
  relatedSessions: overrides.relatedSessions ?? [],
  tags: overrides.tags ?? [],
  searchAnchors: overrides.searchAnchors ?? [],
});

describe("diary loading", () => {
  test("loadAllDiaries returns [] when directory missing", async () => {
    const result = await loadAllDiaries("/tmp/non-existent-diaries-xyz");
    expect(result).toEqual([]);
  });

  test("loadAllDiaries sorts by timestamp desc and skips invalid files", async () => {
    await withTempDir("diary-load", async (tmp) => {
      const dir = path.join(tmp, "diary");
      await mkdir(dir, { recursive: true });

      const newer = makeDiary({
        id: "newer",
        timestamp: new Date("2025-12-08T10:00:00Z").toISOString(),
      });
      const older = makeDiary({
        id: "older",
        timestamp: new Date("2025-12-07T10:00:00Z").toISOString(),
      });

      await writeFile(path.join(dir, "newer.json"), JSON.stringify(newer, null, 2));
      await writeFile(path.join(dir, "older.json"), JSON.stringify(older, null, 2));
      // invalid file should be skipped
      await writeFile(path.join(dir, "bad.json"), "{ not: valid");

      const result = await loadAllDiaries(dir);
      expect(result.map((d) => d.id)).toEqual(["newer", "older"]);
    });
  });

  test("loadDiary loads by id (without .json) and returns null on bad JSON", async () => {
    await withTempDir("diary-load-single", async (tmp) => {
      const cfg = { ...DEFAULT_CONFIG, diaryDir: tmp };
      const entry = makeDiary({ id: "single" });
      await writeFile(path.join(tmp, "single.json"), JSON.stringify(entry, null, 2));
      await writeFile(path.join(tmp, "broken.json"), "{ nope");

      const loaded = await loadDiary("single", cfg);
      expect(loaded?.id).toBe("single");

      const broken = await loadDiary("broken", cfg);
      expect(broken).toBeNull();
    });
  });

  test("findDiaryBySession matches by absolute path resolution", async () => {
    await withTempDir("diary-find", async (tmp) => {
      const cfg = { ...DEFAULT_CONFIG, diaryDir: tmp };
      const sessionPath = path.join(tmp, "sessions", "s1.jsonl");
      const entry = makeDiary({ id: "findme", sessionPath });
      await writeFile(path.join(tmp, "findme.json"), JSON.stringify(entry, null, 2));

      const found = await findDiaryBySession(sessionPath, cfg.diaryDir);
      expect(found?.id).toBe("findme");

      const notFound = await findDiaryBySession("/other/path.jsonl", cfg.diaryDir);
      expect(notFound).toBeNull();
    });
  });
});
