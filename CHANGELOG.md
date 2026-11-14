# Changelog

## [Unreleased]

### Added

- `template`: starter templates. `list` shows six (portfolio, landing page, resume, docs, coming soon, links page); `create` copies one into a new or empty folder for the agent to fill in and publish. Local AI tools only (not hosted MCP clients). It never overwrites: a non-empty folder needs `allow_non_empty: true`, and any file name clash is refused with nothing written. Guide: `references/templates.md`.
- `export` (local plugin only): downloads a site's published files into a folder, verifying each file's size and MD5. Pages through the new `GET /api/ns/:nsId/sites/:slug/export` route with 8 parallel downloads, refuses unsafe or colliding paths and non-empty folders (unless `overwrite: true`) before writing, never follows symlinks, and never prints presigned URL query strings. `export` is in `LOCAL_ONLY_TOOLS`, so the hosted server does not list it. Guide: `references/managing.md`.

### Security

- A server created without `localFiles: true` (the hosted `/mcp` router) no longer exposes any tool that acts on the machine it runs on. `publish`, `qrcode`, `login`, `logout`, `upgrade` and the `admin_*` tools are not registered (and refuse if called anyway), `data_rows` drops `path`/`overwrite` and refuses `export`, the default browser opener refuses, and `status` uses the injected `tokenProvider` instead of reading the host's credentials file. New exports: `LOCAL_ONLY_TOOLS`, `ADMIN_TOOLS`, `HostedServerUnsafeError`, `assertHostedServerSafe` and `createHostedServer(coreDeps)`, which forces `localFiles: false` and throws if a local-only or admin tool is registered. The stdio server (`stdioServerOptions()`) is unchanged.

### Fixed

- `publish` with `force: true` works again. It always sends real file hashes plus an explicit `force: true` manifest flag, and the server re-checks every stored file and re-uploads only those that are missing or corrupt (healthy files are never re-uploaded). The result reports how many files were verified and how many re-uploaded. Previously it sent random hashes, which the server rejected. Against an older server that ignores the flag, a forced publish behaves as a normal diff publish.

### Changed

- `passcode_add` and `visibility(..., passcode:)`: when the site already has the code, the server answers `existed: true` and the tools report "That passcode already exists on this site as '<label>' (id <id>); nothing changed." as a success (visibility still switches). Older servers without the field behave as before.

## [0.12.39] — 2026-11-07

### Added

- User backends (paid add-on): `publish_backend` deploys a small server-side handler next to a site at `{site}/_api/*` (an entry file bundled locally with `Bun.build`, or inline `code`; bundle limit 1 MB, compiler errors and Node built-in imports reported before anything is sent). `backend` covers status, versions, rollback, enable/disable, access (`site` or `public`), `delete` (destructive, needs `confirm_site`) and the add-on itself (`addon_enable` needs a consent echo: `accept_charge: true` plus the exact `expected` object, and states that the add-on includes Site data). `backend_secret` sets, lists (names only) and deletes secrets; values are never echoed, logged or stored locally. `backend_logs` shows the last 100 log lines. Guide: `references/backends.md`, with a tested contact-form starter (`references/backend-template.ts`).
- `publish` warns when a published file has an `_api` path segment (reserved for backends; such files are not served).

## [0.12.38] — 2026-11-06

### Fixed

- `passcode_add`: `label` is optional (omitted, empty or whitespace-only becomes `default`, as in `visibility`).
- `publish`: a `.git` file (git worktree or submodule pointer) is never uploaded and counts as a repo signal in the project-folder guard.
- `publish`: the plan-tier read after a live republish times out after 3 s instead of hanging.
- `gate` remove: when the server keeps a non-passcode state other than public, the error names that state instead of always saying PUBLIC.
- Plugin icon (`.claude-plugin/icon.png`) added; clears the `claude plugin validate` ICON_MISSING warning.

## [0.12.37] — 2026-11-05

Access control that tells the truth, a publish guard against wrong folders and secrets, and
guidance that matches the tools. The backend half (`DELETE /gate?visibility=` and
`previous_visibility` on `PUT /gate`) ships first.

### Added

- `visibility` tool: switch a published site between `public` and `passcode` without
  republishing ("make it private", "make it public again"). Passing `passcode` adds it before
  the switch, so a site is never locked with zero codes. It is refused with a passcode for
  `public`, and with no passcode when the site has none.
- `publish` takes `spa` for single-page apps. Pass it on every publish of the site: a
  republish without it turns SPA mode off when it also sets a non-public visibility (for example a passcode).
- `publish` takes `allow_no_index`, `allow_project_files` and `include_sourcemaps` to opt out
  of the new guards below.
- Republish output names what it replaced: `Replaced live version vB → vN. Undo:
  versions_restore(slug, B)` on paid plans, a "previous version can't be restored" note on
  the free plan, and `Live site unchanged (preview)` for previews.
- The stdio server prefixes every tool response with an upgrade note when it runs on Bun
  older than 1.4.4. `bun run typecheck` is clean and runs in CI.
- `LICENSE` (MIT) and `"license": "MIT"` in `package.json` and the Claude and Codex manifests.
- README: Bun requirement, `codex plugin marketplace upgrade`, and a "What this plugin sends
  where" section.

### Changed

- `publish` refuses a folder with no top-level `index.html` or one that looks like a project
  root (two or more of `package.json`, `src/`, lockfiles, `Dockerfile`, `.git/`), before
  anything uploads, and names the build folder it found.
- `publish` now also skips `.envrc`, `.npmrc`, `.netrc`, `.pypirc`, `credentials.json`,
  `secrets.*`, `id_rsa*`/`id_ed25519*` style keys, `*.p12`, `*.pfx`, `.aws/`, `.ssh/`, and
  source maps (`*.map`).
- `passcode_add` refuses unless the site is already `passcode`, instead of reporting success
  on a site that stayed public. It points to `visibility`.
- `gate` `remove` requires `visibility_after` (`public` or `passcode`) and reports the
  resulting visibility. `gate set` says when it replaces passcode protection.
- SKILL.md and GEMINI.md use short tool names (no `mcp_upublish_` prefix), list all 27 tools,
  route domain, undo, private/public, home page, SPA, QR, analytics, preview/promote and
  rename, flag the paid features, and tell the agent to confirm the address and any
  overwrite of a slug the user didn't name.
- References refreshed: `visibility.md`, `content-types/spa.md`, `troubleshooting.md`
  (auth routes now 404, the real empty-directory message, 402 storage approval, 100 MB free
  total), `publishing.md` (slug 1-255, free plan has no undo), `managing.md` (domain, rename,
  QR, analytics, preview, members), a shorter `pre-publish-checklist.md`, and
  `generate-pipeline.md` (no CLI).

## [0.12.36] — 2026-10-25

### Security

- Pinned Bun 1.4.4 (`.bun-version`, `engines.bun >=1.4.4`), the first release with the
  Brotli decoder fix (CVE-2026-111497).
- `@modelcontextprotocol/sdk` ^1.32.2 and `zod` ^4.6.7 clear 53 `bun audit` advisories.

### Changed

- Tool input schemas render through the SDK's zod 4 converter, which omits top-level
  `additionalProperties: false`. Unknown keys are still stripped at runtime.

## [0.12.35] — 2026-10-20

### Added

- Out-of-date note: the local MCP server checks `plugin.json` on GitHub `main` at most once a
  day and, when behind, adds one note to the first tool response telling the AI how to
  update on each host.
- Every request to the upublish API carries `X-Upublish-Client: upublish-mcp/<version>`.

### Changed

- README explains how to turn on auto-update and how to update on each host.

## [0.12.34] — 2026-10-19

### Added

- Site data add-on tools: `data` (status, enable with a two-step price consent, disable,
  wipe), `data_collection`, `data_rows` (including NDJSON export and import) and `data_jwt`,
  plus the AI-facing guide `references/site-data.md`.
- Row data is visitor-written, so it is fenced and labelled as untrusted in tool output and
  export files.

## [0.12.33] — 2026-10-10

### Fixed

- Publishing to a namespace's root (`_root`) without `--title` now sends the namespace name
  as the title instead of the literal slug, and preserves an existing hand-set root title
  on re-publish instead of resetting it.
- `gate set` now works. Every call had previously failed with `400 each field must be
  an object` — the tool sent a list of field-type strings while the API requires
  `{type, required}` objects — so there was no working way to configure a form gate
  from an AI client. Fields are now sent as objects, each marked required.
- `gate get` and `gate set` now print a gate's fields as readable text
  (`email, name, company (optional)`) instead of `[object Object]`.

### Removed

- The `message` gate field type. The API never accepted it — the server's valid set is
  exactly `email`, `name`, `company`, `phone` — so asking for it returned a 400. The
  tool now offers only the four types the server will take.

## [0.12.10] — 2026-06-14

### Added

- Add native support for the new Antigravity CLI (`agy`) by adding root-level `plugin.json` and `mcp_config.json` manifests.
- Updated CI workflows and automated tests to track and synchronize the new configuration manifests.

## [0.12.7] — 2026-06-11

### Changed

- Codex now installs the complete native plugin through the repository
  marketplace instead of installing only the standalone skill.
- Codex manifest paths, metadata, and MCP packaging now follow the native
  plugin layout.
- Skill reference paths now resolve correctly from the installed skill folder.
- Installation documentation now explains which components each plugin
  installation includes.

## [0.12.6] — 2026-06-06

### Changed

- `login` now opens the website's provider chooser at `{SITE}/login` instead of going
  directly to Google OAuth. Users can sign in with Google, GitHub, Microsoft, Discord,
  or GitLab. The chooser forwards PKCE params to the chosen provider; the rest of the
  flow (single-use code + token exchange) is unchanged.
- New `UPUBLISH_SITE_URL` environment variable overrides the website base URL used for
  the provider-chooser login page (defaults to `https://upubli.sh`).
- All MCP/CLI copy is now provider-neutral — no hardcoded "Google" references in log
  messages or tool descriptions.

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
