<!-- base-commit: 50ee97a1df70c557b34f20308f4f03e11ee0319b -->
<!-- generated: 2026-05-22 -->

# Code Standards

## Forbidden Patterns

**Never import from submodules in adapters** — adapters (`mcp/index.ts`) import only from `lib/core.ts`. Core re-exports any types adapters need.

```typescript
// BAD — adapter reaches into submodule, creates coupling
import { readCredentials } from "../lib/auth.ts";
import { ApiClient } from "../lib/api-client.ts";

// GOOD — adapter uses core facade, which wires internals
import { list, publish, deleteOp } from "../lib/core.ts";
import type { PublishResult, Site } from "../lib/core.ts";
```

**Never cache credentials at module level** — read fresh from disk on every operation. The MCP server must pick up credentials written by login without a restart.

```typescript
// BAD — stale if user logs in after server starts
const token = await readCredentials(credFile);

// GOOD — from lib/core.ts: each function reads fresh
export async function list(deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps); // reads from disk each call
  return listSites(apiClient);
}
```

**Never use `any`** — the codebase has zero `any` types outside of prose in doc comments.

## Code Examples

### Domain function with DI

```typescript
// DO — from lib/delete.ts: pure domain logic, injectable ApiClient
export async function deleteSite(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<DeleteResult> {
  await apiClient.delete(`/api/ns/${nsId}/sites/${encodeURIComponent(slug)}`);
  return { message: `Site '${slug}' deleted.` };
}

// DON'T — constructs its own client, reads credentials, untestable
export async function deleteSite(slug: string): Promise<DeleteResult> {
  const token = await readCredentials("~/.upublish/credentials");
  const res = await fetch(`https://api.upubli.sh/api/sites/${slug}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return { message: "deleted" };
}
```

### MCP tool registration

```typescript
// DO — from mcp/index.ts: zod schema, calls core function, structured response
server.registerTool(
  "delete",
  {
    title: "Delete Site",
    description: "Permanently deletes a published site.",
    inputSchema: {
      slug: z.string().describe("The site slug to delete."),
    },
  },
  async ({ slug }) => {
    try {
      const result = await deleteOp(slug as string, undefined, coreDeps);
      return okResponse(result.message);
    } catch (err) {
      return errResponse(err);
    }
  },
);
```

## Error Handling

Throw `Error` with human-readable messages. Never use Result types or error codes. Core functions throw; MCP tool handlers catch and return `errResponse()`.

```typescript
// From lib/api-client.ts — single error format for all API failures
throw new Error(`API error ${response.status}: ${errorMessage}`);

// From mcp/index.ts — tool handlers wrap in try/catch, return structured error
try {
  const result = await publish(args, coreDeps);
  return okResponse(`Site published!\nURL: ${result.url}`);
} catch (err) {
  return errResponse(err); // { content: [{ type: "text", text: msg }], isError: true }
}
```

`logout()` is the exception — it never throws for expected failures, returning `{ loggedOut: false, error }` instead.

## Imports & Dependency Direction

Dependency flows inward: adapters → core → domain modules → types.

```
mcp/index.ts  →  lib/core.ts  →  lib/list.ts, lib/publish.ts, lib/delete.ts, ...
                                  lib/auth.ts, lib/api-client.ts
                                  lib/namespace.ts
                              →  lib/types.ts (leaf — no internal imports)
```

Import order within files:
1. Node builtins (`node:fs`, `node:path`, `node:os`)
2. External packages (`@modelcontextprotocol/sdk`, `zod`, `fflate`)
3. Internal (`../lib/core.ts`, `./types.ts`)

Use `.ts` extension in all imports (Bun requires it).

## Testing Patterns

Framework: `bun:test`. Tests co-located with source in `lib/` (unit) and in `tests/` (integration/adapter).

**Dependency injection over mocking:** Every core function accepts `CoreDeps` with `credentialsPath` and `fetchFn`. Tests inject a temp credentials file and a mock fetch — no network calls.

```typescript
// From lib/core.test.ts — mock fetch + temp credentials
const mockFetch = (url: string | URL | Request, init?: RequestInit) => {
  return Promise.resolve(new Response(JSON.stringify({ sites: [] })));
};
const deps: CoreDeps = { credentialsPath: tmpCredFile, fetchFn: mockFetch };
const result = await list(undefined, deps);
```

**Test naming:** `test_DW_N_M_description` (DW = "done-when" criterion from the plan that motivated the test).

**ApiClient test pattern:** Construct with a mock `TokenProvider` and mock `FetchFn`, assert on captured URL/method/headers.

## Naming Conventions

Files: `kebab-case.ts`. Test files: `*.test.ts` for unit, `*.ns.test.ts` for namespace-scoped variants.

Domain terms:
- `slug` — URL-safe site identifier (not "name" or "id")
- `namespace` / `nsId` — multi-tenant space (not "workspace" or "org")
- `CoreDeps` — the DI bag for core functions
- `deleteOp` — avoids shadowing JS `delete` keyword

## File Organization

```
lib/           # Domain logic + core facade. Tests co-located.
  core.ts      # Facade — all operations, wires credentials + ApiClient
  auth.ts      # OAuth login, PKCE, token refresh, credential I/O
  api-client.ts # HTTP client with Bearer token injection
  publish.ts   # Zip + upload
  list.ts      # GET sites
  delete.ts    # DELETE site
  passcode.ts  # Passcode CRUD
  namespace.ts # Namespace resolution
  types.ts     # Shared types (leaf module)
mcp/           # MCP server adapter
  index.ts     # Tool registration, calls core functions
skills/        # Skill definitions for AI agents
references/    # Markdown docs for skill routing
```

## Technology Decisions

- **Bun** as runtime, test runner, and bundler. No Node.js-specific APIs except where Bun provides them (`node:fs`, `node:path`).
- **fflate** for zip — synchronous, no native deps, works in Bun.
- **zod** for MCP tool input validation — required by `@modelcontextprotocol/sdk`.
- **No build step for dev** — Bun runs TypeScript directly. `dist/mcp.js` is a pre-built bundle for plugin distribution.
- `dist/mcp.js` is rebuilt by CI on version bump: `bun build mcp/index.ts --target=bun --outfile=dist/mcp.js`.

## Exemplar Files

**`lib/core.ts`** — demonstrates facade pattern, fresh-credential-per-call, CoreDeps injection, re-exports for adapters, structured return types.

**`mcp/index.ts`** — demonstrates MCP tool registration, zod schemas, okResponse/errResponse pattern, createServer factory for test injection.

**`lib/auth.test.ts`** — demonstrates DI-based testing (mock fetch, temp files), cleanup in afterEach, no network calls.
