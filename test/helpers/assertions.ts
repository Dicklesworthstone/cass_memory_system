import { readFile, stat } from "node:fs/promises";
import { PlaybookSchema, PlaybookBulletSchema, ConfigSchema } from "../../src/types.js";
import type { Playbook, PlaybookBullet, Config } from "../../src/types.js";

/**
 * Assert that a value is a valid Playbook according to the schema.
 * Throws with detailed error if validation fails.
 */
export function expectValidPlaybook(value: unknown): asserts value is Playbook {
  const result = PlaybookSchema.safeParse(value);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid Playbook:\n${errors}`);
  }
}

/**
 * Assert that a value is a valid PlaybookBullet according to the schema.
 */
export function expectValidBullet(value: unknown): asserts value is PlaybookBullet {
  const result = PlaybookBulletSchema.safeParse(value);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid PlaybookBullet:\n${errors}`);
  }
}

/**
 * Assert that a value is a valid Config according to the schema.
 */
export function expectValidConfig(value: unknown): asserts value is Config {
  const result = ConfigSchema.safeParse(value);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid Config:\n${errors}`);
  }
}

/**
 * Assert that a file exists and contains the expected content.
 */
export async function expectFileContains(
  filePath: string,
  expectedContent: string
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  if (!content.includes(expectedContent)) {
    throw new Error(
      `File ${filePath} does not contain expected content.\n` +
      `Expected to find: "${expectedContent.slice(0, 100)}..."\n` +
      `Actual content: "${content.slice(0, 200)}..."`
    );
  }
}

/**
 * Assert that a file exists.
 */
export async function expectFileExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

/**
 * Assert that a file does not exist.
 */
export async function expectFileNotExists(filePath: string): Promise<void> {
  try {
    await stat(filePath);
    throw new Error(`Expected file to NOT exist: ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist - this is expected
  }
}

/**
 * Assert arrays have same elements (order-independent).
 */
export function expectSameElements<T>(actual: T[], expected: T[]): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();

  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `Arrays don't have same elements.\n` +
      `Expected: ${JSON.stringify(sortedExpected)}\n` +
      `Actual: ${JSON.stringify(sortedActual)}`
    );
  }
}
