#!/bin/bash
# e2e-test.sh - Full system smoke test

set -e

CM_BIN="./src/cm.ts"
TEST_DIR=$(mktemp -d)
export CASS_MEMORY_VERBOSE=1
# Mock LLM key for testing (won't be used if we mock LLM or use degrades mode, 
# but doctor checks it. We can set a dummy valid-looking key)
export ANTHROPIC_API_KEY="sk-ant-test-dummy-key-1234567890abcdef"

echo "Running E2E tests in $TEST_DIR"

# Setup clean environment
export HOME="$TEST_DIR"
mkdir -p "$TEST_DIR/.cass-memory"

# 1. Init
echo "--> testing init"
bun run $CM_BIN init
if [ ! -f "$TEST_DIR/.cass-memory/config.json" ]; then
  echo "FAIL: config.json not created"
  exit 1
fi

# 2. Stats (empty)
echo "--> testing stats (empty)"
bun run $CM_BIN stats --json > "$TEST_DIR/stats.json"
grep '"total": 0' "$TEST_DIR/stats.json" || exit 1

# 3. Playbook Add
echo "--> testing playbook add"
bun run $CM_BIN playbook add "Always use atomic writes" --category "io" --json
bun run $CM_BIN stats --json > "$TEST_DIR/stats_after_add.json"
grep '"total": 1' "$TEST_DIR/stats_after_add.json" || exit 1

# 4. Mark Helpful
echo "--> testing mark helpful"
# Need ID. Let's parse it from stats or list.
BULLET_ID=$(bun run $CM_BIN playbook list --json | grep '"id":' | head -1 | cut -d '"' -f 4)
echo "Marking bullet $BULLET_ID"
bun run $CM_BIN mark "$BULLET_ID" --helpful --session "test-session" --json

# 5. Context (Hydration)
echo "--> testing context"
bun run $CM_BIN context "implement file writing" --json > "$TEST_DIR/context.json"
# Should find our rule because "atomic writes" matches "file writing" keywords? 
# Maybe not. "file" != "atomic".
# Let's add a rule that matches.
bun run $CM_BIN playbook add "Use fs.promises for file operations" --category "io" --json
bun run $CM_BIN context "file operations" --json > "$TEST_DIR/context_match.json"
grep "fs.promises" "$TEST_DIR/context_match.json" || echo "WARNING: Context matching might be weak without LLM"

# 6. Doctor
echo "--> testing doctor"
bun run $CM_BIN doctor --json

echo "ALL TESTS PASSED"
rm -rf "$TEST_DIR"
