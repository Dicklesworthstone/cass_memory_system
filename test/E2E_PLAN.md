# E2E Scenario Matrix & Logging Spec (cass-memory)

## Goals
- Define minimal but meaningful end-to-end flows that exercise the CLI without relying on external services.
- Cover degraded modes (cass missing, LLM missing) to ensure graceful fallbacks.
- Standardize logging for automated runs so failures are diagnosable.

## Scenarios

### S1: Offline Smoke (happy path, no cass/LLM)
- Preconditions: `cass` not required; `ANTHROPIC_API_KEY` unset; clean HOME.
- Steps:
  1) `cm init`
  2) `cm context "hello world"` (should use playbook-only path)
  3) `cm playbook add "Always write atomically" --category io`
  4) `cm mark <bullet-id> --helpful --session smoke-1`
  5) `cm playbook list --json`
- Assertions:
  - Playbook file created under `~/.cass-memory/playbook.yaml`.
  - Context runs in degraded mode message (no cass).
  - Bullet appears in list; helpful count increments.
  - All commands exit 0.

### S2: Reflect/Validate/Curate Pipeline (fixture-backed)
- Preconditions: Provide fixture cass export files; run in temp HOME/workspace.
- Steps:
  1) Seed diary fixture(s) under `~/.cass-memory/diary/`.
  2) `cm reflect --session <fixture>` (dry-run then apply).
  3) `cm validate "Proposed rule text"` (can be stubbed to local check).
  4) `cm playbook list --json`.
- Assertions:
  - Proposed deltas recorded/applied to playbook.
  - Validation output includes acceptance/rejection reasoning.
  - No network calls to LLM when `LLM_DISABLED=1` set.

### S3: Failure Path — cass unavailable
- Preconditions: Temporarily shadow `cass` binary (PATH without it) or set `CASS_PATH=__missing__`.
- Steps:
  1) `cm context "test without cass"` --json
- Assertions:
  - Exit code 0; warning indicates cass unavailable.
  - History array empty; rules still returned if playbook present.
  - Log includes `mode: "no_cass"`.

### S4: Failure Path — LLM unavailable
- Preconditions: `ANTHROPIC_API_KEY` unset; `LLM_DISABLED=1`.
- Steps:
  1) `cm reflect --dry-run --json`
- Assertions:
  - Runs in basic extraction path; no outbound calls.
  - Log includes `mode: "no_llm"`.

### S5: Combined degradation (cass missing + LLM disabled)
- Steps: run S1 but also set `CASS_PATH=__missing__` and `LLM_DISABLED=1`.
- Assertions: Both fallbacks engaged; commands still succeed.

## Logging Specification
- Format: JSONL, one record per command step.
- Fields:
  - `timestamp` (ISO 8601)
  - `step` (S1.1, S1.2, …)
  - `command` (array of args)
  - `cwd`
  - `env_overrides` (whitelisted keys)
  - `exit_code`
  - `duration_ms`
  - `stdout` (truncated to 4KB)
  - `stderr` (truncated to 4KB)
  - `notes` (optional)
- Redaction:
  - Strip API keys/tokens using existing sanitize patterns.
  - Do not log full home paths; replace with `$HOME`.

## Artifacts & Layout
- Temp run directory: `${TMPDIR:-/tmp}/cm-e2e-<timestamp>/`
- Logs: `${run}/logs/steps.jsonl`
- Captured outputs: `${run}/artifacts/<step>.out`
- Coverage (when enabled): `${run}/coverage/`

## Pass/Fail Gates
- Any non-zero exit code → fail.
- Missing expected file or assertion → fail.
- Unexpected network call when `LLM_DISABLED=1` → fail.

## Implementation Notes
- Script runner should be Bun-friendly (`bun run test:e2e`).
- Keep scenario data small; no mocks/fakes—use real CLI and file system.
- Use `set -euo pipefail` and explicit assertions.
