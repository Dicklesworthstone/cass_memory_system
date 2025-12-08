import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cassExport, handleSessionExportFailure } from "../src/cass.js";

async function writeTempSession(ext: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-fallback-"));
  const file = path.join(dir, `session${ext}`);
  await fs.writeFile(file, content, "utf8");
  return file;
}

describe("handleSessionExportFailure", () => {
  it("parses jsonl sessions into readable text", async () => {
    const file = await writeTempSession(
      ".jsonl",
      [
        JSON.stringify({ type: "user", content: "hello" }),
        JSON.stringify({ type: "assistant", content: "hi there" })
      ].join("\n")
    );

    const result = await handleSessionExportFailure(file, new Error("export failed"));

    expect(result).toContain("[user] hello");
    expect(result).toContain("[assistant] hi there");
  });

  it("parses json session arrays", async () => {
    const file = await writeTempSession(
      ".json",
      JSON.stringify([
        { role: "user", content: "json content" },
        { role: "assistant", content: "json reply" }
      ])
    );

    const result = await handleSessionExportFailure(file, new Error("export failed"));

    expect(result).toContain("[user] json content");
    expect(result).toContain("[assistant] json reply");
  });

  it("returns raw markdown for .md sessions", async () => {
    const file = await writeTempSession(".md", "# Session Notes\nDetails here.");

    const result = await handleSessionExportFailure(file, new Error("export failed"));

    expect(result?.startsWith("# Session Notes")).toBeTrue();
  });
});

describe("cassExport fallback integration", () => {
  it("falls back to direct parsing when cass binary is missing", async () => {
    const file = await writeTempSession(
      ".jsonl",
      JSON.stringify({ type: "user", content: "fallback check" })
    );

    const result = await cassExport(file, "text", "/nonexistent/cass");

    expect(result).toContain("fallback check");
  });
});
