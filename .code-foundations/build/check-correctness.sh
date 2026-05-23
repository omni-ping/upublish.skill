#!/bin/bash
set -e

echo "=== Correctness Dimensions Check ==="
echo ""

echo "1. Concurrency: Are functions async/await safe?"
echo "Core functions:"
grep "export async function" lib/core.ts | grep -i passcode

echo ""
echo "2. Error Handling: Are API errors properly caught and propagated?"
echo "apiClient.post/get/delete error handling:"
grep -n "apiClient\." lib/passcode.ts

echo ""
echo "3. Resources: Any resource leaks (files, connections)?"
echo "Passcode module doesn't manage resources:"
grep -n "open\|close\|Socket\|Stream" lib/passcode.ts || echo "No resource management needed"

echo ""
echo "4. Boundaries: Slug encoding, parameter validation"
grep -n "encodeURIComponent\|trim()\|length === 0" lib/passcode.ts

echo ""
echo "5. Security: Passcode code/label validation, injection prevention"
grep -A 5 "code is required\|label is required" lib/passcode.ts | head -10

echo ""
echo "6. Checking API response parsing doesn't have silent failures:"
grep -n "result\[" lib/passcode.ts || echo "No unvalidated property access"

echo ""
echo "7. Checking return types match promises:"
grep "Promise<" lib/passcode.ts | head -5
