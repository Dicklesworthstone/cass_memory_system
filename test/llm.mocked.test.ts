import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTestConfig, createTestDiary } from "./helpers/factories.js";
import { extractDiary, runReflector, runValidator } from "../src/llm.js";
import type { LLMIO } from "../src/llm.js";

describe("LLM flows with injected generateObject", () => {
  it("extractDiary returns structured diary using session metadata in the prompt", async () => {
    let lastOptions: any = null;
    const io: LLMIO = {
      generateObject: async <T>(options: any) => {
      lastOptions = options;
      return {
        object: {
          status: "success",
          accomplishments: ["wrote tests"],
          decisions: ["used injected provider"],
          challenges: ["llm offline"],
          preferences: [],
          keyLearnings: ["mocking keeps tests local"],
          tags: ["testing"],
          searchAnchors: ["mocked ai"]
        } as T
      };
      }
    };

    const schema = z.object({
      status: z.string(),
      accomplishments: z.array(z.string()),
      decisions: z.array(z.string()),
      challenges: z.array(z.string()),
      preferences: z.array(z.string()),
      keyLearnings: z.array(z.string()),
      tags: z.array(z.string()),
      searchAnchors: z.array(z.string())
    });

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await extractDiary(
      schema,
      "session content body",
      { sessionPath: "/tmp/s1.jsonl", agent: "agent-1", workspace: "ws-1" },
      config,
      io
    );

    expect(result.status).toBe("success");
    expect(lastOptions).toBeTruthy();
    const prompt = (lastOptions?.prompt ?? "") as string;
    expect(prompt).toContain("/tmp/s1.jsonl");
    expect(prompt).toContain("agent-1");
    expect(prompt).toContain("ws-1");
    expect(prompt).toContain("session content body");
  });

  it("runReflector generates deltas and includes diary/context details in the prompt", async () => {
    let lastOptions: any = null;
    const io: LLMIO = {
      generateObject: async <T>(options: any) => {
      lastOptions = options;
      return {
        object: {
          deltas: [
            {
              type: "add",
              bullet: { content: "Prefer bun test for fast runs", category: "testing" },
              reason: "keeps feedback tight",
              sourceSession: "/tmp/s1.jsonl"
            }
          ]
        } as T
      };
      }
    };

    const diary = createTestDiary({
      sessionPath: "/tmp/s1.jsonl",
      agent: "cursor",
      workspace: "/workspace",
      status: "success",
      accomplishments: ["added integration tests"],
      decisions: ["mocked ai sdk"],
      challenges: ["llm unavailable"],
      keyLearnings: ["mock before import to intercept ai"]
    });

    const schema = z.object({
      deltas: z.array(
        z.object({
          type: z.literal("add"),
          bullet: z.object({ content: z.string(), category: z.string() }),
          reason: z.string(),
          sourceSession: z.string().optional()
        })
      )
    });

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await runReflector(
      schema,
      diary,
      "Existing bullets summary",
      "cass history notes",
      1,
      config,
      io
    );

    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0].bullet.content).toBe("Prefer bun test for fast runs");

    expect(lastOptions).toBeTruthy();
    const prompt = (lastOptions?.prompt ?? "") as string;
    expect(prompt).toContain("Existing bullets summary");
    expect(prompt).toContain("cass history notes");
    expect(prompt).toContain("iteration 2"); // 0-based iteration argument
    expect(prompt).toContain("added integration tests");
    expect(prompt).toContain("mocked ai sdk");
  });

  it("runValidator maps evidence and uses proposed rule/evidence in the prompt", async () => {
    let lastOptions: any = null;
    const io: LLMIO = {
      generateObject: async <T>(options: any) => {
      lastOptions = options;
      return {
        object: {
          verdict: "ACCEPT",
          confidence: 0.92,
          reason: "supported by history",
          evidence: {
            supporting: ["session a evidence"],
            contradicting: ["session b counterpoint"]
          },
          suggestedRefinement: null
        } as T
      };
      }
    };

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await runValidator(
      "Use transactions for writes",
      "Session: /tmp/s2\nSnippet: committed changes\n---",
      config,
      io
    );

    expect(result.valid).toBe(true);
    expect(result.verdict).toBe("ACCEPT");
    expect(result.evidence).toEqual([
      { sessionPath: "unknown", snippet: "session a evidence", supports: true },
      { sessionPath: "unknown", snippet: "session b counterpoint", supports: false }
    ]);

    expect(lastOptions).toBeTruthy();
    const prompt = (lastOptions?.prompt ?? "") as string;
    expect(prompt).toContain("Use transactions for writes");
    expect(prompt).toContain("Session: /tmp/s2");
  });
});
