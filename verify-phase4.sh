#!/bin/bash

set -e

ROOT="/Users/r/repos/upublish.skill/.claude/worktrees/cross-user-namespace-publishing"
cd "$ROOT"

echo "=== Phase 4 Review Verification ==="
echo ""

# Step 1: Run all tests
echo "Step 1: Running all tests..."
bun test 2>&1 | tee test-output.txt
echo ""

# Step 2: Extract test counts from output
echo "Step 2: Analyzing test results..."
PASS_COUNT=$(grep -oP 'ok \K\d+' test-output.txt | head -1 || echo "unknown")
echo "Tests passed: $PASS_COUNT"
echo ""

# Step 3: Check lib/core.ts for member exports
echo "Step 3: Checking lib/core.ts for member functions..."
if grep -q "export.*function.*members" "$ROOT/lib/core.ts"; then
  echo "✓ members() export found in lib/core.ts"
else
  echo "✗ members() export NOT found in lib/core.ts"
fi

if grep -q "export.*listMembers\|export.*addMember\|export.*removeMember\|export.*changeMemberRole" "$ROOT/lib/members.ts" 2>/dev/null; then
  echo "✓ Member domain functions found in lib/members.ts"
else
  echo "✗ Member domain functions NOT found"
fi
echo ""

# Step 4: Check Namespace type for role field
echo "Step 4: Checking Namespace type..."
if grep -A5 "export.*interface Namespace" "$ROOT/lib/types.ts" | grep -q "role"; then
  echo "✓ Namespace type includes role field"
else
  echo "✗ Namespace type does NOT include role field"
fi
echo ""

# Step 5: Check mcp/index.ts for members tool
echo "Step 5: Checking MCP members tool registration..."
if grep -q "members" "$ROOT/mcp/index.ts"; then
  echo "✓ members tool reference found in mcp/index.ts"
  if grep -q "action.*list\|action.*add\|action.*remove\|action.*role" "$ROOT/mcp/index.ts"; then
    echo "✓ members tool actions found"
  fi
else
  echo "✗ members tool NOT found in mcp/index.ts"
fi
echo ""

# Step 6: Check for hexagonal boundary violations
echo "Step 6: Checking hexagonal boundary (mcp/index.ts imports)..."
if grep "^import.*from.*lib/members" "$ROOT/mcp/index.ts" 2>/dev/null | grep -v "lib/core"; then
  echo "✗ WARNING: mcp/index.ts imports directly from internal modules (should import from lib/core only)"
else
  echo "✓ mcp/index.ts does not import directly from lib/members (good)"
fi
echo ""

# Step 7: Check ApiClient.patch method
echo "Step 7: Checking ApiClient.patch() method..."
if grep -q "patch<T>" "$ROOT/lib/api-client.ts"; then
  echo "✓ ApiClient.patch() method found"
else
  echo "✗ ApiClient.patch() method NOT found"
fi
echo ""

# Step 8: Check for role display in list/status
echo "Step 8: Checking for role display in list and status tools..."
if grep -A10 "list.*tool" "$ROOT/mcp/index.ts" | grep -q "role\|admin\|user"; then
  echo "✓ list tool appears to show role information"
else
  echo "⚠ list tool role display not clearly visible in grep"
fi

if grep -A10 "status.*tool" "$ROOT/mcp/index.ts" | grep -q "role\|admin\|user"; then
  echo "✓ status tool appears to show role information"
else
  echo "⚠ status tool role display not clearly visible in grep"
fi
echo ""

echo "=== Verification Complete ==="
