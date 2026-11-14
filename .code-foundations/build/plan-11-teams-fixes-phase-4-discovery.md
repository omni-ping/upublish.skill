# Discovery + Design: Phase 4 - Skill: leave action in members tool

## Files Found
lib/members.ts, lib/members.test.ts, lib/core.ts (members() dispatch ~L923-990), lib/core-members.test.ts,
mcp/index.ts (members tool ~L1840), tests/mcp.members.test.ts, references/managing.md (Team members section), lib/api-client.ts.

## Current State
members tool has list/add/remove/role; domain fns in lib/members.ts, dispatch in core.ts, MCP formats text.

## Gaps
- ApiClient already throws `ApiError(status, rawBodyData, msg)` carrying the parsed body, so `code` is readable
  (same pattern as lib/gate.ts:179). No api-client.ts change needed; no new typed error.
- `ApiClient.delete` takes no body: fine for DELETE /members/me.
- Version bump: CI does it (CLAUDE.md); not touched.

## Code Standards
No docs/code-standards.md checked; follow repo CLAUDE.md: adapters import only lib/core.ts, core.ts re-exports types,
tests never pin versions, rebuild dist/mcp.js.

## Test Infrastructure
bun:test; lib tests inject ApiClient with mock fetch; tests/mcp.members.test.ts drives the registered tool handler.

## DW Verification
| DW-ID | Item | Status | Tests |
|---|---|---|---|
| DW-4.1 | leave succeeds for a member, confirmation names address | COVERED | lib: leaveMember sends DELETE /members/me, no GET lookup; core: members({action:"leave"}); mcp: text contains address name + "left" |
| DW-4.2 | owner msg; not-member msg; enum includes leave | COVERED | lib+mcp owner_cannot_leave -> plain message; 404 -> not-a-member message; mcp inputSchema action enum accepts "leave" and rejects junk |

**All items COVERED:** YES

## Design Decisions
- `leaveMember(apiClient, nsId)` in lib/members.ts returns `{ok:true}`, catches ApiError: 400 + code owner_cannot_leave ->
  plain Error ("owner cannot leave; transfer or delete instead"); 404 -> "not a member of this address". Others rethrown.
- Core attaches `address: ns.name` to result (`{action:"leave", ok:true, address}`), so MCP can name it.
- MCP: zod enum + description gain `leave`; username/role not required for leave.

## Prerequisites
- [x] all present

## Recommendation
BUILD
