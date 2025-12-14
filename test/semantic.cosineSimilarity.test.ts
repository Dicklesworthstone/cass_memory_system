import { describe, expect, test } from "bun:test";
import { batchEmbed, cosineSimilarity, embedText, findSemanticDuplicates, ModelLoadProgress, ProgressCallback, WarmupResult, warmupEmbeddings, isModelCached, getSemanticStatus, formatSemanticModeMessage, SemanticStatus } from "../src/semantic.js";

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
});

describe("semantic: embedding helpers (no model downloads)", () => {
  test("embedText returns [] when model is 'none'", async () => {
    expect(await embedText("hello world", { model: "none" })).toEqual([]);
  });

  test("batchEmbed returns [] vectors when model is 'none'", async () => {
    const result = await batchEmbed(["hello", "", "world"], 32, { model: "none" });
    expect(result).toEqual([[], [], []]);
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
    const status = getSemanticStatus({ semanticSearchEnabled: true, embeddingModel: "custom-model" });
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
      enableHint: "Set semanticSearchEnabled: true in ~/.cass-memory/config.yaml",
      model: "Xenova/all-MiniLM-L6-v2",
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
    };
    const message = formatSemanticModeMessage("keyword", status);
    expect(message).toContain("keyword search");
    expect(message).toContain("offline");
  });
});
