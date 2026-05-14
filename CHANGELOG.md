# Changelog

## [0.2.0] — 2026-05-13

### Changed

- Hexagonal architecture refactor — core logic separated from adapters
- Unified manifests to use `npx` for all platforms

### Added

- Gemini CLI extension support (`gemini-extension.json`)

## [0.1.0] — 2026-05-13

Initial release as a standalone skill repo.

### Added

- `upublish login` — Google OAuth authentication with PKCE
- `upublish publish <dir> --slug <slug>` — zip and publish a static site
- `upublish list` — list all published sites
- `upublish delete <slug>` — delete a published site
- `upublish generate --context <text>` — generate a diagram from text
- `--json` flag on all commands
- MCP server with publish, list, delete, and generate tools
- Codex plugin (`.codex-plugin/plugin.json`)
- Gemini extension (`gemini-extension.json` + `GEMINI.md`)
- npm package (`@omniping/upublish`)
