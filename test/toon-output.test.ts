import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { __setStdoutSinkForTests, isToonOutput, printToon } from "../src/utils.js";

describe("TOON output helpers", () => {
  const envKeys = [
    "CM_OUTPUT_FORMAT",
    "TOON_DEFAULT_FORMAT",
    "TOON_TRU_BIN",
    "TOON_BIN",
    "TOON_STATS",
  ] as const;
  const originalValues: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalValues[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("respects env defaults and --json override", () => {
    process.env.CM_OUTPUT_FORMAT = "toon";
    expect(isToonOutput({})).toBe(true);

    // Explicit --json beats env (TOON is only selected for non-JSON output).
    expect(isToonOutput({ json: true })).toBe(false);

    // Explicit --format beats --json.
    expect(isToonOutput({ json: true, format: "toon" })).toBe(true);
  });

  it("rejects Node 'toon' and uses toon_rust tru for encoding", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];

    // Use `require` here to patch the exact module instance used by src/utils.ts.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const childProcess = require("child_process");

    const spawnSpy = spyOn(childProcess, "spawnSync").mockImplementation((...callArgs: any[]) => {
      const cmdStr = String(callArgs[0]);
      const argv = Array.isArray(callArgs[1]) ? callArgs[1].map(String) : [];
      calls.push({ cmd: cmdStr, args: argv });

      const sub = argv[0] ?? "";
      if (sub === "--help") {
        // Only `tru` should look like toon_rust.
        return (
          cmdStr === "tru"
            ? {
                pid: 0,
                output: [],
                stdout: "tru - reference implementation in rust",
                stderr: "",
                status: 0,
                signal: null,
              }
            : {
                pid: 0,
                output: [],
                stdout: "node toon cli",
                stderr: "",
                status: 0,
                signal: null,
              }
        ) as any;
      }
      if (sub === "--version") {
        return (
          cmdStr === "tru"
            ? {
                pid: 0,
                output: [],
                stdout: "tru 0.1.0",
                stderr: "",
                status: 0,
                signal: null,
              }
            : {
                pid: 0,
                output: [],
                stdout: "toon 9.9.9",
                stderr: "",
                status: 0,
                signal: null,
              }
        ) as any;
      }
      if (sub === "--encode") {
        return {
          pid: 0,
          output: [],
          stdout: "k=v\n",
          stderr: "",
          status: 0,
          signal: null,
        } as any;
      }
      return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null } as any;
    });

    let output = "";
    __setStdoutSinkForTests((text) => {
      output += text;
    });

    // Ensure we don't accept Node `toon` as the encoder.
    process.env.TOON_TRU_BIN = "toon";

    try {
      printToon({ a: 1 }, { fallbackToJson: false });

      // The encode step must use `tru`, not `toon`.
      const encodeCall = calls.find((c) => c.args[0] === "--encode");
      expect(encodeCall?.cmd).toBe("tru");

      // And the encoded output reaches the structured stdout sink unchanged.
      expect(output).toBe("k=v\n");
    } finally {
      __setStdoutSinkForTests(null);
      spawnSpy.mockRestore();
    }
  });

  // toon_rust v0.2.0+ ships its binary as `toon` (GH #86). Real `toon --help` / `--version`
  // output from toon_rust 0.2.4 and a stand-in for the unrelated npm `@toon-format/cli`.
  const TOON_RUST_HELP = "TOON reference implementation in Rust (JSON <-> TOON)\n\nUsage: toon";
  const OTHER_TOON_HELP = "toon - Convert JSON to TOON\n\nUSAGE: toon [OPTIONS]";

  function mockSpawn(
    binaries: Record<string, { help: string; version: string }>,
    calls: Array<{ cmd: string; args: string[]; opts: any }>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const childProcess = require("child_process");
    return spyOn(childProcess, "spawnSync").mockImplementation((...callArgs: any[]) => {
      const cmdStr = String(callArgs[0]);
      const argv = Array.isArray(callArgs[1]) ? callArgs[1].map(String) : [];
      calls.push({ cmd: cmdStr, args: argv, opts: callArgs[2] });
      const bin = binaries[cmdStr];
      const base = { pid: 0, output: [], stderr: "", signal: null };
      if (!bin) {
        return { ...base, stdout: "", status: null, error: new Error(`ENOENT ${cmdStr}`) } as any;
      }
      const sub = argv[0] ?? "";
      if (sub === "--help") return { ...base, stdout: bin.help, status: 0 } as any;
      if (sub === "--version") return { ...base, stdout: bin.version, status: 0 } as any;
      if (sub === "--encode")
        return { ...base, stdout: `encoded-by:${cmdStr}\n`, status: 0 } as any;
      return { ...base, stdout: "", status: 0 } as any;
    });
  }

  function encodeWith(binaries: Record<string, { help: string; version: string }>) {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const spawnSpy = mockSpawn(binaries, calls);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let output = "";
    __setStdoutSinkForTests((text) => {
      output += text;
    });
    try {
      printToon({ a: 1 }, { fallbackToJson: false });
      return { calls, output, errors: errorSpy.mock.calls.map((c) => String(c[0])) };
    } finally {
      __setStdoutSinkForTests(null);
      errorSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  }

  it("finds toon_rust installed as `toon` on PATH (GH #86)", () => {
    const { calls, output } = encodeWith({
      toon: { help: TOON_RUST_HELP, version: "toon 0.2.4" },
    });
    expect(calls.find((c) => c.args[0] === "--encode")?.cmd).toBe("toon");
    expect(output).toBe("encoded-by:toon\n");
  });

  it("accepts TOON_TRU_BIN pointing at toon_rust's `toon` binary", () => {
    process.env.TOON_TRU_BIN = "/opt/toon_rust/bin/toon";
    const { calls, errors } = encodeWith({
      "/opt/toon_rust/bin/toon": { help: TOON_RUST_HELP, version: "toon 0.2.4" },
    });
    expect(calls.find((c) => c.args[0] === "--encode")?.cmd).toBe("/opt/toon_rust/bin/toon");
    expect(errors.some((e) => e.includes("does not look like toon_rust"))).toBe(false);
  });

  it("prefers `toon` over a leftover `tru` when both are installed", () => {
    const { calls } = encodeWith({
      toon: { help: TOON_RUST_HELP, version: "toon 0.2.4" },
      tru: { help: "tru - TOON reference implementation in Rust", version: "tru 0.1.0" },
    });
    expect(calls.find((c) => c.args[0] === "--encode")?.cmd).toBe("toon");
  });

  it("skips a non-toon_rust `toon` on PATH and falls through to `tru`", () => {
    const { calls } = encodeWith({
      toon: { help: OTHER_TOON_HELP, version: "toon 9.9.9" },
      tru: { help: "tru - TOON reference implementation in Rust", version: "tru 0.1.0" },
    });
    expect(calls.find((c) => c.args[0] === "--encode")?.cmd).toBe("tru");
  });

  it("never accepts a `toon` whose only evidence is a `toon <version>` line", () => {
    process.env.TOON_TRU_BIN = "toon";
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const spawnSpy = mockSpawn({ toon: { help: OTHER_TOON_HELP, version: "toon 9.9.9" } }, calls);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => printToon({ a: 1 }, { fallbackToJson: false })).toThrow(
        "toon_rust binary (toon) not found",
      );
      expect(calls.some((c) => c.args[0] === "--encode")).toBe(false);
      // Every identification probe is bounded so a hung candidate cannot stall cm.
      const probes = calls.filter((c) => c.args[0] === "--help" || c.args[0] === "--version");
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) expect(p.opts?.timeout).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });
});
