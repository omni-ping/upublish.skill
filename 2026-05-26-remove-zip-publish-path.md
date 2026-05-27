# Plan: Remove zip publish path, make presigned uploads the default
**Created:** 2026-05-26
**Status:** ready
**Complexity:** medium
---
## Context
upublish has two publish paths — a zip-based flow through the Linode and a presigned-URL flow direct to R2. The zip path makes the Linode a data pipe, which doesn't scale and adds latency. The presigned path is strictly better but currently opt-in via `--incremental`.

## Constraints
- No breaking change to the publish UX — users shouldn't need to change anything
- Passcode-on-publish must keep working (currently missing from manifest+finalize flow)
- Legacy sites (live_version=null) can be ignored
- Preview/staging must keep working
- Backend `fflate` dependency stays (tar.gz archiving still needs it)
- Skill `fflate` dependency is removed (only used by zip building)

## Chosen Approach
**Add passcode to manifest+finalize, then delete zip path** — Feature parity first, then remove. Minimizes risk by ensuring the new-only path handles all cases before the old path is removed. **Fallback:** If passcode wiring is complex, ship deletion first and require separate `passcode_add` call.

## Rejected Approaches
- **Drop passcode-on-publish:** Would degrade UX for passcode-protected sites by requiring a separate API call after every publish.
- **Keep zip as --legacy fallback:** Adds maintenance burden for a path we want dead. If presigned works, ship it.

---
## Implementation Phases

### Phase 1: Backend — Add passcode support to manifest+finalize
**Model:** sonnet
**Skills:** `code-foundations:cc-defensive-programming`, `code-foundations:cc-pseudocode-programming`

**Goal:** Wire passcode and passcode_label through the manifest → session → finalize pipeline so passcode-on-publish works without the zip endpoint.

**Scope:**
- IN: Add `passcode` and `passcode_label` to `PublishOptions` interface, manifest body parsing, session storage, and finalize passcode creation
- OUT: Zip endpoint deletion (Phase 2), skill changes (Phase 3)

**Approach notes:** Follow the exact pattern from the zip handler (namespace-sites.ts lines 616-622): hash passcode with `hashPasscode()`, call `createPasscode(db, siteId, label, hash)`. Validate minimum length (4 chars) at the manifest barricade. Tier gate already exists in manifest for visibility=passcode.

**File hints:**
- `packages/server/src/api/manifest-diff.ts` — `PublishOptions` interface, `SessionData`
- `packages/server/src/api/namespace-sites.ts` — manifest body parsing (~line 842), finalize handler (~line 1102)

**Depends on:** nothing | **Unlocks:** Phase 2

**Done when:**
- [ ] DW-1.1: `PublishOptions` interface includes `passcode?: string` and `passcode_label?: string`
- [ ] DW-1.2: Manifest endpoint parses `passcode` and `passcode_label` from request body, validates length >= 4 when present
- [ ] DW-1.3: Finalize endpoint creates `site_passcodes` entry when session has passcode (hashed, same pattern as zip handler)
- [ ] DW-1.4: Tests cover passcode-on-publish through manifest+finalize flow (happy path + validation)

**Difficulty:** LOW
**Uncertainty:** None

---

### Phase 2: Backend — Delete zip upload endpoint
**Model:** sonnet
**Skills:** `code-foundations:cc-refactoring-guidance`

**Goal:** Remove the entire `POST /api/ns/:nsId/sites` zip upload handler and all code only reachable from it.

**Scope:**
- IN: Delete zip handler (lines 222-687), delete `extractZip()` from archive.ts, delete `makeZip()` test helper and all zip-path tests, remove zip-specific imports
- OUT: Keep `extractTarGz()`, `createTarGz()`, `extractArchive()` dispatcher (used by versioning). Keep `fflate` dependency (tar.gz). Keep all manifest/finalize tests.

**Approach notes:** The entire `router.post("/ns/:nsId/sites", ...)` block is deleted — not refactored, not shrunk. The route itself ceases to exist. Any test importing `makeZip()` or posting multipart to `/api/ns/:nsId/sites` is deleted. The `extractArchive()` function in archive.ts should be checked: if `extractZip` is the only zip caller, remove it and simplify the dispatcher to only handle tar.gz.

**File hints:**
- `packages/server/src/api/namespace-sites.ts` — lines 222-687 (the handler)
- `packages/server/src/api/archive.ts` — `extractZip()` helper
- `packages/server/src/api/namespace-sites.test.ts` — `makeZip()` helper and all zip upload test blocks (the `POST /api/ns/:nsId/sites` describe group)

**Depends on:** Phase 1 | **Unlocks:** Phase 3

**Done when:**
- [ ] DW-2.1: `POST /api/ns/:nsId/sites` route no longer exists
- [ ] DW-2.2: `extractZip()` function deleted from archive.ts
- [ ] DW-2.3: All tests that posted multipart archives to the zip endpoint are deleted
- [ ] DW-2.4: No dead imports remain (unused imports from the deleted handler)
- [ ] DW-2.5: `bun test --cwd packages/server` passes with no failures
- [ ] DW-2.6: `extractArchive()` simplified or updated to reflect zip extraction removal

**Difficulty:** LOW
**Uncertainty:** Test file dependencies — some test helpers may be shared across zip and non-zip tests

---

### Phase 3: Skill — Consolidate to single publish path
**Model:** sonnet
**Skills:** `code-foundations:cc-refactoring-guidance`

**Goal:** Make the presigned-URL flow the only publish path: delete zip publish function, rename incremental to publish, remove the `--incremental` flag, delete `fflate` dependency, delete `postForm`.

**Scope:**
- IN: Delete `publish()` (zip path) from publish.ts, rename `publishIncremental()` → `publish()`, simplify core.ts routing (remove incremental branch), remove `incremental` from MCP tool schema and `PublishArgs`, delete `postForm` from api-client.ts, remove `fflate` from package.json, delete zip-path tests, rename incremental test file
- OUT: Exclusion logic (shared, stays as-is), `collectFilesWithHashes` (stays), api-client `manifest`/`finalize` methods (stay)

**Approach notes:** The fallback `catch` in `publishIncremental()` (line 567-571) that falls back to `publish(opts)` must be removed — there's no zip path to fall back to. Errors from the manifest endpoint should propagate to the caller. The `incremental` field in MCP schema and PublishArgs type is removed entirely — the flag never appears in the UI.

**File hints:**
- `lib/publish.ts` — delete `buildZipFromDirectory` (253-289), delete `publish()` (414-479), rename `publishIncremental` → `publish`, remove fflate import
- `lib/core.ts` — remove `incremental` from `PublishArgs`, simplify routing (lines 220-226)
- `mcp/index.ts` — remove `incremental` from zod schema (lines 236-244)
- `lib/api-client.ts` — delete `postForm` method (lines 61-73)
- `lib/publish.test.ts` — delete entire file (zip-only tests)
- `lib/incremental-publish.test.ts` — rename to `publish.test.ts`, update any references to "incremental"
- `package.json` — remove `fflate` dependency

**Depends on:** Phase 2 | **Unlocks:** Phase 4

**Done when:**
- [ ] DW-3.1: `publish()` in publish.ts is the presigned-URL flow (no zip code remains)
- [ ] DW-3.2: No `incremental` flag in `PublishArgs`, MCP schema, or core.ts routing
- [ ] DW-3.3: `fflate` removed from package.json
- [ ] DW-3.4: `postForm` deleted from api-client.ts and its test
- [ ] DW-3.5: `buildZipFromDirectory` deleted
- [ ] DW-3.6: Old `publish.test.ts` (zip tests) deleted; incremental tests renamed to `publish.test.ts`
- [ ] DW-3.7: No fallback to zip in the publish flow — manifest errors propagate
- [ ] DW-3.8: `bun test lib/` passes with no failures

**Difficulty:** MEDIUM
**Uncertainty:** Test rename may require updating imports or DW-IDs in test descriptions

---

### Phase 4: Cross-repo verification
**Model:** sonnet
**Skills:** `code-foundations:aposd-verifying-correctness`, `code-foundations:cc-quality-practices`

**Goal:** Verify the full publish flow works end-to-end across both repos, and that no dead code or broken references remain.

**Scope:**
- IN: Run all tests in both repos, check for dead imports/exports, verify version bumps
- OUT: Deployment (push to main triggers CI/CD)

**File hints:**
- `upublish-backend/` — `bun test`
- `upublish.skill/` — `bun test lib/`

**Depends on:** Phase 3 | **Unlocks:** nothing

**Done when:**
- [ ] DW-4.1: `bun test` passes in upublish-backend (all packages)
- [ ] DW-4.2: `bun test lib/` passes in upublish.skill
- [ ] DW-4.3: No unused imports or exports flagged by TypeScript
- [ ] DW-4.4: Version bumped in both repos (backend patch, skill minor)
- [ ] DW-4.5: Passcode-on-publish works end-to-end through the new flow (manifest sends passcode, finalize creates entry)

**Difficulty:** LOW
**Uncertainty:** None

---
## Test Coverage
**Level:** 100%
## Test Plan
- [ ] Backend: passcode-on-publish via manifest+finalize (happy path, validation errors, tier gate)
- [ ] Backend: all existing manifest+finalize tests still pass after zip deletion
- [ ] Backend: `POST /api/ns/:nsId/sites` route no longer registered
- [ ] Skill: publish() uses manifest+presigned flow by default (no flag needed)
- [ ] Skill: passcode option passed through manifest body
- [ ] Skill: error from manifest endpoint propagates (no silent fallback)
- [ ] Integration: incremental-publish-integration.test.ts still passes

## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| No external consumers call POST /api/ns/:nsId/sites directly | HIGH | Phase 2 | Add deprecation period with warning header |
| fflate is only used for zip in skill repo | HIGH | Phase 3 | Grep before deleting |
| Incremental tests cover all scenarios the zip tests covered | MEDIUM | Phase 2 | Port missing test scenarios before deleting zip tests |

## Decision Log
| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Add passcode to manifest+finalize | Drop passcode-on-publish | Feature parity — users expect one-step publish with passcode | 1 |
| Delete postForm from ApiClient | Keep as generic utility | YAGNI — no other callers, easy to re-add | 3 |
| Delete zip endpoint entirely | Keep as --legacy fallback | Maintenance burden, contradicts goal of simplifying | 2 |

---
## Notes
- The zip endpoint is ~465 lines — this is primarily a deletion task
- `extractArchive()` dispatcher in archive.ts may need simplification after zip removal
- Backend `fflate` stays for tar.gz archiving; only skill `fflate` is removed
- Phases 1-2 are backend-only, Phase 3 is skill-only — clean repo boundaries
- The `postForm` test in api-client.test.ts should be deleted along with the method
---
## Execution Log
_To be filled during /code-foundations:build_
