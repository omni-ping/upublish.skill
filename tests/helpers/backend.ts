/**
 * Shared helpers for backend tests: contract fixture loading (the fake server,
 * namespace and client helpers are reused from ./site-data.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BACKEND_FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "backend");

export interface BackendFixtureResponse { name: string; status: number; body: any }
export interface BackendRouteFixture {
  route: string;
  request: { method: string; path: string; query?: string; body?: any };
  responses: BackendFixtureResponse[];
}

/** Loads `tests/fixtures/backend/routes/{id}.json`. */
export const loadBackendRoute = (id: string): BackendRouteFixture =>
  JSON.parse(readFileSync(join(BACKEND_FIXTURE_DIR, "routes", `${id}.json`), "utf-8")) as BackendRouteFixture;

export const backendResponse = (route: BackendRouteFixture, name: string): BackendFixtureResponse => {
  const r = route.responses.find((x) => x.name === name);
  if (!r) throw new Error(`fixture ${route.route} has no response '${name}'`);
  return r;
};

/** Fixture request path including its query string, as the client sends it. */
export const fixturePath = (route: BackendRouteFixture): string =>
  route.request.query ? `${route.request.path}?${route.request.query}` : route.request.path;

/** The Pro-tier account the fake stack reports by default. */
export const SLUG = "contact";
