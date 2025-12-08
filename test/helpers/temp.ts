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
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeFileInDir(dir: string, relative: string, contents: string | Buffer): Promise<string> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  return full;
}
