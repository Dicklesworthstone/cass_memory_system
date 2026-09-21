/**
 * Pipeline integration tests: diary -> reflect -> curate
 *
 * These tests use LLMIO injection to mock LLM responses without env vars.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { curatePlaybook } from "../src/curate.js";
import { reflectOnSession } from "../src/reflect.js";
import { DiaryEntrySchema } from "../src/types.js";
import {
  createTestBullet,
  createTestConfig,
  createTestFeedbackEvent,
  createTestPlaybook,
} from "./helpers/factories.js";
import { withLlmShim } from "./helpers/llm-shim.js";

const diaryFixturePath = path.join(process.cwd(), "test/fixtures/diary-success.json");

describe("Pipeline integration: diary -> reflect -> curate (stubbed LLM)", () => {
  test.serial("applies unique add deltas into playbook", async () => {
    const diaryRaw = JSON.parse(fs.readFileSync(diaryFixturePath, "utf-8"));
    const diary = DiaryEntrySchema.parse(diaryRaw);
    const playbook = createTestPlaybook();
    const config = createTestConfig({ maxReflectorIterations: 3 });

    // Set up sequential responses for multi-iteration reflection
    let callCount = 0;
    const responses = [
      {
        deltas: [
          {
            type: "add" as const,
            bullet: { content: "Rule A", category: "testing" },
            reason: "iter1",
            sourceSession: diary.sessionPath,
          },
        ],
      },
      {
        deltas: [
          {
            type: "add" as const,
            bullet: { content: "Rule B", category: "testing" },
            reason: "iter2",
            sourceSession: diary.sessionPath,
          },
        ],
      },
      {
        deltas: [
          {
            type: "add" as const,
            bullet: { content: "Rule A", category: "testing" },
            reason: "dup",
            sourceSession: diary.sessionPath,
          },
        ],
      },
    ];

    await withLlmShim(
      {
        reflector: () => responses[callCount++] || { deltas: [] },
      },
      async (io) => {
        const reflectionResult = await reflectOnSession(diary, playbook, config, io);
        const deltas = reflectionResult.deltas;
        const curation = curatePlaybook(playbook, deltas, config);

        expect(deltas).toHaveLength(2);
        expect(curation.applied).toBeGreaterThanOrEqual(1);
        expect(curation.playbook.bullets.length).toBeGreaterThanOrEqual(1);
        const contents = curation.playbook.bullets.map((b) => b.content);
        expect(contents).toContain("Rule A");
      },
    );
  });

  test.serial("harmful deltas trigger inversion to anti-pattern", async () => {
    const diaryRaw = JSON.parse(fs.readFileSync(diaryFixturePath, "utf-8"));
    const diary = DiaryEntrySchema.parse(diaryRaw);

    const existingBullet = createTestBullet({
      id: "b-invert",
      content: "Always deploy without checks",
      category: "testing",
      harmfulCount: 3,
      feedbackEvents: [
        createTestFeedbackEvent("harmful", 0),
        createTestFeedbackEvent("harmful", 0),
        createTestFeedbackEvent("harmful", 0),
      ],
    });

    const playbook = createTestPlaybook([existingBullet]);
    const baseConfig = createTestConfig();
    const config = createTestConfig({
      maxReflectorIterations: 2,
      scoring: { ...baseConfig.scoring, decayHalfLifeDays: 1000 },
    });

    // Set up sequential responses for multi-iteration reflection
    let callCount = 0;
    const responses = [
      {
        deltas: [
          {
            type: "harmful" as const,
            bulletId: "b-invert",
            reason: "caused_bug" as const,
            sourceSession: diary.sessionPath,
          },
        ],
      },
      { deltas: [] },
    ];

    await withLlmShim(
      {
        reflector: () => responses[callCount++] || { deltas: [] },
      },
      async (io) => {
        const reflectionResult = await reflectOnSession(diary, playbook, config, io);
        const deltas = reflectionResult.deltas;
        const curation = curatePlaybook(playbook, deltas, config);

        expect(deltas.length).toBe(1);
        expect(curation.applied).toBeGreaterThanOrEqual(1);

        const anti = curation.playbook.bullets.find(
          (b) => b.kind === "anti_pattern" || b.isNegative,
        );
        expect(anti).toBeTruthy();
        expect(anti?.content).toContain("AVOID");

        const original = curation.playbook.bullets.find((b) => b.id === "b-invert");
        expect(original?.deprecated).toBe(true);
      },
    );
  });
});
