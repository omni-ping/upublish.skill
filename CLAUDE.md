# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

upublish is an MCP server + multi-platform AI plugin for publishing static sites to upubli.sh and pinn.sh (two hosted platform alternatives). It installs into Claude Code, Gemini CLI, and Codex as a plugin/extension.

## Commands

```sh
bun test lib/         # unit tests (lib/ only — the default `bun test`)
bun test              # all tests (lib/ + tests/)
bun test lib/auth.test.ts  # single test file
```

There is no build step for development — Bun runs TypeScript directly. The `dist/mcp.js` is a pre-built bundle for plugin distribution.

## Architecture

```
mcp/index.ts       MCP server adapter — registers 21 always-on tools plus 5 env-gated admin tools:
                   • auth/account: login, status, logout, namespace_create, domain, rename
                   • sites: publish, list, delete, promote, qrcode, analytics
                   • versions: versions_list, versions_delete, versions_restore, versions_limit
                   • access: passcode_add, passcode_list, passcode_revoke (now three tools, not one), gate, members
                   • admin (only when UPUBLISH_ADMIN=1): admin_user, admin_site, admin_stats, admin_storage, admin_domains
lib/core.ts        Facade — all user-facing operations, wires credentials + ApiClient per call
lib/auth.ts        Unified OAuth login (PKCE auth-code + token exchange), token refresh, credential read/write (~/.upublish/credentials)
lib/api-client.ts  Thin HTTP client — Bearer token injection via async TokenProvider
lib/namespace.ts   Namespace resolve + create (POST /api/ns)
lib/publish.ts     Hash files, diff against server manifest, upload only changed files to presigned R2 URLs, then finalize
lib/list.ts        GET /api/sites
lib/delete.ts      DELETE /api/sites/:slug
lib/types.ts       Shared types (Site, Visibility, FetchFn, TokenProvider)
```

**Sign-in is one unified flow.** `login` opens `{SITE}/login?flow=local` — the
website's provider chooser — with PKCE params. The chooser renders a button per
enabled provider (Google, GitHub, Microsoft, Discord, GitLab); clicking one forwards
all five params to `{API}/auth/:provider`. First-time users detour through browser
onboarding (first namespace + terms) before the single-use `code` arrives; the callback
returns that code, which `login` exchanges at `POST /auth/token/exchange` for tokens —
**tokens never appear in a URL**. Returning users are signed in directly. The old
per-flow auth endpoints have been removed (the skill never calls them).

**Key design rule: adapters import only from `lib/core.ts`.** `mcp/index.ts` calls core functions — it never constructs ApiClient or reads credentials directly. Core re-exports any types adapters need.

**Credentials are read fresh from disk on every operation** (no module-level cache). This eliminates stale-state bugs — the MCP server picks up new credentials from login without a restart.

## Dependency injection

Every core function accepts an optional `CoreDeps` bag (`credentialsPath`, `fetchFn`). Tests inject a temp credentials file and mock fetch to avoid network calls.

## Plugin manifests

The repo ships plugin configs for four platforms:
- `.claude-plugin/` — Claude Code (`plugin.json`, `marketplace.json`); MCP via `.mcp.json` (`${CLAUDE_PLUGIN_ROOT}`)
- `.codex-plugin/plugin.json` — Codex; MCP via `codex-mcp.json` (`cwd:"."` + relative path — Codex sets no plugin-root var)
- `gemini-extension.json` + `GEMINI.md` — Gemini CLI
- `plugin.json` + `mcp_config.json` — Antigravity CLI

`references/` contains markdown docs that the skill and GEMINI.md route users to (publishing, visibility, managing, troubleshooting).

## Version tracking

The version appears in six places that must stay in sync: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `plugin.json` (root), and `mcp/index.ts` (`PACKAGE_VERSION`). CI bumps all of them automatically on merge to main.

**Every change to this repo must include a version bump.** Plugin users only receive updates when the version number changes — without a bump, changes are invisible to installed plugins.

**Every change must also rebuild `dist/mcp.js`** — this is the pre-built bundle that plugin runners execute. Source file edits are invisible to installed plugins without a rebuild:
```sh
bun build mcp/index.ts --target=bun --outfile=dist/mcp.js && chmod +x dist/mcp.js
```

## Per-client timeout knobs

All four clients carry (or were investigated for) a per-tool wall-clock timeout ≥6h so large publishes survive. Units differ — a swap is a silent failure, not a runtime error:

| Client | Config file | Field | Value | Units |
|--------|-------------|-------|-------|-------|
| Claude Code | `.mcp.json` | `mcpServers.upublish.timeout` | 21600000 | **milliseconds** |
| Gemini CLI | `gemini-extension.json` | `mcpServers.upublish.timeout` | 21600000 | **milliseconds** |
| Codex | `codex-mcp.json` | `mcpServers.upublish.tool_timeout_sec` | 21600 | **seconds** |
| Antigravity | `mcp_config.json` | — | not set | — |

**Antigravity timeout knob — unverified, gap documented (DW-1.4).**
Investigation (2026-06-20): official Google/Antigravity docs cover MCP auth/connection only — no tool-call timeout or per-tool deadline knob documented. The per-server `timeout` field is reportedly dropped in Antigravity. An `MCP_SERVER_REQUEST_TIMEOUT` env var (ms) appears in practitioner blogs but is unconfirmed in any authoritative source. **No knob is set in `mcp_config.json`.** Residual risk: a long publish on Antigravity may time out at the client's default. Verify against a live Antigravity install before adding any knob.

**No client resets its per-tool timeout on `notifications/progress`.** Progress notifications are cosmetic everywhere; the wall-clock timeout knob is the only thing that keeps a long publish alive. Do not rely on heartbeats for timeout survival.

## Environment

- `UPUBLISH_API_URL` — overrides the API base URL (defaults to `https://api.upubli.sh`)
- `UPUBLISH_SITE_URL` — overrides the website base URL used for the provider-chooser login page (defaults to `https://upubli.sh`)
- Credentials stored at `~/.upublish/credentials` (refresh token, 0600 permissions)
