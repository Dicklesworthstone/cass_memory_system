/**
 * Tests for the info command (cm --info).
 */
import { describe, expect, it } from "bun:test";
import { gatherInfo, InfoResult, infoCommand } from "../src/info.js";

function captureConsole() {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    output: () => logs.join("\n"),
    restore: () => {
      console.log = originalLog;
    },
  };
}

describe("info command", () => {
  describe("gatherInfo", () => {
    it("returns structured info object", async () => {
      const info = await gatherInfo();

      // Version
      expect(typeof info.version).toBe("string");
      expect(info.version.length).toBeGreaterThan(0);

      // Configuration
      expect(info.configuration).toBeDefined();
      expect(info.configuration.globalConfig).toBeDefined();
      expect(typeof info.configuration.globalConfig.path).toBe("string");
      expect(typeof info.configuration.globalConfig.exists).toBe("boolean");

      expect(info.configuration.globalPlaybook).toBeDefined();
      expect(typeof info.configuration.globalPlaybook.path).toBe("string");
      expect(typeof info.configuration.globalPlaybook.exists).toBe("boolean");

      // Environment
      expect(info.environment).toBeDefined();
      expect(info.environment.OPENAI_API_KEY).toBeDefined();
      expect(typeof info.environment.OPENAI_API_KEY.set).toBe("boolean");

      // Dependencies
      expect(info.dependencies).toBeDefined();
      expect(info.dependencies.node).toBeDefined();
      expect(info.dependencies.node.version).toMatch(/^v?\d+\.\d+/);
    });

    it("masks API keys correctly", async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      try {
        // Set a test key
        process.env.OPENAI_API_KEY = "sk-test1234567890abcdefghij";
        const info = await gatherInfo();

        expect(info.environment.OPENAI_API_KEY.set).toBe(true);
        expect(info.environment.OPENAI_API_KEY.masked).toBe("sk-...ghij");
        // Ensure the full key is NOT in the output
        expect(info.environment.OPENAI_API_KEY.masked).not.toContain("1234567890");
      } finally {
        if (originalKey !== undefined) {
          process.env.OPENAI_API_KEY = originalKey;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });

    it("detects cass CLI availability", async () => {
      const info = await gatherInfo();

      // cass dependency info should be present
      expect(info.dependencies.cass).toBeDefined();
      expect(typeof info.dependencies.cass.available).toBe("boolean");

      // If available, version should be a string
      if (info.dependencies.cass.available) {
        expect(typeof info.dependencies.cass.version).toBe("string");
      }
    });

    it("detects Bun runtime", async () => {
      const info = await gatherInfo();

      // When running under Bun (which we are), bun should be available
      expect(info.dependencies.bun).toBeDefined();
      expect(info.dependencies.bun.available).toBe(true);
      expect(typeof info.dependencies.bun.version).toBe("string");
    });

    it("includes workspace playbook info when in repo", async () => {
      const info = await gatherInfo();

      // We're running in the cass_memory_system repo which has .cass/
      expect(info.configuration.workspacePlaybook.path).not.toBeNull();
    });
  });

  describe("infoCommand", () => {
    it("outputs JSON when json option is true", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({ json: true });
        const output = capture.output();
        const parsed = JSON.parse(output);

        expect(parsed.success).toBe(true);
        expect(parsed.command).toBe("info");
        expect(parsed.data.version).toBeString();
        expect(parsed.data.configuration).toBeDefined();
        expect(parsed.data.environment).toBeDefined();
        expect(parsed.data.dependencies).toBeDefined();
      } finally {
        capture.restore();
      }
    });

    it("outputs human-readable format by default", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        // Should contain key sections
        expect(output).toContain("Configuration:");
        expect(output).toContain("Environment:");
        expect(output).toContain("Dependencies:");
        expect(output).toContain("Node.js:");
      } finally {
        capture.restore();
      }
    });

    it("shows OPENAI_API_KEY status in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        expect(output).toContain("OPENAI_API_KEY:");
      } finally {
        capture.restore();
      }
    });

    it("shows ANTHROPIC_API_KEY status in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        expect(output).toContain("ANTHROPIC_API_KEY:");
      } finally {
        capture.restore();
      }
    });

    it("shows cass CLI status in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        // Should show either available version or not available
        expect(output).toMatch(/cass CLI:/i);
      } finally {
        capture.restore();
      }
    });

    it("shows Bun version when running under Bun", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        // Since we're running under Bun, it should show Bun version
        expect(output).toContain("Bun:");
      } finally {
        capture.restore();
      }
    });

    it("shows doctor hint in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        expect(output).toContain("doctor");
      } finally {
        capture.restore();
      }
    });

    it("shows global config path in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        expect(output).toContain("Global config:");
      } finally {
        capture.restore();
      }
    });

    it("shows playbook paths in human output", async () => {
      const capture = captureConsole();
      try {
        await infoCommand({});
        const output = capture.output();

        expect(output).toContain("Global playbook:");
        expect(output).toContain("Workspace playbook:");
      } finally {
        capture.restore();
      }
    });
  });
});
