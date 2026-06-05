# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

upublish is an MCP server + multi-platform AI plugin for publishing static sites to [upubli.sh](https://upubli.sh). It installs into Claude Code, Gemini CLI, and Codex as a plugin/extension.

## Commands

```sh
bun test lib/         # unit tests (lib/ only — the default `bun test`)
bun test              # all tests (lib/ + tests/)
bun test lib/auth.test.ts  # single test file
```

There is no build step for development — Bun runs TypeScript directly. The `dist/mcp.js` is a pre-built bundle for plugin distribution.

## Architecture

```
mcp/index.ts       MCP server adapter — exposes login, status, namespace_create, publish, list, delete, passcode, and logout tools
lib/core.ts        Facade — all user-facing operations, wires credentials + ApiClient per call
lib/auth.ts        Unified OAuth login (PKCE auth-code + token exchange), token refresh, credential read/write (~/.upublish/credentials)
lib/api-client.ts  Thin HTTP client — Bearer token injection via async TokenProvider
lib/namespace.ts   Namespace resolve + create (POST /api/ns)
lib/publish.ts     Hash files, diff against server manifest, upload only changed files to presigned R2 URLs, then finalize
lib/list.ts        GET /api/sites
lib/delete.ts      DELETE /api/sites/:slug
lib/types.ts       Shared types (Site, Visibility, FetchFn, TokenProvider)
```

**Sign-in is one unified flow.** `login` opens `GET /auth/google?flow=local` with PKCE.
First-time users transparently detour through a browser onboarding page (username +
first namespace + terms); the callback returns a single-use `code`, which `login`
exchanges at `POST /auth/token/exchange` for tokens — **tokens never appear in a URL**.
Returning users are signed in directly. Old per-flow auth endpoints are retired and
return HTTP 410 `upgrade_required`.

**Key design rule: adapters import only from `lib/core.ts`.** `mcp/index.ts` calls core functions — it never constructs ApiClient or reads credentials directly. Core re-exports any types adapters need.

**Credentials are read fresh from disk on every operation** (no module-level cache). This eliminates stale-state bugs — the MCP server picks up new credentials from login without a restart.

## Dependency injection

Every core function accepts an optional `CoreDeps` bag (`credentialsPath`, `fetchFn`). Tests inject a temp credentials file and mock fetch to avoid network calls.

## Plugin manifests

The repo ships plugin configs for three platforms:
- `.claude-plugin/` — Claude Code (`plugin.json`, `marketplace.json`)
- `.codex-plugin/plugin.json` — Codex
- `gemini-extension.json` + `GEMINI.md` — Gemini CLI

`references/` contains markdown docs that the skill and GEMINI.md route users to (publishing, visibility, managing, troubleshooting).

## Version tracking

The version appears in five places that must stay in sync: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, and `mcp/index.ts` (`PACKAGE_VERSION`). CI bumps all of them automatically on merge to main.

**Every change to this repo must include a version bump.** Plugin users only receive updates when the version number changes — without a bump, changes are invisible to installed plugins.

**Every change must also rebuild `dist/mcp.js`** — this is the pre-built bundle that plugin runners execute. Source file edits are invisible to installed plugins without a rebuild:
```sh
bun build mcp/index.ts --target=bun --outfile=dist/mcp.js && chmod +x dist/mcp.js
```

## Environment

- `UPUBLISH_API_URL` — overrides the API base URL (defaults to `https://api.upubli.sh`)
- Credentials stored at `~/.upublish/credentials` (refresh token, 0600 permissions)
