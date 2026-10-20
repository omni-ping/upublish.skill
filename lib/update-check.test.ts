/**
 * Tests for lib/update-check.ts (Phase 2: out-of-date check).
 * Every test injects fetchFn / cachePath / now: nothing touches ~/.upublish or the network.
 *
 * Covers DW-2.2 (no note on equal/older/dirty/failed results) and
 * DW-2.3 (fetched at most once per 24 h).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkForUpdate, formatUpdateNote } from "./update-check.ts";
import type { FetchFn } from "./types.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-update-check-"));
  cachePath = path.join(dir, "update-check.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function remote(version: unknown): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ name: "upublish", version }), { status: 200 });
  };
  return { fetchFn, calls };
}

const run = (current: string, fetchFn: FetchFn, extra: object = {}) =>
  checkForUpdate(current, { fetchFn, cachePath, now: () => NOW, timeoutMs: 100, ...extra });

describe("version comparison", () => {
  test("test_DW_2_1_newer_remote_is_behind", async () => {
    expect(await run("0.12.34", remote("0.13.0").fetchFn)).toEqual({ status: "behind", latest: "0.13.0" });
  });
  test("equal is current", async () => {
    expect(await run("0.12.34", remote("0.12.34").fetchFn)).toEqual({ status: "current" });
  });
  test("older remote is current", async () => {
    expect(await run("0.12.34", remote("0.12.3").fetchFn)).toEqual({ status: "current" });
  });
  test("dev build newer than remote is current", async () => {
    expect(await run("1.0.0", remote("0.12.34").fetchFn)).toEqual({ status: "current" });
  });
  test("numeric not lexical: 0.12.10 > 0.12.9", async () => {
    expect(await run("0.12.9", remote("0.12.10").fetchFn)).toEqual({ status: "behind", latest: "0.12.10" });
    fs.rmSync(cachePath, { force: true });
    expect(await run("0.12.10", remote("0.12.9").fetchFn)).toEqual({ status: "current" });
  });
  test("non-semver current version is unknown without fetching", async () => {
    const r = remote("9.9.9");
    expect(await run("dev", r.fetchFn)).toEqual({ status: "unknown" });
    expect(r.calls).toHaveLength(0);
  });
  test("requests the GitHub main plugin.json with no client header", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    await run("0.1.0", async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ version: "0.1.0" }));
    });
    expect(seen!.url).toBe("https://raw.githubusercontent.com/omni-ping/upublish.skill/main/plugin.json");
    expect(JSON.stringify(seen!.init?.headers ?? {})).not.toContain("X-Upublish-Client");
  });
});

describe("dirty remote results yield unknown and never throw", () => {
  const cases: Array<[string, FetchFn]> = [
    ["malformed JSON", async () => new Response("{not json", { status: 200 })],
    ["JSON null", async () => new Response("null", { status: 200 })],
    ["missing version", async () => new Response("{}", { status: 200 })],
    ["numeric version", async () => new Response('{"version": 1}', { status: 200 })],
    ["injection-looking version", async () => new Response('{"version":"1.0.0; rm -rf"}', { status: 200 })],
    ["prerelease version", async () => new Response('{"version":"1.0.0-beta"}', { status: 200 })],
    ["404", async () => new Response("Not Found", { status: 404 })],
    ["500", async () => new Response("boom", { status: 500 })],
    ["thrown fetch", async () => { throw new Error("ENOTFOUND"); }],
    ["oversized body", async () => new Response(`{"version":"9.9.9","pad":"${"x".repeat(70_000)}"}`, { status: 200 })],
    ["timeout (fetch ignores abort)", () => new Promise<Response>(() => {})],
  ];
  for (const [name, fetchFn] of cases) {
    test(name, async () => {
      expect(await run("0.12.34", fetchFn)).toEqual({ status: "unknown" });
      expect(fs.existsSync(cachePath)).toBe(false); // failures are never cached
    });
  }

  test("DW_2_2 timeout resolves within the bound", async () => {
    const t0 = Date.now();
    await run("0.12.34", () => new Promise<Response>(() => {}));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("cache (DW-2.3)", () => {
  const writeCache = (v: unknown) => fs.writeFileSync(cachePath, typeof v === "string" ? v : JSON.stringify(v));

  test("test_DW_2_3_fresh_cache_means_zero_fetches", async () => {
    writeCache({ checkedAt: NOW - 23 * HOUR, latest: "0.13.0" });
    const r = remote("9.9.9");
    expect(await run("0.12.34", r.fetchFn)).toEqual({ status: "behind", latest: "0.13.0" });
    expect(r.calls).toHaveLength(0);
  });
  test("test_DW_2_3_stale_cache_means_one_fetch_and_rewrite", async () => {
    writeCache({ checkedAt: NOW - 25 * HOUR, latest: "0.12.0" });
    const r = remote("0.13.0");
    expect(await run("0.12.34", r.fetchFn)).toEqual({ status: "behind", latest: "0.13.0" });
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: NOW, latest: "0.13.0" });
  });
  test("test_DW_2_3_future_dated_cache_means_one_fetch", async () => {
    writeCache({ checkedAt: NOW + HOUR, latest: "0.12.0" });
    const r = remote("0.13.0");
    await run("0.12.34", r.fetchFn);
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).checkedAt).toBe(NOW);
  });
  for (const [name, content] of [
    ["corrupt JSON", "{{{"],
    ["wrong shape", { checkedAt: "yesterday", latest: 3 }],
    ["cached non-semver latest", { checkedAt: NOW, latest: "1.0.0; rm" }],
  ] as const) {
    test(`test_DW_2_3_${name.replace(/\W+/g, "_")}_cache_means_one_fetch_and_rewrite`, async () => {
      writeCache(content);
      const r = remote("0.13.0");
      expect(await run("0.12.34", r.fetchFn)).toEqual({ status: "behind", latest: "0.13.0" });
      expect(r.calls).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).latest).toBe("0.13.0");
    });
  }
  test("a fresh cache holding current version yields current", async () => {
    writeCache({ checkedAt: NOW, latest: "0.12.34" });
    expect(await run("0.12.34", remote("9.9.9").fetchFn)).toEqual({ status: "current" });
  });
  test("credentialsPath places the cache beside the credentials file", async () => {
    await checkForUpdate("0.1.0", {
      fetchFn: remote("0.2.0").fetchFn,
      credentialsPath: path.join(dir, "credentials"),
      now: () => NOW,
    });
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: NOW, latest: "0.2.0" });
  });
  test("creates the cache directory when missing", async () => {
    const nested = path.join(dir, "a", "b", "update-check.json");
    await checkForUpdate("0.1.0", { fetchFn: remote("0.2.0").fetchFn, cachePath: nested, now: () => NOW });
    expect(fs.existsSync(nested)).toBe(true);
  });
  test("unwritable cache location does not throw and still reports", async () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x"); // a file where a directory is needed
    const res = await checkForUpdate("0.1.0", {
      fetchFn: remote("0.2.0").fetchFn,
      cachePath: path.join(blocker, "update-check.json"),
      now: () => NOW,
    });
    expect(res).toEqual({ status: "behind", latest: "0.2.0" });
  });
  test("a throwing clock yields unknown, not a rejection", async () => {
    const res = await checkForUpdate("0.1.0", {
      fetchFn: remote("0.2.0").fetchFn,
      cachePath,
      now: () => { throw new Error("clock"); },
    });
    expect(res).toEqual({ status: "unknown" });
  });
});

describe("formatUpdateNote", () => {
  test("is one line naming installed, latest and the update path for each host", () => {
    const note = formatUpdateNote("0.12.34", "0.13.0");
    expect(note).not.toContain("\n");
    for (const s of ["0.12.34", "0.13.0", "/plugin", "Enable auto-update", "/plugin update upublish@upublish.skill", "/reload-plugins", "Codex", "Gemini CLI", "Antigravity"]) {
      expect(note).toContain(s);
    }
  });
});
