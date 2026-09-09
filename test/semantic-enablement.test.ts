/**
 * Tri-state `semanticSearchEnabled` (#75).
 *
 * The flag has three states, and every command must go through
 * `resolveSemanticEnabled()` rather than reading it by truthiness:
 *   - `true`  -> semantic search always attempted (pre-#75 behaviour).
 *   - `false` -> keyword-only, even on a machine that could embed.
 *   - unset   -> automatic: on exactly when the configured backend can embed
 *               offline (local model already cached, or a reachable Ollama
 *               daemon that has the model pulled).
 *
 * Everything here is hermetic: the local-backend cases substitute the
 * readiness probe (no ~23 MB model download), and the Ollama cases talk to a
 * real Bun.serve stub on localhost.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";
import {
  resolveSemanticEnabled,
  resetSemanticResolutionCache,
  semanticReadinessProbes,
  type SemanticConfigInput,
} from "../src/semantic.js";
import {
  scoreBulletsEnhanced,
  generateContextResult,
  contextCommand,
  type ScoreBulletsMeta,
} from "../src/commands/context.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestConfig, createTestBullet, createTestPlaybook } from "./helpers/factories.js";

const realXenovaProbe = semanticReadinessProbes.xenova;
const realOllamaProbe = semanticReadinessProbes.ollama;

/**
 * Replace the local-backend readiness probe for one test and count its calls,
 * so we can assert both the answer and that an *explicit* flag never consults
 * it at all.
 */
function stubXenovaProbe(cached: boolean): { calls: () => number } {
  let calls = 0;
  semanticReadinessProbes.xenova = async () => {
    calls++;
    return cached;
  };
  resetSemanticResolutionCache();
  return { calls: () => calls };
}

afterEach(() => {
  semanticReadinessProbes.xenova = realXenovaProbe;
  semanticReadinessProbes.ollama = realOllamaProbe;
  resetSemanticResolutionCache();
});

/**
 * Two bullets with equal keyword pull but opposite embeddings, plus a query
 * embedding aligned with the first. Ranking therefore proves whether the
 * semantic term was actually applied — a keyword-only run leaves the original
 * order (and gives both bullets the same relevance score).
 */
function semanticFixture() {
  const query = [1, 0, 0];
  const bullets = [
    { ...createTestBullet({ id: "b-far", content: "alpha topic", tags: ["alpha"] }), embedding: [0, 1, 0] },
    { ...createTestBullet({ id: "b-near", content: "alpha topic", tags: ["alpha"] }), embedding: [1, 0, 0] },
  ];
  return { query, bullets };
}

describe("resolveSemanticEnabled: tri-state posture (#75)", () => {
  test("cached model + no explicit setting -> automatic on", async () => {
    const probe = stubXenovaProbe(true);
    const status = await resolveSemanticEnabled(
      createTestConfig({ semanticSearchEnabled: undefined })
    );

    expect(status.enabled).toBe(true);
    expect(status.available).toBe(true);
    expect(status.posture).toBe("auto-on");
    expect(status.enableHint).toBeUndefined();
    expect(probe.calls()).toBe(1);
  });

  test("uncached model + no explicit setting -> automatic off, with an actionable hint", async () => {
    stubXenovaProbe(false);
    const status = await resolveSemanticEnabled(
      createTestConfig({ semanticSearchEnabled: undefined })
    );

    expect(status.enabled).toBe(false);
    expect(status.posture).toBe("auto-off");
    expect(status.reason).toContain("cached");
    expect(status.enableHint).toContain("doctor --fix");
    expect(status.enableHint).toContain("~/.cass-memory/config.json");
  });

  test("explicit false wins over a cached model, and never runs the probe", async () => {
    const probe = stubXenovaProbe(true);
    const status = await resolveSemanticEnabled(createTestConfig({ semanticSearchEnabled: false }));

    expect(status.enabled).toBe(false);
    expect(status.posture).toBe("explicit-off");
    expect(probe.calls()).toBe(0);
  });

  test("explicit true wins over an uncached model, and never runs the probe", async () => {
    const probe = stubXenovaProbe(false);
    const status = await resolveSemanticEnabled(createTestConfig({ semanticSearchEnabled: true }));

    expect(status.enabled).toBe(true);
    expect(status.posture).toBe("explicit-on");
    expect(probe.calls()).toBe(0);
  });

  test("embeddingModel: none opts out regardless of the flag", async () => {
    const probe = stubXenovaProbe(true);
    for (const flag of [undefined, true, false] as const) {
      const status = await resolveSemanticEnabled(
        createTestConfig({ semanticSearchEnabled: flag, embeddingModel: "none" })
      );
      expect(status.enabled).toBe(false);
      expect(status.posture).toBe("model-none");
    }
    expect(probe.calls()).toBe(0);
  });

  test("the probe runs once per process, and again when the config it depends on changes", async () => {
    const probe = stubXenovaProbe(true);
    const config: SemanticConfigInput = { semanticSearchEnabled: undefined };

    await resolveSemanticEnabled(config);
    await resolveSemanticEnabled(config);
    expect(probe.calls()).toBe(1);

    // Concurrent callers share the single in-flight probe rather than racing.
    resetSemanticResolutionCache();
    await Promise.all([resolveSemanticEnabled(config), resolveSemanticEnabled(config)]);
    expect(probe.calls()).toBe(2);

    // A different embedding model is a different question.
    await resolveSemanticEnabled({ ...config, embeddingModel: "Xenova/other-model" });
    expect(probe.calls()).toBe(3);
  });

  test("a 'not ready' answer expires, so a long-lived process picks the backend up later", async () => {
    const probe = stubXenovaProbe(false);
    const config: SemanticConfigInput = { semanticSearchEnabled: undefined };

    expect((await resolveSemanticEnabled(config)).enabled).toBe(false);
    expect((await resolveSemanticEnabled(config)).enabled).toBe(false);
    expect(probe.calls()).toBe(1);

    // Jump past the not-ready TTL (60s) without sleeping for it.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      semanticReadinessProbes.xenova = async () => true;
      const status = await resolveSemanticEnabled(config);
      expect(status.enabled).toBe(true);
      expect(status.posture).toBe("auto-on");
    } finally {
      Date.now = realNow;
    }
  });

  test("a throwing probe degrades to keyword-only instead of failing the command", async () => {
    semanticReadinessProbes.xenova = async () => {
      throw new Error("cache directory unreadable");
    };
    resetSemanticResolutionCache();

    const status = await resolveSemanticEnabled(
      createTestConfig({ semanticSearchEnabled: undefined })
    );
    expect(status.enabled).toBe(false);
    expect(status.posture).toBe("auto-off");
  });
});

describe("resolveSemanticEnabled: Ollama auto-on (#75)", () => {
  /** Stand up a throwaway daemon that answers /api/tags with `models`. */
  async function withTagServer<T>(
    handler: (url: URL) => Response | undefined,
    fn: (baseUrl: string) => Promise<T>
  ): Promise<T> {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => handler(new URL(req.url)) ?? new Response("not found", { status: 404 }),
    });
    try {
      return await fn(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  const tags = (names: string[]) => (url: URL) =>
    url.pathname === "/api/tags"
      ? Response.json({ models: names.map((name) => ({ name, model: name })) })
      : undefined;

  test("turns on when the daemon answers and has the model pulled", async () => {
    await withTagServer(tags(["all-minilm:latest"]), async (baseUrl) => {
      resetSemanticResolutionCache();
      const status = await resolveSemanticEnabled(
        createTestConfig({
          semanticSearchEnabled: undefined,
          embeddingBackend: "ollama",
          // The default Xenova model name maps onto Ollama's official tag.
          embeddingModel: "Xenova/all-MiniLM-L6-v2",
          ollamaBaseUrl: `${baseUrl}/`,
        })
      );

      expect(status.enabled).toBe(true);
      expect(status.posture).toBe("auto-on");
      expect(status.model).toBe("ollama:all-minilm");
      expect(status.reason).toContain("Ollama");
    });
  });

  test("stays off when the daemon answers but the model is not pulled", async () => {
    await withTagServer(tags(["llama3:latest"]), async (baseUrl) => {
      resetSemanticResolutionCache();
      const status = await resolveSemanticEnabled(
        createTestConfig({
          semanticSearchEnabled: undefined,
          embeddingBackend: "ollama",
          ollamaBaseUrl: baseUrl,
        })
      );

      expect(status.enabled).toBe(false);
      expect(status.posture).toBe("auto-off");
      expect(status.enableHint).toContain("ollama pull all-minilm");
    });
  });

  test("stays off when nothing is listening", async () => {
    resetSemanticResolutionCache();
    const status = await resolveSemanticEnabled(
      createTestConfig({
        semanticSearchEnabled: undefined,
        embeddingBackend: "ollama",
        // Port 1 is reserved and never bound; the probe must fail closed.
        ollamaBaseUrl: "http://127.0.0.1:1",
      })
    );

    expect(status.enabled).toBe(false);
    expect(status.posture).toBe("auto-off");
  });
});

describe("scoreBulletsEnhanced honours the resolved posture (#75)", () => {
  test("cached model + no explicit setting -> the semantic path runs", async () => {
    stubXenovaProbe(true);
    const { query, bullets } = semanticFixture();
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };

    const scored = await scoreBulletsEnhanced(
      bullets,
      "alpha topic",
      ["alpha"],
      createTestConfig({ semanticSearchEnabled: undefined }),
      { queryEmbedding: query, skipEmbeddingLoad: true, meta }
    );

    expect(meta.semanticMode).toBe("semantic");
    expect(meta.semanticError).toBeUndefined();
    expect(meta.semanticNotice).toBeUndefined();
    // The bullet whose embedding matches the query outranks its keyword twin.
    expect(scored[0].id).toBe("b-near");
    expect(scored[0].relevanceScore).toBeGreaterThan(scored[1].relevanceScore);
  });

  test("uncached model + no explicit setting -> keyword-only with a visible notice", async () => {
    stubXenovaProbe(false);
    const { query, bullets } = semanticFixture();
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };

    const scored = await scoreBulletsEnhanced(
      bullets,
      "alpha topic",
      ["alpha"],
      createTestConfig({ semanticSearchEnabled: undefined }),
      { queryEmbedding: query, skipEmbeddingLoad: true, meta }
    );

    expect(meta.semanticMode).toBe("keyword");
    // Nobody asked for semantic search, so this is a notice, not an error.
    expect(meta.semanticError).toBeUndefined();
    expect(meta.semanticNotice).toBeDefined();
    expect(meta.semanticNotice).toContain("doctor --fix");
    // Keyword-only: the embeddings were ignored, so the twins tie.
    expect(scored[0].relevanceScore).toBe(scored[1].relevanceScore);
  });

  test("explicit false -> keyword-only even when the model is cached", async () => {
    stubXenovaProbe(true);
    const { query, bullets } = semanticFixture();
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };

    const scored = await scoreBulletsEnhanced(
      bullets,
      "alpha topic",
      ["alpha"],
      createTestConfig({ semanticSearchEnabled: false }),
      { queryEmbedding: query, skipEmbeddingLoad: true, meta }
    );

    expect(meta.semanticMode).toBe("keyword");
    expect(meta.semanticError).toBeUndefined();
    // An explicit opt-out is a decision, not a gap: no nag.
    expect(meta.semanticNotice).toBeUndefined();
    expect(scored[0].relevanceScore).toBe(scored[1].relevanceScore);
  });

  test("explicit true + uncached -> unchanged: still attempts semantic", async () => {
    stubXenovaProbe(false);
    const { query, bullets } = semanticFixture();
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };

    const scored = await scoreBulletsEnhanced(
      bullets,
      "alpha topic",
      ["alpha"],
      createTestConfig({ semanticSearchEnabled: true }),
      { queryEmbedding: query, skipEmbeddingLoad: true, meta }
    );

    expect(meta.semanticMode).toBe("semantic");
    expect(meta.semanticNotice).toBeUndefined();
    expect(scored[0].id).toBe("b-near");
  });

  test("explicit true + a backend that cannot embed -> the loud semanticError, unchanged", async () => {
    stubXenovaProbe(false);
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };
    const bullets = [createTestBullet({ id: "b-1", content: "alpha topic", tags: ["alpha"] })];

    // The fallback warning on stderr is part of the contract here (silent
    // fallback once hid a release-long regression), so it is left in place.
    await scoreBulletsEnhanced(
      bullets,
      "alpha topic",
      ["alpha"],
      createTestConfig({
        semanticSearchEnabled: true,
        embeddingModel: "invalid-nonexistent-model",
      }),
      { meta }
    );

    expect(meta.semanticMode).toBe("keyword");
    expect(meta.semanticError).toBeDefined();
    // semanticError and semanticNotice are mutually exclusive.
    expect(meta.semanticNotice).toBeUndefined();
  });
});

describe("cm context surfaces the automatic posture (#75)", () => {
  test("keyword-only fallback reaches the structured result as semanticNotice", async () => {
    stubXenovaProbe(false);
    await withTempCassHome(async (env) => {
      writeFileSync(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ id: "b-1", content: "alpha topic", tags: ["alpha"], state: "active" }),
          ])
        )
      );

      const { result } = await generateContextResult("alpha topic", { json: true });

      expect(result.semanticMode).toBe("keyword");
      expect(result.semanticError).toBeUndefined();
      expect(result.semanticNotice).toBeDefined();
      expect(result.semanticNotice).toContain("doctor --fix");
    });
  });

  test("the notice survives into `cm context --json`, where agents can read it", async () => {
    stubXenovaProbe(false);
    await withTempCassHome(async (env) => {
      writeFileSync(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ id: "b-1", content: "alpha topic", tags: ["alpha"], state: "active" }),
          ])
        )
      );

      // Structured output is routed through console.log by test/setup.ts.
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      let envelope: any;
      try {
        await contextCommand("alpha topic", { json: true });
        envelope = JSON.parse(lines.join("\n"));
      } finally {
        console.log = originalLog;
      }

      expect(envelope.success).toBe(true);
      expect(envelope.data.semanticMode).toBe("keyword");
      expect(envelope.data.semanticNotice).toContain("doctor --fix");
      expect(envelope.data.semanticError).toBeUndefined();
    });
  });

  test("an explicit opt-out produces no notice at all", async () => {
    stubXenovaProbe(false);
    await withTempCassHome(async (env) => {
      writeFileSync(env.configPath, JSON.stringify({ semanticSearchEnabled: false }));
      writeFileSync(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ id: "b-1", content: "alpha topic", tags: ["alpha"], state: "active" }),
          ])
        )
      );

      const { result } = await generateContextResult("alpha topic", { json: true });

      expect(result.semanticMode).toBe("keyword");
      expect(result.semanticNotice).toBeUndefined();
      expect(result.semanticError).toBeUndefined();
    });
  });
});
