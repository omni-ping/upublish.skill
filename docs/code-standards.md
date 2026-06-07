<!-- base-commit: a1574752c2870def4eaf887a4f65335a7cf8b04c -->
<!-- generated: 2026-06-06 -->

# Code Standards

`@omniping/upublish` — a hexagonal MCP server + multi-platform AI plugin. Adapters (`mcp/index.ts`) call a single facade (`lib/core.ts`); domain modules under `lib/` hold the logic. No CLI binary, no `bin/`, no linter config — conventions are enforced by `bun:test`, not by eslint/biome/prettier.

## Forbidden Patterns

**Never import a `lib/` submodule from an adapter** — `mcp/index.ts` imports only `lib/core.ts`, which re-exports every type adapters need. Enforced by a test in `lib/publish.test.ts` (and `lib/qrcode.test.ts`) that scans every non-test `lib/*.ts` for `@modelcontextprotocol/sdk`.

```typescript
// BAD — adapter reaches into a submodule, couples the MCP layer to internals
import { ApiClient } from "../lib/api-client.ts";
import { renameSite } from "../lib/rename.ts";

// GOOD — adapter uses the facade; core wires ApiClient + credentials per call
import { rename, namespaceCreate, publish } from "../lib/core.ts";
import type { RenameResult, NamespaceCreateResult } from "../lib/core.ts";
```

**Never cache credentials at module scope** — `buildApiClient()` reads the credentials file on every core call. The MCP server picks up a token written by `login` without a restart.

```typescript
// BAD — captured once; stale if the user logs in after the server starts
const refreshToken = await readCredentials(credFile); // at module load

// GOOD — lib/core.ts: every export rebuilds the client from disk
export async function list(namespaceName?: string, deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps); // reads disk every call
  const ns = await resolveNamespace(apiClient, namespaceName);
  // ...
}
```

**Never put tokens in a URL or log a PKCE verifier** — the loopback callback receives only a single-use `code`; tokens arrive solely in the `/auth/token/exchange` response body. The verifier is sent only in that POST body.

```typescript
// GOOD — lib/auth.ts buildAuthUrl(): only the code_challenge goes in the URL
new URLSearchParams({ flow: "local", redirect_uri, code_challenge, code_challenge_method: "S256" });
// the code_verifier stays in scope; exchangeCodeForTokens() sends it only in the body
```

**Never use `any`, `@ts-ignore`, or `eslint-disable`** — none exist in the codebase. Narrow `unknown`; cast args from MCP handlers explicitly (`slug as string`).

**Never re-introduce zip-based upload (`fflate`)** — the publish flow is presigned-URL-only: manifest → PUT changed files → finalize. File bytes never pass through the API server.

## Code Examples

### Domain function: injectable client, structured success type, throw on API error

```typescript
// DO — lib/rename.ts: takes the ApiClient, returns a typed success shape,
// lets ApiClient.parseResponse throw on non-2xx (the facade catches it).
export async function renameSite(
  apiClient: ApiClient, nsId: string, oldSlug: string, newSlug: string, redirect: RedirectMode,
): Promise<RenameSuccess> {
  const result = await apiClient.post<SiteRenameResponse>(
    `/api/ns/${encodeURIComponent(nsId)}/sites/${encodeURIComponent(oldSlug)}/rename`,
    { new_slug: newSlug, redirect },
  );
  return { url: result.url, redirectExpiresAt: result.redirect_expires_at };
}

// DON'T — builds its own client, reads credentials, hardcodes the host: untestable
export async function renameSite(slug: string, newSlug: string) {
  const token = await readCredentials("~/.upublish/credentials");
  await fetch(`https://api.upubli.sh/api/sites/${slug}/rename`, { method: "POST", /* ... */ });
}
```

### Facade dispatch: one core function fronts two domain ops

```typescript
// DO — lib/core.ts rename(): `site` present → site rename, absent → namespace rename.
// Returns a discriminated union; it NEVER throws (see Error Handling).
export async function rename(opts: RenameArgs, deps?: CoreDeps): Promise<RenameResult> {
  let apiClient;
  try { apiClient = await buildApiClient(deps); }
  catch (err) { return { success: false, error: (err as Error).message }; }
  const redirect: RedirectMode = opts.redirect ?? "30d";
  try {
    const result = opts.site !== undefined
      ? await renameSite(apiClient, opts.nsId, opts.site, opts.newName, redirect)
      : await renameNamespace(apiClient, opts.nsId, opts.newName, redirect);
    return { success: true, url: result.url, redirectExpiresAt: result.redirectExpiresAt };
  } catch (err) { return { success: false, error: (err as Error).message }; }
}
```

### MCP tool: zod schema → call core → check the result shape

```typescript
// DO — mcp/index.ts: the rename tool checks result.success (not try/catch alone)
// because core.rename() reports expected failures as { success: false }.
async ({ nsId, site, newName, redirect }) => {
  try {
    const result = await rename({ nsId: nsId as string, site: site as string | undefined,
      newName: newName as string, redirect: redirect as RedirectMode | undefined }, coreDeps);
    if (!result.success) return errResponse(new Error(result.error));
    return okResponse(`Renamed ... New URL: ${result.url}`);
  } catch (err) { return errResponse(err); }
}

// DON'T — for a throwing core fn (publish/list/namespaceCreate), try/catch is the
// whole contract; there is no result.success to inspect.
async ({ name, domain }) => {
  try { const r = await namespaceCreate(name, domain, coreDeps); return okResponse(`...${r.namespace_id}`); }
  catch (err) { return errResponse(err); }
}
```

## Error Handling

Two coexisting strategies — match the one the function you touch already uses. No Result wrapper, no error codes; failures carry a human-readable `Error.message`.

**Throwing functions (the default):** `publish`, `list`, `deleteOp`, `promote`, `passcode*`, `gate*`, `members`, `versions*`, `qrcode`, `namespaceCreate`, admin ops. They throw `Error`; the MCP handler wraps every call in try/catch → `errResponse(err)`.

```typescript
// lib/api-client.ts — single error format for every API failure
throw new Error(`API error ${response.status}: ${errorMessage}`);
```

**Structured-return functions (never throw for expected failures):** `rename`, `status`, `logout`. They return a discriminated union so callers branch on a flag, not a catch.

```typescript
// lib/core.ts — these encode failure in the type, including auth failure
type StatusResult = { authenticated: true; username: string; namespaces: Namespace[] }
                  | { authenticated: false; error?: string };
type RenameResult = { success: true; url: string; redirectExpiresAt: string | null }
                  | { success: false; error: string };
type LogoutResult = { loggedOut: true } | { loggedOut: false; error: string };
```

**Error enrichment at the domain boundary** — `namespaceCreate` appends actionable guidance only to a tier-limit 403; all other errors pass through verbatim.

```typescript
// lib/namespace.ts — enrich the one case the agent can act on, leave the rest
const isTierLimit = /API error 403/.test(err.message) && /limit/i.test(err.message);
if (isTierLimit) return new Error(`${err.message} Upgrade at ${UPGRADE_URL} to create more namespaces.`);
return err;
```

**Best-effort side effects are silently swallowed** — server-side token revoke on logout, and `log()`, must never block or break the primary operation.

```typescript
// lib/core.ts logout() — offline logout must still delete local creds
try { await fetchFn(`${API_BASE_URL}/auth/token/revoke`, { /* ... */ }); }
catch { /* best-effort revoke */ }
```

## Imports & Dependency Direction

```
mcp/index.ts  →  lib/core.ts  →  domain modules (list, publish, delete, promote,
                                  rename, namespace, passcode, gate, members,
                                  versions, qrcode, admin, auth, api-client)
                              →  lib/types.ts   (leaf — no internal imports)
                              →  lib/log.ts     (leaf — no internal imports)
```

Use the `.ts` extension on every import (Bun requires it). Import order: `node:` builtins → external packages (`zod`, `@modelcontextprotocol/sdk`, `open`, `qrcode`) → internal (`./core.ts`, `../lib/core.ts`).

When a core export name collides with the imported domain function, alias the import with a `domain` prefix and keep the bare name for the public facade export.

```typescript
// lib/core.ts — the export is publish(); the import is domainPublish()
import { publish as domainPublish } from "./publish.ts";
import { namespaceCreate as domainNamespaceCreate } from "./namespace.ts";
export async function publish(args: PublishArgs, deps?: CoreDeps) { /* ... */ return domainPublish({ /* ... */ }); }
```

`resolveNamespace()` returns the full `Namespace` (`{ id, name, domain, role? }`), not just the id. Core passes `ns.id` down to domain functions and `ns` itself back to callers — avoids a second metadata fetch.

## Testing Patterns

Framework: `bun:test`. Unit tests co-located in `lib/` as `*.test.ts` (the default `bun test` runs `lib/` only via the `test` script). Adapter/integration tests live in `tests/` (`bun run test:all`). No `bun:mock` — dependencies are injected.

**Inject `CoreDeps`, never mock modules.** Every core function takes `{ credentialsPath?, fetchFn? }`. Tests write a temp credentials file and supply a `fetchFn` that returns canned `Response`s — no network.

```typescript
// lib/core-rename.test.ts — temp cred file + a fetch that asserts on the request
const fetchFn = makeMockFetch((url, init) => { /* assert url/method/body, return Response */ });
const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
const result = await rename({ nsId, site, newName, redirect }, deps);
```

**`login()` is driven entirely from `LoginDeps`** — no real browser, server, or network. Stub `startCallbackServer().waitForCode()` to hand back the auth code, and `fetchFn` to answer the token exchange.

```typescript
// lib/login-exchange.test.ts
makeDeps({ credentialsFilePath: credFile, startCallbackServer: codeServer("code-123"), fetchFn: exchangeOk() });
```

**`ApiClient` tests:** construct directly with a static token provider + mock fetch; assert on captured URL/method/body.

```typescript
const client = new ApiClient(BASE_URL, async () => "test-token", fetchFn);
```

**Test naming:** `test_DW_<phase>_<n>_<description>` — `DW` = the "done-when" criterion from the plan that motivated the test (e.g. `test_DW_5_1_collect_files_hashes_each_file`).

**Boundary test (keep it green):** `lib/publish.test.ts` (and `lib/qrcode.test.ts`) read every non-test `lib/*.ts` and assert none import `@modelcontextprotocol/sdk`.

```typescript
const offenders: string[] = [];
for (const f of files) if (readFileSync(join(libDir, f), "utf-8").includes("@modelcontextprotocol/sdk")) offenders.push(f);
expect(offenders).toEqual([]);
```

## Naming Conventions

Files: `kebab-case.ts`. Tests: `*.test.ts`; namespace-scoped variants use `*.ns.test.ts`; facade-vs-domain split uses `core-<feature>.test.ts` (e.g. `core-rename.test.ts`) for the facade and `<feature>.test.ts` for the domain module.

Domain terms:
- `slug` — URL-safe site identifier (never "name" or "id")
- `ns` is the full `Namespace` object; `nsId` is the bare id string passed to domain functions
- `CoreDeps` — the DI bag for the facade (`credentialsPath`, `fetchFn`); `LoginDeps` — the richer bag for `login()` (browser, callback server, logger, fetch)
- `deleteOp` — facade name for delete (avoids shadowing the `delete` keyword)
- `domainPublish`, `domainNamespaceCreate`, … — `domain`-prefixed import aliases in `core.ts` where the facade reuses the export name

API responses use `snake_case` and types mirror them verbatim: `user_id`, `file_count`, `passcode_hash`, `redirect_expires_at`, `default_namespace_id`. Map to camelCase only when building the lib-facing success type (`redirect_expires_at` → `redirectExpiresAt`).

## File Organization

```
lib/             Domain logic + facade. Unit tests co-located as *.test.ts.
  core.ts          Facade — every user-facing op; buildApiClient() per call; re-exports for adapters
  auth.ts          Unified PKCE login: generatePkce, buildAuthUrl, exchangeCodeForTokens, token refresh, cred I/O
  api-client.ts    Thin HTTP client — Bearer injection, get/post/put/patch/delete, manifest()/finalize()
  publish.ts       Hash files, diff manifest, stream presigned PUT uploads w/ retry, finalize
  rename.ts        renameSite + renameNamespace (POST .../rename) — NEW
  namespace.ts     resolveNamespace + namespaceCreate (POST /api/ns) w/ tier-limit enrichment
  list/delete/promote/passcode/gate/members/versions/qrcode.ts  one domain area each
  admin.ts         Env-gated admin ops (user/site/stats/storage/domains)
  types.ts         Shared types (leaf) | log.ts  file logger ~/.upublish/publish.log (leaf, never throws)
mcp/index.ts     MCP adapter — createServer(coreDeps?, opts?) factory, tool registry, okResponse/errResponse
tests/           Integration/adapter tests (import from mcp/)
references/      Markdown docs the skill/GEMINI.md route users to
dist/mcp.js      Pre-built bundle — rebuilt by CI, never hand-edited
```

New domain area: add `lib/<area>.ts` + co-located `lib/<area>.test.ts`, wire it through `lib/core.ts` (import + facade fn + type re-export), then register the MCP tool in `mcp/index.ts`.

## Technology Decisions

- **Bun** is runtime, test runner, and bundler. Only `node:` builtins, no Node-specific runtime APIs. No build step in dev — Bun runs `.ts` directly.
- **PKCE auth is real (RFC 7636)** via Web Crypto (`crypto.subtle`), not `node:crypto`. One unified entry `GET /auth/google?flow=local`; the legacy per-flow endpoints return HTTP 410 `upgrade_required` — do not call them.
- **No linter/formatter config** (no eslint/biome/prettier). Style is enforced by tests and review, not tooling. `tsconfig.json` is strict.
- **zod** for MCP input schemas (required by the SDK). **open** for the browser launch, **qrcode** for the qrcode tool.
- **Version must be bumped on every change** — plugins only update when the number changes. It lives in five files that must stay in sync: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `mcp/index.ts` (`PACKAGE_VERSION`). CI bumps them on merge.
- **Rebuild `dist/mcp.js` on every source change** — installed plugins run the bundle, not the source: `bun build mcp/index.ts --target=bun --outfile=dist/mcp.js && chmod +x dist/mcp.js`.
- **Admin tools are env-gated** — only registered when `UPUBLISH_ADMIN=1`; otherwise the registry is byte-identical to the public baseline.

## Exemplar Files

**`lib/core.ts`** — the facade: `buildApiClient()` fresh-creds-per-call, `CoreDeps` injection, `domain*` import aliasing, adapter type re-exports, both error strategies (throwing `publish`/`list` vs structured-return `rename`/`status`/`logout`).

**`lib/rename.ts` + `lib/core.ts` rename()** — newest convention pair: a slim domain module that throws, fronted by a facade fn that catches into a `{ success }` union and dispatches site-vs-namespace on one optional arg.

**`lib/auth.ts`** — the full PKCE login: `generatePkce()` (Web Crypto), `buildAuthUrl()` (challenge only), loopback `waitForCode()`, `exchangeCodeForTokens()` (verifier in body, tokens in response), `createTokenProvider()` (transparent refresh). Fully deps-injected.

**`lib/api-client.ts`** — token-provider-per-request pattern, the verb methods, typed `manifest()`/`finalize()`, single `parseResponse()` that is the one place errors are thrown.

**`mcp/index.ts`** — `createServer(coreDeps?, opts?)` factory for test injection, `okResponse`/`errResponse`, env-gated admin registration, and the two adapter idioms (try/catch-only for throwing core fns; `if (!result.success)` for structured-return fns).
