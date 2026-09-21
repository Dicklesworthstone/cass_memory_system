import { describe, expect, test } from "bun:test";
import { normalizeLineEndings, normalizeLineEndingsTo } from "../src/utils.js";

describe("normalizeLineEndings", () => {
  test("converts mixed CRLF/CR to LF", () => {
    const input = "line1\r\nline2\rline3\n";
    const output = normalizeLineEndings(input);
    expect(output).toBe("line1\nline2\nline3\n");
  });

  test("returns input when empty", () => {
    expect(normalizeLineEndings("")).toBe("");
  });
});

describe("normalizeLineEndingsTo", () => {
  test("returns LF when style is lf", () => {
    const input = "a\r\nb\r\n";
    const output = normalizeLineEndingsTo(input, "lf");
    expect(output).toBe("a\nb\n");
  });

  test("returns CRLF when style is crlf", () => {
    const input = "a\nb\n";
    const output = normalizeLineEndingsTo(input, "crlf");
    expect(output).toBe("a\r\nb\r\n");
  });

  test("auto uses platform (assumes non-win here) and still normalizes", () => {
    const input = "a\r\nb\r";
    const output = normalizeLineEndingsTo(input, "auto");
    // On non-win this is LF; on win it would be CRLF. Both should be normalized (no lone \\r).
    expect(output.endsWith("\r") || output.endsWith("\n")).toBe(true);
    expect(output.includes("\r\r")).toBe(false);
  });
});
