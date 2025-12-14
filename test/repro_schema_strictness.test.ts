
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { PlaybookDeltaSchema } from "../src/types.js";

describe("PlaybookDeltaSchema", () => {
  it("AddDelta requires sourceSession", () => {
    const invalidDelta = {
      type: "add",
      bullet: { content: "foo", category: "bar" },
      reason: "test"
    };
    const result = PlaybookDeltaSchema.safeParse(invalidDelta);
    expect(result.success).toBe(false);
  });
});
