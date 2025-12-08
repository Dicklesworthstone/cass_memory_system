# Contributing to cass-memory

## 1) Development setup
- Prerequisites: Bun ≥1.0, Node.js 18+, Git
- Clone: `git clone <repo>` then `cd cass_memory_system`
- Install deps: `bun install`
- Dev entrypoints: `bun run dev` (future) or run individual commands with `bun run src/cm.ts -- <cmd>`

## 2) Running tests
- Unit tests: `bun test`
- Integration tests: `bun test --filter integration` (when added)
- Coverage: `bun test --coverage`
- Typecheck: `bun run typecheck`

## 3) Code style
- TypeScript strict mode is enabled; no implicit any.
- Use existing formatting (Prettier-equivalent); keep imports ESM with `.js` suffix for local modules.
- Avoid console.log in production code; use shared logger helpers when available.

## 4) PR process
- Branch from `main`; use feature branches.
- Add/adjust tests for new behavior.
- Ensure `bun run typecheck` and `bun test` pass.
- Update docs (README/AGENTS.md/CONTRIBUTING.md) when behavior or commands change.
- PR description: what changed, why, testing done.

## 5) Issue templates
- Bug reports: steps to reproduce, expected/actual, logs, versions.
- Feature requests: use-case, proposed shape, acceptance criteria.
- Docs: what’s unclear or missing; suggested wording if possible.

## 6) Architecture overview (quick)
- Three-layer ACE pipeline: Generator (context) → Reflector (deltas) → Curator (deterministic merge).
- Storage: playbook YAML in `~/.cass-memory/` and `.cass/` (repo-level); diaries in `~/.cass-memory/diary`.
- CLI: `cm` (cass-memory) commands under `src/commands`.
- Keep schemas single-sourced in `src/types.ts`; other modules must import from there to avoid drift.
