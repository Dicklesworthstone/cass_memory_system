type Level = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: Level;
  message: string;
  meta?: Record<string, unknown>;
}

export class TestLogger {
  private entries: LogEntry[] = [];
  constructor(private minLevel: Level = "info") {}

  private shouldLog(level: Level) {
    const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    return order[level] >= order[this.minLevel];
  }

  log(level: Level, message: string, meta?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = { ts: new Date().toISOString(), level, message, meta };
    this.entries.push(entry);
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.log("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.log("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.log("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.log("error", msg, meta); }

  flushToConsole() {
    for (const e of this.entries) {
      const prefix = `[${e.ts}] ${e.level.toUpperCase()}`;
      const meta = e.meta ? ` ${JSON.stringify(e.meta)}` : "";
      // eslint-disable-next-line no-console
      console.log(`${prefix} ${e.message}${meta}`);
    }
  }

  toJSON(): LogEntry[] {
    return [...this.entries];
  }
}

export function createTestLogger(level: Level = "info") {
  return new TestLogger(level);
}
