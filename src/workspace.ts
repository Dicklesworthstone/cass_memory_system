/**
 * Workspace / project identity for workspace-scoped rules (#81).
 *
 * A workspace-scoped rule stores the directory it belongs to. Matching it
 * against `cm context`'s working directory by exact path made a rule for
 * `/repo` invisible from `/repo/src` and from a linked worktree such as
 * `/repo/.worktrees/feature`. These helpers give both sides a canonical form:
 *
 *  - paths are expanded (`~`), resolved and realpath'd when they exist;
 *  - a path inside a *linked* git worktree is mapped to the equivalent path in
 *    the main worktree, so every checkout of a repository shares one identity;
 *  - a rule applies to its directory and everything below it, but not across
 *    into a nested, separate git repository.
 *
 * Git layout is read from the filesystem (`.git` dir / `gitdir:` file /
 * `commondir`) instead of spawning `git`, so matching stays synchronous and
 * cheap even when a playbook holds many workspace-scoped rules.
 */
import fs from "node:fs";
import path from "node:path";
import { expandPath } from "./utils.js";

interface GitCheckout {
  /** Top-level directory of the checkout that contains the path. */
  root: string;
  /** Top-level directory of the repository's main worktree (== root unless linked). */
  mainRoot: string;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Expand `~`, resolve against cwd, and canonicalize symlinks when the path exists. */
export function normalizeWorkspacePath(workspace: string): string {
  return safeRealpath(path.resolve(expandPath(workspace.trim())));
}

function readGitdirPointer(dotGitFile: string): string | null {
  try {
    const content = fs.readFileSync(dotGitFile, "utf-8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match?.[1]) return null;
    return path.resolve(path.dirname(dotGitFile), match[1].trim());
  } catch {
    return null;
  }
}

/**
 * Main-worktree root for a checkout whose `.git` is a file (linked worktree or
 * submodule). Linked worktrees have `<gitdir>/commondir` pointing at the shared
 * `.git` directory; submodules do not, and are their own project.
 */
function mainRootForGitFile(root: string, dotGitFile: string): string {
  const gitdir = readGitdirPointer(dotGitFile);
  if (!gitdir) return root;
  let commonDir: string;
  try {
    const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf-8").trim();
    if (!rel) return root;
    commonDir = safeRealpath(path.resolve(gitdir, rel));
  } catch {
    return root; // submodule (or unreadable): the checkout is its own project
  }
  // A non-bare repository keeps its git dir at `<main worktree>/.git`. A bare
  // common dir has no main worktree to map to, so keep the checkout itself.
  if (path.basename(commonDir) !== ".git") return root;
  return path.dirname(commonDir);
}

const gitCheckoutCache = new Map<string, GitCheckout | null>();

/** Find the git checkout containing `absPath` (which must be normalized). */
function findGitCheckout(absPath: string): GitCheckout | null {
  if (gitCheckoutCache.has(absPath)) return gitCheckoutCache.get(absPath) ?? null;

  let result: GitCheckout | null = null;
  let dir = absPath;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      result = { root: dir, mainRoot: dir };
      break;
    }
    if (stat?.isFile()) {
      result = { root: dir, mainRoot: mainRootForGitFile(dir, dotGit) };
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Bounded: a process only ever sees a handful of distinct workspaces, but a
  // long-lived `cm serve` should not grow this without limit.
  if (gitCheckoutCache.size > 512) gitCheckoutCache.clear();
  gitCheckoutCache.set(absPath, result);
  return result;
}

/** Test hook: git layouts created by tests change between cases. */
export function __clearWorkspaceCacheForTest(): void {
  gitCheckoutCache.clear();
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Canonical form of a workspace path: normalized, and — inside a linked git
 * worktree — mapped to the equivalent location in the main worktree.
 */
export function canonicalWorkspacePath(workspace: string): string {
  const normalized = normalizeWorkspacePath(workspace);
  const checkout = findGitCheckout(normalized);
  if (!checkout || checkout.mainRoot === checkout.root) return normalized;
  return path.join(checkout.mainRoot, path.relative(checkout.root, normalized));
}

/**
 * Project root for a workspace: the main worktree's top level when the path is
 * inside a git repository, otherwise the normalized path itself. Used to tag
 * rules learned in a session with the project they belong to.
 */
export function resolveProjectRoot(workspace: string): string {
  const normalized = normalizeWorkspacePath(workspace);
  const checkout = findGitCheckout(normalized);
  return checkout ? checkout.mainRoot : normalized;
}

/**
 * Does a rule scoped to `ruleWorkspace` apply when working in `currentWorkspace`?
 *
 * True when the current directory is the rule's directory or below it (after
 * mapping linked worktrees onto the main worktree), unless that path crosses
 * into a nested git repository that the rule's directory is not part of.
 */
export function workspaceMatches(ruleWorkspace: string, currentWorkspace: string): boolean {
  if (!ruleWorkspace?.trim() || !currentWorkspace?.trim()) return false;
  const rule = canonicalWorkspacePath(ruleWorkspace);
  const current = canonicalWorkspacePath(currentWorkspace);
  if (rule === current) return true;
  // A rule scoped to the filesystem root would otherwise match everything.
  if (path.dirname(rule) === rule) return false;
  if (!isWithin(current, rule)) return false;

  // `/repo` must not leak into `/repo/vendor/other-repo` (a separate project).
  const checkout = findGitCheckout(normalizeWorkspacePath(currentWorkspace));
  if (!checkout) return true;
  return isWithin(rule, checkout.mainRoot);
}
