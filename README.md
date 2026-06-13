# upublish

Publish static sites to [upubli.sh](https://upubli.sh) instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Install

This repository is packaged as a native plugin for each supported host. The
plugin install includes the upublish skill, its reference files, and the MCP
server. Bun must be installed because the bundled MCP server runs on Bun.

### Claude Code

```sh
/plugin marketplace add omni-ping/upublish.skill
/plugin install upublish@upublish.skill
```

### Codex

```sh
codex plugin marketplace add omni-ping/upublish.skill
codex plugin add upublish@upublish
```

### Gemini CLI

```sh
gemini extensions install omni-ping/upublish.skill
```

## Getting started

1. Install the plugin (see above)
2. Restart your session to load the MCP tools
3. Ask the agent to publish, list, delete, or manage sites with upublish

## What gets installed

- `skills/upublish/` provides the guided workflow and reference documentation.
- `dist/mcp.js` provides login, publishing, site management, namespaces,
  passcodes, versions, previews, promotion, and member-management tools.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/marketplace.json`,
  `.mcp.json`, and `gemini-extension.json` adapt the same implementation to
  Claude Code, Codex, and Gemini CLI.

This plugin does not currently ship separate commands, hooks, or subagents.
Those should only be added when they provide behavior that does not belong in
the existing skill or MCP server.
