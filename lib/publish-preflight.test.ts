/**
 * Phase 3: pre-flight guard, wider excludes, spa, overwrite-awareness line.
 * DW-3.1 .. DW-3.5 at the lib layer.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { publish, preflightCheck, listFiles, renderReplaceLine, readPlanTier } from "./publish.ts";
import type { PublishResult } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

const SITE = {
  id: "u1", user_id: "x", slug: "my-site", title: "t", created_at: "", updated_at: "",
  file_count: 1, total_size: 1, visibility: "public" as const, passcode_hash: null,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "upublish-preflight-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tree(files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}

interface Harness { urls: string[]; manifestBody: () => Record<string, any> | null; run: (o?: Record<string, unknown>) => Promise<PublishResult> }
function harness(opts: { base?: number | null; version?: number; tier?: unknown; spaceStatus?: number } = {}): Harness {
  const urls: string[] = [];
  let body: Record<string, any> | null = null;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    if (url.includes("/manifest")) {
      body = JSON.parse(init!.body as string);
      return json(200, { needed: [], version: opts.version ?? 2, session_id: "s", base_version: opts.base ?? null });
    }
    if (url.includes("/finalize")) return json(200, { site: SITE, url: "https://u.upubli.sh/my-site/" });
    if (url.endsWith("/api/space")) {
      return opts.spaceStatus && opts.spaceStatus !== 200
        ? json(opts.spaceStatus, { error: "boom" })
        : json(200, { space: { tier: opts.tier ?? "pro" } });
    }
    return json(404, {});
  };
  const apiClient = new ApiClient("https://api.example.com", async () => "tok", fetchFn);
  return {
    urls,
    manifestBody: () => body,
    run: (o = {}) => publish({ apiClient, nsId: "ns", directory: dir, slug: "my-site", fetchFn, ...o }),
  };
}

describe("DW-3.1: missing top-level index.html", () => {
  it("test_DW_3_1_throws_before_any_fetch", async () => {
    tree({ "about.html": "x" });
    const h = harness();
    await expect(h.run()).rejects.toThrow(/No index\.html at the top level/);
    expect(h.urls).toEqual([]);
  });
  it("test_DW_3_1_allow_no_index_publishes", async () => {
    tree({ "about.html": "x" });
    const r = await harness().run({ allowNoIndex: true });
    expect(r.url).toContain("my-site");
  });
  it("test_DW_3_1_index_only_in_subfolder_blocks", async () => {
    tree({ "docs/index.html": "x" });
    const h = harness();
    await expect(h.run()).rejects.toThrow(/No index\.html/);
    expect(h.urls).toEqual([]);
  });
  it("test_DW_3_1_empty_dir_still_says_empty", async () => {
    await expect(harness().run()).rejects.toThrow("Directory is empty");
  });
  it("test_DW_3_1_root_slug_follows_same_rules", async () => {
    tree({ "about.html": "x" });
    await expect(harness().run({ slug: "_root" })).rejects.toThrow(/No index\.html/);
  });
});

describe("DW-3.2: project-folder block", () => {
  it("test_DW_3_2_package_json_plus_src_without_index_throws_naming_dist", async () => {
    tree({ "package.json": "{}", "src/app.ts": "x", "dist/index.html": "x" });
    const h = harness();
    await expect(h.run()).rejects.toThrow(/project folder.*package\.json, src\/.*'dist\/'/s);
    expect(h.urls).toEqual([]);
  });
  it("test_DW_3_2_blocks_even_with_index_html", async () => {
    tree({ "index.html": "x", "package.json": "{}", "src/app.ts": "x", "build/index.html": "y" });
    const h = harness();
    await expect(h.run()).rejects.toThrow(/project folder.*'build\/'/s);
    expect(h.urls).toEqual([]);
  });
  it("test_DW_3_2_no_index_message_also_names_build_dir", async () => {
    tree({ "dist/index.html": "x", "notes.txt": "n" });
    await expect(harness().run()).rejects.toThrow(/No index\.html.*'dist\/'/s);
  });
  it("test_DW_3_2_allow_project_files_publishes", async () => {
    tree({ "index.html": "x", "package.json": "{}", "src/app.ts": "x" });
    const r = await harness().run({ allowProjectFiles: true });
    expect(r.version).toBe(2);
  });
  it("test_DW_3_2_single_signal_not_blocked", async () => {
    tree({ "index.html": "x", "package.json": "{}" });
    expect((await harness().run()).version).toBe(2);
  });
  it("test_DW_3_2_dot_git_counts_as_signal_and_lockfile", () => {
    tree({ "index.html": "x", "yarn.lock": "l", ".git/HEAD": "ref" });
    const { files, excluded } = listFiles(dir);
    expect(() => preflightCheck(files, excluded, {})).toThrow(/\.git\//);
  });
  it("test_DW_1_2_dot_git_file_excluded_at_any_depth_dir_unchanged", () => {
    tree({ "index.html": "x", ".git": "gitdir: /x/.git/worktrees/w", "sub/.git": "gitdir: /y", "sub/a.html": "a" });
    const { files, excluded } = listFiles(dir);
    expect(files.map((f) => f.relPath).sort()).toEqual(["index.html", "sub/a.html"]);
    expect(excluded).toContain(".git");
    expect(excluded).toContain("sub/.git");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "upublish-preflight-"));
    tree({ "index.html": "x", ".git/HEAD": "ref" });
    expect(listFiles(dir).excluded).toContain(".git/");
  });
  it("test_DW_1_2_dot_git_file_plus_package_json_trips_project_guard", async () => {
    tree({ "index.html": "x", "package.json": "{}", ".git": "gitdir: /x" });
    const { files, excluded } = listFiles(dir);
    expect(() => preflightCheck(files, excluded, {})).toThrow(/project folder.*\.git/);
    expect(() => preflightCheck(files, excluded, { allowProjectFiles: true })).not.toThrow();
    expect((await harness().run({ allowProjectFiles: true })).excluded).toContain(".git");
  });
  it("test_preflight_src_signal_needs_files_under_src", () => {
    tree({ "index.html": "x", "package.json": "{}", "srcfile.txt": "y" });
    const { files, excluded } = listFiles(dir);
    expect(() => preflightCheck(files, excluded, {})).not.toThrow();
  });
  it("test_preflight_clean_site_passes", () => {
    tree({ "index.html": "x", "css/a.css": "y" });
    const { files, excluded } = listFiles(dir);
    expect(() => preflightCheck(files, excluded, {})).not.toThrow();
  });
});

describe("DW-3.3: new default excludes", () => {
  const secrets = [
    ".envrc", ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa", "id_dsa",
    "cert.p12", "cert.pfx", "credentials.json", "secrets.yml", "secrets.json", ".ssh/config", ".aws/credentials",
    "ID_RSA", "sub/.npmrc",
  ];
  for (const name of secrets) {
    it(`test_DW_3_3_excludes_${name}`, () => {
      tree({ "index.html": "x", [name]: "secret" });
      const { files, excluded } = listFiles(dir);
      expect(files.map((f) => f.relPath)).toEqual(["index.html"]);
      // Excluded secret dirs are reported as "<dir>/"; files by their relative path.
      expect(excluded).toContain(name.startsWith(".") && name.includes("/") ? `${name.split("/")[0]}/` : name);
    });
  }
  it("test_DW_3_3_secrets_never_in_manifest", async () => {
    tree({ "index.html": "x", ".npmrc": "t", ".aws/credentials": "k", "id_rsa": "k" });
    const h = harness();
    await h.run();
    expect(Object.keys(h.manifestBody()!.files)).toEqual(["index.html"]);
  });
  it("test_DW_3_3_similar_names_not_excluded", () => {
    tree({ "index.html": "x", "secret.txt": "x", "idea.html": "x", "credentials.html": "x" });
    expect(listFiles(dir).files).toHaveLength(4);
  });
  it("test_DW_3_3_map_excluded_by_default", () => {
    tree({ "index.html": "x", "app.js.map": "m" });
    const r = listFiles(dir);
    expect(r.files.map((f) => f.relPath)).toEqual(["index.html"]);
    expect(r.excluded).toContain("app.js.map");
  });
  it("test_DW_3_3_map_included_with_include_sourcemaps", async () => {
    tree({ "index.html": "x", "app.js.map": "m" });
    expect(listFiles(dir, { includeSourcemaps: true }).files).toHaveLength(2);
    const h = harness();
    await h.run({ includeSourcemaps: true });
    expect(Object.keys(h.manifestBody()!.files).sort()).toEqual(["app.js.map", "index.html"]);
  });
  it("test_DW_3_3_secrets_still_excluded_with_include_sourcemaps", () => {
    tree({ "index.html": "x", ".npmrc": "t" });
    expect(listFiles(dir, { includeSourcemaps: true }).files).toHaveLength(1);
  });
});

describe("DW-3.4: spa in manifest body", () => {
  it("test_DW_3_4_spa_true_sent", async () => {
    tree({ "index.html": "x" });
    const h = harness();
    await h.run({ spa: true });
    expect(h.manifestBody()!.spa).toBe(true);
  });
  it("test_DW_3_4_spa_absent_when_unset", async () => {
    tree({ "index.html": "x" });
    const h = harness();
    await h.run();
    expect("spa" in h.manifestBody()!).toBe(false);
  });
});

describe("DW-3.5: replaced-version result + line", () => {
  beforeEach(() => tree({ "index.html": "x" }));

  it("test_DW_3_5_first_publish_no_line", async () => {
    const h = harness({ base: null });
    const r = await h.run();
    expect(r.replacedVersion).toBeNull();
    expect(r.planTier).toBeNull();
    expect(renderReplaceLine(r)).toBe("");
    expect(h.urls.some((u) => u.endsWith("/api/space"))).toBe(false);
  });
  it("test_DW_3_5_paid_republish", async () => {
    const r = await harness({ base: 3, version: 4, tier: "pro" }).run();
    expect(r).toMatchObject({ replacedVersion: 3, version: 4, planTier: "paid" });
    expect(renderReplaceLine(r)).toBe("\nReplaced live version v3 → v4. Undo: versions_restore(my-site, 3)");
  });
  it("test_DW_3_5_max_is_paid", async () => {
    expect((await harness({ base: 1, tier: "max" }).run()).planTier).toBe("paid");
  });
  it("test_DW_3_5_free_republish", async () => {
    const r = await harness({ base: 3, version: 4, tier: "free" }).run();
    expect(renderReplaceLine(r)).toBe("\nReplaced live version v3 → v4 (free plan: the previous version can't be restored)");
    expect(renderReplaceLine(r)).not.toContain("Undo");
  });
  it("test_DW_3_5_tier_read_failure_is_neutral_and_publish_succeeds", async () => {
    const r = await harness({ base: 3, version: 4, spaceStatus: 500 }).run();
    expect(r.planTier).toBeNull();
    expect(renderReplaceLine(r)).toContain("restoring needs a paid plan");
  });
  it("test_DW_3_5_unrecognized_tier_is_neutral", async () => {
    expect((await harness({ base: 3, tier: "weird" }).run()).planTier).toBeNull();
  });
  it("test_DW_3_5_member_namespace_skips_tier_read", async () => {
    const h = harness({ base: 3, tier: "free" });
    const r = await h.run({ namespaceRole: "admin" });
    expect(r.planTier).toBeNull();
    expect(h.urls.some((u) => u.endsWith("/api/space"))).toBe(false);
  });
  it("test_DW_3_5_preview_says_live_unchanged_and_skips_tier_read", async () => {
    const h = harness({ base: 3 });
    const r = await h.run({ preview: true });
    expect(h.urls.some((u) => u.endsWith("/api/space"))).toBe(false);
    expect(renderReplaceLine({ ...r, preview_url: "https://p/@v2/" })).toBe("\nLive site unchanged (preview)");
  });
});

describe("DW-1.3: readPlanTier timeout", () => {
  const client = (get: () => Promise<unknown>) => ({ get } as unknown as ApiClient);

  it("test_DW_1_3_never_resolving_space_read_yields_null_within_timeout", async () => {
    const t0 = Date.now();
    const tier = await readPlanTier(client(() => new Promise(() => {})), { replacesLive: true }, 30);
    expect(tier).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("test_DW_1_3_late_rejection_after_timeout_is_swallowed", async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on("unhandledRejection", onUnhandled);
    const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60));
    expect(await readPlanTier(client(late), { replacesLive: true }, 10)).toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toBe(0);
  });

  it("test_DW_1_3_success_returns_tier_and_clears_timer", async () => {
    const realClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => { cleared++; return realClear(id); }) as typeof clearTimeout;
    try {
      expect(await readPlanTier(client(async () => ({ space: { tier: "pro" } })), { replacesLive: true })).toBe("paid");
      expect(await readPlanTier(client(async () => ({ space: { tier: "free" } })), { replacesLive: true })).toBe("free");
    } finally {
      globalThis.clearTimeout = realClear;
    }
    expect(cleared).toBe(2);
  });

  it("test_DW_1_3_skipped_reads_do_not_call_api", async () => {
    let calls = 0;
    const c = client(async () => { calls++; return {}; });
    expect(await readPlanTier(c, { replacesLive: false })).toBeNull();
    expect(await readPlanTier(c, { replacesLive: true, namespaceRole: "member" as never })).toBeNull();
    expect(calls).toBe(0);
  });
});
