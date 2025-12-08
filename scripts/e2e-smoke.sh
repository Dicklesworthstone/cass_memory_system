#!/usr/bin/env bash
# Minimal offline smoke test for cass-memory (bead cass_memory_system-7dlg)
# Flow: init -> context (offline) -> playbook add -> mark -> playbook list
# Logs each step as JSONL plus raw stdout/stderr artifacts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CM_BIN="${CM_BIN:-$ROOT/src/cm.ts}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/cm-e2e-$(date +%s)}"
LOG_FILE="$LOG_DIR/steps.jsonl"
ARTIFACTS="$LOG_DIR/artifacts"
mkdir -p "$LOG_DIR" "$ARTIFACTS"

timestamp() { date -Iseconds; }
now_ms() { python - <<'PY'
import time; print(int(time.time()*1000))
PY
}

json_escape() {
  python - <<'PY'
import json,sys
print(json.dumps(sys.stdin.read()))
PY
}

log_step() {
  local step="$1" cmd_json="$2" exit="$3" duration_ms="$4" stdout_json="$5" stderr_json="$6"
  cat <<JSON >>"$LOG_FILE"
{"t":"$(timestamp)","step":"$step","cmd":$cmd_json,"exit":$exit,"ms":$duration_ms,"stdout":$stdout_json,"stderr":$stderr_json}
JSON
}

run_step() {
  local step="$1"; shift
  local out_file err_file
  out_file=$(mktemp)
  err_file=$(mktemp)

  local start end dur status
  start=$(now_ms)
  if "$@" >"$out_file" 2>"$err_file"; then
    status=0
  else
    status=$?
  fi
  end=$(now_ms)
  dur=$((end-start))

  # Persist artifacts
  cp "$out_file" "$ARTIFACTS/${step}.out"
  cp "$err_file" "$ARTIFACTS/${step}.err"

  # Truncate for log (4KB) and escape
  local stdout_json stderr_json cmd_json
  stdout_json=$(head -c 4000 "$out_file" | json_escape)
  stderr_json=$(head -c 4000 "$err_file" | json_escape)
  cmd_json=$(python - <<PY "$@"
import json,sys
print(json.dumps(sys.argv[1:]))
PY
)

  log_step "$step" "$cmd_json" "$status" "$dur" "$stdout_json" "$stderr_json"

  rm -f "$out_file" "$err_file"
  return $status
}

# Isolate environment; disable cass/LLM
WORKDIR=$(mktemp -d)
export HOME="$WORKDIR"
export CASS_PATH="__missing__"
unset ANTHROPIC_API_KEY

echo "Running smoke in $WORKDIR; logs: $LOG_FILE"

run_step S1_init bun run "$CM_BIN" init
run_step S2_context bun run "$CM_BIN" context "hello world" --json
run_step S3_add_rule bun run "$CM_BIN" playbook add "Always write atomically" --category io --json
ID=$(bun run "$CM_BIN" playbook list --json | node -e "import fs from 'fs'; const data=JSON.parse(fs.readFileSync(0,'utf8')); const id=(Array.isArray(data)&&data[0]?.id)||''; if(!id){process.exit(1);} console.log(id);")
if [[ -z "$ID" ]]; then
  echo "Failed to extract bullet id from playbook list" >&2
  exit 1
fi
run_step S4_mark bun run "$CM_BIN" mark "$ID" --helpful --session smoke-1 --json
run_step S5_list bun run "$CM_BIN" playbook list --json

echo "Smoke completed. Artifacts in $LOG_DIR"
