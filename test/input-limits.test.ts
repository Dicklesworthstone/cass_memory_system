import { describe, expect, it } from "bun:test";
import { open, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertInputLimits,
  assertTextSize,
  CONFIG_INPUT_LIMITS,
  formatValidationIssues,
  InputLimitError,
  parseJsonInput,
  parseYamlInput,
  PLAYBOOK_INPUT_LIMITS,
  readBoundedFile,
  type InputLimits,
} from "../src/input-limits.js";
import {
  ConfigSchema,
  FeedbackEventSchema,
  PlaybookBulletSchema,
  PlaybookSchema,
} from "../src/types.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

const smallLimits: InputLimits = {
  maxBytes: 128,
  maxArrayLength: 4,
  maxObjectKeys: 4,
  maxDepth: 3,
  maxNodes: 16,
};

// Only a few KB, with a sentinel proving rejection happens before validation
// touches any element. Never allocate a host-memory-exhaustion fixture.
function oversizedArray(max: number): unknown[] {
  const values = Array(max + 1).fill(null);
  Object.defineProperty(values, 0, {
    get() { throw new Error("oversized array element was evaluated"); },
  });
  return values;
}

describe("bounded untrusted input (#98)", () => {
  it("checks array length before accessing elements", () => {
    expect(() => assertInputLimits(oversizedArray(4), smallLimits, "fixture"))
      .toThrow("maximum array length is 4");
    expect(() => assertInputLimits([null, false, 1, "x"], smallLimits, "fixture"))
      .not.toThrow();
  });

  it("bounds object keys, total values, and depth independently", () => {
    expect(() => assertInputLimits({ a: 1, b: 2, c: 3, d: 4, e: 5 }, smallLimits, "keys"))
      .toThrow("maximum object key count");
    expect(() => assertInputLimits(Array.from({ length: 4 }, () => [1, 2, 3, 4]), smallLimits, "nodes"))
      .toThrow("maximum expanded value count");
    expect(() => assertInputLimits([[[0]]], smallLimits, "depth")).not.toThrow();
    expect(() => assertInputLimits([[[[0]]]], smallLimits, "depth"))
      .toThrow("maximum nesting depth");
  });

  it("counts each repeated reference while accepting small acyclic aliases", () => {
    const shared = { a: 1, b: 2, c: 3 };
    expect(() => assertInputLimits([shared, shared], smallLimits, "aliases")).not.toThrow();
    expect(() => assertInputLimits([shared, shared, shared, shared], smallLimits, "aliases"))
      .toThrow("maximum expanded value count");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => assertInputLimits(cyclic, smallLimits, "cycle")).toThrow("cyclic");
  });

  it("bounds expanded scalar aliases as well as their reference count", () => {
    const yaml = `a: &text ${"x".repeat(40)}\nb: [*text, *text, *text]\n`;
    expect(Buffer.byteLength(yaml)).toBeLessThan(smallLimits.maxBytes);
    expect(() => parseYamlInput(yaml, smallLimits, "scalar aliases"))
      .toThrow("maximum expanded text size");
  });

  it("measures UTF-8 bytes and accepts the exact byte boundary", () => {
    expect(() => assertTextSize("éé", 4, "utf8")).not.toThrow();
    expect(() => assertTextSize("éé", 3, "utf8")).toThrow(InputLimitError);
    expect(() => assertInputLimits("éé", { ...smallLimits, maxBytes: 3 }, "utf8"))
      .toThrow("maximum expanded text size");
  });

  it("checks text size before JSON or YAML parsing", () => {
    const limits = { ...smallLimits, maxBytes: 4 };
    expect(() => parseJsonInput("invalid", limits, "json")).toThrow(InputLimitError);
    expect(() => parseYamlInput("[broken", limits, "yaml")).toThrow(InputLimitError);
    expect(parseJsonInput("null", limits, "json")).toBeNull();
    expect(parseYamlInput("null", limits, "yaml")).toBeNull();
  });

  it("rejects YAML resource amplification and cycles without changing normal parsing", () => {
    expect(parseYamlInput("a: &value [1, 2]\nb: *value", smallLimits, "normal aliases"))
      .toEqual({ a: [1, 2], b: [1, 2] });
    expect(() => parseYamlInput("a: &cycle [*cycle]", smallLimits, "cycle"))
      .toThrow(InputLimitError);
    const amplification = `a: &a [1, 2]\nb: [${Array(101).fill("*a").join(",")}]`;
    expect(() => parseYamlInput(amplification, CONFIG_INPUT_LIMITS, "alias expansion"))
      .toThrow(InputLimitError);
  });

  it("rejects excessive YAML tokens before a syntax tree is built", () => {
    const tokens = `[${Array(20).fill("null").join(",")} `;
    // The deliberately missing ']' would otherwise produce a syntax error.
    expect(() => parseYamlInput(tokens, { ...smallLimits, maxNodes: 3 }, "tokens"))
      .toThrow("maximum YAML token count");
  });

  it("bounds diagnostic output rather than formatting every validation issue", () => {
    const issues = Array.from({ length: 100 }, (_, i) => ({
      path: ["bullets", i, "content"],
      message: "invalid ".repeat(100),
    }));
    const message = formatValidationIssues({ issues });
    expect(message.length).toBeLessThan(2000);
    expect(message).toContain("bullets.0.content");
    expect(message).toContain("95 more validation issues");
    expect(message).not.toContain("bullets.5.content");
  });

  it("reads ordinary files and rejects oversized sparse files before reading their contents", async () => {
    await withTempDir("input-limits", async (dir) => {
      const file = path.join(dir, "input.yaml");
      await writeFile(file, "éé");
      expect(await readBoundedFile(file, 4)).toBe("éé");
      await expect(readBoundedFile(file, 3)).rejects.toThrow(InputLimitError);
      const handle = await open(file, "r+");
      try {
        await handle.truncate(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      } finally {
        await handle.close();
      }
      await expect(readBoundedFile(file, PLAYBOOK_INPUT_LIMITS.maxBytes))
        .rejects.toThrow("maximum file size");
      await expect(readBoundedFile(path.join(dir, "missing"), 10)).rejects.toThrow();
    });
  });

  it.skipIf(process.platform === "win32")("rejects a device symlink without reading from it", async () => {
    await withTempDir("input-special-file", async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      await symlink("/dev/zero", file);
      await expect(readBoundedFile(file, 10)).rejects.toThrow("expected a regular file");
    });
  });
});

describe("patched Zod collection short-circuiting (#98)", () => {
  for (const field of ["bullets", "deprecatedPatterns"]) {
    it(`rejects oversized ${field} before parsing even one invalid element`, () => {
      const result = PlaybookSchema.safeParse({
        ...createTestPlaybook(),
        [field]: oversizedArray(PLAYBOOK_INPUT_LIMITS.maxArrayLength),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].code).toBe("too_big");
        expect(result.error.issues[0].path).toEqual([field]);
      }
    });
  }

  for (const field of ["feedbackEvents", "sourceSessions", "sourceAgents", "tags", "embedding"]) {
    it(`bounds nested bullet ${field}`, () => {
      const result = PlaybookBulletSchema.safeParse({
        ...createTestBullet(),
        [field]: oversizedArray(PLAYBOOK_INPUT_LIMITS.maxArrayLength),
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toHaveLength(1);
    });
  }

  it("bounds nested transcript evidence keys", () => {
    const result = FeedbackEventSchema.safeParse({
      type: "helpful", timestamp: "2026-10-27T00:00:00Z",
      transcriptEvidenceKeys: oversizedArray(PLAYBOOK_INPUT_LIMITS.maxArrayLength),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  for (const [section, field] of [
    [null, "sessionExcludePatterns"], ["sanitization", "extraPatterns"],
    ["crossAgent", "agents"], ["remoteCass", "hosts"],
  ] as const) {
    it(`bounds configuration ${section ? `${section}.` : ""}${field}`, () => {
      const data = { [field]: oversizedArray(CONFIG_INPUT_LIMITS.maxArrayLength) };
      const result = ConfigSchema.safeParse(section ? { [section]: data } : data);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toHaveLength(1);
    });
  }

  it("preserves normal playbooks and still reports invalid elements below the cap", () => {
    const playbook = createTestPlaybook([createTestBullet({ content: "Run migration tests." })]);
    expect(PlaybookSchema.parse(playbook)).toEqual(playbook);
    const result = PlaybookSchema.safeParse({ ...playbook, bullets: [null, 17, "invalid"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(3);
      expect(result.error.issues.map((issue) => issue.path)).toEqual([
        ["bullets", 0], ["bullets", 1], ["bullets", 2],
      ]);
    }
    expect(ConfigSchema.safeParse({ sessionExcludePatterns: Array(1000).fill("test") }).success)
      .toBe(true);
    expect(ConfigSchema.safeParse({ sessionExcludePatterns: [null] }).success).toBe(false);
  });
});
