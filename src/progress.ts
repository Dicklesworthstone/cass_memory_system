import { getOutputStyle, icon } from "./output.js";

export type ProgressFormat = "text" | "json";

export interface ProgressOptions {
  message: string;
  total?: number;
  showSpinner?: boolean;
  showEta?: boolean;
  format?: ProgressFormat;
  stream?: NodeJS.WritableStream;
  delayMs?: number;
  spinnerIntervalMs?: number;
  minUpdateIntervalMs?: number;
}

export interface ProgressReporter {
  update: (current: number, message?: string) => void;
  complete: (message?: string) => void;
  fail: (message: string) => void;
}

type ProgressState = {
  message: string;
  current: number;
  total?: number;
};

const UNICODE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII_SPINNER = ["-", "\\", "|", "/"] as const;

function getTerminalWidth(stream: NodeJS.WritableStream): number {
  const raw = (stream as any)?.columns;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 80;
}

function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function computeEtaMs(params: {
  startedAtMs: number;
  current: number;
  total: number;
}): number | null {
  if (params.current <= 0) return null;
  const elapsedMs = Date.now() - params.startedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const rateMsPerUnit = elapsedMs / params.current;
  if (!Number.isFinite(rateMsPerUnit) || rateMsPerUnit <= 0) return null;
  const remaining = Math.max(0, params.total - params.current);
  return Math.round(rateMsPerUnit * remaining);
}

function formatProgressLine(params: {
  frame: string;
  state: ProgressState;
  showEta: boolean;
  startedAtMs: number;
  width: number;
}): string {
  const pieces: string[] = [];

  pieces.push(`${params.frame} ${params.state.message}`);

  if (
    typeof params.state.total === "number" &&
    Number.isFinite(params.state.total) &&
    params.state.total > 0
  ) {
    const total = params.state.total;
    const current = Math.min(total, Math.max(0, Math.floor(params.state.current)));
    const percent = Math.round((current / total) * 100);
    pieces.push(`(${current}/${total}, ${percent}%)`);

    if (params.showEta) {
      const etaMs = computeEtaMs({ startedAtMs: params.startedAtMs, current, total });
      if (etaMs !== null) pieces.push(`ETA ${formatDuration(etaMs)}`);
    }
  }

  const line = pieces.join(" ");
  if (line.length <= params.width) return line;
  return line.slice(0, Math.max(0, params.width - 1)) + "…";
}

function writeJsonLine(stream: NodeJS.WritableStream, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function createProgress(options: ProgressOptions): ProgressReporter {
  const format: ProgressFormat = options.format ?? "text";
  const stream = options.stream ?? process.stderr;
  const delayMs =
    typeof options.delayMs === "number" ? Math.max(0, Math.floor(options.delayMs)) : 2000;
  const spinnerIntervalMs =
    typeof options.spinnerIntervalMs === "number"
      ? Math.max(40, Math.floor(options.spinnerIntervalMs))
      : 80;
  const minUpdateIntervalMs =
    typeof options.minUpdateIntervalMs === "number"
      ? Math.max(0, Math.floor(options.minUpdateIntervalMs))
      : 120;

  const startedAtMs = Date.now();
  const state: ProgressState = {
    message: options.message,
    current: 0,
    total: options.total,
  };

  const showEta = options.showEta ?? Boolean(state.total);
  const style = getOutputStyle();
  const frames = style.emoji ? UNICODE_SPINNER : ASCII_SPINNER;

  const isTty = Boolean((stream as any)?.isTTY);
  let shown = false;
  let finished = false;
  let spinnerIndex = 0;
  let lastUpdateAtMs = 0;
  let lastLineLen = 0;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  const canUseSpinner = format === "text" && (options.showSpinner ?? true) && isTty;

  function clearSpinnerTimers(): void {
    if (delayTimer) clearTimeout(delayTimer);
    delayTimer = null;
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = null;
  }

  function renderTextLine(force: boolean = false): void {
    if (finished) return;
    const now = Date.now();
    if (!force && now - lastUpdateAtMs < minUpdateIntervalMs) return;
    lastUpdateAtMs = now;

    const width = Math.max(20, getTerminalWidth(stream));
    const frame = canUseSpinner ? frames[spinnerIndex % frames.length] : icon("clock") || "*";
    const line = formatProgressLine({ frame, state, showEta, startedAtMs, width });

    if (!isTty) {
      stream.write(`${line}\n`);
      return;
    }

    const padding = lastLineLen > line.length ? " ".repeat(lastLineLen - line.length) : "";
    lastLineLen = line.length;
    stream.write(`\r${line}${padding}`);
  }

  function ensureShown(): void {
    if (finished || shown) return;
    shown = true;

    if (format === "json") {
      writeJsonLine(stream, {
        event: "progress",
        current: state.current,
        total: state.total,
        message: state.message,
      });
      return;
    }

    renderTextLine(true);
    if (canUseSpinner) {
      spinnerTimer = setInterval(() => {
        spinnerIndex += 1;
        renderTextLine();
      }, spinnerIntervalMs);
      if (typeof (spinnerTimer as any)?.unref === "function") {
        (spinnerTimer as any).unref();
      }
    }
  }

  delayTimer = setTimeout(() => ensureShown(), delayMs);
  if (typeof (delayTimer as any)?.unref === "function") {
    (delayTimer as any).unref();
  }

  function update(current: number, message?: string): void {
    if (finished) return;
    state.current = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
    if (typeof message === "string" && message.trim()) state.message = message.trim();

    const now = Date.now();
    if (now - startedAtMs >= delayMs) ensureShown();

    if (!shown) return;
    if (format === "json") {
      if (now - lastUpdateAtMs < minUpdateIntervalMs) return;
      lastUpdateAtMs = now;
      writeJsonLine(stream, {
        event: "progress",
        current: state.current,
        total: state.total,
        message: state.message,
      });
      return;
    }

    renderTextLine();
  }

  function complete(message?: string): void {
    if (finished) return;
    finished = true;
    clearSpinnerTimers();

    if (!shown) return;
    const finalMessage = typeof message === "string" && message.trim() ? message.trim() : "Done";

    if (format === "json") {
      writeJsonLine(stream, {
        event: "progress",
        current: state.total ?? state.current,
        total: state.total,
        message: finalMessage,
      });
      return;
    }

    const width = Math.max(20, getTerminalWidth(stream));
    const line = `${icon("success") || "✓"} ${finalMessage}`;
    const rendered = line.length <= width ? line : line.slice(0, Math.max(0, width - 1)) + "…";
    if (!isTty) {
      stream.write(`${rendered}\n`);
      return;
    }
    const padding = lastLineLen > rendered.length ? " ".repeat(lastLineLen - rendered.length) : "";
    stream.write(`\r${rendered}${padding}\n`);
  }

  function fail(message: string): void {
    if (finished) return;
    finished = true;
    clearSpinnerTimers();

    if (!shown) return;
    const finalMessage = message?.trim() ? message.trim() : "Failed";

    if (format === "json") {
      writeJsonLine(stream, {
        event: "progress",
        current: state.current,
        total: state.total,
        message: finalMessage,
      });
      return;
    }

    const width = Math.max(20, getTerminalWidth(stream));
    const line = `${icon("failure") || "✗"} ${finalMessage}`;
    const rendered = line.length <= width ? line : line.slice(0, Math.max(0, width - 1)) + "…";
    if (!isTty) {
      stream.write(`${rendered}\n`);
      return;
    }
    const padding = lastLineLen > rendered.length ? " ".repeat(lastLineLen - rendered.length) : "";
    stream.write(`\r${rendered}${padding}\n`);
  }

  return { update, complete, fail };
}
