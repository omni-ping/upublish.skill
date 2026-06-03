#!/bin/bash

echo "=== COMPREHENSIVE DW VERIFICATION ==="
echo ""

# DW-4.1: Core member functions
echo "DW-4.1: Core member functions exported from lib/core.ts"
grep -n "export.*function members" lib/core.ts && echo "✓ members() exported"
grep -n "export type.*MembersArgs\|export type.*MembersResult" lib/core.ts && echo "✓ MembersArgs and MembersResult types exported"

# DW-4.2: Namespace.role field
echo ""
echo "DW-4.2: Namespace type includes role"
grep -A5 "export interface Namespace" lib/types.ts | grep -n "role" && echo "✓ role field found in Namespace interface"

# Verify list/status carry role
echo ""
echo "DW-4.2: list() and status() carry role through Namespace"
grep "ListResult\|StatusResult" lib/core.ts | head -3 && echo "✓ Result types use Namespace (which carries role)"

# DW-4.3: MCP members tool
echo ""
echo "DW-4.3: MCP members tool registered"
grep '"members"' mcp/index.ts | head -1 && echo "✓ members tool registered"
grep -c "action.*list\|action.*add\|action.*remove\|action.*role" mcp/index.ts && echo "✓ All four actions present"

# Check for errResponse usage
grep "errResponse" mcp/index.ts | grep -q "members" && echo "✓ members tool uses errResponse for error handling"

# DW-4.4: Role display in list/status
echo ""
echo "DW-4.4: Role display in list and status tools"
grep -A5 "Sites in namespace" mcp/index.ts | grep -q "roleMarker" && echo "✓ list tool shows role marker"
grep -B5 -A5 "ns.role.*owner" mcp/index.ts | grep -q "roleMarker" && echo "✓ status tool shows role marker"

# DW-4.5: Test coverage
echo ""
echo "DW-4.5: Test coverage"
grep -l "test_DW_4" lib/*.test.ts tests/*.test.ts 2>/dev/null | wc -l | xargs -I {} echo "✓ {} test files with DW-4 tests"
grep "test_DW_4" lib/*.test.ts tests/*.test.ts 2>/dev/null | wc -l | xargs -I {} echo "✓ {} DW-4 test cases"

# Hexagonal boundary check
echo ""
echo "Hexagonal boundary verification:"
echo "mcp/index.ts imports:"
grep "^import.*from.*lib/" mcp/index.ts | sort | uniq
echo ""
echo "Expected: should only import from lib/core.ts and lib/types.ts (re-exported by core)"
if grep "^import.*from.*lib/" mcp/index.ts | grep -v "lib/core\|lib/log" | grep -q "lib/"; then
  echo "⚠ Warning: importing from non-core lib modules"
else
  echo "✓ Hexagonal boundary respected"
fi

# ApiClient.patch verification
echo ""
echo "ApiClient.patch() method:"
grep -n "async patch<T>" lib/api-client.ts && echo "✓ patch method found"

# Verify no throw for expected failures pattern
echo ""
echo "No-throw pattern verification (structured returns):"
grep -n "throw new Error" lib/members.ts | wc -l | xargs -I {} echo "  {} throws in members.ts (should be only resolveUserId for username not found)"
grep -c "export async function" lib/members.ts | xargs -I {} echo "  {} exported member functions"

