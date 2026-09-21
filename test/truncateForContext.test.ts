import { describe, expect, it } from "bun:test";
import { truncateForContext } from "../src/utils.js";

describe("truncateForContext", () => {
  it("returns original text when under the limit", () => {
    const text = "short text";
    const result = truncateForContext(text, { maxChars: 50 });
    expect(result).toBe(text);
  });

  it("preserves head and tail with middle strategy and marker", () => {
    const text = "AAAAA ".repeat(50) + "BBBBB ".repeat(50);
    const result = truncateForContext(text, { maxChars: 120, strategy: "middle" });

    expect(result).toContain("[...truncated...]");
    expect(result.startsWith("AAAAA")).toBeTrue();
    expect(result.trimEnd().endsWith("BBBBB")).toBeTrue();
    expect(result.length).toBeLessThanOrEqual(120);
  });

  it("uses tail strategy marker prefix when truncating", () => {
    const text = "line ".repeat(200);
    const result = truncateForContext(text, { maxChars: 80, strategy: "tail" });

    expect(result.startsWith("[...truncated...]")).toBeTrue();
    expect(result.length).toBeLessThanOrEqual(80);
  });
});
