import { describe, test, expect } from "bun:test";
import path from "node:path";

// Regression test for #50: `cm context --json` truncated its stdout mid-JSON
// for payloads larger than ~64KB because the async stdout stream had not
// drained when the process exited. writeStdoutSync writes straight to fd 1 and
// blocks until every byte is flushed, so a spawned process that exits right
// after the write must still deliver the whole document to a piped reader.
describe("writeStdoutSync (no truncation on large payloads, #50)", () => {
  const utilsPath = path.join(import.meta.dir, "..", "src", "utils.ts");

  test("delivers a large JSON payload to a piped reader in full", async () => {
    const script = `
      import { writeStdoutSync } from ${JSON.stringify(utilsPath)};
      const bullets = [];
      for (let i = 0; i < 3000; i++) {
        bullets.push({
          id: "bullet-" + i,
          content: "x".repeat(200),
          feedbackEvents: Array.from({ length: 5 }, (_, j) => ({
            timestamp: new Date(0).toISOString(),
            decayedValue: j / 5,
          })),
        });
      }
      writeStdoutSync(JSON.stringify({ bullets }, null, 2) + "\\n");
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    // Comfortably past the ~64KB boundary where the original bug truncated.
    expect(out.length).toBeGreaterThan(256 * 1024);

    // The whole document must parse — truncation left it unparseable mid-field.
    const parsed = JSON.parse(out) as { bullets: unknown[] };
    expect(parsed.bullets.length).toBe(3000);
  });
});
