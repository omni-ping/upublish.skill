# Changelog

## [0.4.0] — 2026-05-14

### Added

- `upublish configure --platform <claude|gemini|codex>` — install platform plugin
- `upublish hello` — onboarding entry point, confirms setup is working
- Unified `/upublish` skill as single bootstrap entry point (replaces separate setup skill)
- `.claude-plugin` manifest for Claude Code plugin install

### Removed

- `upublish generate` — diagram generation feature removed
- `upublish-setup` skill — consolidated into root `/upublish` skill

## [0.3.0] — 2026-05-13

### Added

- Pre-publish checklist (`references/pre-publish-checklist.md`) — 5-point validation run before every publish

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
- `--json` flag on all commands
- MCP server with publish, list, and delete tools
- Codex plugin (`.codex-plugin/plugin.json`)
- Gemini extension (`gemini-extension.json` + `GEMINI.md`)
- npm package (`@omniping/upublish`)
