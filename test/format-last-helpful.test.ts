import { describe, expect, it } from "bun:test";
import { formatLastHelpful } from "../src/utils.js";

describe("formatLastHelpful", () => {
  it("returns 'Never' for empty bullet", () => {
    expect(formatLastHelpful({})).toBe("Never");
  });
  // ... existing tests
});