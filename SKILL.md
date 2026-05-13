---
name: upublish
description: Publish static sites to upubli.sh — the instant web publishing platform. Use this skill whenever the user wants to publish HTML/CSS/JS files to the web, share a site with a URL, make a page public or password-protected, deploy a static site, put something online, or manage published sites. Also triggers on "upublish", "upubli.sh", "publish this site", "make this live", "put this on the web", "share this page", or any mention of site visibility, passcode protection, or unlisted pages.
---

# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Step 1: Verify upublish is working

Run this check every time before doing anything else.

**Check MCP tools exist:** Look for `mcp_upublish_publish` in your available tools.

| State | Action |
|---|---|
| MCP tools available, calls succeed | Go to Step 2 |
| MCP tools available but return "Not authenticated" | Re-run auth: `upublish login` |
| MCP tools not found | Bootstrap (see below) |

### Bootstrap (only when MCP tools are missing)

Do all of this automatically — don't ask the user to run commands:

1. **Bun:** `which bun` — if missing: `curl -fsSL https://bun.sh/install | bash && source ~/.bashrc`
2. **Find the skill directory** — it's where this SKILL.md lives. Use the path Claude resolved when loading this skill.
3. **Dependencies:** `cd <skill-dir> && bun install`
4. **Auth:** `<skill-dir>/bin/upublish.ts login`
   - Opens a browser for Google sign-in — the only step that needs the user
   - Stores credentials at `~/.upublish/credentials`
5. Tell the user: "upublish is ready. Restart your Claude session to activate the tools, then ask me again."

If any step fails, read the error output and fix it. Don't show raw errors to the user.

## Step 2: Route to the right workflow

Read the reference file for what the user wants, then follow it.

| User wants to... | Read |
|---|---|
| Publish a directory as a live site | `references/publishing.md` |
| List, delete, or manage existing sites | `references/managing.md` |
| Control who can access a site (passcode, unlisted) | `references/visibility.md` |
| Generate a diagram and publish it | `references/generating.md` |
| Fix something that's broken | `references/troubleshooting.md` |

## Quick reference

**URL format:** `https://{username}.upubli.sh/{slug}/`

**Tools:**
- `mcp_upublish_publish` — publish a directory as a live site
- `mcp_upublish_list` — list all published sites with URLs
- `mcp_upublish_delete` — delete a published site (permanent, confirm first)
- `mcp_upublish_generate` — generate an Excalidraw diagram and publish it

**Visibility modes:** `public` (default), `unlisted` (URL-only access), `passcode` (requires a code)

**Slug rules:** 3-63 chars, lowercase alphanumeric + hyphens, start/end with letter or number. Don't use `__upublish` prefix (reserved).

## Example: publish a project

```
User: "publish my portfolio site"
Agent:
  1. Ask which directory contains the files (or identify from context)
  2. Suggest slug: "portfolio"
  3. Call mcp_upublish_publish(directory: "/path/to/portfolio", slug: "portfolio")
  4. Response: "Your site is live at https://ryan.upubli.sh/portfolio/"
```
