#!/bin/bash
set -e

echo "=== Checking defensive programming ==="
echo ""

echo "1. Checking for empty catch blocks in passcode module:"
grep -n "catch\|} catch" lib/passcode.ts && echo "FOUND: May have catch blocks" || echo "None found"

echo ""
echo "2. Checking for input validation in addPasscode:"
grep -A 3 "if (!code\|if (!label" lib/passcode.ts | head -8

echo ""
echo "3. Checking for input validation in revokePasscode:"
grep -A 3 "if (!id" lib/passcode.ts | head -5

echo ""
echo "4. Checking for unhandled promise rejections in core:"
grep -n "catch.*{}.*)" lib/core.ts && echo "FOUND: Empty catch" || echo "Proper error handling"

echo ""
echo "5. Checking for silent failures in MCP:"
grep -n "catch.*err.*{" mcp/index.ts | head -3

echo ""
echo "6. Checking for proper error propagation:"
grep -n "throw\|rejects" lib/passcode.test.ts | head -5

echo ""
echo "7. Checking encodeURIComponent usage for slug safety:"
grep -n "encodeURIComponent(slug)" lib/passcode.ts
