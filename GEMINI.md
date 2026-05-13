# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## When to use this extension

Use upublish when the user wants to:
- Publish HTML/CSS/JS files to the web
- Share a site with a live URL
- Deploy a static site or demo
- Make a page public, password-protected, or unlisted
- Manage (list, delete) previously published sites
- Generate an Excalidraw diagram and publish it

Trigger phrases: "publish this site", "make this live", "put this on the web", "share this page", "upublish", "upubli.sh".

## Step 1: Verify upublish is working

Check for `mcp_upublish_publish` in your available tools before proceeding.

| State | Action |
|---|---|
| MCP tools available, calls succeed | Go to Step 2 |
| MCP tools available but return "Not authenticated" | Re-run auth: `upublish login` |
| MCP tools not found | Bootstrap (see below) |

### Bootstrap (only when MCP tools are missing)

Handle this automatically — do not ask the user to run commands manually.

1. **Bun:** `which bun` — if missing: `curl -fsSL https://bun.sh/install | bash && source ~/.bashrc`
2. **Dependencies:** `cd <extension-dir> && bun install`
3. **Auth:** `<extension-dir>/bin/upublish.ts login`
   - Opens a browser for Google sign-in — the only step that needs the user
   - Stores credentials at `~/.upublish/credentials`
4. Tell the user: "upublish is ready. Restart Gemini to activate the tools, then ask me again."

If any step fails, read the error and fix it. Do not show raw errors to the user.

## Step 2: Route to the right workflow

| User wants to... | Reference |
|---|---|
| Publish a directory as a live site | `references/publishing.md` |
| List, delete, or manage existing sites | `references/managing.md` |
| Control who can access a site (passcode, unlisted) | `references/visibility.md` |
| Generate a diagram and publish it | `references/generating.md` |
| Fix something that's broken | `references/troubleshooting.md` |

## Available tools

- `mcp_upublish_publish` — publish a directory as a live site
- `mcp_upublish_list` — list all published sites with URLs
- `mcp_upublish_delete` — delete a published site (permanent, confirm first)
- `mcp_upublish_generate` — generate an Excalidraw diagram and publish it

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
