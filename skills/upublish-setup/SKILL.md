---
name: upublish-setup
description: Set up upublish — install CLI, configure MCP tools, and authenticate. Run this before using /upublish for the first time, or when tools are missing or auth has expired.
---

# upublish setup

Get upublish working in this environment. This skill checks each prerequisite and fixes anything missing.

## Checklist

Run each check in order. Stop at the first failure, fix it, then continue.

### 1. CLI installed?

```sh
which upublish
```

If missing:

```sh
npm install -g @upublish/cli
```

### 2. MCP server registered?

Look for `mcp_upublish_publish` in your available tools.

| State | Action |
|---|---|
| Tools available | Skip to step 3 |
| Tools not found | Register the MCP server (see below), then tell the user to restart their session |

#### Register MCP server

Detect which agent is running and add the MCP config to the right location.

**Codex** — append to `~/.codex/config.toml`:

```toml
[mcp_servers.upublish]
command = "npx"
args = ["-y", "@upublish/cli", "mcp"]
```

**Claude Code** — add to `.mcp.json` or project settings:

```json
{
  "mcpServers": {
    "upublish": {
      "command": "npx",
      "args": ["-y", "@upublish/cli", "mcp"]
    }
  }
}
```

After registering, tell the user: "MCP server configured. Restart your session to activate the upublish tools."

### 3. Authenticated?

```sh
upublish status
```

| State | Action |
|---|---|
| Shows "Authenticated" with username | Done — upublish is ready |
| Shows "Not authenticated" or any error | Run `upublish login` (opens browser for Google sign-in) |

## When everything passes

Tell the user:

> upublish is ready. You can now use `/upublish` to publish sites, list your sites, or manage visibility.

If MCP tools weren't available and this is the first setup, remind them to restart their session first.
