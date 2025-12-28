/**
 * E2E Tests for CLI trauma command - Hot Stove Pattern Prevention
 *
 * Tests the `cm trauma` command for managing trauma entries that prevent
 * repeating dangerous patterns. Uses isolated temp directories.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";

import { traumaCommand } from "../src/commands/trauma.js";
import { loadTraumas } from "../src/trauma.js";
import { TraumaEntry } from "../src/types.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = path.join(os.tmpdir(), `trauma-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

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

async function setupTestEnvironment() {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const cassMemoryDir = path.join(home, ".cass-memory");
  const repoCassDir = path.join(repo, ".cass");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(repoCassDir, { recursive: true });

  // Initialize git repo so resolveRepoDir() can find .cass directory
  execSync("git init", { cwd: repo, stdio: "pipe" });

  // Create config
  const config = { schema_version: 1 };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  return { dir, home, repo, cassMemoryDir, repoCassDir };
}

// Helper to run code in a different working directory (needed for project-scope traumas)
async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function createTestTrauma(overrides: Partial<TraumaEntry> = {}): TraumaEntry {
  return {
    id: `trauma-test-${Math.random().toString(36).slice(2)}`,
    severity: "CRITICAL",
    pattern: "rm -rf /",
    scope: "global",
    status: "active",
    trigger_event: {
      session_path: "/test/session.jsonl",
      timestamp: new Date().toISOString(),
      human_message: "This caused data loss"
    },
    created_at: new Date().toISOString(),
    ...overrides
  };
}

// --- Test Suites ---

describe("E2E: CLI trauma command", () => {
  describe("trauma list", () => {
    it("shows empty message when no traumas exist", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("list", [], { json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("No active traumas");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("lists active traumas with details", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create a trauma entry
        const trauma = createTestTrauma({
          id: "trauma-list-test",
          pattern: "DROP TABLE",
          severity: "FATAL"
        });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("list", [], { json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("ACTIVE TRAUMAS");
        expect(output).toContain("trauma-list-test");
        expect(output).toContain("DROP TABLE");
        expect(output).toContain("FATAL");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("outputs JSON when --json flag is used", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create a trauma entry
        const trauma = createTestTrauma({ id: "trauma-json-list" });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("list", [], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();

        const payload = JSON.parse(output);
        expect(payload.success).toBe(true);
        expect(payload.data.traumas).toBeInstanceOf(Array);
        expect(payload.data.traumas.length).toBe(1);
        expect(payload.data.traumas[0].id).toBe("trauma-json-list");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("excludes healed traumas from active list", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create one active and one healed trauma
        const activeTrauma = createTestTrauma({ id: "trauma-active", status: "active" });
        const healedTrauma = createTestTrauma({ id: "trauma-healed", status: "healed" });

        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(
          traumasFile,
          JSON.stringify(activeTrauma) + "\n" + JSON.stringify(healedTrauma) + "\n"
        );

        const capture = captureConsole();
        try {
          await traumaCommand("list", [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.traumas.length).toBe(1);
        expect(payload.data.traumas[0].id).toBe("trauma-active");
        expect(payload.data.healedCount).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("trauma add", () => {
    it("adds a new trauma with default options", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("add", ["rm -rf /var/data"], { json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Added trauma");
        expect(output).toContain("safety guard will now block");

        // Verify trauma was saved
        const traumas = await loadTraumas();
        expect(traumas.length).toBe(1);
        expect(traumas[0].pattern).toBe("rm -rf /var/data");
        expect(traumas[0].severity).toBe("CRITICAL");
        expect(traumas[0].scope).toBe("global");
        expect(traumas[0].status).toBe("active");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("adds trauma with custom severity and message", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("add", ["git push --force"], {
            severity: "FATAL",
            message: "Force push destroyed PR history",
            json: true
          });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.entry.severity).toBe("FATAL");
        expect(payload.data.entry.trigger_event.human_message).toBe("Force push destroyed PR history");

        const traumas = await loadTraumas();
        expect(traumas[0].severity).toBe("FATAL");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("adds trauma with project scope", async () => {
      const { home, repo } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Need to chdir to temp repo so resolveRepoDir() finds the temp .cass dir
        await withCwd(repo, async () => {
          const capture = captureConsole();
          try {
            await traumaCommand("add", ["npm publish"], {
              scope: "project",
              json: true
            });
          } finally {
            capture.restore();
          }

          const payload = JSON.parse(capture.logs.join("\n"));
          expect(payload.data.entry.scope).toBe("project");
        });
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("rejects invalid regex patterns", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("add", ["[invalid(regex"], { json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        expect(payload.success).toBe(false);
        // Error may be in various formats
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("invalid") && payloadStr.includes("regex")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("requires a pattern argument", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("add", [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error may be in various formats
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("pattern") || payloadStr.includes("required")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("trauma heal", () => {
    it("heals an active trauma", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create a trauma
        const trauma = createTestTrauma({ id: "trauma-to-heal" });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("heal", ["trauma-to-heal"], { json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Healed trauma");
        expect(output).toContain("trauma-to-heal");
        expect(output).toContain("no longer block");

        // Verify trauma was healed
        const traumas = await loadTraumas();
        expect(traumas[0].status).toBe("healed");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("outputs JSON when healing", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const trauma = createTestTrauma({ id: "trauma-heal-json" });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("heal", ["trauma-heal-json"], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.updated).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("reports error for non-existent trauma", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("heal", ["non-existent-trauma"], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error may include code or message about not found
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("not found") || payloadStr.includes("trauma_not_found")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("requires a trauma id argument", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("heal", [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("trauma remove", () => {
    it("removes trauma with --force and --yes flags", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const uniqueId = `trauma-remove-${Math.random().toString(36).slice(2)}`;
        const trauma = createTestTrauma({ id: uniqueId });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        // Verify trauma exists before removal
        const beforeTraumas = await loadTraumas();
        expect(beforeTraumas.some(t => t.id === uniqueId)).toBe(true);

        const capture = captureConsole();
        try {
          await traumaCommand("remove", [uniqueId], {
            force: true,
            yes: true,
            json: false
          });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Removed trauma");

        // Verify our specific trauma was removed
        const traumas = await loadTraumas();
        expect(traumas.some(t => t.id === uniqueId)).toBe(false);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("refuses removal without --force flag", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const uniqueId = `trauma-keep-${Math.random().toString(36).slice(2)}`;
        const trauma = createTestTrauma({ id: uniqueId });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("remove", [uniqueId], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error message may be in various formats - check stringified payload
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("force")).toBe(true);

        // Verify our specific trauma still exists
        const traumas = await loadTraumas();
        expect(traumas.some(t => t.id === uniqueId)).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("outputs JSON when removing", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const trauma = createTestTrauma({ id: "trauma-remove-json" });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand("remove", ["trauma-remove-json"], {
            force: true,
            yes: true,
            json: true
          });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.removed).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("reports error for non-existent trauma", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("remove", ["ghost-trauma-xyz"], {
            force: true,
            yes: true,
            json: true
          });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error code may be in various formats
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("not found") || payloadStr.includes("trauma_not_found")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("trauma import", () => {
    it("imports traumas from a plain text file (one pattern per line)", async () => {
      const { home, cassMemoryDir, dir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Get initial count
        const initialTraumas = await loadTraumas();
        const initialCount = initialTraumas.length;

        // Create import file with patterns
        const importFile = path.join(dir, "patterns.txt");
        await writeFile(importFile, "rm -rf /\nDROP DATABASE\ngit push --force\n");

        const capture = captureConsole();
        try {
          await traumaCommand("import", [importFile], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.imported).toBe(3);

        // Verify 3 new traumas were added
        const traumas = await loadTraumas();
        expect(traumas.length).toBe(initialCount + 3);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("imports traumas from JSONL file", async () => {
      const { home, cassMemoryDir, dir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create import file with JSONL patterns
        const importFile = path.join(dir, "patterns.jsonl");
        await writeFile(
          importFile,
          '{"pattern": "rm -rf /"}\n{"pattern": "DROP TABLE"}\n'
        );

        const capture = captureConsole();
        try {
          await traumaCommand("import", [importFile], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.imported).toBe(2);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("applies severity and scope to all imported traumas", async () => {
      const { home, repo, dir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Use truly unique patterns with random suffix
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pattern1 = `import-severity-test-${uniqueSuffix}-1`;
        const pattern2 = `import-severity-test-${uniqueSuffix}-2`;

        const importFile = path.join(dir, "patterns.txt");
        await writeFile(importFile, `${pattern1}\n${pattern2}\n`);

        // Need to chdir to temp repo for project scope to work correctly
        await withCwd(repo, async () => {
          const capture = captureConsole();
          try {
            await traumaCommand("import", [importFile], {
              severity: "FATAL",
              scope: "project",
              json: true
            });
          } finally {
            capture.restore();
          }

          const payload = JSON.parse(capture.logs.join("\n"));
          expect(payload.data.imported).toBe(2);

          // Verify the newly imported traumas have correct severity and scope
          const traumas = await loadTraumas();
          const importedTraumas = traumas.filter(t =>
            t.pattern.includes(uniqueSuffix)
          );
          expect(importedTraumas.length).toBe(2);
          expect(importedTraumas.every(t => t.severity === "FATAL")).toBe(true);
          expect(importedTraumas.every(t => t.scope === "project")).toBe(true);
        });
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("skips invalid regex patterns with warning", async () => {
      const { home, cassMemoryDir, dir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Get initial count
        const initialCount = (await loadTraumas()).length;

        const importFile = path.join(dir, "patterns.txt");
        await writeFile(importFile, "valid-skip-test-1\n[invalid(regex\nvalid-skip-test-2\n");

        const capture = captureConsole();
        try {
          await traumaCommand("import", [importFile], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.imported).toBe(2);
        expect(payload.data.warningsCount).toBe(1);
        // warnings is an array of strings - check if any contains the expected text
        expect(payload.warnings.some((w: string) => w.includes("Line 2") && w.includes("invalid regex"))).toBe(true);

        // Verify 2 valid patterns were added
        const traumas = await loadTraumas();
        expect(traumas.length).toBe(initialCount + 2);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("reports error for non-existent file", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("import", ["/nonexistent/file.txt"], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error code may be in various formats
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("not found") || payloadStr.includes("file_not_found")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("skips empty lines in import file", async () => {
      const { home, dir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const importFile = path.join(dir, "patterns.txt");
        await writeFile(importFile, "pattern-1\n\n\npattern-2\n  \npattern-3\n");

        const capture = captureConsole();
        try {
          await traumaCommand("import", [importFile], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.data.imported).toBe(3);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("unknown subcommand", () => {
    it("shows usage for unknown action", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("unknown-action", [], { json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Usage:");
        expect(output).toContain("trauma");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("outputs JSON error for unknown action with --json", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await traumaCommand("bogus", [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(false);
        // Error message may be in various formats - check stringified payload
        const payloadStr = JSON.stringify(payload).toLowerCase();
        expect(payloadStr.includes("unknown") || payloadStr.includes("bogus")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("default action", () => {
    it("defaults to list when no action specified", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const trauma = createTestTrauma({ id: "trauma-default" });
        const traumasFile = path.join(cassMemoryDir, "traumas.jsonl");
        await writeFile(traumasFile, JSON.stringify(trauma) + "\n");

        const capture = captureConsole();
        try {
          await traumaCommand(undefined, [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        expect(payload.success).toBe(true);
        expect(payload.data.traumas).toBeInstanceOf(Array);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("multiple traumas", () => {
    it("handles multiple traumas with different severities", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Use unique patterns to identify our test traumas
        const uniqueId = Math.random().toString(36).slice(2);
        const pattern1 = `pattern-critical-${uniqueId}`;
        const pattern2 = `pattern-fatal-${uniqueId}`;

        // Suppress output from add commands
        const addCapture1 = captureConsole();
        try {
          await traumaCommand("add", [pattern1], { severity: "CRITICAL", json: true });
        } finally {
          addCapture1.restore();
        }

        const addCapture2 = captureConsole();
        try {
          await traumaCommand("add", [pattern2], { severity: "FATAL", json: true });
        } finally {
          addCapture2.restore();
        }

        const capture = captureConsole();
        try {
          await traumaCommand("list", [], { json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        // Filter for our specific test patterns
        const ourTraumas = payload.data.traumas.filter((t: TraumaEntry) =>
          t.pattern.includes(uniqueId)
        );
        expect(ourTraumas.length).toBe(2);

        const severities = ourTraumas.map((t: TraumaEntry) => t.severity);
        expect(severities).toContain("CRITICAL");
        expect(severities).toContain("FATAL");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
