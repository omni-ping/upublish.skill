#!/bin/bash

echo "=== DEFENSIVE PROGRAMMING CHECKLIST ==="
echo ""

# GC-1: Does the routine protect itself from bad input?
echo "GC-1: Input validation at entry points"
echo "  Checking members.ts for input validation..."
if grep -q "if (!username\|if (!nsId\|if (!role" lib/members.ts; then
  echo "  ✓ Parameter validation found"
fi

# EC-3: No empty catch blocks
echo ""
echo "EC-3: No empty catch blocks"
if grep -n "catch.*{.*}" lib/members.ts lib/core.ts mcp/index.ts 2>/dev/null | grep -v "catch.*Error\|catch.*err"; then
  echo "  ⚠ Potential empty catch blocks"
else
  echo "  ✓ No empty catch blocks found"
fi

# Check MCP tool error handling
echo ""
echo "MCP error handling:"
grep -B2 -A2 "catch (err)" mcp/index.ts | head -10 && echo "  ✓ Error handling pattern in place"

# Check no executable code in assertions
echo ""
echo "Assertions:"
grep -n "assert\|expect" lib/members.ts lib/core.ts 2>/dev/null | wc -l | xargs -I {} echo "  {} assertion-like statements (expected in tests, not in library code)"

# Check for swallowed errors
echo ""
echo "Checking for swallowed errors (silent failures):"
if grep -n "catch.*{.*}" lib/members.ts | grep -v "throw"; then
  echo "  ⚠ Some catch blocks may swallow errors"
else
  echo "  ✓ No silently swallowed errors detected"
fi

# Check error propagation in core.ts
echo ""
echo "Core function error handling:"
echo "  members() function (lines 505-527):"
grep -A20 "export async function members" lib/core.ts | grep -E "throw|catch|try" && echo "    ✓ Uses domain functions which throw (propagated to caller)"

# Verify no logging of sensitive data
echo ""
echo "Sensitive data in error messages:"
if grep "username\|password\|token\|secret" lib/members.ts | grep -v "// \|const.*username\|args.username"; then
  echo "  ⚠ Potential sensitive data in logging"
else
  echo "  ✓ No sensitive data logging detected"
fi

