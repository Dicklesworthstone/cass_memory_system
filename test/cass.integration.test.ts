import { describe, expect, it } from "bun:test";
import { createTestConfig } from "./helpers/factories.js";
import {
  cassAvailable,
  cassNeedsIndex,
  handleCassUnavailable,
  safeCassSearchWithDegraded,
} from "../src/cass.js";

const hasRealCass = cassAvailable();
const cassReady = hasRealCass && !cassNeedsIndex();

describe("cass integration (real cass)", () => {
  it.skipIf(!cassReady)("handleCassUnavailable reports cass available", async () => {
    const result = await handleCassUnavailable({ cassPath: "cass", searchCommonPaths: false });
    expect(result.canContinue).toBe(true);
    expect(result.fallbackMode).toBe("none");
  });

  it.skipIf(!cassReady)("safeCassSearchWithDegraded runs against real cass", async () => {
    const config = createTestConfig();
    const result = await safeCassSearchWithDegraded("definitely-nonexistent-query", { limit: 1, days: 1 }, "cass", config);
    expect(Array.isArray(result.hits)).toBe(true);
  });
});
