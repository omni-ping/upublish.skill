---
name: upublish
description: Publish static sites to upubli.sh — the instant web publishing platform. Use when the user wants to publish files to the web, manage published sites, set visibility, generate diagrams, or get started with upublish. Handles full setup (CLI install, plugin config, auth) automatically before first use. Triggers on "upublish", "upubli.sh", "publish this site", "make this live", "put this on the web", "share this page", "deploy this", "list my sites", "delete site", "site visibility", "passcode protect".
---

# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Step 1: Bootstrap

Run these checks in order. Stop at the first failure, fix it, then continue.

### 1a. CLI installed?

```sh
which upublish
```

If missing, install it:

```sh
npm install -g @omniping/upublish
```

### 1b. Plugin configured?

Check if MCP tools are available — look for `mcp_upublish_publish` in your tools.

| MCP tools available? | Action |
|---|---|
| Yes | Skip to step 1c |
| No | Detect your platform and run configure (see below) |

**Detect your platform:**

| You are running in... | Platform |
|---|---|
| Claude Code, or `claude` CLI is available | claude |
| Gemini CLI, or a Gemini extension | gemini |
| Codex, or `codex` CLI is available | codex |

Run the configure command with your detected platform:

```sh
upublish configure --platform <claude|gemini|codex>
```

**After configure completes:** Tell the user to restart their session so MCP tools load. **STOP here** — do not continue until the session restarts. MCP tools only become available after a restart.

### 1c. Authenticated?

```sh
upublish status
```

| Output | Action |
|---|---|
| Shows "Authenticated" with username | Setup complete — continue to step 2 |
| Shows "Not authenticated" or error | Run `upublish login` (opens browser for Google sign-in), then re-check |

### 1d. Confirm setup

Run `upublish hello` to verify everything is working. This prints a welcome message with the username.

## Step 2: Route to action

Match what the user wants and read the reference file, then follow it.

| User wants to... | Reference |
|---|---|
| Publish a directory as a live site | `references/publishing.md` |
| **Pre-publish validation (REQUIRED before every publish)** | `references/pre-publish-checklist.md` |
| List, delete, or manage existing sites | `references/managing.md` |
| Control who can access a site (passcode, unlisted) | `references/visibility.md` |
| Generate a diagram and publish it | `references/generating.md` |
| Fix something that is broken | `references/troubleshooting.md` |
| Say hello or check setup | Run `upublish hello` |

## MCP tools vs CLI commands

Prefer MCP tools. Fall back to CLI if MCP tools are unavailable or a call fails.

| Action | MCP tool (preferred) | CLI fallback |
|---|---|---|
| Publish | `mcp_upublish_publish` | `upublish publish <dir> --slug <slug>` |
| List sites | `mcp_upublish_list` | `upublish list` |
| Delete site | `mcp_upublish_delete` | `upublish delete <slug>` |
| Generate diagram | `mcp_upublish_generate` | `upublish generate --context "..." --slug <slug>` |
| Check auth | — | `upublish status` |
| Login | — | `upublish login` |
| Configure plugin | — | `upublish configure --platform <platform>` |
| Say hello | — | `upublish hello` |

## Quick reference

**URL format:** `https://{username}.upubli.sh/{slug}/`

**Visibility modes:** `public` (default), `unlisted` (URL-only access), `passcode` (requires a code)

**Slug rules:** 3-63 chars, lowercase alphanumeric + hyphens, start/end with letter or number.

## Example

```
User: "publish my portfolio site"
Agent:
  1. Bootstrap passes (CLI installed, MCP tools available, authenticated)
  2. Read references/pre-publish-checklist.md — run all checks, fix issues
  3. Read references/publishing.md — follow the workflow
  4. Call mcp_upublish_publish(directory: "/path/to/portfolio", slug: "portfolio")
  5. Share the URL: "Your site is live at https://ryan.upubli.sh/portfolio/"
```
