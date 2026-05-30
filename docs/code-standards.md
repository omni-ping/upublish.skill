<!-- base-commit: 1192310dd5df1fe086da207642bfbcbef60cd1d2 -->
<!-- generated: 2026-05-29 -->

# Code Standards

## Forbidden Patterns

**Never import from submodules in adapters** — adapters (`mcp/index.ts`) import only from `lib/core.ts`. Core re-exports any types adapters need. A test in `lib/publish.test.ts` explicitly verifies no `lib/` source file imports `@modelcontextprotocol/sdk`.

```typescript
// BAD — adapter reaches into submodule, creates coupling
import { readCredentials } from "../lib/auth.ts";
import { ApiClient } from "../lib/api-client.ts";

// GOOD — adapter uses core facade; core wires internals
import { list, publish, deleteOp, gate } from "../lib/core.ts";
import type { PublishResult, GateResult, Site } from "../lib/core.ts";
```

**Never cache credentials at module level** — read fresh from disk on every operation. The MCP server picks up credentials written by login without a restart.

```typescript
// BAD — stale if user logs in after server starts
const token = await readCredentials(credFile); // at module scope

// GOOD — from lib/core.ts: buildApiClient() called inside each export
export async function list(namespaceName?: string, deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps); // reads disk on every call
  const ns = await resolveNamespace(apiClient, namespaceName);
  return listSites(apiClient, ns.id);
}
```

**Never use `any`** — zero `any` types in the codebase.

**Never import `fflate`** — the zip-based upload path was removed (v0.9.0). The publish flow is presigned-URL-only: manifest → upload → finalize.

## Code Examples

### Domain function with DI

```typescript
// DO — lib/delete.ts: pure domain logic, injectable ApiClient, structured return
export async function deleteSite(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<DeleteResult> {
  if (!slug || slug.trim().length === 0) throw new Error("slug is required");
  const result = await apiClient.delete<DeleteSiteResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}`,
  );
  return { message: result.message };
}

// DON'T — constructs its own client, reads credentials, untestable
export async function deleteSite(slug: string): Promise<DeleteResult> {
  const token = await readCredentials("~/.upublish/credentials");
  await fetch(`https://api.upubli.sh/api/sites/${slug}`, { method: "DELETE", ... });
}
```

### MCP tool registration

```typescript
// DO — mcp/index.ts: zod schema, calls core, try/catch → okResponse/errResponse
server.registerTool(
  "delete",
  {
    title: "Delete Site",
    description: "Permanently deletes a published site.",
    inputSchema: {
      slug: z.string().describe("The site slug to delete."),
      namespace: z.string().optional().describe("Namespace name. Defaults to default namespace."),
    },
  },
  async ({ slug, namespace }) => {
    try {
      const result = await deleteOp(slug as string, namespace as string | undefined, coreDeps);
      return okResponse(result.message);
    } catch (err) {
      return errResponse(err);
    }
  },
);
```

### Progress callback threading (sync, platform-agnostic)

The `onProgress` callback in `publish()` and `uploadChangedFiles()` must be **synchronous and non-throwing**. `lib/` stays free of async notification machinery — the MCP adapter wraps an async `sendNotification` behind it.

```typescript
// DO — mcp/index.ts: async MCP notification wrapped in sync callback
const onProgress = progressToken !== undefined
  ? (p: { completed: number; total: number }) => {
      extra.sendNotification({ method: "notifications/progress", params: { progressToken, ...p } })
        .catch((err) => log(`progress notification failed: ${(err as Error).message}`));
    }
  : undefined;
await publish({ ..., onProgress }, coreDeps);

// DON'T — lib/ calling MCP SDK directly (breaks hexagonal boundary)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // in lib/publish.ts
```

## Error Handling

Core functions throw `Error` with human-readable messages on API failures. MCP tool handlers catch and return `errResponse()`. No Result wrapper types, no error codes.

```typescript
// lib/api-client.ts — single error format for all API failures
throw new Error(`API error ${response.status}: ${errorMessage}`);

// mcp/index.ts — every tool handler wraps in try/catch
try {
  const result = await publish(args, coreDeps);
  return okResponse(`Site published!\nURL: ${result.url}`);
} catch (err) {
  return errResponse(err); // { content: [{ type: "text", text: msg }], isError: true }
}
```

**Exception — `logout()` and `status()`:** These never throw for expected failures. `logout()` returns `{ loggedOut: false, error }` on filesystem failure. `status()` returns `{ authenticated: false }` when credentials are absent or the API rejects them — it uses its own inline credential check rather than `buildApiClient()`.

**Best-effort operations are always wrapped silently:**

```typescript
// lib/core.ts logout() — server revocation failure must not block local logout
try {
  await fetchFn(`${API_BASE_URL}/auth/token/revoke`, { ... });
} catch {
  // Silently ignore — best-effort revoke
}
```

## Imports & Dependency Direction

```
mcp/index.ts  →  lib/core.ts  →  lib/list.ts, lib/publish.ts, lib/delete.ts
                                  lib/passcode.ts, lib/gate.ts
                                  lib/auth.ts, lib/api-client.ts
                                  lib/namespace.ts
                              →  lib/types.ts   (leaf — no internal imports)
                              →  lib/log.ts     (leaf — no internal imports)
```

`resolveNamespace()` returns a full `Namespace` object (`{ id, name, domain }`), not just the ID string. Core functions pass `ns.id` to domain functions and `ns` itself to callers. This avoids extra API calls to fetch namespace metadata alongside results.

Use `.ts` extension in all imports (Bun requires it). Import order: Node builtins (`node:fs`, `node:path`) → external packages (`zod`, `@modelcontextprotocol/sdk`) → internal (`../lib/core.ts`, `./types.ts`).

## Testing Patterns

Framework: `bun:test`. Unit tests co-located in `lib/` as `*.test.ts`; adapter/integration tests in `tests/`.

```sh
bun test lib/   # unit tests only (default npm test)
bun test        # all tests (unit + integration)
```

**Dependency injection over mocking:** Every core function accepts `CoreDeps { credentialsPath, fetchFn }`. Tests inject a temp credentials file and a mock `fetchFn` — no network calls, no `bun:mock`.

```typescript
// tests/mcp.test.ts — mock fetch handles token refresh + namespace resolution
function makeMockFetch(apiResponse: unknown = { sites: [] }) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/auth/token/refresh"))
      return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), { status: 200 });
    if (url.endsWith("/api/space"))
      return new Response(JSON.stringify({ space: { id: "sp1", default_namespace_id: "ns-default", tier: "free" } }), { status: 200 });
    if (/\/api\/ns$/.test(url))
      return new Response(JSON.stringify({ namespaces: [{ id: "ns-default", name: "default", domain: "user.upubli.sh" }] }), { status: 200 });
    return new Response(JSON.stringify(apiResponse), { status: 200 });
  };
}
const deps: CoreDeps = { credentialsPath: tmpCredFile, fetchFn: makeMockFetch() };
```

**ApiClient test pattern:** Construct directly with a mock `TokenProvider` and mock `FetchFn`, capture and assert on URL/method/body.

```typescript
const staticTokenProvider = async () => "test-token";
const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
```

**Test naming:** `test_DW_N_M_description` (DW = "done-when" criterion from the plan that motivated the test).

**Hexagonal boundary test** — enforced in `lib/publish.test.ts`:

```typescript
it("test_DW_1_3_lib_has_no_mcp_sdk_imports", () => {
  const files = readdirSync(libDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const offenders = files.filter(f => readFileSync(join(libDir, f), "utf-8").includes("@modelcontextprotocol/sdk"));
  expect(offenders).toEqual([]);
});
```

## Naming Conventions

Files: `kebab-case.ts`. Test files: `*.test.ts` for unit, `*.ns.test.ts` for namespace-scoped variants.

Domain terms:
- `slug` — URL-safe site identifier (not "name" or "id")
- `namespace` / `ns` / `nsId` — multi-tenant space. `ns` is the full `Namespace` object; `nsId` is the string ID passed to domain functions.
- `CoreDeps` — the DI bag for core functions (`credentialsPath`, `fetchFn`)
- `deleteOp` — avoids shadowing the JS `delete` keyword
- `domainPromote`, `domainPublish`, etc. — prefix used in `core.ts` when a core function name conflicts with an imported domain function name

DB columns on the `Site` type use `snake_case` (mirrors the API response verbatim): `user_id`, `created_at`, `file_count`, `total_size`, `passcode_hash`.

## File Organization

```
lib/           Domain logic + core facade. Unit tests co-located.
  core.ts        Facade — all user-facing operations; wires credentials + ApiClient per call
  auth.ts        OAuth login (PKCE), token refresh, credential read/write
  api-client.ts  Thin HTTP client — Bearer token injection, manifest/finalize methods
  publish.ts     Hash files, diff manifest, presigned R2 upload with retry, finalize
  list.ts        GET /api/ns/:nsId/sites
  delete.ts      DELETE /api/ns/:nsId/sites/:slug
  promote.ts     POST /api/ns/:nsId/sites/:slug/promote
  passcode.ts    Passcode CRUD
  gate.ts        Form gate CRUD + submissions
  namespace.ts   Namespace resolution (by name or default)
  types.ts       Shared types — leaf module, no internal imports
  log.ts         File logger (~/.upublish/publish.log) — never throws
mcp/           MCP server adapter
  index.ts       Tool registration, createServer() factory, okResponse/errResponse helpers
tests/         Integration/adapter tests (imports from mcp/)
skills/        Skill definitions for AI agents
references/    Markdown docs for skill routing
dist/          Pre-built bundle (mcp.js) — rebuilt by CI, not edited by hand
```

## Technology Decisions

- **Bun** as runtime, test runner, and bundler. No Node.js-specific APIs except `node:` builtins (which Bun provides).
- **No fflate** — removed in v0.9.0. Publish flow is presigned-URL-only (manifest → PUT → finalize). Do not re-introduce zip-based upload.
- **zod** for MCP tool input schemas — required by `@modelcontextprotocol/sdk`.
- **No build step for dev** — Bun runs TypeScript directly. `dist/mcp.js` is a pre-built bundle for plugin distribution. Rebuild after every source change: `bun build mcp/index.ts --target=bun --outfile=dist/mcp.js && chmod +x dist/mcp.js`.
- **Version must be bumped with every change** — plugins only receive updates when the version number changes. Version appears in 5 places: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `mcp/index.ts` (`PACKAGE_VERSION`).

## Exemplar Files

**`lib/core.ts`** — facade pattern, fresh-credential-per-call via `buildApiClient()`, `CoreDeps` injection, re-exports for adapters, discriminated union dispatch (`gate()`).

**`lib/publish.ts`** — presigned-URL publish flow: `collectFilesWithHashes()` → `manifest()` → `uploadChangedFiles()` (batched parallel with retry, `onProgress` callback) → `finalize()`. Shows sync-callback threading pattern and `force` flag (randomized hashes to bypass diff).

**`mcp/index.ts`** — `createServer(coreDeps?)` factory for test injection, `okResponse`/`errResponse` helpers, MCP progress notification pattern (async notification wrapped in sync `onProgress`).

**`lib/api-client.ts`** — token-provider pattern (called before every request for transparent refresh), typed `manifest()` and `finalize()` methods, single `parseResponse()` for all error handling.
