import { execSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a temporary git repository for testing.
 * Returns the path to the repo directory.
 */
export async function createTempGitRepo(prefix = "cass-test-repo"): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), `${prefix}-`));

  // Initialize git repo
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: "pipe" });

  // Create initial commit so we have a valid repo state
  await writeFile(join(repoDir, ".gitkeep"), "");
  execSync("git add .gitkeep", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: "pipe" });

  return repoDir;
}

/**
 * Cleanup a temporary git repo.
 */
export async function cleanupTempGitRepo(repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
}

/**
 * Run callback with a temporary git repo, then cleanup.
 */
export async function withTempGitRepo<T>(
  fn: (repoDir: string) => Promise<T>,
  prefix = "cass-test-repo"
): Promise<T> {
  const repoDir = await createTempGitRepo(prefix);
  try {
    return await fn(repoDir);
  } finally {
    await cleanupTempGitRepo(repoDir);
  }
}

/**
 * Stage and commit all changes in a repo.
 */
export function commitAll(repoDir: string, message: string): void {
  execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
    cwd: repoDir,
    stdio: "pipe"
  });
}

/**
 * Get current branch name.
 */
export function getCurrentBranch(repoDir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: repoDir,
    encoding: "utf-8"
  }).trim();
}

/**
 * Check if there are uncommitted changes.
 */
export function hasUncommittedChanges(repoDir: string): boolean {
  const status = execSync("git status --porcelain", {
    cwd: repoDir,
    encoding: "utf-8"
  });
  return status.trim().length > 0;
}

/**
 * Create a file and commit it.
 */
export async function createAndCommitFile(
  repoDir: string,
  relativePath: string,
  content: string,
  commitMessage: string
): Promise<void> {
  const fullPath = join(repoDir, relativePath);
  const parentDir = join(fullPath, "..");
  await mkdir(parentDir, { recursive: true });
  await writeFile(fullPath, content);
  execSync(`git add "${relativePath}"`, { cwd: repoDir, stdio: "pipe" });
  execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
    cwd: repoDir,
    stdio: "pipe"
  });
}
