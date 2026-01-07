/**
 * Unit tests for examples.ts module
 *
 * Tests the examples command which displays curated workflows
 * for users to copy-paste.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { examplesCommand } from "../src/examples.js";

/**
 * Capture console output during command execution.
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
    all: () => [...logs, ...errors].join("\n"),
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

describe("examplesCommand", () => {
  describe("JSON output", () => {
    it("returns workflows array with expected structure", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        expect(output.success).toBe(true);
        expect(output.command).toBe("examples");
        expect(output.data.workflows).toBeArray();
        expect(output.data.workflows.length).toBeGreaterThan(0);
        expect(output.data.tip).toBeString();
      } finally {
        capture.restore();
      }
    });

    it("each workflow has title, description, and commands", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        for (const workflow of output.data.workflows) {
          expect(workflow.title).toBeString();
          expect(workflow.title.length).toBeGreaterThan(0);
          expect(workflow.description).toBeString();
          expect(workflow.description.length).toBeGreaterThan(0);
          expect(workflow.commands).toBeArray();
          expect(workflow.commands.length).toBeGreaterThan(0);
        }
      } finally {
        capture.restore();
      }
    });

    it("strips comments from commands in JSON output", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        // Commands should not contain trailing comments (# ...)
        for (const workflow of output.data.workflows) {
          for (const cmd of workflow.commands) {
            // Comments starting with # should be stripped
            expect(cmd).not.toMatch(/#\s+\w/);
          }
        }
      } finally {
        capture.restore();
      }
    });

    it("includes Quick Start workflow", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        const quickStart = output.data.workflows.find(
          (w: { title: string }) => w.title === "Quick Start"
        );
        expect(quickStart).toBeDefined();
        expect(quickStart.commands.some((c: string) => c.includes("init"))).toBe(true);
        expect(quickStart.commands.some((c: string) => c.includes("context"))).toBe(true);
      } finally {
        capture.restore();
      }
    });

    it("includes Agent Workflow", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        const agentWorkflow = output.data.workflows.find(
          (w: { title: string }) => w.title === "Agent Workflow"
        );
        expect(agentWorkflow).toBeDefined();
        expect(agentWorkflow.commands.some((c: string) => c.includes("mark"))).toBe(true);
        expect(agentWorkflow.commands.some((c: string) => c.includes("outcome"))).toBe(true);
      } finally {
        capture.restore();
      }
    });

    it("includes Playbook Management workflow", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        const playbookMgmt = output.data.workflows.find(
          (w: { title: string }) => w.title === "Playbook Management"
        );
        expect(playbookMgmt).toBeDefined();
        expect(playbookMgmt.commands.some((c: string) => c.includes("playbook"))).toBe(true);
      } finally {
        capture.restore();
      }
    });

    it("includes Safety Guards workflow", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        const safetyGuards = output.data.workflows.find(
          (w: { title: string }) => w.title.includes("Safety") || w.title.includes("Guard")
        );
        expect(safetyGuards).toBeDefined();
        expect(safetyGuards.commands.some((c: string) => c.includes("guard") || c.includes("trauma"))).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });

  describe("human output", () => {
    it("prints output to console without json flag", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({});
        const output = capture.all();

        expect(output.length).toBeGreaterThan(0);
        expect(capture.logs.length).toBeGreaterThan(0);
      } finally {
        capture.restore();
      }
    });

    it("includes Examples header", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({});
        const output = capture.all();

        expect(output).toContain("Examples");
      } finally {
        capture.restore();
      }
    });

    it("includes workflow titles", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({});
        const output = capture.all();

        expect(output).toContain("Quick Start");
        expect(output).toContain("Agent Workflow");
        expect(output).toContain("Playbook Management");
      } finally {
        capture.restore();
      }
    });

    it("includes tip about --help", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({});
        const output = capture.all();

        expect(output).toContain("--help");
      } finally {
        capture.restore();
      }
    });

    it("defaults to human output when options is undefined", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand();
        const output = capture.all();

        // Should produce human output, not JSON
        expect(output).toContain("Examples");
        expect(() => JSON.parse(output)).toThrow();
      } finally {
        capture.restore();
      }
    });
  });

  describe("workflow content validation", () => {
    it("all commands use consistent CLI name", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        for (const workflow of output.data.workflows) {
          for (const cmd of workflow.commands) {
            // Commands should start with "cm " or be a comment/placeholder/empty
            if (cmd && !cmd.startsWith("#") && !cmd.startsWith("...")) {
              expect(cmd).toMatch(/^cm\s/);
            }
          }
        }
      } finally {
        capture.restore();
      }
    });

    it("workflows cover major functionality areas", async () => {
      const capture = captureConsole();
      try {
        await examplesCommand({ json: true });
        const output = JSON.parse(capture.logs.join(""));

        const titles = output.data.workflows.map((w: { title: string }) => w.title.toLowerCase());
        const allCommands = output.data.workflows
          .flatMap((w: { commands: string[] }) => w.commands)
          .join(" ");

        // Should cover key areas
        expect(allCommands).toContain("context");
        expect(allCommands).toContain("playbook");
        expect(allCommands).toContain("reflect");
        expect(allCommands).toContain("doctor");
        expect(allCommands).toContain("onboard");
      } finally {
        capture.restore();
      }
    });
  });
});
