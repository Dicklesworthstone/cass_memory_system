/**
 * Unit tests for playbook export and import commands.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { playbookCommand } from "../src/commands/playbook.js";
import { PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome, withTempDir } from "./helpers/temp.js";

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
    },
  };
}

// Helper to save playbook to path
async function savePlaybookToPath(playbook: any, playbookPath: string) {
  await writeFile(playbookPath, yaml.stringify(playbook));
}

describe("playbook export command", () => {
  let originalEnv: Record<string, string | undefined> = {};
  let originalHome: string | undefined;

  beforeEach(() => {
    originalEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    originalHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api3-test-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalHome) process.env.HOME = originalHome;
  });

  it("exports playbook as YAML by default", async () => {
    await withTempDir("playbook-export", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullets = [
        createTestBullet({ id: "b-1", content: "Test rule 1", category: "testing" }),
        createTestBullet({ id: "b-2", content: "Test rule 2", category: "best-practice" }),
      ];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("export", [], {});
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      // Should be valid YAML
      const parsed = yaml.parse(output);
      expect(parsed.schema_version).toBe(2);
      expect(parsed.bullets.length).toBe(2);
      expect(parsed.metadata.exportedAt).toBeDefined();
    });
  });

  it("exports playbook as JSON with --json flag", async () => {
    await withTempDir("playbook-export", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullets = [createTestBullet({ id: "b-json", content: "JSON test" })];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("export", [], { json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      const payload = JSON.parse(output) as any;
      expect(payload.success).toBe(true);
      const parsed = payload.data;
      expect(parsed.schema_version).toBe(2);
      expect(parsed.bullets.length).toBe(1);
    });
  });

  it("excludes deprecated bullets by default", async () => {
    await withTempDir("playbook-export", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullets = [
        createTestBullet({ id: "b-active", content: "Active rule", deprecated: false }),
        createTestBullet({ id: "b-deprecated", content: "Deprecated rule", deprecated: true }),
      ];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("export", [], { json: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      const parsed = payload.data;
      expect(parsed.bullets.length).toBe(1);
      expect(parsed.bullets[0].id).toBe("b-active");
    });
  });

  it("includes deprecated bullets with --all flag", async () => {
    await withTempDir("playbook-export", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullets = [
        createTestBullet({ id: "b-active", deprecated: false }),
        createTestBullet({ id: "b-deprecated", deprecated: true }),
      ];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("export", [], { json: true, all: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      const parsed = payload.data;
      expect(parsed.bullets.length).toBe(2);
    });
  });

  it("strips sourceSessions for portability", async () => {
    await withTempDir("playbook-export", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const bullets = [
        createTestBullet({
          id: "b-with-sessions",
          sourceSessions: ["/home/user/.claude/sessions/s1.jsonl", "/home/user/.cursor/s2.jsonl"],
        }),
      ];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const capture = captureConsole();
      try {
        await playbookCommand("export", [], { json: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      const parsed = payload.data;
      expect(parsed.bullets[0].sourceSessions).toBeUndefined();
    });
  });
});

describe("playbook import command", () => {
  let originalEnv: Record<string, string | undefined> = {};
  let originalHome: string | undefined;

  beforeEach(() => {
    originalEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    originalHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api3-test-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalHome) process.env.HOME = originalHome;
  });

  it("imports bullets from YAML file", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      // Start with empty playbook
      const playbook = createTestPlaybook([]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      // Create import file
      const importFile = path.join(dir, "import.yaml");
      const importData = {
        schema_version: 2,
        bullets: [
          {
            id: "b-imported-1",
            content: "Imported rule 1",
            category: "testing",
            kind: "workflow_rule",
            maturity: "candidate",
            scope: "global",
          },
          {
            id: "b-imported-2",
            content: "Imported rule 2",
            category: "best-practice",
            kind: "workflow_rule",
            maturity: "established",
            scope: "global",
          },
        ],
      };
      await writeFile(importFile, yaml.stringify(importData));

      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      expect(payload.data.added).toBe(2);
      expect(payload.data.skipped).toBe(0);

      // Verify playbook was updated
      const updatedPlaybook = yaml.parse(await readFile(playbookPath, "utf-8"));
      expect(updatedPlaybook.bullets.length).toBe(2);
    });
  });

  it("imports bullets from JSON file", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const playbook = createTestPlaybook([]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      // Create JSON import file
      const importFile = path.join(dir, "import.json");
      const importData = {
        bullets: [
          {
            id: "b-json-import",
            content: "From JSON",
            category: "testing",
            kind: "workflow_rule",
            maturity: "candidate",
            scope: "global",
          },
        ],
      };
      await writeFile(importFile, JSON.stringify(importData));

      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      expect(payload.data.added).toBe(1);
    });
  });

  it("skips bullets that already exist", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      // Start with one bullet
      const playbook = createTestPlaybook([
        createTestBullet({ id: "b-existing", content: "Existing rule" }),
      ]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      // Try to import same ID plus new one
      const importFile = path.join(dir, "import.yaml");
      const importData = {
        bullets: [
          {
            id: "b-existing",
            content: "Duplicate",
            category: "test",
            kind: "workflow_rule",
            maturity: "candidate",
            scope: "global",
          },
          {
            id: "b-new",
            content: "New rule",
            category: "test",
            kind: "workflow_rule",
            maturity: "candidate",
            scope: "global",
          },
        ],
      };
      await writeFile(importFile, yaml.stringify(importData));

      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      expect(payload.data.added).toBe(1);
      expect(payload.data.skipped).toBe(1);

      // Original content should be preserved
      const updatedPlaybook = yaml.parse(await readFile(playbookPath, "utf-8"));
      const existing = updatedPlaybook.bullets.find((b: any) => b.id === "b-existing");
      expect(existing.content).toBe("Existing rule"); // Not replaced
    });
  });

  it("replaces existing bullets with --replace flag", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const playbook = createTestPlaybook([
        createTestBullet({ id: "b-to-replace", content: "Original content" }),
      ]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const importFile = path.join(dir, "import.yaml");
      const importData = {
        bullets: [
          {
            id: "b-to-replace",
            content: "Updated content",
            category: "test",
            kind: "workflow_rule",
            maturity: "proven",
            scope: "global",
          },
        ],
      };
      await writeFile(importFile, yaml.stringify(importData));

      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true, replace: true });
      } finally {
        capture.restore();
      }

      const payload = JSON.parse(capture.logs.join("\n")) as any;
      expect(payload.success).toBe(true);
      expect(payload.data.updated).toBe(1);

      const updatedPlaybook = yaml.parse(await readFile(playbookPath, "utf-8"));
      const replaced = updatedPlaybook.bullets.find((b: any) => b.id === "b-to-replace");
      expect(replaced.content).toBe("Updated content");
      expect(replaced.maturity).toBe("proven");
    });
  });

  it("merges feedback only into the matching scope and preserves other scoped copies", async () => {
    await withTempDir("playbook-import-scopes", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const content = "Run the full test suite before pushing";
      const existing = [
        createTestBullet({ id: "project-a", content, scope: "workspace", workspace: "/projects/a" }),
        createTestBullet({ id: "project-b", content, scope: "workspace", workspace: "/projects/b" }),
        createTestBullet({ id: "global-anti", content, type: "anti-pattern", isNegative: true, kind: "anti_pattern" }),
      ];
      await savePlaybookToPath(createTestPlaybook(existing), playbookPath);
      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(createTestConfig({ playbookPath })));
      process.env.HOME = dir;
      const feedback = [{ type: "helpful" as const, timestamp: new Date().toISOString(), sessionPath: "/session/import.jsonl" }];
      const importFile = path.join(dir, "import.yaml");
      await writeFile(importFile, yaml.stringify({ bullets: [
        createTestBullet({ id: "copy-a", content, scope: "workspace", workspace: "/projects/a/../a", feedbackEvents: feedback, helpfulCount: 1 }),
        createTestBullet({ id: "project-c", content, scope: "workspace", workspace: "/projects/c", feedbackEvents: feedback, helpfulCount: 1 }),
        createTestBullet({ id: "python", content: "Run full test suite before pushing", scope: "language", scopeKey: "python", feedbackEvents: feedback, helpfulCount: 1 }),
        createTestBullet({ id: "global-rule", content, feedbackEvents: feedback, helpfulCount: 1 }),
      ] }));
      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }
      const payload = JSON.parse(capture.logs.join("\n"));
      expect(payload.data.added).toBe(3);
      expect(payload.data.merged).toBe(1);
      const saved = yaml.parse(await readFile(playbookPath, "utf-8"));
      expect(saved.bullets).toHaveLength(6);
      expect(saved.bullets.find((b: any) => b.id === "project-a").helpfulCount).toBe(1);
      expect(saved.bullets.find((b: any) => b.id === "project-b").helpfulCount).toBe(0);
      expect(saved.bullets.find((b: any) => b.id === "python").scopeKey).toBe("python");
      expect(saved.bullets.find((b: any) => b.id === "global-anti").helpfulCount).toBe(0);
      expect(saved.bullets.find((b: any) => b.id === "global-rule").type).toBe("rule");
    });
  });

  it("does not combine same-id feedback when the imported scope has changed", async () => {
    await withTempDir("playbook-import-scope-collision", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const existing = createTestBullet({ id: "same-id", content: "Run tests before pushing", scope: "workspace", workspace: "/projects/a" });
      await savePlaybookToPath(createTestPlaybook([existing]), playbookPath);
      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(createTestConfig({ playbookPath })));
      process.env.HOME = dir;
      const importFile = path.join(dir, "import.yaml");
      await writeFile(importFile, yaml.stringify({ bullets: [{ ...existing, workspace: "/projects/b", helpfulCount: 5 }] }));
      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }
      const payload = JSON.parse(capture.logs.join("\n"));
      expect(payload.data.merged).toBe(0);
      expect(payload.data.skipped).toBe(1);
      const saved = yaml.parse(await readFile(playbookPath, "utf-8"));
      expect(saved.bullets[0].workspace).toBe("/projects/a");
      expect(saved.bullets[0].helpfulCount).toBe(0);
    });
  });

  it("updates the import identity index and conflict report after replacing a rule", async () => {
    await withTempDir("playbook-import-replacement-index", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const original = createTestBullet({ id: "changed", content: "Run the full test suite before pushing" });
      const opposing = createTestBullet({ id: "other", content: "Always commit generated lockfiles" });
      await savePlaybookToPath(createTestPlaybook([original, opposing]), playbookPath);
      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(createTestConfig({ playbookPath })));
      process.env.HOME = dir;
      const importFile = path.join(dir, "import.yaml");
      await writeFile(importFile, yaml.stringify({ bullets: [
        { ...original, content: "Never commit generated lockfiles" },
        { ...original, id: "restored-copy" },
      ] }));
      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true, replace: true });
      } finally {
        capture.restore();
      }
      const payload = JSON.parse(capture.logs.join("\n"));
      expect(payload.data.updated).toBe(1);
      expect(payload.data.added).toBe(1);
      expect(payload.data.merged).toBe(0);
      expect(payload.data.conflicts).toHaveLength(1);
      expect(payload.data.conflicts[0].importedId).toBe("changed");
      const saved = yaml.parse(await readFile(playbookPath, "utf-8"));
      expect(saved.bullets).toHaveLength(3);
      expect(saved.bullets.find((b: any) => b.id === "restored-copy").content).toBe(original.content);
    });
  });

  it("handles non-existent file", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const playbook = createTestPlaybook([]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      // Reset exitCode before test
      process.exitCode = 0;

      const capture = captureConsole();
      try {
        await playbookCommand("import", ["/nonexistent/file.yaml"], { json: true });
      } finally {
        capture.restore();
      }

      expect(process.exitCode as number | undefined).toBe(4);
      process.exitCode = 0; // Clean up
      const result = JSON.parse(capture.logs.join("\n")) as any;
      expect(result.success).toBe(false);
      expect(result.error.message).toContain("not found");
    });
  });

  it("handles invalid YAML gracefully", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const playbook = createTestPlaybook([]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(
        path.join(dir, ".cass-memory", "config.json"),
        JSON.stringify(config, null, 2),
      );
      process.env.HOME = dir;

      const importFile = path.join(dir, "bad.yaml");
      await writeFile(
        importFile,
        "bullets:\n  - id: missing-closing-quote\n    content: 'unclosed string",
      );

      // Reset exitCode before test
      process.exitCode = 0;

      const capture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        capture.restore();
      }

      expect(process.exitCode as number | undefined).toBe(2);
      process.exitCode = 0; // Clean up
      const result = JSON.parse(capture.logs.join("\n")) as any;
      expect(result.success).toBe(false);
      expect(result.error.message).toContain("Parse error");
    });
  });
});

describe("bounded playbook imports and batch input (#98)", () => {
  it("rejects oversized JSON/YAML imports before validating or writing bullets", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, JSON.stringify(createTestConfig({ playbookPath: env.playbookPath })));
      await savePlaybookToPath(createTestPlaybook([createTestBullet({ content: "Keep existing rules" })]), env.playbookPath);
      const original = await readFile(env.playbookPath, "utf8");
      const invalid = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(null);
      for (const [filename, input] of [
        ["oversized.json", { success: true, data: { bullets: invalid } }],
        ["nested.yaml", { bullets: [{ ...createTestBullet(), feedbackEvents: invalid }] }],
      ] as const) {
        const file = path.join(env.home, filename);
        await writeFile(file, JSON.stringify(input));
        const capture = captureConsole();
        const previousExitCode = process.exitCode;
        try {
          await playbookCommand("import", [file], { json: true });
          const result = JSON.parse(capture.logs.join("\n"));
          expect(result.success).toBe(false);
          expect(result.error.message).toContain("Input limit exceeded");
          expect(capture.logs.join("\n").length).toBeLessThan(4000);
        } finally {
          capture.restore();
          process.exitCode = previousExitCode;
        }
        expect(await readFile(env.playbookPath, "utf8")).toBe(original);
      }
    }, "playbook-import-limits");
  });

  it("bounds invalid-element diagnostics and rejects oversized batch arrays", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, JSON.stringify(createTestConfig({ playbookPath: env.playbookPath })));
      await savePlaybookToPath(createTestPlaybook([]), env.playbookPath);
      const original = await readFile(env.playbookPath, "utf8");
      const file = path.join(env.home, "rules.json");
      for (const action of ["import", "add"] as const) {
        await writeFile(file, JSON.stringify(Array(128).fill(null)));
        const capture = captureConsole();
        const previousExitCode = process.exitCode;
        try {
          await playbookCommand(action, action === "import" ? [file] : [], { json: true, file });
          const result = JSON.parse(capture.logs.join("\n"));
          if (action === "import") {
            expect(result.error.details.failed).toBe(128);
            expect(result.error.details.errors.length).toBeLessThanOrEqual(20);
          } else {
            expect(result.data.summary.failed).toBe(128);
            expect(result.data.failed.length).toBeLessThanOrEqual(20);
          }
          expect(capture.logs.join("\n").length).toBeLessThan(30_000);
        } finally {
          capture.restore();
          process.exitCode = previousExitCode;
        }
        expect(await readFile(env.playbookPath, "utf8")).toBe(original);
      }
      await writeFile(file, JSON.stringify(Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(null)));
      const capture = captureConsole();
      try {
        await playbookCommand("add", [], { json: true, file });
        const result = JSON.parse(capture.logs.join("\n"));
        expect(result.data.success).toBe(false);
        expect(result.data.failed[0].error).toContain("Input limit exceeded");
      } finally {
        capture.restore();
      }
      expect(await readFile(env.playbookPath, "utf8")).toBe(original);
    }, "playbook-batch-limits");
  });
});

describe("playbook export/import roundtrip", () => {
  let originalEnv: Record<string, string | undefined> = {};
  let originalHome: string | undefined;

  beforeEach(() => {
    originalEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    originalHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api3-test-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalHome) process.env.HOME = originalHome;
  });

  it("maintains bullet integrity through export/import cycle", async () => {
    await withTempDir("playbook-roundtrip", async (dir) => {
      // Setup source environment
      const sourcePlaybookPath = path.join(dir, "source", "playbook.yaml");
      await mkdir(path.join(dir, "source", ".cass-memory"), { recursive: true });
      const sourceBullets = [
        createTestBullet({
          id: "b-roundtrip",
          content: "Roundtrip test rule",
          category: "testing",
          maturity: "proven",
          helpfulCount: 10,
          harmfulCount: 2,
          tags: ["test", "roundtrip"],
        }),
      ];
      const sourcePlaybook = createTestPlaybook(sourceBullets);
      await savePlaybookToPath(sourcePlaybook, sourcePlaybookPath);
      const sourceConfig = createTestConfig({ playbookPath: sourcePlaybookPath });
      await writeFile(
        path.join(dir, "source", ".cass-memory", "config.json"),
        JSON.stringify(sourceConfig, null, 2),
      );

      // Export from source
      process.env.HOME = path.join(dir, "source");
      const exportCapture = captureConsole();
      try {
        await playbookCommand("export", [], { json: true });
      } finally {
        exportCapture.restore();
      }
      const exportedData = exportCapture.logs.join("\n");

      // Setup target environment
      const targetPlaybookPath = path.join(dir, "target", "playbook.yaml");
      await mkdir(path.join(dir, "target", ".cass-memory"), { recursive: true });
      const targetPlaybook = createTestPlaybook([]);
      await savePlaybookToPath(targetPlaybook, targetPlaybookPath);
      const targetConfig = createTestConfig({ playbookPath: targetPlaybookPath });
      await writeFile(
        path.join(dir, "target", ".cass-memory", "config.json"),
        JSON.stringify(targetConfig, null, 2),
      );

      // Write exported data to file
      const importFile = path.join(dir, "exported.json");
      await writeFile(importFile, exportedData);

      // Import to target
      process.env.HOME = path.join(dir, "target");
      const importCapture = captureConsole();
      try {
        await playbookCommand("import", [importFile], { json: true });
      } finally {
        importCapture.restore();
      }

      // Verify roundtrip
      const importPayload = JSON.parse(importCapture.logs.join("\n")) as any;
      expect(importPayload.success).toBe(true);
      expect(importPayload.data.added).toBe(1);

      const targetPlaybookContent = yaml.parse(await readFile(targetPlaybookPath, "utf-8"));
      const imported = targetPlaybookContent.bullets[0];

      expect(imported.id).toBe("b-roundtrip");
      expect(imported.content).toBe("Roundtrip test rule");
      expect(imported.category).toBe("testing");
      expect(imported.maturity).toBe("proven");
      expect(imported.helpfulCount).toBe(10);
      expect(imported.harmfulCount).toBe(2);
      expect(imported.tags).toContain("test");
      expect(imported.tags).toContain("roundtrip");
    });
  });
});
