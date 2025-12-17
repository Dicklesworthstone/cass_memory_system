import { describe, test, expect } from "bun:test";

import { quickstartCommand } from "../src/commands/quickstart.js";

async function withEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function captureConsoleLog<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ")
    );
  };

  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

type QuickstartJson = {
  summary: string;
  oneCommand: string;
  expectations: {
    degradedMode: string;
    privacy: string;
    remoteHistory: string;
  };
  whatItReturns: string[];
  doNotDo: string[];
  operatorNote: {
    automation: string;
    health: string;
  };
  soloUser: {
    description: string;
    manualReflection: string[];
    onboarding: string[];
  };
  inlineFeedbackFormat: {
    helpful: string;
    harmful: string;
  };
  protocol: {
    start: string;
    work: string;
    feedback: string;
    end: string;
  };
  examples: string[];
};

type JsonEnvelope<T> = {
  success: true;
  command: string;
  timestamp: string;
  data: T;
  metadata: {
    executionMs: number;
    version: string;
  };
};

describe("quickstart command", () => {
  test("prints JSON envelope with deterministic content", async () => {
    const { output } = await withEnvAsync(
      { CASS_MEMORY_CLI_NAME: "cm", NO_COLOR: "1", FORCE_COLOR: "0" },
      () => captureConsoleLog(() => quickstartCommand({ json: true }))
    );

    const parsed = JSON.parse(output) as JsonEnvelope<QuickstartJson>;

    expect(parsed.success).toBe(true);
    expect(parsed.command).toBe("quickstart");
    expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date");
    expect(typeof parsed.metadata.executionMs).toBe("number");
    expect(parsed.metadata.executionMs).toBeGreaterThanOrEqual(0);
    expect(parsed.metadata.version).toMatch(/\d+\.\d+\.\d+/);

    expect(parsed.data.summary).toContain("Procedural memory");
    expect(parsed.data.oneCommand).toBe('cm context "<task>" --json');

    expect(parsed.data.expectations.degradedMode).toContain("cm doctor");
    expect(parsed.data.expectations.privacy).toContain("cm privacy status");
    expect(parsed.data.expectations.remoteHistory).toContain("origin.kind");

    expect(parsed.data.examples).toHaveLength(3);
    for (const example of parsed.data.examples) {
      expect(example).toStartWith("cm context ");
      expect(example).toEndWith(" --json");
    }

    expect(parsed.data.inlineFeedbackFormat.helpful).toContain("[cass: helpful");
    expect(parsed.data.inlineFeedbackFormat.harmful).toContain("[cass: harmful");
  });

  test("prints human-readable markdown with valid repo URL and examples", async () => {
    const { output } = await withEnvAsync(
      { CASS_MEMORY_CLI_NAME: "cm", NO_COLOR: "1", FORCE_COLOR: "0" },
      () => captureConsoleLog(() => quickstartCommand({ json: false }))
    );

    expect(output).toContain("# cass-memory Quick Start");
    expect(output).toContain("cm context");
    expect(output).toContain("Inline Feedback");

    const url = "https://github.com/Dicklesworthstone/cass_memory_system";
    expect(output).toContain(url);
    expect(new URL(url).protocol).toBe("https:");
  });
});
