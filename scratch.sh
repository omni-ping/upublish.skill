#!/bin/bash
set -e
cd /Users/r/repos/upublish.skill/.claude/worktrees/signup-signin-flows

echo "=== RUNNING LIB UNIT TESTS ==="
bun test lib/ 2>&1
echo ""
echo "EXIT_LIB=$?"

echo ""
echo "=== RUNNING ALL TESTS (lib/ + tests/) ==="
bun test 2>&1
echo ""
echo "EXIT_ALL=$?"
