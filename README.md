# upublish

Publish static sites to the web instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

---

## Install

```sh
npm install -g @upublish/cli
upublish login
```

### Codex

```sh
npx skills add omni-ping/upublish.skill
```

### Gemini CLI

```sh
gemini extensions install github:omni-ping/upublish.skill
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
