# Review: members `leave` action (commit 4ccb5b7)

## Executed Results
- bun test -> exit 0, 2031 pass / 0 fail
- bunx tsc --noEmit -p . -> exit 0
- Fresh `bun build mcp/index.ts --target=bun` diff vs dist/mcp.js -> identical (check file deleted)

## Requirements
DW-4.1 PASS. lib/members.ts leaveMember -> apiClient.delete(`/api/ns/${nsId}/members/me`), no GET. mcp/index.ts leave branch -> "You left <address>. ..." using ns.name from core. Tests: test_DW_4_1_leave_member_sends_delete_to_members_me_without_lookup (asserts exactly one DELETE call), test_DW_4_1_core_leave_returns_address_and_ok, test_DW_4_1_leave_action_confirms_and_names_address. All ran green.
DW-4.2 PASS. Owner (400 + code owner_cannot_leave) -> "You own this address, so you cannot leave it. You can delete the address instead." No ownership-transfer promise (delete of an address is a pre-existing capability, see Notes). 404 -> "You are not a member of this address..." Enum includes leave (schema safeParse test). Missing namespace -> errResponse before any core call (leave_action_requires_namespace). Other errors rethrown unchanged (500, 400 w/o code tests).

## Other checks
- Hexagonal: mcp/index.ts imports only lib/core.ts plus pre-existing lib/log.ts (not in the diff). New leaveMember is reached via core.members.
- dist/mcp.js matches fresh build: PASS.
- references/managing.md line accurate: leave, namespace required, owner cannot leave. PASS.
- Tests pin no versions.

## Notes (non-blocking)
- Owner message says "You can delete the address instead." Backend has DELETE /ns/:nsId (packages/server/src/api/space.ts:1417) so the process exists, but the skill/MCP exposes no tool to delete an address (grep found none). Not a transfer promise and the backend process is real, so a Note; the caller may prefer to drop that sentence to be safe.
- Any 404 from the endpoint (including unknown namespace) maps to "not a member"; core resolves the namespace first, so unlikely.

**Verdict: PASS**
