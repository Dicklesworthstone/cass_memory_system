import { describe, test, expect, afterEach } from "bun:test";
import {
  compareSemver,
  normalizeVersion,
  parseSemver,
  fetchLatestRelease,
  updateCommand,
  LATEST_RELEASE_API_URL,
  INSTALL_COMMAND,
  UPDATE_REPO,
} from "../src/commands/update.js";
import { getVersion } from "../src/utils.js";

async function captureConsoleLog<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };

  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async (url: any, _init?: any) => {
    expect(String(url)).toBe(LATEST_RELEASE_API_URL);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("update command", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  describe("normalizeVersion", () => {
    test("strips a leading v and whitespace", () => {
      expect(normalizeVersion("v0.2.14")).toBe("0.2.14");
      expect(normalizeVersion("V1.0.0")).toBe("1.0.0");
      expect(normalizeVersion("  0.2.14 ")).toBe("0.2.14");
    });

    test("leaves already-normalized versions alone", () => {
      expect(normalizeVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
    });
  });

  describe("parseSemver", () => {
    test("parses full versions", () => {
      expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    });

    test("defaults missing minor/patch to zero", () => {
      expect(parseSemver("v2")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
      expect(parseSemver("2.1")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: [] });
    });

    test("parses prerelease identifiers and ignores build metadata", () => {
      expect(parseSemver("1.0.0-rc.1+build.5")).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: ["rc", "1"],
      });
    });

    test("returns null for garbage", () => {
      expect(parseSemver("not-a-version")).toBeNull();
      expect(parseSemver("")).toBeNull();
    });
  });

  describe("compareSemver", () => {
    test("orders by major, minor, patch", () => {
      expect(compareSemver("0.2.13", "0.2.14")).toBe(-1);
      expect(compareSemver("0.2.14", "0.2.13")).toBe(1);
      expect(compareSemver("0.2.14", "0.2.14")).toBe(0);
      expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
      expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
      expect(compareSemver("0.2.9", "0.2.10")).toBe(-1);
    });

    test("treats a leading v as equivalent", () => {
      expect(compareSemver("v0.2.14", "0.2.14")).toBe(0);
      expect(compareSemver("v0.2.13", "v0.2.14")).toBe(-1);
    });

    test("release sorts after its prereleases", () => {
      expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
      expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    });

    test("compares prerelease identifiers numerically and lexically", () => {
      expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
      expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
      expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
      // Numeric identifiers sort before alphanumeric identifiers
      expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    });

    test("unparseable versions compare as 0.0.0", () => {
      expect(compareSemver("garbage", "0.0.1")).toBe(-1);
      expect(compareSemver("garbage", "garbage")).toBe(0);
    });
  });

  describe("fetchLatestRelease", () => {
    test("returns normalized version, tag, and url", async () => {
      const info = await fetchLatestRelease(
        stubFetch({ tag_name: "v9.9.9", html_url: "https://example.com/rel" })
      );
      expect(info.version).toBe("9.9.9");
      expect(info.tag).toBe("v9.9.9");
      expect(info.url).toBe("https://example.com/rel");
    });

    test("falls back to a constructed release url", async () => {
      const info = await fetchLatestRelease(stubFetch({ tag_name: "v1.2.3" }));
      expect(info.url).toBe(`https://github.com/${UPDATE_REPO}/releases/tag/v1.2.3`);
    });

    test("throws on HTTP errors", async () => {
      await expect(fetchLatestRelease(stubFetch({}, 500))).rejects.toThrow(/HTTP 500/);
    });

    test("throws when tag_name is missing", async () => {
      await expect(fetchLatestRelease(stubFetch({ html_url: "x" }))).rejects.toThrow(/tag_name/);
    });
  });

  describe("updateCommand --check", () => {
    test("reports up to date with exit code 0 when latest matches current", async () => {
      process.exitCode = 0;
      const { output } = await captureConsoleLog(() =>
        updateCommand(
          { check: true, json: true },
          { fetchImpl: stubFetch({ tag_name: `v${getVersion()}` }) }
        )
      );
      const envelope = JSON.parse(output);
      expect(envelope.success).toBe(true);
      expect(envelope.data.updateAvailable).toBe(false);
      expect(envelope.data.currentVersion).toBe(getVersion());
      expect(process.exitCode).toBe(0);
    });

    test("reports update available with exit code 1 when a newer release exists", async () => {
      process.exitCode = 0;
      const { output } = await captureConsoleLog(() =>
        updateCommand(
          { check: true, json: true },
          { fetchImpl: stubFetch({ tag_name: "v999.0.0" }) }
        )
      );
      const envelope = JSON.parse(output);
      expect(envelope.success).toBe(true);
      expect(envelope.data.updateAvailable).toBe(true);
      expect(envelope.data.latestVersion).toBe("999.0.0");
      expect(envelope.data.installCommand).toBe(INSTALL_COMMAND);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("updateCommand non-interactive update", () => {
    test("prints instructions instead of running the installer", async () => {
      process.exitCode = 0;
      const { output } = await captureConsoleLog(() =>
        updateCommand(
          { json: true, interactive: false },
          { fetchImpl: stubFetch({ tag_name: "v999.0.0" }) }
        )
      );
      const envelope = JSON.parse(output);
      expect(envelope.success).toBe(true);
      expect(envelope.data.updated).toBe(false);
      expect(envelope.data.installCommand).toBe(INSTALL_COMMAND);
      expect(envelope.data.reason).toMatch(/non-interactive/);
      expect(process.exitCode).toBe(1);
    });

    test("does nothing when already up to date", async () => {
      process.exitCode = 0;
      const { output } = await captureConsoleLog(() =>
        updateCommand(
          { json: true, interactive: false },
          { fetchImpl: stubFetch({ tag_name: `v${getVersion()}` }) }
        )
      );
      const envelope = JSON.parse(output);
      expect(envelope.success).toBe(true);
      expect(envelope.data.updateAvailable).toBe(false);
      expect(envelope.data.updated).toBe(false);
      expect(process.exitCode).toBe(0);
    });
  });
});
