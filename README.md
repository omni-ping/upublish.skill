# upublish

Creativity at the speed of AI. Our AI companions are great at producing content — now give them a place to help share it.

## Install

### Claude Code

```sh
claude plugin install omni-ping/upublish.claude
```

Then: `/upublish:setup` to get started, `/upublish:ask` to publish.

### Codex

```sh
npx skills add omni-ping/upublish.skill -g --agent codex
```

Then: `/upublish-setup` to get started, `/upublish` to publish.

### Gemini CLI

Coming soon.

### Standalone CLI

```sh
npm install -g @omniping/upublish
upublish login
```

---

## Quick start

```sh
upublish login
upublish publish ./my-site --slug my-site
upublish list
upublish delete my-site
```

Published sites appear at `https://username.upubli.sh/slug/` immediately.

---

## Commands

| Command | Description |
|---------|-------------|
| `upublish login` | Authenticate via Google OAuth |
| `upublish status` | Check authentication status |
| `upublish publish <dir> --slug <slug>` | Publish a directory |
| `upublish list` | List your published sites |
| `upublish delete <slug>` | Delete a site |
| `upublish generate --context <text>` | Generate a diagram from text |
| `upublish mcp` | Start the MCP server (used by AI assistants) |

All commands accept `--json` for machine-readable output.
