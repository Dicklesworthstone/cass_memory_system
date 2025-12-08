import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create an isolated temp directory, run the provided async fn, then clean up.
 * Keeps tests deterministic and avoids leaking files into the repo.
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    // Recursive remove; ignore errors so tests don't fail on cleanup
    if (!process.env.KEEP_TEMP) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function writeFileInDir(dir: string, relative: string, contents: string | Buffer): Promise<string> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  return full;
}

/**
 * Creates a dummy executable file that can be used as a stub for CLI tools.
 * 
 * @param dir - Directory to create the stub in
 * @param outputs - Map of command args to stdout, or simple stdout string, or legacy exit code
 * @param outputOrName - (Legacy) stdout or name
 * @param nameArg - (Legacy) name
 */
type LegacyCassStubOptions = {
  exitCode?: number;
  healthExit?: number;
  indexExit?: number;
  search?: string;
  export?: string;
  expand?: string;
  timeline?: string;
};

export async function makeCassStub(
  dir: string,
  outputs: any = 0,
  outputOrName: any = "",
  nameArg = "cass"
): Promise<string> {
  let name = nameArg;
  let scriptContent = "";

  const looksLikeLegacy =
    outputs &&
    typeof outputs === "object" &&
    ["exitCode", "healthExit", "indexExit", "search", "export", "expand", "timeline"].some(
      key => key in outputs
    );

  if (looksLikeLegacy) {
    const opts = outputs as LegacyCassStubOptions;
    const exitCode = opts.exitCode ?? 0;
    const healthExit = opts.healthExit ?? exitCode;
    const indexExit = opts.indexExit ?? exitCode;
    const searchOut = opts.search ?? '[{"source_path":"/sessions/s1.jsonl","line_number":1,"agent":"stub","snippet":"hello","score":0.9}]';
    const exportOut = opts.export ?? "# Session transcript";
    const expandOut = opts.expand ?? "context lines";
    const timelineOut = opts.timeline ?? '{"groups":[{"date":"2025-01-01","sessions":[{"path":"/sessions/s1.jsonl","agent":"stub"}]}]}';

    const quote = (text: string) => text.replace(/'/g, "'\\''");

    scriptContent = `#!/bin/sh
cmd="$1"; shift
case "$cmd" in
  --version) exit 0 ;;
  health) exit ${healthExit} ;;
  index) exit ${indexExit} ;;
  search)
    echo '${quote(searchOut)}'
    exit ${exitCode} ;;
  export)
    echo '${quote(exportOut)}'
    exit ${exitCode} ;;
  expand)
    echo '${quote(expandOut)}'
    exit ${exitCode} ;;
  timeline)
    echo '${quote(timelineOut)}'
    exit ${exitCode} ;;
  *)
    exit ${exitCode} ;;
esac
`;
  } else if (typeof outputs === "object" && outputs !== null) {
    // Complex mode: outputs is a map of subcommand -> stdout
    // Example: { search: '[...]', timeline: '{...}' }
    // We generate a shell script case statement
    
    const cases = Object.entries(outputs).map(([cmd, out]) => {
      // Escape single quotes
      const safeOut = String(out).replace(/'/g, "'\\''");
      return `  *${cmd}*) 
    echo '${safeOut}'
    ;;`;
    }).join("\n");

    scriptContent = `#!/bin/sh
case "$*" in
${cases}
  *) 
    echo '[]' # Default empty json array
    ;; 
esac
exit 0
`;
  } else if (typeof outputs === "number") {
    // Legacy mode: (dir, exitCode, stdout, name)
    const exitCode = outputs;
    const stdout = outputOrName;
    name = nameArg;
    scriptContent = `#!/bin/sh
echo '${stdout}'
exit ${exitCode}
`;
  } else {
    // String mode? assume stdout
    scriptContent = `#!/bin/sh
echo '${outputs}'
exit 0
`;
  }

  const stubPath = path.join(dir, name);
  await writeFile(stubPath, scriptContent);
  await chmod(stubPath, 0o755);
  return stubPath;
}

/**
 * Isolated test environment with its own HOME directory.
 * Simulates a fresh cass-memory installation.
 */
export interface TestEnv {
  /** Temporary HOME directory */
  home: string;
  /** Path to ~/.cass-memory */
  cassMemoryDir: string;
  /** Path to ~/.cass-memory/config.json */
  configPath: string;
  /** Path to ~/.cass-memory/playbook.yaml */
  playbookPath: string;
  /** Path to ~/.cass-memory/diary */
  diaryDir: string;
  /** Original HOME value to restore */
  originalHome: string;
  /** Original cwd */
  originalCwd: string;
}

/**
 * Create an isolated environment with its own HOME for testing cass-memory.
 * Does NOT automatically set process.env.HOME - use the returned paths explicitly.
 */
export async function createIsolatedEnvironment(prefix = "cass-test"): Promise<TestEnv> {
  const home = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const cassMemoryDir = path.join(home, ".cass-memory");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

  return {
    home,
    cassMemoryDir,
    configPath: path.join(cassMemoryDir, "config.json"),
    playbookPath: path.join(cassMemoryDir, "playbook.yaml"),
    diaryDir: path.join(cassMemoryDir, "diary"),
    originalHome: process.env.HOME || "",
    originalCwd: process.cwd(),
  };
}

/**
 * Cleanup an isolated environment.
 */
export async function cleanupEnvironment(env: TestEnv): Promise<void> {
  if (!process.env.KEEP_TEMP) {
    await rm(env.home, { recursive: true, force: true });
  }
}

/**
 * Run callback with an isolated cass-memory home directory.
 * Sets HOME env var for the duration of the callback.
 */
export async function withTempCassHome<T>(
  fn: (env: TestEnv) => Promise<T>,
  prefix = "cass-test"
): Promise<T> {
  const env = await createIsolatedEnvironment(prefix);
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = env.home;
    return await fn(env);
  } finally {
    process.env.HOME = originalHome;
    await cleanupEnvironment(env);
  }
}
