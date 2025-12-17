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
now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
json_escape() { bun -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0, "utf8")));'; }
json_argv() {
  bun -e '
    const idx = process.argv.indexOf("--");
    const args = idx === -1 ? process.argv.slice(2) : process.argv.slice(idx + 1);
    process.stdout.write(JSON.stringify(args));
  ' -- "$@"
}

choose_free_port() {
  bun -e '
    const net = require("net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => process.stdout.write(String(port)));
    });
  '
}

write_tools_list_reqres() {
  local base_url="$1"
  local out_file="$2"
  bun -e '
    const fs = require("fs");
    const http = require("http");
    const { URL } = require("url");

    const baseUrl = process.argv[2];
    const outFile = process.argv[3];
    const url = new URL(baseUrl);

    const requestObj = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const body = JSON.stringify(requestObj);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          const record = {
            url: baseUrl,
            request: requestObj,
            status: res.statusCode,
            response: parsed,
            responseRaw: data.slice(0, 4000),
            recordedAt: new Date().toISOString(),
          };
          fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
          if (res.statusCode !== 200) process.exit(1);
          if (!parsed || parsed.jsonrpc !== "2.0") process.exit(1);
          process.exit(0);
        });
      }
    );

    req.on("error", () => process.exit(1));
    req.setTimeout(750, () => {
      try { req.destroy(); } catch {}
      process.exit(1);
    });
    req.write(body);
    req.end();
  ' "$base_url" "$out_file"
}

assert_json_has_success() {
  local file="$1"
  bun -e '
    const fs=require("fs");
    const obj=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!obj || typeof obj.success !== "boolean") {
      console.error("Missing boolean `success` in JSON output");
      process.exit(1);
    }
  ' "$file"
}

assert_json_success() {
  local file="$1"
  bun -e '
    const fs=require("fs");
    const obj=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!obj || obj.success !== true) {
      console.error("Expected `success: true` in JSON output");
      process.exit(1);
    }
  ' "$file"
}

assert_json_failure() {
  local file="$1"
  bun -e '
    const fs=require("fs");
    const obj=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!obj || obj.success !== false) {
      console.error("Expected `success: false` in JSON output");
      process.exit(1);
    }
  ' "$file"
}

log_step() {
  local step="$1" cmd_json="$2" exit="$3" duration_ms="$4" stdout_json="$5" stderr_json="$6"
  cat <<JSON >>"$LOG_FILE"
{"t":"$(timestamp)","step":"$step","cmd":$cmd_json,"exit":$exit,"ms":$duration_ms,"stdout":$stdout_json,"stderr":$stderr_json}
JSON
}

run_step() {
  local step="$1"; shift
  local out_file="$ARTIFACTS/${step}.out"
  local err_file="$ARTIFACTS/${step}.err"

  local start end dur status
  start=$(now_ms)
  if "$@" >"$out_file" 2>"$err_file"; then
    status=0
  else
    status=$?
  fi
  end=$(now_ms)
  dur=$((end-start))

  # Truncate for log (4KB) and escape
  local stdout_json stderr_json cmd_json
  stdout_json=$(head -c 4000 "$out_file" | json_escape)
  stderr_json=$(head -c 4000 "$err_file" | json_escape)
  cmd_json=$(json_argv "$@")

  log_step "$step" "$cmd_json" "$status" "$dur" "$stdout_json" "$stderr_json"
  return $status
}

run_expect_fail() {
  local step="$1"; shift
  if run_step "$step" "$@"; then
    echo "Expected failure but command succeeded: $step" >&2
    return 1
  fi
  return 0
}

extract_first_bullet_id() {
  local file="$1"
  bun -e '
    const fs = require("fs");
    const obj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const bullets =
      Array.isArray(obj) ? obj :
      Array.isArray(obj.bullets) ? obj.bullets :
      Array.isArray(obj.data?.bullets) ? obj.data.bullets :
      Array.isArray(obj.data) ? obj.data :
      [];
    const id = bullets[0]?.id;
    if (!id) process.exit(1);
    process.stdout.write(String(id));
  ' "$file"
}

run_serve_contract() {
  local step="$1"
  local port
  port="$(choose_free_port)"

  local server_out="$ARTIFACTS/${step}.server.out"
  local server_err="$ARTIFACTS/${step}.server.err"
  local reqres_file="$ARTIFACTS/${step}.reqres.json"

  local start end dur status
  start=$(now_ms)

  local cmd=(bun run "$CM_BIN" serve --host 127.0.0.1 --port "$port")
  "${cmd[@]}" >"$server_out" 2>"$server_err" &
  local pid=$!

  local base_url="http://127.0.0.1:${port}"
  local ok=0
  for _ in {1..50}; do
    if write_tools_list_reqres "$base_url" "$reqres_file"; then
      ok=1
      break
    fi
    sleep 0.1
  done

  status=0
  if [[ $ok -ne 1 ]]; then
    status=1
  fi

  # Bounded shutdown (best-effort)
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true

  end=$(now_ms)
  dur=$((end-start))

  local stdout_json stderr_json cmd_json
  stdout_json=$(head -c 4000 "$server_out" | json_escape)
  stderr_json=$(head -c 4000 "$server_err" | json_escape)
  cmd_json=$(json_argv "${cmd[@]}")
  log_step "$step" "$cmd_json" "$status" "$dur" "$stdout_json" "$stderr_json"

  return $status
}

# Isolate environment; disable cass/LLM
WORKDIR=$(mktemp -d)
export HOME="$WORKDIR"
export CASS_PATH="__missing__"
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY
unset GOOGLE_GENERATIVE_AI_API_KEY

echo "Running smoke in $WORKDIR; logs: $LOG_FILE"

run_step S1_init bun run "$CM_BIN" init --json
assert_json_success "$ARTIFACTS/S1_init.out"

run_step S2_doctor bun run "$CM_BIN" doctor --json
assert_json_has_success "$ARTIFACTS/S2_doctor.out"

run_step S3_context bun run "$CM_BIN" context "hello world" --json
assert_json_success "$ARTIFACTS/S3_context.out"

run_step S4_add_rule bun run "$CM_BIN" playbook add "Always write atomically" --category io --json
assert_json_success "$ARTIFACTS/S4_add_rule.out"

run_step S5_list bun run "$CM_BIN" playbook list --json
assert_json_success "$ARTIFACTS/S5_list.out"

ID=$(extract_first_bullet_id "$ARTIFACTS/S5_list.out" || true)
if [[ -z "${ID:-}" ]]; then
  echo "Failed to extract bullet id from $ARTIFACTS/S5_list.out" >&2
  exit 1
fi

run_step S6_mark bun run "$CM_BIN" mark "$ID" --helpful --session smoke-1 --json
assert_json_success "$ARTIFACTS/S6_mark.out"

run_step S7_why bun run "$CM_BIN" why "$ID" --json
assert_json_has_success "$ARTIFACTS/S7_why.out"

run_step S8_stats bun run "$CM_BIN" stats --json
assert_json_success "$ARTIFACTS/S8_stats.out"

run_step S9_top bun run "$CM_BIN" top --json
assert_json_success "$ARTIFACTS/S9_top.out"

run_step S10_similar bun run "$CM_BIN" similar "atomically" --json
assert_json_success "$ARTIFACTS/S10_similar.out"

run_step S11_usage bun run "$CM_BIN" usage --json
assert_json_success "$ARTIFACTS/S11_usage.out"

run_step S12_starters bun run "$CM_BIN" starters --json
assert_json_success "$ARTIFACTS/S12_starters.out"

run_step S13_quickstart bun run "$CM_BIN" quickstart --json
assert_json_has_success "$ARTIFACTS/S13_quickstart.out"

run_step S14_privacy bun run "$CM_BIN" privacy status --json
assert_json_success "$ARTIFACTS/S14_privacy.out"

run_step S15_onboard_status bun run "$CM_BIN" onboard status --json
assert_json_success "$ARTIFACTS/S15_onboard_status.out"

run_step S16_onboard_gaps bun run "$CM_BIN" onboard gaps --json
assert_json_success "$ARTIFACTS/S16_onboard_gaps.out"

run_step S17_onboard_prompt bun run "$CM_BIN" onboard prompt --json
assert_json_success "$ARTIFACTS/S17_onboard_prompt.out"

run_step S18_outcome bun run "$CM_BIN" outcome success "$ID" --session smoke-1 --json
assert_json_has_success "$ARTIFACTS/S18_outcome.out"

run_step S19_outcome_apply bun run "$CM_BIN" outcome-apply --json
assert_json_success "$ARTIFACTS/S19_outcome_apply.out"

run_step S20_stale bun run "$CM_BIN" stale --json
assert_json_success "$ARTIFACTS/S20_stale.out"

run_step S21_project bun run "$CM_BIN" project --format raw

run_serve_contract S22_serve

run_step S23_forget bun run "$CM_BIN" forget "$ID" --reason "smoke test" --json
assert_json_success "$ARTIFACTS/S23_forget.out"

run_step S24_undo bun run "$CM_BIN" undo "$ID" --json
assert_json_success "$ARTIFACTS/S24_undo.out"

run_expect_fail S25_audit bun run "$CM_BIN" audit --days 1 --json
assert_json_failure "$ARTIFACTS/S25_audit.out"

run_expect_fail S26_validate bun run "$CM_BIN" validate "Use transactions for writes" --json
assert_json_failure "$ARTIFACTS/S26_validate.out"

run_step S27_reflect bun run "$CM_BIN" reflect --days 1 --json
assert_json_success "$ARTIFACTS/S27_reflect.out"

echo "Smoke completed. Artifacts in $LOG_DIR"
