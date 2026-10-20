/**
 * X-Upublish-Client header (Phase 2, DW-2.4).
 * With clientVersion set, every request to the upublish API carries
 * `X-Upublish-Client: upublish-mcp/<v>`; with it absent, none does.
 * All fetches are stubs and all files live in temp dirs.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient, clientHeader } from "./api-client.ts";
import { createTokenProvider, exchangeCodeForTokens, login as authLogin } from "./auth.ts";
import { list, login, logout, status } from "./core.ts";
import type { CoreDeps } from "./core.ts";
import type { FetchFn } from "./types.ts";

const H = "X-Upublish-Client";
const V = "1.2.3";
const EXPECTED = `upublish-mcp/${V}`;

type Seen = { url: string; headers: Headers };

function recorder(respond?: (url: string) => Response): { fetchFn: FetchFn; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (respond) return respond(url);
    if (url.includes("/auth/token/refresh"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    if (url.includes("/auth/token/exchange"))
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, username: "u" }));
    return new Response(JSON.stringify({ sites: [], namespaces: [], username: "u" }));
  };
  return { fetchFn, seen };
}


/** Minimal API: token refresh, space, namespaces, sites. */
function api(url: string): Response {
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (url.includes("/auth/token/refresh")) return json({ access_token: "tok", expires_in: 3600 });
  if (/\/api\/space/.test(url)) return json({ space: { id: "sp", default_namespace_id: "n1", tier: "free" } });
  if (/\/api\/ns/.test(url)) return json({ namespaces: [{ id: "n1", name: "default", domain: "d" }] });
  return json({ sites: [] });
}

const tmp: string[] = [];
function tmpFile(content?: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-client-header-"));
  tmp.push(d);
  const p = path.join(d, "credentials");
  if (content !== undefined) fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("clientHeader()", () => {
  test("sets the header when a version is given", () => {
    expect(clientHeader("0.1.0")).toEqual({ [H]: "upublish-mcp/0.1.0" });
  });
  test("returns no header when absent or empty (no default)", () => {
    expect(clientHeader()).toEqual({});
    expect(clientHeader("")).toEqual({});
  });
});

describe("ApiClient (DW-2.4)", () => {
  const calls: Array<[string, (c: ApiClient) => Promise<unknown>]> = [
    ["get", (c) => c.get("/x")],
    ["getRaw", (c) => c.getRaw("/x")],
    ["post", (c) => c.post("/x", {})],
    ["put", (c) => c.put("/x", {})],
    ["patch", (c) => c.patch("/x", {})],
    ["delete", (c) => c.delete("/x")],
  ];
  for (const [name, call] of calls) {
    test(`test_DW_2_4_${name}_carries_header_and_keeps_other_headers`, async () => {
      const { fetchFn, seen } = recorder();
      await call(new ApiClient("https://api.test", async () => "tok", fetchFn, V));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
      expect(seen[0]!.headers.get("Authorization")).toBe("Bearer tok");
    });
    test(`test_DW_2_4_${name}_has_no_header_without_clientVersion`, async () => {
      const { fetchFn, seen } = recorder();
      await call(new ApiClient("https://api.test", async () => "tok", fetchFn));
      expect(seen[0]!.headers.has(H)).toBe(false);
    });
  }

  test("test_DW_2_4_default_global_fetch_sends_the_header", async () => {
    const original = globalThis.fetch;
    const { fetchFn, seen } = recorder();
    globalThis.fetch = ((url: string, init?: RequestInit) => fetchFn(String(url), init)) as typeof fetch;
    try {
      await new ApiClient("https://api.test", async () => "tok", undefined, V).get("/x");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
});

describe("auth seams (DW-2.4)", () => {
  test("token refresh carries the header", async () => {
    const { fetchFn, seen } = recorder();
    await createTokenProvider({ refreshToken: "r", apiBaseUrl: "https://api.test", fetchFn, clientVersion: V })();
    expect(seen[0]!.url).toContain("/auth/token/refresh");
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
  test("token refresh has no header without clientVersion", async () => {
    const { fetchFn, seen } = recorder();
    await createTokenProvider({ refreshToken: "r", apiBaseUrl: "https://api.test", fetchFn })();
    expect(seen[0]!.headers.has(H)).toBe(false);
  });
  test("token exchange carries the header", async () => {
    const { fetchFn, seen } = recorder();
    await exchangeCodeForTokens({ apiBaseUrl: "https://api.test", code: "c", codeVerifier: "v", fetchFn, clientVersion: V });
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
  test("token exchange has no header without clientVersion", async () => {
    const { fetchFn, seen } = recorder();
    await exchangeCodeForTokens({ apiBaseUrl: "https://api.test", code: "c", codeVerifier: "v", fetchFn });
    expect(seen[0]!.headers.has(H)).toBe(false);
  });
  test("auth login() threads clientVersion into the exchange", async () => {
    const { fetchFn, seen } = recorder();
    await authLogin({
      apiBaseUrl: "https://api.test",
      credentialsFilePath: tmpFile(),
      openBrowser: async () => {},
      startCallbackServer: async () => ({ port: 1, waitForCode: async () => "code", close: async () => {} }),
      log: () => {},
      fetchFn,
      clientVersion: V,
    });
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
});

describe("core seams (DW-2.4)", () => {
  const loginBag = () => ({
    apiBaseUrl: "https://api.test",
    openBrowser: async () => {},
    startCallbackServer: async () => ({ port: 1, waitForCode: async () => "code", close: async () => {} }),
    log: () => {},
  });

  test("core.login() takes clientVersion from CoreDeps for the exchange", async () => {
    const { fetchFn, seen } = recorder();
    await login(loginBag(), { credentialsPath: tmpFile(), fetchFn, clientVersion: V });
    expect(seen[0]!.url).toContain("/auth/token/exchange");
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
  test("core.login() without clientVersion sends none", async () => {
    const { fetchFn, seen } = recorder();
    await login(loginBag(), { credentialsPath: tmpFile(), fetchFn });
    expect(seen[0]!.headers.has(H)).toBe(false);
  });

  test("logout revoke carries the header", async () => {
    const { fetchFn, seen } = recorder();
    const r = await logout({ credentialsPath: tmpFile("rt"), fetchFn, clientVersion: V });
    expect(r.loggedOut).toBe(true);
    expect(seen[0]!.url).toContain("/auth/token/revoke");
    expect(seen[0]!.headers.get(H)).toBe(EXPECTED);
  });
  test("logout revoke has no header without clientVersion", async () => {
    const { fetchFn, seen } = recorder();
    await logout({ credentialsPath: tmpFile("rt"), fetchFn });
    expect(seen[0]!.headers.has(H)).toBe(false);
  });

  test("status() refresh and API calls all carry the header", async () => {
    const { fetchFn, seen } = recorder();
    const r = await status({ credentialsPath: tmpFile("rt"), fetchFn, clientVersion: V });
    expect(r.authenticated).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s.headers.get(H)).toBe(EXPECTED);
  });

  test("disk-backed buildApiClient: refresh + API call carry the header", async () => {
    const { fetchFn, seen } = recorder(api);
    await list(undefined, { credentialsPath: tmpFile("rt"), fetchFn, clientVersion: V });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s.headers.get(H)).toBe(EXPECTED);
  });

  test("injected tokenProvider path (hosted): API calls carry the header", async () => {
    const { fetchFn, seen } = recorder(api);
    const deps: CoreDeps = { fetchFn, tokenProvider: async () => "hosted", clientVersion: V };
    await list(undefined, deps);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const s of seen) expect(s.headers.get(H)).toBe(EXPECTED);
  });

  test("no clientVersion: nothing carries the header anywhere", async () => {
    const { fetchFn, seen } = recorder(api);
    await list(undefined, { credentialsPath: tmpFile("rt"), fetchFn });
    for (const s of seen) expect(s.headers.has(H)).toBe(false);
  });
});
