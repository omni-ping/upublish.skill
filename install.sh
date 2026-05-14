#!/bin/sh
# upublish installer
# Usage: curl -fsSL https://raw.githubusercontent.com/omni-ping/upublish.skill/main/install.sh | sh
#
# Installs the upublish CLI by:
# 1. Checking for an unsupported OS (Windows)
# 2. Checking that Node.js and npm are available
# 3. Installing @omniping/upublish globally via npm
# 4. Running `upublish login` to authenticate

set -e

# ─── OS check ────────────────────────────────────────────────────────────────

OS_NAME=$(uname -s 2>/dev/null || echo "unknown")

case "$OS_NAME" in
  Linux|Darwin)
    ;;
  *)
    echo "Error: unsupported operating system: $OS_NAME"
    echo "upublish installer supports macOS and Linux only."
    exit 1
    ;;
esac

# ─── Node/npm check ─────────────────────────────────────────────────────────

if ! command -v node > /dev/null 2>&1; then
  echo "Error: Node.js is not installed."
  echo "Install Node.js from https://nodejs.org/ and try again."
  exit 1
fi

if ! command -v npm > /dev/null 2>&1; then
  echo "Error: npm is not installed."
  echo "Install Node.js from https://nodejs.org/ (npm is included) and try again."
  exit 1
fi

echo "Node $(node --version) found."
echo "npm $(npm --version) found."

# ─── Install ─────────────────────────────────────────────────────────────────

echo "Installing upublish..."
npm install -g @omniping/upublish

if ! command -v upublish > /dev/null 2>&1; then
  echo "Error: upublish installation failed."
  echo "Try running: npm install -g @omniping/upublish"
  exit 1
fi

# ─── Auth ─────────────────────────────────────────────────────────────────────

echo ""
echo "upublish is installed."
echo ""
echo "Starting authentication..."
upublish login
