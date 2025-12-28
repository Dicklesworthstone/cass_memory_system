/**
 * Tests for the outcome command input validation and flow
 *
 * Tests:
 * - Input validation for outcomeCommand
 * - Input validation for applyOutcomeLogCommand
 * - Error handling paths
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";
import { outcomeCommand, applyOutcomeLogCommand } from "../src/commands/outcome.js";
import { withTempCassHome } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { createTestPlaybook, createTestBullet } from "./helpers/factories.js";

/**
 * Capture console output during async function execution.
 */
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

describe("outcomeCommand input validation", () => {
  test("rejects missing status", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({ rules: "b-test", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("status");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid status value", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({ status: "invalid", rules: "b-test", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("status");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects missing rules", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({ status: "success", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("rules");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects empty rules string", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({ status: "success", rules: "", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("rules");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid duration (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "success",
            rules: "b-test",
            duration: -100,
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("duration");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid errors count (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "failure",
            rules: "b-test",
            errors: -5,
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("errors");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid sentiment value", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "success",
            rules: "b-test",
            sentiment: "invalid",
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("sentiment");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid success outcome with rules", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // Create a playbook with a matching bullet
          const bullet = createTestBullet({ id: "b-success-test" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "success",
              rules: "b-success-test",
              json: true
            });
            const output = capture.getOutput();
            // Should either succeed or report no signal
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid failure outcome with errors", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = createTestBullet({ id: "b-failure-test" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "failure",
              rules: "b-failure-test",
              errors: 5,
              json: true
            });
            const output = capture.getOutput();
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid mixed outcome with sentiment", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = createTestBullet({ id: "b-mixed-test" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "mixed",
              rules: "b-mixed-test",
              sentiment: "negative",
              text: "it worked but was slow",
              json: true
            });
            const output = capture.getOutput();
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("handles multiple rules in comma-separated list", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet1 = createTestBullet({ id: "b-rule-1" });
          const bullet2 = createTestBullet({ id: "b-rule-2" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet1, bullet2])));

          const capture = captureConsole();
          try {
            await outcomeCommand({
              status: "success",
              rules: "b-rule-1,b-rule-2",
              json: true
            });
            const output = capture.getOutput();
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("outcomeCommand additional validation", () => {
  test("rejects whitespace-only session", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "success",
            rules: "b-test",
            session: "   ",
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("session");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects whitespace-only text", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "success",
            rules: "b-test",
            text: "   ",
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("text");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects rules that become empty after splitting", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await outcomeCommand({
            status: "success",
            rules: " , , ",
            json: true
          });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("rule");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("handles outcome with no implicit signal (neutral outcome)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // Create a playbook with matching bullet
          const bullet = createTestBullet({ id: "b-neutral-test" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

          const capture = captureConsole();
          try {
            // Mixed status with no additional signals may not produce feedback
            await outcomeCommand({
              status: "mixed",
              rules: "b-neutral-test",
              json: true
            });
            const output = capture.getOutput();
            // Should succeed but may report no signal
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("outputs human-readable message without --json flag", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = createTestBullet({ id: "b-human-test" });
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

          const capture = captureConsole();
          try {
            // Success without --json flag
            await outcomeCommand({
              status: "success",
              rules: "b-human-test"
            });
            const output = capture.getOutput();
            const errors = capture.getErrors();
            // Should produce some output - either success message or "no signal" warning
            const combined = output + errors;
            expect(combined.length).toBeGreaterThan(0);
            // Should contain either feedback confirmation or no-signal message
            expect(
              combined.includes("Recorded") ||
              combined.includes("feedback") ||
              combined.includes("signal") ||
              combined.includes("No implicit")
            ).toBe(true);
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("applyOutcomeLogCommand input validation", () => {
  test("rejects invalid limit (negative)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await applyOutcomeLogCommand({ limit: -10, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("limit");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects invalid limit (zero)", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await applyOutcomeLogCommand({ limit: 0, json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("limit");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("accepts valid limit", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({ limit: 50, json: true });
            const output = capture.getOutput();
            // Should succeed (no outcomes to apply is fine)
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("handles session filter with no matching outcomes", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({
              session: "nonexistent-session",
              json: true
            });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("outcomesFound");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("runs without session filter (default behavior)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({ json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("rejects whitespace-only session", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        const capture = captureConsole();
        try {
          await applyOutcomeLogCommand({ session: "   ", json: true });
          const output = capture.getOutput();
          expect(output).toContain("error");
          expect(output).toContain("session");
        } finally {
          capture.restore();
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("outputs human-readable message without --json", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const capture = captureConsole();
          try {
            // Run without --json
            await applyOutcomeLogCommand({});
            const output = capture.getOutput();
            // Should output human-readable message about applied outcomes
            expect(output).toContain("Applied");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("outputs human-readable message for session filter with no matches", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const capture = captureConsole();
          try {
            await applyOutcomeLogCommand({ session: "nonexistent-session-id" });
            const output = capture.getOutput() + capture.getErrors();
            // Should output message about no outcomes found
            expect(output).toContain("No outcomes found");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});
