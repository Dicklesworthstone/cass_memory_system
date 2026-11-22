import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  batchEmbed,
  buildSemanticDedupIndex,
  configureEmbeddingBackend,
  cosineSimilarity,
  createEmptyEmbeddingCache,
  DEFAULT_EMBEDDING_MODEL,
  embedText,
  findSimilarBulletsSemantic,
  findSemanticDuplicates,
  formatSemanticModeMessage,
  getEmbeddingBackend,
  getEmbeddingCachePath,
  getSemanticStatus,
  isValidEmbedding,
  isModelCached,
  loadOrComputeEmbeddingsForBullets,
  type ModelLoadProgress,
  type ProgressCallback,
  type SemanticStatus,
  type SemanticConfigInput,
  setEmbeddingBackend,
  type WarmupResult,
  warmupEmbeddings,
} from "../src/semantic.js";
import { hashContent } from "../src/utils.js";
import { createTestBullet } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

type EmbedRequest = { model: string; input: string | string[] };

async function withOllamaServer(
  respond: (request: EmbedRequest) => Response | Promise<Response>,
  run: (config: SemanticConfigInput) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/embed") {
        return new Response("not found", { status: 404 });
      }
      return respond(await request.json() as EmbedRequest);
    },
  });
  try {
    await run({
      semanticSearchEnabled: true,
      embeddingBackend: "ollama",
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      ollamaBaseUrl: `http://127.0.0.1:${server.port}`,
    });
  } finally {
    server.stop(true);
    setEmbeddingBackend("xenova");
  }
}

function embeddingResponse(request: EmbedRequest, vector: number[]): Response {
  const inputs = Array.isArray(request.input) ? request.input : [request.input];
  return Response.json({ embeddings: inputs.map(() => vector) });
}

describe("semantic: cosineSimilarity", () => {
  test("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  test("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  test("rejects unusable vectors and keeps cosine finite at numerical extremes", () => {
    for (const value of [undefined, null, [], [0, 0], [NaN, 1], [Infinity, 1], ["1", 2]]) {
      expect(isValidEmbedding(value)).toBe(false);
    }
    expect(isValidEmbedding([1, 0], 2)).toBe(true);
    expect(isValidEmbedding([1, 0], 3)).toBe(false);
    expect(cosineSimilarity([NaN, 1], [1, 0])).toBe(0);
    expect(cosineSimilarity([Infinity, 1], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1e308, 1e308], [1e308, 1e308])).toBeCloseTo(1);
    expect(cosineSimilarity([1e-308, 1e-308], [-1e-308, -1e-308])).toBeCloseTo(-1);
  });
});

describe("semantic: embedding helpers (no model downloads)", () => {
  test("embedText returns [] when model is 'none'", async () => {
    expect(await embedText("hello world", { model: "none" })).toEqual([]);
  });

  test("batchEmbed returns [] vectors when model is 'none'", async () => {
    const result = await batchEmbed(["hello", "", "world"], 32, { model: "none" });
    expect(result).toEqual([[], [], []]);
  });

  test("configureEmbeddingBackend maps the default Xenova model to Ollama's official model name", () => {
    try {
      const config = {
        semanticSearchEnabled: true,
        embeddingBackend: "ollama" as const,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
        ollamaBaseUrl: "http://127.0.0.1:11434/",
      };

      configureEmbeddingBackend(config);

      expect(getEmbeddingBackend()).toBe("ollama");
      expect(getSemanticStatus(config).model).toBe("ollama:all-minilm");
    } finally {
      setEmbeddingBackend("xenova");
    }
  });

  test("configureEmbeddingBackend still normalizes custom Xenova model names", () => {
    try {
      const config = {
        semanticSearchEnabled: true,
        embeddingBackend: "ollama" as const,
        embeddingModel: "Xenova/custom-embedding-model",
      };

      configureEmbeddingBackend(config);

      expect(getSemanticStatus(config).model).toBe("ollama:custom-embedding-model");
    } finally {
      setEmbeddingBackend("xenova");
    }
  });

  test("Ollama embedding requests include a timeout signal", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      signals.push(init?.signal);
      const request = JSON.parse(String(init?.body)) as {
        input: string | string[];
      };
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return Response.json({
        embeddings: inputs.map(() => [1, 0]),
      });
    }) as typeof fetch);

    try {
      configureEmbeddingBackend({
        embeddingBackend: "ollama",
        embeddingModel: "all-minilm",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      });

      expect(await embedText("single")).toEqual([1, 0]);
      expect(await batchEmbed(["first", "second"])).toEqual([
        [1, 0],
        [1, 0],
      ]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      setEmbeddingBackend("xenova");
    }
  });
});

describe("semantic: provider output and request ownership", () => {
  test("validates local tensor shape and vector content before claiming embedding or warmup success", async () => {
    await withTempCassHome(async () => {
      // Isolate the pipeline substitute from other test files and keep native
      // model downloads out of this provider-contract regression.
      const child = Bun.spawnSync([process.execPath, "--eval", `
        import { spyOn } from "bun:test";
        import * as transformers from "@xenova/transformers";
        const { embedText, batchEmbed, warmupEmbeddings } = await import("./src/semantic.ts");
        const config = { embeddingBackend: "xenova", embeddingModel: "tensor-contract-fixture" };
        let tensor = { data: new Float32Array([1, 0]), dims: [1, 2] };
        let downloads = 0;
        globalThis.fetch = async () => { downloads++; throw new Error("model download forbidden"); };
        spyOn(transformers, "pipeline").mockImplementation(async () => async () => tensor);
        const validSingle = await embedText("query", { config });
        const validWarmup = (await warmupEmbeddings({ config, showProgress: false })).success;
        const invalidSingles = [
          { data: [], dims: [1, 0] },
          { data: [0, 0], dims: [1, 2] },
          { data: [Infinity, 1], dims: [1, 2] },
          { data: [1, 0], dims: [1, 3] },
          { data: [1, 0], dims: [2, 1] },
        ];
        const rejectedSingles = [], invalidWarmups = [];
        for (tensor of invalidSingles) {
          try { await embedText("query", { config }); rejectedSingles.push(false); }
          catch { rejectedSingles.push(true); }
          invalidWarmups.push((await warmupEmbeddings({ config, showProgress: false })).success);
        }
        tensor = { data: new Float32Array([1, 0, 0, 1]), dims: [2, 2] };
        const validBatch = await batchEmbed(["first", "second"], 32, { config });
        const invalidBatches = [
          { data: [1, 0, 0], dims: [2, 2] },
          { data: [1, 0, 0, 0], dims: [2, 2] },
          { data: [1, 0, NaN, 1], dims: [2, 2] },
          { data: [1, 0, 0, 1], dims: [2, 1, 2] },
        ];
        const rejectedBatches = [];
        for (tensor of invalidBatches) {
          try { await batchEmbed(["first", "second"], 32, { config }); rejectedBatches.push(false); }
          catch { rejectedBatches.push(true); }
        }
        console.log(JSON.stringify({ validSingle, validWarmup, validBatch, rejectedSingles, invalidWarmups, rejectedBatches, downloads }));
      `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        validSingle: [1, 0],
        validWarmup: true,
        validBatch: [[1, 0], [0, 1]],
        rejectedSingles: [true, true, true, true, true],
        invalidWarmups: [false, false, false, false, false],
        rejectedBatches: [true, true, true, true],
        downloads: 0,
      });
    });
  });

  test.each([
    ["empty vector", '{"embeddings":[[]]}'],
    ["zero norm", '{"embeddings":[[0,0]]}'],
    ["nonnumeric coordinate", '{"embeddings":[["1",2]]}'],
    ["nonfinite coordinate", '{"embeddings":[[1e999,1]]}'],
    ["missing vector", '{"embeddings":[]}'],
  ])("rejects %s in single, batch and warmup responses", async (_name, payload) => {
    await withOllamaServer(
      () => new Response(payload, { headers: { "Content-Type": "application/json" } }),
      async config => {
        await expect(embedText("query", { config })).rejects.toThrow();
        await expect(batchEmbed(["rule"], 32, { config })).rejects.toThrow();
        const warmup = await warmupEmbeddings({ config });
        expect(warmup.success).toBe(false);
        expect(warmup.error).toBeTruthy();
      },
    );
  });

  test("validates dimensions across Ollama response chunks", async () => {
    let calls = 0;
    await withOllamaServer(
      request => embeddingResponse(request, ++calls === 1 ? [1, 0] : [1, 0, 0]),
      async config => {
        await expect(batchEmbed(Array.from({ length: 65 }, (_, i) => `rule ${i}`), 32, { config }))
          .rejects.toThrow("2 dimensions");
        expect(calls).toBe(2);
      },
    );
  });

  test("keeps every batch on its initial endpoint and model after global reconfiguration", async () => {
    const requestsA: EmbedRequest[] = [];
    const requestsB: EmbedRequest[] = [];
    await withOllamaServer(request => {
      requestsA.push(request);
      return embeddingResponse(request, [1, 0]);
    }, async configA => {
      await withOllamaServer(request => {
        requestsB.push(request);
        return embeddingResponse(request, [0, 1]);
      }, async configB => {
        configureEmbeddingBackend({ ...configA, embeddingModel: "model-a" });
        const result = await batchEmbed(Array.from({ length: 65 }, (_, i) => `rule ${i}`), 32, {
          onProgress: () => configureEmbeddingBackend({ ...configB, embeddingModel: "model-b" }),
        });
        expect(result).toHaveLength(65);
        expect(result.every(vector => vector[0] === 1 && vector[1] === 0)).toBe(true);
        expect(requestsA.map(request => request.model)).toEqual(["model-a", "model-a"]);
        expect(requestsB).toHaveLength(0);
      });
    });
  });

  test("per-text fallback retains the initial runtime when a batch changes global defaults", async () => {
    await withTempCassHome(async () => {
      const requests: EmbedRequest[] = [];
      let alternateRequests = 0;
      let alternate: SemanticConfigInput;
      await withOllamaServer(request => {
        requests.push(request);
        if (Array.isArray(request.input)) {
          configureEmbeddingBackend(alternate);
          return new Response("batch unavailable", { status: 503 });
        }
        return embeddingResponse(request, [1, 0]);
      }, async config => {
        await withOllamaServer(request => {
          alternateRequests++;
          return embeddingResponse(request, [0, 1]);
        }, async other => {
          alternate = { ...other, embeddingModel: "other-model" };
          configureEmbeddingBackend(config);
          const bullets = [createTestBullet({ content: "First rule" }), createTestBullet({ content: "Second rule" })];
          const result = await loadOrComputeEmbeddingsForBullets(bullets);
          expect(result.stats).toEqual({ reused: 0, computed: 2, skipped: 0 });
          expect(bullets.map(bullet => bullet.embedding)).toEqual([[1, 0], [1, 0]]);
          expect(requests.map(request => request.model)).toEqual(["all-minilm", "all-minilm", "all-minilm"]);
          expect(alternateRequests).toBe(0);
          expect(result.cache.runtimeId).toBe(createEmptyEmbeddingCache(undefined, { config }).runtimeId);
        });
      });
    });
  });
});

describe("semantic: cache provenance", () => {
  test("rejects a different runtime even when the caller reuses one explicit cache file", async () => {
    await withTempCassHome(async env => {
      const configA: SemanticConfigInput = { embeddingBackend: "xenova", embeddingModel: "none" };
      const configB: SemanticConfigInput = { embeddingBackend: "ollama", embeddingModel: "none" };
      const bullet = createTestBullet({ content: "A cached rule", embedding: [1, 0] });
      const cache = createEmptyEmbeddingCache(undefined, { config: configA });
      cache.bullets[bullet.id] = {
        contentHash: hashContent(bullet.content),
        embedding: [1, 0],
        computedAt: "2026-11-01T00:00:00.000Z",
      };
      const cachePath = path.join(env.cassMemoryDir, "explicit-cache.json");
      const original = JSON.stringify(cache);
      await fs.writeFile(cachePath, original);
      const result = await loadOrComputeEmbeddingsForBullets([bullet], { config: configB, cachePath });
      expect(result.stats).toEqual({ reused: 0, computed: 0, skipped: 1 });
      expect(bullet.embedding).toBeUndefined();
      expect(result.cache.runtimeId).not.toBe(cache.runtimeId);
      expect(await fs.readFile(cachePath, "utf8")).toBe(original);
    });
  });

  test("isolates concurrent project endpoints, reuses effective-model aliases, and preserves legacy files", async () => {
    await withTempCassHome(async env => {
      const requestsA: EmbedRequest[] = [];
      const requestsB: EmbedRequest[] = [];
      await withOllamaServer(request => {
        requestsA.push(request);
        return embeddingResponse(request, [1, 0]);
      }, async configA => {
        await withOllamaServer(request => {
          requestsB.push(request);
          return embeddingResponse(request, [0, 1]);
        }, async configB => {
          const legacyPath = path.join(env.cassMemoryDir, "embeddings", "bullets.json");
          const legacyBytes = JSON.stringify({ version: "1.0", model: DEFAULT_EMBEDDING_MODEL, bullets: {} });
          await fs.mkdir(path.dirname(legacyPath), { recursive: true });
          await fs.writeFile(legacyPath, legacyBytes);
          const bulletA = createTestBullet({ id: "same-id", content: "Check the session evidence" });
          const bulletB = { ...bulletA };
          configureEmbeddingBackend(configB);
          const [firstA, firstB] = await Promise.all([
            loadOrComputeEmbeddingsForBullets([bulletA], { config: configA }),
            loadOrComputeEmbeddingsForBullets([bulletB], { config: configB }),
          ]);
          expect(bulletA.embedding).toEqual([1, 0]);
          expect(bulletB.embedding).toEqual([0, 1]);
          expect(firstA.cache.model).toBe("all-minilm");
          expect(firstA.cache.runtimeId).not.toBe(firstB.cache.runtimeId);
          expect(getEmbeddingCachePath({ config: configA })).not.toBe(getEmbeddingCachePath({ config: configB }));
          expect(getEmbeddingCachePath({ config: { ...configA, embeddingBackend: "xenova" } }))
            .not.toBe(getEmbeddingCachePath({ config: configA }));
          const alias = { ...configA, embeddingModel: "all-minilm", ollamaBaseUrl: `${configA.ollamaBaseUrl}/` };
          expect(getEmbeddingCachePath({ config: alias })).toBe(getEmbeddingCachePath({ config: configA }));
          expect((await loadOrComputeEmbeddingsForBullets([bulletA], { config: alias })).stats.reused).toBe(1);
          expect((await loadOrComputeEmbeddingsForBullets([bulletB], { config: configB })).stats.reused).toBe(1);
          expect(requestsA.map(request => request.model)).toEqual(["all-minilm"]);
          expect(requestsB.map(request => request.model)).toEqual(["all-minilm"]);
          expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
          expect(JSON.stringify(firstA.cache)).not.toContain(configA.ollamaBaseUrl!);

          // Reflection supplies project A explicitly after project B was loaded.
          const index = await buildSemanticDedupIndex([bulletA], ["Check supporting session evidence"], configA);
          expect(index?.embeddings.get(hashContent(bulletA.content))).toEqual([1, 0]);
          expect(index?.embeddings.get(hashContent("Check supporting session evidence"))).toEqual([1, 0]);
          expect(requestsB).toHaveLength(1);
        });
      });
    });
  });

  test("hashes case-sensitive endpoint credentials and model identities", () => {
    const config: SemanticConfigInput = {
      embeddingBackend: "ollama",
      embeddingModel: "private-model",
      ollamaBaseUrl: "https://user:Secret@example.test/tenant?token=SensitiveToken",
    };
    const cache = createEmptyEmbeddingCache(undefined, { config });
    expect(JSON.stringify(cache)).not.toContain("Secret");
    expect(getEmbeddingCachePath({ config })).not.toContain("SensitiveToken");
    expect(getEmbeddingCachePath({ config })).not.toBe(getEmbeddingCachePath({
      config: { ...config, ollamaBaseUrl: config.ollamaBaseUrl!.replace("Secret", "secret") },
    }));
    expect(getEmbeddingCachePath({ config })).not.toBe(getEmbeddingCachePath({
      config: { ...config, embeddingModel: "another-model" },
    }));
  });

  test("clears stale content vectors on failure while keeping compatible cached rules", async () => {
    await withTempCassHome(async () => {
      let failing = false;
      await withOllamaServer(request => failing
        ? new Response("temporarily unavailable", { status: 503 })
        : embeddingResponse(request, [1, 0]), async config => {
        const bullets = [createTestBullet({ content: "Original rule" }), createTestBullet({ content: "Retained rule" })];
        await loadOrComputeEmbeddingsForBullets(bullets, { config });
        bullets[0].content = "A different rule after editing";
        failing = true;
        const result = await loadOrComputeEmbeddingsForBullets(bullets, { config });
        expect(result.stats).toEqual({ reused: 1, computed: 0, skipped: 1 });
        expect(bullets[0].embedding).toBeUndefined();
        expect(bullets[1].embedding).toEqual([1, 0]);
        expect(result.cache.bullets[bullets[0].id]).toBeUndefined();
        const persisted = JSON.parse(await fs.readFile(getEmbeddingCachePath({ config }), "utf8"));
        expect(persisted.bullets[bullets[0].id]).toBeUndefined();
      });
    });
  });

  test("recomputes mismatched cache dimensions instead of pinning retrieval to stale vectors", async () => {
    await withTempCassHome(async () => {
      let vector = [1, 0];
      let calls = 0;
      await withOllamaServer(request => {
        calls++;
        return embeddingResponse(request, vector);
      }, async config => {
        const bullet = createTestBullet({ content: "Dimension-sensitive rule" });
        await loadOrComputeEmbeddingsForBullets([bullet], { config, expectedDimensions: 2 });
        vector = [1, 0, 0];
        const recovered = await loadOrComputeEmbeddingsForBullets([bullet], { config, expectedDimensions: 3 });
        expect(recovered.stats).toEqual({ reused: 0, computed: 1, skipped: 0 });
        expect(recovered.cache.dimensions).toBe(3);
        expect(bullet.embedding).toEqual([1, 0, 0]);
        expect(calls).toBe(2);
      });
    });
  });

  for (const failBeforeRecovery of [false, true]) {
    test(`learns fresh dimensions without a query after every cached rule changes${failBeforeRecovery ? " and the provider fails" : ""}`, async () => {
      await withTempCassHome(async () => {
        let vector = [1, 0];
        let failing = false;
        let calls = 0;
        await withOllamaServer(request => {
          calls++;
          return failing
            ? new Response("temporarily unavailable", { status: 503 })
            : embeddingResponse(request, vector);
        }, async config => {
          const bullet = createTestBullet({ content: "Original cached rule" });
          await loadOrComputeEmbeddingsForBullets([bullet], { config });
          bullet.content = "Updated rule after the embedding model changes";
          if (failBeforeRecovery) {
            failing = true;
            const unavailable = await loadOrComputeEmbeddingsForBullets([bullet], { config });
            expect(unavailable.stats).toEqual({ reused: 0, computed: 0, skipped: 1 });
            expect(bullet.embedding).toBeUndefined();
          }
          failing = false;
          vector = [1, 0, 0];
          const recovered = await loadOrComputeEmbeddingsForBullets([bullet], { config });
          expect(recovered.stats).toEqual({ reused: 0, computed: 1, skipped: 0 });
          expect(recovered.cache.dimensions).toBe(3);
          expect(bullet.embedding).toEqual([1, 0, 0]);
          const recoveryCalls = calls;
          const reused = await loadOrComputeEmbeddingsForBullets([bullet], { config });
          expect(reused.stats).toEqual({ reused: 1, computed: 0, skipped: 0 });
          expect(calls).toBe(recoveryCalls);
        });
      });
    });
  }

  test("dedup refreshes cached rules to the dimensions of current incoming vectors", async () => {
    await withTempCassHome(async () => {
      let vector = [1, 0];
      await withOllamaServer(request => embeddingResponse(request, vector), async config => {
        const existing = createTestBullet({ content: "Check session evidence before recording a rule" });
        const incoming = "Verify supporting session evidence before saving a learned rule";
        await loadOrComputeEmbeddingsForBullets([existing], { config });
        vector = [1, 0, 0];
        const index = await buildSemanticDedupIndex([existing], [incoming], config);
        expect(index?.embeddings.get(hashContent(existing.content))).toEqual([1, 0, 0]);
        expect(index?.embeddings.get(hashContent(incoming))).toEqual([1, 0, 0]);
        expect(Array.from(index!.embeddings.values()).every(value => isValidEmbedding(value, 3))).toBe(true);
        // Building the index owns clones; it must not change the caller's playbook.
        expect(existing.embedding).toEqual([1, 0]);
        const refreshed = { ...existing };
        const cached = await loadOrComputeEmbeddingsForBullets([refreshed], { config });
        expect(cached.stats).toEqual({ reused: 1, computed: 0, skipped: 0 });
        expect(refreshed.embedding).toEqual([1, 0, 0]);
      });
    });
  });

  test("distinguishes unavailable rule embeddings from a valid search with no matches", async () => {
    const bullet = createTestBullet({ content: "Use indexed retrieval", embedding: [0, 1] });
    const options = { queryEmbedding: [1, 0], ensureEmbeddings: false, threshold: 0.9 };
    expect(await findSimilarBulletsSemantic("query", [bullet], 5, options)).toEqual([]);
    bullet.embedding = [1, 0, 0];
    await expect(findSimilarBulletsSemantic("query", [bullet], 5, options)).rejects.toThrow("no rule embeddings");
    await expect(findSimilarBulletsSemantic("query", [bullet], 5, { ...options, queryEmbedding: [0, 0] }))
      .rejects.toThrow("invalid embedding");
    expect(await findSimilarBulletsSemantic("query", [], 5, options)).toEqual([]);
  });
});

describe("semantic: findSemanticDuplicates (deterministic)", () => {
  test("detects duplicates from precomputed embeddings", async () => {
    const bullets: any[] = [
      { id: "b-1", content: "A", embedding: [1, 0] },
      { id: "b-2", content: "B", embedding: [1, 0] },
      { id: "b-3", content: "C", embedding: [0, 1] },
    ];

    const dupes = await findSemanticDuplicates(bullets, 0.9, { ensureEmbeddings: false });
    expect(dupes).toHaveLength(1);
    expect(dupes[0].pair).toEqual(["b-1", "b-2"]);
    expect(dupes[0].similarity).toBeCloseTo(1);
  });
});

describe("semantic: progress callback types", () => {
  test("ModelLoadProgress has expected status values", () => {
    // Type test - verify the interface is correctly exported
    const initiateProgress: ModelLoadProgress = { status: "initiate" };
    const downloadProgress: ModelLoadProgress = { status: "download", name: "model.bin" };
    const progressProgress: ModelLoadProgress = { status: "progress", progress: 50 };
    const doneProgress: ModelLoadProgress = { status: "done" };
    const readyProgress: ModelLoadProgress = { status: "ready" };

    expect(initiateProgress.status).toBe("initiate");
    expect(downloadProgress.status).toBe("download");
    expect(progressProgress.progress).toBe(50);
    expect(doneProgress.status).toBe("done");
    expect(readyProgress.status).toBe("ready");
  });

  test("ProgressCallback type is correctly exported", () => {
    // Type test - verify callback signature
    const progressEvents: ModelLoadProgress[] = [];
    const callback: ProgressCallback = (progress) => {
      progressEvents.push(progress);
    };

    callback({ status: "initiate" });
    callback({ status: "progress", progress: 25 });
    callback({ status: "progress", progress: 50 });
    callback({ status: "progress", progress: 75 });
    callback({ status: "progress", progress: 100 });
    callback({ status: "ready" });

    expect(progressEvents).toHaveLength(6);
    expect(progressEvents[0].status).toBe("initiate");
    expect(progressEvents[progressEvents.length - 1].status).toBe("ready");
  });
});

describe("semantic: warmup types", () => {
  test("WarmupResult has expected shape", () => {
    // Type test - verify the interface is correctly exported
    const successResult: WarmupResult = { success: true, durationMs: 100 };
    const failureResult: WarmupResult = { success: false, durationMs: 50, error: "Network error" };

    expect(successResult.success).toBe(true);
    expect(successResult.durationMs).toBe(100);
    expect(successResult.error).toBeUndefined();

    expect(failureResult.success).toBe(false);
    expect(failureResult.durationMs).toBe(50);
    expect(failureResult.error).toBe("Network error");
  });

  test("warmupEmbeddings is exported as a function", () => {
    expect(typeof warmupEmbeddings).toBe("function");
  });

  test("isModelCached is exported as a function", () => {
    expect(typeof isModelCached).toBe("function");
  });
});

describe("semantic: getSemanticStatus", () => {
  test("returns disabled status when semanticSearchEnabled is false", () => {
    const status = getSemanticStatus({ semanticSearchEnabled: false });
    expect(status.enabled).toBe(false);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("disabled");
    expect(status.enableHint).toBeDefined();
    expect(status.enableHint).toContain("semanticSearchEnabled");
  });

  test("enable hint names the file the global loader actually reads (#75)", () => {
    // The global loader reads ~/.cass-memory/config.json (YAML accepted too);
    // the old hint pointed only at config.yaml, which was ignored globally.
    const status = getSemanticStatus({ semanticSearchEnabled: false });
    expect(status.enableHint).toContain("~/.cass-memory/config.json");
    expect(status.enableHint).toContain("doctor --fix");
    expect(status.enableHint).not.toMatch(/in ~\/\.cass-memory\/config\.yaml\b/);
  });

  test("returns disabled status when embeddingModel is 'none'", () => {
    const status = getSemanticStatus({ semanticSearchEnabled: true, embeddingModel: "none" });
    expect(status.enabled).toBe(false);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("none");
  });

  test("returns enabled status when semanticSearchEnabled is true", () => {
    const status = getSemanticStatus({ semanticSearchEnabled: true });
    expect(status.enabled).toBe(true);
    expect(status.available).toBe(true);
    expect(status.reason).toContain("enabled");
    expect(status.enableHint).toBeUndefined();
  });

  test("uses default model when embeddingModel not specified", () => {
    const status = getSemanticStatus({ semanticSearchEnabled: true });
    expect(status.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  test("uses custom model when specified", () => {
    const status = getSemanticStatus({
      semanticSearchEnabled: true,
      embeddingModel: "custom-model",
    });
    expect(status.model).toBe("custom-model");
  });
});

describe("semantic: formatSemanticModeMessage", () => {
  test("formats semantic mode message", () => {
    const status: SemanticStatus = {
      enabled: true,
      available: true,
      reason: "Semantic search enabled",
      model: "Xenova/all-MiniLM-L6-v2",
      posture: "explicit-on",
    };
    const message = formatSemanticModeMessage("semantic", status);
    expect(message).toContain("semantic search");
    expect(message).toContain("Xenova/all-MiniLM-L6-v2");
  });

  test("formats keyword mode with enable hint", () => {
    const status: SemanticStatus = {
      enabled: false,
      available: false,
      reason: "Semantic search is disabled in config",
      enableHint: "Set semanticSearchEnabled: true in ~/.cass-memory/config.json (or config.yaml)",
      model: "Xenova/all-MiniLM-L6-v2",
      posture: "explicit-off",
    };
    const message = formatSemanticModeMessage("keyword", status);
    expect(message).toContain("keyword search");
    expect(message).toContain("semanticSearchEnabled");
  });

  test("formats keyword mode for offline fallback", () => {
    const status: SemanticStatus = {
      enabled: true,
      available: false,
      reason: "Model not available",
      model: "Xenova/all-MiniLM-L6-v2",
      posture: "explicit-on",
    };
    const message = formatSemanticModeMessage("keyword", status);
    expect(message).toContain("keyword search");
    expect(message).toContain("offline");
  });
});
