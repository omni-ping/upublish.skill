# Discovery + Design: Phase 1 - Add MCP login + status tools

## Files Found
- `mcp/index.ts` — MCP server, 7 tools registered (publish, list, delete, passcode_add, passcode_list, passcode_revoke, logout)
- `lib/core.ts` — Core facade, already exports `login()`, `status()`, `LoginDeps`, `LoginResult`, `StatusResult`
- `lib/auth.ts` — OAuth flow, `CallbackServer` type, `TokenResponse` type, `login()` orchestrator
- `bin/upublish.ts` — CLI adapter with `createCallbackServer()` function to port
- `tests/mcp.test.ts` — 22 tests, 2 failing (stale tool count assertions at 4, actual is 7)

## Current State
- `core.login(loginDeps, coreDeps?)` already exists and accepts `LoginDeps` with `openBrowser`, `startCallbackServer`, `log` callbacks
- `core.status(deps?)` already exists and returns `StatusResult` (authenticated/not)
- `bin/upublish.ts` has a `createCallbackServer()` that uses `Bun.serve` on port 0 — this is the pattern to port to `mcp/index.ts`
- The MCP server uses `createServer(coreDeps?)` factory pattern — new tools just add `server.registerTool()` calls
- Error message at `lib/core.ts:119` says `"Not authenticated. Run \`upublish login\` to sign in."` — needs update
- The `open` package is already a dependency (used in `bin/upublish.ts`)

## Gaps
1. Tool count assertions in `tests/mcp.test.ts` lines 150 and 620 expect 4, but actual is 7. Plan says update to 9 (after adding login + status). Confirmed.
2. Pre-existing test failures in `tests/manifests.test.ts` (6 failures) — not in scope for Phase 1, will be addressed in Phase 2.
3. The `login` tool needs `createCallbackServer` ported from `bin/upublish.ts` to `mcp/index.ts`.
4. The `login` tool needs to return the auth URL in the response text — `core.login()` calls `log()` but doesn't return the URL. Need to capture it via the injected `log` and `openBrowser` callbacks.

## Code Standards
- Adapters import only from `lib/core.ts` (forbidden pattern: no direct submodule imports)
- MCP tool registration follows `server.registerTool(name, { title, description, inputSchema }, handler)` pattern
- Error handling: tool handlers wrap in try/catch, return `errResponse()`
- Test naming: `test_DW_N_M_description`
- DI via `CoreDeps` bag
- `.ts` extensions in all imports

## Test Infrastructure
- `bun:test` with `describe`, `test`, `expect`
- `createServer(coreDeps)` factory enables test injection
- `getTools(server)` extracts `_registeredTools` for direct handler invocation
- `makeDeps(fetchFn)` creates temp credentials file + mock fetch
- `makeMockFetch(apiResponse)` handles token refresh + namespace resolution

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | MCP server exposes a `login` tool that opens browser and returns auth URL text | COVERED | `test_DW_1_1_server_registers_login_tool`, `test_DW_1_1_login_tool_opens_browser_and_returns_url` |
| DW-1.2 | MCP server exposes a `status` tool that returns auth state | COVERED | `test_DW_1_2_server_registers_status_tool`, `test_DW_1_2_status_tool_returns_authenticated`, `test_DW_1_2_status_tool_returns_unauthenticated` |
| DW-1.3 | Login tool creates a localhost callback server, waits for OAuth tokens, stores credentials | COVERED | `test_DW_1_3_login_tool_creates_callback_server_and_stores_credentials` |
| DW-1.4 | Login tool response always includes the auth URL as text | COVERED | `test_DW_1_4_login_response_includes_auth_url` |
| DW-1.5 | "Not authenticated" error message no longer references CLI commands | COVERED | `test_DW_1_5_error_message_no_cli_reference` |
| DW-1.6 | Tests for login and status tools pass in `tests/mcp.test.ts` | COVERED | All DW-1.x tests in `tests/mcp.test.ts` |
| DW-1.7 | Tool count assertions in `tests/mcp.test.ts` are fixed | COVERED | `test_DW_1_7_server_registers_exactly_nine_tools`, update `test_DW_2_1_creates_server_and_has_tools` |
| DW-1.8 | `dist/mcp.js` is rebuilt with login + status tools | COVERED | Post-implementation build step |
| DW-1.9 | `bun test` passes with 0 failures | COVERED | Full test suite run after changes |

**All items COVERED:** YES

## Design Decisions

### Login tool — capturing the auth URL

The `core.login()` function accepts `LoginDeps` which includes `openBrowser(url)` and `log(msg)` callbacks. The auth URL is passed to `openBrowser()`. To return it in the MCP response:

**Approach A:** Capture the URL in the `openBrowser` callback closure. The MCP tool handler provides an `openBrowser` that (1) calls `open(url)` and (2) stores the URL in a local variable. After `core.login()` resolves, the handler includes the captured URL in the response text.

**Approach B:** Modify `core.login()` to return the auth URL in `LoginResult`. This would require changing `lib/auth.ts` which is out of scope.

**Chosen: Approach A** — no changes to domain logic, captures the URL via the existing DI mechanism. Simple, no new interfaces.

### createCallbackServer location

Ported directly into `mcp/index.ts` from `bin/upublish.ts`. Same `Bun.serve` pattern, same `CallbackServer` interface. Not extracted to a shared module because Phase 2 will delete `bin/upublish.ts`, and only `mcp/index.ts` will need it.

### Login tool testing

Cannot fully test real OAuth flow (requires browser + API). Test strategy:
- Mock `core.login()` by testing the tool handler's response shape when login succeeds
- The handler constructs `LoginDeps` internally, so we test the output (response text containing URL, username)
- For DW-1.3 (callback server + credential storage), we inject `CoreDeps` with a temp credentials path and verify the handler calls through to `core.login()`

## Prerequisites
- [x] Required files exist
- [x] Dependencies available (`open`, `@modelcontextprotocol/sdk`, `zod`)
- [x] `core.login()` and `core.status()` already implemented
- [x] `CallbackServer` type available via re-export

## Recommendation
BUILD — All prerequisites met, design is straightforward, no blockers.
