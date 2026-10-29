import { describe, expect, test } from "bun:test";
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

describe("Commander output survives immediate process exit", () => {
  const cmPath = path.join(import.meta.dir, "..", "src", "cm.ts");
  const endMarker = "COMPLETE_DIAGNOSTIC_END";
  const payload = "x".repeat(2 * 1024 * 1024) + "\n" + endMarker;
  const scriptPrelude = `
    import { createProgram } from ${JSON.stringify(cmPath)};
    const program = createProgram(["bun", "cm"]);
    const payload = "x".repeat(2 * 1024 * 1024) + "\\n" + ${JSON.stringify(endMarker)};
  `;

  async function runScript(script: string) {
    const proc = Bun.spawn([process.execPath, "-e", scriptPrelude + script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  for (const args of [[], ["playbook", "repair"]]) {
    test(`flushes complete ${args.length ? "nested subcommand" : "root"} help to stdout`, async () => {
      const { stdout, stderr, exitCode } = await runScript(`
        const args = ${JSON.stringify(args)};
        let target = program;
        for (const name of args) target = target.commands.find((command) => command.name() === name);
        target.addHelpText("after", payload);
        await program.parseAsync(["bun", "cm", ...args, "--help"]);
      `);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.includes(payload)).toBe(true);
      expect(stdout.endsWith(endMarker + "\n")).toBe(true);
    });
  }

  test("flushes complete subcommand failure to stderr while preserving nonzero exit status", async () => {
    const { stdout, stderr, exitCode } = await runScript(`
      const playbook = program.commands.find((command) => command.name() === "playbook");
      const repair = playbook.commands.find((command) => command.name() === "repair");
      repair.error(payload);
    `);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr === payload + "\n").toBe(true);
  });
});
