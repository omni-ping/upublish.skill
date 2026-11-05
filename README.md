# upublish

upublish gives everything your AI agent builds a permanent home on the web. Say "publish this" in Claude Code, Codex, Gemini CLI or Antigravity and get back `you.upubli.sh/thing`: real multi-file sites, free, with unlimited bandwidth. Roll back a version, print a QR code, or point your own domain at it. Passcodes, version rollback and custom domains come with a paid plan.

Free plan: 1 address, unlimited sites, 100 MB. Pro is $4/mo. Details at [upubli.sh](https://upubli.sh).

## Requirements

[Bun](https://bun.sh) 1.4.4 or newer. The bundled MCP server runs on Bun, and older versions have a security flaw (CVE-2026-111497) and a publish bug. If yours is older, run `bun upgrade`; the server also warns you in its tool output.

## Install

This repository is packaged as a native plugin for each supported host. The
plugin install includes the upublish skill, its reference files, and the MCP
server.

### Claude Code

Run each command separately:

```sh
/plugin marketplace add omni-ping/upublish.skill
/plugin install upublish@upublish.skill
```

Turn on auto-update so new upublish versions install themselves. Run `/plugin`,
open **Marketplaces**, select `upublish.skill`, and choose **Enable auto-update**.
Claude Code does not enable this by default for third-party marketplaces.

New versions load after `/reload-plugins` or a restart. To update by hand at any
time, run:

```sh
/plugin update upublish@upublish.skill
```

Hitting `Permission denied (publickey)`? Update Claude Code, or use the full HTTPS URL `https://github.com/omni-ping/upublish.skill.git` — and run each command separately.

### Codex

```sh
codex plugin marketplace add omni-ping/upublish.skill
codex plugin add upublish@upublish
```

To update, run:

```sh
codex plugin marketplace upgrade upublish
```

### Antigravity CLI

```sh
agy plugin install https://github.com/omni-ping/upublish.skill
```

To update, reinstall with the install command above.

### Gemini CLI

```sh
gemini extensions install omni-ping/upublish.skill
```

To update, run:

```sh
gemini extensions update upublish
```

## Getting started

1. Install the plugin (see above)
2. Restart your session to load the MCP tools
3. Ask the agent to publish, make a site private, undo a publish, put a site on your domain, or manage sites with upublish

## What gets installed

- `skills/upublish/` provides the guided workflow and reference documentation.
- `dist/mcp.js` provides login, publishing, site management, addresses,
  passcodes, visibility, versions, previews, promotion, custom domains, and member-management tools.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/marketplace.json`,
  `.mcp.json`, `gemini-extension.json`, `plugin.json`, and `mcp_config.json` adapt the same implementation to
  Claude Code, Codex, Gemini CLI, and Antigravity CLI.

This plugin does not currently ship separate commands, hooks, or subagents.
Those should only be added when they provide behavior that does not belong in
the existing skill or MCP server.

## What this plugin sends where

The plugin runs locally and talks to these hosts, and no others:

| Host | What | When |
|---|---|---|
| `api.upubli.sh` | Your account (sign-in tokens), the file manifest of a publish (path, MD5, size), site settings, and tool requests. Every request carries an `X-Upublish-Client: upublish-mcp/<version>` header. | Any tool call |
| Cloudflare R2 (presigned URLs from the API) | The bytes of the files you publish, uploaded straight from your machine. File contents never pass through the API server. | `publish` |
| Your browser, then the sign-in provider (Google, GitHub, Microsoft, Discord or GitLab) | The OAuth sign-in. The plugin only opens `upubli.sh/login` and listens on `localhost` for a one-time code; the provider talks to your browser, not to the plugin. Stripe Checkout (`upgrade`) is also browser-only. | `login`, `upgrade` |
| `raw.githubusercontent.com` | A read of `plugin.json` on `main` to see whether a newer version exists. At most once a day, with a 3 s timeout. Only a plain `x.y.z` version is accepted from it. | First tool call of a day |

On disk it keeps `~/.upublish/credentials` (a refresh token, mode 0600) and `~/.upublish/update-check.json`. It publishes only the directory you point it at, and skips secrets and repo files by default.

## License

[MIT](LICENSE)
