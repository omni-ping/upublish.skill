# Discovery + Design: Phase 5 - CLI + MCP Tools

## Files Found
- `lib/types.ts` — `Visibility` already includes `"passcode"`, `Site` has `passcode_hash`. No `SitePasscode` type exists yet.
- `lib/core.ts` — exports `list`, `publish`, `deleteOp`, `login`, `status`, `logout`. No passcode functions yet.
- `lib/publish.ts` — `PublishOpts` has `passcode?: string` but no `passcodeLabel`. Sends `passcode` form field. No `label` field.
- `lib/list.ts` — `listSites(apiClient, nsId)` pattern to follow.
- `lib/delete.ts` — `deleteSite(apiClient, nsId, slug)` pattern to follow.
- `lib/api-client.ts` — has `get`, `post`, `postForm`, `delete` methods. `post` sends JSON body.
- `bin/upublish.ts` — citty CLI with subcommands. No `passcode` subcommand group yet.
- `mcp/index.ts` — `createServer(coreDeps?)` registers tools with zod schemas. No passcode tools yet.

## Current State
- 82 tests pass, 0 fail.
- `Visibility` type already has `"passcode"` — no change needed there.
- `publish` already sends `passcode` form field — just needs `label` added.
- No `SitePasscode` type, no passcode domain functions, no CLI subcommand group, no MCP tools.

## Gaps
- Plan says "add `SitePasscode` type, update `Visibility`" — `Visibility` already correct, only `SitePasscode` type is missing.
- `PublishOpts` in `publish.ts` needs `passcodeLabel?: string` field and the form POST must send it.
- `PublishArgs` in `core.ts` needs `passcodeLabel?: string`.
- `PublishArgs` in `bin/upublish.ts` needs `label?: string` for the CLI flag.

## Code Standards
No `docs/code-standards.md` found. Conventions derived from codebase:
- Files: `kebab-case.ts`, single responsibility per file
- Types: interfaces mirror DB columns (`snake_case`), TypeScript `interface` not `type` for objects
- Module pattern: domain function file exports a named function + result/opts interfaces; `core.ts` wraps it
- Tests: `describe("DW-N.M: label", () => { it("test_DW_N_M_snake_name", ...) })`
- No throwing for expected failures in core — structured results where sensible, throws for auth and validation errors
- Comments: JSDoc with `@param`, `@returns`, `@throws`
- Adapters import only from `lib/core.ts`

## Test Infrastructure
- Bun test runner (`bun test lib/`)
- Pattern: `ApiClient` constructed with `staticTokenProvider` + `mockFetch` for domain tests
- Pattern: `writeTempCredentials` + `mockFetchWithTokenRefresh` for core.ts integration tests
- No test framework for CLI/MCP adapters — unit tests live in `lib/` only

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-5.1 | `upublish publish --visibility passcode --passcode mycode` creates site with one passcode labeled "default" | COVERED | test_DW_5_1_publish_sends_passcode_label_default (in lib/publish.test.ts or core.test.ts — verifies label="default" in form data) |
| DW-5.2 | `upublish publish --visibility passcode --passcode mycode --label "Client A"` uses provided label | COVERED | test_DW_5_2_publish_sends_custom_label (verifies label="Client A" in form data) |
| DW-5.3 | `upublish passcode add <slug> --label "Client A" --passcode mycode` adds a passcode | COVERED | test_DW_5_3_add_passcode_posts_to_api (verifies POST /api/ns/:nsId/sites/:slug/passcodes with body) |
| DW-5.4 | `upublish passcode list <slug>` displays table of id, label, created date | COVERED | test_DW_5_4_list_passcodes_returns_array (verifies GET and returned shape) |
| DW-5.5 | `upublish passcode revoke <slug> --id <id>` (or `--label`) removes passcode | COVERED | test_DW_5_5_revoke_passcode_by_id, test_DW_5_5_revoke_passcode_by_label |
| DW-5.6 | MCP tools `passcode_add`, `passcode_list`, `passcode_revoke` mirror CLI | COVERED | Verified by createServer exporting named tools (schema check in test) |
| DW-5.7 | `lib/core.ts` exports `addPasscode`, `listPasscodes`, `revokePasscode` with CoreDeps | COVERED | test_DW_5_7_core_exports_add_passcode, test_DW_5_7_core_exports_list_passcodes, test_DW_5_7_core_exports_revoke_passcode |
| DW-5.8 | All existing skill tests pass; new tests cover core passcode functions | COVERED | All 8 new tests + regression run of bun test lib/ |

**All items COVERED:** YES

## Design Decisions

### New domain module: `lib/passcode.ts`
Follows the same pattern as `lib/list.ts` and `lib/delete.ts`:
- Exports `addPasscode(apiClient, nsId, slug, code, label)`, `listPasscodes(apiClient, nsId, slug)`, `revokePasscode(apiClient, nsId, slug, id)`
- Exports `AddPasscodeResult`, `ListPasscodesResult`, `RevokePasscodeResult`, `SitePasscode`
- Simple, thin wrappers around `apiClient.post/get/delete`

### `revokePasscode` by label
The API only supports DELETE by id (`DELETE /api/ns/:nsId/sites/:slug/passcodes/:id`). To support `--label`, the `revokePasscode` domain function will accept only `id` — the label→id resolution lives in `core.ts` using `listPasscodes` then looking up the id.

Design choice: keep domain functions thin (one API call each). Core handles label→id lookup when needed. This avoids the domain function making two API calls and keeps it aligned with the delete.ts pattern.

### `publish` label default
When `visibility === "passcode"` and no `passcodeLabel` is provided, default to `"default"`. The default is applied in `publish.ts` (domain layer), not in the CLI adapter, so it works consistently for MCP callers too.

### CLI subcommand group
`citty` supports nested subcommands via `defineCommand` with `subCommands`. The `passcode` group will be a command with three subcommands: `add`, `list`, `revoke`. Registered in the `main` command's `subCommands`.

## Prerequisites
- [x] Required files exist (or will be created: `lib/passcode.ts`, `lib/passcode.test.ts`)
- [x] Dependencies available (no new deps needed)
- [x] Bun test infrastructure working (82 pass)

## Recommendation
BUILD
- Create `lib/passcode.ts` with `SitePasscode` type + three domain functions
- Create `lib/passcode.test.ts` with red-green tests for DW-5.3/5.4/5.5/5.7
- Update `lib/publish.ts`: add `passcodeLabel` to `PublishOpts`, default to `"default"` when visibility=passcode
- Update `lib/core.ts`: add `passcodeLabel` to `PublishArgs`; add `addPasscode`, `listPasscodes`, `revokePasscode` exports; re-export `SitePasscode`
- Update `bin/upublish.ts`: add `--label` flag to publish; add `passcode` subcommand group
- Update `mcp/index.ts`: add `passcode_add`, `passcode_list`, `passcode_revoke` tools
