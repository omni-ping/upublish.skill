# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

upublish is a CLI tool + MCP server + multi-platform AI plugin for publishing static sites to [upubli.sh](https://upubli.sh). It ships as the npm package `@omniping/upublish` and installs into Claude Code, Gemini CLI, and Codex as a plugin/extension.

## Commands

```sh
bun test lib/         # unit tests (lib/ only — the default `bun test`)
bun test              # all tests (lib/ + tests/)
bun test lib/auth.test.ts  # single test file
```

There is no build step for development — Bun runs TypeScript directly. The `dist/cli.cjs` is a pre-built artifact checked into git for npm consumers.

Publishing to npm: `./scripts/publish.sh` (requires `NPM_TOKEN` in `.env` or environment).

## Architecture

```
bin/upublish.ts    CLI adapter (citty) — subcommands: login, publish, list, delete, status, configure, hello, mcp
mcp/index.ts       MCP server adapter — exposes publish, list, delete as MCP tools
lib/core.ts        Facade — all user-facing operations, wires credentials + ApiClient per call
lib/auth.ts        OAuth login flow, PKCE, token refresh, credential read/write (~/.upublish/credentials)
lib/api-client.ts  Thin HTTP client — Bearer token injection via async TokenProvider
lib/publish.ts     Zip a directory (fflate) and upload via multipart POST
lib/list.ts        GET /api/sites
lib/delete.ts      DELETE /api/sites/:slug
lib/types.ts       Shared types (Site, Visibility, FetchFn, TokenProvider)
```

**Key design rule: adapters import only from `lib/core.ts`.** Both `bin/upublish.ts` and `mcp/index.ts` call core functions — they never construct ApiClient or read credentials directly. Core re-exports any types adapters need.

**Credentials are read fresh from disk on every operation** (no module-level cache). This eliminates stale-state bugs — the MCP server picks up new credentials from `upublish login` without a restart.

## Dependency injection

Every core function accepts an optional `CoreDeps` bag (`credentialsPath`, `fetchFn`). Tests inject a temp credentials file and mock fetch to avoid network calls. CLI command runners accept deps bags with overridable function references (e.g., `publishFn`, `listFn`).

## Plugin manifests

The repo ships plugin configs for three platforms:
- `.claude-plugin/` — Claude Code (`plugin.json`, `marketplace.json`)
- `.codex-plugin/plugin.json` — Codex
- `gemini-extension.json` + `GEMINI.md` — Gemini CLI

`references/` contains markdown docs that the skill and GEMINI.md route users to (publishing, visibility, managing, troubleshooting).

## Version tracking

The version (`0.4.0`) appears in three places that must stay in sync: `package.json`, `.claude-plugin/plugin.json`, and `mcp/index.ts` (`PACKAGE_VERSION`). The `.codex-plugin/plugin.json` also carries a version field.

## Environment

- `UPUBLISH_API_URL` — overrides the API base URL (defaults to `https://api.upubli.sh`)
- Credentials stored at `~/.upublish/credentials` (refresh token, 0600 permissions)
