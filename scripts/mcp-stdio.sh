#!/usr/bin/env bash
# Wrapper for the MCP stdio server — ensures bun is in PATH.
# Configure in ~/.claude/settings.json:
#   "mcpServers": { "cass-memory": { "command": "/path/to/scripts/mcp-stdio.sh" } }

export PATH="$HOME/.bun/bin:$PATH"
exec bun run "$(dirname "$(dirname "$(realpath "$0")")")/src/cm.ts" mcp-stdio
