/**
 * E2E Tests for CLI project command - Playbook export formats
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";
import { projectCommand } from "../src/commands/project.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig, createTestPlaybook, createBullet, createFeedbackEvent } from "./helpers/factories.js";

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

async function writeTestConfig(env: TestEnv): Promise<void> {
  const config = createTestConfig({
    cassPath: "__cass_not_installed__",
    playbookPath: env.playbookPath,
    diaryDir: env.diaryDir,
    verbose: false,
    jsonOutput: false,
  });
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function snapshotFile(log: ReturnType<typeof createE2ELogger>, name: string, filePath: string): Promise<void> {
  const contents = await readFile(filePath, "utf-8").catch(() => "");
  log.snapshot(name, contents);
}

async function withNoColor<T>(fn: () => Promise<T>): Promise<T> {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
  try {
    return await fn();
  } finally {
    process.env.NO_COLOR = originalNoColor;
    process.env.FORCE_COLOR = originalForceColor;
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("E2E: CLI project command", () => {
  it.serial("exports agents.md format and applies --per-category per category", async () => {
    const log = createE2ELogger("cli-project: agents.md + per-category");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bulletSecurityHigh = createBullet({
          id: "b-proj-sec-high",
          category: "security",
          content: "Use prepared statements for SQL queries.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs }), createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 2,
        });
        const bulletSecurityLow = createBullet({
          id: "b-proj-sec-low",
          category: "security",
          content: "Low-score security rule (should be excluded by --per-category 1).",
          maturity: "established",
          feedbackEvents: [],
        });
        const bulletTestingHigh = createBullet({
          id: "b-proj-test-high",
          category: "testing",
          content: "Keep tests deterministic and offline.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 1,
        });
        const bulletTestingLow = createBullet({
          id: "b-proj-test-low",
          category: "testing",
          content: "Low-score testing rule (should be excluded by --per-category 1).",
          maturity: "established",
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bulletSecurityLow, bulletTestingLow, bulletSecurityHigh, bulletTestingHigh]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format agents.md --per-category 1 --json" });
              await projectCommand({ format: "agents.md", perCategory: 1, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("project");
        expect(payload.data.format).toBe("agents.md");

        const content = payload.data.content as string;
        expect(content.startsWith("# AGENTS.md")).toBe(true);
        expect(content).toContain("## Summary");
        expect(content).toContain("## Rules");
        expect(content).toContain("### security");
        expect(content).toContain("### testing");

        expect(content).toContain("Use prepared statements for SQL queries.");
        expect(content).not.toContain("Low-score security rule (should be excluded by --per-category 1).");
        expect(content).toContain("Keep tests deterministic and offline.");
        expect(content).not.toContain("Low-score testing rule (should be excluded by --per-category 1).");
      });
    });
  });

  it.serial("exports claude.md format and applies --per-category per category", async () => {
    const log = createE2ELogger("cli-project: claude.md + per-category");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bulletA = createBullet({
          id: "b-proj-claude-a",
          category: "security",
          content: "Validate JWTs before trusting claims.",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs }), createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 2,
        });
        const bulletB = createBullet({
          id: "b-proj-claude-b",
          category: "security",
          content: "Second security rule (excluded by --per-category 1).",
          maturity: "established",
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bulletB, bulletA]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format claude.md --per-category 1 --json" });
              await projectCommand({ format: "claude.md", perCategory: 1, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);
        const content = payload.data.content as string;

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("project");
        expect(payload.data.format).toBe("claude.md");
        expect(content.startsWith("<project_rules>")).toBe(true);
        expect(content).toContain("</project_rules>");
        expect(content).toContain("## security");
        expect(content).toContain("Validate JWTs before trusting claims.");
        expect(content).not.toContain("Second security rule (excluded by --per-category 1).");
      });
    });
  });

  it.serial("exports raw format correctly", async () => {
    const log = createE2ELogger("cli-project: raw");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-raw-1",
          category: "testing",
          content: "Raw export includes schema and bullets.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format raw --json" });
              await projectCommand({ format: "raw", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.data.format).toBe("raw");

        const playbookJson = JSON.parse(payload.data.content);
        expect(playbookJson.schema_version).toBe(2);
        expect(Array.isArray(playbookJson.bullets)).toBe(true);
        expect(playbookJson.bullets.some((b: any) => b.id === "b-proj-raw-1")).toBe(true);
      });
    });
  });

  it.serial("exports yaml format correctly", async () => {
    const log = createE2ELogger("cli-project: yaml format");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-yaml-1",
          category: "testing",
          content: "YAML export test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm project --format yaml --json" });
              await projectCommand({ format: "yaml", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.data.format).toBe("yaml");

        const parsed = yaml.parse(payload.data.content);
        expect(parsed.schema_version).toBe(2);
        expect(Array.isArray(parsed.bullets)).toBe(true);
        expect(parsed.bullets.some((b: any) => b.id === "b-proj-yaml-1")).toBe(true);
      });
    });
  });

  it.serial("rejects invalid format parameter", async () => {
    const log = createE2ELogger("cli-project: invalid format");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-invfmt",
          category: "testing",
          content: "Test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid format", { format: "invalid" });
              await projectCommand({ format: "invalid", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("INVALID_INPUT");
        expect(payload.error.message).toContain("format");
      });
    });
  });

  it.serial("rejects invalid per-category parameter", async () => {
    const log = createE2ELogger("cli-project: invalid per-category");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-invpc",
          category: "testing",
          content: "Test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid per-category", { perCategory: -5 });
              await projectCommand({ perCategory: -5, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("INVALID_INPUT");
        expect(payload.error.message).toContain("per-category");
      });
    });
  });

  it.serial("rejects invalid top parameter", async () => {
    const log = createE2ELogger("cli-project: invalid top");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-invtop",
          category: "testing",
          content: "Test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid top", { top: -1 });
              await projectCommand({ top: -1, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("INVALID_INPUT");
        expect(payload.error.message).toContain("top");
      });
    });
  });

  it.serial("shows deprecated --top warning", async () => {
    const log = createE2ELogger("cli-project: deprecated top warning");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-deptop",
          category: "testing",
          content: "Test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with deprecated --top", { top: 5 });
              await projectCommand({ top: 5, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        const stderr = capture.errors.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", stderr);

        // Should still succeed but show warning
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        // Warning goes to stderr
        expect(stderr).toContain("deprecated");
      });
    });
  });

  it.serial("exports to file with --output and --force", async () => {
    const log = createE2ELogger("cli-project: output file");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-outfile",
          category: "testing",
          content: "Output file test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const outputPath = `${env.home}/AGENTS_TEST.md`;

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with --output", { output: outputPath });
              await projectCommand({ output: outputPath, format: "agents.md", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.data.outputPath).toBe(outputPath);
        expect(payload.data.bytesWritten).toBeGreaterThan(0);

        // Verify file was created
        const fileContent = await readFile(outputPath, "utf-8");
        expect(fileContent).toContain("# AGENTS.md");
      });
    });
  });

  it.serial("refuses to overwrite existing file without --force", async () => {
    const log = createE2ELogger("cli-project: refuse overwrite");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-noforce",
          category: "testing",
          content: "No force test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const outputPath = `${env.home}/EXISTING.md`;
        // Create existing file
        await writeFile(outputPath, "existing content");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command without --force on existing file");
              await projectCommand({ output: outputPath, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("ALREADY_EXISTS");
        expect(payload.error.message).toContain("overwrite");

        // Verify file was NOT overwritten
        const fileContent = await readFile(outputPath, "utf-8");
        expect(fileContent).toBe("existing content");
      });
    });
  });

  it.serial("overwrites existing file with --force", async () => {
    const log = createE2ELogger("cli-project: force overwrite");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-force",
          category: "testing",
          content: "Force overwrite test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const outputPath = `${env.home}/OVERWRITE.md`;
        // Create existing file
        await writeFile(outputPath, "existing content");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with --force on existing file");
              await projectCommand({ output: outputPath, force: true, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);

        // Verify file was overwritten
        const fileContent = await readFile(outputPath, "utf-8");
        expect(fileContent).toContain("# AGENTS.md");
        expect(fileContent).not.toBe("existing content");
      });
    });
  });

  it.serial("human-readable output without --json", async () => {
    const log = createE2ELogger("cli-project: human output");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-human",
          category: "testing",
          content: "Human output test bullet.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command without --json");
              await projectCommand({ format: "agents.md" });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        // Human output prints the markdown directly
        expect(stdout).toContain("# AGENTS.md");
        expect(stdout).toContain("Human output test bullet.");
      });
    });
  });

  it.serial("human-readable file export output", async () => {
    const log = createE2ELogger("cli-project: human file output");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-humanfile",
          category: "testing",
          content: "Human file output test.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const outputPath = `${env.home}/HUMAN_OUTPUT.md`;

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command without --json with --output");
              await projectCommand({ output: outputPath, format: "agents.md" });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        // Human output shows success message
        expect(stdout).toContain("Exported to");
        expect(stdout).toContain(outputPath);
      });
    });
  });

  it.serial("warns when both --top and --per-category are provided", async () => {
    const log = createE2ELogger("cli-project: top + per-category warning");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-bothtop",
          category: "testing",
          content: "Both top and per-category test.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with both --top and --per-category");
              await projectCommand({ top: 5, perCategory: 3, json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        const stderr = capture.errors.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", stderr);

        // Should succeed but warn about ignoring --top
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(stderr).toContain("Ignoring deprecated --top");
        expect(stderr).toContain("--per-category");
      });
    });
  });

  it.serial("rejects empty output path", async () => {
    const log = createE2ELogger("cli-project: empty output");
    log.setRepro("bun test test/cli-project.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-proj-emptyout",
          category: "testing",
          content: "Empty output test.",
          maturity: "established",
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with empty output path");
              await projectCommand({ output: "", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("INVALID_INPUT");
        expect(payload.error.message).toContain("output");
      });
    });
  });
});
