import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDir } from "./helpers/temp.js";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const artifact = "#!/bin/sh\nprintf '%s\\n' 'downloaded-release'\n";
const digest = createHash("sha256").update(artifact).digest("hex");
const customArtifact = "https://example.test/custom/cm";
const customChecksum = "https://example.test/checksum";

interface InstallScenario {
  args?: string[];
  env?: Record<string, string>;
  os?: string;
  gnuLibc?: boolean;
  ldd?: "gnu" | "musl" | "unknown" | "absent";
  muslLoader?: boolean;
  failArtifact?: boolean;
  failChecksum?: boolean;
  checksumText?: string;
  checksumTool?: "sha256sum" | "shasum" | "none";
  failDependencies?: boolean;
  existingBinary?: boolean;
}

function executable(version: string): string {
  return `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
}

/** Run the complete installer without external network or package installation.
 * Git clones a real fixture repository so tests observe the selected release's
 * installed bytes, not just the presence of a particular command-line option.
 */
async function runInstaller(scenario: InstallScenario = {}) {
  return withTempDir("cm-installer", async (dir) => {
    const bash = Bun.which("bash");
    const git = Bun.which("git");
    if (!bash || !git) throw new Error("Installer tests require Bash and Git");

    const bin = path.join(dir, "commands");
    const source = path.join(dir, "release repo");
    const dest = path.join(dir, "installed binaries");
    const home = path.join(dir, "home");
    const temp = path.join(dir, "installer temp");
    const log = path.join(dir, "commands.log");
    await Promise.all([bin, source, dest, home, temp].map((entry) => mkdir(entry)));
    await writeFile(log, "");
    await writeFile(path.join(dir, "artifact"), artifact);
    await writeFile(path.join(dir, "checksum"), scenario.checksumText ?? `${digest}  cm\n`);
    if (scenario.existingBinary) {
      await writeFile(path.join(dest, "cm"), executable("existing-install"), { mode: 0o755 });
    }

    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const runGit = (...args: string[]) => {
      const result = Bun.spawnSync([git, ...args], {
        cwd: source,
        env: gitEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    runGit("init", "-q", "-b", "main");
    runGit("config", "user.name", "Installer fixture");
    runGit("config", "user.email", "installer@example.test");
    for (const version of ["v1.2.3", "v9.8.7", "unreleased-main"]) {
      await writeFile(path.join(source, "release-binary"), executable(version));
      runGit("add", "release-binary");
      runGit("commit", "-q", "-m", version);
      if (version.startsWith("v")) runGit("tag", version);
    }

    // A whitelist prevents the installer from finding ambient download/build
    // tools or touching the host's installation lock via flock.
    for (const command of [
      "awk", "basename", "cat", "chmod", "cp", "grep", "install", "mkdir", "mktemp", "rm", "tr",
    ]) {
      const resolved = Bun.which(command);
      if (!resolved) throw new Error(`Missing installer utility: ${command}`);
      await symlink(resolved, path.join(bin, command));
    }
    const checksumTool = scenario.checksumTool ?? (Bun.which("sha256sum") ? "sha256sum" : "shasum");
    if (checksumTool !== "none") {
      const resolved = Bun.which(checksumTool);
      if (!resolved) throw new Error(`Missing checksum utility: ${checksumTool}`);
      await symlink(resolved, path.join(bin, checksumTool));
    }

    const command = async (name: string, body: string) => {
      const file = path.join(bin, name);
      await writeFile(file, `#!${bash}\nset -euo pipefail\n${body}\n`);
      await chmod(file, 0o755);
    };
    await command("uname", `case "$1" in -s) printf '%s\\n' "$FIXTURE_OS" ;; -m) echo x86_64 ;; *) exit 90 ;; esac`);
    await command("getconf", `printf 'getconf %s\\n' "$*" >> "$FIXTURE_LOG"
[ "$FIXTURE_GNU" = 1 ] || exit 1
echo 'glibc 2.43'`);
    if (scenario.ldd !== "absent") {
      await command("ldd", `printf 'ldd %s\\n' "$*" >> "$FIXTURE_LOG"
case "$FIXTURE_LDD" in
  gnu) echo 'ldd (GNU libc) 2.43' ;;
  musl) echo 'musl libc (x86_64)' >&2; exit 1 ;;
  *) echo 'unknown libc'; exit 1 ;;
esac`);
    }
    await command("ls", `printf 'ls %s\\n' "$*" >> "$FIXTURE_LOG"
[ "$FIXTURE_MUSL_LOADER" = 1 ]`);
    await command("curl", `url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w|-A|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    https://*) url="$1"; shift ;;
    *) exit 91 ;;
  esac
done
printf 'curl %s\\n' "$url" >> "$FIXTURE_LOG"
case "$url" in
  */releases/latest)
    printf '%s\\n' 'https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v9.8.7' ;;
  *.sha256|*/checksum)
    [ "$FIXTURE_FAIL_CHECKSUM" = 0 ] || exit 22
    cp "$FIXTURE_ROOT/checksum" "$output" ;;
  *)
    [ "$FIXTURE_FAIL_ARTIFACT" = 0 ] || exit 22
    cp "$FIXTURE_ROOT/artifact" "$output" ;;
esac`);
    await command("git", `printf 'git %s\\n' "$*" >> "$FIXTURE_LOG"
[ "$1" = clone ] || exit 92
args=("$@")
found=0
for index in "\${!args[@]}"; do
  if [ "\${args[$index]}" = 'https://github.com/Dicklesworthstone/cass_memory_system.git' ]; then
    args[$index]="file://$FIXTURE_REPO"
    found=1
  fi
done
[ "$found" = 1 ] || exit 93
exec "$FIXTURE_GIT" "\${args[@]}"`);
    await command("bun", `printf 'bun %s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  install) [ "$FIXTURE_FAIL_DEPENDENCIES" = 0 ] || exit 94 ;;
  run)
    [ "$2" = build ] || exit 95
    mkdir -p dist
    cp release-binary dist/cass-memory
    chmod +x dist/cass-memory ;;
  *) exit 96 ;;
esac`);

    const result = Bun.spawnSync([bash, installer, "--dest", dest, ...(scenario.args ?? [])], {
      cwd: dir,
      env: {
        ...gitEnv,
        PATH: bin,
        HOME: home,
        TMPDIR: temp,
        VERSION: "",
        OWNER: "Dicklesworthstone",
        REPO: "cass_memory_system",
        DEST: "",
        ARTIFACT_URL: "",
        CHECKSUM: "",
        CHECKSUM_URL: "",
        FIXTURE_ROOT: dir,
        FIXTURE_LOG: log,
        FIXTURE_REPO: source,
        FIXTURE_GIT: git,
        FIXTURE_OS: scenario.os ?? "Linux",
        FIXTURE_GNU: scenario.gnuLibc === false ? "0" : "1",
        FIXTURE_LDD: scenario.ldd ?? "gnu",
        FIXTURE_MUSL_LOADER: scenario.muslLoader ? "1" : "0",
        FIXTURE_FAIL_ARTIFACT: scenario.failArtifact ? "1" : "0",
        FIXTURE_FAIL_CHECKSUM: scenario.failChecksum ? "1" : "0",
        FIXTURE_FAIL_DEPENDENCIES: scenario.failDependencies ? "1" : "0",
        ...scenario.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const installed = Bun.file(path.join(dest, "cm"));
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      commands: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean),
      installed: (await installed.exists()) ? await installed.text() : null,
    };
  });
}

const posixDescribe = process.platform === "win32" ? describe.skip : describe;

posixDescribe("release installer", () => {
  for (const scenario of [
    { name: "GNU getconf wins over a side-by-side musl loader", gnuLibc: true, ldd: "musl" as const },
    { name: "GNU ldd wins over a side-by-side musl loader", gnuLibc: false, ldd: "gnu" as const },
  ]) {
    test(scenario.name, async () => {
      const result = await runInstaller({ ...scenario, muslLoader: true, args: ["--version", "v1.2.3"] });
      expect(result.exitCode).toBe(0);
      expect(result.installed).toBe(artifact);
      expect(result.output).toContain("Checksum verified");
      expect(result.commands.some((entry) => entry.startsWith("git "))).toBe(false);
      expect(result.commands).toContain("curl https://github.com/Dicklesworthstone/cass_memory_system/releases/download/v1.2.3/cass-memory-linux-x64");
    });
  }

  test("non-Linux platforms do not consult libc probes", async () => {
    const result = await runInstaller({ os: "Darwin", gnuLibc: false, ldd: "musl", muslLoader: true });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(artifact);
    expect(result.commands.some((entry) => /^(getconf|ldd|ls|git) /.test(entry))).toBe(false);
    expect(result.commands.some((entry) => entry.endsWith("/cass-memory-macos-x64"))).toBe(true);
  });

  for (const ldd of ["musl", "absent"] as const) {
    test(`musl source fallback selects the requested release (${ldd} ldd)`, async () => {
      const result = await runInstaller({ gnuLibc: false, ldd, muslLoader: true, args: ["--version", "v1.2.3"] });
      expect(result.exitCode).toBe(0);
      expect(result.installed).toBe(executable("v1.2.3"));
      expect(result.commands).toContain("bun install --frozen-lockfile");
      expect(result.commands.some((entry) => entry.startsWith("curl "))).toBe(false);
    });
  }

  test("explicit source builds install the selected tag instead of unreleased main", async () => {
    const result = await runInstaller({ args: ["--from-source", "--version", "v1.2.3"] });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(executable("v1.2.3"));
    expect(result.commands).toContain("bun install --frozen-lockfile");
    expect(result.output).toContain("Building release v1.2.3 from source");
    expect(result.commands.some((entry) => entry.startsWith("curl "))).toBe(false);
  });

  test("source builds honor VERSION from the environment", async () => {
    const result = await runInstaller({ args: ["--from-source"], env: { VERSION: "v1.2.3" } });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(executable("v1.2.3"));
  });

  test("source builds resolve latest once without downloading a release artifact", async () => {
    const result = await runInstaller({ args: ["--from-source"] });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(executable("v9.8.7"));
    expect(result.commands.filter((entry) => entry.startsWith("curl "))).toEqual([
      "curl https://github.com/Dicklesworthstone/cass_memory_system/releases/latest",
    ]);
  });

  test("failed release downloads preserve the version during source fallback", async () => {
    const result = await runInstaller({ failArtifact: true, args: ["--version", "v1.2.3"] });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(executable("v1.2.3"));
    expect(result.output).toContain("falling back to build-from-source");
  });

  test("a missing source ref never falls back to main", async () => {
    const result = await runInstaller({ args: ["--from-source", "--version", "v-does-not-exist"] });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeNull();
    expect(result.commands.filter((entry) => entry.startsWith("git "))).toHaveLength(1);
    expect(result.commands.some((entry) => entry.startsWith("bun "))).toBe(false);
  });

  test("failed frozen dependency installation stops before building or replacing cm", async () => {
    const result = await runInstaller({ args: ["--from-source"], failDependencies: true, existingBinary: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBe(executable("existing-install"));
    expect(result.commands.filter((entry) => entry.startsWith("bun "))).toEqual(["bun install --frozen-lockfile"]);
  });

  for (const viaEnv of [false, true]) {
    test(`custom artifact failure cannot substitute repository source (${viaEnv ? "env" : "CLI"})`, async () => {
      const result = await runInstaller({
        failArtifact: true,
        args: viaEnv ? [] : ["--artifact-url", customArtifact],
        env: viaEnv ? { ARTIFACT_URL: customArtifact } : {},
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.installed).toBeNull();
      expect(result.commands).toEqual([`curl ${customArtifact}`]);
    });

    for (const [flag, envKey, value] of [
      ["--artifact-url", "ARTIFACT_URL", customArtifact],
      ["--checksum", "CHECKSUM", digest],
      ["--checksum-url", "CHECKSUM_URL", customChecksum],
    ]) {
      test(`source mode rejects ${flag} constraints (${viaEnv ? "env" : "CLI"})`, async () => {
        const result = await runInstaller({
          args: ["--from-source", ...(viaEnv ? [] : [flag, value])],
          env: viaEnv ? { [envKey]: value } : {},
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.installed).toBeNull();
        expect(result.output).toContain("Source builds cannot satisfy");
        expect(result.commands.some((entry) => /^(git|bun) /.test(entry))).toBe(false);
      });
    }

    test(`a valid explicit checksum verifies the downloaded bytes (${viaEnv ? "env" : "CLI"})`, async () => {
      const result = await runInstaller({
        args: ["--artifact-url", customArtifact, ...(viaEnv ? [] : ["--checksum", digest])],
        env: viaEnv ? { CHECKSUM: digest } : {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.installed).toBe(artifact);
      expect(result.output).toContain("Checksum verified");
      expect(result.commands).toEqual([`curl ${customArtifact}`]);
    });

    test(`an explicit checksum URL must download successfully (${viaEnv ? "env" : "CLI"})`, async () => {
      const result = await runInstaller({
        failChecksum: true,
        args: viaEnv ? [] : ["--checksum-url", customChecksum],
        env: viaEnv ? { CHECKSUM_URL: customChecksum } : {},
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.installed).toBeNull();
      expect(result.output).toContain("Could not download the requested checksum");
      expect(result.commands.some((entry) => entry.startsWith("git "))).toBe(false);
    });
  }

  test("automatic musl fallback cannot discard a requested binary checksum", async () => {
    const result = await runInstaller({ gnuLibc: false, ldd: "musl", env: { CHECKSUM: digest } });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeNull();
    expect(result.commands.some((entry) => /^(git|bun) /.test(entry))).toBe(false);
  });

  test("a failed release download cannot discard a requested checksum", async () => {
    const result = await runInstaller({ failArtifact: true, args: ["--checksum", digest] });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeNull();
    expect(result.commands.some((entry) => /^(git|bun) /.test(entry))).toBe(false);
  });

  test("checksum mismatch preserves an existing installation", async () => {
    const result = await runInstaller({ args: ["--checksum", "0".repeat(64)], existingBinary: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Checksum mismatch");
    expect(result.installed).toBe(executable("existing-install"));
  });

  for (const checksumText of ["", "not-a-checksum\n", `${digest}  first\n${digest}  second\n`]) {
    test(`requested checksum files must contain one valid digest: ${JSON.stringify(checksumText.slice(0, 20))}`, async () => {
      const result = await runInstaller({ checksumText, args: ["--checksum-url", customChecksum] });
      expect(result.exitCode).not.toBe(0);
      expect(result.installed).toBeNull();
    });
  }

  test("missing checksum tools cannot bypass an explicit digest", async () => {
    const result = await runInstaller({ checksumTool: "none", env: { CHECKSUM: digest } });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeNull();
    expect(result.output).toContain("Cannot verify the requested checksum");
  });

  test.skipIf(!Bun.which("shasum"))("shasum verifies explicit checksums when sha256sum is unavailable", async () => {
    const result = await runInstaller({ checksumTool: "shasum", args: ["--checksum", digest] });
    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(artifact);
    expect(result.output).toContain("Checksum verified");
  });

  test("empty explicit checksum values are rejected before downloading", async () => {
    const result = await runInstaller({ args: ["--checksum", ""] });
    expect(result.exitCode).not.toBe(0);
    expect(result.installed).toBeNull();
    expect(result.commands).toEqual([]);
  });
});
