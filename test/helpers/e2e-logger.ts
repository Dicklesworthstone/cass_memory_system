import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

type Level = "debug" | "info" | "warn" | "error";

type LogEvent =
  | {
      ts: string;
      level: Level;
      kind: "step";
      message: string;
      data?: Record<string, unknown>;
    }
  | {
      ts: string;
      level: Level;
      kind: "snapshot";
      name: string;
      value: string;
    }
  | {
      ts: string;
      level: Level;
      kind: "timer";
      name: string;
      action: "start" | "end";
      durationMs?: number;
    }
  | {
      ts: string;
      level: Level;
      kind: "repro";
      command: string;
    };

export interface E2ELoggerOptions {
  /** Minimum level to emit in live mode (default: "info"). */
  liveMinLevel?: Level;
  /** If true, emit logs during the test; otherwise, only dump on failure. */
  live?: boolean;
  /** Directory for writing artifacts (default: test/logs). */
  logDir?: string;
  /** Truncate snapshots to this many chars (default: 10_000). */
  maxSnapshotChars?: number;
  /** Write JSONL artifact on failure (default: true). */
  writeFileOnFailure?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}… (+${remaining} chars)`;
}

function safeStringify(value: unknown, maxChars: number): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return "[Circular]";
          seen.add(v as object);
        }
        return v;
      },
      2
    );
    return truncate(json, maxChars);
  } catch {
    return truncate(inspect(value, { depth: 6, maxArrayLength: 50 }), maxChars);
  }
}

function safeFileStem(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-").slice(0, 80) || "e2e";
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class E2ELogger {
  private readonly events: LogEvent[] = [];
  private readonly timers = new Map<string, number>();
  private reproCommand: string | null = null;
  private readonly startedAt = Date.now();
  private stepIndex = 0;

  private readonly options: Required<E2ELoggerOptions>;

  constructor(
    private readonly testName: string,
    options: E2ELoggerOptions = {}
  ) {
    const envLevel = (process.env.TEST_LOG_LEVEL || "").trim().toLowerCase();
    const liveMinLevel = (options.liveMinLevel ||
      (["debug", "info", "warn", "error"].includes(envLevel) ? (envLevel as Level) : "info")) as Level;

    this.options = {
      liveMinLevel,
      live: options.live ?? Boolean(process.env.DEBUG),
      logDir: options.logDir ?? path.join(process.cwd(), "test", "logs"),
      maxSnapshotChars: options.maxSnapshotChars ?? 10_000,
      writeFileOnFailure: options.writeFileOnFailure ?? true,
    };
  }

  private push(event: LogEvent): void {
    this.events.push(event);
    if (!this.options.live) return;
    if (LEVEL_ORDER[event.level] < LEVEL_ORDER[this.options.liveMinLevel]) return;
    // eslint-disable-next-line no-console
    console.log(this.formatEvent(event));
  }

  private formatEvent(event: LogEvent): string {
    const prefix = `[${event.ts}] [${event.level.toUpperCase()}] [${this.testName}]`;
    if (event.kind === "step") {
      const data = event.data ? `\n  data: ${safeStringify(event.data, 2000)}` : "";
      return `${prefix} ${event.message}${data}`;
    }
    if (event.kind === "snapshot") {
      return `${prefix} SNAPSHOT ${event.name} (${event.value.length} chars)`;
    }
    if (event.kind === "timer") {
      if (event.action === "start") return `${prefix} TIMER start ${event.name}`;
      return `${prefix} TIMER end ${event.name}${typeof event.durationMs === "number" ? ` (${Math.round(event.durationMs)}ms)` : ""}`;
    }
    return `${prefix} REPRO ${event.command}`;
  }

  step(message: string, data?: Record<string, unknown>): void {
    this.stepIndex++;
    this.push({
      ts: nowIso(),
      level: "info",
      kind: "step",
      message: `${this.stepIndex}. ${message}`,
      data,
    });
  }

  snapshot(name: string, value: unknown): void {
    const valueStr = safeStringify(value, this.options.maxSnapshotChars);
    this.push({
      ts: nowIso(),
      level: "debug",
      kind: "snapshot",
      name,
      value: valueStr,
    });
  }

  startTimer(name: string): void {
    const key = name.trim();
    if (!key) return;
    this.timers.set(key, performance.now());
    this.push({ ts: nowIso(), level: "debug", kind: "timer", name: key, action: "start" });
  }

  endTimer(name: string): number {
    const key = name.trim();
    const start = this.timers.get(key);
    const durationMs = typeof start === "number" ? performance.now() - start : 0;
    this.push({
      ts: nowIso(),
      level: "info",
      kind: "timer",
      name: key,
      action: "end",
      durationMs,
    });
    return durationMs;
  }

  setRepro(command: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    this.reproCommand = cmd;
    this.push({ ts: nowIso(), level: "info", kind: "repro", command: cmd });
  }

  toJSON(): { testName: string; startedAt: string; durationMs: number; events: LogEvent[]; repro?: string } {
    return {
      testName: this.testName,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
      events: [...this.events],
      repro: this.reproCommand || undefined,
    };
  }

  async writeArtifact(): Promise<string> {
    await mkdir(this.options.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${safeFileStem(this.testName)}-${ts}.jsonl`;
    const filePath = path.join(this.options.logDir, fileName);
    const jsonl = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, jsonl, "utf-8");
    return filePath;
  }

  async dumpFailure(error: unknown): Promise<void> {
    const header = `\n===== E2E FAILURE: ${this.testName} =====`;
    // eslint-disable-next-line no-console
    console.error(header);

    if (this.reproCommand) {
      // eslint-disable-next-line no-console
      console.error(`REPRO: ${this.reproCommand}`);
    }

    // eslint-disable-next-line no-console
    console.error(`DURATION: ${Date.now() - this.startedAt}ms`);

    // eslint-disable-next-line no-console
    console.error("\nEVENTS:");
    for (const e of this.events) {
      // eslint-disable-next-line no-console
      console.error(this.formatEvent(e));
      if (e.kind === "snapshot") {
        // eslint-disable-next-line no-console
        console.error(`  ${e.name}: ${e.value}`);
      }
    }

    // eslint-disable-next-line no-console
    console.error("\nERROR:");
    if (error instanceof Error) {
      // eslint-disable-next-line no-console
      console.error(error.stack || error.message);
    } else {
      // eslint-disable-next-line no-console
      console.error(String(error));
    }

    if (this.options.writeFileOnFailure) {
      try {
        const artifact = await this.writeArtifact();
        // eslint-disable-next-line no-console
        console.error(`\nARTIFACT: ${artifact}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`(failed to write artifact) ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // eslint-disable-next-line no-console
    console.error("===== END FAILURE LOG =====\n");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      await this.dumpFailure(err);
      throw err;
    }
  }
}

export function createE2ELogger(testName: string, options: E2ELoggerOptions = {}): E2ELogger {
  return new E2ELogger(testName, options);
}

