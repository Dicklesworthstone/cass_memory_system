import { describe, test, expect } from "bun:test";

import {
  agentIcon,
  agentIconPrefix,
  formatCheckStatusBadge,
  formatKv,
  formatMaturityIcon,
  formatRule,
  formatSafetyBadge,
  formatTipPrefix,
  getOutputStyle,
  icon,
  iconPrefix,
  wrapText,
} from "../src/output.js";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withStdoutColumns<T>(columns: number | undefined, fn: () => T): T {
  const stdout = process.stdout as unknown as Record<string, unknown>;
  const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");

  Object.defineProperty(stdout, "columns", { value: columns, configurable: true });
  try {
    return fn();
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(stdout, "columns", previousDescriptor);
    } else {
      // Restore prototype/default lookup
      delete (stdout as any).columns;
    }
  }
}

describe("output.ts", () => {
  test("getOutputStyle respects NO_COLOR + CASS_MEMORY_NO_EMOJI", () => {
    const styleDefault = withEnv(
      { NO_COLOR: undefined, CASS_MEMORY_NO_EMOJI: undefined, CASS_MEMORY_WIDTH: undefined },
      () => getOutputStyle()
    );
    expect(styleDefault.color).toBe(true);
    expect(styleDefault.emoji).toBe(true);

    const style = withEnv(
      { NO_COLOR: "1", CASS_MEMORY_NO_EMOJI: "1", CASS_MEMORY_WIDTH: undefined },
      () => getOutputStyle()
    );
    expect(style.color).toBe(false);
    expect(style.emoji).toBe(false);
  });

  test("getOutputStyle width: env override wins, otherwise uses stdout.columns, else 80", () => {
    const fromColumns = withEnv(
      { CASS_MEMORY_WIDTH: undefined, NO_COLOR: undefined, CASS_MEMORY_NO_EMOJI: undefined },
      () => withStdoutColumns(101, () => getOutputStyle().width)
    );
    expect(fromColumns).toBe(101);

    const fromEnv = withEnv(
      { CASS_MEMORY_WIDTH: " 42 ", NO_COLOR: undefined, CASS_MEMORY_NO_EMOJI: undefined },
      () => withStdoutColumns(101, () => getOutputStyle().width)
    );
    expect(fromEnv).toBe(42);

    const invalidEnvFallsBack = withEnv(
      { CASS_MEMORY_WIDTH: "nope", NO_COLOR: undefined, CASS_MEMORY_NO_EMOJI: undefined },
      () => withStdoutColumns(77, () => getOutputStyle().width)
    );
    expect(invalidEnvFallsBack).toBe(77);

    const fallback80 = withEnv(
      { CASS_MEMORY_WIDTH: "nope", NO_COLOR: undefined, CASS_MEMORY_NO_EMOJI: undefined },
      () => withStdoutColumns(undefined, () => getOutputStyle().width)
    );
    expect(fallback80).toBe(80);
  });

  test("icon + iconPrefix respect emoji toggle", () => {
    const warningPlain = withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => icon("warning"));
    expect(warningPlain).toBe("[!]");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => iconPrefix("warning"))).toBe("[!] ");

    const warningEmoji = withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => icon("warning"));
    expect(warningEmoji).toContain("⚠");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => iconPrefix("warning"))).toContain("⚠");
  });

  test("agentIcon matches known agents and is disabled when emoji is off", () => {
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => agentIcon("claude"))).toBe("");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => agentIcon("claude-code"))).toBe("🟣");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => agentIcon("codex-cli"))).toBe("🟢");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => agentIcon("cursor"))).toBe("🔵");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => agentIconPrefix("cursor"))).toBe("🔵 ");
  });

  test("formatTipPrefix switches between emoji and text prefix", () => {
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => formatTipPrefix())).toBe("Tip: ");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatTipPrefix())).toBe("💡 ");
  });

  test("formatCheckStatusBadge + formatSafetyBadge switch between emoji and text", () => {
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => formatCheckStatusBadge("pass"))).toBe("PASS");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatCheckStatusBadge("pass"))).toBe("✅");

    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => formatSafetyBadge("manual"))).toBe("MANUAL");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatSafetyBadge("manual"))).toBe("📝");
  });

  test("formatMaturityIcon is empty when emoji off, otherwise matches expected mapping", () => {
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: "1" }, () => formatMaturityIcon("proven"))).toBe("");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatMaturityIcon("proven"))).toBe("✅");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatMaturityIcon("established"))).toBe("🔵");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatMaturityIcon("candidate"))).toBe("🟡");
    expect(withEnv({ CASS_MEMORY_NO_EMOJI: undefined }, () => formatMaturityIcon("unknown"))).toBe("⚪");
  });

  test("formatRule clamps width with minWidth/maxWidth", () => {
    expect(formatRule("x", { width: 5 })).toBe("x".repeat(10));
    expect(formatRule("x", { width: 20, maxWidth: 12 })).toBe("x".repeat(12));
    expect(formatRule("x", { width: 20, minWidth: 25 })).toBe("x".repeat(25));
  });

  test("wrapText wraps by words and preserves blank lines", () => {
    expect(wrapText("hello world", 5)).toEqual(["hello", "world"]);
    expect(wrapText("a b\n\nc d", 3)).toEqual(["a b", "", "c d"]);
  });

  test("formatKv wraps values and aligns continuation lines", () => {
    const output = formatKv(
      [{ key: "Key", value: "one two three four five" }],
      { width: 16, indent: "", separator: ": " }
    );
    const lines = output.split("\n");
    expect(lines[0]).toStartWith("Key: ");
    expect(lines.length).toBeGreaterThan(1);
    // Continuation uses spaces for key cell + separator
    expect(lines[1]).toStartWith("   : ");
  });
});

