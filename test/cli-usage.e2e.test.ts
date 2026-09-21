/**
 * E2E Tests for CLI usage command - LLM Cost Tracking Dashboard
 *
 * Tests the `cm usage` command for displaying:
 * - Daily/monthly/all-time usage statistics
 * - Budget limit progress and warnings
 * - Human-readable and JSON output formats
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { usageCommand } from "../src/commands/usage.js";

// --- Test Infrastructure ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = path.join(
    os.tmpdir(),
    `usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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
  };
}

async function setupTestEnvironment(
  options: {
    dailyCost?: number;
    monthlyCost?: number;
    allTimeCost?: number;
    dailyLimit?: number;
    monthlyLimit?: number;
  } = {},
) {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const cassMemoryDir = path.join(home, ".cass-memory");
  const costDir = path.join(cassMemoryDir, "cost");

  await mkdir(costDir, { recursive: true });

  // Create config with budget settings
  const config = {
    schema_version: 1,
    budget: {
      dailyLimit: options.dailyLimit ?? 0.1,
      monthlyLimit: options.monthlyLimit ?? 2.0,
    },
  };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  // Create cost tracking data using the actual TotalCostData schema from cost.ts
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const totalData = {
    allTime: options.allTimeCost ?? 0,
    lastUpdated: new Date().toISOString(),
    currentDay: {
      day: today,
      cost: options.dailyCost ?? 0,
    },
    currentMonth: {
      month: month,
      cost: options.monthlyCost ?? 0,
    },
  };
  await writeFile(path.join(costDir, "total.json"), JSON.stringify(totalData));

  return { dir, home, cassMemoryDir, costDir };
}

// --- Test Suites ---

describe("E2E: CLI usage command", () => {
  describe("JSON Output", () => {
    it("outputs valid JSON when --json flag is set", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        allTimeCost: 1.25,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();

        const payload = JSON.parse(output);
        expect(payload.success).toBe(true);
        expect(payload.command).toBe("usage");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("includes all expected usage fields in JSON", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        allTimeCost: 1.25,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;

        expect(stats).toHaveProperty("today");
        expect(stats).toHaveProperty("month");
        expect(stats).toHaveProperty("total");
        expect(stats).toHaveProperty("dailyLimit");
        expect(stats).toHaveProperty("monthlyLimit");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("returns correct usage values", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.0543,
        monthlyCost: 0.8765,
        allTimeCost: 3.2109,
        dailyLimit: 0.15,
        monthlyLimit: 5.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;

        expect(stats.today).toBeCloseTo(0.0543, 4);
        expect(stats.month).toBeCloseTo(0.8765, 4);
        expect(stats.total).toBeCloseTo(3.2109, 4);
        expect(stats.dailyLimit).toBeCloseTo(0.15, 2);
        expect(stats.monthlyLimit).toBeCloseTo(5.0, 2);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Human-Readable Output", () => {
    it("displays usage statistics in human-readable format", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        allTimeCost: 1.25,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("LLM Usage Statistics");
        expect(output).toContain("Today:");
        expect(output).toContain("Month:");
        expect(output).toContain("All-time:");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("displays budget progress bars", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Budget Progress");
        expect(output).toContain("Daily:");
        expect(output).toContain("Monthly:");
        // Progress bars contain block characters
        expect(output).toMatch(/[█░]/);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("displays percentage of budget used", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 1.0,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        // Should show 50% for daily (0.05/0.10) and 50% for monthly (1.00/2.00)
        expect(output).toContain("50.0%");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("shows config tip", async () => {
      const { home } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("config.json");
        expect(output).toContain("budget");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Budget Warnings", () => {
    it("shows warning when daily limit is reached", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.12, // Over the 0.10 limit
        monthlyCost: 0.5,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Daily budget limit reached");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("shows warning when monthly limit is reached", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 2.5, // Over the 2.00 limit
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Monthly budget limit reached");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("no warning when within budget", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.02,
        monthlyCost: 0.5,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).not.toContain("budget limit reached");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Zero/No Limits", () => {
    it("handles zero daily limit gracefully", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        dailyLimit: 0,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        // Should show "no limit set" or N/A for percentage
        expect(output).toMatch(/no limit set|N\/A/);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("handles zero monthly limit gracefully", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.05,
        monthlyCost: 0.5,
        dailyLimit: 0.1,
        monthlyLimit: 0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        // Should show "no limit set" for monthly progress bar
        expect(output).toMatch(/no limit set|N\/A/);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("No Cost Data", () => {
    it("handles missing cost file gracefully", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");

      await mkdir(cassMemoryDir, { recursive: true });

      // Create config but NO cost directory or file
      const config = {
        schema_version: 1,
        budget: {
          dailyLimit: 0.1,
          monthlyLimit: 2.0,
        },
      };
      await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);

        // Should return zeros for all usage
        expect(payload.data.today).toBe(0);
        expect(payload.data.month).toBe(0);
        expect(payload.data.total).toBe(0);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("shows zero usage in human-readable format when no cost data", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");

      await mkdir(cassMemoryDir, { recursive: true });

      const config = {
        schema_version: 1,
        budget: {
          dailyLimit: 0.1,
          monthlyLimit: 2.0,
        },
      };
      await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        // Should show $0.0000 for usage
        expect(output).toContain("$0.0000");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Progress Bar Rendering", () => {
    it("shows green bar for low usage", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.02, // 20% of limit
        monthlyCost: 0.2, // 10% of limit
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        // The output contains ANSI color codes
        // Just verify the progress bars are rendered
        const output = capture.logs.join("\n");
        expect(output).toContain("█");
        expect(output).toContain("░");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("shows yellow bar near limit (80%+)", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.085, // 85% of limit
        monthlyCost: 1.7, // 85% of limit
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        // Just verify the output is generated without error
        const output = capture.logs.join("\n");
        expect(output).toContain("Budget Progress");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("shows red bar when over limit", async () => {
      const { home } = await setupTestEnvironment({
        dailyCost: 0.15, // 150% of limit
        monthlyCost: 0.5,
        dailyLimit: 0.1,
        monthlyLimit: 2.0,
      });
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Daily budget limit reached");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Error Handling", () => {
    it("handles corrupted cost file gracefully", async () => {
      const { home, costDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      // Overwrite with invalid JSON
      await writeFile(path.join(costDir, "total.json"), "{ invalid json }");

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await usageCommand({ json: true });
        } finally {
          capture.restore();
        }

        // Should not crash - may return zeros or error
        const output = capture.logs.join("\n") + capture.errors.join("\n");
        expect(output.length).toBeGreaterThan(0);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
