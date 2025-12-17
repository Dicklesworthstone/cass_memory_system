/**
 * Unit tests for playbook export and import commands.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { playbookCommand } from "../src/commands/playbook.js";
import { createTestPlaybook, createTestBullet, createTestConfig } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
          sourceSessions: ["/home/user/.claude/sessions/s1.jsonl", "/home/user/.cursor/s2.jsonl"]
        }),
      ];
      const playbook = createTestPlaybook(bullets);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      // Create import file
      const importFile = path.join(dir, "import.yaml");
      const importData = {
        schema_version: 2,
        bullets: [
          { id: "b-imported-1", content: "Imported rule 1", category: "testing", kind: "workflow_rule", maturity: "candidate", scope: "global" },
          { id: "b-imported-2", content: "Imported rule 2", category: "best-practice", kind: "workflow_rule", maturity: "established", scope: "global" },
        ]
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      // Create JSON import file
      const importFile = path.join(dir, "import.json");
      const importData = {
        bullets: [
          { id: "b-json-import", content: "From JSON", category: "testing", kind: "workflow_rule", maturity: "candidate", scope: "global" },
        ]
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
        createTestBullet({ id: "b-existing", content: "Existing rule" })
      ]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      // Try to import same ID plus new one
      const importFile = path.join(dir, "import.yaml");
      const importData = {
        bullets: [
          { id: "b-existing", content: "Duplicate", category: "test", kind: "workflow_rule", maturity: "candidate", scope: "global" },
          { id: "b-new", content: "New rule", category: "test", kind: "workflow_rule", maturity: "candidate", scope: "global" },
        ]
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
        createTestBullet({ id: "b-to-replace", content: "Original content" })
      ]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      const importFile = path.join(dir, "import.yaml");
      const importData = {
        bullets: [
          { id: "b-to-replace", content: "Updated content", category: "test", kind: "workflow_rule", maturity: "proven", scope: "global" },
        ]
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

  it("handles non-existent file", async () => {
    await withTempDir("playbook-import", async (dir) => {
      const playbookPath = path.join(dir, "playbook.yaml");
      const playbook = createTestPlaybook([]);
      await savePlaybookToPath(playbook, playbookPath);

      await mkdir(path.join(dir, ".cass-memory"), { recursive: true });
      const config = createTestConfig({ playbookPath });
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
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
      await writeFile(path.join(dir, ".cass-memory", "config.json"), JSON.stringify(config, null, 2));
      process.env.HOME = dir;

      const importFile = path.join(dir, "bad.yaml");
      await writeFile(importFile, "bullets:\n  - id: missing-closing-quote\n    content: 'unclosed string");

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
      await writeFile(path.join(dir, "source", ".cass-memory", "config.json"), JSON.stringify(sourceConfig, null, 2));

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
      await writeFile(path.join(dir, "target", ".cass-memory", "config.json"), JSON.stringify(targetConfig, null, 2));

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
