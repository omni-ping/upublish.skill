#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env from repo root if it exists
if [ -f "$ROOT/.env" ]; then
  export $(grep -v '^#' "$ROOT/.env" | xargs)
fi

if [ -z "$NPM_TOKEN" ]; then
  echo "Missing NPM_TOKEN."
  echo ""
  echo "Either:"
  echo "  1. Create .env in repo root with: NPM_TOKEN=your_token"
  echo "  2. Run: NPM_TOKEN=your_token ./scripts/publish.sh"
  exit 1
fi

cd "$ROOT"
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
npm publish
rm -f .npmrc
echo "Published @omniping/upublish successfully."
