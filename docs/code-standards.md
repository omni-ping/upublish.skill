<!-- base-commit: d12baf41aa603e2b7af38e87f10a8c942bfd3f8b -->
<!-- generated: 2026-06-18 -->

# Code Standards

`@omniping/upublish` — a hexagonal MCP server + multi-platform AI plugin. The adapter (`mcp/index.ts`) calls a single facade (`lib/core.ts`); domain modules under `lib/` hold the logic. No CLI binary, no `bin/`, no linter config — conventions are enforced by `bun:test` and review, not by eslint/biome/prettier.

## Forbidden Patterns

**Never import a `lib/` submodule from an adapter** — `mcp/index.ts` imports only `lib/core.ts`, which re-exports every type/symbol adapters need. Enforced by a boundary test in `lib/publish.test.ts` and `lib/qrcode.test.ts` that scans every non-test `lib/*.ts` for `@modelcontextprotocol/sdk`.

```typescript
// BAD — adapter reaches into a submodule, couples the MCP layer to internals
import { ApiClient } from "../lib/api-client.ts";
import { renameSite } from "../lib/rename.ts";

// GOOD — adapter uses the facade; core wires ApiClient + credentials per call
import { rename, namespaceCreate, publish, OverageApprovalError, displayMsg } from "../lib/core.ts";
import type { RenameResult, NamespaceCreateResult } from "../lib/core.ts";
```

**Never cache credentials or the ApiClient at module scope** — `buildApiClient()` reads credentials and builds the client on every core call. The MCP server picks up a token written by `login` without a restart.

```typescript
// BAD — captured once; stale if the user logs in after the server starts
const refreshToken = await readCredentials(credFile); // at module load

// GOOD — lib/core.ts: every export rebuilds the client from disk per call
export async function list(namespaceName?: string, deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps); // reads disk (or injected provider) every call
  const ns = await resolveNamespace(apiClient, namespaceName);
  // ...
}
```

**Never put tokens in a URL or log a PKCE verifier** — the loopback callback receives only a single-use `code`; tokens arrive solely in the `/auth/token/exchange` response body. The verifier is sent only in that POST body, never in the authorize URL.

```typescript
// GOOD — lib/auth.ts buildAuthUrl(): only the code_challenge goes in the URL
new URLSearchParams({ flow: "local", redirect_uri, code_challenge, code_challenge_method: "S256" });
// the code_verifier stays in scope; exchangeCodeForTokens() sends it only in the body
```

**Never use `any`, `@ts-ignore`, or `eslint-disable`** — none exist in non-test source. Narrow `unknown`; cast args from MCP handlers explicitly (`slug as string`). `tsconfig.json` is `strict`.

**Never re-introduce zip-based upload (`fflate`)** — the publish flow is presigned-URL-only: manifest → PUT changed files → finalize. File bytes never pass through the API server.

## Code Examples

### Domain function: injectable client, structured success type, throw on API error

```typescript
// DO — lib/promote.ts: takes the ApiClient, returns a typed success shape,
// lets apiClient.post → parseResponse throw on non-2xx (the facade catches it).
export async function promote(apiClient: ApiClient, nsId: string, slug: string): Promise<PromoteResult> {
  const result = await apiClient.post<PromoteResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/promote`, {},
  );
  return { url: result.url };
}

// DON'T — builds its own client, reads credentials, hardcodes the host: untestable
export async function promote(slug: string) {
  const token = await readCredentials("~/.upublish/credentials");
  await fetch(`https://api.upubli.sh/api/sites/${slug}/promote`, { method: "POST" });
}
```

### Facade dispatch: one core function fronts two domain ops, never throws

```typescript
// DO — lib/core.ts rename(): `site` present → site rename, absent → namespace rename.
// Returns a discriminated union; it NEVER throws (see Error Handling). Auth failure
// is caught into { success: false } too, not rethrown.
export async function rename(opts: RenameArgs, deps?: CoreDeps): Promise<RenameResult> {
  let apiClient;
  try { apiClient = await buildApiClient(deps); }
  catch (err) { return { success: false, error: (err as Error).message }; }
  const redirect: RedirectMode = opts.redirect ?? "30d";
  try {
    const ns = await resolveNamespaceRef(apiClient, opts.nsId);
    const result = opts.site !== undefined
      ? await renameSite(apiClient, ns.id, opts.site, opts.newName, redirect)
      : await renameNamespace(apiClient, ns.id, opts.newName, redirect);
    return { success: true, url: result.url, redirectExpiresAt: result.redirectExpiresAt };
  } catch (err) { return { success: false, error: (err as Error).message }; }
}
```

### Multi-action core function: discriminated args + result that carries `action`

```typescript
// DO — lib/core.ts gate()/members(): a single facade fn switches on args.action and
// tags the result with the same action so the adapter narrows without re-deriving it.
export async function gate(args: GateArgs, deps?: CoreDeps): Promise<GateResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, args.namespace);
  switch (args.action) {
    case "get": { const r = await domainGetGate(apiClient, ns.id, args.slug); return { action: "get", ...r }; }
    // ... one case per action, each returns { action, ...result }
  }
}
```

## Error Handling

Two coexisting strategies — match the one the function you touch already uses. There is no `Result<T,E>` wrapper; failures carry a human-readable `Error.message`.

**Throwing functions (the default):** `publish`, `list`, `deleteOp`, `promote`, `analytics`, `passcode*`, `gate`, `members`, `versions*`, `qrcode`, `namespaceCreate`, `domain`, admin ops. They throw `Error`; the MCP handler wraps every call in try/catch → `errResponse(err)`.

```typescript
// lib/api-client.ts parseResponse() — the ONE place API errors are thrown.
// Throws a typed ApiError subclass that preserves status + parsed body so domain
// enrichers can read structured fields instead of regexing the message.
throw new ApiError(response.status, parsedBody, `API error ${response.status}: ${errorMessage}`);
```

**Structured-return functions (never throw for expected failures):** `rename`, `status`, `logout`. They return a discriminated union so callers branch on a flag, not a catch.

```typescript
// lib/core.ts — failure is encoded in the type, including auth failure
type StatusResult = { authenticated: true; username: string; namespaces: Namespace[] }
                  | { authenticated: false; error?: string };
type RenameResult = { success: true; url: string; redirectExpiresAt: string | null }
                  | { success: false; error: string };
type LogoutResult = { loggedOut: true } | { loggedOut: false; error: string };
```

**Typed errors for cases the adapter must render specially** — when an error carries data the adapter needs (a URL, a price), throw a named `Error` subclass instead of a string the adapter would have to parse.

```typescript
// lib/namespace.ts enrichNamespaceError() — convert a 402 into a typed error with fields
if (err instanceof ApiError && err.status === 402 && code === "needs_overage_approval") {
  return new OverageApprovalError(approvalUrl, price, `Needs overage approval: ... ${approvalUrl}`);
}
// mcp/index.ts — the adapter checks `instanceof` and formats the structured fields
if (err instanceof OverageApprovalError) { /* show err.approval_url, err.price */ }
```

**Error enrichment at the domain boundary** — append actionable guidance only to the one case the agent can act on (403 tier-limit gets the upgrade URL); all other errors pass through verbatim because backend text is already actionable.

**Best-effort side effects are silently swallowed** — server-side token revoke on `logout`, namespace fetch in `status`, and `log()` must never block or break the primary operation.

```typescript
// lib/core.ts logout() — offline logout must still delete local creds
try { await fetchFn(`${API_BASE_URL}/auth/token/revoke`, { /* ... */ }); }
catch { /* best-effort revoke */ }
```

**Display translation happens only at the adapter boundary** — lib/* error strings stay raw (testable); `displayMsg()` rewrites "namespace" → "address" at the single `errResponse()` chokepoint in `mcp/index.ts`.

```typescript
// mcp/index.ts errResponse() — translate once, at the edge
return { content: [{ type: "text", text: displayMsg((err as Error).message) }], isError: true };
```

## Imports & Dependency Direction

```
mcp/index.ts  →  lib/core.ts  →  domain modules (list, publish, delete, promote, rename,
                                  namespace, analytics, passcode, gate, members, versions,
                                  qrcode, domain, admin, auth, api-client)
                              →  lib/types.ts       (leaf — no internal imports)
                              →  lib/log.ts         (leaf — no internal imports)
                              →  lib/display-msg.ts (leaf — pure, no internal imports)
```

Use the `.ts` extension on every import (Bun requires it). Import order: `node:` builtins → external packages (`zod`, `@modelcontextprotocol/sdk`, `open`, `qrcode`) → internal (`./core.ts`, `../lib/core.ts`).

When a core export name collides with the imported domain function, alias the import with a `domain` prefix and keep the bare name for the public facade export.

```typescript
// lib/core.ts — the export is publish(); the import is domainPublish()
import { publish as domainPublish } from "./publish.ts";
import { namespaceCreate as domainNamespaceCreate } from "./namespace.ts";
export async function publish(args: PublishArgs, deps?: CoreDeps) { /* ... */ return domainPublish({ /* ... */ }); }
```

`resolveNamespace()` returns the full `Namespace` (`{ id, name, domain, role? }`), not just the id. Core passes `ns.id` down to domain functions and `ns` itself back to callers — avoids a second metadata fetch. Use `resolveNamespaceRef()` when the input may be a name *or* a UUID (e.g. `rename`).

## Testing Patterns

Framework: `bun:test`. Unit tests co-located in `lib/` as `*.test.ts` (`bun test lib/` is the default `test` script). Adapter/integration tests live in `tests/` (`bun run test:all`). No `bun:mock` — dependencies are injected.

**Inject `CoreDeps`, never mock modules.** Every core function takes `{ credentialsPath?, fetchFn?, tokenProvider? }`. Tests write a temp credentials file and supply a `fetchFn` that returns canned `Response`s — no network.

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

**Test naming:** `test_DW_<phase>_<n>_<description>` — `DW` = the "done-when" criterion from the plan that motivated the test (e.g. `test_DW_6_1_core_rename_site_calls_correct_route`).

**Boundary test (keep it green):** `lib/publish.test.ts` and `lib/qrcode.test.ts` read every non-test `lib/*.ts` and assert none import `@modelcontextprotocol/sdk`.

```typescript
const offenders: string[] = [];
for (const f of files) if (readFileSync(join(libDir, f), "utf-8").includes("@modelcontextprotocol/sdk")) offenders.push(f);
expect(offenders).toEqual([]);
```

## Naming Conventions

Files: `kebab-case.ts`. Tests: `*.test.ts`; namespace-scoped variants use `*.ns.test.ts`; the facade-vs-domain split uses `core-<feature>.test.ts` (e.g. `core-rename.test.ts`) for the facade and `<feature>.test.ts` for the domain module.

Domain terms:
- `slug` — URL-safe site identifier (never "name" or "id")
- `ns` is the full `Namespace` object; `nsId` is the bare id string passed to domain functions
- `CoreDeps` — the DI bag for the facade (`credentialsPath`, `fetchFn`, `tokenProvider`); `LoginDeps` — the richer bag for `login()` (browser, callback server, logger, fetch)
- `deleteOp` — facade name for delete (avoids shadowing the `delete` keyword)
- `domainPublish`, `domainNamespaceCreate`, … — `domain`-prefixed import aliases in `core.ts` where the facade reuses the export name
- "namespace" in code; "address" only in user-facing display text (translated by `displayMsg`)

API responses use `snake_case` and types mirror them verbatim: `user_id`, `file_count`, `passcode_hash`, `redirect_expires_at`, `default_namespace_id`, `freed_bytes`, `max_versions`. Map to camelCase only when building the lib-facing success type (`redirect_expires_at` → `redirectExpiresAt`).

## File Organization

```
lib/             Domain logic + facade. Unit tests co-located as *.test.ts.
  core.ts          Facade — every user-facing op; buildApiClient() per call; re-exports for adapters
  auth.ts          Unified PKCE login: generatePkce, buildAuthUrl, exchangeCodeForTokens, refresh, cred I/O
  api-client.ts    Thin HTTP client + ApiError class; Bearer injection; verb methods; manifest()/finalize()
  publish.ts       Hash files, diff manifest, stream presigned PUT uploads w/ retry, finalize
  namespace.ts     resolveNamespace/resolveNamespaceRef + namespaceCreate; OverageApprovalError; tier/overage enrichment
  domain.ts        Custom-domain connect/check/list/remove (space-level /api/domains — not ns-scoped)
  analytics.ts     Per-site analytics on/off PATCH (no republish)
  display-msg.ts   Pure display-boundary translator (namespace → address) — leaf, no deps
  rename/list/delete/promote/passcode/gate/members/versions/qrcode.ts  one domain area each
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
- **PKCE auth is real (RFC 7636)** via Web Crypto (`crypto.subtle`), not `node:crypto`. The unified login opens the website provider-chooser with `flow=local` + PKCE params; legacy per-flow endpoints return HTTP 410 `upgrade_required` — do not call them.
- **No linter/formatter config** (no eslint/biome/prettier). Style is enforced by tests and review. `tsconfig.json` is strict.
- **zod** for MCP input schemas (required by the SDK). **open** for browser launch, **qrcode** for the qrcode tool.
- **Version must be bumped on every change** — plugins only update when the number changes. It lives in six files that must stay in sync: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `plugin.json` (root), `mcp/index.ts` (`PACKAGE_VERSION`). CI bumps them on merge.
- **Rebuild `dist/mcp.js` on every source change** — installed plugins run the bundle, not the source: `bun build mcp/index.ts --target=bun --outfile=dist/mcp.js && chmod +x dist/mcp.js`.
- **Admin tools are env-gated** — only registered when `UPUBLISH_ADMIN=1`; otherwise the registry is byte-identical to the public baseline.
- **Hosted token injection** — `CoreDeps.tokenProvider` lets a host (backend `/mcp` router) supply a per-request bearer, bypassing the disk credential path. Takes precedence over `credentialsPath`; wrapped to fail closed on an empty token.

## Exemplar Files

**`lib/core.ts`** — the facade: `buildApiClient()` fresh-creds-per-call (disk vs injected `tokenProvider`), `CoreDeps` injection, `domain*` import aliasing, adapter re-exports, both error strategies (throwing `publish`/`list` vs structured-return `rename`/`status`/`logout`), and discriminated `gate`/`members` dispatch.

**`lib/api-client.ts`** — token-provider-per-request pattern, the verb methods, typed `manifest()`/`finalize()`, the `ApiError` subclass that carries status + parsed body, and the single `parseResponse()` that is the one place errors are thrown.

**`lib/namespace.ts`** — resolution (`resolveNamespace`/`resolveNamespaceRef`/`namespaceNotFound`), `namespaceCreate`, and `enrichNamespaceError()` — the model for converting a typed `ApiError` (402) into a domain-specific typed error (`OverageApprovalError`) while passing other errors through.

**`lib/auth.ts`** — the full PKCE login: `generatePkce()` (Web Crypto), `buildAuthUrl()` (challenge only), loopback `waitForCode()`, `exchangeCodeForTokens()` (verifier in body, tokens in response), `createTokenProvider()` (transparent refresh). Fully deps-injected.

**`mcp/index.ts`** — `createServer(coreDeps?, opts?)` factory for test injection, `okResponse`/`errResponse` (with `displayMsg` at the edge), env-gated admin registration, and the adapter idioms: try/catch for throwing core fns, `if (!result.success)` for structured-return fns, and `instanceof OverageApprovalError` for typed-error rendering.
