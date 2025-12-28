/**
 * E2E Tests for CLI starters command - List available starter packs
 *
 * Tests the `cm starters` command which lists available starter
 * rule packs (built-in and custom) for seeding playbooks.
 */
import { describe, it, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startersCommand } from "../src/commands/starters.js";
import { withTempCassHome } from "./helpers/temp.js";
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

describe("E2E: CLI starters command", () => {
  describe("text output mode", () => {
    it("lists built-in starters with descriptions", async () => {
      const log = createE2ELogger("starters: text output");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          const capture = captureConsole();
          try {
            log.startTimer("startersCommand");
            await startersCommand({});
            log.endTimer("startersCommand");
          } finally {
            capture.restore();
          }

          log.snapshot("output", { logs: capture.logs, errors: capture.errors });

          const output = capture.logs.join("\n");

          // Should list built-in starters
          expect(output).toContain("Built-in starters");
          expect(output).toContain("general");
          expect(output).toContain("react");
          expect(output).toContain("python");
          expect(output).toContain("node");
          expect(output).toContain("rust");

          // Should include rule counts
          expect(output).toMatch(/\d+ rules/);

          // Should include usage hint
          expect(output).toContain("init --starter=");
        }, "starters-text");
      });
    });

    it("lists custom starters when present", async () => {
      const log = createE2ELogger("starters: custom starters");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          // Create a custom starter
          const startersDir = path.join(env.cassMemoryDir, "starters", "custom");
          await mkdir(startersDir, { recursive: true });

          const customStarter = {
            name: "my-team",
            description: "Team-specific coding standards",
            bullets: [
              { content: "Always use TypeScript strict mode", category: "typescript" },
              { content: "Prefer composition over inheritance", category: "architecture" }
            ]
          };

          await writeFile(
            path.join(startersDir, "my-team.yaml"),
            `name: ${customStarter.name}\ndescription: ${customStarter.description}\nbullets:\n` +
            customStarter.bullets.map(b => `  - content: "${b.content}"\n    category: ${b.category}`).join("\n"),
            "utf-8"
          );

          log.step("Created custom starter", { path: startersDir });

          const capture = captureConsole();
          try {
            await startersCommand({});
          } finally {
            capture.restore();
          }

          log.snapshot("output", { logs: capture.logs, errors: capture.errors });

          const output = capture.logs.join("\n");

          // Should list both built-in and custom
          expect(output).toContain("Built-in starters");
          expect(output).toContain("Custom starters");
          expect(output).toContain("my-team");
          expect(output).toContain("Team-specific coding standards");
        }, "starters-custom");
      });
    });
  });

  describe("JSON output mode", () => {
    it("outputs valid JSON with starters array", async () => {
      const log = createE2ELogger("starters: JSON output");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          log.snapshot("output", { logs: capture.logs, errors: capture.errors });

          // Find and parse JSON output
          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          expect(jsonOutput).toBeDefined();

          const parsed = JSON.parse(jsonOutput!);
          log.snapshot("parsed JSON", parsed);

          // Verify top-level structure
          expect(parsed.success).toBe(true);
          expect(parsed.command).toBe("starters");
          expect(parsed.data).toBeDefined();
          expect(parsed.data.starters).toBeDefined();
          expect(Array.isArray(parsed.data.starters)).toBe(true);
        }, "starters-json");
      });
    });

    it("JSON includes all built-in starters with correct fields", async () => {
      const log = createE2ELogger("starters: JSON fields");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          const parsed = JSON.parse(jsonOutput!);
          const starters = parsed.data.starters;

          log.snapshot("starters", starters);

          // Should have all built-in starters
          const names = starters.map((s: any) => s.name);
          expect(names).toContain("general");
          expect(names).toContain("react");
          expect(names).toContain("python");
          expect(names).toContain("node");
          expect(names).toContain("rust");

          // Each starter should have required fields
          for (const starter of starters) {
            expect(starter.name).toBeDefined();
            expect(starter.description).toBeDefined();
            expect(typeof starter.bulletCount).toBe("number");
            expect(starter.source).toBeDefined();
          }
        }, "starters-json-fields");
      });
    });

    it("JSON includes custom starters with path field", async () => {
      const log = createE2ELogger("starters: JSON custom starters");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          // Create a custom starter
          const startersDir = path.join(env.cassMemoryDir, "starters", "custom");
          await mkdir(startersDir, { recursive: true });

          const customPath = path.join(startersDir, "custom-rules.json");
          await writeFile(
            customPath,
            JSON.stringify({
              name: "custom-rules",
              description: "Custom rules for testing",
              bullets: [
                { content: "Test rule 1", category: "testing" }
              ]
            }),
            "utf-8"
          );

          log.step("Created custom starter", { path: customPath });

          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          const parsed = JSON.parse(jsonOutput!);
          const starters = parsed.data.starters;

          log.snapshot("starters with custom", starters);

          // Find custom starter
          const custom = starters.find((s: any) => s.name === "custom-rules");
          expect(custom).toBeDefined();
          expect(custom.source).toBe("custom");
          expect(custom.path).toBeDefined();
          expect(custom.path).toContain("custom-rules.json");
          expect(custom.bulletCount).toBe(1);
        }, "starters-json-custom");
      });
    });

    it("JSON starters are sorted by name", async () => {
      const log = createE2ELogger("starters: JSON sorted");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          const parsed = JSON.parse(jsonOutput!);
          const starters = parsed.data.starters;
          const names = starters.map((s: any) => s.name);

          log.snapshot("names order", names);

          // Should be sorted alphabetically
          const sorted = [...names].sort((a, b) => a.localeCompare(b));
          expect(names).toEqual(sorted);
        }, "starters-json-sorted");
      });
    });

    it("JSON bullet counts are accurate", async () => {
      const log = createE2ELogger("starters: JSON bullet counts");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          const parsed = JSON.parse(jsonOutput!);
          const starters = parsed.data.starters;

          // Known bullet counts for built-in starters
          const general = starters.find((s: any) => s.name === "general");
          expect(general.bulletCount).toBe(5);

          const react = starters.find((s: any) => s.name === "react");
          expect(react.bulletCount).toBe(4);

          const python = starters.find((s: any) => s.name === "python");
          expect(python.bulletCount).toBe(4);

          const node = starters.find((s: any) => s.name === "node");
          expect(node.bulletCount).toBe(4);

          const rust = starters.find((s: any) => s.name === "rust");
          expect(rust.bulletCount).toBe(4);
        }, "starters-json-counts");
      });
    });
  });

  describe("edge cases", () => {
    it("handles missing custom starters directory gracefully", async () => {
      const log = createE2ELogger("starters: no custom dir");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async () => {
          // Don't create any custom starters directory
          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          // Should not throw
          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          expect(jsonOutput).toBeDefined();

          const parsed = JSON.parse(jsonOutput!);
          expect(parsed.success).toBe(true);

          // Should only have built-in starters
          const sources = parsed.data.starters.map((s: any) => s.source);
          expect(sources.every((s: string) => s === "builtin")).toBe(true);
        }, "starters-no-custom-dir");
      });
    });

    it("ignores invalid custom starter files", async () => {
      const log = createE2ELogger("starters: invalid custom files");
      log.setRepro("bun test test/cli-starters.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const startersDir = path.join(env.cassMemoryDir, "starters", "custom");
          await mkdir(startersDir, { recursive: true });

          // Write invalid YAML
          await writeFile(
            path.join(startersDir, "broken.yaml"),
            "name: [invalid yaml",
            "utf-8"
          );

          // Write valid one for comparison
          await writeFile(
            path.join(startersDir, "valid.yaml"),
            "name: valid\ndescription: Valid starter\nbullets:\n  - content: Rule 1\n    category: test",
            "utf-8"
          );

          log.step("Created broken and valid starters");

          const capture = captureConsole();
          try {
            await startersCommand({ json: true });
          } finally {
            capture.restore();
          }

          const jsonOutput = capture.logs.find(l => l.startsWith("{"));
          const parsed = JSON.parse(jsonOutput!);
          const names = parsed.data.starters.map((s: any) => s.name);

          log.snapshot("starters after invalid", names);

          // Should include valid but not broken
          expect(names).toContain("valid");
          expect(names).not.toContain("broken");
        }, "starters-invalid-custom");
      });
    });
  });
});
