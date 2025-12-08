import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { createTestConfig } from "./helpers/factories.js";
import { safeCassSearch, handleCassUnavailable, cassAvailable } from "../src/cass.js";
import { withTempDir } from "./helpers/index.js";

async function makeCassStub(tempDir: string, script: string): Promise<string> {
  const scriptPath = join(tempDir, "cass-stub.sh");
  await writeFile(scriptPath, script, { encoding: "utf-8" });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("cass integration (stubbed)", () => {
  it.serial("handleCassUnavailable returns available path when stub exists", async () => {
    await withTempDir("cass-available", async (dir) => {
      const cassPath = await makeCassStub(dir, "#!/bin/sh\nexit 0\n");
      const result = await handleCassUnavailable({ cassPath });

      expect(result.canContinue).toBe(true);
      expect(result.fallbackMode).toBe("none");
      expect(result.resolvedCassPath).toBe(cassPath);
    });
  });

  it.serial("handleCassUnavailable falls back to playbook-only when cass missing", async () => {
    // If a real cass is installed on this system, skip this assertion to avoid false positives.
    if (cassAvailable()) return;

    const result = await handleCassUnavailable({ cassPath: "/nonexistent/cass-binary" });
    expect(result.canContinue).toBe(true);
    expect(result.fallbackMode).toBe("playbook-only");
    expect(result.message.toLowerCase()).toContain("playbook-only");
  });

  it.serial("safeCassSearch returns empty when cass not available", async () => {
    const hits = await safeCassSearch("test", {}, "/nonexistent/cass-binary");
    expect(hits).toEqual([]);
  });

  it.serial("safeCassSearch returns stubbed hits when cass available", async () => {
    await withTempDir("cass-search", async (dir) => {
      const cassPath = await makeCassStub(dir, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "search" ]; then
  echo '[{"source_path":"demo/session.jsonl","line_number":1,"agent":"stub","snippet":"hello world","score":0.9}]'
  exit 0
fi
exit 0
`);
      const config = createTestConfig();
      const hits = await safeCassSearch("anything", { limit: 1, force: true }, cassPath, config);

      expect(hits.length).toBe(1);
      expect(hits[0].source_path).toBe("demo/session.jsonl");
      expect(hits[0].agent).toBe("stub");
      expect(hits[0].snippet).toBe("hello world");
    });
  });
});
