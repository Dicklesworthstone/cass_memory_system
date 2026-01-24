/**
 * E2E Tests for CLI playbook command - Playbook management
 *
 * Tests the `cm playbook` command for listing, adding, removing,
 * getting, exporting, and importing playbook bullets.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { playbookCommand } from "../src/commands/playbook.js";
import { withTempCassHome, TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

// Helper to capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

// Helper to create a valid test playbook
function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    bullets: bullets,
    deprecatedPatterns: []
  };
}

// Helper to create a valid test bullet
function createTestBullet(overrides: Partial<{
  id: string;
  content: string;
  kind: string;
  category: string;
  scope: string;
  workspace?: string;
  tags: string[];
  maturity: string;
  isNegative?: boolean;
  effectiveScore?: number;
  helpfulCount?: number;
  harmfulCount?: number;
  deprecated?: boolean;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "stack_pattern",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    workspace: overrides.workspace,
    tags: overrides.tags || [],
    maturity: overrides.maturity || "candidate",
    isNegative: overrides.isNegative || false,
    effectiveScore: overrides.effectiveScore ?? 0.8,
    state: "active",
    type: overrides.isNegative ? "anti-pattern" : "rule",
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    deprecated: overrides.deprecated ?? false,
    createdAt: now,
    updatedAt: now
  };
}

describe("E2E: CLI playbook command", () => {
  describe("list action", () => {
    it("lists empty playbook gracefully", async () => {
      const log = createE2ELogger("cli-playbook: list empty playbook");
      log.setRepro("bun test test/cli-playbook.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Write empty playbook", { playbookPath: env.playbookPath });
          const playbook = createTestPlaybook([]);
          await writeFile(env.playbookPath, yaml.stringify(playbook));

          const capture = captureConsole();
          try {
            log.startTimer("playbookCommand:list");
            await playbookCommand("list", [], {});
            log.endTimer("playbookCommand:list");
          } finally {
            capture.restore();
          }

          const output = capture.logs.join("\n");
          log.snapshot("stdout", output);
          log.snapshot("stderr", capture.errors.join("\n"));
          expect(output).toContain("PLAYBOOK RULES (0)");
        });
      });
    });

    it("lists all active bullets", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "bullet-1",
            content: "First rule content",
            category: "security"
          }),
          createTestBullet({
            id: "bullet-2",
            content: "Second rule content",
            category: "testing"
          }),
          createTestBullet({
            id: "bullet-3",
            content: "Third rule content",
            category: "security"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("list", [], {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("PLAYBOOK RULES (3)");
        expect(output).toContain("bullet-1");
        expect(output).toContain("bullet-2");
        expect(output).toContain("bullet-3");
        expect(output).toContain("First rule content");
        expect(output).toContain("Second rule content");
      });
    });

    it("prints JSON when --format json is set (even without --json)", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "bullet-1",
            content: "First rule content",
            category: "security"
          }),
          createTestBullet({
            id: "bullet-2",
            content: "Second rule content",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("list", [], { format: "json" });
        } finally {
          capture.restore();
        }

        expect(capture.errors.length).toBe(0);
        const payload = JSON.parse(capture.logs.join("\n")) as any;
        expect(payload.success).toBe(true);
        expect(Array.isArray(payload.data.bullets)).toBe(true);
        expect(payload.data.bullets.length).toBe(2);
        expect(payload.data.bullets.map((b: any) => b.id)).toEqual(["bullet-1", "bullet-2"]);
      });
    });

    it("filters by category", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "sec-1",
            content: "Security rule",
            category: "security"
          }),
          createTestBullet({
            id: "test-1",
            content: "Testing rule",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("list", [], { category: "security" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("sec-1");
        expect(output).not.toContain("test-1");
      });
    });

    it("outputs JSON when --json flag is set", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "json-bullet",
            content: "Test for JSON output",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("list", [], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const parsed = payload.data;

        expect(payload.success).toBe(true);
        expect(Array.isArray(parsed.bullets)).toBe(true);
        expect(parsed.bullets.length).toBe(1);
        expect(parsed.bullets[0].id).toBe("json-bullet");
      });
    });

    it("excludes deprecated bullets from list", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "active-bullet",
            content: "Active rule",
            category: "testing"
          }),
          createTestBullet({
            id: "deprecated-bullet",
            content: "Deprecated rule",
            category: "testing",
            deprecated: true
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("list", [], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const parsed = payload.data;

        expect(payload.success).toBe(true);
        expect(parsed.bullets.length).toBe(1);
        expect(parsed.bullets[0].id).toBe("active-bullet");
      });
    });
  });

  describe("add action", () => {
    it("adds a bullet with default category", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("add", ["Always use TypeScript strict mode"], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.bullet.content).toBe("Always use TypeScript strict mode");
        expect(result.bullet.category).toBe("general");

        // Verify bullet was saved to playbook
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(1);
        expect(savedPlaybook.bullets[0].content).toBe("Always use TypeScript strict mode");
      });
    });

    it("adds a bullet with custom category", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("add", ["Use bun for testing"], { category: "tooling", json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.bullet.category).toBe("tooling");
      });
    });

    it("adds multiple bullets sequentially", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Add first bullet
        let capture = captureConsole();
        try {
          await playbookCommand("add", ["First rule"], { json: true });
        } finally {
          capture.restore();
        }

        // Add second bullet
        capture = captureConsole();
        try {
          await playbookCommand("add", ["Second rule"], { json: true });
        } finally {
          capture.restore();
        }

        // Verify both bullets saved
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(2);
      });
    });

    it("outputs human-readable confirmation by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("add", ["New rule content"], {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Added bullet");
      });
    });

    it("reports error when content is missing", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode as number | undefined).toBe(2);
        const output = capture.logs.join("\n");
        const result = JSON.parse(output) as any;
        expect(result.success).toBe(false);
        expect(result.error.code).toBe("MISSING_REQUIRED");
        process.exitCode = 0;
      });
    });
  });

  describe("add action with --file (batch add)", () => {
    it("adds multiple rules from JSON file", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create batch input file
        const batchRules = [
          { content: "Always use strict TypeScript" },
          { content: "Write tests for new features", category: "testing" },
          { content: "Document public APIs", category: "documentation" }
        ];
        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify(batchRules));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.summary.total).toBe(3);
        expect(result.summary.succeeded).toBe(3);
        expect(result.added.length).toBe(3);

        // Verify rules were saved
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(3);
      });
    });

    it("uses --category flag as default for rules without category", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchRules = [
          { content: "Rule without category" },
          { content: "Rule with category", category: "specific" }
        ];
        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify(batchRules));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, category: "security", json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        // First rule uses default category, second uses its own
        expect(result.added[0].category).toBe("security");
        expect(result.added[1].category).toBe("specific");
      });
    });

    it("handles invalid JSON gracefully", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchPath = path.join(env.cassMemoryDir, "invalid.json");
        await writeFile(batchPath, "{ invalid json }");

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;

        // Outer success is true (command ran), but data.success is false (batch failed)
        expect(payload.success).toBe(true);
        expect(payload.data.success).toBe(false);
        expect(payload.data.summary.failed).toBe(1);
        expect(payload.data.failed[0].error).toContain("Invalid JSON");
      });
    });

    it("handles file not found gracefully", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: "/nonexistent/batch.json", json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;

        // Outer success is true (command ran), but data.success is false (batch failed)
        expect(payload.success).toBe(true);
        expect(payload.data.success).toBe(false);
        expect(payload.data.summary.failed).toBe(1);
        expect(payload.data.failed[0].error).toContain("Failed to read");
      });
    });

    it("validates rule schema and reports failures", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchRules = [
          { content: "Valid rule" },
          { content: "" }, // Empty content - invalid
          { notContent: "Missing content field" }, // Wrong field
          { content: "Another valid rule" }
        ];
        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify(batchRules));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        // 2 valid, 2 failed (empty content and missing content)
        expect(result.summary.succeeded).toBe(2);
        expect(result.summary.failed).toBe(2);
        expect(result.failed.length).toBe(2);
      });
    });

    it("handles non-array JSON input", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify({ content: "Not an array" }));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;

        // Outer success is true (command ran), but data.success is false (batch failed)
        expect(payload.success).toBe(true);
        expect(payload.data.success).toBe(false);
        expect(payload.data.failed[0].error).toContain("must be a JSON array");
      });
    });

    it("handles empty array input gracefully", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify([]));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;

        expect(payload.success).toBe(true);
        expect(payload.data.summary.total).toBe(0);
      });
    });

    it("outputs human-readable batch results without --json", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const batchRules = [
          { content: "First batch rule" },
          { content: "Second batch rule" }
        ];
        const batchPath = path.join(env.cassMemoryDir, "batch.json");
        await writeFile(batchPath, JSON.stringify(batchRules));

        const capture = captureConsole();
        try {
          await playbookCommand("add", [], { file: batchPath });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("BATCH ADD RESULTS");
        expect(output).toContain("Added 2 rules");
        expect(output).toContain("2 added");
      });
    });
  });

  describe("remove action", () => {
    it("deprecates a bullet by ID (soft delete)", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "to-remove",
            content: "This will be deprecated",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["to-remove"], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.action).toBe("deprecated");

        // Verify bullet is deprecated but still exists
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(1);
        expect(savedPlaybook.bullets[0].deprecated).toBe(true);
      });
    });

    it("hard deletes a bullet with --hard flag", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "to-delete",
            content: "This will be deleted",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["to-delete"], { hard: true, yes: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.action).toBe("deleted");

        // Verify bullet is completely removed
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(0);
      });
    });

    it("refuses hard delete without explicit confirmation (requires --yes in non-interactive/json)", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "to-delete",
            content: "This will NOT be deleted",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Reset exitCode before test
        process.exitCode = 0;

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["to-delete"], { hard: true, json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode as number | undefined).toBe(2);
        process.exitCode = 0; // Clean up
        const output = capture.logs.join("\n");
        const result = JSON.parse(output);
        expect(result.success).toBe(false);

        // Verify bullet was NOT removed
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(1);
        expect(savedPlaybook.bullets[0].id).toBe("to-delete");
      });
    });

    it("removes with custom reason", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "obsolete-rule",
            content: "Old rule",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["obsolete-rule"], {
            reason: "No longer applicable",
            json: true
          });
        } finally {
          capture.restore();
        }

        // Verify deprecation reason is saved
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets[0].deprecationReason).toBe("No longer applicable");
      });
    });

    it("fails gracefully when bullet ID not found", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "existing-bullet",
            content: "Existing rule",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["nonexistent-id"], {});
        } finally {
          capture.restore();
        }

        expect(process.exitCode as number | undefined).toBe(2);
        expect(capture.errors.some(e => e.includes("not found"))).toBe(true);
        process.exitCode = 0;
      });
    });

    it("shows dry-run preview for deprecate without making changes", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "dry-run-test",
            content: "This bullet will not be deprecated",
            category: "testing",
            helpfulCount: 5,
            harmfulCount: 1
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["dry-run-test"], { dryRun: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.plan).toBeDefined();
        expect(result.plan.dryRun).toBe(true);
        expect(result.plan.action).toBe("deprecate");
        expect(result.plan.bulletId).toBe("dry-run-test");
        expect(result.plan.preview).toContain("not be deprecated");
        expect(result.plan.wouldChange).toContain("deprecated");
        expect(result.plan.applyCommand).toContain("cm playbook remove dry-run-test");

        // Verify bullet was NOT deprecated
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets[0].deprecated).toBe(false);
      });
    });

    it("shows dry-run preview for --hard delete without making changes", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "dry-run-hard-test",
            content: "This bullet will not be deleted",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["dry-run-hard-test"], { dryRun: true, hard: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.plan).toBeDefined();
        expect(result.plan.dryRun).toBe(true);
        expect(result.plan.action).toBe("delete");
        expect(result.plan.bulletId).toBe("dry-run-hard-test");
        expect(result.plan.wouldChange).toContain("permanently removed");
        expect(result.plan.applyCommand).toContain("--hard --yes");

        // Verify bullet was NOT deleted
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(1);
        expect(savedPlaybook.bullets[0].id).toBe("dry-run-hard-test");
      });
    });

    it("shows human-readable dry-run output without --json", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "human-dry-run",
            content: "Human readable dry run test",
            category: "security"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("remove", ["human-dry-run"], { dryRun: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("DRY RUN");
        expect(output).toContain("DEPRECATE");
        expect(output).toContain("human-dry-run");
        expect(output).toContain("Would:");
        expect(output).toContain("To apply:");

        // Verify bullet was NOT deprecated
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets[0].deprecated).toBe(false);
      });
    });
  });

  describe("get action", () => {
    it("retrieves bullet details by ID", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "detail-bullet",
            content: "Detailed rule content",
            category: "security",
            helpfulCount: 5,
            harmfulCount: 1
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("get", ["detail-bullet"], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.bullet.id).toBe("detail-bullet");
        expect(result.bullet.content).toBe("Detailed rule content");
        expect(result.bullet.category).toBe("security");
        expect(result.bullet.helpfulCount).toBe(5);
        expect(result.bullet.harmfulCount).toBe(1);
        expect(typeof result.bullet.effectiveScore).toBe("number");
      });
    });

    it("shows human-readable details by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "human-bullet",
            content: "Human readable test",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("get", ["human-bullet"], {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("BULLET: human-bullet");
        expect(output).toContain("Content:");
        expect(output).toContain("Category:");
        expect(output).toContain("Scores:");
      });
    });

    it("suggests similar IDs when not found", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "auth-rule-1",
            content: "Auth rule",
            category: "security"
          }),
          createTestBullet({
            id: "auth-rule-2",
            content: "Another auth rule",
            category: "security"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await playbookCommand("get", ["auth"], { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode as number | undefined).toBe(2);
        const output = capture.logs.join("\n");
        const result = JSON.parse(output) as any;

        expect(result.success).toBe(false);
        expect(result.error.details?.suggestions).toBeDefined();
        expect(result.error.details.suggestions.length).toBeGreaterThan(0);
        process.exitCode = 0;
      });
    });
  });

  describe("export action", () => {
    it("exports playbook as YAML by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "export-bullet",
            content: "Rule to export",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("export", [], {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const parsed = yaml.parse(output);

        expect(parsed.schema_version).toBe(2);
        expect(parsed.bullets.length).toBe(1);
        expect(parsed.bullets[0].id).toBe("export-bullet");
      });
    });

    it("exports playbook as JSON with --json flag", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "json-export",
            content: "JSON export test",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("export", [], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const parsed = payload.data;

        expect(parsed.schema_version).toBe(2);
        expect(parsed.bullets.length).toBe(1);
      });
    });

    it("excludes deprecated bullets by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "active-export",
            content: "Active rule",
            category: "testing"
          }),
          createTestBullet({
            id: "deprecated-export",
            content: "Deprecated rule",
            category: "testing",
            deprecated: true
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("export", [], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const parsed = payload.data;

        expect(parsed.bullets.length).toBe(1);
        expect(parsed.bullets[0].id).toBe("active-export");
      });
    });

    it("includes deprecated bullets with --all flag", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "active-all",
            content: "Active rule",
            category: "testing"
          }),
          createTestBullet({
            id: "deprecated-all",
            content: "Deprecated rule",
            category: "testing",
            deprecated: true
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await playbookCommand("export", [], { all: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const parsed = payload.data;

        expect(parsed.bullets.length).toBe(2);
      });
    });
  });

  describe("import action", () => {
    it("imports bullets from JSON file", async () => {
      await withTempCassHome(async (env) => {
        // Create initial empty playbook
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Create import file
        const importData = {
          bullets: [
            createTestBullet({
              id: "imported-1",
              content: "Imported rule 1",
              category: "imported"
            }),
            createTestBullet({
              id: "imported-2",
              content: "Imported rule 2",
              category: "imported"
            })
          ]
        };
        const importPath = path.join(env.cassMemoryDir, "import.json");
        await writeFile(importPath, JSON.stringify(importData, null, 2));

        const capture = captureConsole();
        try {
          await playbookCommand("import", [importPath], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.added).toBe(2);

        // Verify bullets were added
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets.length).toBe(2);
      });
    });

    it("imports bullets from YAML file", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const importData = {
          bullets: [
            createTestBullet({
              id: "yaml-import",
              content: "YAML imported rule",
              category: "yaml"
            })
          ]
        };
        const importPath = path.join(env.cassMemoryDir, "import.yaml");
        await writeFile(importPath, yaml.stringify(importData));

        const capture = captureConsole();
        try {
          await playbookCommand("import", [importPath], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.added).toBe(1);
      });
    });

    it("skips duplicate bullets by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "existing-bullet",
            content: "Existing rule",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const importData = {
          bullets: [
            createTestBullet({
              id: "existing-bullet",
              content: "Duplicate rule",
              category: "testing"
            }),
            createTestBullet({
              id: "new-bullet",
              content: "New rule",
              category: "testing"
            })
          ]
        };
        const importPath = path.join(env.cassMemoryDir, "import.json");
        await writeFile(importPath, JSON.stringify(importData, null, 2));

        const capture = captureConsole();
        try {
          await playbookCommand("import", [importPath], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.added).toBe(1);
        expect(result.skipped).toBe(1);
      });
    });

    it("replaces duplicates with --replace flag", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "to-replace",
            content: "Original content",
            category: "testing"
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const importData = {
          bullets: [
            createTestBullet({
              id: "to-replace",
              content: "Updated content",
              category: "testing"
            })
          ]
        };
        const importPath = path.join(env.cassMemoryDir, "import.json");
        await writeFile(importPath, JSON.stringify(importData, null, 2));

        const capture = captureConsole();
        try {
          await playbookCommand("import", [importPath], { replace: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output) as any;
        const result = payload.data;

        expect(payload.success).toBe(true);
        expect(result.updated).toBe(1);

        // Verify content was updated
        const savedContent = await readFile(env.playbookPath, "utf-8");
        const savedPlaybook = yaml.parse(savedContent);
        expect(savedPlaybook.bullets[0].content).toBe("Updated content");
      });
    });

    it("fails gracefully when file not found", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        process.exitCode = 0;
        const capture = captureConsole();
        try {
          await playbookCommand("import", ["/nonexistent/file.json"], { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode as number | undefined).toBe(4);
        const output = capture.logs.join("\n");
        const result = JSON.parse(output) as any;
        expect(result.success).toBe(false);
        expect(result.error.message).toContain("not found");
        process.exitCode = 0;
      });
    });
  });
});
