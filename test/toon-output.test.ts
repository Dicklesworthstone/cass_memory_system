import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  __setStdoutSinkForTests,
  isToonOutput,
  printToon,
} from "../src/utils.js";

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
          return (cmdStr === "tru"
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
              }) as any;
        }
        if (sub === "--version") {
          return (cmdStr === "tru"
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
              }) as any;
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
});
