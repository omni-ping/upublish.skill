# upublish

Publish static sites to [upubli.sh](https://upubli.sh) instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Install

```sh
npm install -g @omniping/upublish
upublish login
```

## CLI commands

| Command | Description |
|---------|-------------|
| `upublish login` | Authenticate via Google OAuth |
| `upublish status` | Check authentication status |
| `upublish publish <dir> --slug <slug>` | Publish a directory |
| `upublish list` | List your published sites |
| `upublish delete <slug>` | Delete a site |
| `upublish configure --platform <platform>` | Install plugin for Claude, Gemini, or Codex |
| `upublish hello` | Confirm setup is working |

All commands accept `--json` for machine-readable output.
