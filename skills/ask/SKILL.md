---
name: ask
description: Publish static sites to upubli.sh — the instant web publishing platform. Use this skill whenever the user wants to publish HTML/CSS/JS files to the web, share a site with a URL, make a page public or password-protected, deploy a static site, put something online, or manage published sites. Also triggers on "upublish", "upubli.sh", "publish this site", "make this live", "put this on the web", "share this page", or any mention of site visibility, passcode protection, or unlisted pages.
---

# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Before you start

Check if MCP tools are available — look for `mcp_upublish_publish` in your tools.

| State | Action |
|---|---|
| MCP tools available, calls succeed | Continue below |
| MCP tools missing or return "Not authenticated" | Tell the user to run `/upublish:setup` first |

## Route to the right workflow

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

**Slug rules:** 3-63 chars, lowercase alphanumeric + hyphens, start/end with letter or number.

## Example

```
User: "publish my portfolio site"
Agent:
  1. Ask which directory contains the files (or identify from context)
  2. Suggest slug: "portfolio"
  3. Call mcp_upublish_publish(directory: "/path/to/portfolio", slug: "portfolio")
  4. Response: "Your site is live at https://ryan.upubli.sh/portfolio/"
```
