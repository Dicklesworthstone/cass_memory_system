import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: Level;
  testName: string;
  step: string;
  message: string;
  context?: Record<string, unknown>;
  durationMs?: number;
}

interface TestSummary {
  testName: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  entryCount: number;
  errors: string[];
}

const LOG_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * E2E Test Logger with detailed logging per ke2x spec:
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Format: [TIMESTAMP] [LEVEL] [TEST_NAME] [STEP] message
 * - File output to test/logs/{test-name}-{timestamp}.log
 * - Summary JSON to test/logs/summary.json
 */
export class TestLogger {
  private entries: LogEntry[] = [];
  private startTime: number;
  private stepTimers: Map<string, number> = new Map();
  private errors: string[] = [];

  constructor(
    private testName: string,
    private minLevel: Level = "info",
    private logDir: string = path.join(process.cwd(), "test/logs")
  ) {
    this.startTime = Date.now();
  }

  private shouldLog(level: Level): boolean {
    return LOG_ORDER[level] >= LOG_ORDER[this.minLevel];
  }

  private formatEntry(e: LogEntry): string {
    const prefix = `[${e.ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.testName}] [${e.step}]`;
    const duration = e.durationMs ? ` (${e.durationMs}ms)` : "";
    const context = e.context ? `\n  context: ${JSON.stringify(e.context)}` : "";
    return `${prefix} ${e.message}${duration}${context}`;
  }

  startStep(step: string): void {
    this.stepTimers.set(step, Date.now());
    this.info(`Step started: ${step}`, { step });
  }

  endStep(step: string, success = true): number {
    const start = this.stepTimers.get(step);
    const duration = start ? Date.now() - start : 0;
    this.stepTimers.delete(step);
    this.info(`Step ${success ? "completed" : "failed"}: ${step}`, { step, durationMs: duration });
    return duration;
  }

  log(level: Level, step: string, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const stepStart = this.stepTimers.get(step);
    const durationMs = stepStart ? Date.now() - stepStart : undefined;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      testName: this.testName,
      step,
      message,
      context,
      durationMs
    };
    this.entries.push(entry);

    if (level === "error") {
      this.errors.push(message);
    }

    // Console output for INFO and above
    if (LOG_ORDER[level] >= LOG_ORDER.info) {
      // eslint-disable-next-line no-console
      console.log(this.formatEntry(entry));
    }
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.log("debug", "main", msg, ctx); }
  info(msg: string, ctx?: Record<string, unknown>): void { this.log("info", "main", msg, ctx); }
  warn(msg: string, ctx?: Record<string, unknown>): void { this.log("warn", "main", msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.log("error", "main", msg, ctx); }

  /** Log with explicit step name */
  step(step: string, level: Level, msg: string, ctx?: Record<string, unknown>): void {
    this.log(level, step, msg, ctx);
  }

  flushToConsole(): void {
    for (const e of this.entries) {
      // eslint-disable-next-line no-console
      console.log(this.formatEntry(e));
    }
  }

  /** Write all log entries to file */
  flushToFile(): string {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = this.testName.replace(/[^a-zA-Z0-9-_]/g, "-");
    const filePath = path.join(this.logDir, `${safeName}-${timestamp}.log`);

    const content = this.entries.map(e => this.formatEntry(e)).join("\n");
    writeFileSync(filePath, content, "utf-8");

    return filePath;
  }

  /** Get test summary for aggregation */
  getSummary(status: "pass" | "fail" | "skip"): TestSummary {
    return {
      testName: this.testName,
      status,
      durationMs: Date.now() - this.startTime,
      entryCount: this.entries.length,
      errors: this.errors
    };
  }

  toJSON(): LogEntry[] {
    return [...this.entries];
  }
}

/** Aggregates summaries from multiple test loggers */
export class TestSummaryAggregator {
  private summaries: TestSummary[] = [];

  add(summary: TestSummary): void {
    this.summaries.push(summary);
  }

  /** Write summary JSON to test/logs/summary.json */
  flush(logDir: string = path.join(process.cwd(), "test/logs")): string {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const filePath = path.join(logDir, "summary.json");
    const aggregate = {
      timestamp: new Date().toISOString(),
      total: this.summaries.length,
      passed: this.summaries.filter(s => s.status === "pass").length,
      failed: this.summaries.filter(s => s.status === "fail").length,
      skipped: this.summaries.filter(s => s.status === "skip").length,
      totalDurationMs: this.summaries.reduce((sum, s) => sum + s.durationMs, 0),
      tests: this.summaries
    };

    writeFileSync(filePath, JSON.stringify(aggregate, null, 2), "utf-8");
    return filePath;
  }
}

export function createTestLogger(testNameOrLevel: string | Level = "info", minLevel: Level = "info"): TestLogger {
  const envLevel = process.env.TEST_LOG_LEVEL?.trim().toLowerCase();
  const hasEnvOverride = envLevel && ["debug", "info", "warn", "error"].includes(envLevel);
  const effectiveMinLevel: Level = hasEnvOverride
    ? (envLevel as Level)
    : process.env.DEBUG
      ? minLevel
      : "error";

  // Backwards compat: if first arg looks like a level, use it as level with generic name
  if (["debug", "info", "warn", "error"].includes(testNameOrLevel)) {
    return new TestLogger("test", effectiveMinLevel ?? (testNameOrLevel as Level));
  }
  return new TestLogger(testNameOrLevel, effectiveMinLevel);
}
