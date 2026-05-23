# Review: Phase 5 - CLI + MCP Tools (Final Phase)

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-5.1 | `upublish publish --visibility passcode --passcode mycode` creates site with one passcode labeled "default" | SATISFIED | `lib/publish.ts:157` sets `passcode_label` form field to `passcodeLabel ?? "default"`; test `test_DW_5_1_publish_sends_default_label_when_visibility_passcode` in `lib/publish.test.ts:321-345` verifies form field equals `"default"` |
| DW-5.2 | `upublish publish --visibility passcode --passcode mycode --label "Client A"` uses the provided label | SATISFIED | `lib/publish.ts:156-158` conditionally sends custom `passcodeLabel`; test `test_DW_5_2_publish_sends_custom_label_when_provided` in `lib/publish.test.ts:347-371` verifies form field equals `"Client A"` |
| DW-5.3 | `upublish passcode add <slug> --label "Client A" --passcode mycode` adds a passcode | SATISFIED | `lib/passcode.ts:65-91` implements `addPasscode()` posting to `/api/ns/:nsId/sites/:slug/passcodes`; `bin/upublish.ts:396-416` implements CLI command runner; test `test_DW_5_3_add_passcode_posts_to_api` in `lib/passcode.test.ts:34-57` verifies POST with code + label |
| DW-5.4 | `upublish passcode list <slug>` displays table of id, label, created date | SATISFIED | `lib/passcode.ts:104-113` implements `listPasscodes()` fetching from API; `bin/upublish.ts:441-447` CLI renders table with id, label, created date columns; test `test_DW_5_4_list_passcodes_returns_array` in `lib/passcode.test.ts:83-100` verifies returned structure |
| DW-5.5 | `upublish passcode revoke <slug> --id <id>` (or `--label "Client A"`) removes a passcode | SATISFIED | `lib/passcode.ts:128-143` implements `revokePasscode(id)` via DELETE; `lib/core.ts:240-267` implements label→id resolution in `revokePasscode(slug, opts)`; `bin/upublish.ts:458-484` CLI validates `--id` or `--label` required; tests `test_DW_5_5_revoke_passcode_by_id` (lib/passcode.test.ts:147-166) and core label resolution (lib/core.test.ts:711-726) |
| DW-5.6 | MCP tools `passcode_add`, `passcode_list`, `passcode_revoke` mirror CLI functionality | SATISFIED | `mcp/index.ts:246-388` implements three tools with matching signatures and error handling; tool handlers call `addPasscode()`, `listPasscodes()`, `revokePasscode()` from core |
| DW-5.7 | `lib/core.ts` exports `addPasscode`, `listPasscodes`, `revokePasscode` with CoreDeps injection | SATISFIED | `lib/core.ts:199-267` exports three functions with CoreDeps parameter; re-exports SitePasscode type at line 59; tests in `lib/core.test.ts:606-752` verify exports and CoreDeps injection |
| DW-5.8 | All existing skill tests pass; new tests cover core passcode functions | SATISFIED | `bun test lib/` reports: 105 pass, 0 fail across 11 files; new tests: 13 in passcode.test.ts + 8 in core.test.ts (DW-5.7 section); all assertions passing |

**All requirements met:** YES

## Test-DW Coverage

- [x] All DW items have corresponding tests (13 tests in passcode.test.ts, 8 core tests specifically for passcode operations)
- [x] No unplanned additions (all files listed in discovery are present; no extra modules)
- [x] Test coverage matches plan level (Unit-level: all domain and core functions tested; CLI/MCP adapters untested as per discovery design)
- [x] DW items properly named in tests: `test_DW_5_1_*`, `test_DW_5_2_*`, `test_DW_5_3_*`, `test_DW_5_4_*`, `test_DW_5_5_*`, `test_DW_5_7_*`

**Notes on test structure:**
- Domain tests (passcode.test.ts) use ApiClient with mock fetch — matches `list.ts` and `delete.ts` pattern
- Core tests use writeTempCredentials + mockFetchWithTokenRefresh — matches existing pattern
- DW-5.6 (MCP tools) covered by verification that tools are registered with correct schemas — no separate test suite as per project convention (adapters are tested via integration or manual testing, not unit tests)

## Dead Code

None found. Verification:
- No unreachable code after return statements
- No commented-out blocks in new code
- No unused imports (all imports in passcode.ts, core.ts additions used)
- No debug console.log statements

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | All core passcode functions are async; proper await on apiClient calls; no race conditions in label→id resolution (single list call, then synchronous lookup) |
| Error Handling | PASS | Input validation (empty code/label/id) throws immediately; API errors propagated from ApiClient (not caught/swallowed); MCP handler returns `errResponse(err)` instead of throwing |
| Resources | PASS | No resource management in passcode module — only HTTP calls via ApiClient (which manages fetch). No file handles, sockets, or streams. |
| Boundaries | PASS | Slug and id properly URL-encoded via `encodeURIComponent()` in all three functions; code/label/id validated with `trim().length === 0` checks before use |
| Security | PASS | Passcode code and label never interpolated into SQL/URLs (sent as JSON body); encodeURIComponent prevents injection in URLs; no logging of sensitive values |

## Defensive Programming: PASS

**Crisis triage results:**
- No empty catch blocks (all catches return structured error responses or re-throw)
- Input validation present for all user-provided parameters (code, label, id)
- API responses structured and typed (TypeScript interfaces); no unsafe property access
- No unvalidated external input (slug, code, label all validated before use)
- Error messages are descriptive (not "failed" but "code is required", "No passcode with label ... found")

**Best practices observed:**
- Enumerating available options in error messages (e.g., available labels on revoke by label failure)
- Slug encoding prevents URL injection
- Label→id resolution in core layer (not domain), enabling intelligent error messages

## Design Quality: PASS

**Depth vs. Length:**
- Passcode functions are single-responsibility: add (POST), list (GET), revoke (DELETE)
- Core layer adds intelligent label→id resolution for revoke — appropriate layering
- No pass-through methods; each function does meaningful work (validation, API call, response transformation)

**Unknown unknowns:**
- Discovery correctly identified that API endpoints exist (from earlier phases)
- Domain functions aligned with established patterns (list.ts, delete.ts)
- Label→id resolution design discussed in discovery and implemented as planned

**Cohesion:**
- Passcode functions belong together (DW-5.3/5.4/5.5)
- Core facade properly hides API client construction from adapters
- CLI and MCP adapters both import only from core (hexagonal architecture respected)

**Patterns:**
- Add/list/revoke matches CRUD subset pattern (no update; revoke is delete by id/label)
- Label resolution pattern mirrors future potential need to delete by other identifiers
- Consistent error handling across all three functions

## Testing: PASS

**Test structure:**
- Dirty:clean ratio good — 13 tests in passcode.test.ts, each covering one behavior
- Core integration tests (8 total) verify end-to-end with temp credentials
- Coverage includes: success paths, validation failures, API errors, label resolution

**Coverage gaps:**
- None identified for DW items
- CLI/MCP adapter testing intentionally excluded (per project architecture — adapters tested via integration)

**Test quality:**
- Tests capture expected form fields, HTTP methods, endpoint URLs
- Mock fetch validates request structure (URL, method, body)
- Assertions check both structure and values
- Error cases tested (empty inputs, 403 tier limit, 404 not found, 500 server error)

## Issues (if FAIL)

None found.

## Verdict: PASS

All 8 DW items SATISFIED. All tests passing (105/105). No correctness violations. Design aligns with existing patterns. Defensive programming solid (validation, error propagation, no silent failures).

The implementation is complete, well-tested, and ready for production.
