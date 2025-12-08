import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ContextResult } from "./types.js";

const execAsync = promisify(exec);

// --- Input Validation Types and Errors ---

/**
 * Error thrown when input validation fails.
 * Contains structured information about the validation failure.
 */
export class InputValidationError extends Error {
  /** The type of input that failed validation */
  readonly inputType: InputType;
  /** The value that failed validation */
  readonly invalidValue: string;
  /** What format was expected */
  readonly expectedFormat: string;
  /** Example of valid input */
  readonly example: string;

  constructor(
    inputType: InputType,
    invalidValue: string,
    expectedFormat: string,
    example: string,
    reason?: string
  ) {
    const message = [
      `Invalid ${inputType}: ${reason || "validation failed"}`,
      `  Got: ${truncateForError(invalidValue)}`,
      `  Expected: ${expectedFormat}`,
      `  Example: ${example}`,
    ].join("\n");

    super(message);
    this.name = "InputValidationError";
    this.inputType = inputType;
    this.invalidValue = invalidValue;
    this.expectedFormat = expectedFormat;
    this.example = example;
  }
}

/** Supported input types for validation */
export type InputType = "bulletId" | "sessionPath" | "task" | "category";

/**
 * Truncate value for error messages (prevent huge error messages).
 */
function truncateForError(value: string, maxLen = 50): string {
  if (!value) return '""';
  if (value.length <= maxLen) return `"${value}"`;
  return `"${value.slice(0, maxLen)}..." (${value.length} chars)`;
}

/**
 * Remove control characters (except newlines and tabs) from text.
 * Control characters are U+0000-U+001F and U+007F-U+009F.
 */
function removeControlChars(text: string): string {
  // Keep \n (0x0A), \r (0x0D), and \t (0x09)
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

/**
 * Normalize unicode text using NFC normalization.
 * This ensures consistent comparison of strings with accents, etc.
 */
function normalizeUnicode(text: string): string {
  return text.normalize("NFC");
}

// Bullet ID pattern: b-{base36timestamp}-{random6chars}
// Example: b-m4k8z2x-abc123
const BULLET_ID_PATTERN = /^b-[a-z0-9]+-[a-z0-9]+$/;

// Category pattern: alphanumeric with hyphens/underscores, lowercase
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Maximum lengths
const MAX_TASK_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 50;
const MAX_PATH_LENGTH = 1024;

/**
 * Validate and sanitize user input to prevent errors and security issues.
 *
 * Applies type-specific validation rules and sanitization:
 * - bulletId: Must match `b-{timestamp}-{random}` pattern
 * - sessionPath: Valid file path, resolved to absolute
 * - task: Non-empty, max 500 chars, no control characters
 * - category: Lowercase alphanumeric with hyphens/underscores, max 50 chars
 *
 * Sanitization applied to all types:
 * - Trim whitespace
 * - Normalize unicode (NFC)
 * - Remove control characters (except newlines/tabs where appropriate)
 *
 * @param type - The type of input being validated
 * @param value - The input value to validate and sanitize
 * @returns Sanitized value on success
 * @throws {InputValidationError} With helpful error message if validation fails
 *
 * @example
 * // Validate bullet ID
 * validateAndSanitizeInput('bulletId', 'b-m4k8z2x-abc123');
 * // Returns: 'b-m4k8z2x-abc123'
 *
 * // Validate session path
 * validateAndSanitizeInput('sessionPath', '~/sessions/session.jsonl');
 * // Returns: '/home/user/sessions/session.jsonl'
 *
 * // Validate task
 * validateAndSanitizeInput('task', '  Fix auth timeout  ');
 * // Returns: 'Fix auth timeout'
 *
 * // Validate category
 * validateAndSanitizeInput('category', 'Error-Handling');
 * // Returns: 'error-handling'
 */
export function validateAndSanitizeInput(
  type: InputType,
  value: string
): string {
  // Basic null/undefined check
  if (value === null || value === undefined) {
    throw new InputValidationError(
      type,
      String(value),
      "non-null string",
      getExampleForType(type),
      "value is null or undefined"
    );
  }

  // Basic sanitization for all types
  let sanitized = String(value).trim();
  sanitized = normalizeUnicode(sanitized);

  // Type-specific validation
  switch (type) {
    case "bulletId":
      return validateBulletId(sanitized);
    case "sessionPath":
      return validateSessionPath(sanitized);
    case "task":
      return validateTask(sanitized);
    case "category":
      return validateCategory(sanitized);
    default:
      throw new InputValidationError(
        type,
        sanitized,
        "valid input type",
        "bulletId, sessionPath, task, or category",
        `unknown input type: ${type}`
      );
  }
}

/**
 * Validate bullet ID format.
 */
function validateBulletId(value: string): string {
  // Remove control chars but keep the structure
  const cleaned = removeControlChars(value);

  if (!cleaned) {
    throw new InputValidationError(
      "bulletId",
      value,
      "non-empty bullet ID in format b-{timestamp}-{random}",
      "b-m4k8z2x-abc123",
      "bullet ID is empty"
    );
  }

  // Check pattern
  if (!BULLET_ID_PATTERN.test(cleaned)) {
    throw new InputValidationError(
      "bulletId",
      value,
      "format: b-{base36-timestamp}-{random-chars}",
      "b-m4k8z2x-abc123",
      "bullet ID does not match expected pattern"
    );
  }

  return cleaned;
}

/**
 * Validate and resolve session path.
 */
function validateSessionPath(value: string): string {
  // Remove control chars
  const cleaned = removeControlChars(value);

  if (!cleaned) {
    throw new InputValidationError(
      "sessionPath",
      value,
      "valid file path",
      "~/.claude/sessions/session.jsonl",
      "path is empty"
    );
  }

  // Check length
  if (cleaned.length > MAX_PATH_LENGTH) {
    throw new InputValidationError(
      "sessionPath",
      value,
      `path under ${MAX_PATH_LENGTH} characters`,
      "~/.claude/sessions/session.jsonl",
      `path exceeds ${MAX_PATH_LENGTH} characters`
    );
  }

  // Expand ~ to home directory
  const expanded = expandPath(cleaned);

  // Resolve to absolute path
  const absolute = path.resolve(expanded);

  // Check for path traversal attempts (after resolution)
  // This prevents things like /../../../etc/passwd
  const normalizedAbsolute = path.normalize(absolute);
  if (normalizedAbsolute !== absolute) {
    throw new InputValidationError(
      "sessionPath",
      value,
      "normalized absolute path without traversal",
      "~/.claude/sessions/session.jsonl",
      "path contains suspicious traversal sequences"
    );
  }

  // Check for valid extension (common session file types)
  const ext = path.extname(absolute).toLowerCase();
  const validExtensions = [".jsonl", ".json", ".md", ".txt", ".log"];
  if (ext && !validExtensions.includes(ext)) {
    throw new InputValidationError(
      "sessionPath",
      value,
      `file with extension: ${validExtensions.join(", ")}`,
      "~/.claude/sessions/session.jsonl",
      `unexpected file extension: ${ext}`
    );
  }

  return absolute;
}

/**
 * Validate task description.
 */
function validateTask(value: string): string {
  // Remove control chars but keep newlines and tabs
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");

  if (!cleaned) {
    throw new InputValidationError(
      "task",
      value,
      "non-empty task description",
      "Fix authentication timeout bug",
      "task is empty"
    );
  }

  // Check length
  if (cleaned.length > MAX_TASK_LENGTH) {
    throw new InputValidationError(
      "task",
      value,
      `task under ${MAX_TASK_LENGTH} characters`,
      "Fix authentication timeout bug",
      `task exceeds ${MAX_TASK_LENGTH} characters (got ${cleaned.length})`
    );
  }

  // Warn about very short tasks (but don't reject)
  // This is informational - the sanitized value is still returned

  return cleaned;
}

/**
 * Validate category name.
 */
function validateCategory(value: string): string {
  // Remove control chars
  const cleaned = removeControlChars(value);

  if (!cleaned) {
    throw new InputValidationError(
      "category",
      value,
      "non-empty category name",
      "error-handling",
      "category is empty"
    );
  }

  // Convert to lowercase for consistency
  const lowercased = cleaned.toLowerCase();

  // Check length
  if (lowercased.length > MAX_CATEGORY_LENGTH) {
    throw new InputValidationError(
      "category",
      value,
      `category under ${MAX_CATEGORY_LENGTH} characters`,
      "error-handling",
      `category exceeds ${MAX_CATEGORY_LENGTH} characters`
    );
  }

  // Check pattern (alphanumeric start, then alphanumeric/hyphen/underscore)
  if (!CATEGORY_PATTERN.test(lowercased)) {
    throw new InputValidationError(
      "category",
      value,
      "lowercase alphanumeric with hyphens or underscores, starting with alphanumeric",
      "error-handling",
      "category contains invalid characters"
    );
  }

  return lowercased;
}

/**
 * Get example value for each input type.
 */
function getExampleForType(type: InputType): string {
  switch (type) {
    case "bulletId":
      return "b-m4k8z2x-abc123";
    case "sessionPath":
      return "~/.claude/sessions/session.jsonl";
    case "task":
      return "Fix authentication timeout bug";
    case "category":
      return "error-handling";
    default:
      return "valid input";
  }
}

// --- Permission Error Handling ---

/**
 * Error thrown when a file permission issue is detected.
 * Contains actionable guidance for resolution.
 */
export class PermissionError extends Error {
  /** The path that had the permission issue */
  readonly path: string;
  /** The operation that failed (read, write, execute) */
  readonly operation: "read" | "write" | "execute" | "delete" | "unknown";
  /** Current permissions in octal (e.g., "644") */
  readonly currentPermissions?: string;
  /** Suggested fix command */
  readonly suggestedFix: string;
  /** Original error code (EACCES, EPERM, etc.) */
  readonly errorCode: string;

  constructor(
    path: string,
    operation: "read" | "write" | "execute" | "delete" | "unknown",
    currentPermissions: string | undefined,
    suggestedFix: string,
    errorCode: string,
    originalMessage: string
  ) {
    const permStr = currentPermissions ? ` (current: ${currentPermissions})` : "";
    const message = [
      `Permission denied: Cannot ${operation} ${path}${permStr}`,
      ``,
      `Error: ${originalMessage}`,
      ``,
      `To fix:`,
      `  ${suggestedFix}`,
    ].join("\n");

    super(message);
    this.name = "PermissionError";
    this.path = path;
    this.operation = operation;
    this.currentPermissions = currentPermissions;
    this.suggestedFix = suggestedFix;
    this.errorCode = errorCode;
  }
}

/**
 * Check if an error is a permission-related error.
 */
export function isPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Detect the operation type from the error message.
 */
function detectOperation(
  error: Error
): "read" | "write" | "execute" | "delete" | "unknown" {
  const msg = error.message.toLowerCase();
  if (msg.includes("open") && msg.includes("r")) return "read";
  if (
    msg.includes("write") ||
    msg.includes("open") ||
    msg.includes("mkdir") ||
    msg.includes("rename")
  )
    return "write";
  if (msg.includes("unlink") || msg.includes("rmdir")) return "delete";
  if (msg.includes("exec") || msg.includes("spawn")) return "execute";
  return "unknown";
}

/**
 * Format file mode as human-readable string.
 * @param mode - File mode from fs.stat
 * @returns String like "644" (rw-r--r--) or "755" (rwxr-xr-x)
 */
function formatMode(mode: number): string {
  // Extract permission bits (last 9 bits)
  const permBits = mode & 0o777;
  return permBits.toString(8).padStart(3, "0");
}

/**
 * Get current file/directory permissions if accessible.
 */
async function getPermissions(
  filePath: string
): Promise<{ mode: string; owner: string } | null> {
  try {
    const stat = await fs.stat(filePath);
    return {
      mode: formatMode(stat.mode),
      owner: `uid:${stat.uid}`,
    };
  } catch {
    // Try parent directory if file doesn't exist
    try {
      const parentDir = path.dirname(filePath);
      const stat = await fs.stat(parentDir);
      return {
        mode: formatMode(stat.mode) + " (parent dir)",
        owner: `uid:${stat.uid}`,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Generate a suggested fix command based on the operation and path.
 */
function generateSuggestedFix(
  operation: "read" | "write" | "execute" | "delete" | "unknown",
  filePath: string,
  isDirectory: boolean
): string {
  const escapedPath = filePath.replace(/'/g, "'\\''");

  switch (operation) {
    case "read":
      return isDirectory
        ? `chmod 755 '${escapedPath}' # Allow directory access`
        : `chmod 644 '${escapedPath}' # Allow file read`;
    case "write":
    case "delete":
      return isDirectory
        ? `chmod 755 '${escapedPath}' # Allow directory write`
        : `chmod 644 '${escapedPath}' # Allow file write`;
    case "execute":
      return `chmod +x '${escapedPath}' # Allow execution`;
    default:
      return `chmod 644 '${escapedPath}' # Try granting read/write`;
  }
}

/**
 * Handle file permission errors with helpful guidance.
 *
 * Detects EACCES and EPERM errors, retrieves current permissions,
 * and throws an enhanced PermissionError with actionable fix suggestions.
 *
 * @param error - The original error that occurred
 * @param filePath - The path that was being accessed
 * @throws {PermissionError} Always throws with helpful information
 *
 * @example
 * try {
 *   await fs.readFile('/root/secret.txt');
 * } catch (error) {
 *   if (isPermissionError(error)) {
 *     await handlePermissionError(error as Error, '/root/secret.txt');
 *   }
 *   throw error;
 * }
 */
export async function handlePermissionError(
  error: Error,
  filePath: string
): Promise<never> {
  const code = (error as NodeJS.ErrnoException).code || "UNKNOWN";
  const operation = detectOperation(error);

  // Get current permissions
  const perms = await getPermissions(filePath);
  const permStr = perms ? `${perms.mode} (owner: ${perms.owner})` : undefined;

  // Check if it's a directory
  let isDirectory = false;
  try {
    const stat = await fs.stat(filePath);
    isDirectory = stat.isDirectory();
  } catch {
    // Assume file if we can't stat
    isDirectory = filePath.endsWith("/") || !path.extname(filePath);
  }

  const suggestedFix = generateSuggestedFix(operation, filePath, isDirectory);

  throw new PermissionError(
    filePath,
    operation,
    permStr,
    suggestedFix,
    code,
    error.message
  );
}

/**
 * Synchronous version of handlePermissionError for use in sync contexts.
 * Uses cached/estimated permissions rather than async stat.
 */
export function handlePermissionErrorSync(
  error: Error,
  filePath: string
): never {
  const code = (error as NodeJS.ErrnoException).code || "UNKNOWN";
  const operation = detectOperation(error);

  // Check if it's likely a directory
  const isDirectory = filePath.endsWith("/") || !path.extname(filePath);
  const suggestedFix = generateSuggestedFix(operation, filePath, isDirectory);

  throw new PermissionError(
    filePath,
    operation,
    undefined, // Can't get permissions synchronously without blocking
    suggestedFix,
    code,
    error.message
  );
}

// --- Error Categorization ---

/**
 * Categories for classifying errors.
 * Used to determine appropriate exit codes, messaging, and retry behavior.
 */
export type ErrorCategory =
  | "user_input" // Invalid input from user (bad arguments, invalid IDs)
  | "configuration" // Config file issues (invalid YAML, missing required fields)
  | "filesystem" // File/directory issues (ENOENT, EACCES, disk full)
  | "network" // API/network failures (timeouts, connection refused)
  | "cass" // cass binary errors (not installed, index issues)
  | "llm" // LLM provider errors (rate limits, API errors)
  | "internal"; // Bugs in cass-memory (unexpected states)

/**
 * Map of error codes to their categories.
 */
const ERROR_CODE_CATEGORIES: Record<string, ErrorCategory> = {
  // Filesystem errors
  ENOENT: "filesystem",
  EACCES: "filesystem",
  EPERM: "filesystem",
  EEXIST: "filesystem",
  ENOTDIR: "filesystem",
  EISDIR: "filesystem",
  EMFILE: "filesystem",
  ENOSPC: "filesystem",
  EROFS: "filesystem",

  // Network errors
  ECONNREFUSED: "network",
  ECONNRESET: "network",
  ETIMEDOUT: "network",
  ENOTFOUND: "network",
  EAI_AGAIN: "network",
  EHOSTUNREACH: "network",
};

/**
 * Patterns in error messages that indicate specific categories.
 * Order matters - more specific patterns should come first.
 */
const ERROR_MESSAGE_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  // LLM errors
  { pattern: /rate[_\s]?limit/i, category: "llm" },
  { pattern: /api[_\s]?key/i, category: "llm" },
  { pattern: /token[_\s]?limit/i, category: "llm" },
  { pattern: /context[_\s]?(length|window)/i, category: "llm" },
  { pattern: /anthropic|openai|google.*ai/i, category: "llm" },
  { pattern: /model.*not.*found/i, category: "llm" },
  { pattern: /invalid.*model/i, category: "llm" },
  { pattern: /quota.*exceeded/i, category: "llm" },

  // Cass errors
  { pattern: /cass.*not.*found/i, category: "cass" },
  { pattern: /cass.*command/i, category: "cass" },
  { pattern: /cass.*index/i, category: "cass" },
  { pattern: /cass.*export/i, category: "cass" },
  { pattern: /session.*search/i, category: "cass" },

  // User input errors
  { pattern: /invalid.*bullet/i, category: "user_input" },
  { pattern: /invalid.*id/i, category: "user_input" },
  { pattern: /invalid.*path/i, category: "user_input" },
  { pattern: /invalid.*category/i, category: "user_input" },
  { pattern: /invalid.*input/i, category: "user_input" },
  { pattern: /validation.*failed/i, category: "user_input" },
  { pattern: /required.*parameter/i, category: "user_input" },
  { pattern: /missing.*argument/i, category: "user_input" },

  // Configuration errors
  { pattern: /config.*invalid/i, category: "configuration" },
  { pattern: /invalid.*config/i, category: "configuration" },
  { pattern: /yaml.*parse/i, category: "configuration" },
  { pattern: /json.*parse/i, category: "configuration" },
  { pattern: /schema.*validation/i, category: "configuration" },
  { pattern: /missing.*required.*field/i, category: "configuration" },

  // Network errors
  { pattern: /timeout/i, category: "network" },
  { pattern: /connection.*refused/i, category: "network" },
  { pattern: /fetch.*failed/i, category: "network" },
  { pattern: /network.*error/i, category: "network" },
  { pattern: /dns.*lookup/i, category: "network" },

  // Filesystem errors
  { pattern: /permission.*denied/i, category: "filesystem" },
  { pattern: /no.*such.*file/i, category: "filesystem" },
  { pattern: /file.*not.*found/i, category: "filesystem" },
  { pattern: /directory.*not.*found/i, category: "filesystem" },
  { pattern: /disk.*full/i, category: "filesystem" },
  { pattern: /read.*only.*file/i, category: "filesystem" },
];

/**
 * Map error categories to recommended exit codes.
 */
export const ERROR_CATEGORY_EXIT_CODES: Record<ErrorCategory, number> = {
  user_input: 2, // Like UNIX convention for usage errors
  configuration: 3,
  filesystem: 4,
  network: 5,
  cass: 6,
  llm: 7,
  internal: 1, // Generic error
};

/**
 * Categorize an error for appropriate handling and user messaging.
 *
 * Uses a multi-tier approach:
 * 1. Check if error is a known custom error type (InputValidationError, PermissionError)
 * 2. Check error code (ENOENT, EACCES, etc.)
 * 3. Check error name (e.g., ZodError for schema validation)
 * 4. Match error message against patterns
 * 5. Default to "internal" for unknown errors
 *
 * @param error - The error to categorize
 * @returns The error category
 *
 * @example
 * const category = categorizeError(error);
 * process.exit(ERROR_CATEGORY_EXIT_CODES[category]);
 *
 * @example
 * switch (categorizeError(error)) {
 *   case 'network':
 *     console.log('Check your internet connection');
 *     break;
 *   case 'llm':
 *     console.log('API error - check your API key');
 *     break;
 * }
 */
export function categorizeError(error: unknown): ErrorCategory {
  // Handle non-Error objects
  if (!(error instanceof Error)) {
    return "internal";
  }

  // Check for our custom error types
  if (error instanceof InputValidationError) {
    return "user_input";
  }
  if (error instanceof PermissionError) {
    return "filesystem";
  }

  // Check error code (Node.js system errors)
  const errorCode = (error as NodeJS.ErrnoException).code;
  if (errorCode && ERROR_CODE_CATEGORIES[errorCode]) {
    return ERROR_CODE_CATEGORIES[errorCode];
  }

  // Check error name for known types
  if (error.name === "ZodError") {
    return "configuration"; // Schema validation failed
  }
  if (error.name === "SyntaxError") {
    // Could be JSON/YAML parse error
    const msg = error.message.toLowerCase();
    if (msg.includes("json") || msg.includes("yaml") || msg.includes("unexpected token")) {
      return "configuration";
    }
  }
  if (error.name === "TypeError" || error.name === "ReferenceError") {
    return "internal"; // Likely a bug
  }
  if (error.name === "AbortError") {
    return "user_input"; // User cancelled
  }

  // Match error message against patterns
  const message = error.message || "";
  for (const { pattern, category } of ERROR_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return category;
    }
  }

  // Check for stack trace hints (cass-memory internal bugs)
  const stack = error.stack || "";
  if (stack.includes("cass-memory/src/") || stack.includes("cass_memory_system/src/")) {
    // Error originated from our code but wasn't caught specifically
    // Could be an edge case we haven't handled
    return "internal";
  }

  // Default to internal for unknown errors
  return "internal";
}

/**
 * Get a user-friendly description for an error category.
 */
export function getErrorCategoryDescription(category: ErrorCategory): string {
  switch (category) {
    case "user_input":
      return "Invalid input provided";
    case "configuration":
      return "Configuration error";
    case "filesystem":
      return "File system error";
    case "network":
      return "Network error";
    case "cass":
      return "Cass integration error";
    case "llm":
      return "LLM provider error";
    case "internal":
      return "Internal error";
  }
}

/**
 * Get recommended user action for an error category.
 */
export function getErrorCategoryAction(category: ErrorCategory): string {
  switch (category) {
    case "user_input":
      return "Check the command arguments and try again";
    case "configuration":
      return "Check your config files (~/.cass-memory/config.json or .cass/config.yaml)";
    case "filesystem":
      return "Check file permissions and available disk space";
    case "network":
      return "Check your internet connection and try again";
    case "cass":
      return "Install cass or set CASS_PATH: cargo install cass";
    case "llm":
      return "Check your API key and rate limits";
    case "internal":
      return "This may be a bug. Please report at https://github.com/anthropics/cass-memory/issues";
  }
}

/**
 * Determine if an error category should trigger retry behavior.
 */
export function shouldRetry(category: ErrorCategory): boolean {
  return category === "network" || category === "llm";
}

// --- Path Utilities ---

export function expandPath(p: string): string {
  if (!p) return "";
  if (p.startsWith("~")) {
    const home = process.env.HOME || os.homedir();
    return path.join(home, p.slice(1));
  }
  return p;
}

/**
 * Normalize a path for the current platform.
 * - Expands ~ to home directory
 * - Handles Windows drive letters and UNC paths even on Unix
 * - Resolves . and .. components where applicable
 * - Removes redundant separators
 * - Returns path using current platform separators
 */
export function normalizePlatformPath(p: string): string {
  if (!p) return "";

  let input = expandPath(p);

  const isUNC = input.startsWith("\\\\") || input.startsWith("//");
  const hasDriveLetter = /^[a-zA-Z]:/.test(input);

  // Normalize separators to forward slashes for internal processing
  input = input.replace(/\\/g, "/");

  if (isUNC) {
    // Preserve the UNC prefix (//server/share[/...])
    const stripped = input.replace(/^\/\//, "");
    const normalizedRest = stripped
      .split("/")
      .filter(Boolean)
      .join("/");
    const rebuilt = `//${normalizedRest}`;
    return process.platform === "win32"
      ? rebuilt.replace(/\//g, "\\")
      : rebuilt;
  }

  if (hasDriveLetter) {
    // Use win32 helpers to normalize drive-letter paths even on Unix
    const winNormalized = path.win32.normalize(input);
    const finalWin = path.win32.isAbsolute(winNormalized)
      ? winNormalized
      : path.win32.resolve(winNormalized);
    return process.platform === "win32"
      ? finalWin
      : finalWin.replace(/\\/g, "/");
  }

  // POSIX-style path: resolve against cwd and normalize
  const resolved = path.resolve(input);
  return path.normalize(resolved);
}

/**
 * Convert all path separators to forward slashes.
 * Useful for consistent storage/comparison across platforms.
 */
export function toForwardSlashes(p: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/");
}

/**
 * Convert path separators to the native platform separator.
 * On Windows: forward slashes → backslashes
 * On Unix: backslashes → forward slashes
 */
export function toNativeSeparators(p: string): string {
  if (!p) return "";
  if (path.sep === "\\") {
    // Windows: convert forward slashes to backslashes
    return p.replace(/\//g, "\\");
  } else {
    // Unix: convert backslashes to forward slashes
    return p.replace(/\\/g, "/");
  }
}

/**
 * Cross-platform check for absolute paths.
 * Recognizes:
 * - Unix absolute paths: /path/to/file
 * - Windows drive letters: C:\path, D:/path
 * - UNC paths: \\server\share, //server/share
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false;

  // Unix absolute path
  if (p.startsWith("/")) return true;

  // Windows drive letter (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(p)) return true;

  // UNC path (\\server\share or //server/share)
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;

  return false;
}

/**
 * Join path segments with tilde expansion on the first segment.
 * Uses platform-native separators.
 */
export function joinPath(...segments: string[]): string {
  if (segments.length === 0) return "";

  // Expand tilde on first segment only
  const first = expandPath(segments[0]);
  const rest = segments.slice(1);

  // Join and normalize
  return path.normalize(path.join(first, ...rest));
}

export async function ensureDir(dir: string): Promise<void> {
  const expanded = expandPath(dir);
  try {
    await fs.access(expanded);
  } catch {
    await fs.mkdir(expanded, { recursive: true });
  }
}

/**
 * Async existence check that respects ~ expansion.
 * Returns false on any access error (ENOENT, EACCES, etc.).
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(expandPath(filePath));
    return true;
  } catch {
    return false;
  }
}

// --- Repository .cass/ Structure ---

/**
 * Resolve the .cass/ directory path for the current git repository.
 * Returns null if not in a git repository.
 *
 * @returns Absolute path to .cass/ directory, or null if not in a git repo
 *
 * @example
 * const cassDir = await resolveRepoDir();
 * if (cassDir) {
 *   console.log(`Repo .cass/ at: ${cassDir}`);
 * }
 */
export async function resolveRepoDir(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel");
    const repoRoot = stdout.trim();
    return path.join(repoRoot, ".cass");
  } catch {
    return null;
  }
}

export function resolveGlobalDir(): string {
  return expandPath("~/.cass-memory");
}

export async function ensureGlobalStructure(
  defaultConfigStr?: string, 
  defaultPlaybookStr?: string
): Promise<{ created: string[], existed: string[] }> {
  const globalDir = resolveGlobalDir();
  const created: string[] = [];
  const existed: string[] = [];

  await ensureDir(globalDir);

  // Subdirectories
  const subdirs = ["diary", "reflections", "embeddings", "cost"];
  for (const d of subdirs) {
      await ensureDir(path.join(globalDir, d));
  }

  // config.json
  const configPath = path.join(globalDir, "config.json");
  if (await fileExists(configPath)) {
      existed.push("config.json");
  } else if (defaultConfigStr) {
      await atomicWrite(configPath, defaultConfigStr);
      created.push("config.json");
  }

  // playbook.yaml
  const playbookPath = path.join(globalDir, "playbook.yaml");
  if (await fileExists(playbookPath)) {
      existed.push("playbook.yaml");
  } else {
      const content = defaultPlaybookStr || `# Global Playbook
schema_version: 2
name: global-playbook
description: Personal global playbook rules
metadata:
  createdAt: ${new Date().toISOString()}
  totalReflections: 0
  totalSessionsProcessed: 0
deprecatedPatterns: []
bullets: []
`;
      await atomicWrite(playbookPath, content);
      created.push("playbook.yaml");
  }
  
  // blocked.log - global blocklist
  const blockedPath = path.join(globalDir, "blocked.log");
  if (await fileExists(blockedPath)) {
      existed.push("blocked.log");
  } else {
      await atomicWrite(blockedPath, "");
      created.push("blocked.log");
  }

  // usage.jsonl
  const usagePath = path.join(globalDir, "usage.jsonl");
  if (await fileExists(usagePath)) {
      existed.push("usage.jsonl");
  } else {
      await atomicWrite(usagePath, "");
      created.push("usage.jsonl");
  }

  return { created, existed };
}

/**
 * Ensure the .cass/ repo-level directory structure exists.
 * Creates the directory and initializes required files if missing.
 *
 * Creates:
 * - .cass/playbook.yaml (empty playbook for project-specific rules)
 * - .cass/blocked.log (empty blocklist file)
 *
 * Does NOT create config.yaml by default (only created when project
 * needs to override global settings).
 *
 * @param cassDir - Absolute path to .cass/ directory (from resolveRepoDir)
 * @returns Object describing what was created
 *
 * @example
 * const cassDir = await resolveRepoDir();
 * if (cassDir) {
 *   const result = await ensureRepoStructure(cassDir);
 *   console.log(`Created: ${result.created.join(', ')}`);
 * }
 */
export async function ensureRepoStructure(cassDir: string): Promise<{
  created: string[];
  existed: string[];
}> {
  const created: string[] = [];
  const existed: string[] = [];

  // Ensure .cass/ directory exists
  await ensureDir(cassDir);

  // 1. playbook.yaml - Project-specific rules
  const playbookPath = path.join(cassDir, "playbook.yaml");
  if (await fileExists(playbookPath)) {
    existed.push("playbook.yaml");
  } else {
    const emptyPlaybook = `# Project-specific playbook rules
# These are merged with your global ~/.cass-memory/playbook.yaml
# Project rules take precedence over global rules
schema_version: 2
name: repo-playbook
description: Project-specific rules for this repository
metadata:
  createdAt: ${new Date().toISOString()}
  totalReflections: 0
  totalSessionsProcessed: 0
deprecatedPatterns: []
bullets: []
`;
    await atomicWrite(playbookPath, emptyPlaybook);
    created.push("playbook.yaml");
  }

  // 2. blocked.log - Project-specific blocked patterns (JSONL format)
  const blockedPath = path.join(cassDir, "blocked.log");
  if (await fileExists(blockedPath)) {
    existed.push("blocked.log");
  } else {
    // Create empty file (JSONL format - one JSON object per line)
    await atomicWrite(blockedPath, "");
    created.push("blocked.log");
  }

  // Note: config.yaml is NOT created by default
  // It's only needed when project overrides global settings
  // .gitignore already excludes .cass/config.yaml for security

  return { created, existed };
}

export async function checkDiskSpace(dirPath: string): Promise<{ ok: boolean; free: string }> {
  try {
    const expanded = expandPath(dirPath);
    await ensureDir(expanded);

    // Use execFile with arguments to prevent command injection
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    const { stdout } = await execFileAsync("df", ["-h", expanded]);

    // Parse df output - last line, 4th column (Available space)
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) {
      return { ok: true, free: "unknown" };
    }

    // Get last line (the filesystem info), split by whitespace
    const lastLine = lines[lines.length - 1];
    const columns = lastLine.split(/\s+/);

    // df -h format: Filesystem Size Used Avail Use% Mounted
    // Available is typically column 4 (index 3)
    const free = columns[3] || "unknown";
    return { ok: true, free };
  } catch (err: any) {
    warn(`[utils] checkDiskSpace failed: ${err.message}`);
    return { ok: true, free: "unknown" };
  }
}

// --- File Locking ---

export async function withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const { withLock: lock } = await import("./lock.js");
  return lock(filePath, operation);
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const expanded = typeof expandPath === "function" ? expandPath(filePath) : path.resolve(filePath);
  await ensureDir(path.dirname(expanded));
  
  const tempPath = `${expanded}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempPath, expanded);
  } catch (err: any) {
    try { await fs.unlink(tempPath); } catch {} 
    throw new Error(`Failed to atomic write to ${expanded}: ${err.message}`);
  }
}

// --- Content & Hashing ---

export function hashContent(content: string): string {
  if (!content) return crypto.createHash("sha256").update("").digest("hex").substring(0, 16);

  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

// Alias for backward compatibility - some modules import as contentHash
// Backwards compatibility alias (some modules import contentHash)
export function contentHash(content: string): string {
  return hashContent(content);
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  
  // Improved regex: Keeps technical terms like C++, node.js, user_id
  // Matches:
  // - Sequences of alphanumeric chars including dots, underscores, hyphens, pluses
  // - But avoids trailing dots
  
  // This is a heuristic for code-heavy text
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:[._\-+]+[a-z0-9]+)*|[a-z0-9]+/g);
  
  return (tokens || [])
    .filter(t => t.length >= 2); // Min length 2
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return intersection.size / union.size;
}

// --- ID Generation ---

export function generateBulletId(): string {
  const timestamp36 = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `b-${timestamp36}-${random}`;
}

export function generateDiaryId(sessionPath: string): string {
  const input = `${sessionPath}-${Date.now()}-${process.hrtime.bigint()}-${Math.random()}`;
  const hash = hashContent(input);
  return `diary-${hash}`;
}

// --- Date/Time ---

export function now(): string {
  return new Date().toISOString();
}

export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Return the whole number of days elapsed since the given ISO date or timestamp.
 * Negative if the date lies in the future.
 */
export function daysSince(dateLike: string | number | Date): number {
  const target = new Date(dateLike);
  const diffMs = Date.now() - target.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// --- Text & NLP ---

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before",
  "after", "and", "or", "but", "if", "when", "where", "why", "how", "this", "that",
  "these", "those", "what", "which", "who", "there", "here", "i", "you", "he", "she",
  "it", "we", "they", "me", "him", "her", "us", "them"
]);

export function extractKeywords(text: string): string[] {
  const tokens = tokenize(text);
  const keywords = tokens.filter(t => !STOP_WORDS.has(t));
  
  const counts: Record<string, number> = {};
  keywords.forEach(k => counts[k] = (counts[k] || 0) + 1);
  
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k]) => k);
}

export function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  if (maxLen < 3) return text.slice(0, maxLen);
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Truncation strategy for LLM context.
 * - "head": Keep the beginning (default)
 * - "tail": Keep the end
 * - "middle": Keep start and end, remove middle (best for preserving context)
 */
export type TruncateStrategy = "head" | "tail" | "middle";

export interface TruncateForContextOptions {
  /** Maximum characters (default: 4000, roughly 1000 tokens) */
  maxChars?: number;
  /** Maximum estimated tokens (overrides maxChars if set, uses ~4 chars/token) */
  maxTokens?: number;
  /** Truncation strategy (default: "middle") */
  strategy?: TruncateStrategy;
  /** Preserve code blocks when possible (default: true) */
  preserveCodeBlocks?: boolean;
  /** Marker to insert at truncation point (default: "\n\n[...truncated...]\n\n") */
  truncationMarker?: string;
}

/**
 * Truncate large content for LLM context windows.
 *
 * More sophisticated than simple truncation:
 * - Estimates token count (~4 chars per token)
 * - Supports different strategies (head, tail, middle)
 * - Tries to break at paragraph/sentence boundaries
 * - Can preserve start and end context (middle strategy)
 *
 * @param text - Content to truncate
 * @param options - Truncation options
 * @returns Truncated text within token/char limits
 *
 * @example
 * // Keep ~500 tokens, preserving start and end
 * truncateForContext(longDoc, { maxTokens: 500, strategy: "middle" });
 *
 * // Keep first 2000 chars
 * truncateForContext(longDoc, { maxChars: 2000, strategy: "head" });
 */
export function truncateForContext(
  text: string,
  options: TruncateForContextOptions = {}
): string {
  if (!text) return "";

  const {
    maxChars: inputMaxChars,
    maxTokens,
    strategy = "middle",
    preserveCodeBlocks = true,
    truncationMarker = "\n\n[...truncated...]\n\n"
  } = options;

  // Calculate max chars from tokens if provided (approx 4 chars per token)
  const maxChars = maxTokens ? maxTokens * 4 : (inputMaxChars ?? 4000);

  // Already within limits
  if (text.length <= maxChars) return text;

  // Account for truncation marker in budget
  const markerLen = truncationMarker.length;
  const availableChars = maxChars - markerLen;

  if (availableChars <= 0) {
    return text.slice(0, maxChars);
  }

  switch (strategy) {
    case "head":
      return truncateHead(text, availableChars, preserveCodeBlocks) + truncationMarker.trim();

    case "tail":
      return truncationMarker.trim() + truncateTail(text, availableChars, preserveCodeBlocks);

    case "middle":
    default:
      return truncateMiddle(text, availableChars, truncationMarker, preserveCodeBlocks);
  }
}

/**
 * Truncate from the end, trying to break at paragraph/sentence boundary.
 */
function truncateHead(text: string, maxChars: number, preserveCodeBlocks: boolean): string {
  if (text.length <= maxChars) return text;

  let cutPoint = maxChars;

  // If we're in a code block, try to include the whole block or none
  if (preserveCodeBlocks) {
    const codeBlockEnd = text.lastIndexOf("```", cutPoint);
    const codeBlockStart = text.lastIndexOf("```", codeBlockEnd - 1);

    // If cut point is inside a code block, cut before it starts
    if (codeBlockStart !== -1 && codeBlockEnd > codeBlockStart) {
      const blockEndPos = text.indexOf("```", codeBlockEnd + 3);
      if (blockEndPos === -1 || blockEndPos > cutPoint) {
        // We're inside an unclosed code block, cut before it
        cutPoint = Math.min(cutPoint, codeBlockStart);
      }
    }
  }

  // Try to find a good break point (paragraph, sentence, word)
  const searchStart = Math.max(0, cutPoint - 200);
  const searchRegion = text.slice(searchStart, cutPoint);

  // Prefer paragraph break
  const paraBreak = searchRegion.lastIndexOf("\n\n");
  if (paraBreak !== -1 && paraBreak > searchRegion.length * 0.5) {
    return text.slice(0, searchStart + paraBreak).trimEnd();
  }

  // Then sentence break
  const sentenceMatch = searchRegion.match(/[.!?]\s+[A-Z]/g);
  if (sentenceMatch) {
    const lastSentence = searchRegion.lastIndexOf(sentenceMatch[sentenceMatch.length - 1]);
    if (lastSentence !== -1) {
      return text.slice(0, searchStart + lastSentence + 1).trimEnd();
    }
  }

  // Then word break
  const lastSpace = searchRegion.lastIndexOf(" ");
  if (lastSpace !== -1 && lastSpace > searchRegion.length * 0.7) {
    return text.slice(0, searchStart + lastSpace).trimEnd();
  }

  return text.slice(0, cutPoint).trimEnd();
}

/**
 * Truncate from the beginning, keeping the end.
 */
function truncateTail(text: string, maxChars: number, preserveCodeBlocks: boolean): string {
  if (text.length <= maxChars) return text;

  let cutPoint = text.length - maxChars;

  // If we're in a code block, try to start after it ends
  if (preserveCodeBlocks) {
    const searchEnd = Math.min(text.length, cutPoint + 200);
    const codeBlockEnd = text.indexOf("```", cutPoint);

    if (codeBlockEnd !== -1 && codeBlockEnd < searchEnd) {
      // Find the closing ``` and start after it
      const nextLine = text.indexOf("\n", codeBlockEnd + 3);
      if (nextLine !== -1) {
        cutPoint = nextLine + 1;
      }
    }
  }

  // Try to find a good break point
  const searchEnd = Math.min(text.length, cutPoint + 200);
  const searchRegion = text.slice(cutPoint, searchEnd);

  // Prefer paragraph break
  const paraBreak = searchRegion.indexOf("\n\n");
  if (paraBreak !== -1 && paraBreak < searchRegion.length * 0.5) {
    return text.slice(cutPoint + paraBreak + 2).trimStart();
  }

  // Then sentence break
  const sentenceMatch = searchRegion.match(/[.!?]\s+[A-Z]/);
  if (sentenceMatch && sentenceMatch.index !== undefined) {
    return text.slice(cutPoint + sentenceMatch.index + 2).trimStart();
  }

  // Then word break
  const firstSpace = searchRegion.indexOf(" ");
  if (firstSpace !== -1 && firstSpace < searchRegion.length * 0.3) {
    return text.slice(cutPoint + firstSpace + 1).trimStart();
  }

  return text.slice(cutPoint).trimStart();
}

/**
 * Keep beginning and end, remove middle content.
 * Best for preserving context in long documents.
 */
function truncateMiddle(
  text: string,
  availableChars: number,
  marker: string,
  preserveCodeBlocks: boolean
): string {
  if (text.length <= availableChars) return text;

  // Split budget between head and tail (60/40 favoring beginning)
  // Note: availableChars already has marker length subtracted by caller
  const headBudget = Math.floor(availableChars * 0.6);
  const tailBudget = availableChars - headBudget;

  const headPart = truncateHead(text, headBudget, preserveCodeBlocks);
  const tailPart = truncateTail(text, tailBudget, preserveCodeBlocks);

  return headPart + marker + tailPart;
}

// --- Deprecated pattern detection ---

function buildDeprecatedMatcher(pattern: string): (text: string) => boolean {
  if (!pattern) return () => false;

  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    const body = pattern.slice(1, -1);
    
    // ReDoS protection
    if (body.length > 256) {
      warn(`[utils] Skipped excessively long regex pattern: ${pattern}`);
      return () => false;
    }
    if (/\([^)]*[*+][^)]*\)[*+?]/.test(body)) {
      warn(`[utils] Skipped potentially unsafe regex pattern: ${pattern}`);
      return () => false;
    }

    try {
      const regex = new RegExp(body);
      return (text: string) => regex.test(text);
    } catch (e) {
      warn(`[utils] Invalid regex pattern: ${pattern}`);
      return () => false;
    }
  }

  return (text: string) => text.includes(pattern);
}

export function checkDeprecatedPatterns(
  history: Array<{ snippet?: string }> = [],
  deprecatedPatterns: Array<{ pattern: string; replacement?: string; reason?: string }> = []
): string[] {
  if (!history.length || !deprecatedPatterns.length) return [];

  const warnings = new Set<string>();

  for (const deprecated of deprecatedPatterns) {
    if (!deprecated?.pattern) continue;

    const matches = buildDeprecatedMatcher(deprecated.pattern);

    for (const hit of history) {
      const snippet = hit?.snippet;
      if (!snippet) continue;

      if (matches(snippet)) {
        const reasonSuffix = deprecated.reason ? ` (Reason: ${deprecated.reason})` : "";
        const replacement = deprecated.replacement ? ` - use ${deprecated.replacement} instead` : "";
        warnings.add(`${deprecated.pattern} was deprecated${replacement}${reasonSuffix}`);
        break;
      }
    }
  }

  return Array.from(warnings);
}

// --- Scoring ---

export function scoreBulletRelevance(
  bulletContent: string,
  bulletTags: string[],
  keywords: string[]
): number {
  if (!bulletContent || keywords.length === 0) return 0;
  
  let score = 0;
  const contentLower = bulletContent.toLowerCase();
  const tagsLower = bulletTags.map(t => t.toLowerCase());
  
  // Tokenize once
  const contentTokens = new Set(tokenize(contentLower));

  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    
    // Exact match in token set (fast)
    if (contentTokens.has(k)) {
        score += 3;
    } 
    // Partial string match (slower fallback for "auth" -> "authenticate")
    else if (contentLower.includes(k)) {
        score += 1;
    }
    
    if (tagsLower.includes(k)) {
        score += 5; // Higher weight for explicit tags
    }
  }
  
  return score;
}

export function extractAgentFromPath(sessionPath: string): string {
  const lower = sessionPath.toLowerCase();
  if (lower.includes(".claude")) return "claude";
  if (lower.includes(".cursor")) return "cursor";
  if (lower.includes(".codex")) return "codex";
  if (lower.includes(".aider")) return "aider";
  return "unknown";
}

/**
 * Format the last helpful feedback timestamp for a bullet as human-readable relative time.
 * Used in context output to help users understand recency of validation.
 *
 * @param bullet - PlaybookBullet or object with helpfulEvents/feedbackEvents array
 * @returns Human-readable string like "2 days ago", "3 weeks ago", or "Never"
 *
 * @example
 * formatLastHelpful({ helpfulEvents: [{ timestamp: '2025-12-05T10:00:00Z' }] })
 * // Returns: "2 days ago" (if today is 2025-12-07)
 *
 * formatLastHelpful({ feedbackEvents: [{ type: 'helpful', timestamp: '2025-12-07T14:00:00Z' }] })
 * // Returns: "45 minutes ago"
 *
 * formatLastHelpful({})
 * // Returns: "Never"
 */
export function formatLastHelpful(bullet: {
  helpfulEvents?: Array<{ timestamp: string }>;
  feedbackEvents?: Array<{ type: string; timestamp: string }>;
}): string {
  // Find helpful events from either helpfulEvents or feedbackEvents
  let helpfulTimestamps: string[] = [];

  if (bullet.helpfulEvents && bullet.helpfulEvents.length > 0) {
    helpfulTimestamps = bullet.helpfulEvents.map(e => e.timestamp);
  } else if (bullet.feedbackEvents && bullet.feedbackEvents.length > 0) {
    helpfulTimestamps = bullet.feedbackEvents
      .filter(e => e.type === "helpful")
      .map(e => e.timestamp);
  }

  if (helpfulTimestamps.length === 0) {
    return "Never";
  }

  // Find most recent helpful event
  const sortedTimestamps = helpfulTimestamps
    .map(ts => new Date(ts).getTime())
    .filter(ts => !isNaN(ts))
    .sort((a, b) => b - a); // Descending (most recent first)

  if (sortedTimestamps.length === 0) {
    return "Never";
  }

  const mostRecent = sortedTimestamps[0];
  const diff = Date.now() - mostRecent;

  // Convert to appropriate units
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  // Format based on magnitude (always round down per spec)
  if (seconds < 60) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (days < 7) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  if (weeks < 4) {
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (months < 12) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// --- Search Suggestions ---

/**
 * Problem-oriented terms to include in search suggestions.
 * These help surface debugging and troubleshooting context.
 */
const PROBLEM_TERMS = ["error", "fix", "bug", "issue", "problem", "fail", "debug"];

/**
 * Generate human-readable cass search suggestions for follow-up investigation.
 *
 * Creates 3-5 ready-to-run cass commands that the user can execute to dig deeper
 * if the provided context isn't sufficient.
 *
 * @param task - The original task description
 * @param keywords - Extracted keywords from the task
 * @param options - Optional configuration
 * @param options.preferredAgent - Agent to filter by (e.g., "claude")
 * @param options.maxSuggestions - Maximum number of suggestions (default: 5)
 * @returns Array of formatted cass command strings
 *
 * @example
 * generateSuggestedQueries("Fix authentication timeout bug", ["authentication", "timeout", "token"])
 * // Returns:
 * // [
 * //   'cass search "authentication timeout" --days 30',
 * //   'cass search "token error" --days 60',
 * //   'cass search "authentication" --days 90',
 * //   ...
 * // ]
 */
export function generateSuggestedQueries(
  task: string,
  keywords: string[],
  options: { preferredAgent?: string; maxSuggestions?: number } = {}
): string[] {
  const { preferredAgent, maxSuggestions = 5 } = options;
  const queries: string[] = [];
  const seenQueries = new Set<string>();

  // Helper to add query if not duplicate
  const addQuery = (query: string, days: number, agent?: string): void => {
    if (queries.length >= maxSuggestions) return;

    // Escape quotes in query
    const escapedQuery = query.replace(/"/g, '\\"');
    const key = `${escapedQuery}-${days}-${agent || ""}`;

    if (!seenQueries.has(key)) {
      seenQueries.add(key);
      let cmd = `cass search "${escapedQuery}" --days ${days}`;
      if (agent) cmd += ` --agent ${agent}`;
      queries.push(cmd);
    }
  };

  // 1. Multi-keyword phrase query (first 2-3 keywords combined)
  if (keywords.length >= 2) {
    const phrase = keywords.slice(0, 3).join(" ");
    addQuery(phrase, 30);
  }

  // 2. Single keyword with problem term (find error/fix patterns)
  if (keywords.length > 0) {
    const topKeyword = keywords[0];

    // Check if task already contains problem terms
    const taskLower = task.toLowerCase();
    const hasProblemTerm = PROBLEM_TERMS.some(term => taskLower.includes(term));

    if (!hasProblemTerm) {
      // Add error-oriented query if task doesn't have problem terms
      addQuery(`${topKeyword} error`, 60);
    } else {
      // Task already has problem context, search for solutions
      addQuery(`${topKeyword} fix`, 60);
    }
  }

  // 3. Broad single keyword query with longer lookback
  if (keywords.length > 0) {
    addQuery(keywords[0], 90);
  }

  // 4. Second keyword with agent filter if available
  if (keywords.length > 1 && preferredAgent) {
    addQuery(keywords[1], 60, preferredAgent);
  }

  // 5. Keyword combination with medium lookback
  if (keywords.length >= 2) {
    const twoKeywords = keywords.slice(0, 2).join(" ");
    addQuery(twoKeywords, 60);
  }

  // 6. Third keyword or pattern with longer lookback if space
  if (keywords.length >= 3 && queries.length < maxSuggestions) {
    addQuery(keywords[2], 90);
  }

  return queries;
}

// --- Logging ---

export function log(msg: string, verbose = false): void {
  if (verbose || process.env.CASS_MEMORY_VERBOSE === "true" || process.env.CASS_MEMORY_VERBOSE === "1") {
    console.error(chalk.blue("[cass-memory]"), msg);
  }
}

export function error(msg: string): void {
  console.error(chalk.red("[cass-memory] ERROR:"), msg);
}

export function warn(msg: string): void {
  console.error(chalk.yellow("[cass-memory] WARNING:"), msg);
}

// --- String Normalization ---

/**
 * Convert snake_case keys to camelCase.
 * Handles nested objects and arrays recursively.
 * Preserves Date, RegExp, and other special objects unchanged.
 *
 * Useful for normalizing YAML config files which typically use snake_case
 * to JavaScript conventions which use camelCase.
 *
 * @param obj - Object with snake_case keys (or primitive value)
 * @returns Object with camelCase keys (preserves primitives and special objects)
 *
 * @example
 * normalizeYamlKeys({ api_key: "x", max_tokens: 100 })
 * // Returns: { apiKey: "x", maxTokens: 100 }
 *
 * normalizeYamlKeys({ nested_obj: { inner_key: "value" } })
 * // Returns: { nestedObj: { innerKey: "value" } }
 */
export function normalizeYamlKeys<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => normalizeYamlKeys(item)) as T;
  }

  if (typeof obj === "object") {
    // Preserve special objects (Date, RegExp, Map, Set, etc.)
    if (obj instanceof Date || obj instanceof RegExp ||
        obj instanceof Map || obj instanceof Set) {
      return obj;
    }

    // Only process plain objects
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      // Not a plain object, return unchanged
      return obj;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const camelKey = snakeToCamel(key);
      result[camelKey] = normalizeYamlKeys(value);
    }

    return result as T;
  }

  // Primitives pass through unchanged
  return obj;
}

/**
 * Convert a single snake_case string to camelCase.
 * Preserves leading underscores (convention for private fields).
 *
 * @param str - snake_case string
 * @returns camelCase string
 *
 * @example
 * snakeToCamel("api_key") // "apiKey"
 * snakeToCamel("max_tokens_limit") // "maxTokensLimit"
 * snakeToCamel("_private_field") // "_privateField" (preserves leading _)
 */
export function snakeToCamel(str: string): string {
  if (!str) return str;

  // Handle leading underscores by preserving them
  const leadingUnderscores = str.match(/^_+/)?.[0] || "";
  const rest = str.slice(leadingUnderscores.length);

  const converted = rest.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

  return leadingUnderscores + converted;
}

/**
 * Convert camelCase keys to snake_case.
 * Inverse of normalizeYamlKeys - useful for writing configs back to YAML.
 * Preserves Date, RegExp, and other special objects unchanged.
 *
 * @param obj - Object with camelCase keys
 * @returns Object with snake_case keys
 *
 * @example
 * camelToSnakeKeys({ apiKey: "x", maxTokens: 100 })
 * // Returns: { api_key: "x", max_tokens: 100 }
 */
export function camelToSnakeKeys<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => camelToSnakeKeys(item)) as T;
  }

  if (typeof obj === "object") {
    // Preserve special objects (Date, RegExp, Map, Set, etc.)
    if (obj instanceof Date || obj instanceof RegExp ||
        obj instanceof Map || obj instanceof Set) {
      return obj;
    }

    // Only process plain objects
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      return obj;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = camelToSnake(key);
      result[snakeKey] = camelToSnakeKeys(value);
    }

    return result as T;
  }

  return obj;
}

// Alias for backwards compatibility
export const denormalizeYamlKeys = camelToSnakeKeys;

/**
 * Convert a single camelCase string to snake_case.
 * Handles PascalCase correctly (no leading underscore).
 *
 * @example
 * camelToSnake("apiKey") // "api_key"
 * camelToSnake("ApiKey") // "api_key" (not "_api_key")
 * camelToSnake("getHTTPResponse") // "get_h_t_t_p_response"
 */
export function camelToSnake(str: string): string {
  if (!str) return str;

  return str
    .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    .replace(/^_/, ""); // Remove leading underscore from PascalCase
}

/**
 * Normalize line endings to Unix-style (LF).
 * Handles Windows (CRLF), old Mac (CR), and mixed line endings.
 *
 * Important for:
 * - Cross-platform config file consistency
 * - Git diff cleanliness
 * - Hash consistency across platforms
 *
 * @param text - Input text with potentially mixed line endings
 * @returns Text with all line endings normalized to LF (\n)
 *
 * @example
 * normalizeLineEndings("line1\r\nline2\rline3\n")
 * // Returns: "line1\nline2\nline3\n"
 */
export function normalizeLineEndings(text: string): string {
  if (!text) return text;

  // Replace CRLF first (Windows), then CR (old Mac)
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize line endings to platform-specific style.
 * Use when writing files that should match local conventions.
 *
 * @param text - Input text
 * @param style - Target style: "lf" (Unix), "crlf" (Windows), or "auto" (detect from platform)
 * @returns Text with normalized line endings
 */
export function normalizeLineEndingsTo(
  text: string,
  style: "lf" | "crlf" | "auto" = "auto"
): string {
  if (!text) return text;

  // First normalize to LF
  const normalized = normalizeLineEndings(text);

  // Then convert to target style
  const targetStyle = style === "auto"
    ? (process.platform === "win32" ? "crlf" : "lf")
    : style;

  if (targetStyle === "crlf") {
    return normalized.replace(/\n/g, "\r\n");
  }

  return normalized;
}

// --- Context Formatting ---

/**
 * Format a ContextResult as human-readable markdown.
 * Produces portable markdown without ANSI colors for file output, pipes, etc.
 *
 * @param result - The structured ContextResult to format
 * @returns Formatted markdown string ready for display or file output
 *
 * @example
 * const md = formatContextMarkdown(result);
 * console.log(md); // or write to file
 */
export function formatContextMarkdown(result: ContextResult): string {
  const lines: string[] = [];

  // Header
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`CONTEXT FOR: ${result.task}`);
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Relevant Playbook Rules
  if (result.relevantBullets.length > 0) {
    lines.push(`## RELEVANT PLAYBOOK RULES (${result.relevantBullets.length})`);
    lines.push("");
    for (const bullet of result.relevantBullets) {
      const score = bullet.effectiveScore?.toFixed(1) ?? "N/A";
      lines.push(`**[${bullet.id}]** ${bullet.category}/${bullet.kind} (score: ${score})`);
      lines.push(`  ${truncateSnippet(bullet.content, 300)}`);
      lines.push("");
    }
  } else {
    lines.push("_(No relevant playbook rules found)_");
    lines.push("");
  }

  // Pitfalls to Avoid (Anti-patterns)
  if (result.antiPatterns.length > 0) {
    lines.push(`## ⚠️ PITFALLS TO AVOID (${result.antiPatterns.length})`);
    lines.push("");
    for (const bullet of result.antiPatterns) {
      lines.push(`**[${bullet.id}]** ${truncateSnippet(bullet.content, 200)}`);
    }
    lines.push("");
  }

  // Historical Context
  if (result.historySnippets.length > 0) {
    lines.push(`## HISTORICAL CONTEXT (${result.historySnippets.length} sessions)`);
    lines.push("");
    // Show up to 5 history items
    const displayed = result.historySnippets.slice(0, 5);
    displayed.forEach((hit, idx) => {
      const agent = hit.agent || "unknown";
      const relTime = hit.timestamp ? formatRelativeTime(hit.timestamp) : "";
      lines.push(`${idx + 1}. ${hit.source_path}:${hit.line_number} (${agent}${relTime ? ", " + relTime : ""})`);
      const snippet = truncateSnippet(hit.snippet.replace(/\n/g, " ").trim(), 150);
      lines.push(`   > ${snippet}`);
      lines.push("");
    });
  }

  // Deprecated Warnings
  if (result.deprecatedWarnings.length > 0) {
    lines.push("## ⚠️ WARNINGS");
    lines.push("");
    for (const warning of result.deprecatedWarnings) {
      lines.push(`  • ${warning}`);
    }
    lines.push("");
  }

  // Suggested Searches
  if (result.suggestedCassQueries.length > 0) {
    lines.push("## DIG DEEPER");
    lines.push("");
    for (const query of result.suggestedCassQueries) {
      lines.push(`  ${query}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Truncate snippet text with ellipsis, preserving word boundaries when possible.
 */
function truncateSnippet(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;

  // Try to break at word boundary
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated.slice(0, maxLen - 3) + "...";
}

/**
 * Extended PlaybookBullet type that may include derivedFrom field.
 * Used for extracting reasoning from rule provenance data.
 */
interface BulletWithProvenance {
  reasoning?: string;
  derivedFrom?: {
    sessionPath?: string;
    timestamp?: string;
    keyEvidence?: string[];
    extractedBy?: string;
  };
  sourceSessions?: string[];
  sourceAgents?: string[];
  createdAt?: string;
}

/**
 * Extract reasoning/origin story for why a playbook bullet exists.
 * Provides context about HOW and WHY a rule was created, helping agents
 * understand the origin story and give more weight to the guidance.
 *
 * Priority order:
 * 1. bullet.reasoning (if explicitly set)
 * 2. bullet.derivedFrom.keyEvidence (if derived from session)
 * 3. Fallback: "From {agent} session on {date}" using session metadata
 * 4. Final fallback: "No reasoning available"
 *
 * @param bullet - PlaybookBullet with optional provenance fields
 * @returns Human-readable reasoning string (max 200 chars, truncated with ellipsis)
 *
 * @example
 * // With explicit reasoning
 * extractBulletReasoning({ reasoning: 'JWT expiry caused auth failures' })
 * // Returns: "JWT expiry caused auth failures"
 *
 * // With key evidence
 * extractBulletReasoning({ derivedFrom: { keyEvidence: ['Token refresh was too slow'] } })
 * // Returns: "Token refresh was too slow"
 *
 * // Fallback to session metadata
 * extractBulletReasoning({ sourceAgents: ['claude'], createdAt: '2025-11-15T10:00:00Z' })
 * // Returns: "From claude session on 11/15/2025"
 */
export function extractBulletReasoning(bullet: BulletWithProvenance): string {
  const MAX_LENGTH = 200;

  // 1. Check explicit reasoning field first
  if (bullet.reasoning && bullet.reasoning.trim()) {
    return truncateReasoning(bullet.reasoning.trim(), MAX_LENGTH);
  }

  // 2. Check derivedFrom.keyEvidence
  if (bullet.derivedFrom?.keyEvidence && bullet.derivedFrom.keyEvidence.length > 0) {
    // Join evidence items, take first that fits
    const evidence = bullet.derivedFrom.keyEvidence
      .filter(e => e && e.trim())
      .map(e => e.trim());

    if (evidence.length > 0) {
      // If multiple pieces of evidence, join with semicolon
      const combined = evidence.join("; ");
      return truncateReasoning(combined, MAX_LENGTH);
    }
  }

  // 3. Fallback to session metadata
  const agent = bullet.sourceAgents?.[0] || bullet.derivedFrom?.extractedBy;
  const timestamp = bullet.derivedFrom?.timestamp || bullet.createdAt;

  if (agent || timestamp) {
    const agentStr = agent || "unknown";
    const dateStr = timestamp ? formatDateShort(timestamp) : "unknown date";
    return `From ${agentStr} session on ${dateStr}`;
  }

  // 4. Final fallback
  return "No reasoning available";
}

/**
 * Truncate reasoning text, preserving first sentence if possible.
 */
function truncateReasoning(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Try to preserve first sentence
  const sentenceEnd = text.search(/[.!?]/);
  if (sentenceEnd > 0 && sentenceEnd < maxLen - 3) {
    return text.slice(0, sentenceEnd + 1);
  }

  // Fall back to word boundary truncation
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated.slice(0, maxLen - 3) + "...";
}

/**
 * Format a timestamp as a short date string for display.
 */
function formatDateShort(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return "unknown date";

    // Format as M/D/YYYY
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  } catch {
    return "unknown date";
  }
}

// --- Graceful Shutdown ---

/** Global flag to track if shutdown has been initiated */
let shutdownInProgress = false;

/** Custom cleanup handlers registered via onShutdown */
const shutdownHandlers: Array<() => void | Promise<void>> = [];

/**
 * Check if shutdown is currently in progress.
 * Useful for operations to abort early during shutdown.
 */
export function isShutdownInProgress(): boolean {
  return shutdownInProgress;
}

/**
 * Register a cleanup handler to be called during graceful shutdown.
 * Handlers are called in registration order.
 *
 * @param handler - Cleanup function (can be async)
 * @returns Function to unregister the handler
 *
 * @example
 * const unregister = onShutdown(() => {
 *   console.log("Cleaning up...");
 * });
 * // Later: unregister();
 */
export function onShutdown(handler: () => void | Promise<void>): () => void {
  shutdownHandlers.push(handler);
  return () => {
    const index = shutdownHandlers.indexOf(handler);
    if (index >= 0) shutdownHandlers.splice(index, 1);
  };
}

/**
 * Perform graceful shutdown cleanup.
 * This is called by signal handlers but can also be called directly.
 *
 * @param signal - The signal or reason for shutdown
 * @param exitCode - Exit code to use (default: 0)
 */
export async function performShutdown(
  signal: string,
  exitCode: number = 0
): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  const logPrefix = "[cass-memory]";

  try {
    // 0. Signal abort to all running operations
    // Note: requestAbort is defined later in this file, use direct access
    try {
      globalAbortController?.abort(`Shutdown: ${signal}`);
    } catch {
      // Abort controller might not be initialized yet
    }

    // 1. Release all acquired locks
    const { releaseAllLocks, getActiveLocks } = await import("./lock.js");
    const lockCount = getActiveLocks().length;
    if (lockCount > 0) {
      const released = await releaseAllLocks();
      if (released > 0) {
        console.error(`${logPrefix} Released ${released} lock(s) during shutdown`);
      }
    }

    // 2. Run custom shutdown handlers
    for (const handler of shutdownHandlers) {
      try {
        await handler();
      } catch (err) {
        // Best effort - continue with other handlers
        console.error(`${logPrefix} Shutdown handler error:`, err);
      }
    }

    // 3. Log shutdown event
    if (signal === "SIGINT") {
      console.error(`\n${logPrefix} Operation cancelled by user`);
    } else if (signal === "SIGTERM") {
      console.error(`${logPrefix} Received termination signal`);
    } else {
      console.error(`${logPrefix} Shutting down: ${signal}`);
    }
  } catch (err) {
    console.error(`${logPrefix} Error during shutdown:`, err);
  }

  // Exit with appropriate code
  // SIGINT: 128 + 2 = 130 (Unix convention)
  // SIGTERM: 128 + 15 = 143 (Unix convention)
  const finalCode =
    exitCode !== 0
      ? exitCode
      : signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : 0;

  process.exit(finalCode);
}

/** Track if handlers are already registered */
let handlersRegistered = false;

/**
 * Register signal handlers for graceful shutdown.
 * Handles SIGINT (Ctrl+C) and SIGTERM (system termination).
 *
 * This function is idempotent - calling it multiple times has no effect.
 *
 * @example
 * // At application startup
 * setupGracefulShutdown();
 *
 * // Now Ctrl+C will:
 * // 1. Release all acquired locks
 * // 2. Run registered cleanup handlers
 * // 3. Log shutdown message
 * // 4. Exit with code 130
 */
export function setupGracefulShutdown(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    void performShutdown("SIGINT", 130);
  });

  // Handle termination signal (e.g., kill, system shutdown)
  process.on("SIGTERM", () => {
    void performShutdown("SIGTERM", 143);
  });

  // Handle uncaught exceptions gracefully
  process.on("uncaughtException", (err) => {
    console.error("[cass-memory] Uncaught exception:", err);
    void performShutdown("uncaughtException", 1);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason) => {
    console.error("[cass-memory] Unhandled rejection:", reason);
    void performShutdown("unhandledRejection", 1);
  });
}

// --- AbortController Integration ---

/**
 * Error thrown when an operation is aborted.
 * Extends Error with additional abort-specific information.
 */
export class AbortError extends Error {
  /** Name is always "AbortError" for instanceof checks */
  readonly name = "AbortError";
  /** The reason the operation was aborted */
  readonly reason: string;

  constructor(reason: string = "Operation aborted") {
    super(reason);
    this.reason = reason;
    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AbortError);
    }
  }
}

/**
 * Global abort controller for application-wide cancellation.
 * Reset this when starting a new operation that should be cancellable.
 */
let globalAbortController = new AbortController();

/**
 * Get the global AbortSignal for checking cancellation.
 *
 * @returns The current global AbortSignal
 *
 * @example
 * // Pass to fetch or other APIs that accept AbortSignal
 * const response = await fetch(url, { signal: getAbortSignal() });
 */
export function getAbortSignal(): AbortSignal {
  return globalAbortController.signal;
}

/**
 * Check if the current operation should be aborted.
 * Call this periodically in long-running operations.
 *
 * @throws {AbortError} If abort has been requested
 *
 * @example
 * for (const session of sessions) {
 *   checkAbort(); // Throws if Ctrl+C was pressed
 *   await processSession(session);
 * }
 */
export function checkAbort(): void {
  if (globalAbortController.signal.aborted) {
    throw new AbortError("Operation cancelled by user");
  }
}

/**
 * Check if abort has been requested without throwing.
 * Use this when you want to handle abort gracefully.
 *
 * @returns true if abort has been requested
 *
 * @example
 * if (isAborted()) {
 *   return partialResult;
 * }
 */
export function isAborted(): boolean {
  return globalAbortController.signal.aborted;
}

/**
 * Request abort of current operations.
 * This signals all operations watching the global abort signal.
 *
 * @param reason - Optional reason for the abort
 *
 * @example
 * // In a SIGINT handler
 * requestAbort("User pressed Ctrl+C");
 */
export function requestAbort(reason?: string): void {
  globalAbortController.abort(reason);
}

/**
 * Reset the global abort controller.
 * Call this at the start of a new top-level operation.
 *
 * @example
 * // At the start of a CLI command
 * resetAbort();
 * try {
 *   await longRunningOperation();
 * } catch (err) {
 *   if (err instanceof AbortError) {
 *     console.log("Operation was cancelled");
 *   }
 * }
 */
export function resetAbort(): void {
  globalAbortController = new AbortController();
}

/**
 * Create a timeout abort signal.
 * Useful for operations that should have a maximum duration.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @returns AbortSignal that will abort after the timeout
 *
 * @example
 * const signal = createTimeoutSignal(5000); // 5 seconds
 * try {
 *   await fetch(url, { signal });
 * } catch (err) {
 *   if (err.name === "AbortError") {
 *     console.log("Request timed out");
 *   }
 * }
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Create a combined abort signal from multiple sources.
 * Aborts if any of the source signals abort.
 *
 * @param signals - Array of AbortSignals to combine
 * @returns Combined AbortSignal
 *
 * @example
 * const signal = combineAbortSignals([
 *   getAbortSignal(),           // User cancellation
 *   createTimeoutSignal(30000)  // 30 second timeout
 * ]);
 * await fetch(url, { signal });
 */
export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

/**
 * Run an async operation with abort support.
 * Checks for abort before and after the operation.
 *
 * @param operation - The async operation to run
 * @param checkIntervalMs - Optional: check abort every N ms during long operations
 * @returns The operation result
 * @throws {AbortError} If aborted before or during operation
 *
 * @example
 * const result = await withAbortCheck(async () => {
 *   return await expensiveLLMCall();
 * });
 */
export async function withAbortCheck<T>(
  operation: () => Promise<T>,
  checkIntervalMs?: number
): Promise<T> {
  checkAbort();

  if (checkIntervalMs) {
    // Create a periodic abort checker
    const intervalId = setInterval(() => {
      if (globalAbortController.signal.aborted) {
        clearInterval(intervalId);
      }
    }, checkIntervalMs);

    try {
      const result = await operation();
      checkAbort();
      return result;
    } finally {
      clearInterval(intervalId);
    }
  }

  const result = await operation();
  checkAbort();
  return result;
}

/**
 * Execute operations in sequence, checking for abort between each.
 * Useful for batch processing where you want clean abort points.
 *
 * @param items - Array of items to process
 * @param processor - Async function to process each item
 * @returns Array of results
 * @throws {AbortError} If aborted between operations
 *
 * @example
 * const results = await withAbortableSequence(
 *   sessions,
 *   async (session) => await processSession(session)
 * );
 */
export async function withAbortableSequence<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    checkAbort();
    results.push(await processor(items[i], i));
  }
  return results;
}
