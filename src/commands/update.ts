import chalk from "chalk";
import { spawn } from "node:child_process";
import { getCliName, getVersion, printJsonResult, reportError } from "../utils.js";
import { iconPrefix, formatTipPrefix } from "../output.js";

export const UPDATE_REPO = "Dicklesworthstone/cass_memory_system";
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const INSTALL_COMMAND =
  `curl -fsSL "https://raw.githubusercontent.com/${UPDATE_REPO}/main/install.sh" | bash -s -- --easy-mode --verify`;

export interface UpdateOptions {
  check?: boolean;
  json?: boolean;
  interactive?: boolean;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/**
 * Normalize a version string: trim whitespace and strip a leading "v"/"V".
 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

/**
 * Parse a semver-ish version string. Returns null when the string is not
 * recognizable as X[.Y[.Z]][-prerelease] (build metadata after "+" is ignored).
 */
export function parseSemver(version: string): ParsedSemver | null {
  const normalized = normalizeVersion(version);
  const withoutBuild = normalized.split("+")[0] ?? "";
  const match = withoutBuild.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: match[2] !== undefined ? Number.parseInt(match[2], 10) : 0,
    patch: match[3] !== undefined ? Number.parseInt(match[3], 10) : 0,
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease sorts AFTER any prerelease (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    // Shorter prerelease list sorts first when all prior identifiers are equal.
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum) {
      // Numeric identifiers sort before alphanumeric ones.
      return -1;
    } else if (bNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two semver strings.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 * Unparseable versions compare as 0.0.0 (i.e., older than anything real).
 */
export function compareSemver(a: string, b: string): number {
  const zero: ParsedSemver = { major: 0, minor: 0, patch: 0, prerelease: [] };
  const pa = parseSemver(a) ?? zero;
  const pb = parseSemver(b) ?? zero;

  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const pre = comparePrerelease(pa.prerelease, pb.prerelease);
  if (pre !== 0) return pre < 0 ? -1 : 1;
  return 0;
}

export interface LatestReleaseInfo {
  version: string;
  tag: string;
  url: string;
}

/**
 * Fetch the latest release from GitHub. Injectable fetch for tests.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch
): Promise<LatestReleaseInfo> {
  const response = await fetchImpl(LATEST_RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API returned HTTP ${response.status} while checking the latest release`
    );
  }
  const body = (await response.json()) as { tag_name?: string; html_url?: string };
  const tag = body?.tag_name;
  if (!tag || typeof tag !== "string") {
    throw new Error("GitHub API response did not include a tag_name for the latest release");
  }
  return {
    version: normalizeVersion(tag),
    tag,
    url:
      typeof body.html_url === "string" && body.html_url
        ? body.html_url
        : `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
  };
}

function isInteractiveSession(options: UpdateOptions): boolean {
  if (options.interactive === false) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function runInstallScript(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", INSTALL_COMMAND], { stdio: "inherit" });
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", (err) => reject(err));
  });
}

function printManualInstructions(latest: LatestReleaseInfo): void {
  console.log(chalk.bold(`\nTo update to v${latest.version}, run:`));
  console.log(`\n  ${INSTALL_COMMAND}\n`);
  console.log(chalk.gray(`Release notes: ${latest.url}`));
  console.log(
    chalk.gray(
      `${formatTipPrefix()}Homebrew installs update via 'brew upgrade dicklesworthstone/tap/cm' instead.`
    )
  );
}

export async function updateCommand(
  options: UpdateOptions = {},
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "update";
  const currentVersion = getVersion();

  let latest: LatestReleaseInfo;
  try {
    latest = await fetchLatestRelease(deps.fetchImpl ?? fetch);
  } catch (err) {
    reportError(err instanceof Error ? err : String(err), {
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const cmp = compareSemver(currentVersion, latest.version);
  const updateAvailable = cmp < 0;

  if (options.check) {
    if (options.json) {
      printJsonResult(command, {
        currentVersion,
        latestVersion: latest.version,
        updateAvailable,
        releaseUrl: latest.url,
        installCommand: INSTALL_COMMAND,
      }, { startedAtMs });
    } else if (updateAvailable) {
      console.log(
        `${iconPrefix("warning")}Update available: v${currentVersion} -> v${latest.version}`
      );
      console.log(chalk.gray(`Run '${getCliName()} update' to install, or:`));
      console.log(chalk.gray(`  ${INSTALL_COMMAND}`));
    } else {
      console.log(
        `${iconPrefix("check")}${getCliName()} is up to date (v${currentVersion}, latest release v${latest.version})`
      );
    }
    // Exit code signals update status for scripts: 0 = up to date, 1 = update available.
    if (updateAvailable) process.exitCode = 1;
    return;
  }

  if (!updateAvailable) {
    if (options.json) {
      printJsonResult(command, {
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: false,
        updated: false,
        releaseUrl: latest.url,
      }, { startedAtMs });
    } else {
      console.log(
        `${iconPrefix("check")}Already up to date (v${currentVersion}, latest release v${latest.version})`
      );
    }
    return;
  }

  // An update is available. In non-interactive or JSON mode we never execute
  // the installer; we print the exact instructions instead.
  if (options.json || !isInteractiveSession(options)) {
    if (options.json) {
      printJsonResult(command, {
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: true,
        updated: false,
        reason: "non-interactive session: run the install command manually",
        installCommand: INSTALL_COMMAND,
        releaseUrl: latest.url,
      }, { startedAtMs });
    } else {
      console.log(
        `${iconPrefix("warning")}Update available: v${currentVersion} -> v${latest.version}`
      );
      console.log(chalk.yellow("Non-interactive session detected; not running the installer."));
      printManualInstructions(latest);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `${iconPrefix("warning")}Update available: v${currentVersion} -> v${latest.version}`
  );
  console.log(chalk.gray("Re-running the documented installer (install.sh from the repo)...\n"));
  try {
    const code = await runInstallScript();
    if (code === 0) {
      console.log(
        `\n${iconPrefix("check")}Installer finished. Run '${getCliName()} --version' to confirm v${latest.version}.`
      );
    } else {
      console.log(chalk.red(`\nInstaller exited with code ${code}.`));
      printManualInstructions(latest);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log(chalk.red(`\nFailed to run the installer: ${err instanceof Error ? err.message : String(err)}`));
    printManualInstructions(latest);
    process.exitCode = 1;
  }
}
