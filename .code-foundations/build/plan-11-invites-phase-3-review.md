VERDICT: PASS

# plan-11-invites Phase 3 review — commit 763398a (parent 8c4cd2b), upublish.skill worktree `invites`

Independent reviewer. Spec: plan-11-invites.md Phase 3 (DW-3.1, DW-3.2) + Context. Contract:
upublish-backend worktree `invites`, packages/server/src/api/invites.ts (mounted at `/api`, index.ts:372).

## Evidence summary

| Check | Result |
|---|---|
| `bun test` | exit 0 — 2113 pass, 0 fail, 85 files |
| `bun run typecheck` (`tsc --noEmit -p .`) | exit 0 |
| dist sync: `bun build mcp/index.ts --target=bun --outfile=<scratchpad>/mcp-review.js` then `cmp` with dist/mcp.js | identical; dist/mcp.js is mode 755 |
| Hexagonal: mcp/index.ts imports | only `../lib/core.ts` (index.ts:20-85, 86-108) plus the pre-existing `../lib/log.ts` (index.ts:19, from d578971, not this commit). Commit adds only `PendingInvite` to the core type import. |

## 1. Contract correctness — PASS

- Create: `POST /api/ns/${nsId}/invites` body `{role}` (lib/members.ts createInvite) == backend invites.ts:128, 137-156 (role optional, admin|user). 201 `{invite:{id,role,created_at,expires_at}, token, url}` (invites.ts:180-186) — skill reads `response.invite` + `response.url`, drops `token`.
- List: `GET /api/ns/${nsId}/invites` → `{invites:[{id, role, created_by_username, created_at, expires_at, paused}]}` (invites.ts:191-196; shared db/index.ts:2034-2050). Skill whitelists exactly those six fields.
- Revoke: `DELETE /api/ns/${nsId}/invites/${encodeURIComponent(id)}` (members.ts:389) == invites.ts:200; 200 `{ok}` / 404 `invite_not_found` (invites.ts:209-213).
- Errors: 400 `invalid_request`, 403 `forbidden` | `account_restricted` | `teams_unavailable`, 404 `not_found` | `invite_not_found`, 422 `collaborator_limit` — all mapped by status+code in inviteError (members.ts:278-321), matching invites.ts:56-60, 120-125, 139-165, 210.
- Claim/preview are correctly NOT exposed (Context: "claiming stays in the browser"); tool description says so.

## 2. Security — PASS

- The URL appears only in the create output (mcp/index.ts invite branch). `createInvite` returns a rebuilt object with no `token` key.
- `listInvites` rebuilds each row from six named fields, so a stray `url`/`token` from a misbehaving server is dropped; the MCP listing prints id/role/creator/expiry/paused only.
- Revoke output echoes only the caller-supplied invite id (mcp/index.ts:2058).
- Every error message comes from status/code, never from the response body or `err.message` (members.ts:278-321). Transport errors (TypeError / system errors with `code`), which may name the request URL, are replaced with a fixed message. The original ApiError is kept only as `cause`, and errResponse prints only `.message` (mcp/index.ts:216-224).
- Owner role is rejected before any request at two layers: the zod enum `["admin","user"]`, the handler check in mcp/index.ts invite branch, and createInvite's guard (members.ts, `role !== "admin" && role !== "user"`).
- The admin warning text matches the plan's exact sentence and is emitted only when `result.invite.role === "admin"`. The once/7-day note is always emitted.

## 3. Hexagonal rule — PASS (see table)

## 4. Tests prove the DW items — PASS

Mutation reasoning (would the test fail if the guarded behavior broke?):
- Token returned → `expect("token" in result).toBe(false)` (lib/members.test.ts, core-members.test.ts) fails.
- Listing passes extra fields through (e.g. a `...i` spread) → `toEqual` on the whitelisted shape plus the `SECRET_RE` assertions (lib/members.test.ts, tests/mcp.members.test.ts) fail, because the fixtures inject `url` and `token` into list rows.
- An error built from the body or err.message → every ERROR_CASES row uses a body whose `error` embeds URL+token, across all three ops, and asserts `not.toMatch(SECRET_RE)`. Network errors embedding the URL are covered too.
- Owner rejection → asserts zero fetch calls at both the lib and the MCP handler layer; the schema test asserts `role.safeParse("owner")` fails.
- Admin warning: present for admin and absent for user (both asserted). Default role user: the request body is asserted as `{"role":"user"}`.
- Revoke: method, path and the encoded id are asserted, plus empty-id rejection before any request.

## 5. dist in sync — PASS (byte-identical rebuild)

## 6. Hosted-MCP safety — PASS (by inspection), coverage gap non-blocking

`members` is a hosted tool (tests/mcp-hosted-local-files.test.ts:36). The new branches call only `members()` → `buildApiClient` / `resolveNamespace` / ApiClient. There is no fs, `open`, or credential-file access in the new code. `leave` had no hosted-specific test either. The new actions follow that precedent and inherit the tool-level hosted guarantees, but no hosted test exercises them (see N2).

## Findings

### Blocking
None.

### Non-blocking (ranked)

N1. **references/managing.md not updated** (file scope lists it; managing.md:62 still names only list/add/remove/role/leave). Scenario: an AI follows SKILL.md → managing.md for "invite my teammate" and reads that teammates need an existing account. It falls back to `add` → 404 `user_not_found` and never discovers `invite` unless it reads the tool description. Not a DW-3.x item, and the plan defers docs to cmd-docs, but this file was in this phase's scope. Recommend a one-line addition.

N2. **No hosted-mode test for the new actions** (tests/mcp-hosted-local-files.test.ts has none for members invite/invites/revoke, the same as for leave). Scenario: a future refactor adds a local cache file for invite ids or opens the URL in a browser (`open`) on create, and nothing in the hosted suite catches it. Suggest one hosted call of `members {action:"invite"}` with recordingFetch, asserting no fs writes and no `open`.

N3. **The error-body log line can hold attacker or server text** (lib/api-client.ts:286 logs raw non-2xx bodies to ~/.upublish/publish.log; hosted servers disable file logging). The real backend never puts the token in an error body, and the skill never sends a token, so this is not a live leak. But the "never in logs" guarantee rests on server behavior, not on the client. The tests that inject URL/token into error bodies also append those fake values to the developer's real publish.log unless HOME is redirected. Scenario: a future backend bug echoes the create response into a 5xx body, and the URL lands in publish.log. Optional hardening: pass `sensitive` for invite calls (post/delete/get would need the option).

N4. **revoke accepts a pasted join URL or token as invite_id** (lib/members.ts:380-389). Scenario: the user says "revoke https://upubli.sh/join#<token>" and the AI passes it as invite_id. The skill sends `DELETE /api/ns/:id/invites/https%3A%2F%2F...%23<token>`, which puts the live token in a URL path, and so in Caddy/server access logs. The plan's Rejected Approaches forbid exactly that. The server 404s, so the invite is not revoked, and the token is now in logs. Cheap guard: reject an invite_id that matches `/[#/:]|^[A-Za-z0-9_-]{43}$/` before the request, with "use the invite id from action 'invites', not the link".

N5. **The 400 message is create-specific** (members.ts:293-296). It says "An invite link can make someone a member ('user') or an 'admin'", even for list/revoke, where a 400 can't come from the role. Cosmetic.

## Follow-up (cmd-console2, 2026-11-08)
- N4 FIXED: `revokeInvite` accepts only a UUID invite id (server ids are crypto.randomUUID) and refuses a pasted join link/token/other string BEFORE any request. New test `test_DW_3_2_revoke_refuses_a_pasted_link_or_token_before_any_request` fails on 763398a (0 pass/1 fail) and passes after. Test fixtures for revoke moved to a real UUID.
- N1 deferred to cmd-docs (owner of references/*.md); proposed text in status-console.md.
- N2, N3, N5 accepted as non-blocking. N3: api-client error-body logging is outside this phase's file scope; the backend never returns the token in an error body.
- Gate after fix: bun test 2114/0 exit 0; typecheck 0; dist/mcp.js rebuilt.
