#!/usr/bin/env node
/**
 * upublish Node.js shim for npm/npx fallback.
 *
 * This shim is the bin entry point when the package is installed via npm
 * (e.g. `npm install -g @upublish/cli` or `npx -y @upublish/cli`).
 *
 * Since upublish is written in TypeScript and runs on Bun, this shim:
 * 1. Checks that Bun is installed
 * 2. Delegates execution to bun + bin/upublish.ts using execFileSync
 *    (not exec with shell string interpolation — avoids injection risk)
 * 3. Exits with the same code as the bun process
 */

"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

// The TypeScript entry point is one directory up from dist/
const binEntry = path.join(__dirname, "..", "bin", "upublish.ts");
const args = process.argv.slice(2);

try {
  execFileSync("bun", [binEntry, ...args], { stdio: "inherit" });
} catch (err) {
  if (err && typeof err === "object" && "status" in err && err.status != null) {
    // Child process exited with a non-zero code — propagate it
    process.exit(err.status);
  }

  // Bun not found or other spawn error
  const message =
    err && typeof err === "object" && "code" in err && err.code === "ENOENT"
      ? "Error: Bun is not installed. Please install it first:\n  curl -fsSL https://bun.sh/install | bash\n\nOr use the install script:\n  curl -fsSL https://raw.githubusercontent.com/omni-ping/upublish.skill/main/install.sh | sh"
      : "Error: " + (err instanceof Error ? err.message : String(err));

  process.stderr.write(message + "\n");
  process.exit(1);
}
