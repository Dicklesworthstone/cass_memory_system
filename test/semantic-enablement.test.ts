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
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";
import {
  contextCommand,
  generateContextResult,
  type ScoreBulletsMeta,
  scoreBulletsEnhanced,
  scoreBulletsKeyword,
} from "../src/commands/context.js";
import {
  resetSemanticResolutionCache,
  resolveSemanticEnabled,
  type SemanticConfigInput,
  semanticReadinessProbes,
  createEmptyEmbeddingCache,
  getEmbeddingBackend,
  loadEmbeddingCache,
  setEmbeddingBackend,
} from "../src/semantic.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome, withTempDir } from "./helpers/temp.js";

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
    {
      ...createTestBullet({ id: "b-far", content: "alpha topic", tags: ["alpha"] }),
      embedding: [0, 1, 0],
    },
    {
      ...createTestBullet({ id: "b-near", content: "alpha topic", tags: ["alpha"] }),
      embedding: [1, 0, 0],
    },
  ];
  return { query, bullets };
}

describe("resolveSemanticEnabled: tri-state posture (#75)", () => {
  test("cached model + no explicit setting -> automatic on", async () => {
    const probe = stubXenovaProbe(true);
    const status = await resolveSemanticEnabled(
      createTestConfig({ semanticSearchEnabled: undefined }),
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
      createTestConfig({ semanticSearchEnabled: undefined }),
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
        createTestConfig({ semanticSearchEnabled: flag, embeddingModel: "none" }),
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
      createTestConfig({ semanticSearchEnabled: undefined }),
    );
    expect(status.enabled).toBe(false);
    expect(status.posture).toBe("auto-off");
  });
});

describe("local embedding runtime ownership", () => {
  test("network retry retains the caller's model path and quantized WASM settings", async () => {
    await withTempCassHome(async () => {
      const child = Bun.spawnSync([process.execPath, "--eval", `
        import { spyOn } from "bun:test";
        import * as transformers from "@huggingface/transformers";
        const { getEmbedder } = await import("./src/semantic.ts");
        const calls = [];
        spyOn(transformers, "pipeline").mockImplementation(async (task, model, options) => {
          calls.push({ task, model, device: options.device, dtype: options.dtype, local: options.local_files_only ?? false });
          if (calls.length === 1) throw new Error("network fetch unavailable");
          return { dispose: async () => {} };
        });
        await getEmbedder("/custom/local/text-model", { showProgress: false });
        console.log(JSON.stringify(calls));
      `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual([
        { task: "feature-extraction", model: "/custom/local/text-model", device: "wasm", dtype: "q8", local: false },
        { task: "feature-extraction", model: "/custom/local/text-model", device: "wasm", dtype: "q8", local: true },
      ]);
    });
  });

  test("concurrent local-only probes share and dispose their temporary pipeline, and retry failures", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { spyOn } from "bun:test";
      import * as transformers from "@huggingface/transformers";
      const { isModelCached } = await import("./src/semantic.ts");
      let calls = 0, disposed = 0, downloads = 0, failures = 1;
      const localOnly = [], devices = [], dtypes = [];
      globalThis.fetch = async () => { downloads++; throw new Error("network forbidden in readiness probe"); };
      spyOn(transformers, "pipeline").mockImplementation(async (_task, model, options) => {
        calls++;
        localOnly.push(options.local_files_only);
        devices.push(options.device);
        dtypes.push(options.dtype);
        if (model === "retry-model" && failures-- > 0) throw new Error("cache incomplete");
        return { dispose: async () => { disposed++; } };
      });
      const ready = await Promise.all([isModelCached("probe-model"), isModelCached("probe-model"), isModelCached("probe-model")]);
      const concurrent = { calls, disposed };
      await isModelCached("probe-model");
      const firstRetry = await isModelCached("retry-model");
      const secondRetry = await isModelCached("retry-model");
      console.log(JSON.stringify({ ready, concurrent, firstRetry, secondRetry, calls, disposed, downloads, localOnly, devices, dtypes }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.ready).toEqual([true, true, true]);
    expect(result.concurrent).toEqual({ calls: 1, disposed: 1 });
    expect(result.firstRetry).toBe(false);
    expect(result.secondRetry).toBe(true);
    expect(result.calls).toBe(4);
    expect(result.disposed).toBe(3);
    expect(result.downloads).toBe(0);
    expect(result.localOnly).toEqual([true, true, true, true]);
    expect(result.devices).toEqual(["wasm", "wasm", "wasm", "wasm"]);
    expect(result.dtypes).toEqual(["q8", "q8", "q8", "q8"]);
  });

  test("readiness reuses an active embedder and older failed loads cannot evict its cache", async () => {
    await withTempCassHome(async () => {
      const child = Bun.spawnSync([process.execPath, "--eval", `
        import { spyOn } from "bun:test";
        import * as transformers from "@huggingface/transformers";
        const { getEmbedder, isModelCached } = await import("./src/semantic.ts");
        let calls = 0, disposed = 0, startOlder, rejectOlder;
        const olderStarted = new Promise(resolve => { startOlder = resolve; });
        const newerPipeline = { dispose: async () => { disposed++; } };
        spyOn(transformers, "pipeline").mockImplementation(async (_task, model) => {
          calls++;
          if (model === "older-model") {
            startOlder();
            return new Promise((_resolve, reject) => { rejectOlder = reject; });
          }
          return newerPipeline;
        });
        const older = getEmbedder("older-model").catch(error => error.message);
        await olderStarted;
        const newer = getEmbedder("newer-model");
        rejectOlder(new Error("older model failed"));
        const olderError = await older;
        const loaded = await newer;
        const reused = await getEmbedder("newer-model");
        const ready = await isModelCached("newer-model");
        console.log(JSON.stringify({ olderError, reused: loaded === reused, ready, calls, disposed }));
      `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        olderError: "older model failed",
        reused: true,
        ready: true,
        calls: 2,
        disposed: 0,
      });
    });
  });
});

describe("embedding cache runtime versions", () => {
  test("invalidates old local vectors while retaining existing Ollama cache entries", async () => {
    await withTempDir("cm-cache-versions", async dir => {
      const previousBackend = getEmbeddingBackend();
      const cachePath = `${dir}/cache.json`;
      const localConfig = { embeddingBackend: "xenova", embeddingModel: "custom-model" } as const;
      const ollamaConfig = { embeddingBackend: "ollama", embeddingModel: "custom-model", ollamaBaseUrl: "http://127.0.0.1:11434" } as const;
      const emptyLocal = createEmptyEmbeddingCache(undefined, { config: localConfig });
      const legacyLocal = {
        ...emptyLocal,
        version: "2.0",
        dimensions: 3,
        bullets: { "b-version": { contentHash: "known-content", embedding: [1, 0, 0], computedAt: "2026-01-01T00:00:00.000Z" } },
      };
      const ollamaCache = {
        ...createEmptyEmbeddingCache(undefined, { config: ollamaConfig }),
        dimensions: 3,
        bullets: legacyLocal.bullets,
      };
      writeFileSync(cachePath, JSON.stringify(legacyLocal));
      try {
        setEmbeddingBackend("ollama");
        expect(emptyLocal.version).toBe("3.0");
        expect(await loadEmbeddingCache({ cachePath, config: localConfig })).toEqual(emptyLocal);
        writeFileSync(cachePath, JSON.stringify(ollamaCache));
        setEmbeddingBackend("xenova");
        expect(ollamaCache.version).toBe("2.0");
        expect(await loadEmbeddingCache({ cachePath, config: ollamaConfig })).toEqual(ollamaCache);

        const current = { ...legacyLocal, version: "3.0" };
        writeFileSync(cachePath, JSON.stringify(current));
        setEmbeddingBackend("ollama");
        expect(await loadEmbeddingCache({ cachePath, config: localConfig })).toEqual(current);
        expect((await loadEmbeddingCache({ cachePath, config: ollamaConfig })).bullets).toEqual({});
      } finally {
        setEmbeddingBackend(previousBackend);
      }
    });
  });
});

describe("resolveSemanticEnabled: Ollama auto-on (#75)", () => {
  /** Stand up a throwaway daemon that answers /api/tags with `models`. */
  async function withTagServer<T>(
    handler: (url: URL) => Response | undefined,
    fn: (baseUrl: string) => Promise<T>,
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
        }),
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
        }),
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
      }),
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
      { queryEmbedding: query, skipEmbeddingLoad: true, meta },
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
      { queryEmbedding: query, skipEmbeddingLoad: true, meta },
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
      { queryEmbedding: query, skipEmbeddingLoad: true, meta },
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
      { queryEmbedding: query, skipEmbeddingLoad: true, meta },
    );

    expect(meta.semanticMode).toBe("semantic");
    expect(meta.semanticNotice).toBeUndefined();
    expect(scored[0].id).toBe("b-near");
  });

  test("explicit true + a backend that cannot embed -> the loud semanticError, unchanged", async () => {
    stubXenovaProbe(false);
    const meta: ScoreBulletsMeta = { semanticMode: "keyword" };
    const bullets = [createTestBullet({ id: "b-1", content: "alpha topic", tags: ["alpha"] })];
    const requests: Array<{ model: string; input: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/api/embed") {
          return new Response("not found", { status: 404 });
        }
        requests.push(await request.json() as { model: string; input: string });
        return new Response("embedding fixture unavailable", { status: 503 });
      },
    });
    try {
      // Explicit enablement bypasses readiness probes, so make the embedding
      // request itself fail without consulting an external model registry.
      // Leave the fallback warning visible: silent fallback once hid a
      // release-long regression.
      await scoreBulletsEnhanced(
        bullets,
        "alpha topic",
        ["alpha"],
        createTestConfig({
          semanticSearchEnabled: true,
          embeddingBackend: "ollama",
          embeddingModel: "invalid-nonexistent-model",
          ollamaBaseUrl: `http://127.0.0.1:${server.port}`,
        }),
        { meta },
      );

      expect(meta.semanticMode).toBe("keyword");
      expect(meta.semanticError).toBeDefined();
      // semanticError and semanticNotice are mutually exclusive.
      expect(meta.semanticNotice).toBeUndefined();
      expect(requests).toEqual([{ model: "invalid-nonexistent-model", input: "alpha topic" }]);
      expect(meta.semanticError).toContain("HTTP 503");
      expect(meta.semanticError).toContain("embedding fixture unavailable");
    } finally {
      server.stop(true);
    }
  });
});

describe("context scoring recovers from unusable corpus embeddings", () => {
  for (const failure of ["provider error", "wrong dimensions"] as const) {
    test(`${failure} preserves keyword scores and retries successfully after repair`, async () => {
      await withTempCassHome(async () => {
        const task = "cache database connections efficiently";
        const keywords = ["cache", "database", "connections"];
        const bullets = [
          createTestBullet({
            id: "b-keyword",
            content: "cache database connections",
            embedding: [0, 1],
          }),
          createTestBullet({
            id: "b-semantic",
            content: "reuse a client pool",
            embedding: [1, 0],
          }),
        ];
        let repaired = false;
        let corpusRequests = 0;
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: async (request) => {
            if (new URL(request.url).pathname !== "/api/embed") {
              return new Response("not found", { status: 404 });
            }
            const { input } = await request.json() as { input: string | string[] };
            const texts = Array.isArray(input) ? input : [input];
            if (texts.every((text) => text === task)) {
              return Response.json({ embeddings: texts.map(() => [1, 0]) });
            }
            corpusRequests++;
            if (!repaired && failure === "provider error") {
              return new Response("corpus model temporarily unavailable", { status: 503 });
            }
            return Response.json({
              embeddings: texts.map((text) =>
                !repaired ? [1, 0, 0] : text === bullets[0].content ? [0, 1] : [1, 0],
              ),
            });
          },
        });
        try {
          const config = createTestConfig({
            semanticSearchEnabled: true,
            embeddingBackend: "ollama",
            ollamaBaseUrl: `http://127.0.0.1:${server.port}`,
          });
          const meta: ScoreBulletsMeta = { semanticMode: "keyword" };
          const keywordScores = scoreBulletsKeyword(bullets, keywords, config);
          const failed = await scoreBulletsEnhanced(bullets, task, keywords, config, { meta });

          expect(meta.semanticMode).toBe("keyword");
          expect(meta.semanticError).toBeDefined();
          expect(meta.semanticNotice).toBeUndefined();
          expect(failed.map(({ id, relevanceScore, finalScore }) => ({ id, relevanceScore, finalScore })))
            .toEqual(keywordScores.map(({ id, relevanceScore, finalScore }) => ({ id, relevanceScore, finalScore })));
          expect(failed[0].id).toBe("b-keyword");
          expect(corpusRequests).toBeGreaterThan(0);
          const failedRequests = corpusRequests;

          repaired = true;
          const recovered = await scoreBulletsEnhanced(bullets, task, keywords, config, { meta });

          expect(meta.semanticMode).toBe("semantic");
          expect(meta.semanticError).toBeUndefined();
          expect(corpusRequests).toBeGreaterThan(failedRequests);
          expect(recovered[0].id).toBe("b-semantic");
        } finally {
          server.stop(true);
        }
      });
    });
  }

  test("partial corpus coverage keeps full keyword scores for incompatible rules", async () => {
    await withTempCassHome(async () => {
      const task = "database query";
      const keywords = ["database"];
      const bullets = [
        createTestBullet({ id: "b-invalid", content: "database connection checks" }),
        createTestBullet({ id: "b-valid", content: "reuse a client pool" }),
      ];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const { input } = await request.json() as { input: string | string[] };
          const texts = Array.isArray(input) ? input : [input];
          return Response.json({
            embeddings: texts.map((text) => text === bullets[0].content ? [1, 0, 0] : [1, 0]),
          });
        },
      });
      try {
        const config = createTestConfig({
          semanticSearchEnabled: true,
          embeddingBackend: "ollama",
          ollamaBaseUrl: `http://127.0.0.1:${server.port}`,
        });
        const meta: ScoreBulletsMeta = { semanticMode: "keyword" };
        const keywordScores = scoreBulletsKeyword(bullets, keywords, config);
        const scored = await scoreBulletsEnhanced(bullets, task, keywords, config, { meta });

        expect(meta.semanticMode).toBe("semantic");
        expect(scored.find((bullet) => bullet.id === "b-invalid")?.relevanceScore)
          .toBe(keywordScores.find((bullet) => bullet.id === "b-invalid")?.relevanceScore);
        expect(scored.find((bullet) => bullet.id === "b-valid")?.relevanceScore).toBeGreaterThan(0);
        expect(scored.every((bullet) => Number.isFinite(bullet.finalScore))).toBe(true);
      } finally {
        server.stop(true);
      }
    });
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
            createTestBullet({
              id: "b-1",
              content: "alpha topic",
              tags: ["alpha"],
              state: "active",
            }),
          ]),
        ),
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
            createTestBullet({
              id: "b-1",
              content: "alpha topic",
              tags: ["alpha"],
              state: "active",
            }),
          ]),
        ),
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
            createTestBullet({
              id: "b-1",
              content: "alpha topic",
              tags: ["alpha"],
              state: "active",
            }),
          ]),
        ),
      );

      const { result } = await generateContextResult("alpha topic", { json: true });

      expect(result.semanticMode).toBe("keyword");
      expect(result.semanticNotice).toBeUndefined();
      expect(result.semanticError).toBeUndefined();
    });
  });
});
