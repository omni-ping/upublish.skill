/**
 * Shared helpers for site-data tests: contract fixture loading and a fake
 * server behind an injected fetch (no network, ever).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "../../lib/api-client.ts";
import type { Namespace } from "../../lib/types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "site-data", "routes");

export interface FixtureResponse {
  name: string;
  status: number;
  body?: unknown;
  contentType?: string;
  bodyLines?: unknown[];
}

export interface RouteFixture {
  route: string;
  request: { method: string; path: string; body?: unknown };
  responses: FixtureResponse[];
}

/** Loads `tests/fixtures/site-data/routes/{id}.json`. */
export function loadRoute(id: string): RouteFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), "utf-8")) as RouteFixture;
}

export const fixtureResponse = (route: RouteFixture, name: string): FixtureResponse => {
  const r = route.responses.find((x) => x.name === name);
  if (!r) throw new Error(`fixture ${route.route} has no response '${name}'`);
  return r;
};

/** The namespace every fixture request is addressed to (`ryan`, matching the wipe fixture). */
export const NS: Namespace = { id: "5b0e3c1a-0000-4000-8000-00000000a001", name: "ryan", domain: "upubli.sh" };

export const SITE_FOR_HER = "5b0e3c1a-0000-4000-8000-00000000b001";
export const SITE_RESULTS = "5b0e3c1a-0000-4000-8000-00000000b002";

/** Sites matching the ids used by the collection fixtures. */
export const SITES_BODY = {
  sites: [
    { id: SITE_FOR_HER, slug: "for-her", title: "For her" },
    { id: SITE_RESULTS, slug: "results", title: "Results" },
    { id: "5b0e3c1a-0000-4000-8000-00000000b003", slug: "_root", title: "Root" },
  ],
};

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Renders a fixture response as an HTTP Response (JSON body, or NDJSON for `bodyLines`). */
export function fromFixture(r: FixtureResponse): Response {
  if (r.bodyLines) {
    return new Response(r.bodyLines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
      status: r.status,
      headers: { "Content-Type": r.contentType ?? "application/x-ndjson" },
    });
  }
  return jsonResponse(r.status, r.body);
}

/** Handler result: a Response, or undefined for "not handled" (which fails the test loudly). */
export type Handler = (req: Recorded) => Response | undefined | Promise<Response | undefined>;

const BASE = "https://api.test";

/** An ApiClient whose fetch is `handler`; every request is recorded in `calls`. */
export function makeClient(handler: Handler): { client: ApiClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      path: url.slice(BASE.length),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    calls.push(req);
    const res = await handler(req);
    if (!res) throw new Error(`unexpected request: ${req.method} ${req.path}`);
    return res;
  };
  return { client: new ApiClient(BASE, async () => "tok", fetchFn), calls };
}

/** Handler answering `GET /api/ns/{id}/sites` with SITES_BODY, delegating everything else to `next`. */
export const withSites =
  (next: Handler): Handler =>
  (req) =>
    req.method === "GET" && req.path === `/api/ns/${NS.id}/sites` ? jsonResponse(200, SITES_BODY) : next(req);

// ─── Full-stack (core / MCP) fetch ───────────────────────────────────────────

const json = { "Content-Type": "application/json" };

/** The account the fake stack reports on `GET /api/space` (tier) and `GET /auth/me` (role); a status makes that read fail. */
export interface Account {
  tier?: "free" | "pro" | "max";
  role?: string;
  spaceStatus?: number;
  meStatus?: number;
}

/** Handler answering `GET /api/space` and `GET /auth/me` for `account`, delegating everything else to `next`. */
export const withAccount =
  (account: Account, next: Handler): Handler =>
  (req) => {
    if (req.method === "GET" && req.path === "/api/space") {
      return account.spaceStatus ? jsonResponse(account.spaceStatus, { error: "down" }) : jsonResponse(200, { space: { id: "sp1", default_namespace_id: NS.id, tier: account.tier ?? "pro" } });
    }
    if (req.method === "GET" && req.path === "/auth/me") {
      return account.meStatus ? jsonResponse(account.meStatus, { error: "down" }) : jsonResponse(200, { id: "u1", username: "ryan", email: "r@x.test", role: account.role ?? "user" });
    }
    return next(req);
  };

/**
 * A fetch for core/MCP tests: answers token refresh, `GET /api/space` and
 * `GET /api/ns` (two namespaces: `ryan` = default, `other`), then delegates
 * everything else to `handler`. Requests are recorded in `calls`.
 */
export function stackFetch(handler: Handler, account: Account = {}): { fetchFn: (url: string, init?: RequestInit) => Promise<Response>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path.includes("/auth/token/refresh")) return jsonResponse(200, { access_token: "mock-access", expires_in: 3600 });
    if (path === "/api/space") {
      return account.spaceStatus ? jsonResponse(account.spaceStatus, { error: "down" }) : jsonResponse(200, { space: { id: "sp1", default_namespace_id: NS.id, tier: account.tier ?? "pro" } });
    }
    if (path === "/auth/me") {
      return account.meStatus ? jsonResponse(account.meStatus, { error: "down" }) : jsonResponse(200, { id: "u1", username: "ryan", email: "r@x.test", role: account.role ?? "user" });
    }
    if (path === "/api/ns") {
      return new Response(
        JSON.stringify({ namespaces: [{ ...NS, role: "owner" }, { id: "ns-other", name: "other", domain: "upubli.sh", role: "owner" }] }),
        { status: 200, headers: json },
      );
    }
    const req: Recorded = {
      method: init?.method ?? "GET",
      path,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    calls.push(req);
    const res = await handler(req);
    if (!res) throw new Error(`unexpected request: ${req.method} ${req.path}`);
    return res;
  };
  return { fetchFn, calls };
}
