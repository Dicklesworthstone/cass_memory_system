/**
 * Tests for LLM shim helper
 *
 * Verifies that the LLM shim correctly intercepts and mocks LLM API calls
 * for offline testing.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import {
  withLlmShim,
  getLlmCallLog,
  createOfflineShim,
  createDiarySuccessShim,
  createReflectorAddDeltaShim,
  createValidatorRejectShim,
  createErrorShim,
  DEFAULT_DIARY_RESPONSE,
  DEFAULT_REFLECTOR_RESPONSE,
  DEFAULT_VALIDATOR_RESPONSE
} from "./helpers/llm-shim.js";

afterEach(() => {
  mock.restore();
});

describe("LLM Shim", () => {
  describe("Default Responses", () => {
    it("provides sensible default diary response", () => {
      expect(DEFAULT_DIARY_RESPONSE.status).toBe("success");
      expect(DEFAULT_DIARY_RESPONSE.accomplishments).toHaveLength(1);
      expect(DEFAULT_DIARY_RESPONSE.keyLearnings).toHaveLength(1);
    });

    it("provides sensible default reflector response", () => {
      expect(DEFAULT_REFLECTOR_RESPONSE.deltas).toEqual([]);
      expect(DEFAULT_REFLECTOR_RESPONSE.reasoning).toBeTruthy();
    });

    it("provides sensible default validator response", () => {
      expect(DEFAULT_VALIDATOR_RESPONSE.verdict).toBe("ACCEPT");
      expect(DEFAULT_VALIDATOR_RESPONSE.confidence).toBeGreaterThan(0);
    });
  });

  describe("withLlmShim", () => {
    it("mocks generateObject for diary extraction prompts", async () => {
      await withLlmShim(createDiarySuccessShim(["Built feature X"]), async () => {
        // Import after mock is applied
        const ai = await import("ai");

        const result = await ai.generateObject({
          prompt: "Extract diary from session accomplishments",
          schema: {} as any,
          model: {} as any
        });

        expect(result.object.status).toBe("success");
        expect(result.object.accomplishments).toContain("Built feature X");
      });
    });

    it("mocks generateObject for reflector prompts", async () => {
      await withLlmShim(
        createReflectorAddDeltaShim([
          { content: "Always use TypeScript", category: "typescript" }
        ]),
        async () => {
          const ai = await import("ai");

          const result = await ai.generateObject({
            prompt: "Reflect on playbook and generate deltas",
            schema: {} as any,
            model: {} as any
          });

          expect(result.object.deltas).toHaveLength(1);
          expect(result.object.deltas[0].type).toBe("add");
          expect(result.object.deltas[0].bullet.content).toBe("Always use TypeScript");
        }
      );
    });

    it("mocks generateObject for validator prompts", async () => {
      await withLlmShim(createValidatorRejectShim("Not enough evidence"), async () => {
        const ai = await import("ai");

        const result = await ai.generateObject({
          prompt: "Validate this rule with evidence",
          schema: {} as any,
          model: {} as any
        });

        expect(result.object.verdict).toBe("REJECT");
        expect(result.object.reasoning).toBe("Not enough evidence");
      });
    });

    it("simulates API errors when configured", async () => {
      await withLlmShim(createErrorShim("Rate limit exceeded"), async () => {
        const ai = await import("ai");

        await expect(
          ai.generateObject({
            prompt: "Any prompt",
            schema: {} as any,
            model: {} as any
          })
        ).rejects.toThrow("Rate limit exceeded");
      });
    });

    it("simulates delay when configured", async () => {
      const start = Date.now();

      await withLlmShim({ delay: 100, ...createOfflineShim() }, async () => {
        const ai = await import("ai");

        await ai.generateObject({
          prompt: "Extract diary",
          schema: {} as any,
          model: {} as any
        });
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
    });
  });

  describe("Call Tracking", () => {
    it("tracks calls when trackCalls is enabled", async () => {
      await withLlmShim({ ...createOfflineShim(), trackCalls: true }, async () => {
        const ai = await import("ai");

        await ai.generateObject({
          prompt: "Extract diary from session",
          schema: {} as any,
          model: {} as any
        });

        await ai.generateObject({
          prompt: "Reflect on playbook",
          schema: {} as any,
          model: {} as any
        });

        const log = getLlmCallLog();
        expect(log).not.toBeNull();
        expect(log!.extractDiary.length).toBe(1);
        expect(log!.reflector.length).toBe(1);
      });
    });

    it("does not track calls when trackCalls is disabled", async () => {
      await withLlmShim({ ...createOfflineShim(), trackCalls: false }, async () => {
        const ai = await import("ai");

        await ai.generateObject({
          prompt: "Extract diary",
          schema: {} as any,
          model: {} as any
        });

        const log = getLlmCallLog();
        expect(log).toBeNull();
      });
    });
  });

  describe("Convenience Helpers", () => {
    it("createOfflineShim provides complete offline config", () => {
      const config = createOfflineShim();

      expect(config.extractDiary).toBeDefined();
      expect(config.reflector).toBeDefined();
      expect(config.validator).toBeDefined();
      expect(config.trackCalls).toBe(true);
    });

    it("createDiarySuccessShim creates success config", () => {
      const config = createDiarySuccessShim(["Did task A"], ["Learned B"]);

      expect(config.extractDiary).toBeDefined();
      const diary = config.extractDiary as any;
      expect(diary.status).toBe("success");
      expect(diary.accomplishments).toContain("Did task A");
      expect(diary.keyLearnings).toContain("Learned B");
    });

    it("createReflectorAddDeltaShim creates add delta config", () => {
      const config = createReflectorAddDeltaShim([
        { content: "Rule 1", category: "cat1" },
        { content: "Rule 2" }
      ]);

      expect(config.reflector).toBeDefined();
      const reflector = config.reflector as any;
      expect(reflector.deltas).toHaveLength(2);
      expect(reflector.deltas[0].bullet.content).toBe("Rule 1");
      expect(reflector.deltas[0].bullet.category).toBe("cat1");
      expect(reflector.deltas[1].bullet.category).toBe("general"); // Default
    });
  });

  describe("Function Responses", () => {
    it("supports function-based extractDiary responses", async () => {
      let receivedContent = "";

      await withLlmShim({
        extractDiary: (content) => {
          receivedContent = content;
          return {
            status: "success",
            accomplishments: [`Processed: ${content.slice(0, 10)}`],
            decisions: [],
            challenges: [],
            preferences: [],
            keyLearnings: [],
            tags: [],
            searchAnchors: []
          };
        }
      }, async () => {
        const ai = await import("ai");

        const result = await ai.generateObject({
          prompt: "Extract diary from THIS_IS_TEST_CONTENT",
          schema: {} as any,
          model: {} as any
        });

        expect(receivedContent).toContain("THIS_IS_TEST_CONTENT");
        expect(result.object.accomplishments[0]).toContain("Processed:");
      });
    });
  });
});
