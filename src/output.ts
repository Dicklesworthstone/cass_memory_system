export type OutputStyle = {
  color: boolean;
  emoji: boolean;
  width: number;
};

export function getOutputStyle(): OutputStyle {
  const color = process.env.NO_COLOR === undefined;
  const emoji = process.env.CASS_MEMORY_NO_EMOJI === undefined;
  const width =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : 80;

  return { color, emoji, width };
}

type IconName =
  | "chart"
  | "star"
  | "check"
  | "warning"
  | "neutral"
  | "pin"
  | "tip"
  | "brain"
  | "note"
  | "fix"
  | "test"
  | "rocket"
  | "hospital"
  | "construction"
  | "diary"
  | "target"
  | "palette"
  | "folder"
  | "trophy"
  | "thumbsUp"
  | "clock"
  | "merge"
  | "success"   // Simple checkmark for success messages
  | "failure"   // Simple X for failure messages
  | "skipped";  // Circle-slash for skipped items

const ICONS: Record<IconName, { emoji: string; plain: string }> = {
  chart: { emoji: "📊", plain: "" },
  star: { emoji: "🌟", plain: "" },
  check: { emoji: "✅", plain: "" },
  warning: { emoji: "⚠️", plain: "" },
  neutral: { emoji: "⚪", plain: "" },
  pin: { emoji: "📌", plain: "" },
  tip: { emoji: "💡", plain: "" },
  brain: { emoji: "🧠", plain: "" },
  note: { emoji: "📝", plain: "" },
  fix: { emoji: "🔧", plain: "" },
  test: { emoji: "🧪", plain: "" },
  rocket: { emoji: "🚀", plain: "" },
  hospital: { emoji: "🏥", plain: "" },
  construction: { emoji: "🏗️", plain: "" },
  diary: { emoji: "📔", plain: "" },
  target: { emoji: "🎯", plain: "" },
  palette: { emoji: "🎨", plain: "" },
  folder: { emoji: "📁", plain: "" },
  trophy: { emoji: "🏆", plain: "" },
  thumbsUp: { emoji: "👍", plain: "" },
  clock: { emoji: "🕐", plain: "" },
  merge: { emoji: "🔄", plain: "" },
  success: { emoji: "✓", plain: "[OK]" },
  failure: { emoji: "✗", plain: "[FAIL]" },
  skipped: { emoji: "⊘", plain: "[SKIP]" },
};

export function icon(name: IconName): string {
  const style = getOutputStyle();
  return style.emoji ? ICONS[name].emoji : ICONS[name].plain;
}

export function iconPrefix(name: IconName): string {
  const value = icon(name);
  return value ? `${value} ` : "";
}

export function formatTipPrefix(): string {
  const style = getOutputStyle();
  return style.emoji ? "💡 " : "Tip: ";
}

export function formatCheckStatusBadge(status: "pass" | "warn" | "fail"): string {
  const style = getOutputStyle();
  if (!style.emoji) {
    if (status === "pass") return "PASS";
    if (status === "warn") return "WARN";
    return "FAIL";
  }

  if (status === "pass") return "✅";
  if (status === "warn") return "⚠️";
  return "❌";
}

export function formatSafetyBadge(safety: "safe" | "cautious" | "manual"): string {
  const style = getOutputStyle();
  if (!style.emoji) {
    if (safety === "safe") return "SAFE";
    if (safety === "cautious") return "CAUTIOUS";
    return "MANUAL";
  }

  if (safety === "safe") return "✅";
  if (safety === "cautious") return "⚠️";
  return "📝";
}

export function formatMaturityIcon(maturity: string): string {
  const style = getOutputStyle();
  if (!style.emoji) return "";

  switch (maturity) {
    case "proven":
      return "✅";
    case "established":
      return "🔵";
    case "candidate":
      return "🟡";
    default:
      return "⚪";
  }
}

export function formatRule(
  char: string = "─",
  options: { width?: number; maxWidth?: number; minWidth?: number } = {}
): string {
  const baseWidth = options.width ?? getOutputStyle().width;
  const minWidth = options.minWidth ?? 10;
  const targetWidth =
    typeof options.maxWidth === "number" ? Math.min(baseWidth, options.maxWidth) : baseWidth;

  const width = Math.max(minWidth, Math.floor(targetWidth));
  return char.repeat(width);
}

export function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(10, Math.floor(width));
  const paragraphs = String(text).split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = words[0] ?? "";
    for (const word of words.slice(1)) {
      if ((current + " " + word).length <= maxWidth) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }

  return lines;
}

export function formatKv(
  rows: Array<{ key: string; value: string }>,
  options: { indent?: string; separator?: string; keyWidth?: number; width?: number } = {}
): string {
  const indent = options.indent ?? "";
  const separator = options.separator ?? ": ";
  const width = options.width ?? getOutputStyle().width;

  const computedKeyWidth = rows.reduce((max, row) => Math.max(max, row.key.length), 0);
  const keyWidth = Math.max(0, options.keyWidth ?? Math.min(computedKeyWidth, 24));

  const valueWidth = Math.max(10, width - indent.length - keyWidth - separator.length);
  const lines: string[] = [];

  for (const row of rows) {
    const wrapped = wrapText(row.value, valueWidth);
    const keyCell = row.key.padEnd(keyWidth);
    const lead = `${indent}${keyCell}${separator}`;

    if (wrapped.length === 0) {
      lines.push(`${lead}`);
      continue;
    }

    lines.push(`${lead}${wrapped[0]}`);
    const continuation = `${indent}${" ".repeat(keyWidth)}${separator}`;
    for (const extra of wrapped.slice(1)) {
      lines.push(`${continuation}${extra}`);
    }
  }

  return lines.join("\n");
}
