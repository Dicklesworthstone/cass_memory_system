/**
 * Unit tests for outcome.ts - Implicit feedback and outcome tracking
 *
 * Tests the core functions:
 * - detectSentiment: Sentiment detection from user text
 * - scoreImplicitFeedback: Scoring logic for outcome signals
 * - recordOutcome: Persistence with sanitization
 * - loadOutcomes: Loading with sanitization
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  detectSentiment,
  scoreImplicitFeedback,
  recordOutcome,
  loadOutcomes,
  OutcomeInput,
} from "../src/outcome.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestConfig } from "./helpers/factories.js";

describe("detectSentiment", () => {
  describe("positive patterns", () => {
    it("detects 'that worked' as positive", () => {
      expect(detectSentiment("that worked perfectly")).toBe("positive");
    });

    it("detects 'perfect' as positive", () => {
      expect(detectSentiment("Perfect!")).toBe("positive");
    });

    it("detects 'thanks' as positive", () => {
      expect(detectSentiment("Thanks for the help")).toBe("positive");
    });

    it("detects 'great' as positive", () => {
      expect(detectSentiment("Great job")).toBe("positive");
    });

    it("detects 'exactly what i needed' as positive", () => {
      expect(detectSentiment("That's exactly what I needed")).toBe("positive");
    });

    it("detects 'solved it' as positive", () => {
      expect(detectSentiment("You solved it")).toBe("positive");
    });
  });

  describe("negative patterns", () => {
    it("detects 'that's wrong' as negative", () => {
      expect(detectSentiment("That's wrong")).toBe("negative");
    });

    it("detects 'that is wrong' as negative", () => {
      expect(detectSentiment("That is wrong")).toBe("negative");
    });

    it("detects 'doesn't work' as negative", () => {
      expect(detectSentiment("This doesn't work")).toBe("negative");
    });

    it("detects 'broke' as negative", () => {
      expect(detectSentiment("You broke the build")).toBe("negative");
    });

    it("detects 'not what i wanted' as negative", () => {
      expect(detectSentiment("That's not what I wanted")).toBe("negative");
    });

    it("detects 'try again' as negative", () => {
      expect(detectSentiment("Please try again")).toBe("negative");
    });

    it("detects 'undo' as negative", () => {
      expect(detectSentiment("Can you undo that?")).toBe("negative");
    });
  });

  describe("neutral cases", () => {
    it("returns neutral for undefined input", () => {
      expect(detectSentiment(undefined)).toBe("neutral");
    });

    it("returns neutral for empty string", () => {
      expect(detectSentiment("")).toBe("neutral");
    });

    it("returns neutral for text with no sentiment markers", () => {
      expect(detectSentiment("Please implement the login feature")).toBe("neutral");
    });

    it("returns neutral when positive and negative counts are equal", () => {
      // "thanks" (positive) + "try again" (negative) = tie
      expect(detectSentiment("Thanks but please try again")).toBe("neutral");
    });
  });

  describe("case insensitivity", () => {
    it("matches UPPERCASE patterns", () => {
      expect(detectSentiment("THAT WORKED")).toBe("positive");
    });

    it("matches MixedCase patterns", () => {
      expect(detectSentiment("That's WRONG")).toBe("negative");
    });
  });
});

describe("scoreImplicitFeedback", () => {
  describe("outcome-based scoring", () => {
    it("returns helpful for success outcome", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("helpful");
      expect(result!.context).toContain("success");
    });

    it("returns harmful for failure outcome", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "failure",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("harmful");
      expect(result!.context).toContain("failure");
    });

    it("handles partial outcome with small scores", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "partial",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      // With equal small scores (0.1 each), helpful wins (>=)
      expect(result!.type).toBe("helpful");
      expect(result!.context).toContain("partial");
    });

    it("handles mixed outcome with small scores", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "mixed",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("mixed");
    });
  });

  describe("duration-based scoring", () => {
    it("adds bonus for fast completion (under 10 min) on success", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        durationSec: 300, // 5 minutes
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("helpful");
      expect(result!.context).toContain("fast");
      expect(result!.decayedValue).toBeGreaterThan(1); // 1 (success) + 0.5 (fast)
    });

    it("does not add fast bonus on failure even if quick", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "failure",
        durationSec: 60, // 1 minute
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).not.toContain("fast");
    });

    it("adds penalty for slow completion (over 1 hour)", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        durationSec: 4000, // Over 1 hour
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("slow");
    });

    it("ignores zero duration", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        durationSec: 0,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).not.toContain("fast");
    });
  });

  describe("error-based scoring", () => {
    it("adds moderate penalty for single error", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        errorCount: 1,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("error");
    });

    it("adds larger penalty for 2+ errors", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        errorCount: 3,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("errors>=2");
    });

    it("no penalty for zero errors", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        errorCount: 0,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).not.toContain("error");
    });
  });

  describe("retry-based scoring", () => {
    it("adds penalty for retries", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        hadRetries: true,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("retries");
    });

    it("no penalty when hadRetries is false", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        hadRetries: false,
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).not.toContain("retries");
    });
  });

  describe("sentiment-based scoring", () => {
    it("adds bonus for positive sentiment", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        sentiment: "positive",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("sentiment+");
    });

    it("adds penalty for negative sentiment", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        sentiment: "negative",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).toContain("sentiment-");
    });

    it("no change for neutral sentiment", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        sentiment: "neutral",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.context).not.toContain("sentiment");
    });
  });

  describe("combined scoring", () => {
    it("success can become harmful with many negative signals", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success", // +1 helpful
        durationSec: 5000, // +0.3 harmful (slow)
        errorCount: 3, // +0.7 harmful
        hadRetries: true, // +0.5 harmful
        sentiment: "negative", // +0.5 harmful
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      // 1.0 helpful vs 2.0 harmful
      expect(result!.type).toBe("harmful");
    });

    it("failure can be mitigated by positive signals (but stays harmful)", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "failure", // +1 harmful
        sentiment: "positive", // +0.3 helpful
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("harmful");
    });

    it("decayedValue is clamped to max 2", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "success",
        durationSec: 60, // fast
        sentiment: "positive",
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.decayedValue).toBeLessThanOrEqual(2);
    });

    it("decayedValue is clamped to min 0.1", () => {
      const input: OutcomeInput = {
        sessionId: "test-session",
        outcome: "partial", // 0.1 each
      };
      const result = scoreImplicitFeedback(input);
      expect(result).not.toBeNull();
      expect(result!.decayedValue).toBeGreaterThanOrEqual(0.1);
    });
  });

  // Regression suite for #56: a non-failure session must never manufacture a
  // `harmful` mark from weak, incidental signals, and an auto-graded session
  // whose rule set is the injected context must never blanket-blame harm.
  describe("#56 harm-attribution policy", () => {
    it("does NOT mark mixed + single error as harmful (the corpus flood)", () => {
      // This is the exact incident scenario: a `mixed` session with errorCount 1.
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "mixed",
        errorCount: 1,
      });
      // Net harm (0.3) is below the override margin -> abstain, never harmful.
      expect(result?.type).not.toBe("harmful");
      expect(result).toBeNull();
    });

    it("does NOT mark partial + single error as harmful", () => {
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "partial",
        errorCount: 1,
      });
      expect(result).toBeNull();
    });

    it("does NOT mark mixed + negative sentiment as harmful", () => {
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "mixed",
        sentiment: "negative",
      });
      expect(result).toBeNull();
    });

    it("does NOT mark mixed + retries as harmful", () => {
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "mixed",
        hadRetries: true,
      });
      expect(result).toBeNull();
    });

    it("still allows mixed -> harmful when negative evidence is overwhelming", () => {
      // 2+ errors (0.7) + retries (0.5) + negative sentiment (0.5) = 1.7 net harm,
      // which clears the 1.0 override margin: a genuine pile-up still flips.
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "mixed",
        errorCount: 3,
        hadRetries: true,
        sentiment: "negative",
      });
      expect(result?.type).toBe("harmful");
    });

    it("still credits a pure mixed/partial session as helpful (non-null)", () => {
      expect(scoreImplicitFeedback({ sessionId: "s", outcome: "mixed" })?.type).toBe("helpful");
      expect(scoreImplicitFeedback({ sessionId: "s", outcome: "partial" })?.type).toBe("helpful");
    });

    it("suppresses harm for an auto-graded session with a blast-radius rule set", () => {
      // A genuine `failure` that injected the whole context (50 shown rules) must
      // NOT blanket-condemn all of them: we cannot attribute the failure to any
      // specific shown rule.
      const big = Array.from({ length: 50 }, (_, i) => `b-rule${i}0`);
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "failure",
        errorCount: 1,
        rulesUsed: big,
        autoGraded: true,
      });
      expect(result?.type).not.toBe("harmful");
      expect(result).toBeNull();
    });

    it("still grades harm for an auto-graded FAILURE with a small (citation-sized) rule set", () => {
      // Small-N deliberate-citation-sized sets on a real failure are trusted.
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "failure",
        rulesUsed: ["b-abc123", "b-def456"],
        autoGraded: true,
      });
      expect(result?.type).toBe("harmful");
    });

    it("does NOT apply the blast-radius guard to manual (non-auto) outcomes", () => {
      // A user who explicitly lists many rules in `cm outcome failure ...` is
      // trusted — the guard only fires for auto-harvested (shown) rule sets.
      const big = Array.from({ length: 50 }, (_, i) => `b-rule${i}0`);
      const result = scoreImplicitFeedback({
        sessionId: "s",
        outcome: "failure",
        rulesUsed: big,
        // autoGraded intentionally unset (manual path)
      });
      expect(result?.type).toBe("harmful");
    });
  });
});

describe("recordOutcome", () => {
  it("records outcome to outcomes.jsonl file", async () => {
    await withTempCassHome(async (env) => {
      // Change to temp dir to isolate from repo's .cass
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        const input: OutcomeInput = {
          sessionId: "test-session-123",
          outcome: "success",
          rulesUsed: ["rule-1", "rule-2"],
          notes: "Test notes",
          task: "Test task",
        };

        const record = await recordOutcome(input, config);

        expect(record.sessionId).toBe("test-session-123");
        expect(record.outcome).toBe("success");
        expect(record.rulesUsed).toEqual(["rule-1", "rule-2"]);
        expect(record.notes).toBe("Test notes");
        expect(record.task).toBe("Test task");
        expect(record.recordedAt).toBeDefined();
        expect(record.path).toContain("outcomes.jsonl");
      } finally {
        process.chdir(originalCwd);
      }
    }, "record-outcome");
  });

  it("sanitizes notes and task fields", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        const input: OutcomeInput = {
          sessionId: "test-session",
          outcome: "success",
          notes: "Secret: sk-12345678901234567890123456789012345678901234567890",
          task: "Use API key sk-abcdefghijklmnopqrstuvwxyz123456789012345678",
        };

        const record = await recordOutcome(input, config);

        // Should be sanitized (API key patterns replaced)
        expect(record.notes).not.toContain("sk-12345678901234567890123456789012345678901234567890");
        expect(record.task).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456789012345678");
      } finally {
        process.chdir(originalCwd);
      }
    }, "sanitize-outcome");
  });

  it("creates parent directory if not exists", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        const input: OutcomeInput = {
          sessionId: "test-session",
          outcome: "success",
        };

        const record = await recordOutcome(input, config);

        // Verify file was created
        const exists = await fs.stat(record.path).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    }, "create-dir-outcome");
  });

  it("appends to existing outcomes file", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Record two outcomes
        await recordOutcome({ sessionId: "session-1", outcome: "success" }, config);
        await recordOutcome({ sessionId: "session-2", outcome: "failure" }, config);

        // Load and verify both exist
        const outcomes = await loadOutcomes(config);
        expect(outcomes.length).toBe(2);
        expect(outcomes.map(o => o.sessionId)).toContain("session-1");
        expect(outcomes.map(o => o.sessionId)).toContain("session-2");
      } finally {
        process.chdir(originalCwd);
      }
    }, "append-outcome");
  });

  it("defaults rulesUsed to empty array", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        const input: OutcomeInput = {
          sessionId: "test-session",
          outcome: "success",
          // No rulesUsed provided
        };

        const record = await recordOutcome(input, config);
        expect(record.rulesUsed).toEqual([]);
      } finally {
        process.chdir(originalCwd);
      }
    }, "default-rules-outcome");
  });
});

describe("loadOutcomes", () => {
  it("returns empty array when file does not exist", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        const outcomes = await loadOutcomes(config);
        expect(outcomes).toEqual([]);
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-empty-outcome");
  });

  it("loads outcomes from file", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Record some outcomes first
        await recordOutcome({ sessionId: "s1", outcome: "success", task: "Task 1" }, config);
        await recordOutcome({ sessionId: "s2", outcome: "failure", task: "Task 2" }, config);
        await recordOutcome({ sessionId: "s3", outcome: "partial", task: "Task 3" }, config);

        const outcomes = await loadOutcomes(config);
        expect(outcomes.length).toBe(3);
        expect(outcomes[0].sessionId).toBe("s1");
        expect(outcomes[1].sessionId).toBe("s2");
        expect(outcomes[2].sessionId).toBe("s3");
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-outcomes");
  });

  it("respects limit parameter", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Record 5 outcomes
        for (let i = 1; i <= 5; i++) {
          await recordOutcome({ sessionId: `s${i}`, outcome: "success" }, config);
        }

        const outcomes = await loadOutcomes(config, 2);
        expect(outcomes.length).toBe(2);
        // Should get the last 2 (most recent)
        expect(outcomes[0].sessionId).toBe("s4");
        expect(outcomes[1].sessionId).toBe("s5");
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-limit-outcome");
  });

  it("handles malformed JSON lines gracefully", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Record one valid outcome
        await recordOutcome({ sessionId: "valid", outcome: "success" }, config);

        // Manually append malformed line
        const outcomesPath = path.join(env.cassMemoryDir, "outcomes.jsonl");
        await fs.appendFile(outcomesPath, "{ invalid json }\n");

        // Record another valid outcome
        await recordOutcome({ sessionId: "valid2", outcome: "failure" }, config);

        const outcomes = await loadOutcomes(config);
        // Should have 2 valid outcomes, malformed line ignored
        expect(outcomes.length).toBe(2);
        expect(outcomes.map(o => o.sessionId)).toContain("valid");
        expect(outcomes.map(o => o.sessionId)).toContain("valid2");
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-malformed-outcome");
  });

  it("sanitizes notes and task on load", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Manually write outcome with unsanitized content
        const outcomesPath = path.join(env.cassMemoryDir, "outcomes.jsonl");
        await fs.mkdir(path.dirname(outcomesPath), { recursive: true });

        const rawOutcome = {
          sessionId: "test",
          outcome: "success",
          notes: "API key: sk-12345678901234567890123456789012345678901234567890",
          task: "Testing task",
          recordedAt: new Date().toISOString(),
          path: outcomesPath,
          rulesUsed: [],
        };
        await fs.writeFile(outcomesPath, JSON.stringify(rawOutcome) + "\n");

        const outcomes = await loadOutcomes(config);
        expect(outcomes.length).toBe(1);
        // Notes should be sanitized on load
        expect(outcomes[0].notes).not.toContain("sk-12345678901234567890123456789012345678901234567890");
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-sanitize-outcome");
  });

  it("handles empty lines in file", async () => {
    await withTempCassHome(async (env) => {
      const originalCwd = process.cwd();
      process.chdir(env.home);

      try {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });

        // Manually write file with empty lines
        const outcomesPath = path.join(env.cassMemoryDir, "outcomes.jsonl");
        await fs.mkdir(path.dirname(outcomesPath), { recursive: true });

        const outcome1 = JSON.stringify({ sessionId: "s1", outcome: "success", recordedAt: new Date().toISOString(), path: outcomesPath, rulesUsed: [] });
        const outcome2 = JSON.stringify({ sessionId: "s2", outcome: "failure", recordedAt: new Date().toISOString(), path: outcomesPath, rulesUsed: [] });

        await fs.writeFile(outcomesPath, `${outcome1}\n\n\n${outcome2}\n`);

        const outcomes = await loadOutcomes(config);
        expect(outcomes.length).toBe(2);
      } finally {
        process.chdir(originalCwd);
      }
    }, "load-empty-lines-outcome");
  });
});
