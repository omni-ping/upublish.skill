# upublish

Publish static sites to [upubli.sh](https://upubli.sh) instantly. One directory becomes a live URL at `address.upubli.sh/slug/`.

## Install

This repository is packaged as a native plugin for each supported host. The
plugin install includes the upublish skill, its reference files, and the MCP
server. Bun must be installed because the bundled MCP server runs on Bun.

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

To update, reinstall with the install command above.

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
3. Ask the agent to publish, list, delete, or manage sites with upublish

## What gets installed

- `skills/upublish/` provides the guided workflow and reference documentation.
- `dist/mcp.js` provides login, publishing, site management, addresses,
  passcodes, versions, previews, promotion, and member-management tools.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/marketplace.json`,
  `.mcp.json`, `gemini-extension.json`, `plugin.json`, and `mcp_config.json` adapt the same implementation to
  Claude Code, Codex, Gemini CLI, and Antigravity CLI.

This plugin does not currently ship separate commands, hooks, or subagents.
Those should only be added when they provide behavior that does not belong in
the existing skill or MCP server.
