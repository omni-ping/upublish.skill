# Plan: Team collaboration — fixes + leave (issue #11, cmd-console)
**Created:** 2026-11-08
**Status:** ready
**Complexity:** medium
**Review cadence:** 2
**Check-ins:** quiet
---
## Context
**Problem:** Teams already ship (audit: `audit-11-teams.md`), but the dashboard has user-facing bugs that need no product
decision: (a) the Members tab gates on the VIEWER's tier while the backend gates on the address OWNER's tier — admins
of a Max owner's address are locked out, and a Max admin of a non-Max address sees a form that 403s; (b) shared
addresses look identical to owned ones; (c) rename/delete-address controls show to non-owners and 403; (d) adding
someone without an account gives a bare "User not found"; (e) the non-Max notice has no way forward.

**Success criteria:** the Members tab reflects what the server will actually allow for this address; shared addresses
are labelled with the viewer's role; non-owners don't see owner-only controls; failures explain the next step.

## Decisions in scope (the general, 2026-11-08)
- Leave: any member (admin or user) can remove themselves; the owner cannot leave.

## Constraints
- Charter OP2: never push to main; one branch per repo; backend ships before the website consumes the new field.
- Website consumes the new field additively (absent → today's behavior), so the website can ship in either order safely.
- Invites and the activity log ship on their own branches (separate plans). Caps unchanged.
- Marketing/docs copy (Features card, docs/managing) belongs to cmd-docs — sent to them, not edited here.
- Gates: backend `bun test` (all packages) + typecheck as in its CLAUDE.md; website `bun run test`, `bun test src/lib`,
  `bun run check`, `bun run build` — exit codes checked.

## Chosen Approach
**Server says what the address allows.** `GET /api/ns/:nsId/members` adds `teams: { available, max, count }` computed
from the OWNER's limits (same rule as the POST gate). The website reads it. **Fallback:** if absent, keep today's
viewer-tier logic.

## Rejected Approaches
- **Expose the owner's tier string:** leaks billing detail to members; `available/max/count` is all the UI needs.
- **Fetch the owner's space from the website:** no such endpoint for non-owners, by design.

---
## Implementation Phases

### Phase 1: Backend — members list reports what the address allows
**Repo:** upublish-backend, branch `feature/members-teams-status` off origin/main
**Skills:** code-foundations:cc-defensive-programming
**Model:** sonnet
**Gate:** Standard
**Depends on:** none
**File scope:** packages/server/src/api/members.ts, packages/server/src/api/members-teams-status.test.ts (new), packages/shared/src/types/** (only if MemberEntry/response types live there)

**Goal:** `GET /api/ns/:nsId/members` returns `teams: { available: boolean; max: number | null; count: number }`.

**Scope:**
- IN: extract ONE helper `teamsPolicy(space, ownerUser) -> { available, max }` used by the POST route for BOTH the 403
  tier gate and the cap check, keeping the POST's order (suspended-caller check, authorize, parse, tier gate, lookup,
  …). `available` = the gate result (`space.tier === 'max' || ownerRole === 'admin'`, ownerRole = `ownerUser?.role ??
  'user'`), not "limit > 0". `max` = `maxCollaborators` with Infinity → **null** (deliberately NOT the -1 convention used
  by serialized limits in limits.ts:186-189; the website treats null as "no cap"). `count` = `countNamespaceMembers`
  (the number the cap uses). Additive field; `members` array unchanged.
  The 404 for an unknown target user on POST gains `code: "user_not_found"` (additive; message unchanged), so the
  website can tell it from "Namespace not found".
- OUT: any change to add/remove/role rules.

**Edge cases:** owner downgraded with existing grants (available false, count > 0); platform-admin owner (available
true, max null); owner user row missing → treated as role user (gate false); a suspended caller still reads `teams` (accepted: the POST rejects them).

**Done when:**
- [ ] DW-1.1: tests: Max owner → `{available:true, max:25, count:n}`; Pro/Free owner → `available:false`; admin owner → `max:null`; downgraded owner with grants → `available:false, count>0`.
- [ ] DW-1.2: dirty tests — flipping the owner tier makes GET `available` and the POST 403 agree; admin owner → `max === null` asserted on the parsed value and the raw body contains neither `Infinity` nor `"max":-1`; a stranger gets 404 with no `teams` in the body; POST unknown username → 404 `code: "user_not_found"`, unknown namespace → 404 without that code.

### Phase 1b: Backend — leave an address
**Repo:** upublish-backend (same branch)
**Skills:** code-foundations:cc-defensive-programming
**Model:** sonnet
**Gate:** Standard (security barricade: the auth-focused dirty tests above are mandatory)
**Depends on:** Phase 1
**File scope:** packages/server/src/api/members.ts, packages/server/src/api/members-leave.test.ts (new)

**Goal:** any member can remove themselves; the owner cannot leave.

**Scope:**
- IN: `DELETE /api/ns/:nsId/members/:userId` — `:userId` may be the literal `me` (alias for the caller; resolved before
  authz). Resolve `minRole = target === caller ? "user" : "admin"` BEFORE `authorizeNamespace` (stranger still 404;
  `user` removing someone else still 403). Owner self-delete → 400 `{ error: "The owner can't leave an address — delete
  it or keep it.", code: "owner_cannot_leave" }`; an admin targeting the owner keeps today's 400 message with no code.
  Success stays `200 { ok: true }`. `requireActiveUser` stays first: a suspended member cannot leave (403) — accepted,
  consistent with all other mutations. Update the file header (DELETE: self for any member, others admin+).
  Verified: no KV/site/worker sync is tied to membership; add-on billing keys off the owner's space — nothing to clean up.
- OUT: ownership transfer.

**Done when:**
- [ ] DW-1b.1: a `user` and an `admin` member can each leave via `/members/me` and via their own id (200 `{ok:true}`), then get 404 on the address; a former admin loses admin routes.
- [ ] DW-1b.2: dirty tests — a `user` removing another member 403; owner self (`me` or id) → 400 `owner_cannot_leave`; admin → owner keeps the old 400 without that code; stranger → 404; leaving twice → 404; a member of A leaving B → 404; suspended member → 403.

### Phase 2: Website — Members tab trusts the address, not the viewer
**Repo:** upublish-website, branch `feature/teams-fixes` off origin/main
**Skills:** svelte-foundations:coding
**Model:** sonnet
**Gate:** Standard
**Depends on:** Phase 1 (contract only — website handles the field's absence)
**File scope:** src/lib/components/dashboard/organisms/Members.svelte, src/lib/components/dashboard/organisms/AddressHub.svelte, src/lib/components/dashboard/SiteDetailPanel.svelte, src/routes/profile/home/+page.svelte, src/lib/api.ts, src/lib/types.ts, src/tests/members-*.svelte.test.ts, src/tests/address-hub.svelte.test.ts, src/tests/root-hub.svelte.test.ts, src/tests/*leave*.svelte.test.ts

**Goal:** add/manage controls appear exactly when the server would allow them; failures say what to do.

**Scope:**
- IN: keep `fetchMembers(nsId): Promise<NamespaceMember[]>` unchanged (every existing mock returns a bare array); add
  `fetchMembersWithTeams(nsId): Promise<{ members; teams?: { available; max: number | null; count } }>` used by
  Members only. `addMember` throws a typed error carrying `status` and `code` (additive; message unchanged).
  Members re-loads when `nsId` changes and guards stale responses (capture nsId before await; drop writes for a
  different nsId) — this is new code, Members only loads in onMount today.
  When `teams` is present: show the add form iff `teams.available && canManage`; role toggle + Remove use `canManage`
  alone (the server has no tier check on PATCH/DELETE); when absent: today's `isMaxTier` logic for all three;
  show "n of max teammates" when max is a number; when `!available`: owner sees "Teammates are a Max feature" + an
  "Upgrade" link to the existing upgrade href (`UPGRADE_HREF` in `$lib/site-data.ts`); admins/members see "Teammates
  need the address owner's Max plan" (no link). When absent: today's `spaceTier` logic. Label the input "Account email"
  (placeholder "teammate@example.com"); empty-field error "Enter their upublish account email."; an add error with
  `code === 'user_not_found'` → "No upublish account uses that email. Ask them to sign up at upubli.sh first, then add
  them." (no claim of an invite); other errors keep the server message. Upgrade link reuses `UPGRADE_HREF` +
  `UPGRADE_LABEL` from `$lib/site-data.ts`. Never hard-code 25. Keep test ids `members-gate-notice`, `members-add`,
  `members-add-input`.
  **Leave:** Members gets `role` (viewer's role on the address), `address` (display name from AddressHub's nsName +
  domain) and `onLeft`. For a non-owner viewer (independent of `canManage` — a `user` gets it), a "Leave <address>"
  control (TwoStepConfirm; button disabled-guarded while the request runs) calls `leaveAddress(nsId)` → DELETE
  `/members/me` (no viewer id needed). On success it calls `onLeft`, which AddressHub forwards to the hosts' existing
  `onDeleted`/`onAddressDeleted` → home's `handleAddressDeleted()` (closes panes, clears selection, reloads list/strip).
  Owner sees no Leave. A 400 `owner_cannot_leave` shows its message.
  Keep accessible names of existing Remove / role controls unchanged.
- OUT: invites, activity.

**Edge cases:** at cap (count === max) → form hidden with "Teammate limit reached (max)"; stale response after
address switch (existing guard pattern); member (role user) never sees the form.

**Done when:**
- [ ] DW-2.1: with `teams.available` true, an admin whose OWN tier is free sees the add form, role toggle and Remove; with false, a Max-tier viewer does not see the add form but an admin still sees role toggle + Remove for existing teammates.
- [ ] DW-2.2: owner sees the Upgrade link when unavailable; admin/member see the owner's-plan sentence and no link; cap reached hides the form.
- [ ] DW-2.3: dirty tests — `user_not_found` shows the sign-up guidance, a namespace 404 does not; a response without `teams` (bare-array mocks) keeps today's behavior; a members response for address A landing after switching to B is dropped.
- [ ] DW-2.4: a `user` (canManage false) and an admin can leave (confirm → DELETE /members/me → `onLeft` → the address is gone from the home list); owner sees no Leave; accessible name "Leave <address>"; a double click sends one request; a failed leave shows the error and keeps them on the page.

### Phase 3: Website — shared badge and owner-only controls
**Repo:** upublish-website (same branch)
**Skills:** svelte-foundations:coding, svelte-foundations:a11y-audit
**Model:** sonnet
**Gate:** Standard
**Depends on:** Phase 2
**File scope:** src/lib/components/dashboard/molecules/NamespaceRow.svelte, src/lib/components/dashboard/organisms/AddressHub.svelte, src/lib/components/dashboard/organisms/NamespaceSettings.svelte, src/lib/components/dashboard/organisms/AddressStrip.svelte, src/lib/components/dashboard/SiteDetailPanel.svelte, src/routes/profile/home/+page.svelte, src/tests/**

**Goal:** a shared address is visibly shared, and non-owners don't see owner-only actions.

**Scope:**
- IN: NamespaceRow shows a small "Shared · Admin" / "Shared · Member" tag when `ns.role` is `admin` or `user` (no tag
  when role is `owner` OR undefined — older fixtures); text, not color only; placed on the sub-line or beside the paused
  chip with `flex-none` — the address keeps its never-truncate `[overflow-wrap:anywhere]` contract. Same tag in the
  address strip (`ns.role` is already on its prop). AddressHub's optional `viewerRole` prop (added in Phase 2; a test forbids a prop named `role` on AddressHub) is reused —
  both hosts already pass it; NamespaceSettings renders rename + delete only when role is `owner` or
  undefined (old behavior when omitted), otherwise a one-line note "Only the owner can rename or delete this address."
- OUT: copy on marketing/docs pages (cmd-docs).

**Edge cases:** long address + tag at 360px (wraps/truncates without horizontal scroll); owner sees no tag.

**Done when:**
- [ ] DW-3.1: non-owner rows (admin, user) show the tag with role text; owner rows don't.
- [ ] DW-3.2: NamespaceSettings hides rename/delete for admin and user and shows the note; owner unchanged (existing tests pass).
- [ ] DW-3.3: dirty tests — a namespace without `role` shows no tag and full rename/delete; at 360px (browser VERIFY, plus a class audit) the tag never pushes the gear off-row and the address never truncates.

### Phase 4: Skill — leave action in the members tool
**Repo:** upublish.skill, branch `feature/members-leave` off origin/main
**Skills:** none -- small additive MCP action following the existing members tool pattern
**Model:** sonnet
**Gate:** Standard
**Depends on:** Phase 1b
**File scope:** lib/members.ts, lib/core.ts, lib/api-client.ts (only if needed for `code`), mcp/index.ts, references/managing.md, lib/*members*.test.ts, tests for the mcp tool schema

**Goal:** an AI tool can leave an address for its user ("leave giftshop.upubli.sh").

**Scope:**
- IN: `members` tool `action: "leave"` (namespace required): calls DELETE `/members/me` (no id lookup); add the
  variant to the `MembersArgs`/`MembersResult` unions in lib/core.ts and to the tool's zod enum in mcp/index.ts; map
  `owner_cannot_leave` (read the error `code` — verify how ApiClient surfaces body fields; add a typed error if needed)
  and 404 to plain messages; docs line in references/managing.md. Never pin versions in tests.
- OUT: invites (own branch).

**Done when:**
- [ ] DW-4.1: leave succeeds for a member (mocked API) and returns a confirmation naming the address.
- [ ] DW-4.2: dirty tests — owner gets the owner_cannot_leave message; not-a-member → clear not-found message; the tool schema's action enum includes `leave`.

---
## Test Coverage
**Level:** Per-phase (every DW item has tests; new routines unit-tested; Svelte components via component tests + browser VERIFY)

## Test Plan
- [ ] Backend unit/API tests DW-1.x.
- [ ] Website component tests DW-2.x, DW-3.x.
- [ ] Browser VERIFY (headless launch mode, stub API): Members tab as owner (Max / Pro), admin (free viewer on a Max address), member; leave flow; shared tag on home at 1280/360.

## Assumptions
| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| POST gate predicate is extractable without behavior change | high | 1 | duplicate with a parity test |
| `UPGRADE_HREF` is the right upgrade target | high | 2 | `/pricing` |

## Notes
- Copy handed to cmd-docs separately (sent 2026-11-08); verified against server authz in the audit, not in this plan's scope.
---
## Decided During Build
| # | Phase | Decision or question | Source | Status |
|---|---|---|---|---|
| 1 | 2 | AddressHub/host prop is `viewerRole` (DW-3.6 source guard forbids `role` on AddressHub); Members' own prop is `role` | build-agent | assumed |
| 2 | 2 | Leave shown only for role admin/user; undefined role → none | build-agent | assumed |
---
## Execution Log
_To be filled during build_
