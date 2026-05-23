#!/bin/bash
set -e

echo "=== Design Quality Analysis ==="
echo ""

echo "1. Checking for pass-through functions (thin wrappers with no real logic):"
echo "Examining core.addPasscode, listPasscodes, revokePasscode:"
wc -l lib/core.ts | awk '{print "Total core.ts lines: " $1}'
grep -A 10 "export async function addPasscode" lib/core.ts | head -15

echo ""
echo "2. Checking core.revokePasscode has intelligent label→id resolution:"
grep -A 15 "export async function revokePasscode" lib/core.ts | grep -A 10 "opts.label"

echo ""
echo "3. Design: Domain layer (passcode.ts) has appropriate responsibility:"
grep "function\|export" lib/passcode.ts | head -10

echo ""
echo "4. Checking DW coverage in tests - are all paths tested?"
grep "describe\|it(" lib/passcode.test.ts | wc -l && echo "Test cases defined"

echo ""
echo "5. Checking for magic strings or hardcoded values:"
grep -n "default\|Client A" lib/passcode.ts lib/publish.ts
