---
name: setup
description: Set up upublish — install CLI, configure MCP tools, and authenticate. Run this before using /upublish:ask for the first time, or when tools are missing or auth has expired.
---

# upublish setup

Get upublish working in this environment. This skill checks each prerequisite and fixes anything missing.

## Checklist

Run each check in order. Stop at the first failure, fix it, then continue.

### 1. Bun installed?

```sh
which bun
```

If missing, install it:
```sh
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc
```

### 2. Dependencies installed?

Find the skill directory — it's where this SKILL.md lives.

```sh
cd <skill-dir>/.. && bun install
```

Only needed if `node_modules/` is missing.

### 3. MCP tools available?

Look for `mcp_upublish_publish` in your available tools.

| State | Action |
|---|---|
| Tools available and calls succeed | Skip to step 4 |
| Tools not found | The MCP server needs to be registered. Tell the user to restart their session after setup completes. |

### 4. Authenticated?

```sh
cat ~/.upublish/credentials
```

| State | Action |
|---|---|
| File exists and is non-empty | Done — upublish is ready |
| File missing or empty | Run auth (see below) |

### Auth

Run the login flow — this opens a browser for Google sign-in:

```sh
bun run <skill-dir>/../bin/upublish.ts login
```

This is the only step that needs user interaction. After sign-in, credentials are stored at `~/.upublish/credentials`.

## When everything passes

Tell the user:

> upublish is ready. You can now use `/upublish:ask` to publish sites, list your sites, or manage visibility.

If MCP tools weren't available and this is the first setup, also tell them to restart their session so the tools activate.
