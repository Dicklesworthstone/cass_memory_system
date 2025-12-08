import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";

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
    LLM_DISABLED: "1",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };

  const cm = (args: string[]) =>
    $({ env, stdin: "inherit", stdout: "pipe", stderr: "pipe" })`bun run src/cm.ts ${args}`;

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
    const init = await cm(["init"]);
    expect(init.exitCode).toBe(0);

    // 2) context (degraded)
    const ctx = await cm(["context", "hello world", "--json"]);
    expect(ctx.exitCode).toBe(0);
    const ctxOut = ctx.stdout.toString();
    expect(ctxOut).toContain("Context");
    // In degraded mode, historySnippets should be empty; parse json result
    const parsed = JSON.parse(ctxOut);
    expect(parsed.historySnippets.length).toBe(0);

    // 3) add rule
    const add = await cm(["playbook", "add", "Always write atomically", "--category", "io", "--json"]);
    expect(add.exitCode).toBe(0);
    const addOut = JSON.parse(add.stdout.toString());
    const bulletId = addOut?.bullet?.id ?? addOut?.id ?? addOut?.bulletId;
    expect(typeof bulletId).toBe("string");

    // 4) mark helpful
    const mark = await cm(["mark", bulletId, "--helpful", "--session", "smoke-1", "--json"]);
    expect(mark.exitCode).toBe(0);

    // 5) list and assert helpful count increments
    const list = await cm(["playbook", "list", "--json"]);
    expect(list.exitCode).toBe(0);
    const bullets = JSON.parse(list.stdout.toString());
    const added = bullets.find((b: any) => b.id === bulletId);
    expect(added).toBeTruthy();
    expect(added.helpfulCount || added.helpful_count || 0).toBeGreaterThanOrEqual(1);
  });
});

