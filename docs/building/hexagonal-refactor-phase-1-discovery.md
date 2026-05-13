# Discovery + Design: Phase 1 - Core module with fresh-per-call wiring

## Files Found
- `lib/api-client.ts` — ApiClient class with get/post/postForm/delete methods
- `lib/auth.ts` — login(), createTokenProvider(), readCredentials(), saveCredentials(), defaultCredentialsPath()
- `lib/delete.ts` — deleteSite(apiClient, slug)
- `lib/generate.ts` — generate({ apiClient, context, diagramType, slug })
- `lib/list.ts` — listSites(apiClient)
- `lib/publish.ts` — publish({ apiClient, directory, slug, title, visibility, passcode })
- `lib/types.ts` — Site, FetchFn, TokenProvider, Visibility
- `bin/upublish.ts` — CLI adapter, has loadApiClient() helper, status done via apiClient.get('/auth/me')
- `mcp/index.ts` — MCP adapter, reads refreshToken at startup in main(), passes to createServer()

## Current State
All domain functions exist and are well-tested (56 tests pass). Each takes an `ApiClient` as first argument. Auth wiring is duplicated in both adapters:
- CLI: `loadApiClient()` reads credentials + creates tokenProvider + creates ApiClient
- MCP: `main()` reads credentials once at startup; `createServer()` receives it as config

The MCP stale-state bug: credentials are read once in `main()` before stdio transport connects. After `upublish login`, the MCP process must be restarted to pick up new credentials.

`status()` is currently CLI-only (`runStatusCommand` in bin/upublish.ts); it calls `apiClient.get('/auth/me')` directly — no domain function in lib/.

## Gaps
- `lib/core.ts` does not exist — must be created
- No `status()` domain/core function exists — `runStatusCommand` calls `apiClient.get('/auth/me')` inline in the CLI
- `CoreDeps` type is not defined anywhere — must be defined in core.ts
- No `core.login()` function with the right signature — `lib/auth.ts` exports `login(deps: LoginDeps)` which takes the full OAuth deps bag, not a CoreDeps override

## Code Standards
No `docs/code-standards.md` found. Conventions derived from codebase:
- Bun test framework: `import { describe, it, expect } from "bun:test"`
- Test naming: `test_DW_X_Y_description` referencing DW-IDs in test names
- File structure: section headers with `// ─── Section ─────` comments
- JSDoc block at file top explaining exports and purpose
- All imports use `.ts` extension (Bun native resolution)
- `async function` style (not arrow functions for named exports)
- Types grouped at top of file under `// ─── Types ───`

## Test Infrastructure
- Framework: Bun test (`bun:test`)
- Test files colocated in `lib/` as `*.test.ts`
- `bun test lib/` runs lib tests; `bun test` runs all
- Pattern: `mockFetch(status, body)` helper in each test file
- Injectable deps for network isolation — no real HTTP calls

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `lib/core.ts` exports `list()`, `publish()`, `delete()`, `generate()`, `login()`, `status()` — none take ApiClient | COVERED | `test_DW_1_1_core_exports_list`, `test_DW_1_1_core_exports_publish`, `test_DW_1_1_core_exports_delete`, `test_DW_1_1_core_exports_generate`, `test_DW_1_1_core_exports_login`, `test_DW_1_1_core_exports_status` |
| DW-1.2 | Each function reads credentials from disk on every call (no module-level cache) | COVERED | `test_DW_1_2_list_reads_credentials_per_call`, `test_DW_1_2_publish_reads_credentials_per_call` |
| DW-1.3 | Functions accept optional `CoreDeps` for test injection | COVERED | `test_DW_1_3_list_accepts_core_deps`, `test_DW_1_3_status_accepts_core_deps` |
| DW-1.4 | Calling `core.list()` with no credentials throws "Not authenticated" | COVERED | `test_DW_1_4_list_no_credentials_throws`, `test_DW_1_4_delete_no_credentials_throws`, `test_DW_1_4_publish_no_credentials_throws`, `test_DW_1_4_generate_no_credentials_throws`, `test_DW_1_4_status_no_credentials_throws` |
| DW-1.5 | Calling `core.status()` after writing credentials returns `{ authenticated: true, username }` | COVERED | `test_DW_1_5_status_authenticated_returns_username` |
| DW-1.6 | All 6 core functions have unit tests with injected deps | COVERED | All tests in `lib/core.test.ts` use injected `CoreDeps` — no real fs or network |

**All items COVERED:** YES

## Design Decisions

### CoreDeps interface design (design-it-twice)

**Option A: Full deps injection**
```ts
interface CoreDeps {
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
}
```
Each core function reconstructs tokenProvider + ApiClient from scratch on every call using these deps.

**Option B: ApiClient injection override**
```ts
interface CoreDeps {
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  apiClient?: ApiClient;  // full override
}
```
Tests can skip auth entirely by passing a pre-built ApiClient.

**Option C: readCredentials injection**
```ts
interface CoreDeps {
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  readCredentialsFn?: (path: string) => Promise<string | null>;
}
```
Allows tests to simulate missing credentials without touching filesystem.

**Chosen: Option A (plan-specified interface)**
The plan specifies exactly `{ credentialsPath?: string; fetchFn?: typeof fetch }`. This is cleanest because:
- Interface simplicity: 2 fields, obvious purpose
- Tests inject a `credentialsPath` pointing to a temp file they wrote — this lets us test the read-from-disk path too
- No exposure of ApiClient internals to callers
- `apiBaseUrl` comes from `process.env.UPUBLISH_API_URL` defaulting to prod URL — consistent with existing adapters

Option A loses on one dimension: tests must write an actual temp file to inject credentials. Option C would avoid that. However Option A tests a more realistic path (actual file read).

### `core.login()` signature

The existing `lib/auth.ts:login()` takes a `LoginDeps` bag (openBrowser, startCallbackServer, log) — heavy infrastructure deps. `core.login()` needs to orchestrate this same flow but accept only `CoreDeps`.

Decision: `core.login()` signature:
```ts
async function login(loginDeps: LoginDeps, coreDeps?: CoreDeps): Promise<LoginResult>
```
This keeps the OAuth plumbing deps separate from the storage deps, consistent with the rest of core. The `coreDeps.credentialsPath` overrides the default credentials path passed to `lib/auth.ts:login()`.

### `core.status()` — no domain function exists

Currently `runStatusCommand` calls `apiClient.get<{ username: string }>('/auth/me')` inline. Core needs to own this. `core.status()` will:
1. Read credentials from disk
2. If null → return `{ authenticated: false }`
3. Build tokenProvider + ApiClient
4. Call GET /auth/me
5. Return `{ authenticated: true, username }`
6. On error → return `{ authenticated: false, error: string }` (does not throw)

This aligns with DW-1.5: no credentials → return `{ authenticated: false }`, not throw.

For `core.list()` and other operations: no credentials → throw "Not authenticated" (DW-1.4). This is intentional asymmetry — `status()` is a query about auth state, never an error; `list()` etc. require auth and fail hard.

## Prerequisites
- [x] All domain functions exist (lib/publish.ts, lib/list.ts, lib/delete.ts, lib/generate.ts, lib/auth.ts)
- [x] ApiClient exists and is injectable
- [x] Bun test framework available
- [x] 56 existing tests pass (no regressions to start from)

## Recommendation
BUILD — all prerequisites met, design is clear, no gaps block implementation.
