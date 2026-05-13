#!/bin/sh
# upublish installer
# Usage: curl -fsSL https://raw.githubusercontent.com/omni-ping/upublish.skill/main/install.sh | sh
#
# Installs the upublish CLI by:
# 1. Checking for an unsupported OS (Windows)
# 2. Installing Bun if it is not already present
# 3. Cloning the repo to ~/.upublish/
# 4. Adding ~/.upublish/bin to PATH in the user's shell rc file
# 5. Running `upublish login` to authenticate

set -e

REPO_URL="https://github.com/omni-ping/upublish.skill.git"
INSTALL_DIR="$HOME/.upublish"
BIN_DIR="$INSTALL_DIR/bin"

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

# ─── Bun installation ────────────────────────────────────────────────────────

install_bun() {
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | sh
  # Source Bun's env so it's available in the current session
  if [ -f "$HOME/.bun/bin/bun" ]; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
}

if ! command -v bun > /dev/null 2>&1; then
  install_bun
fi

if ! command -v bun > /dev/null 2>&1; then
  echo "Error: Bun installation failed. Please install Bun manually: https://bun.sh"
  exit 1
fi

echo "Bun $(bun --version) found."

# ─── Repo clone ───────────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing upublish installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning omni-ping/upublish.skill to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ─── Dependencies ────────────────────────────────────────────────────────────

echo "Installing dependencies..."
bun install --cwd "$INSTALL_DIR" --frozen-lockfile

# ─── Symlink bin ─────────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"

# Create a wrapper script so `upublish` works without specifying the full path
cat > "$BIN_DIR/upublish" << 'EOF'
#!/bin/sh
UPUBLISH_DIR="$HOME/.upublish"
exec bun "$UPUBLISH_DIR/bin/upublish.ts" "$@"
EOF
chmod +x "$BIN_DIR/upublish"

# ─── PATH setup ───────────────────────────────────────────────────────────────

add_to_path() {
  PROFILE_FILE="$1"
  PATH_LINE="export PATH=\"\$HOME/.upublish/bin:\$PATH\""

  if [ -f "$PROFILE_FILE" ]; then
    if ! grep -q ".upublish/bin" "$PROFILE_FILE" 2>/dev/null; then
      echo "" >> "$PROFILE_FILE"
      echo "# upublish CLI" >> "$PROFILE_FILE"
      echo "$PATH_LINE" >> "$PROFILE_FILE"
      echo "Added upublish to PATH in $PROFILE_FILE"
    fi
  fi
}

# Detect shell and add to PATH
if [ -f "$HOME/.zshrc" ]; then
  add_to_path "$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  add_to_path "$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  add_to_path "$HOME/.bash_profile"
else
  add_to_path "$HOME/.profile"
fi

# Make upublish available in the current session
export PATH="$BIN_DIR:$PATH"

# ─── Auth ─────────────────────────────────────────────────────────────────────

echo ""
echo "upublish is installed at $INSTALL_DIR"
echo ""
echo "Starting authentication..."
upublish login
