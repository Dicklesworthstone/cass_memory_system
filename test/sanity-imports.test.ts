import { describe, expect, it } from "bun:test";
import { curatePlaybook } from "../src/curate.js";
import { normalizeValidatorVerdict } from "../src/validate.js";

describe("Sanity Check Imports", () => {
  it("should import curatePlaybook", () => {
    expect(curatePlaybook).toBeDefined();
    expect(typeof curatePlaybook).toBe("function");
  });

  it("should import normalizeValidatorVerdict", () => {
    expect(normalizeValidatorVerdict).toBeDefined();
    expect(typeof normalizeValidatorVerdict).toBe("function");
  });
});
