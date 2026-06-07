---
name: upublish
description: Publish static sites to upubli.sh — the instant web publishing platform. Use when the user wants to publish files to the web, manage published sites, set visibility, or get started with upublish. Triggers on "upublish", "upubli.sh", "publish this site", "make this live", "put this on the web", "share this page", "deploy this", "list my sites", "delete site", "site visibility", "passcode protect", "what sites do I have", "what domains", "my namespaces", "account info".
---

# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Step 1: Bootstrap

Run these checks in order. Stop at the first failure, fix it, then continue.

### 1a. MCP tools available?

Check if `mcp_upublish_publish` is in your available tools.

| MCP tools available? | Action |
|---|---|
| Yes | Continue to step 1b |
| No | The plugin is not installed or the session needs a restart. Tell the user to install the plugin and restart. |

### 1b. Authenticated?

Call the `status` tool to check auth state.

| Output | Action |
|---|---|
| Shows "Authenticated" with username | Setup complete — continue to step 2 |
| Shows "Not authenticated" | Call the `login` tool (opens the sign-in page in a browser), then re-check |

#### Signup happens on first login

There is no separate signup step. `login` opens `upubli.sh/login`, where the user
picks a sign-in provider (Google, GitHub, Microsoft, Discord, or GitLab). The
**first time** they sign in, they are transparently detoured through a short
**browser onboarding page** to finish setup — they create their **first namespace**
and accept the terms. `login` waits while they do this; it is **not stuck**.
Returning users skip onboarding and are signed in immediately.

Tell the user what to expect so the wait makes sense, e.g.: *"A browser window
opened — choose a sign-in provider, then finish the quick setup (namespace) there
and you'll be signed in automatically."* Once onboarding completes, `login` returns
and `status` shows their username and first namespace. No manual namespace creation
is needed to get started; use `namespace_create` only to add **more** namespaces later.

## Step 2: Route to action

Match what the user wants and read the reference file, then follow it.

| User wants to... | Reference |
|---|---|
| Publish a directory as a live site | `references/publishing.md` |
| **Pre-publish validation (REQUIRED before every publish)** | `references/pre-publish-checklist.md` |
| Figure out what type of content this is | `references/content-types/taxonomy.md` then the specific content type reference |
| List, delete, or manage existing sites | `references/managing.md` |
| Control who can access a site (passcode) | `references/visibility.md` |
| Add another namespace (URL prefix) | Call `namespace_create` (free plan allows one; tier-limit errors include the upgrade link) |
| Optimize site performance or reduce size | `references/optimization.md` |
| Add SEO tags, social previews, or favicon | `references/seo-social.md` |
| Check account info, namespaces, domains, or see what sites they have | Call `status` then `list` (no reference file needed) |
| Fix something that is broken | `references/troubleshooting.md` |

## Available MCP tools

| Tool | Description |
|---|---|
| `mcp_upublish_login` | Opens the sign-in page (choose a provider). First-time users finish a quick browser onboarding (first namespace + terms); returning users sign in directly |
| `mcp_upublish_status` | Check authentication state, shows namespaces and domains |
| `mcp_upublish_namespace_create` | Create an additional namespace (URL prefix); tier-limited, returns the new namespace id + domain |
| `mcp_upublish_publish` | Publish a directory as a live site |
| `mcp_upublish_list` | List all published sites with URLs |
| `mcp_upublish_delete` | Delete a published site (permanent, confirm first) |
| `mcp_upublish_passcode_add` | Add a passcode to a site |
| `mcp_upublish_passcode_list` | List passcodes for a site |
| `mcp_upublish_passcode_revoke` | Revoke a passcode from a site |
| `mcp_upublish_logout` | Log out and remove credentials |

## Quick reference

**URL format:** `https://{username}.upubli.sh/{slug}/`

**Visibility modes:** `public` (default), `passcode` (requires a code)

**Slug rules:** 3-63 chars, lowercase alphanumeric + hyphens, start/end with letter or number.

## Example

```
User: "publish my portfolio site"
Agent:
  1. Bootstrap passes (MCP tools available, authenticated)
  2. Read references/pre-publish-checklist.md — run all checks, fix issues
  3. Read references/publishing.md — follow the workflow
  4. Call mcp_upublish_publish(directory: "/path/to/portfolio", slug: "portfolio")
  5. Share the URL: "Your site is live at https://ryan.upubli.sh/portfolio/"
```
