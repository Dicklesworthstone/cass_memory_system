# Changelog

All notable changes to **cass-memory** (`cm`) are documented in this file.

- Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
- Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
- Commit links: [github.com/Dicklesworthstone/cass_memory_system](https://github.com/Dicklesworthstone/cass_memory_system)

---

## [Unreleased] (since v0.2.3 -- 2026-01-07)

### LLM Provider Support

- **Ollama as fourth LLM provider** -- full local model inference support, covering `getModel`, `doctor`, and availability checks ([d5766ed](https://github.com/Dicklesworthstone/cass_memory_system/commit/d5766ed83616b941b4d9c2e4f717358c31351d4f))
- Fix `OLLAMA_HOST` env var handling: consistent usage across `getModel` and `doctor`, env vars take precedence over Zod defaults ([de1fb2a](https://github.com/Dicklesworthstone/cass_memory_system/commit/de1fb2a63d734f041ba6fa6fa3f5ebe95e96c3ba), [b7ee0dc](https://github.com/Dicklesworthstone/cass_memory_system/commit/b7ee0dc676b90720f3bfb09d644a150f334ba0f4))
- Deduplicate `LLMProvider` type and fix Ollama availability check ([2bd55b3](https://github.com/Dicklesworthstone/cass_memory_system/commit/2bd55b358d7d62c964d175f65c8d25ea27c81b1b))
- Expand configuration options and LLM provider refinements, configurable `baseUrl` support ([adbcce4](https://github.com/Dicklesworthstone/cass_memory_system/commit/adbcce434eceeed710f4264cf1b49aa82c87b430))

### Reflection Pipeline

- **Auto-record rule outcomes** from processed sessions -- the reflector now automatically tracks which playbook rules were applied and whether they helped ([80a4631](https://github.com/Dicklesworthstone/cass_memory_system/commit/80a4631beb3e8fa0b3d92499cde9a420153962fe))
- Reduce auto-outcome false positives and double-counting ([165bf64](https://github.com/Dicklesworthstone/cass_memory_system/commit/165bf6412cc2461d78e81d3e7c019a23161dd0f5))
- Filter out internal/auto-generated session types during reflection ([1ae63e6](https://github.com/Dicklesworthstone/cass_memory_system/commit/1ae63e6cbf7dcb091d4f0df256e9721c14489397))
- Ensure reflections directory exists before lock acquisition ([7c4ef37](https://github.com/Dicklesworthstone/cass_memory_system/commit/7c4ef374d83bf17e5f22f2c76af6c1b1c7949d1f))

### TOON Output Format

- **TOON format** for token-efficient agent output -- reduces token cost for LLM consumers of `cm` output ([7dd4424](https://github.com/Dicklesworthstone/cass_memory_system/commit/7dd44248997002d53870c579e5ddea8be5043247))
- Add `--format toon` and stats to `cm` structured outputs ([5e4356a](https://github.com/Dicklesworthstone/cass_memory_system/commit/5e4356ac20aa06849d98a64f8c10cac6b25e3f4f))
- TOON output support for `doctor` command ([1ca0cf7](https://github.com/Dicklesworthstone/cass_memory_system/commit/1ca0cf76fb2ab86b23a2751009bbbee5804015ed))
- Honor `--format=toon` and `--format=json` consistently in global error handling ([9bab75f](https://github.com/Dicklesworthstone/cass_memory_system/commit/9bab75f4898323f2268b9c70bf3e95b10d3cc979), [65ae3dc](https://github.com/Dicklesworthstone/cass_memory_system/commit/65ae3dc3f78d1787ad9accbb1cbffd63c35b84d3))

### Context and Scoring

- Honor `minRelevanceScore` config and fix misleading score labels in context output ([4e8193b](https://github.com/Dicklesworthstone/cass_memory_system/commit/4e8193bd6a52802a74c25f309d5b5b64654489e1))
- Exclude embedding vectors from JSON output ([19ce9ee](https://github.com/Dicklesworthstone/cass_memory_system/commit/19ce9ee28508d67e60d0b7cd28485e5e3f00cd1a))
- Correct workspace bullet filtering logic ([46eeedd](https://github.com/Dicklesworthstone/cass_memory_system/commit/46eeeddf92297abade848d95d8d28870d2d31262))
- Respect `--format` for structured error output in context command ([9b5921b](https://github.com/Dicklesworthstone/cass_memory_system/commit/9b5921b8c2729a19c00dd57bb720da5cc7344a01))

### Playbook Management

- Add `--repo` flag to `playbook add` command for workspace-level imports ([9c2b3b5](https://github.com/Dicklesworthstone/cass_memory_system/commit/9c2b3b5a3a1da9b7a41d0754282f08b76f50fa8d))
- Show target playbook in add success messages ([29c3e04](https://github.com/Dicklesworthstone/cass_memory_system/commit/29c3e043c87e8975174319a42808eee298948c70))

### MCP Server

- Wrap `tools/call` responses in MCP-required content array ([837a460](https://github.com/Dicklesworthstone/cass_memory_system/commit/837a460634df34bf8f4791f38cc2b97c72edc37e))
- Fix MCP server config docs to show HTTP transport instead of stdio ([a08ac87](https://github.com/Dicklesworthstone/cass_memory_system/commit/a08ac87eb86b44562686df24fabc9b7fc8b06c9f))

### CI and Distribution

- Add ACFS notification workflow for installer changes ([c6e5cba](https://github.com/Dicklesworthstone/cass_memory_system/commit/c6e5cba508ad35e44d99ac666c2e2a85f71b92ee))
- Improve GitHub Actions workflows with caching, timeouts, and consolidation ([113309d](https://github.com/Dicklesworthstone/cass_memory_system/commit/113309d34e569c3b507ab3893d93572487b18946))
- ACFS checksum dispatch and update notification workflow ([945cd0d](https://github.com/Dicklesworthstone/cass_memory_system/commit/945cd0d14cf0e8d541d5dce82aebf99b3e6599cb), [2a09ab8](https://github.com/Dicklesworthstone/cass_memory_system/commit/2a09ab8989c0a3a7aa55481fd3da1be0d38fb4bf))
- Prioritize Homebrew/Scoop installation methods in docs ([a30c71f](https://github.com/Dicklesworthstone/cass_memory_system/commit/a30c71f730eddcd6fa62da4fdbee2fb2cb6db84e))
- Skip ACFS dispatch when token missing ([08696f6](https://github.com/Dicklesworthstone/cass_memory_system/commit/08696f6ad67560dd88380529a77d72741f6399b3))

### Guard and Trauma System

- Improve guard script invocation and error handling ([7ec97d8](https://github.com/Dicklesworthstone/cass_memory_system/commit/7ec97d85f9a9ac9478e779daa4a7553c322350c0))
- Update guard command implementation ([5eb8b2f](https://github.com/Dicklesworthstone/cass_memory_system/commit/5eb8b2fb77e62a434f1e54f0a2634fc9b0142fd3))

### Documentation and Licensing

- Update license to MIT with OpenAI/Anthropic Rider ([470d3fd](https://github.com/Dicklesworthstone/cass_memory_system/commit/470d3fd5fabb26eab76252f92fa09f5907afa7dd))
- Add WebP illustration and GitHub social preview image ([880a6e6](https://github.com/Dicklesworthstone/cass_memory_system/commit/880a6e66825ff552973ef9a54a0646878f870ad1), [599b0b8](https://github.com/Dicklesworthstone/cass_memory_system/commit/599b0b8f120075bef513923f6454f820c7fde342))
- Add Claude Code SKILL.md for automatic capability discovery ([977a008](https://github.com/Dicklesworthstone/cass_memory_system/commit/977a00859267ea531d889ac592210e6257b74e17))
- Add cm agent quickstart documentation ([b0b005f](https://github.com/Dicklesworthstone/cass_memory_system/commit/b0b005feb3651b7c383aff391d4bc348391a5347))
- Add specific error handling for missing FTS table ([64d0feb](https://github.com/Dicklesworthstone/cass_memory_system/commit/64d0feb5efe28a5ee3bb4445d2f3344d21f252d3))

### Testing

- Comprehensive tests for configurable baseUrl support ([9cb002b](https://github.com/Dicklesworthstone/cass_memory_system/commit/9cb002bd766ef508bf9986205923da5ff092c742))
- Expand test coverage for serve.ts, doctor.ts, init, project, stale, privacy, guard, diary, and onboard commands ([51bafb0](https://github.com/Dicklesworthstone/cass_memory_system/commit/51bafb06ad75b75a498c3f3a109c1d9163ffdd24), [0e55ab5](https://github.com/Dicklesworthstone/cass_memory_system/commit/0e55ab55482e26f07f151f30ae61353395550628), [5590957](https://github.com/Dicklesworthstone/cass_memory_system/commit/5590957130c01c808d11949a6bf0b944194db31d), [e19371a](https://github.com/Dicklesworthstone/cass_memory_system/commit/e19371a2522540b9f073db4ac4295dadaf6fb5b0), [d192e9a](https://github.com/Dicklesworthstone/cass_memory_system/commit/d192e9acc631248f94acc6c3e0063a5ba1a9e76c))
- Improve CLI argument ordering for command safety ([f4f878c](https://github.com/Dicklesworthstone/cass_memory_system/commit/f4f878ce6058db0f8e2fb03a0f6929bd57e51c20))

---

## [v0.2.3] -- 2026-01-07

**Release**: [cass-memory v0.2.3](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.2.3) | Tag: [`v0.2.3`](https://github.com/Dicklesworthstone/cass_memory_system/commit/79241402f179b8bf6ae5bb57cf3166a17335d8e9) | Published: 2026-01-07

### Security and Safety

- Require explicit consent for guard installation during `cm init` ([13260e3](https://github.com/Dicklesworthstone/cass_memory_system/commit/13260e32803b7223d0925b0d9f7e05d64d53eba6))
- Avoid static secret scanner false positives in source code ([bfaa57b](https://github.com/Dicklesworthstone/cass_memory_system/commit/bfaa57b4d4acba37b9a0c82c3c6309c21829a148))

### Content Handling

- Handle nested array content in `coerceContent`/`coerceRawContent` ([701c4db](https://github.com/Dicklesworthstone/cass_memory_system/commit/701c4dbdc621757101dd6e31d6a8698598076e3a))
- Handle array content blocks in diary session formatting ([2e8d31b](https://github.com/Dicklesworthstone/cass_memory_system/commit/2e8d31bd20de40c028df6ea36c1e5c17e55bbc39))

### Performance

- Optimize Map update pattern to reduce redundant lookups ([a204602](https://github.com/Dicklesworthstone/cass_memory_system/commit/a20460263a5237568154451beea8cf817c22f1e4))

### Documentation

- Expand README with undocumented features ([6eb91ba](https://github.com/Dicklesworthstone/cass_memory_system/commit/6eb91bac5717ccb340f57612f4dae5e711a64ff4))
- Add 'partial' to outcome command help text ([a7d94d4](https://github.com/Dicklesworthstone/cass_memory_system/commit/a7d94d426d95a72599df56d8fef18c5675aa7561))

### Testing

- Add E2E tests for undo, audit, validate, diary, onboard, outcome, and serve commands ([b93cdfa](https://github.com/Dicklesworthstone/cass_memory_system/commit/b93cdfad740480421a0653f26e87e800a0dada10), [dd68326](https://github.com/Dicklesworthstone/cass_memory_system/commit/dd68326282d371ee156b13cb245536e9badd3dc9), [d7059ea](https://github.com/Dicklesworthstone/cass_memory_system/commit/d7059ea4f8b32d4b2b3680f2e4ac51c0a0dc7568), [fbc1743](https://github.com/Dicklesworthstone/cass_memory_system/commit/fbc1743051a20e29693be539be78867d5d72801a))
- Add unit tests for `validateDelta`, `examples.ts`, `infoCommand`, Codex CLI JSONL format handling ([cc9006f](https://github.com/Dicklesworthstone/cass_memory_system/commit/cc9006f44f49dae899d2aa262cbf1452216d8bf8), [88bf9f1](https://github.com/Dicklesworthstone/cass_memory_system/commit/88bf9f1adc87cd5faea37dfc15a54164d373051c), [d6f57d9](https://github.com/Dicklesworthstone/cass_memory_system/commit/d6f57d98bcfa0d9be32c544353c5cccc08a74b3f), [72948cf](https://github.com/Dicklesworthstone/cass_memory_system/commit/72948cff1de6aad946ac868308e74fb8b70b2d18))
- Strengthen validate E2E test assertions ([445b379](https://github.com/Dicklesworthstone/cass_memory_system/commit/445b379e4bfad59fff2c031584afc2b78c5ed4da))

### Bug Fixes

- Validate optimization and test updates ([3a1b9a4](https://github.com/Dicklesworthstone/cass_memory_system/commit/3a1b9a42c3ac21e2af43da546177e43d5366966d))
- Restore contribution policy to README ([3ab4325](https://github.com/Dicklesworthstone/cass_memory_system/commit/3ab43253ec5780ade9a6c38fdc7f7f6116577180))
- Multiple small improvements across modules ([e108758](https://github.com/Dicklesworthstone/cass_memory_system/commit/e108758a260fb1b91e23ecdc72cc8708a0736e7b))

---

## [v0.2.2] -- 2026-01-05

**Release**: [cass-memory v0.2.2](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.2.2) | Tag: [`v0.2.2`](https://github.com/Dicklesworthstone/cass_memory_system/commit/6fa8953fb27082afb791b87e9faa37efcec1975d) | Published: 2026-01-05

A focused patch release improving the installation experience.

### Installer Reliability

- **Redirect-based version resolution** -- the installer now uses GitHub's redirect behavior (`/releases/latest` -> `/releases/tag/vX.Y.Z`) instead of the API, eliminating rate limiting (60/hr for unauthenticated) and cross-platform JSON parsing issues ([c694251](https://github.com/Dicklesworthstone/cass_memory_system/commit/c694251a83a0f7d78cc77fd11df79e536d24b6cc))
- **Fixed concurrent install protection** -- the lock file path was incorrectly using PID expansion (`$$`), causing each installer process to create its own unique lock file; now uses static `/tmp/cass-memory-install.lock` ([6bfdd6a](https://github.com/Dicklesworthstone/cass_memory_system/commit/6bfdd6a247afca1d15105cb7502a7bc6d2da24dc))

### Documentation

- Move installation comment outside code block in README for better formatting ([184951c](https://github.com/Dicklesworthstone/cass_memory_system/commit/184951cd7adcef485e3fbeb3cd1a3f71df25dd24))

---

## [v0.2.1] -- 2026-01-02

**Release**: [cass-memory v0.2.1](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.2.1) | Tag: [`v0.2.1`](https://github.com/Dicklesworthstone/cass_memory_system/commit/afa4e6105151865cf7620ec7b4d79d60038aa302) | Published: 2026-01-03

A major stabilization release that fixed critical session discovery bugs, introduced the Project Hot Stove trauma/guard system, added dependency injection for testing, and dramatically expanded test coverage.

### Critical Bug Fixes (Session Discovery)

- **Resolve `timeline.groups.flatMap` error** -- fixes `cm reflect` failing when cass timeline returns groups as an object instead of an array; now uses `--since Nd` format instead of `--days N` ([7390a7b](https://github.com/Dicklesworthstone/cass_memory_system/commit/7390a7b8868c04e6cb415d68a623ec63be4e98b9))
- Add String coercion for timeline timestamps to prevent type errors ([287a5c6](https://github.com/Dicklesworthstone/cass_memory_system/commit/287a5c6db7110819ae16a872371cb135fe1c4667))
- Improve Codex CLI session parsing: handle nested `payload.content` format, fallback to direct JSONL parsing when cass returns >50% UNKNOWN entries ([7390a7b](https://github.com/Dicklesworthstone/cass_memory_system/commit/7390a7b8868c04e6cb415d68a623ec63be4e98b9))
- Add size limit for fallback session parsing to prevent OOM ([3b88720](https://github.com/Dicklesworthstone/cass_memory_system/commit/3b8872000344a5a9357d4d603ba691aee9dbe4e2))

### Project Hot Stove (Trauma/Guard System)

- **Implement trauma/guard system** for detecting and preventing harmful patterns in agent sessions ([22b4f09](https://github.com/Dicklesworthstone/cass_memory_system/commit/22b4f099cda007f17f4686c791fb57e026605903))
- Add `heal`, `remove`, and `import` trauma commands for managing the pattern database ([d3f9a95](https://github.com/Dicklesworthstone/cass_memory_system/commit/d3f9a95169c8bb568fd5f7f8c04129bac456e010))
- Add git pre-commit hook for trauma pattern detection ([79386e3](https://github.com/Dicklesworthstone/cass_memory_system/commit/79386e38aa0ed965372a212e0905c8308156b6f3))
- Add python3 availability check before hook installation ([abb2daf](https://github.com/Dicklesworthstone/cass_memory_system/commit/abb2daf35e2952767bcd940bde335bc50340feb2))

### Concurrency and Robustness

- Add UUID-based lock ownership verification to prevent race conditions ([2fcf92e](https://github.com/Dicklesworthstone/cass_memory_system/commit/2fcf92ed43a5e545637e95d1dd4b27af4c26645b))
- Add file locking for concurrent privacy config access ([0fe7523](https://github.com/Dicklesworthstone/cass_memory_system/commit/0fe752346fe43d5c1680c29966e728aa7b182c73))
- Add signal handlers and model loading locks for graceful shutdown ([a936c2e](https://github.com/Dicklesworthstone/cass_memory_system/commit/a936c2eb8e182c1928e73febb4552cdea0b8d893))
- Wrap `savePlaybook` calls in `withLock` for consistency ([07cb72a](https://github.com/Dicklesworthstone/cass_memory_system/commit/07cb72ac2d1c3cf8df175a74497cfd1d9d2f9e4b))
- Internalize locking for blocked log operations in playbook ([e070074](https://github.com/Dicklesworthstone/cass_memory_system/commit/e0700740b1da4efc58cdf87632f335e615ab09cb))
- Add locking for blocked log operations in undo ([a32e18d](https://github.com/Dicklesworthstone/cass_memory_system/commit/a32e18db25c19c8a08b824cb282e294d936499ce))
- Use atomic overwrite instead of delete for onboard state reset ([bc42639](https://github.com/Dicklesworthstone/cass_memory_system/commit/bc426390c1a187289cc4388596a6f97c8e967dc8))
- Improve atomicWrite Windows compatibility and lock reliability ([719f478](https://github.com/Dicklesworthstone/cass_memory_system/commit/719f478f79affb1dc0a4ae59ec44892519d86d5d))

### Security

- Add MCP HTTP auth and harden config against repo-level overrides ([c3dd537](https://github.com/Dicklesworthstone/cass_memory_system/commit/c3dd537759af4b0448699850f0e88da3850e553e))
- Validate SSH targets in remoteCass hosts ([15b29a7](https://github.com/Dicklesworthstone/cass_memory_system/commit/15b29a77c2d1e99c89dab12818d84f40eadeae38))
- Add ReDoS protection for deprecated pattern matching in context ([c98994a](https://github.com/Dicklesworthstone/cass_memory_system/commit/c98994ad85b017f273c0788fda93b85e6a1c8f71))
- Handle pre-compiled RegExp arrays and filter unsafe patterns in sanitizer ([cb80c9a](https://github.com/Dicklesworthstone/cass_memory_system/commit/cb80c9a1fe14e00bc8bbefc88ebb737f06212959))
- Extend ReDoS protection to pre-compiled RegExp objects ([4f1f12e](https://github.com/Dicklesworthstone/cass_memory_system/commit/4f1f12e19b9b2f9bfc9c634105a82344d18d75d1))

### CLI Improvements

- Add `--info` flag for system diagnostics ([86f9171](https://github.com/Dicklesworthstone/cass_memory_system/commit/86f91714a77658fdc83f72ac4b5cef04be84ecaf))
- Add `--examples` global flag for curated workflows ([8ba4e9a](https://github.com/Dicklesworthstone/cass_memory_system/commit/8ba4e9a8d32ad0eebd518f3bf53d801b1c1e4cb9))
- Deprecate `--top` in favor of `--limit` and `--per-category` ([6c10328](https://github.com/Dicklesworthstone/cass_memory_system/commit/6c10328eac8896902d9150e09c191ef15104aa78))
- Add `CASS_PATH` environment variable override ([febe6d8](https://github.com/Dicklesworthstone/cass_memory_system/commit/febe6d8b08a360c0a617b8775ed00e32612cfeb9))
- Enforce exactly one of `--helpful` or `--harmful` in mark command ([3b09ffb](https://github.com/Dicklesworthstone/cass_memory_system/commit/3b09ffb6ba4db4b3b511e498093f35d2e14a1def))

### Curation Engine

- Prevent resurrection of deprecated/blocked rules ([c6977e9](https://github.com/Dicklesworthstone/cass_memory_system/commit/c6977e9948911b09615f70086995d058acd9047b))
- Prevent array aliasing when inverting harmful rules to anti-patterns ([6f27c44](https://github.com/Dicklesworthstone/cass_memory_system/commit/6f27c44c28f9f214511f682f6ef8915a2183e954))
- Prefer active bullets over deprecated when finding similar ([4601a5a](https://github.com/Dicklesworthstone/cass_memory_system/commit/4601a5a7261792aed26d58891226d9c61d24efc9))
- Include maturity/state checks in conflict detection skip ([f36ed50](https://github.com/Dicklesworthstone/cass_memory_system/commit/f36ed50142fd5971aef03e57165c8afcf8111eb2))
- Preserve additional bullet metadata from deltas during add ([1877e1d](https://github.com/Dicklesworthstone/cass_memory_system/commit/1877e1d2656bb7d033a60465ab06b3cd3d7f211d))
- Optimize duplicate detection with pre-computed token sets ([1fc6da0](https://github.com/Dicklesworthstone/cass_memory_system/commit/1fc6da01bfdb4f57d70d61484c733315acc9aa47))

### Scoring

- Support per-event `decayedValue` weights for implicit feedback ([a6f39ec](https://github.com/Dicklesworthstone/cass_memory_system/commit/a6f39ec0c710f8177f849b82c7c743bb6c723709))

### Performance

- O(1) Map lookups for deduplication in curate ([c2ac055](https://github.com/Dicklesworthstone/cass_memory_system/commit/c2ac0559034b9a57bcb4729d86b9acb9341b81ad))
- Batch processing and batch append for ProcessedLog ([60619e6](https://github.com/Dicklesworthstone/cass_memory_system/commit/60619e608238b989cd5350128b210a9e8b46e475), [dcde300](https://github.com/Dicklesworthstone/cass_memory_system/commit/dcde300b91b7a1554a0d7010914b9a67842a212a))
- Scan workspace logs for faster diary lookup ([dc4d5d5](https://github.com/Dicklesworthstone/cass_memory_system/commit/dc4d5d5c981bde5a0a515069671d3320be21a966))
- Parallelize session sampling with batches in onboard ([31e295a](https://github.com/Dicklesworthstone/cass_memory_system/commit/31e295aba843e7fc411ed08f290ea3f0db503093))
- Optimize batch operations for audit and trauma ([fe98a72](https://github.com/Dicklesworthstone/cass_memory_system/commit/fe98a72553d47ee04e831ad36944a5d5572e0f37))
- Improve merge candidate detection relevance and coverage in stats ([237bc14](https://github.com/Dicklesworthstone/cass_memory_system/commit/237bc140e3c46b08bc84fc06f2fbad4dc79367d6))
- Fast path for exact matches in `isSemanticallyBlocked` ([3e8b97f](https://github.com/Dicklesworthstone/cass_memory_system/commit/3e8b97f4601b09492cda13e1d0a253ac9e30352a))

### MCP Server

- Return richer delta info in MCP dry-run responses ([6596deb](https://github.com/Dicklesworthstone/cass_memory_system/commit/6596deb76d9fe47165e402d64ebf6e2f42fe4057))
- Pass config to `safeCassSearch` and prevent double-processing ([8947c8a](https://github.com/Dicklesworthstone/cass_memory_system/commit/8947c8a1efb1b893665b05951d8c45214a44675d))

### Onboarding

- `mark-done` now also updates reflection processed log ([e98a5d2](https://github.com/Dicklesworthstone/cass_memory_system/commit/e98a5d2f3947fa920ef38747516a731c5767260d))
- Add onboard-state locking and comprehensive tests ([2a09d46](https://github.com/Dicklesworthstone/cass_memory_system/commit/2a09d464c51c7f786aa24d6723c30b2743130225))
- Normalize session paths consistently in onboarding and tracking ([6d267e5](https://github.com/Dicklesworthstone/cass_memory_system/commit/6d267e5fa5fe8773f7f39d102ed62e1c9b129657))

### Testing (LLMIO Injection and Broad Coverage)

- **Introduce LLMIO injection** -- a mockless unit testing approach using dependency injection ([9dfbdb1](https://github.com/Dicklesworthstone/cass_memory_system/commit/9dfbdb134880702a48b770265ef6ee8a3a871d5e))
- Convert orchestrator and pipeline tests to LLMIO injection ([3c78a1f](https://github.com/Dicklesworthstone/cass_memory_system/commit/3c78a1f0df72ba5169a54f4c7678a3e13745b169))
- Coverage improvements: context 52% -> 86%, reflect 61% -> 82%, serve 52% -> 68%, playbook 63% -> 81%, top 60% -> 100% ([7ed954d](https://github.com/Dicklesworthstone/cass_memory_system/commit/7ed954dd27e7d5f96857258a5289db59b7700eb2), [dcf5dab](https://github.com/Dicklesworthstone/cass_memory_system/commit/dcf5dab206032e61e552099c7e8e2cc15401afd7), [bda2975](https://github.com/Dicklesworthstone/cass_memory_system/commit/bda297517f074217cd38437602b558ed74db115e), [d6bb29e](https://github.com/Dicklesworthstone/cass_memory_system/commit/d6bb29e2e5bc393eccbee30557a002aa56ec6036), [9eeaf60](https://github.com/Dicklesworthstone/cass_memory_system/commit/9eeaf60774c7ba095ee7ad5256a74477bed13f25))
- 31 integration tests for onboardCommand ([f1ecf22](https://github.com/Dicklesworthstone/cass_memory_system/commit/f1ecf22f995935fbb412995cccf267e709879971))
- 30 tests for contextCommand input validation ([0dd293a](https://github.com/Dicklesworthstone/cass_memory_system/commit/0dd293afaea7c8d647e7ee7030c3bedd9cf7e171))
- Comprehensive tests for trauma, trauma-guard, progress, guard, why, forget, outcome, undo, similar, and audit ([82b2cf9](https://github.com/Dicklesworthstone/cass_memory_system/commit/82b2cf987addf04dc0b05345a505ecf07aec88fe), [fa1849a](https://github.com/Dicklesworthstone/cass_memory_system/commit/fa1849a3b5ad0606d6ac34eb1f54520b9965288d), [f72a3c0](https://github.com/Dicklesworthstone/cass_memory_system/commit/f72a3c0c101f74aed648175459cc3f8e16e31a26), [98ae7d9](https://github.com/Dicklesworthstone/cass_memory_system/commit/98ae7d94b0a090cf8879947e0ac61154fdccd6ab), [0de9fea](https://github.com/Dicklesworthstone/cass_memory_system/commit/0de9fead6f52664abda8d836164523394865ccdf), [4fc1adf](https://github.com/Dicklesworthstone/cass_memory_system/commit/4fc1adf5553759ca4d7fe1d73e09dd5addec6989), [3ee7ff2](https://github.com/Dicklesworthstone/cass_memory_system/commit/3ee7ff2ce3b6d25cd995fdeeb6a2f544c9d45689))
- E2E tests for quickstart, starters, guard, usage, and pipeline failure modes ([fccbe64](https://github.com/Dicklesworthstone/cass_memory_system/commit/fccbe645a572fb5fbd36ce8aff58c608395382f2), [7e33e90](https://github.com/Dicklesworthstone/cass_memory_system/commit/7e33e9080138fc87f5381675569c0564a7631451), [2b52a45](https://github.com/Dicklesworthstone/cass_memory_system/commit/2b52a45df33dd429f4541dda4eb6748cff9e77b5))

### Miscellaneous Bug Fixes

- Make feedback recording idempotent across replays ([234bd6f](https://github.com/Dicklesworthstone/cass_memory_system/commit/234bd6f699744193f14acfc7692a26e4a2de0642))
- Treat 0 budget limits as unlimited ([50926df](https://github.com/Dicklesworthstone/cass_memory_system/commit/50926dfd85389fe14949cbb8ae4527c046403f35))
- Date formatting consistency and pinned bullet maturity ([b3d2e65](https://github.com/Dicklesworthstone/cass_memory_system/commit/b3d2e65b31f410822f52c98a3ff9201ff45068cf))
- Log warning when semantic search fails and falls back ([5d86225](https://github.com/Dicklesworthstone/cass_memory_system/commit/5d86225bb1bfdea3f43be1ef2cdcc2a205e1b9c5))
- Support tilde expansion in playbook file paths ([c1f994e](https://github.com/Dicklesworthstone/cass_memory_system/commit/c1f994e792aea74855619e5798be0b2f61bc015f))
- Use `getActiveBullets` consistently across audit, gap-analysis, onboard, serve, and stats ([97faaa3](https://github.com/Dicklesworthstone/cass_memory_system/commit/97faaa3936776b072020cf4e0d65dcd56ef02aa2), [14126d4](https://github.com/Dicklesworthstone/cass_memory_system/commit/14126d4bf50872922464943750ab5dc423d8ef6c), [ad9f4f5](https://github.com/Dicklesworthstone/cass_memory_system/commit/ad9f4f5ae9d8befc245aa6ef8193ed3a065f4f45), [e6e1e1a](https://github.com/Dicklesworthstone/cass_memory_system/commit/e6e1e1a3c8d36e1fc053e24876c9007b963ec23c))
- Use `warn()` utility consistently across cass, tracking, cost, and lock modules ([e592f71](https://github.com/Dicklesworthstone/cass_memory_system/commit/e592f71c0c10ca49969ea9487c719618b20c8bc7), [cb832d4](https://github.com/Dicklesworthstone/cass_memory_system/commit/cb832d42f1b8ba738fc3ad798998b64db278d745), [c8cd01e](https://github.com/Dicklesworthstone/cass_memory_system/commit/c8cd01e1fe793f1e62013280e591a1096e186cd6))
- Improve error categorization in `generateObjectSafe` ([2f28d1c](https://github.com/Dicklesworthstone/cass_memory_system/commit/2f28d1c224711ac4e7cf676249343840a27dd45a))
- Add `--repo` flag for importing to workspace playbook ([6ac7ba7](https://github.com/Dicklesworthstone/cass_memory_system/commit/6ac7ba764f7dbf475f64decc6c5554dd0311ee5a))
- Use cross-platform path separator regex in `why` command ([653dfd6](https://github.com/Dicklesworthstone/cass_memory_system/commit/653dfd6b36056529c354dceeb922fc1fccc2548a))
- Reduce stop words to syntax-only keywords for better keyword extraction ([cc74ed1](https://github.com/Dicklesworthstone/cass_memory_system/commit/cc74ed1e60167e378323f3c0a3f1122f70c45b39))

---

## [v0.2.0] -- 2025-12-15

**Release**: [cass-memory v0.2.0](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.2.0) | Tag: [`v0.2.0`](https://github.com/Dicklesworthstone/cass_memory_system/commit/1b8393ab38d693a80ef4e180435e45c0e1623e07) | Published: 2025-12-16

The first major feature release after initial publication, adding remote search, agent-friendly output, and complete JSON output consistency.

### Remote and Cross-Agent Search

- **SSH-based remote cass search** -- query cass instances on other machines over SSH for true cross-agent memory sharing ([2f6ab6d](https://github.com/Dicklesworthstone/cass_memory_system/commit/2f6ab6dc88fedb776eae65db21c3a8a9433f799d), [7ea47f3](https://github.com/Dicklesworthstone/cass_memory_system/commit/7ea47f3b6c0bff74ef05c2274566d765a818a294))
- Block repo config override of `crossAgent` and `remoteCass` settings for security ([4300912](https://github.com/Dicklesworthstone/cass_memory_system/commit/43009125e221a2e0919f2aaff9fcb2b78d98879b))

### Agent-Friendliness

- **Complete agent-friendliness improvements** -- consistent JSON output, icon system, structured error responses ([a39d997](https://github.com/Dicklesworthstone/cass_memory_system/commit/a39d99790c5e9aa17b9a4a361b4f99bfbb867bd4))
- Improve JSON output consistency with new icon system ([7bee59c](https://github.com/Dicklesworthstone/cass_memory_system/commit/7bee59c95fdd6ef8135ff986c086919b718b2fa9))
- Produce JSON errors for validation failures in `--json` mode ([de7dae1](https://github.com/Dicklesworthstone/cass_memory_system/commit/de7dae1d76eb70400f13a0d4432c838092b8f12c))
- Standardize `undo` JSON output to use `printJsonResult()` ([5ebe73d](https://github.com/Dicklesworthstone/cass_memory_system/commit/5ebe73d3359b596e202135b8d4aa3a2465fd34a7))
- Keep `suggestedCassQueries` semantically pure in context output ([0d07524](https://github.com/Dicklesworthstone/cass_memory_system/commit/0d075247e30a1a967dfdb0cab3e2b145cd3f447f))

### CLI Refinements

- Centralize sentiment detection in outcome command, remove unused params ([d01e5a5](https://github.com/Dicklesworthstone/cass_memory_system/commit/d01e5a57a0d87ad12b167398b6ab4ffba0443856))
- Use `category+item` for precise doctor check lookup ([2fd2bdb](https://github.com/Dicklesworthstone/cass_memory_system/commit/2fd2bdbd27c5622402a5f4ac2579ea6a37adf33e))
- Correct merge delta ID propagation ([48093ca](https://github.com/Dicklesworthstone/cass_memory_system/commit/48093ca3a4737106199e3920f840d0c0c1bd21bf))

---

## [v0.1.1] -- 2025-12-15

**Release**: [cass-memory v0.1.1](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.1.1) | Tag: [`v0.1.1`](https://github.com/Dicklesworthstone/cass_memory_system/commit/c9e74d3daa2a231744cf7d2ece600061dc4546ff) | Published: 2025-12-15

Released the same day as v0.1.0. Focused on CLI ergonomics and the new onboarding system.

### Onboarding System

- **Agent-native guided onboarding** (`cm onboard`) -- a multi-step command for building playbooks from existing sessions ([bcac363](https://github.com/Dicklesworthstone/cass_memory_system/commit/bcac3631dec2ea2a5a4ba23bdf6004873c714938))
- **Enhanced onboarding v2** -- `cm onboard sample`, `cm onboard read`, `cm onboard mark-done` subcommands with `--fill-gaps` support ([b577dc2](https://github.com/Dicklesworthstone/cass_memory_system/commit/b577dc22cd365a8c16c5598a4a45c5501813e2bf))
- Convert onboard to subcommand pattern for consistency ([94a16f5](https://github.com/Dicklesworthstone/cass_memory_system/commit/94a16f568e503c300ba119023955e7df632b710c))

### Playbook Validation

- Add `--check` and `--strict` pre-add validation flags for playbook rules ([6839910](https://github.com/Dicklesworthstone/cass_memory_system/commit/683991055a801f3fa03e085a730054abbd9f5314))
- Add `--session` flag support to single rule add ([e95a5b7](https://github.com/Dicklesworthstone/cass_memory_system/commit/e95a5b7bb22aaf054a9d285bbeda9ef03192537c))

### CLI Ergonomics

- Convert outcome command required options to positional arguments ([7832f13](https://github.com/Dicklesworthstone/cass_memory_system/commit/7832f13070e723290be2f917da61db74eea256a4))
- Respect `CASS_MEMORY_NO_EMOJI` setting in validate output ([44d9d39](https://github.com/Dicklesworthstone/cass_memory_system/commit/44d9d396bd601e9c7e09d50ed820846da25533d9))
- Document `HarmfulReason` enum values in `--help` ([1404061](https://github.com/Dicklesworthstone/cass_memory_system/commit/140406121b495eb5b70ee6502a588f5491a18c36))

### Doctor Improvements

- Make LLM API key optional (not critical) in doctor checks ([6e97be4](https://github.com/Dicklesworthstone/cass_memory_system/commit/6e97be4dbca9389900274af65bbeda8f5209e319))
- Show all available LLM providers, not just configured one ([8192677](https://github.com/Dicklesworthstone/cass_memory_system/commit/8192677a6bef2d704e611df6ad20b3649247fe56))

### Bug Fixes

- Handle wrapped JSON response format from cass search ([633b349](https://github.com/Dicklesworthstone/cass_memory_system/commit/633b3495be3c8c4bcf103dec3ee621dcabe0ffc5))
- Handle empty gaps in `--fill-gaps` message ([e70c357](https://github.com/Dicklesworthstone/cass_memory_system/commit/e70c357830354116e7660006d2384e6b50cd1e34))
- Remove fake stats, duplicate constant, improve extraction prompt in onboard ([65eaf45](https://github.com/Dicklesworthstone/cass_memory_system/commit/65eaf459dbf6427a3e127a5095f9efd2dc342313))

---

## [v0.1.0] -- 2025-12-15

**Release**: [cass-memory v0.1.0](https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.1.0) | Tag: [`v0.1.0`](https://github.com/Dicklesworthstone/cass_memory_system/commit/ded0de3d0f6f47105d65dbead0f0a8de1aa93105) | Published: 2025-12-15

The initial public release of cass-memory, providing procedural memory for AI coding agents. Built from the ground up between 2025-12-07 and 2025-12-15.

### Core Architecture

- **Three-layer cognitive architecture**: raw session ingestion, LLM-driven reflection, and confidence-tracked curation ([6f57e23](https://github.com/Dicklesworthstone/cass_memory_system/commit/6f57e23fe8695381c3724d3468fc6b06e1186c76))
- **Comprehensive Zod-based type system** with schemas for playbooks, bullets, deltas, scoring, sanitization, and more ([9d229bb](https://github.com/Dicklesworthstone/cass_memory_system/commit/9d229bbcdf73cabb52aea28585db61f364cb7d5d))
- **LLM prompt templates** for all pipeline operations ([70d7e6e](https://github.com/Dicklesworthstone/cass_memory_system/commit/70d7e6e571766d146e75e662fdb79e1d9184384e))

### ACE Pipeline (Analyze, Curate, Evolve)

- **Reflector and validator pipeline** components for session analysis ([f101dab](https://github.com/Dicklesworthstone/cass_memory_system/commit/f101dab22da3f1b4bb28234d44cdada342b62ab2))
- **Full reflection pipeline** with orchestration, locking, and iteration control ([08b9a1a](https://github.com/Dicklesworthstone/cass_memory_system/commit/ab2769b48aaec9edd8e4ad6f3e5ead6d0e9fc8c6))
- **Deterministic delta application engine** for curation ([f940fc1](https://github.com/Dicklesworthstone/cass_memory_system/commit/f940fc1a2bf44fe3f49fb57b57e8d63ecb10019e))
- **Validation** with evidence-count gate for pre-LLM filtering and schema validation ([84fb356](https://github.com/Dicklesworthstone/cass_memory_system/commit/84fb35692de35ca43f8ffbdaa1f12a917a0afa6d))
- Expand lock scope to prevent duplicate processing in reflect ([e303214](https://github.com/Dicklesworthstone/cass_memory_system/commit/e303214c23dec0b35f92abab56a0d43e13c629c9))

### Scoring and Decay

- **Bayesian scoring algorithm** with temporal decay and maturity multipliers ([4745221](https://github.com/Dicklesworthstone/cass_memory_system/commit/4745221e6dc3a19cb6ed764035481274beaa3743))
- **Implicit feedback system** for session outcomes ([e35b076](https://github.com/Dicklesworthstone/cass_memory_system/commit/e35b076babb30e2e6dec8df06ee999dfb54a2e73))
- Unify feedback events and remove legacy config helpers ([6560d2c](https://github.com/Dicklesworthstone/cass_memory_system/commit/6560d2cd62e74eee94aece38f4e10e59f2f7f1ec))
- Config tolerance helpers and improved code clarity ([1df2649](https://github.com/Dicklesworthstone/cass_memory_system/commit/1df26496701670095f3355640707fc528a6c43b5))

### CLI Commands

- **`cm init`** -- initialize cass-memory for a project ([b7cc38b](https://github.com/Dicklesworthstone/cass_memory_system/commit/b7cc38b66eca219035d511bf2dbd7cf4022e556b))
- **`cm context`** -- get task-specific memory with programmatic API ([9fcd060](https://github.com/Dicklesworthstone/cass_memory_system/commit/9fcd060a174e998e8db15119e2f9f2aef449f97d))
- **`cm reflect`** -- run the full reflection pipeline ([08b9a1a](https://github.com/Dicklesworthstone/cass_memory_system/commit/ab2769b48aaec9edd8e4ad6f3e5ead6d0e9fc8c6))
- **`cm mark`** -- record helpful/harmful feedback on rules ([ae54f2c](https://github.com/Dicklesworthstone/cass_memory_system/commit/ae54f2c32c6f40a8cfb4e7f2b0dc1bb9cb5c3ceb))
- **`cm validate`** -- validate reflector output and delta application ([6f54884](https://github.com/Dicklesworthstone/cass_memory_system/commit/6f548841e1439e22b1e66e4f29dff20dfd4cc6c3))
- **`cm doctor`** -- system health checks with auto-fix ([309a3d1](https://github.com/Dicklesworthstone/cass_memory_system/commit/309a3d1528bff448bbeb19fa25af01bdebe9c59a))
- **`cm stats`** -- playbook health metrics with staleness detection and merge candidates ([6fb6446](https://github.com/Dicklesworthstone/cass_memory_system/commit/6fb64467ee4f3dc6e4e15e6e9cd7498ee9fe8d55), [ccd60f4](https://github.com/Dicklesworthstone/cass_memory_system/commit/ccd60f4b4b5b5e11ce25bcfb1b78e07d9a1a28df))
- **`cm diary`** -- cross-agent session enrichment with search anchors ([3aa49a1](https://github.com/Dicklesworthstone/cass_memory_system/commit/3aa49a197bef1ca2c3cb38ea3f5439e6e6268efd))
- **`cm audit`** -- playbook audit with LLM analysis ([170e65b](https://github.com/Dicklesworthstone/cass_memory_system/commit/170e65b2ca4bad8bec8faf0f92fb6d5b2eed4a8d))
- **`cm forget`** -- deprecate toxic rules ([170e65b](https://github.com/Dicklesworthstone/cass_memory_system/commit/170e65b2ca4bad8bec8faf0f92fb6d5b2eed4a8d))
- **`cm project`** -- project-level memory management ([170e65b](https://github.com/Dicklesworthstone/cass_memory_system/commit/170e65b2ca4bad8bec8faf0f92fb6d5b2eed4a8d))
- **`cm top`** -- view most effective bullets ([7ce9e41](https://github.com/Dicklesworthstone/cass_memory_system/commit/7ce9e4131b6b2f7b4bc3d17301b9e89340dc2e6b))
- **`cm stale`** -- find bullets without recent feedback ([d81b081](https://github.com/Dicklesworthstone/cass_memory_system/commit/d81b08160f67a27e8eea5a5f5e8d41b21e3d5a32))
- **`cm why`** -- bullet provenance and session tracing ([e559fe7](https://github.com/Dicklesworthstone/cass_memory_system/commit/e559fe79f0b9d7ca1e1e66e58e54ac4b4f4e5a8e))
- **`cm undo`** -- revert bad curation decisions ([269404a](https://github.com/Dicklesworthstone/cass_memory_system/commit/269404a3e5b24a66d3bae3c7d27c3f8e457bc86a))
- **`cm outcome`** -- log session outcomes for scoring ([0920540](https://github.com/Dicklesworthstone/cass_memory_system/commit/0920540c22b0bdcfcbd1b2b6f1f58f48a3e59ddb))
- **`cm serve`** -- MCP server for tool integration ([0920540](https://github.com/Dicklesworthstone/cass_memory_system/commit/0920540c22b0bdcfcbd1b2b6f1f58f48a3e59ddb))
- Commander-based CLI entry point with dynamic version from package.json ([eaa6dfd](https://github.com/Dicklesworthstone/cass_memory_system/commit/eaa6dfd91f0db1af18fe19f4a99a19b3bfd40d1e), [d2332b1](https://github.com/Dicklesworthstone/cass_memory_system/commit/d2332b1a3be241a4815720b2e3fab629afcd89ae))

### Playbook Management

- Playbook CRUD with pinning, auto-prune, markdown export, and atomic writes ([f04ca90](https://github.com/Dicklesworthstone/cass_memory_system/commit/f04ca90949b81a99f3e36b0e50b6d1fc7fafe33d))
- Similarity search for duplicate detection ([44c674b](https://github.com/Dicklesworthstone/cass_memory_system/commit/44c674ba4ab6e2b2d9f4efe0f98f27d30e5f7cf7))
- Semantic classification for bullets with PITFALLS section for anti-patterns ([2a6bc9f](https://github.com/Dicklesworthstone/cass_memory_system/commit/2a6bc9f5dc864ba7fcd834d3377bada329561054))
- Support for `helpfulEvents`/`harmfulEvents` arrays and `feedbackEvents` ([e2ebfd7](https://github.com/Dicklesworthstone/cass_memory_system/commit/e2ebfd7c958c87d320e89987b48b4fbeee9247c1))
- Mark command with event arrays for recording feedback ([6f54884](https://github.com/Dicklesworthstone/cass_memory_system/commit/6f548841e1439e22b1e66e4f29dff20dfd4cc6c3))
- `removeFromBlockedLog` function for managing blocked entries ([cc022cd](https://github.com/Dicklesworthstone/cass_memory_system/commit/cc022cdb7e6ff4f065a32ebbff7a0f4d3e08e4f3))

### Semantic Search

- **Embedding-based semantic search** infrastructure using `@xenova/transformers` for local embeddings ([19774d0](https://github.com/Dicklesworthstone/cass_memory_system/commit/19774d01ed9fe8ab2bee11f5d9367ff15c9e0581))
- Lazy model download with progress callback ([4e60fd1](https://github.com/Dicklesworthstone/cass_memory_system/commit/4e60fd1172ddca5f579b63f6687568f5e0f42365))
- `warmupEmbeddings` and `isModelCached` functions ([9c58f03](https://github.com/Dicklesworthstone/cass_memory_system/commit/9c58f0373a5b44e94b00095bf1500421fdd3a8ee))
- Clear semantic/keyword mode messaging ([7397f36](https://github.com/Dicklesworthstone/cass_memory_system/commit/7397f36735d4a4488a1744afa9ac0ed77d7ad5f0))

### Privacy and Security

- **Cross-agent privacy controls** with consent workflow ([f19437f](https://github.com/Dicklesworthstone/cass_memory_system/commit/f19437f2c22bb93b844c1c1a09fc7c26437cb4da))
- **Secret sanitization module** with standalone sanitizer, ReDoS protection, and verification ([7fd13d3](https://github.com/Dicklesworthstone/cass_memory_system/commit/7fd13d37ff940b7c0d3e7cf8f7bc2fb9a659cd25), [28f0544](https://github.com/Dicklesworthstone/cass_memory_system/commit/28f0544d2ce9b1c944cefc8cf8edd7e4c2281d8c))
- Critical security fixes: shell execution, playbook corruption, network exposure, and collision risks ([834b555](https://github.com/Dicklesworthstone/cass_memory_system/commit/834b555e8ded4f4fd18b24e4c7a7c0a469e0ec27))

### Configuration

- `ConfigSchema` as single source of truth for defaults ([759a364](https://github.com/Dicklesworthstone/cass_memory_system/commit/759a364f2e2e0a8e1f3e32efea4ea5e61927a2e5))
- Repo config format parity (`.cass/config.json` support) ([26b5926](https://github.com/Dicklesworthstone/cass_memory_system/commit/26b5926ee4aba5d94bb8e9fe3dd4b5a4e4ab3dbe))
- Normalize LLM config shape with deprecated `llm.*` migration ([203fd02](https://github.com/Dicklesworthstone/cass_memory_system/commit/203fd02bd3764d2be24cff5a479d8251898f84f4))
- LLM cost tracking and budget enforcement ([2762b38](https://github.com/Dicklesworthstone/cass_memory_system/commit/2762b38d29b950d53cf8a1e7b65e78c0cc3b63db))

### LLM Integration

- `llmWithRetry` with configurable retry policy ([bc35704](https://github.com/Dicklesworthstone/cass_memory_system/commit/bc3570499f69b7e3c28ce1e09346b26f8dfe53f4))
- `llmWithFallback` for multi-provider resilience ([5a22ee5](https://github.com/Dicklesworthstone/cass_memory_system/commit/5a22ee5d81da466dfebd2e3c0aef1b2f3d39b5d9))
- Operation timeouts and improved type safety ([9830022](https://github.com/Dicklesworthstone/cass_memory_system/commit/9830022babc201b76e04c3aeee3afa11f1c6e3da))
- Structured output for `generateContext` ([a99858c](https://github.com/Dicklesworthstone/cass_memory_system/commit/a99858c2fa906c119d3f66f9f11e0282da389ee8))

### Safety and DX

- `--dry-run` preview mode for destructive operations ([51d2d69](https://github.com/Dicklesworthstone/cass_memory_system/commit/51d2d6959525fd6cd22d4c0602576cafbc9ab227))
- Dynamic CLI name and `confirmDangerousAction()` safety prompts ([a2ccbb3](https://github.com/Dicklesworthstone/cass_memory_system/commit/a2ccbb33cab4c6e80c5aec14c8e45f6eb1a2e87c))
- Replace `process.exit` with throws for better error handling ([33db1f7](https://github.com/Dicklesworthstone/cass_memory_system/commit/33db1f7d9f21400860195960c6ff3db68a99298b))
- Resolve nested lock deadlock in reflect orchestrator ([fe740af](https://github.com/Dicklesworthstone/cass_memory_system/commit/fe740af112015c84c789d2a85e7cc257267c92a8))
- Harden cass output parsing and add timeouts ([8a273c2](https://github.com/Dicklesworthstone/cass_memory_system/commit/8a273c2e651dd0bb989f50e5d8d28214b4790690))
- Atomic mkdir-based locking mechanism ([2b9125c](https://github.com/Dicklesworthstone/cass_memory_system/commit/2b9125c3b5f81ce1d19afdd0d01c1f5e2a1e5133))

### Utilities

- `truncateForContext` for LLM-aware content truncation ([54fe012](https://github.com/Dicklesworthstone/cass_memory_system/commit/54fe012b5ab58f1a8b3e4e2e7aec114e21deff80))
- String normalization functions ([f00bebb](https://github.com/Dicklesworthstone/cass_memory_system/commit/f00bebb5c1b15c955e7c4e3e04c86e2adce5b139))
- `getCliName()`, disk space check, consolidated file locking ([981c8cf](https://github.com/Dicklesworthstone/cass_memory_system/commit/981c8cf89e1e2e7e3e893e4a2f19f3c0e2c2fb2c), [1d60530](https://github.com/Dicklesworthstone/cass_memory_system/commit/1d60530279e28ecdfe1df94d5cee1eae12b9068b))
- Scope utilities and bullet ID validation pattern ([77e2924](https://github.com/Dicklesworthstone/cass_memory_system/commit/77e2924d8e5b68f77d1dca940497c1cd7f7e89ff))

### Distribution

- **curl installer** and GitHub Actions release workflow with cross-compilation for Linux x64, macOS arm64/x64, and Windows x64 ([9b37ce3](https://github.com/Dicklesworthstone/cass_memory_system/commit/9b37ce3f5b1247e81dd68300b357bbd01f7aafbc))
- SHA256 checksum verification for all binaries ([ded0de3](https://github.com/Dicklesworthstone/cass_memory_system/commit/ded0de3d0f6f47105d65dbead0f0a8de1aa93105))

### Testing Infrastructure

- Test fixtures, helpers, and logging infrastructure ([98a6aeb](https://github.com/Dicklesworthstone/cass_memory_system/commit/98a6aeb9c0f0e5ff25fc2148a0c4abce2bf25e0c))
- Offline LLM shim for testing without API calls ([5ccffaf](https://github.com/Dicklesworthstone/cass_memory_system/commit/5ccffaf2b814a9bad0ac43f7a67e7f8ecfe9acf8))
- `factories.ts` test helper module ([11d4110](https://github.com/Dicklesworthstone/cass_memory_system/commit/11d4110fedd8bc2805bfa1560e9ba3e1e5d2b8e0))
- E2E tests for new user onboarding and team workflow ([507c9da](https://github.com/Dicklesworthstone/cass_memory_system/commit/507c9da5026b416dd2c3a4db472b2dfda93efbd8), [1a38c9e](https://github.com/Dicklesworthstone/cass_memory_system/commit/1a38c9ed46dd9816a69200cecaff446b6a0e3f93))
- CLI smoke test for offline workflow ([c98e593](https://github.com/Dicklesworthstone/cass_memory_system/commit/c98e593cb2d966ba339baaa4f4d4779dfbe6c8c0))
- Comprehensive tests for scoring, types, tracking, lock, validate, utils, curate, and more ([ac3ffa7](https://github.com/Dicklesworthstone/cass_memory_system/commit/ac3ffa7e13c25e3b2c7b5e6c94c4d25c4eacf5aa), [ef93e3f](https://github.com/Dicklesworthstone/cass_memory_system/commit/ef93e3fdd5d3df7c8c6a1c79f3f6adc96b1ba09b), [b11b2f9](https://github.com/Dicklesworthstone/cass_memory_system/commit/b11b2f9c5a94e1c8d09ca5ce2b25e4e9811fff03), [104ac93](https://github.com/Dicklesworthstone/cass_memory_system/commit/104ac93fd51ebc8412d8b1429b4b7a1e6dfed3c2), [ecf1bcb](https://github.com/Dicklesworthstone/cass_memory_system/commit/ecf1bcba2f06eaa2a5e9e5ce3a23a2f1e5c8eef9))

---

## Pre-release (2025-12-07)

The initial project scaffolding before any tagged release.

### Project Foundation

- Initial implementation of the Beads issue tracking system with configuration and agent workflow documentation ([7393dce](https://github.com/Dicklesworthstone/cass_memory_system/commit/7393dce043830ffe2e73d6e4cb350b50c28c6bec))
- Comprehensive README for cass-memory ([768ac00](https://github.com/Dicklesworthstone/cass_memory_system/commit/768ac00d2acef9940820892788ae85036498745d))
- Fix command naming: use `cm` instead of `cass` to avoid coreutils conflicts ([5f8ed00](https://github.com/Dicklesworthstone/cass_memory_system/commit/5f8ed001af347bfb15b9f4903c5b986e076f47e8))

---

[Unreleased]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.2.3...HEAD
[v0.2.3]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.2.2...v0.2.3
[v0.2.2]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.2.1...v0.2.2
[v0.2.1]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.2.0...v0.2.1
[v0.2.0]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.1.1...v0.2.0
[v0.1.1]: https://github.com/Dicklesworthstone/cass_memory_system/compare/v0.1.0...v0.1.1
[v0.1.0]: https://github.com/Dicklesworthstone/cass_memory_system/releases/tag/v0.1.0
