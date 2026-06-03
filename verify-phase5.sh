#!/bin/bash

set -e

echo "=== Phase 5 Verification Script ==="
echo

# Test 1: Run all tests
echo "1. Running bun test (lib + tests)..."
cd /Users/r/repos/upublish.skill/.claude/worktrees/1gb-hardening
bun test 2>&1 | tail -20

echo
echo "2. Checking for 403 error message in code..."
grep -n "presigned URL expired or invalid" lib/publish.ts || echo "FAIL: 403 message not found"

echo
echo "3. Checking for heartbeat code in mcp/index.ts..."
grep -n "setInterval" mcp/index.ts || echo "FAIL: setInterval not found"
grep -n "heartbeat" mcp/index.ts || echo "FAIL: heartbeat not found"

echo
echo "4. Checking for 25 MB claims in docs..."
grep -n "25 MB" references/publishing.md || echo "PASS: No 25 MB in publishing.md"
grep -n "25 MB" references/content-types/taxonomy.md || echo "PASS: No 25 MB in taxonomy.md"

echo
echo "5. Checking dist/mcp.js exists and is executable..."
ls -lh dist/mcp.js
file dist/mcp.js | head -1

echo
echo "6. Checking that dist/mcp.js contains the 403 message..."
grep -c "presigned URL expired" dist/mcp.js || echo "WARNING: 403 message not in dist"

echo
echo "=== Verification Complete ==="
