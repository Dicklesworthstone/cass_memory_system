import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { reflectOnSession } from "../src/reflect.js";
import { createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { DiaryEntrySchema } from "../src/types.js";
import { __resetReflectorStubsForTest } from "../src/llm.js";

const fixturePath = path.join(process.cwd(), "test/fixtures/diary-success.json");

describe("Reflector pipeline (integration, stubbed LLM)", () => {
  beforeEach(() => {
    __resetReflectorStubsForTest();
  });

  afterEach(() => {
    delete process.env.CM_REFLECTOR_STUBS;
    __resetReflectorStubsForTest();
  });

  test("diary -> reflector iterations -> deduped deltas", async () => {
    const diaryRaw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    const diary = DiaryEntrySchema.parse(diaryRaw);
    const playbook = createTestPlaybook();
    const config = createTestConfig({ maxReflectorIterations: 3 });

    const stub = [
      {
        deltas: [
          {
            type: "add",
            bullet: { content: "Rule A", category: "testing" },
            reason: "iteration one",
            sourceSession: diary.sessionPath
          }
        ]
      },
      {
        deltas: [
          {
            type: "add",
            bullet: { content: "Rule B", category: "testing" },
            reason: "iteration two",
            sourceSession: diary.sessionPath
          }
        ]
      },
      {
        deltas: [
          {
            type: "add",
            bullet: { content: "Rule A", category: "testing" },
            reason: "duplicate",
            sourceSession: diary.sessionPath
          }
        ]
      }
    ];

    process.env.CM_REFLECTOR_STUBS = JSON.stringify(stub);

    const result = await reflectOnSession(diary, playbook, config);
    const deltas = result.deltas;

    expect(deltas).toHaveLength(2);
    const addDeltas = deltas.filter((d): d is Extract<typeof deltas[number], { type: "add" }> => d.type === "add");
    expect(addDeltas[0].bullet.content).toBe("Rule A");
    expect(addDeltas[1].bullet.content).toBe("Rule B");
  });
});
