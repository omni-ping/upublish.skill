# Changelog

All notable changes to upublish are documented here.

## [0.1.0] — 2026-05-13

Initial release as a standalone skill repo.

### Added

- `upublish login` — Google OAuth authentication with PKCE, credentials stored at `~/.upublish/credentials`
- `upublish publish <dir> --slug <slug>` — zip and publish a static site directory
- `upublish list` — list all published sites with visibility and URL
- `upublish delete <slug>` — delete a published site
- `upublish generate --context <text>` — generate a diagram from a text description
- `--json` flag on all commands for machine-readable output
- MCP server with publish, list, delete, and generate tools for AI assistants
- Claude Code skill (SKILL.md + `.claude-plugin/plugin.json`)
- Codex plugin (`.codex-plugin/plugin.json` + `.mcp.json`)
- Gemini extension (`gemini-extension.json` + GEMINI.md)
- `curl | bash` installer (`install.sh`)
- npm package (`@omniping/upublish`) with Node.js shim for environments without Bun
