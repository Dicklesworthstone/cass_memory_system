import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { withBudgetAdmission } from "../src/cost.js";
import type { LLMIO } from "../src/llm.js";
import { extractDiary, runReflector, runValidator } from "../src/llm.js";
import { createTestConfig, createTestDiary } from "./helpers/factories.js";
import { cleanupEnvironment, createIsolatedEnvironment, type TestEnv } from "./helpers/temp.js";

let environment: TestEnv;
let previousMemoryHome: string | undefined;
beforeEach(async () => {
  environment = await createIsolatedEnvironment("llm-mocked");
  previousMemoryHome = process.env.CASS_MEMORY_HOME;
  process.env.CASS_MEMORY_HOME = environment.cassMemoryDir;
});
afterEach(async () => {
  if (previousMemoryHome === undefined) delete process.env.CASS_MEMORY_HOME;
  else process.env.CASS_MEMORY_HOME = previousMemoryHome;
  await cleanupEnvironment(environment);
});

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
            searchAnchors: ["mocked ai"],
          } as T,
        };
      },
    };

    const schema = z.object({
      status: z.string(),
      accomplishments: z.array(z.string()),
      decisions: z.array(z.string()),
      challenges: z.array(z.string()),
      preferences: z.array(z.string()),
      keyLearnings: z.array(z.string()),
      tags: z.array(z.string()),
      searchAnchors: z.array(z.string()),
    });

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await extractDiary(
      schema,
      "session content body",
      { sessionPath: "/tmp/s1.jsonl", agent: "agent-1", workspace: "ws-1" },
      config,
      io,
    );

    expect(result.status).toBe("success");
    expect(lastOptions).toBeTruthy();
    const prompt = (lastOptions?.prompt ?? "") as string;
    expect(prompt).toContain("/tmp/s1.jsonl");
    expect(prompt).toContain("agent-1");
    expect(prompt).toContain("ws-1");
    expect(prompt).toContain("session content body");
  });

  it("extractDiary sizes the session window from config and keeps middle error lines (#88)", async () => {
    const prompts: string[] = [];
    const io: LLMIO = {
      generateObject: async <T>(options: any) => {
        prompts.push(options.prompt as string);
        return { object: { status: "mixed" } as T };
      },
    };
    const schema = z.object({ status: z.string() });
    const prose = (tag: string) =>
      Array.from({ length: 1500 }, (_, i) => `[assistant] ${tag} step ${i}: reading files and taking notes.`).join("\n");
    const session = [
      "[user] START-OF-SESSION",
      prose("early"),
      "[tool] error: MIDDLE-ERROR relation \"users\" does not exist",
      prose("late"),
      "[assistant] END-OF-SESSION",
    ].join("\n");
    expect(session.length).toBeGreaterThan(150_000);
    const meta = { sessionPath: "/tmp/long.jsonl", agent: "claude" };

    await extractDiary(schema, session, meta, createTestConfig({ apiKey: "sk-ant-test-0000000000000000" }), io);
    await extractDiary(
      schema,
      session,
      meta,
      createTestConfig({ apiKey: "sk-ant-test-0000000000000000", diaryMaxInputChars: 400_000 }),
      io,
    );
    await extractDiary(
      schema,
      session,
      meta,
      createTestConfig({ apiKey: "sk-ant-test-0000000000000000", diaryMiddleScanChars: 0 }),
      io,
    );

    const [byDefault, wide, noScan] = prompts;
    for (const p of prompts) {
      expect(p).toContain("START-OF-SESSION");
      expect(p).toContain("END-OF-SESSION");
    }
    // Default 50k window: the middle is cut, but its error line is scanned in.
    expect(byDefault.length).toBeLessThan(65_000);
    expect(byDefault).toContain("MIDDLE-ERROR");
    expect(byDefault).toContain("excerpts from that part");
    // A window larger than the session sends it whole.
    expect(wide).toContain(session);
    // Scan disabled: plain head/tail.
    expect(noScan).not.toContain("MIDDLE-ERROR");
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
                sourceSession: "/tmp/s1.jsonl",
              },
            ],
          } as T,
        };
      },
    };

    const diary = createTestDiary({
      sessionPath: "/tmp/s1.jsonl",
      agent: "cursor",
      workspace: "/workspace",
      status: "success",
      accomplishments: ["added integration tests"],
      decisions: ["mocked ai sdk"],
      challenges: ["llm unavailable"],
      keyLearnings: ["mock before import to intercept ai"],
    });

    const schema = z.object({
      deltas: z.array(
        z.object({
          type: z.literal("add"),
          bullet: z.object({ content: z.string(), category: z.string() }),
          reason: z.string(),
          sourceSession: z.string().optional(),
        }),
      ),
    });

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await runReflector(
      schema,
      diary,
      "Existing bullets summary",
      "cass history notes",
      1,
      config,
      io,
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

  it("runReflector lists earlier passes' rules so later passes do not reword them (#96)", async () => {
    const prompts: string[] = [];
    const io: LLMIO = {
      generateObject: async <T>(options: any) => {
        prompts.push(options.prompt ?? "");
        return { object: { deltas: [] } as T };
      },
    };
    const schema = z.object({ deltas: z.array(z.object({ type: z.string() })) });
    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });
    const earlier = [
      "Before running pt agent diff, verify that both selected sessions contain plan.json",
      "   ",
      "Close a finished bead only after its gated push lands",
    ];

    await runReflector(schema, createTestDiary(), "bullets", "history", 0, config, io, earlier);
    await runReflector(schema, createTestDiary(), "bullets", "history", 1, config, io, earlier);
    await runReflector(schema, createTestDiary(), "bullets", "history", 1, config, io, []);

    const [first, later, laterWithoutEarlier] = prompts;
    expect(first).not.toContain("<earlier_passes>");
    expect(first).not.toContain(earlier[0]);
    expect(later).toContain("iteration 2");
    expect(later).toContain("Do not propose them again, reworded or not");
    expect(later).toContain(`<earlier_passes>\n- ${earlier[0]}\n- ${earlier[2]}\n</earlier_passes>`);
    expect(laterWithoutEarlier).toContain("Focus on insights you may have missed in previous passes.");
    expect(laterWithoutEarlier).not.toContain("<earlier_passes>");
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
              contradicting: ["session b counterpoint"],
            },
            suggestedRefinement: null,
          } as T,
        };
      },
    };

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });

    const result = await runValidator(
      "Use transactions for writes",
      "Session: /tmp/s2\nSnippet: committed changes\n---",
      config,
      io,
    );

    expect(result.valid).toBe(true);
    expect(result.verdict).toBe("ACCEPT");
    expect(result.evidence).toEqual([
      { sessionPath: "unknown", snippet: "session a evidence", supports: true },
      { sessionPath: "unknown", snippet: "session b counterpoint", supports: false },
    ]);

    expect(lastOptions).toBeTruthy();
    const prompt = (lastOptions?.prompt ?? "") as string;
    expect(prompt).toContain("Use transactions for writes");
    expect(prompt).toContain("Session: /tmp/s2");
  });
});

describe("runReflector honors configured LLM timeouts (#78)", () => {
  it("times out after config.llmTimeoutMs instead of the 30s default", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const io: LLMIO = {
      generateObject: async <T>() => {
        await hold; // Deliberately outlives the caller's deadline.
        return { object: { deltas: [] } as T };
      },
    };
    const config = createTestConfig({
      apiKey: "sk-ant-test-0000000000000000",
      llmTimeoutMs: 20,
      llmTotalTimeoutMs: 5000,
    });
    const schema = z.object({ deltas: z.array(z.object({ type: z.string() })) });
    const started = Date.now();
    try {
      await expect(
        runReflector(schema, createTestDiary(), "bullets", "history", 0, config, io),
      ).rejects.toThrow(/runReflector timed out after 20ms/);
      expect(Date.now() - started).toBeLessThan(20000);
    } finally {
      // Caller timeout must not discard an in-flight provider's guard. Settle
      // the fake work and wait for its accounting before removing its home.
      release();
      await withBudgetAdmission(config, async () => undefined);
    }
  }, 25000);
});
