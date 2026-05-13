# Plan: Hexagonal Architecture Refactor
**Created:** 2026-05-13
**Status:** in-progress
**Started:** 2026-05-13
**Complexity:** medium
---
## Context
Core functions require callers to construct an `ApiClient` with credentials and token provider. Both CLI and MCP independently wire auth, causing the MCP stale-state bug (reads credentials once at startup) and duplicated bootstrapping logic. Redesign so core owns all wiring — credentials, token refresh, API client construction — and adapters just call core functions and format output.

## Constraints
- Hexagonal: core owns all wiring, adapters are thin
- No auth knowledge in CLI or MCP adapters
- Credentials read fresh per call (fixes stale-state bug)
- Keep injectable deps for testability via `CoreDeps`: `{ credentialsPath?: string; fetchFn?: typeof fetch }`
- `login()` and `status()` live in core because they're user-facing operations that need the same credential/API wiring — not separate auth plumbing
---
## Implementation Phases

### Phase 1: Core module with fresh-per-call wiring
**Model:** sonnet
**Skills:** `code-foundations:cc-refactoring-guidance`, `code-foundations:ca-architecture-boundaries`

**Goal:** Create `lib/core.ts` that exports all operations with internal credential/API wiring. No caller needs to construct ApiClient.

**Scope:**
- IN: `lib/core.ts` exports `list()`, `publish()`, `delete()`, `generate()`, `login()`, `status()`. Each reads credentials from disk, creates token provider + ApiClient, calls the domain function, returns structured data. All accept optional `CoreDeps` override: `{ credentialsPath?: string; fetchFn?: typeof fetch }`. Existing `lib/publish.ts`, `lib/list.ts` etc stay as domain functions that take ApiClient — they become internal to core. Tests for all 6 core functions.
- OUT: Adapter rewrites (Phase 2). npm publish.

**Done when:**
- [ ] DW-1.1: `lib/core.ts` exports `list()`, `publish()`, `delete()`, `generate()`, `login()`, `status()` — none take ApiClient
- [ ] DW-1.2: Each function reads credentials from disk on every call (no module-level cache)
- [ ] DW-1.3: Functions accept optional `CoreDeps` for test injection
- [ ] DW-1.4: Calling `core.list()` with no credentials throws "Not authenticated"
- [ ] DW-1.5: Calling `core.status()` after writing credentials returns `{ authenticated: true, username }`
- [ ] DW-1.6: All 6 core functions have unit tests with injected deps

### Phase 2: Rewrite adapters
**Model:** sonnet
**Skills:** `code-foundations:cc-refactoring-guidance`

**Goal:** Rewrite CLI and MCP to import only from `lib/core.ts`. Zero auth knowledge in adapters.

**Scope:**
- IN: Rewrite `mcp/index.ts` — import only from `core.ts`, no ApiClient/auth imports, no startup credential read, no stub tools. Each handler calls core and formats result. Rewrite `bin/upublish.ts` — remove `loadApiClient()`, credential reads, token provider construction. Each subcommand calls core and formats. Update adapter tests.
- OUT: Changing domain functions. npm publish.

**Done when:**
- [ ] DW-2.1: `mcp/index.ts` imports only from `lib/core.ts` — no ApiClient, auth, or credential imports
- [ ] DW-2.2: `bin/upublish.ts` imports only from `lib/core.ts` — no ApiClient, auth, or credential imports
- [ ] DW-2.3: MCP tools work after `upublish login` without session restart (stale-state bug fixed)
- [ ] DW-2.4: CLI commands produce correct output
- [ ] DW-2.5: `bun test` passes with 0 failures
- [ ] DW-2.6: No import of `ApiClient`, `createTokenProvider`, or `readCredentials` outside of `lib/`

---
## Test Coverage
**Level:** 100%
## Test Plan
- [ ] Unit: core.list() reads credentials, creates client, returns sites
- [ ] Unit: core.list() with no credentials throws "Not authenticated"
- [ ] Unit: core.publish() reads credentials fresh each call
- [ ] Unit: core.delete() deletes and returns message
- [ ] Unit: core.generate() returns url and slug
- [ ] Unit: core.login() runs OAuth flow via injected deps
- [ ] Unit: core.status() returns authenticated/username or error
- [ ] Unit: core.status() after writing credentials returns authenticated (stale-state regression test)
- [ ] Unit: MCP handlers call core, format output, return MCP content
- [ ] Unit: MCP handlers return error content when core throws
- [ ] Integration: CLI commands produce correct terminal + JSON output
---
## Execution Log
_To be filled during /code-foundations:building_
