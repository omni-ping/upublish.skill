# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## When to use this extension

Use upublish when the user wants to:
- Publish HTML/CSS/JS files to the web
- Share a site with a live URL
- Deploy a static site or demo
- Make a page public, password-protected, or unlisted
- Manage (list, delete) previously published sites
Trigger phrases: "publish this site", "make this live", "put this on the web", "share this page", "upublish", "upubli.sh".

## Step 1: Verify upublish is working

Check for `mcp_upublish_publish` in your available tools before proceeding.

| State | Action |
|---|---|
| MCP tools available, calls succeed | Go to Step 2 |
| MCP tools available but return "Not authenticated" | Call `mcp_upublish_login` to open browser for Google sign-in |
| MCP tools not found | Tell the user the extension is not installed or needs a restart |

## Step 2: Route to the right workflow

| User wants to... | Reference |
|---|---|
| Publish a directory as a live site | `references/publishing.md` |
| List, delete, or manage existing sites | `references/managing.md` |
| Control who can access a site (passcode, unlisted) | `references/visibility.md` |
| Fix something that's broken | `references/troubleshooting.md` |

## Available tools

- `mcp_upublish_login` — open browser for Google sign-in, returns auth URL
- `mcp_upublish_status` — check authentication state
- `mcp_upublish_publish` — publish a directory as a live site
- `mcp_upublish_list` — list all published sites with URLs
- `mcp_upublish_delete` — delete a published site (permanent, confirm first)
- `mcp_upublish_passcode_add` — add a passcode to a site
- `mcp_upublish_passcode_list` — list passcodes for a site
- `mcp_upublish_passcode_revoke` — revoke a passcode from a site
- `mcp_upublish_logout` — log out and remove credentials

## Quick reference

**URL format:** `https://{username}.upubli.sh/{slug}/`

**Visibility modes:**
- `public` (default) — anyone can view
- `unlisted` — accessible by direct URL only
- `passcode` — visitors must enter a code to view

**Slug rules:** 3-63 chars, lowercase alphanumeric + hyphens, start/end with letter or number.

## Example: publish a project

```
User: "publish my portfolio site"
Agent:
  1. Identify or ask for the directory containing the files
  2. Suggest slug: "portfolio"
  3. Call mcp_upublish_publish(directory: "/path/to/portfolio", slug: "portfolio")
  4. Share the returned URL: "Your site is live at https://ryan.upubli.sh/portfolio/"
```

## Example: password-protect a client preview

```
User: "publish this to /client-preview with a passcode"
Agent:
  1. Call mcp_upublish_publish(directory: "...", slug: "client-preview", visibility: "passcode", passcode: "preview2026")
  2. Share the URL and tell the user what passcode to give their client
```
