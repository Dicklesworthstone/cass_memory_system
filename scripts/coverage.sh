#!/usr/bin/env bash
# Run bun test with coverage and emit artifacts with consistent naming.
# Usage: LOG_DIR=/tmp/cm-coverage-123 ./scripts/coverage.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/cm-coverage-$(date +%s)}"
ARTIFACTS="$LOG_DIR/artifacts"
mkdir -p "$ARTIFACTS"

echo "Running coverage; artifacts in $LOG_DIR"

now_ms() { bun -e 'console.log(Date.now())'; }

start=$(now_ms)

# bun coverage output goes to stdout; capture and also tee to file
if bun test --coverage --timeout 60000 | tee "$ARTIFACTS/coverage.txt"; then
  status=0
else
  status=$?
fi

end=$(now_ms)
dur=$((end-start))

coverage_path="$ARTIFACTS/coverage.txt"
summary_path="$LOG_DIR/summary.json"

# Emit structured summary JSON so CI (and humans) can quickly find totals and low-coverage files.
# NOTE: Bun's text reporter (as of bun 1.3.x) reports % Funcs and % Lines (not statements/branches).
bun -e '
const fs = require("fs");

const [coveragePath, summaryPath, exitCodeStr, durationStr] = process.argv.slice(2);
const exit_code = Number(exitCodeStr ?? 0);
const duration_ms = Number(durationStr ?? 0);

let raw = "";
try {
  raw = fs.readFileSync(coveragePath, "utf8");
} catch {
  raw = "";
}

const lines = raw.split(/\r?\n/);
const allFilesLine = lines.find((l) => l.trimStart().startsWith("All files") && l.includes("|"));

const rows = [];

for (const line of lines) {
  const trimmed = line.trimEnd();
  if (!trimmed.includes("|")) continue;
  if (/^[-|\s]+$/.test(trimmed.trim())) continue;

  const parts = trimmed.split("|").map((p) => p.trim());
  if (parts.length < 3) continue;

  const file = parts[0];
  const funcs = Number(parts[1]);
  const linesPct = Number(parts[2]);

  if (!file) continue;
  if (!Number.isFinite(funcs) || !Number.isFinite(linesPct)) continue;

  const uncovered = (parts[3] ?? "").trim();
  rows.push({ file, funcs, lines: linesPct, uncovered });
}

const totals = rows.find((r) => r.file === "All files") ?? null;

const lowest_coverage = rows
  .filter((r) => r.file !== "All files")
  .sort((a, b) => (a.funcs - b.funcs) || (a.lines - b.lines) || a.file.localeCompare(b.file))
  .slice(0, 15);

const payload = {
  exit_code,
  duration_ms,
  coverage_highlights: allFilesLine ? [allFilesLine.trim()] : [],
  totals: totals
    ? { file: totals.file, funcs: totals.funcs, lines: totals.lines, uncovered: totals.uncovered || "" }
    : { file: "All files", funcs: 0, lines: 0, uncovered: "" },
  lowest_coverage,
  coverage_report: coveragePath
};

fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2));
' "$coverage_path" "$summary_path" "$status" "$dur"

echo "Done. Exit $status, duration ${dur}ms"
exit $status
