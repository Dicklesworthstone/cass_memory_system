import { constants } from "node:fs";
import fs from "node:fs/promises";
import yaml, { Lexer } from "yaml";

/** Hard ceilings for repository-controlled data, independent of repo config. */
export interface InputLimits {
  readonly maxBytes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const PLAYBOOK_INPUT_LIMITS: InputLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxArrayLength: 10_000,
  maxObjectKeys: 10_000,
  maxDepth: 32,
  maxNodes: 200_000,
});

/** Operator-selected local budgets are finite; YAML safety limits stay fixed. */
export const TRUSTED_PLAYBOOK_INPUT_CEILING: InputLimits = Object.freeze({
  ...PLAYBOOK_INPUT_LIMITS,
  maxBytes: 64 * 1024 * 1024,
  maxArrayLength: 100_000,
  maxNodes: 2_000_000,
});

export interface InputUsage {
  nodes: number;
  expandedTextBytes: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxDepth: number;
}

export const CONFIG_INPUT_LIMITS: InputLimits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxArrayLength: 1_000,
  maxObjectKeys: 1_000,
  maxDepth: 32,
  maxNodes: 20_000,
});

/** Resource-limit failures must not be treated as a missing/corrupt file. */
export class InputLimitError extends Error {
  readonly code = "INPUT_LIMIT_EXCEEDED";

  constructor(source: string, reason: string) {
    super(`Input limit exceeded for ${source}: ${reason}. Reduce or split the input.`);
    this.name = "InputLimitError";
  }
}

export function assertTextSize(content: string, maxBytes: number, source: string): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new InputLimitError(source, `maximum file size is ${maxBytes} bytes`);
  }
}

/**
 * Read at most maxBytes + 1 bytes from the opened file, even if it grows after
 * fstat. Reject devices/FIFOs rather than allowing an unbounded or blocking read
 * through a checkout's symlink. O_NONBLOCK has no effect on regular files.
 */
export async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  options: { privateFile?: boolean } = {},
): Promise<string> {
  const before = options.privateFile ? await fs.lstat(filePath) : null;
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
    throw new InputLimitError(filePath, "trusted local input must be a regular file without symbolic or hard links");
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK
    | (options.privateFile ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new InputLimitError(filePath, "expected a regular file");
    }
    if (before && (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1)) {
      throw new Error(`Trusted local input changed while opening ${filePath}; retry the operation`);
    }
    if (stat.size > maxBytes) {
      throw new InputLimitError(filePath, `maximum file size is ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new InputLimitError(filePath, `maximum file size is ${maxBytes} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (before) {
      for (const current of [await handle.stat(), await fs.lstat(filePath)]) {
        if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1
          || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
          throw new Error(`Trusted local input changed while reading ${filePath}; retry the operation`);
        }
      }
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Bound work BEFORE normalization, merging, per-element validation, or Zod.
 * Each alias occurrence counts: downstream consumers revisit aliased values.
 * Only current ancestors are tracked for cycles, not a global visited set.
 * The traversal is iterative and holds at most maxDepth frames.
 */
export function measureInputUsage(input: unknown, limits: InputLimits, source: string): InputUsage {
  type Frame = {
    value: object;
    keys: string[] | null;
    length: number;
    index: number;
    depth: number;
  };
  const stack: Frame[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;
  let textBytes = 0;
  let maxArrayLength = 0;
  let maxObjectKeys = 0;
  let maxDepth = 0;

  const countText = (value: string): void => {
    textBytes += Buffer.byteLength(value, "utf8");
    if (textBytes > limits.maxBytes) {
      throw new InputLimitError(source, `maximum expanded text size is ${limits.maxBytes} bytes`);
    }
  };

  const visit = (value: unknown, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (++nodes > limits.maxNodes) {
      throw new InputLimitError(source, `maximum expanded value count is ${limits.maxNodes}`);
    }
    if (depth > limits.maxDepth) {
      throw new InputLimitError(source, `maximum nesting depth is ${limits.maxDepth}`);
    }
    if (typeof value === "string") countText(value);
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) {
      throw new InputLimitError(source, "cyclic YAML aliases or object references are not allowed");
    }

    const isArray = Array.isArray(value);
    // Check length before reading a single array element (GHSA-mrhx-c7xc-m3w5).
    if (isArray && value.length > limits.maxArrayLength) {
      throw new InputLimitError(source, `maximum array length is ${limits.maxArrayLength}`);
    }
    const keys = isArray ? null : Object.keys(value);
    if (isArray) maxArrayLength = Math.max(maxArrayLength, value.length);
    if (keys) maxObjectKeys = Math.max(maxObjectKeys, keys.length);
    if (keys && keys.length > limits.maxObjectKeys) {
      throw new InputLimitError(source, `maximum object key count is ${limits.maxObjectKeys}`);
    }
    if (keys) for (const key of keys) countText(key);
    ancestors.add(value);
    stack.push({ value, keys, length: keys ? keys.length : (value as unknown[]).length, index: 0, depth });
  };

  visit(input, 0);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.length) {
      ancestors.delete(frame.value);
      stack.pop();
      continue;
    }
    const index = frame.index++;
    const child = frame.keys
      ? (frame.value as Record<string, unknown>)[frame.keys[index]]
      : (frame.value as unknown[])[index];
    visit(child, frame.depth + 1);
  }
  return { nodes, expandedTextBytes: textBytes, maxArrayLength, maxObjectKeys, maxDepth };
}

export function assertInputLimits(input: unknown, limits: InputLimits, source: string): void {
  measureInputUsage(input, limits, source);
}

export function parseJsonInput(content: string, limits: InputLimits, source: string): unknown {
  assertTextSize(content, limits.maxBytes, source);
  const parsed: unknown = JSON.parse(content);
  assertInputLimits(parsed, limits, source);
  return parsed;
}

/** Bound YAML parser allocation before constructing a syntax tree. */
export function assertYamlTokenLimits(content: string, limits: InputLimits, source: string): void {
  let tokens = 0;
  for (const token of new Lexer().lex(content)) {
    if (token === "\x02" || token === "\x1f" || /^[ \t\r\n]*$/.test(token)) continue;
    if (++tokens > limits.maxNodes * 4) {
      throw new InputLimitError(source, `maximum YAML token count is ${limits.maxNodes * 4}`);
    }
  }
}

export function parseYamlInput(content: string, limits: InputLimits, source: string): unknown {
  assertTextSize(content, limits.maxBytes, source);
  let parsed: unknown;
  try {
    // Scan without building a syntax tree first. Tiny YAML elements can expand
    // into many parser objects even inside the byte ceiling. Ignore whitespace
    // and lexer control markers; allow four meaningful tokens per logical value
    // to accommodate mapping keys/values, separators, anchors, and tags.
    assertYamlTokenLimits(content, limits, source);
    // Keep the parser's alias-expansion protection explicit. Structural limits
    // below also cover cycles and repeated references that do not get expanded.
    parsed = yaml.parse(content, { maxAliasCount: 100 });
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error instanceof Error && /Excessive alias count|resource exhaustion/i.test(error.message))
    ) {
      throw new InputLimitError(source, "YAML nesting or alias expansion exceeds safe limits");
    }
    throw error;
  }
  assertInputLimits(parsed, limits, source);
  return parsed;
}

/** Never stringify a whole ZodError for an untrusted collection. */
export function formatValidationIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  const examples = error.issues.slice(0, 5).map((issue) => {
    const location = issue.path.slice(0, 8).map(String).join(".").slice(0, 120) || "input";
    return `${location}: ${issue.message.slice(0, 240)}`;
  });
  const remaining = error.issues.length - examples.length;
  return examples.join("; ") + (remaining > 0 ? `; ${remaining} more validation issues` : "");
}
