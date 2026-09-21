/**
 * Lightweight docs tests to prevent README drift.
 * These tests verify that README.md stays in sync with the codebase.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf-8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const CM_TS = readFileSync(join(ROOT, "src/cm.ts"), "utf-8");

describe("README Docs Sync", () => {
  describe("CLI commands are documented", () => {
    // Extract all program.command() and subcommand.command() calls from cm.ts
    const commandMatches = CM_TS.matchAll(/\.command\("([^"]+)"\)/g);
    const cliCommands = Array.from(commandMatches, (m) => m[1]);

    // Core commands that must be documented (not subcommands like playbook.list)
    const coreCommands = [
      "init",
      "context",
      "similar",
      "mark",
      "playbook",
      "stats",
      "top",
      "stale",
      "why",
      "undo",
      "usage",
      "validate",
      "doctor",
      "reflect",
      "forget",
      "audit",
      "project",
      "starters",
      "quickstart",
      "privacy",
      "serve",
      "outcome",
      "outcome-apply",
    ];

    test("all core commands appear in README", () => {
      const missingCommands: string[] = [];

      for (const cmd of coreCommands) {
        // Check for `cm <cmd>` pattern in README
        const pattern = new RegExp(`cm ${cmd}\\b`);
        if (!pattern.test(README)) {
          missingCommands.push(cmd);
        }
      }

      expect(missingCommands).toEqual([]);
    });
  });

  describe("Binary names match", () => {
    test("README download URLs match package.json build outputs", () => {
      // Extract binary names from package.json build scripts
      const buildScripts = PACKAGE_JSON.scripts;
      const binaryNames: string[] = [];

      for (const [key, value] of Object.entries(buildScripts)) {
        if (key.startsWith("build:") && key !== "build:all" && key !== "build:current") {
          // Extract output filename from --outfile dist/NAME
          const match = (value as string).match(/--outfile\s+dist\/([^\s]+)/);
          if (match) {
            binaryNames.push(match[1]);
          }
        }
      }

      // Verify each binary name appears in README download section
      for (const name of binaryNames) {
        expect(README).toContain(name);
      }
    });

    test("all platform binaries are documented", () => {
      // Required platforms
      const requiredPatterns = [
        /cass-memory-linux-x64/,
        /cass-memory-macos-arm64/,
        /cass-memory-macos-x64/,
        /cass-memory-windows.*\.exe/,
      ];

      for (const pattern of requiredPatterns) {
        expect(README).toMatch(pattern);
      }
    });
  });

  describe("Config defaults match", () => {
    test("documented model default matches ConfigSchema", async () => {
      // Import ConfigSchema to get actual default
      const { getDefaultConfig } = await import("../src/config.js");
      const defaults = getDefaultConfig();

      // README should contain the correct default model
      expect(README).toContain(`"${defaults.model}"`);
    });

    test("documented budget defaults are present", async () => {
      const { getDefaultConfig } = await import("../src/config.js");
      const defaults = getDefaultConfig();

      // Check budget defaults are documented (handle formatting variations like 0.1 vs 0.10)
      const dailyPattern = new RegExp(
        `"dailyLimit":\\s*${defaults.budget.dailyLimit.toFixed(2)}|${defaults.budget.dailyLimit}`,
      );
      const monthlyPattern = new RegExp(
        `"monthlyLimit":\\s*${defaults.budget.monthlyLimit.toFixed(2)}|${defaults.budget.monthlyLimit}`,
      );

      expect(README).toMatch(dailyPattern);
      expect(README).toMatch(monthlyPattern);
    });
  });

  describe("Dev entrypoint is correct", () => {
    test("README references src/cm.ts for development", () => {
      // The dev command should use src/cm.ts
      expect(README).toMatch(/bun.*run\s+src\/cm\.ts/);
    });

    test("package.json dev script uses src/cm.ts", () => {
      expect(PACKAGE_JSON.scripts.dev).toContain("src/cm.ts");
    });
  });
});
