# Changelog

## [0.6.0] — 2026-05-22

### Added

- MCP `login` tool — opens browser for Google sign-in and returns auth URL
- MCP `status` tool — checks authentication state
- `gemini-extension.json` now included in CI version bumps

### Removed

- CLI adapter (`bin/upublish.ts`) and Node shim (`dist/cli.cjs`) — all interaction is now through MCP tools
- `install.sh` — no longer needed (plugin install handles setup)
- `scripts/publish.sh` and npm publish pipeline — distribution is GitHub-based plugin install only
- `citty` dependency (CLI framework)

### Changed

- SKILL.md rewritten for MCP-only bootstrap (no CLI commands)
- GEMINI.md rewritten for MCP-only bootstrap with full tool list
- `gemini-extension.json` updated to use `bun run ${extensionPath}/dist/mcp.js` instead of npx
- Troubleshooting docs updated to reference MCP login tool instead of CLI
- Version synced to `gemini-extension.json` in CI

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
