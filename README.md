# upublish

Publish static sites to [upubli.sh](https://upubli.sh) instantly. One directory becomes a live URL at `username.upubli.sh/slug/`.

## Install

### Claude Code

```sh
/plugin marketplace add omni-ping/upublish.skill
/plugin install upublish@omni-ping-upublish
```

### Codex

```sh
npx skills add omni-ping/upublish.skill -g --agent codex
```

### Gemini CLI

```sh
gemini extensions install omni-ping/upublish.skill
```

## Getting started

1. Install the plugin (see above)
2. Type `/upublish` — the skill will install the CLI and configure everything
3. Restart your session to load the MCP tools
4. `/upublish hello` to onboard 
5. `/upublish` to publish, list, delete, or manage sites
