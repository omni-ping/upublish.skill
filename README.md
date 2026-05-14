# upublish

Publish static sites to [upubli.sh](https://upubli.sh) instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Install

### Claude Code

```sh
claude plugin install omni-ping/upublish.claude
```

Then: `/upublish:setup` to authenticate, `/upublish` to publish.

See [omni-ping/upublish.claude](https://github.com/omni-ping/upublish.claude) for details.

### Codex / Cursor / other agents

```sh
npx skills add omni-ping/upublish.skill -g --agent codex
```

Then: `/upublish-setup` to authenticate, `/upublish` to publish.

### Gemini CLI

```sh
gemini extensions install omni-ping/upublish.skill
```

### Standalone CLI

```sh
npm install -g @omniping/upublish
upublish login
```

---

## CLI commands

| Command | Description |
|---------|-------------|
| `upublish login` | Authenticate via Google OAuth |
| `upublish status` | Check authentication status |
| `upublish publish <dir> --slug <slug>` | Publish a directory |
| `upublish list` | List your published sites |
| `upublish delete <slug>` | Delete a site |
| `upublish generate --context <text>` | Generate a diagram from text |

All commands accept `--json` for machine-readable output.
