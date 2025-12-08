import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
