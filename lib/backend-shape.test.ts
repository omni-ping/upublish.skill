/**
 * DW-6.1: the backend parsers accept every success body of the contract
 * fixtures and reject drift, naming the first bad field.
 */

import { describe, it, expect } from "bun:test";
import {
  BINDING_NAME_RE, parseAddonStatus, parseBackendStatus, parseDeployResponse, parseDisableResponse, parseEnableResponse, parseLogs,
  parseRollbackResponse, parseSecretDelete, parseSecretList, parseSecretSet, parseVersionList,
} from "./backend-shape.ts";
import { backendResponse, loadBackendRoute } from "../tests/helpers/backend.ts";

const ok = (route: string): Array<{ name: string; body: any }> =>
  loadBackendRoute(route).responses.filter((r) => r.status < 400);

const PARSERS: Array<[string, (raw: unknown) => unknown]> = [
  ["addon.status", parseAddonStatus],
  ["addon.enable", parseEnableResponse],
  ["addon.disable", parseDisableResponse],
  ["backend.status", parseBackendStatus],
  ["backend.update", parseBackendStatus],
  ["backend.deploy", parseDeployResponse],
  ["backend.versions", parseVersionList],
  ["backend.rollback", parseRollbackResponse],
  ["backend.secrets_list", parseSecretList],
  ["backend.secret_set", parseSecretSet],
  ["backend.secret_delete", parseSecretDelete],
  ["backend.logs", parseLogs],
];

describe("DW-6.1: parsers pass on every success fixture", () => {
  for (const [route, parse] of PARSERS) {
    for (const r of ok(route)) {
      it(`test_DW_6_1_parser_${route}_${r.name.replace(/[^a-z0-9]+/gi, "_")}`, () => {
        expect(() => parse(r.body)).not.toThrow();
      });
    }
  }
});

describe("DW-6.1: parsers reject drift and name the field", () => {
  const status = backendResponse(loadBackendRoute("backend.status"), "deployed").body;

  it("rejects a non-object body", () => {
    expect(() => parseBackendStatus(null)).toThrow(/backend status endpoint.*\(body\)/);
    expect(() => parseBackendStatus([])).toThrow(/\(body\)/);
  });

  it("names a missing top-level field", () => {
    const { deployed: _d, ...rest } = status;
    expect(() => parseBackendStatus(rest)).toThrow(/Missing or invalid field: deployed/);
  });

  it("names a bad nested field", () => {
    expect(() => parseBackendStatus({ ...status, usage: { ...status.usage, calls: -1 } })).toThrow(/usage\.calls/);
    expect(() => parseBackendStatus({ ...status, kv: { drift: "weird", checked_at: null } })).toThrow(/kv\.drift/);
  });

  it("a null parent skips its children (not deployed: limits, usage null)", () => {
    const notDeployed = backendResponse(loadBackendRoute("backend.status"), "not-deployed").body;
    expect(parseBackendStatus(notDeployed).limits).toBeNull();
  });

  it("rejects a secret or var name that is not a valid binding name", () => {
    expect(() => parseBackendStatus({ ...status, secrets: ["1BAD"] })).toThrow(/secrets/);
    expect(() => parseBackendStatus({ ...status, vars: ["has space"] })).toThrow(/vars/);
  });

  it("rejects a malformed sha256 and a non-ISO timestamp", () => {
    const deploy = backendResponse(loadBackendRoute("backend.deploy"), "deployed").body;
    expect(() => parseDeployResponse({ ...deploy, bundle_sha256: "abc" })).toThrow(/bundle_sha256/);
    expect(() => parseDeployResponse({ ...deploy, deployed_at: "yesterday" })).toThrow(/deployed_at/);
  });

  it("validates array members (a bad version / secret / log line is named by its list)", () => {
    expect(() => parseVersionList({ versions: [{ version: 0 }] })).toThrow(/versions/);
    expect(() => parseSecretList({ secrets: [{ name: "OK", set_at: "nope" }] })).toThrow(/secrets/);
    expect(() => parseLogs({ lines: [{ timestamp: "2026-11-06T12:00:00.000Z", level: "loud", message: "x", status: null, outcome: null }], truncated: false })).toThrow(/lines/);
  });

  it("requires includes_site_data to be literally true and the paused flag to be a boolean when present", () => {
    const addon = backendResponse(loadBackendRoute("addon.status"), "enabled").body;
    expect(() => parseAddonStatus({ ...addon, includes_site_data: false })).toThrow(/includes_site_data/);
    expect(() => parseAddonStatus({ ...addon, billing: { ...addon.billing, paused: "yes" } })).toThrow(/billing\.paused/);
  });

  it("test_DW_7_6_new_optional_fields_are_accepted_when_well_formed_and_rejected_when_not", () => {
    const addon = backendResponse(loadBackendRoute("addon.status"), "enabled").body;
    expect(parseAddonStatus({ ...addon, billing: { ...addon.billing, disable_keeps_site_data: false } }).billing.disable_keeps_site_data).toBe(false);
    expect(() => parseAddonStatus({ ...addon, billing: { ...addon.billing, disable_keeps_site_data: "yes" } })).toThrow(/disable_keeps_site_data/);
    expect(parseDisableResponse({ entitled: false, delete_after: "2026-12-06T12:00:00.000Z", site_data_kept: true }).site_data_kept).toBe(true);
    expect(() => parseDisableResponse({ entitled: false, delete_after: "2026-12-06T12:00:00.000Z", site_data_kept: 1 })).toThrow(/site_data_kept/);
    const charge = { interval: "month", price_cents: 140, basis: "invoice", recurring_cents: 300 } as const;
    expect(parseEnableResponse({ entitled: true, activating: false, charge, converted_data_addon: false }).charge).toEqual(charge);
    expect(() => parseEnableResponse({ entitled: true, activating: false, charge: { ...charge, basis: "guess" }, converted_data_addon: false })).toThrow(/charge\.basis/);
    expect(() => parseEnableResponse({ entitled: true, activating: false, charge: { ...charge, recurring_cents: -1 }, converted_data_addon: false })).toThrow(/recurring_cents/);
  });

  it("enable response needs entitled:true; disable needs entitled:false", () => {
    expect(() => parseEnableResponse({ entitled: false, activating: false, charge: null, converted_data_addon: false })).toThrow(/entitled/);
    expect(() => parseDisableResponse({ entitled: true, delete_after: "2026-12-06T12:00:00.000Z" })).toThrow(/entitled/);
  });
});

describe("BINDING_NAME_RE", () => {
  it("accepts identifiers up to 64 characters and rejects the rest", () => {
    expect(BINDING_NAME_RE.test("RESEND_API_KEY")).toBe(true);
    expect(BINDING_NAME_RE.test("a".repeat(64))).toBe(true);
    expect(BINDING_NAME_RE.test("a".repeat(65))).toBe(false);
    expect(BINDING_NAME_RE.test("9lives")).toBe(false);
    expect(BINDING_NAME_RE.test("has-dash")).toBe(false);
    expect(BINDING_NAME_RE.test("")).toBe(false);
  });
});
