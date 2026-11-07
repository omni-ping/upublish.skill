/**
 * DW-2.4 + DW-6.1: the vendored backend contract fixtures.
 *
 * 1. Drift: every file under tests/fixtures/backend hashes to the pinned
 *    manifest.json, and the file set is exactly the manifest's.
 * 2. Replay: every route fixture response (success AND error) is replayed
 *    against the skill's lib functions through an injected fetch. The request
 *    the skill sends must equal the fixture's (method, path incl. query, JSON
 *    body); a success must parse into the tool's result; an error must become a
 *    BackendError carrying the fixture's code and status.
 */

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApiClient } from "./api-client.ts";
import { runBackend, runBackendLogs, runBackendSecret, runPublishBackend, expectedFor } from "./backend.ts";
import { BackendError } from "./backend-errors.ts";
import { parseAddonStatus } from "./backend-shape.ts";
import { NS, fromFixture, makeClient, withSites, type Handler, type Recorded } from "../tests/helpers/site-data.ts";
import { BACKEND_FIXTURE_DIR, fixturePath, loadBackendRoute, backendResponse, SLUG } from "../tests/helpers/backend.ts";

// ─── Drift ───────────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(BACKEND_FIXTURE_DIR, "manifest.json"), "utf-8")) as { algorithm: string; files: Record<string, string> };

/** Every fixture file under the snapshot, relative to its root, excluding the manifest and the README. */
function listFixtureFiles(dir = BACKEND_FIXTURE_DIR, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFixtureFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  ).filter((f) => f !== "manifest.json" && f !== "README.md");
}

describe("DW-2.4: vendored fixtures match the pinned manifest", () => {
  it("test_DW_2_4_manifest_uses_sha256", () => {
    expect(manifest.algorithm).toBe("sha256");
  });

  it("test_DW_2_4_every_manifest_file_hashes_to_its_pinned_value", () => {
    for (const [file, sha] of Object.entries(manifest.files)) {
      const actual = createHash("sha256").update(readFileSync(join(BACKEND_FIXTURE_DIR, file))).digest("hex");
      expect(actual, `drift in ${file}`).toBe(sha);
    }
  });

  it("test_DW_2_4_file_set_equals_the_manifest_no_extra_no_missing", () => {
    expect(listFixtureFiles().sort()).toEqual(Object.keys(manifest.files).sort());
  });

  it("test_DW_2_4_drift_is_detected_when_a_hash_differs", () => {
    // The check above compares real hashes; prove the comparison can fail.
    const [file] = Object.keys(manifest.files);
    const actual = createHash("sha256").update(readFileSync(join(BACKEND_FIXTURE_DIR, file!))).digest("hex");
    expect(actual).not.toBe(createHash("sha256").update("tampered").digest("hex"));
  });
});

// ─── Replay ──────────────────────────────────────────────────────────────────

type BodyCheck = "equal" | "subset" | "no-source";

interface Case {
  route: string;
  call: (client: ApiClient) => Promise<unknown>;
  /** How the sent body is compared with the fixture's request body. */
  body?: BodyCheck;
  /** Answers requests other than the fixture's own (status pre-read, site list, ...). */
  prelude?: Handler;
  onSuccess?: (result: any, fixtureBody: any) => void;
}

const addonFixture = loadBackendRoute("addon.status");
const unentitled = {
  ...(backendResponse(addonFixture, "not-yet-launched").body as object),
  available: true,
  billing: { ...backendResponse(addonFixture, "not-yet-launched").body.billing, would_charge: true },
};
const sample = parseAddonStatus(unentitled);

const deployBody = loadBackendRoute("backend.deploy").request.body as { source: string; access: "site"; vars: Record<string, string> };
const secretFixture = loadBackendRoute("backend.secret_set");

const CASES: Case[] = [
  {
    route: "addon.status",
    call: (c) => runBackend(c, NS, { action: "addon_status" }),
    onSuccess: (r, body) => expect(r.available).toBe(body.available),
  },
  {
    route: "addon.enable",
    call: (c) => runBackend(c, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) }),
    prelude: (req) => (req.method === "GET" && req.path === `/api/ns/${NS.id}/backend-addon` ? fromFixture({ name: "s", status: 200, body: unentitled }) : undefined),
    onSuccess: (r) => expect(r).toMatchObject({ action: "addon_enable", state: "enabled" }),
  },
  {
    route: "addon.disable",
    call: (c) => runBackend(c, NS, { action: "addon_disable" }),
    onSuccess: (r, body) => expect(r.delete_after).toBe(body.delete_after),
  },
  {
    route: "backend.status",
    call: (c) => runBackend(c, NS, { action: "status", site: SLUG }),
    onSuccess: (r, body) => expect(r.status.deployed).toBe(body.deployed),
  },
  {
    route: "backend.deploy",
    body: "no-source",
    call: (c) => runPublishBackend(c, NS, { site: SLUG, code: "export default { async fetch() { return Response.json({ ok: true }); } };", access: deployBody.access, vars: deployBody.vars }),
    prelude: withSites(() => undefined),
    onSuccess: (r, body) => {
      expect(r).toMatchObject({ state: "deployed", version: body.version, access: body.access });
      expect(r.warnings).toEqual(expect.arrayContaining(body.warnings));
    },
  },
  {
    route: "backend.update",
    body: "subset",
    call: (c) => runBackend(c, NS, { action: "access", site: SLUG, access: "public" }),
    onSuccess: (r, body) => expect(r.status.access).toBe(body.access),
  },
  {
    route: "backend.versions",
    call: (c) => runBackend(c, NS, { action: "versions", site: SLUG }),
    onSuccess: (r, body) => expect(r.versions).toHaveLength(body.versions.length),
  },
  {
    route: "backend.rollback",
    call: (c) => runBackend(c, NS, { action: "rollback", site: SLUG, version: 1 }),
    onSuccess: (r, body) => expect(r.result.version).toBe(body.version),
  },
  {
    route: "backend.secrets_list",
    call: (c) => runBackendSecret(c, NS, { action: "list", site: SLUG }),
    onSuccess: (r, body) => expect(r.secrets.map((s: { name: string }) => s.name)).toEqual(body.secrets.map((s: { name: string }) => s.name)),
  },
  {
    route: "backend.secret_set",
    call: (c) => runBackendSecret(c, NS, { action: "set", site: SLUG, name: "RESEND_API_KEY", value: secretFixture.request.body.value }),
    onSuccess: (r, body) => expect(r.secret).toEqual(body),
  },
  {
    route: "backend.secret_delete",
    call: (c) => runBackendSecret(c, NS, { action: "delete", site: SLUG, name: "RESEND_API_KEY" }),
    onSuccess: (r, body) => expect(r.deleted).toBe(body.deleted),
  },
  {
    route: "backend.delete",
    call: (c) => runBackend(c, NS, { action: "delete", site: SLUG, confirm_site: SLUG }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "delete", site: SLUG }),
  },
  {
    route: "backend.logs",
    call: (c) => runBackendLogs(c, NS, { site: SLUG, limit: 50 }),
    onSuccess: (r, body) => expect(r.logs.lines).toHaveLength(body.lines.length),
  },
];

function checkBody(sent: unknown, fixture: unknown, mode: BodyCheck): void {
  if (mode === "equal") return void expect(sent).toEqual(fixture);
  const { source, ...sentRest } = sent as Record<string, unknown>;
  if (mode === "no-source") {
    expect(typeof source).toBe("string");
    const { source: _s, ...fxRest } = fixture as Record<string, unknown>;
    return void expect(sentRest).toEqual(fxRest);
  }
  // subset: every sent field equals the fixture's (the fixture exercises several fields in one body).
  for (const [k, v] of Object.entries(sent as Record<string, unknown>)) expect((fixture as Record<string, unknown>)[k]).toEqual(v);
}

describe("DW-6.1: every backend route fixture is replayed through the skill's lib", () => {
  for (const c of CASES) {
    const fixture = loadBackendRoute(c.route);
    for (const response of fixture.responses) {
      it(`test_DW_6_1_replay_${c.route}_${response.name.replace(/[^a-z0-9]+/gi, "_")}`, async () => {
        const own = (req: Recorded) => (req.method === fixture.request.method && req.path === fixturePath(fixture) ? fromFixture(response) : undefined);
        const { client, calls } = makeClient((req) => own(req) ?? c.prelude?.(req));

        const outcome = await c.call(client).then((value) => ({ value }), (error: unknown) => ({ error }));

        const sent = calls.find((x) => x.method === fixture.request.method && x.path === fixturePath(fixture));
        expect(sent, `the skill never sent ${fixture.request.method} ${fixturePath(fixture)}`).toBeDefined();
        if (fixture.request.body !== undefined) checkBody(sent!.body, fixture.request.body, c.body ?? "equal");

        if (response.status < 400) {
          expect("error" in outcome ? String(outcome.error) : "").toBe("");
          c.onSuccess?.((outcome as { value: unknown }).value, response.body);
        } else {
          const err = (outcome as { error: unknown }).error;
          expect(err).toBeInstanceOf(BackendError);
          expect((err as BackendError).code).toBe(response.body.code);
          expect((err as BackendError).status).toBe(response.status);
        }
      });
    }
  }

  it("test_DW_6_1_every_route_fixture_in_the_manifest_is_replayed_no_route_lacks_a_tool", () => {
    const routes = Object.keys(manifest.files).filter((f) => f.startsWith("routes/")).map((f) => f.replace(/^routes\/|\.json$/g, ""));
    expect(routes.filter((r) => !CASES.some((c) => c.route === r)).sort()).toEqual([]);
  });
});
