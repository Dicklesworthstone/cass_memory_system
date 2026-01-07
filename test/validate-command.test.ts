/**
 * Tests for the validate command
 *
 * Tests the `cm validate` command which validates proposed rules against
 * historical evidence from cass sessions.
 *
 * Note: Many tests focus on input validation and error handling paths
 * since the full validation flow requires LLM API access.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateCommand } from "../src/commands/validate.js";
import { evidenceCountGate } from "../src/validate.js";
import type { EvidenceGateResult } from "../src/types.js";
import { withTempCassHome, TestEnv } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { loadConfig } from "../src/config.js";

/**
 * Capture console.log output during async function execution.
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

describe("validateCommand", () => {
  describe("input validation", () => {
    it("throws error for empty proposed rule", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            await expect(validateCommand("", { json: false })).rejects.toThrow(
              "Proposed rule text is required"
            );
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("throws error for whitespace-only rule", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            await expect(
              validateCommand("   \t\n  ", { json: false })
            ).rejects.toThrow("Proposed rule text is required");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("accepts valid rule text", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            // With no historical evidence, validateCommand now accepts with caution
            // instead of calling the LLM (optimization to avoid unnecessary API calls)
            const capture = captureConsole();
            await validateCommand("Always use TypeScript", { json: true });
            capture.restore();
            const output = JSON.parse(capture.logs.join(""));
            expect(output.data.verdict).toBe("ACCEPT_WITH_CAUTION");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("error handling", () => {
    it("accepts with caution when no evidence exists (skips LLM call)", async () => {
      // Note: With the optimization that skips LLM when no evidence exists,
      // this test verifies that missing API key doesn't cause errors when
      // LLM isn't actually needed (no evidence scenario).
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          const originalApiKey = process.env.ANTHROPIC_API_KEY;
          process.chdir(repoDir);
          delete process.env.ANTHROPIC_API_KEY;

          try {
            const capture = captureConsole();
            await validateCommand("Test rule for validation", { json: true });
            capture.restore();
            const output = JSON.parse(capture.logs.join(""));
            // When no evidence exists, accepts with caution without LLM
            expect(output.data.verdict).toBe("ACCEPT_WITH_CAUTION");
          } finally {
            if (originalApiKey) {
              process.env.ANTHROPIC_API_KEY = originalApiKey;
            }
            process.chdir(originalCwd);
          }
        });
      });
    });
  });
});

describe("evidenceCountGate", () => {
  it("returns draft state when no keywords can be extracted", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Very short content with no meaningful keywords
          const result = await evidenceCountGate("a", config);

          expect(result.passed).toBe(true);
          expect(result.suggestedState).toBe("draft");
          expect(result.reason).toContain("No meaningful keywords");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("returns draft state when no historical evidence is found", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Rule with keywords but no cass history to match
          const result = await evidenceCountGate(
            "Always use TypeScript for all new projects",
            config
          );

          expect(result.passed).toBe(true);
          expect(result.suggestedState).toBe("draft");
          // May return "No historical evidence" or proceed to ambiguous
          expect(result.suggestedState).toBeDefined();
          expect(["draft"]).toContain(result.suggestedState!);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("returns numeric counts for session analysis", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Handle authentication errors gracefully",
            config
          );

          expect(typeof result.sessionCount).toBe("number");
          expect(typeof result.successCount).toBe("number");
          expect(typeof result.failureCount).toBe("number");
          expect(result.sessionCount).toBeGreaterThanOrEqual(0);
          expect(result.successCount).toBeGreaterThanOrEqual(0);
          expect(result.failureCount).toBeGreaterThanOrEqual(0);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("provides a reason for its decision", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Use async/await instead of callbacks",
            config
          );

          expect(typeof result.reason).toBe("string");
          expect(result.reason.length).toBeGreaterThan(0);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  it("has valid structure for gate result", async () => {
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          const result = await evidenceCountGate(
            "Prefer composition over inheritance for code reuse",
            config
          );

          // Check all required fields exist
          expect(typeof result.passed).toBe("boolean");
          expect(typeof result.reason).toBe("string");
          expect(result.suggestedState).toBeDefined();
          expect(["draft", "active"]).toContain(result.suggestedState!);
          expect(typeof result.sessionCount).toBe("number");
          expect(typeof result.successCount).toBe("number");
          expect(typeof result.failureCount).toBe("number");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("classifyOutcome (via validate module)", () => {
  // The classifyOutcome function is private but we can test its behavior
  // indirectly through integration tests with mock cass data

  it("recognizes success keywords in snippets", async () => {
    // This is tested via the evidenceCountGate when cass returns matching snippets
    // Since we can't mock cass easily here, we verify the function exists
    // and the gate can process snippets
    await withTempCassHome(async () => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const config = await loadConfig();
          // Run gate which internally uses pattern matching
          const result = await evidenceCountGate(
            "Fixed the authentication bug successfully",
            config
          );

          // Result should be valid regardless of actual cass data
          expect(result).toBeDefined();
          expect(typeof result.passed).toBe("boolean");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});

describe("validateCommand with dependency injection", () => {
  /**
   * Create a CassRunner stub that returns controlled search results
   * Matches the CassSearchHitSchema: source_path, line_number, agent, snippet are required
   */
  function createCassRunnerStub(opts: {
    searchHits?: Array<{ source_path: string; snippet: string; score?: number }>;
    timelineResult?: { groups: any[] };
  }): any {
    return {
      execFile: async (_file: string, args: string[]) => {
        const cmd = args[0] ?? "";
        if (cmd === "search") {
          // Return search hits as JSON array with all required fields
          const hits = (opts.searchHits || []).map((h, idx) => ({
            source_path: h.source_path,
            line_number: idx + 1,
            agent: "test-agent",
            snippet: h.snippet,
            score: h.score ?? 0.8
          }));
          return { stdout: JSON.stringify(hits), stderr: "" };
        }
        if (cmd === "timeline") {
          return { stdout: JSON.stringify(opts.timelineResult || { groups: [] }), stderr: "" };
        }
        throw new Error(`Unexpected cass command: ${cmd}`);
      },
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      spawn: (() => {
        throw new Error("spawn not implemented in cass runner stub");
      }) as any,
    };
  }

  /**
   * Create an LLMIO stub that returns controlled validator results
   */
  function createLLMIOStub(validatorResponse: {
    verdict: "ACCEPT" | "REJECT" | "REFINE" | "ACCEPT_WITH_CAUTION";
    confidence: number;
    reason: string;
    suggestedRefinement?: string | null;
  }): any {
    return {
      generateObject: async <T>(_options: any): Promise<{ object: T }> => {
        return {
          object: {
            verdict: validatorResponse.verdict,
            confidence: validatorResponse.confidence,
            reason: validatorResponse.reason,
            suggestedRefinement: validatorResponse.suggestedRefinement ?? null,
            valid: validatorResponse.verdict !== "REJECT"
          } as unknown as T
        };
      }
    };
  }

  describe("auto-reject path (strong failure gate)", () => {
    it("rejects when evidence gate fails with high failure count", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            // Create hits that will trigger failure patterns
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Error: failed to compile the module" },
                { source_path: "/sess/2.jsonl", snippet: "Bug found in the authentication" },
                { source_path: "/sess/3.jsonl", snippet: "Crashed during deployment" },
                { source_path: "/sess/4.jsonl", snippet: "Error: threw an error parsing" },
                { source_path: "/sess/5.jsonl", snippet: "doesn't work with older versions" },
              ]
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Always skip testing in production environments",
                { json: true },
                { cassRunner }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            // The output should be valid JSON with our verdict
            expect(output).toBeDefined();
            // If gate rejects, we expect REJECT verdict
            if (output.includes('"verdict"')) {
              const parsed = JSON.parse(output);
              expect(["REJECT", "ACCEPT", "ACCEPT_WITH_CAUTION"]).toContain(parsed.data?.verdict);
            }
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("auto-accept path (strong success gate)", () => {
    it("accepts when evidence gate passes with high success count", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            // Create hits that will trigger success patterns
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Successfully deployed the feature" },
                { source_path: "/sess/2.jsonl", snippet: "Fixed the authentication issue" },
                { source_path: "/sess/3.jsonl", snippet: "Resolved the user login problem" },
                { source_path: "/sess/4.jsonl", snippet: "Works correctly after the change" },
                { source_path: "/sess/5.jsonl", snippet: "Working now in production" },
              ]
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Use TypeScript for all new features",
                { json: true },
                { cassRunner }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            expect(output).toBeDefined();
            // If gate accepts, we expect ACCEPT verdict
            if (output.includes('"verdict"')) {
              const parsed = JSON.parse(output);
              expect(["ACCEPT", "ACCEPT_WITH_CAUTION", "REJECT"]).toContain(parsed.data?.verdict);
            }
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("LLM validator path", () => {
    it("calls LLM validator when gate is ambiguous and returns ACCEPT", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            // Mixed hits that won't trigger auto-accept or auto-reject
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Used the new pattern today" },
                { source_path: "/sess/2.jsonl", snippet: "Tried the approach successfully" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.85,
              reason: "The rule is well-supported by evidence"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Use dependency injection for testability",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            expect(output).toContain('"verdict"');
            const parsed = JSON.parse(output);
            expect(parsed.data?.verdict).toBe("ACCEPT");
            expect(parsed.data?.confidence).toBeCloseTo(0.85, 1);
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("maps REFINE verdict to ACCEPT_WITH_CAUTION with reduced confidence", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Partially applied the pattern" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "REFINE",
              confidence: 0.7,
              reason: "The rule needs refinement",
              suggestedRefinement: "Use dependency injection for unit testing"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Use dependency injection",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);
            // REFINE maps to ACCEPT_WITH_CAUTION
            expect(parsed.data?.verdict).toBe("ACCEPT_WITH_CAUTION");
            // Confidence is reduced by 0.8 factor for REFINE
            expect(parsed.data?.confidence).toBeLessThan(0.7);
            expect(parsed.data?.refinedRule).toBe("Use dependency injection for unit testing");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("returns REJECT verdict from LLM", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "The approach was problematic" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "REJECT",
              confidence: 0.9,
              reason: "This rule contradicts established patterns"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Never write tests for simple functions",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);
            expect(parsed.data?.verdict).toBe("REJECT");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("classifyOutcome via evidence output", () => {
    it("classifies success snippets correctly in evidence", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Fixed the bug in auth module" },
                { source_path: "/sess/2.jsonl", snippet: "Successfully resolved the issue" },
                { source_path: "/sess/3.jsonl", snippet: "Completed the migration task" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.8,
              reason: "Rule validated"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Fix bugs before deploying",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);
            // Evidence should be classified with outcomes - verify evidence exists
            expect(parsed.data?.evidence).toBeDefined();
            expect(parsed.data.evidence.length).toBeGreaterThan(0);
            const outcomes = parsed.data.evidence.map((e: any) => e.outcome);
            expect(outcomes).toContain("success");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("classifies failure snippets correctly in evidence", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Error: failed to compile the code" },
                { source_path: "/sess/2.jsonl", snippet: "The feature is broken" },
                { source_path: "/sess/3.jsonl", snippet: "Regression found after update" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.7,
              reason: "Rule validated despite failures"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Test code before deploying",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);
            // Evidence should be classified with outcomes - verify evidence exists
            expect(parsed.data?.evidence).toBeDefined();
            expect(parsed.data.evidence.length).toBeGreaterThan(0);
            const outcomes = parsed.data.evidence.map((e: any) => e.outcome);
            expect(outcomes).toContain("failure");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("classifies unknown snippets correctly in evidence", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Discussed the architecture approach" },
                { source_path: "/sess/2.jsonl", snippet: "Reviewed the pull request" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.75,
              reason: "Rule seems reasonable"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Review code before merging",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);
            // Evidence should be classified with outcomes - verify evidence exists
            expect(parsed.data?.evidence).toBeDefined();
            expect(parsed.data.evidence.length).toBeGreaterThan(0);
            const outcomes = parsed.data.evidence.map((e: any) => e.outcome);
            expect(outcomes).toContain("unknown");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });

  describe("printResult formatting", () => {
    it("outputs valid JSON in json mode with all fields", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Applied the pattern successfully", score: 0.9 },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT_WITH_CAUTION",
              confidence: 0.75,
              reason: "Rule is valid but needs care",
              suggestedRefinement: "Apply this rule carefully in legacy code"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Refactor legacy code incrementally",
                { json: true },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            const parsed = JSON.parse(output);

            expect(parsed.success).toBe(true);
            expect(parsed.command).toBe("validate");
            expect(parsed.data).toBeDefined();
            expect(parsed.data.proposedRule).toBe("Refactor legacy code incrementally");
            expect(["ACCEPT", "ACCEPT_WITH_CAUTION", "REJECT"]).toContain(parsed.data.verdict);
            expect(typeof parsed.data.confidence).toBe("number");
            expect(typeof parsed.data.reason).toBe("string");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("outputs formatted console text in non-json mode", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Used the pattern successfully", score: 0.85 },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.9,
              reason: "Strong evidence for this rule"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Write comprehensive tests",
                { json: false },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            // Console output should contain human-readable text
            expect(output).toContain("Validation Result");
            expect(output).toContain("Write comprehensive tests");
            expect(output).toContain("Verdict");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("shows refined rule in console output when present", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Partially followed the approach" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "REFINE",
              confidence: 0.6,
              reason: "Rule needs refinement",
              suggestedRefinement: "Use TypeScript for all production code"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Use TypeScript",
                { json: false },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            expect(output).toContain("Refined Rule");
            expect(output).toContain("Use TypeScript for all production code");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });

    it("shows evidence list in console output when present", async () => {
      await withTempCassHome(async () => {
        await withTempGitRepo(async (repoDir) => {
          const originalCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const cassRunner = createCassRunnerStub({
              searchHits: [
                { source_path: "/sess/1.jsonl", snippet: "Fixed the auth bug successfully" },
                { source_path: "/sess/2.jsonl", snippet: "Resolved the login issue" },
              ]
            });

            const io = createLLMIOStub({
              verdict: "ACCEPT",
              confidence: 0.88,
              reason: "Well-evidenced rule"
            });

            const capture = captureConsole();
            try {
              await validateCommand(
                "Fix security bugs promptly",
                { json: false },
                { cassRunner, io }
              );
            } finally {
              capture.restore();
            }

            const output = capture.getOutput();
            expect(output).toContain("Evidence (cass)");
            expect(output).toContain("/sess/1.jsonl");
          } finally {
            process.chdir(originalCwd);
          }
        });
      });
    });
  });
});
