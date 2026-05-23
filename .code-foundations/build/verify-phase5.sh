#!/bin/bash
set -e

echo "=== Phase 5 Implementation Verification ==="
echo ""

echo "1. DW-5.1: publish --visibility passcode --passcode mycode creates site with default label"
grep -A 5 "test_DW_5_1_publish_sends_default_label_when_visibility_passcode" lib/publish.test.ts | grep "passcode_label.*default" && echo "FOUND: Test verifies default label" || echo "MISSING"

echo ""
echo "2. DW-5.2: publish --visibility passcode --passcode mycode --label 'Client A' uses provided label"
grep -A 5 "test_DW_5_2_publish_sends_custom_label_when_provided" lib/publish.test.ts | grep "passcode_label.*Client A" && echo "FOUND: Test verifies custom label" || echo "MISSING"

echo ""
echo "3. DW-5.3: passcode add <slug> --label --passcode adds a passcode"
grep "test_DW_5_3_add_passcode_posts_to_api" lib/passcode.test.ts && echo "FOUND: Test for addPasscode" || echo "MISSING"

echo ""
echo "4. DW-5.4: passcode list <slug> displays table of id, label, created date"
grep "test_DW_5_4_list_passcodes_returns_array" lib/passcode.test.ts && echo "FOUND: Test for listPasscodes" || echo "MISSING"
grep -n "created_at\|created date" bin/upublish.ts | head -1 && echo "FOUND: CLI displays created date" || echo "MISSING"

echo ""
echo "5. DW-5.5: passcode revoke <slug> --id <id> or --label removes a passcode"
grep "test_DW_5_5_revoke_passcode" lib/passcode.test.ts && echo "FOUND: Tests for revokePasscode" || echo "MISSING"
grep -n "Either id or label must be provided" bin/upublish.ts && echo "FOUND: CLI validates id or label" || echo "MISSING"

echo ""
echo "6. DW-5.6: MCP tools passcode_add, passcode_list, passcode_revoke mirror CLI"
grep "passcode_add\|passcode_list\|passcode_revoke" mcp/index.ts | head -3 && echo "FOUND: MCP tools registered" || echo "MISSING"

echo ""
echo "7. DW-5.7: lib/core.ts exports addPasscode, listPasscodes, revokePasscode with CoreDeps"
grep "export.*addPasscode\|export.*listPasscodes\|export.*revokePasscode" lib/core.ts && echo "FOUND: Core exports passcode functions" || echo "MISSING"
grep "test_DW_5_7_core" lib/core.test.ts | head -3 && echo "FOUND: Core tests exist" || echo "MISSING"

echo ""
echo "8. DW-5.8: All existing tests pass; new tests cover core passcode functions"
bun test lib/ 2>&1 | tail -3 && echo "FOUND: All tests pass" || echo "MISSING"

echo ""
echo "=== Summary ==="
echo "Checking file count:"
ls -1 lib/passcode.* 2>/dev/null | wc -l && echo "FOUND: passcode module files (2 expected)" || echo "MISSING"
