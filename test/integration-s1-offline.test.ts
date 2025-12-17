import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

/**
 * Scenario S1: Offline Smoke (no cass/LLM)
 * Steps:
 * 1) cm init
 * 2) cm context "hello world" (should degrade: playbook-only)
 * 3) cm playbook add "Always write atomically" --category io
 * 4) cm mark <bullet-id> --helpful --session smoke-1
 * 5) cm playbook list --json
 */

describe("S1 Offline Smoke (no cass, no LLM)", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cm-s1-"));
  const env = {
    ...process.env,
    HOME: tmpRoot,
    CASS_PATH: "__missing__",
    CASS_MEMORY_LLM: "none",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };

  const runCm = async (args: string[]) => {
    const proc = Bun.spawn(["bun", "run", "src/cm.ts", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };

  beforeAll(() => {
    // Ensure ~/.cass-memory does not exist before running
    try {
      rmSync(path.join(tmpRoot, ".cass-memory"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("runs degraded flow and records playbook updates", async () => {
    // 1) init
    const init = await runCm(["init"]);
    expect(init.exitCode).toBe(0);

    // 2) context (degraded)
    const ctx = await runCm(["context", "hello world", "--json"]);
    expect(ctx.exitCode).toBe(0);
    const ctxOut = ctx.stdout.toString();
    // In degraded mode, historySnippets should be empty; parse json result
    const parsed = JSON.parse(ctxOut) as any;
    expect(parsed.data.task).toBe("hello world");
    expect(parsed.data.historySnippets.length).toBe(0);

    // 3) add rule
    const add = await runCm(["playbook", "add", "Always write atomically", "--category", "io", "--json"]);
    expect(add.exitCode).toBe(0);
    const addOut = JSON.parse(add.stdout.toString()) as any;
    const bulletId =
      addOut?.data?.bullet?.id ??
      addOut?.data?.id ??
      addOut?.data?.bulletId ??
      addOut?.bullet?.id ??
      addOut?.id ??
      addOut?.bulletId;
    expect(typeof bulletId).toBe("string");

    // 4) mark helpful
    const mark = await runCm(["mark", bulletId, "--helpful", "--session", "smoke-1", "--json"]);
    expect(mark.exitCode).toBe(0);

    // 5) list and assert helpful count increments
    const list = await runCm(["playbook", "list", "--json"]);
    expect(list.exitCode).toBe(0);
    const listResponse = JSON.parse(list.stdout.toString()) as any;
    const added = listResponse.data.bullets.find((b: any) => b.id === bulletId);
    expect(added).toBeTruthy();
    expect(added.helpfulCount || added.helpful_count || 0).toBeGreaterThanOrEqual(1);
  }, 20000);
});
