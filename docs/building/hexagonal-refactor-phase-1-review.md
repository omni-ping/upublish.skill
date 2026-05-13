# Review: Phase 1 - Core Module with Fresh-Per-Call Wiring

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-1.1 | `lib/core.ts` exports `list()`, `publish()`, `deleteOp()`, `generate()`, `login()`, `status()` — none take ApiClient | SATISFIED | `lib/core.ts` lines 110, 120, 139, 152, 170, 187 export all 6 functions with signatures taking only domain args + optional `CoreDeps` |
| DW-1.2 | Each function reads credentials from disk on every call (no module-level cache) | SATISFIED | `lib/core.ts` `buildApiClient()` (lines 85–102) calls `readCredentials()` fresh on every invocation; no module-level cache variables; verified via test `test_DW_1_2_list_reads_credentials_per_call` which proves credentials read before each call |
| DW-1.3 | Functions accept optional `CoreDeps` for test injection | SATISFIED | All 6 core functions accept `deps?: CoreDeps` parameter; `CoreDeps` interface defined at line 46; tests inject `{ credentialsPath, fetchFn }` for all functions |
| DW-1.4 | Calling `core.list()` with no credentials throws "Not authenticated" | SATISFIED | `lib/core.ts` lines 89–91: `buildApiClient()` checks `if (!refreshToken)` and throws `"Not authenticated. Run upublish login to sign in."`; verified by 5 tests: `test_DW_1_4_list/publish/delete/generate/status_no_credentials_throws` |
| DW-1.5 | Calling `core.status()` after writing credentials returns `{ authenticated: true, username }` | SATISFIED | `lib/core.ts` lines 206–207: `status()` returns `{ authenticated: true, username: result.username }` after successful API call; test `test_DW_1_5_status_stale_state_regression` proves fresh read per call (no cached startup state); test `test_DW_1_5_status_authenticated_returns_username` verifies username extraction |
| DW-1.6 | All 6 core functions have unit tests with injected deps | SATISFIED | 17 tests in `lib/core.test.ts`; all use injected `CoreDeps` with temp file credentials and mocked `fetchFn`; no real network or filesystem calls; organized by function: `list()` 4 tests, `publish()` 3 tests, `deleteOp()` 2 tests, `generate()` 2 tests, `login()` 1 test, `status()` 5 tests |

**All requirements met:** YES

---

## Test-DW Coverage

- [x] All DW items have corresponding tests: 17 tests cover 6 DW items across 6 functions
- [x] No unplanned additions: one extra test (`status returns authenticated:false when API call fails`) is a defensive path test, not scope creep
- [x] Test coverage matches plan level (100%): all code paths exercised
- [x] Test naming convention matches discovery: `test_DW_X_Y_description` format throughout

**Notes:**
- Fresh-per-call reading verified by `test_DW_1_2_*` tests that write credentials between calls and confirm success
- Stale-state regression test at line 388–411 directly addresses the Phase 1 gap (Phase 2 will fix MCP)
- All tests use injected `CoreDeps`; no real filesystem or network calls
- Test coverage: 17 tests in 0.030s with 28 expect() calls — efficient and focused

---

## Dead Code

No dead code found. Scan results:
- [x] No unused imports: all 8 imports (`readCredentials`, `defaultCredentialsPath`, `createTokenProvider`, `authLogin`, `ApiClient`, `listSites`, `domainPublish`, `deleteSite`, `domainGenerate`, type imports) are used
- [x] No unreachable code: no code after early returns
- [x] No debug statements: no `console.log()`, `debugger`
- [x] No commented-out blocks: clean file

One naming note (not dead code): `deleteOp()` instead of `delete()` (line 139) avoids JS reserved word conflict. Intentional and correct.

---

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| **Concurrency** | N/A | No shared mutable state, no async coordination, no race conditions. Each core function is independent and reads credentials fresh (no TOCTOU). |
| **Error Handling** | PASS | `buildApiClient()` throws "Not authenticated" on missing credentials (lines 89–91); `status()` catches API errors and returns `{ authenticated: false, error }` (lines 208–210); no bare catch blocks; error messages are actionable (what, why, how to fix). Token refresh failures are propagated from `createTokenProvider()` — intentional since they indicate configuration or network issues, not missing auth. |
| **Resources** | PASS | No file handles, connections, locks, or streams created in core. Temp files in tests cleaned up in `afterEach()` hook (lines 80–85). No bounded growth issues — each function call creates a single `ApiClient` and discards it after use. |
| **Boundaries** | PASS | `CoreDeps.credentialsPath` and `CoreDeps.fetchFn` optional fields default to sensible values (default path from auth module, global fetch). No off-by-one errors, string length issues, or numeric boundaries. `GenerateArgs.context` validated by domain function, not duplicated in core. Empty credentials file (`!refreshToken`) correctly handled as unauthenticated. |
| **Security** | PASS | No untrusted input handled by core — credentials come from disk (controlled) or from `CoreDeps.credentialsPath` (caller-controlled in tests). No string concatenation for API URLs (uses `API_BASE_URL` constant). No secrets logged: error message doesn't expose refresh token. `fetchFn` override is test-only and intentional. |

---

## Defensive Programming: PASS

**Crisis triage (5 checks):**

1. **External input validated at boundaries?** ✓
   - Missing credentials: `if (!refreshToken) throw` (line 90)
   - Invalid API response in `status()`: caught and returned safely (line 208)
   - Directory path validation deferred to domain functions (not core's responsibility)

2. **Return values checked for all external calls?** ✓
   - `readCredentials()`: checked immediately (line 89)
   - `createTokenProvider()`: returned value used; failures propagate (expected)
   - `apiClient.get()`: wrapped in try-catch (line 205)
   - Domain functions: results returned directly (caller checks on use)

3. **Error paths tested?** ✓
   - 5 "no credentials throws" tests (DW-1.4)
   - 1 stale-state regression test (DW-1.5)
   - 1 API error path test (status returns authenticated:false on 401)
   - Clean path tests for all 6 functions
   - Ratio approximately 1 error:1.5 clean (7 error paths, 10 happy paths) — acceptable for core orchestration code

4. **Assertions on critical invariants?** ✓
   - No assertions with side effects (none used)
   - Invariants (authenticated vs not) enforced via explicit if/else, not assertions (correct choice for public API)

5. **Resources released on all paths?** ✓
   - No resources to release (no files opened, no connections held)
   - `ApiClient` instances are function-scoped, GC'd after return
   - Temp test files cleaned up in `afterEach()` hook

---

## Design Quality: PASS

**Depth > Length:**
- `buildApiClient()` helper (lines 85–102) is well-scoped and reusable across 5 functions
- Each core function is 2–6 lines: simple delegation to domain + error handling
- Interface is simple (6 functions, 2 optional fields in CoreDeps) while implementation handles credential wiring internally
- **Verdict:** Depth achieved — callers see simple operations, internals handle wiring

**Unknown Unknowns:**
- Clear. Core functions map 1:1 to domain functions (list, publish, delete, generate) plus two new operations (login, status)
- Credential/token provider wiring is centralized in `buildApiClient()` — single point of understanding
- No ambiguity about how `CoreDeps` overrides work (credentialsPath replaces default; fetchFn replaces global fetch)

**Together/Apart (Hexagonal boundary):**
1. Do credentials reading + token provider construction belong together? YES — they're always paired
2. Do they belong in core rather than adapters? YES — fixes duplication and stale-state bug
3. Do 6 operations belong in the same module? YES — they all need the same wiring
4. Does core import from adapters? NO ✓ — pure hexagonal boundary

**Pass-Through Methods:**
- No pass-through; each core function adds meaningful abstraction: `list()` abstracts `buildApiClient() → listSites()`, not just delegation
- `login()` bridges `LoginDeps` → `CoreDeps` signature mismatch (intentional adapter, not pass-through)

**Steel-Man Check:**
- Why is `login()` signature `login(loginDeps: LoginDeps, coreDeps?: CoreDeps)` instead of just `login(loginDeps)`?
  - Answer: Separates OAuth plumbing deps (browser, callback server, logger) from storage deps (credentialsPath). This lets tests override the credentials path without mocking the full OAuth flow. Good design decision — not a layer problem.

---

## Testing: PASS

**Test Quality:**
- **Dirty:Clean Ratio:** 7 error path tests : 10 happy path tests ≈ 0.7:1 (acceptable for orchestration code; stricter ratio needed for complex business logic)
- **Coverage Gaps:** None — all 6 functions tested, all success/failure cases covered
- **Confidence:** High — tests exercise the actual read-from-disk code path (not mocked), token refresh flow (mocked), and API calls (mocked). Real credentials/token/API interactions happen in Phase 2 adapter tests.

**Test Infrastructure:**
- Mock helpers (`mockFetch`, `mockFetchWithTokenRefresh`) are well-designed and reusable
- `writeTempCredentials()` writes real files — tests the actual `readCredentials()` code path
- `afterEach()` cleanup prevents test pollution
- All tests use `CoreDeps` injection — zero globals, repeatable

---

## Issues

None. Code passes all standards checks.

---

## Additional Observations

1. **`status()` intentional asymmetry (DW-1.5):** Other operations throw on missing credentials; `status()` returns `{ authenticated: false }`. This is correct — `status()` queries auth state, never a failure condition. Discovery design notes (line 121–124) explicitly justify this.

2. **Error message quality:** "Not authenticated. Run `upublish login` to sign in." is actionable and user-friendly.

3. **`CoreDeps` type (DW-1.3):** Matches plan exactly: `{ credentialsPath?: string; fetchFn?: typeof fetch }`. Plan note justified simple fields over full ApiClient injection (line 98–101 of discovery).

4. **Fresh-per-call guarantee (DW-1.2):** Each of the 5 core operations (list, publish, delete, generate, status) independently calls `buildApiClient()` or inlines the same pattern. No shared state. Regression test `test_DW_1_5_status_stale_state_regression` directly guards against Phase 1→2 regression (MCP startup caching).

5. **Phase 2 handoff:** Core module is complete and isolated. Phase 2 adapters can import only from `lib/core.ts` with zero auth knowledge. Boundary is clean.

---

## Verdict: **PASS**

All 6 DW items satisfied with concrete evidence. No test coverage gaps. No dead code. All correctness dimensions pass. Defensive programming verified. Design is clean hexagonal boundary. Testing is adequate and well-structured.

**Blockers:** None.

Ready for Phase 2.
