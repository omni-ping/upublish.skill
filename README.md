# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

---

## Install

### Claude Code

```sh
npx skills add omni-ping/upublish.skill
```

Restart Claude Code. The `upublish` MCP tools appear automatically.

### npm (global CLI)

```sh
npm install -g @upublish/cli
upublish login
```

### curl | bash

```sh
curl -fsSL https://raw.githubusercontent.com/omni-ping/upublish.skill/main/install.sh | sh
```

Installs Bun (if needed), clones the repo, and prompts for login.

### Codex

Install the plugin from the Codex plugin directory, or add to your Codex config:

```json
{
  "plugins": ["omni-ping/upublish.skill"]
}
```

### Gemini CLI

```sh
gemini extension install omni-ping/upublish.skill
```

---

## Quick start

```sh
# Authenticate (first time only)
upublish login

# Publish a directory
upublish publish ./my-site --slug my-site

# List your sites
upublish list

# Delete a site
upublish delete my-site
```

Published sites appear at `https://username.upubli.sh/slug/` immediately.

---

## Commands

| Command | Description |
|---------|-------------|
| `upublish login` | Authenticate via Google OAuth |
| `upublish publish <dir> --slug <slug>` | Publish a directory |
| `upublish list` | List your published sites |
| `upublish delete <slug>` | Delete a site |
| `upublish generate --context <text>` | Generate a diagram from text |

All commands accept `--json` for machine-readable output.

---

## MCP tools (AI assistants)

When installed as a skill/plugin, these tools are available to your AI assistant:

- `mcp_upublish_publish` — publish a directory to the web
- `mcp_upublish_list` — list published sites
- `mcp_upublish_delete` — delete a site
- `mcp_upublish_generate` — generate a diagram

---

## Requirements

- [Bun](https://bun.sh) (for Claude Code / curl install)
- Node.js 18+ (for npm install)
- A Google account (for login)
