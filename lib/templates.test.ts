/**
 * lib/templates.ts: listTemplates and the all-or-nothing createFromTemplate.
 * DW-2.1 list, DW-2.2 byte-for-byte copy, DW-2.3 non-empty/clash rules, DW-2.4 injected I/O failure,
 * DW-2.5 symlinks, macOS tmpdir and `../relative`, DW-2.9 the copy passes publish preflight.
 * Every test runs in a real os.tmpdir() folder.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { listTemplates, createFromTemplate, templatesRoot } from "./templates.ts";
import type { TemplateFs, CreateFromTemplateResult } from "./templates.ts";
import { listFiles, preflightCheck } from "./publish.ts";

const ROOT = path.join(import.meta.dir, "..", "templates");
const SIX = ["coming-soon", "docs", "landing", "links", "portfolio", "resume"];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-"));
  tmpDirs.push(d);
  return d;
}

/** Recursive, lstat-aware snapshot: file bytes hashed, symlink targets recorded (never followed). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const full = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(full)}`;
      else if (st.isDirectory()) { out[r] = "dir"; walk(full, r); }
      else out[r] = `file:${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`;
    }
  };
  walk(dir, "");
  return out;
}

const templateFiles = (name: string): string[] =>
  fs.readdirSync(path.join(ROOT, name), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== ".DS_Store")
    .map((e) => path.relative(path.join(ROOT, name), path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();

function ok(r: CreateFromTemplateResult): Extract<CreateFromTemplateResult, { success: true }> {
  if (!r.success) throw new Error(`expected success, got ${r.code}: ${r.error}`);
  return r;
}

describe("DW-2.1: list", () => {
  test("test_DW_2_1_lists_all_six_with_title_and_description", () => {
    const r = listTemplates();
    if (!r.success) throw new Error(r.error);
    expect(r.templates.map((t) => t.name)).toEqual(SIX);
    for (const t of r.templates) {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, `${t.name}.json`), "utf8"));
      expect(t).toEqual({ name: t.name, title: manifest.title, description: manifest.description });
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test("templatesRoot resolves one level up from both lib/templates.ts and dist/mcp.js", () => {
    expect(templatesRoot()).toBe(ROOT);
    expect(templatesRoot("file:///opt/pkg/dist/mcp.js")).toBe("/opt/pkg/templates");
    expect(templatesRoot("file:///opt/pkg/lib/templates.ts")).toBe("/opt/pkg/templates");
  });

  test("an invalid manifest is a structured bad_template error, not a throw", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "x"));
    fs.writeFileSync(path.join(root, "x.json"), "{ not json");
    expect(listTemplates({ root })).toMatchObject({ success: false, code: "bad_template" });
    fs.writeFileSync(path.join(root, "x.json"), JSON.stringify({ name: "y", title: "t", description: "d", placeholders: [] }));
    expect(listTemplates({ root })).toMatchObject({ success: false, code: "bad_template" });
  });

  test("a missing templates folder is a structured error", () => {
    expect(listTemplates({ root: path.join(tmp(), "nope") })).toMatchObject({ success: false, code: "bad_template" });
  });

  test("a manifest without a folder beside it is ignored", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "orphan.json"), JSON.stringify({ name: "orphan", title: "t", description: "d", placeholders: [] }));
    expect(listTemplates({ root })).toEqual({ success: true, templates: [] });
  });
});

describe("DW-2.2: create copies every file byte for byte", () => {
  test.each(SIX)("test_DW_2_2_%s_into_a_new_folder", (name) => {
    const target = path.join(tmp(), "site");
    const r = ok(createFromTemplate({ name, directory: target }));
    expect(r.directory).toBe(target);
    expect(path.isAbsolute(r.directory)).toBe(true);
    expect(r.files.sort()).toEqual(templateFiles(name));
    expect(fs.readdirSync(target).sort()).toEqual(templateFiles(name));
    for (const f of r.files) expect(fs.readFileSync(path.join(target, f)).equals(fs.readFileSync(path.join(ROOT, name, f)))).toBe(true);
    expect(fs.existsSync(path.join(target, `${name}.json`))).toBe(false); // the manifest is not copied
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), "utf8"));
    expect(r.placeholders).toEqual(manifest.placeholders);
  });

  test("test_DW_2_2_into_an_existing_empty_folder", () => {
    const target = tmp();
    const r = ok(createFromTemplate({ name: "links", directory: target }));
    expect(fs.readdirSync(target).sort()).toEqual(templateFiles("links"));
    expect(r.realDirectory).toBe(fs.realpathSync(target));
  });

  test("reports every data-placeholder-href with its file and hint", () => {
    const r = ok(createFromTemplate({ name: "coming-soon", directory: path.join(tmp(), "s") }));
    expect(r.placeholderHrefs).toContainEqual({ file: "index.html", hint: "mailto: link with your email address" });
    const docs = ok(createFromTemplate({ name: "docs", directory: path.join(tmp(), "d") }));
    expect(docs.placeholderHrefs.map((h) => h.file)).toContain("guide.html");
  });

  test("a relative directory resolves against cwd", () => {
    const cwd = tmp();
    const r = ok(createFromTemplate({ name: "resume", directory: "out/cv" }, { cwd }));
    expect(r.directory).toBe(path.join(cwd, "out", "cv"));
    expect(fs.existsSync(path.join(cwd, "out", "cv", "index.html"))).toBe(true);
  });

  test("subfolders in a template are created and copied", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "t", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "t", "index.html"), "<p>[[X]]</p>");
    fs.writeFileSync(path.join(root, "t", "assets", "a.css"), "a{}");
    fs.writeFileSync(path.join(root, "t.json"), JSON.stringify({ name: "t", title: "T", description: "D", placeholders: [{ token: "[[X]]", hint: "x" }] }));
    const target = path.join(tmp(), "s");
    const r = ok(createFromTemplate({ name: "t", directory: target }, { root }));
    expect(r.files.sort()).toEqual(["assets/a.css", "index.html"]);
    expect(fs.readFileSync(path.join(target, "assets", "a.css"), "utf8")).toBe("a{}");
  });
});

describe("argument errors", () => {
  test("an unknown name lists the valid ones and writes nothing", () => {
    const parent = tmp();
    const r = createFromTemplate({ name: "blog", directory: path.join(parent, "s") });
    expect(r).toMatchObject({ success: false, code: "unknown_template" });
    if (!r.success) for (const n of SIX) expect(r.error).toContain(n);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test.each(["../links", "links/../links", "/etc", ""])("a path-like or empty name %p is unknown, never joined", (name) => {
    expect(createFromTemplate({ name, directory: path.join(tmp(), "s") })).toMatchObject({ success: false, code: "unknown_template" });
  });

  test.each([undefined, "", "   "])("a missing directory %p is refused", (directory) => {
    expect(createFromTemplate({ name: "links", directory })).toMatchObject({ success: false, code: "missing_directory" });
  });

  test("a NUL in the directory is refused", () => {
    expect(createFromTemplate({ name: "links", directory: "a\0b" })).toMatchObject({ success: false, code: "missing_directory" });
  });

  test("a target that is a file is refused and left alone", () => {
    const file = path.join(tmp(), "f");
    fs.writeFileSync(file, "keep");
    expect(createFromTemplate({ name: "links", directory: file })).toMatchObject({ success: false, code: "not_a_directory" });
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });

  test("a target under a file is refused", () => {
    const file = path.join(tmp(), "f");
    fs.writeFileSync(file, "keep");
    expect(createFromTemplate({ name: "links", directory: path.join(file, "sub") })).toMatchObject({ success: false, code: "not_a_directory" });
  });
});

describe("DW-2.3: non-empty and clash rules", () => {
  function dirty(): string {
    const d = tmp();
    fs.writeFileSync(path.join(d, "notes.txt"), "mine");
    fs.mkdirSync(path.join(d, "img"));
    fs.writeFileSync(path.join(d, "img", "a.png"), "png");
    return d;
  }

  test("test_DW_2_3_non_empty_without_the_flag_is_refused_unchanged", () => {
    const d = dirty();
    const before = snapshot(d);
    expect(createFromTemplate({ name: "links", directory: d })).toMatchObject({ success: false, code: "not_empty" });
    expect(snapshot(d)).toEqual(before);
  });

  test("test_DW_2_3_non_empty_with_the_flag_and_no_clash_adds_beside_existing", () => {
    const d = dirty();
    const before = snapshot(d);
    ok(createFromTemplate({ name: "links", directory: d, allowNonEmpty: true }));
    const after = snapshot(d);
    for (const [k, v] of Object.entries(before)) expect(after[k]).toBe(v);
    expect(after["index.html"]).toBeDefined();
  });

  test.each([
    ["exact name", (d: string) => fs.writeFileSync(path.join(d, "index.html"), "mine")],
    ["case-only name", (d: string) => fs.writeFileSync(path.join(d, "Index.HTML"), "mine")],
    ["dangling symlink", (d: string) => fs.symlinkSync(path.join(d, "nowhere"), path.join(d, "styles.css"))],
    ["symlink to a real file", (d: string) => { fs.writeFileSync(path.join(d, "real"), "x"); fs.symlinkSync(path.join(d, "real"), path.join(d, "index.html")); }],
    ["folder where a file goes", (d: string) => fs.mkdirSync(path.join(d, "index.html"))],
  ])("test_DW_2_3_clash_with_the_flag_is_refused_unchanged: %s", (_label, plant) => {
    const d = dirty();
    plant(d);
    const before = snapshot(d);
    const r = createFromTemplate({ name: "links", directory: d, allowNonEmpty: true });
    expect(r).toMatchObject({ success: false, code: "clash" });
    if (!r.success) expect(r.error).toContain("Nothing was written");
    expect(snapshot(d)).toEqual(before);
  });

  test("every clash is named at once", () => {
    const d = dirty();
    fs.writeFileSync(path.join(d, "INDEX.html"), "1");
    fs.writeFileSync(path.join(d, "Styles.css"), "2");
    const r = createFromTemplate({ name: "links", directory: d, allowNonEmpty: true });
    if (r.success) throw new Error("expected a clash");
    expect(r.error).toContain("INDEX.html");
    expect(r.error).toContain("Styles.css");
  });

  test("an existing exact-name subfolder is merged into; a case-variant subfolder clashes", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "t", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "t", "index.html"), "i");
    fs.writeFileSync(path.join(root, "t", "assets", "a.css"), "a");
    fs.writeFileSync(path.join(root, "t.json"), JSON.stringify({ name: "t", title: "T", description: "D", placeholders: [] }));

    const merge = tmp();
    fs.mkdirSync(path.join(merge, "assets"));
    fs.writeFileSync(path.join(merge, "assets", "b.css"), "b");
    ok(createFromTemplate({ name: "t", directory: merge, allowNonEmpty: true }, { root }));
    expect(fs.readdirSync(path.join(merge, "assets")).sort()).toEqual(["a.css", "b.css"]);

    const nested = tmp();
    fs.mkdirSync(path.join(nested, "assets"));
    fs.writeFileSync(path.join(nested, "assets", "A.CSS"), "b");
    expect(createFromTemplate({ name: "t", directory: nested, allowNonEmpty: true }, { root })).toMatchObject({ code: "clash" });

    const variant = tmp();
    fs.mkdirSync(path.join(variant, "Assets"));
    const before = snapshot(variant);
    expect(createFromTemplate({ name: "t", directory: variant, allowNonEmpty: true }, { root })).toMatchObject({ code: "clash" });
    expect(snapshot(variant)).toEqual(before);
  });
});

/** A real fs whose `op` throws `code` on its `nth` call (1-based). */
function failingFs(op: "openSync" | "writeSync" | "mkdirSync" | "closeSync", nth: number, code: string): TemplateFs {
  let calls = 0;
  const real = fs[op] as (...a: unknown[]) => unknown;
  return {
    ...fs,
    [op]: (...a: unknown[]) => {
      if (++calls === nth) throw Object.assign(new Error(`${code}: injected`), { code });
      return real(...a);
    },
  } as TemplateFs;
}

describe("DW-2.4: an injected mid-copy failure leaves everything as it was", () => {
  test.each([
    ["writeSync", 2, "ENOSPC"],
    ["openSync", 2, "EACCES"],
    ["closeSync", 1, "EIO"],
    ["writeSync", 1, "ENOSPC"],
  ] as const)("test_DW_2_4_%s_call_%i_%s_in_a_new_nested_folder_removes_created_parents", (op, nth, code) => {
    const base = tmp();
    const target = path.join(base, "a", "b", "site");
    const r = createFromTemplate({ name: "docs", directory: target }, { fs: failingFs(op, nth, code) });
    expect(r).toMatchObject({ success: false, code: "io_error" });
    if (!r.success) {
      expect(r.error).toContain(code);
      expect(r.error).toContain("Everything this call created was removed");
    }
    expect(fs.readdirSync(base)).toEqual([]); // a/, a/b/ and site/ are all gone
  });

  test("test_DW_2_4_failure_in_a_non_empty_folder_removes_only_what_it_wrote", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "notes.txt"), "mine");
    fs.mkdirSync(path.join(d, "keep"));
    const before = snapshot(d);
    const r = createFromTemplate({ name: "docs", directory: d, allowNonEmpty: true }, { fs: failingFs("writeSync", 3, "ENOSPC") });
    expect(r).toMatchObject({ success: false, code: "io_error" });
    expect(snapshot(d)).toEqual(before);
  });

  test("test_DW_2_4_mkdir_failure_of_a_parent_removes_the_parents_already_made", () => {
    const base = tmp();
    const r = createFromTemplate({ name: "links", directory: path.join(base, "a", "b") }, { fs: failingFs("mkdirSync", 2, "EACCES") });
    expect(r).toMatchObject({ success: false, code: "io_error" });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  test("test_DW_2_4_a_file_appearing_between_check_and_write_is_caught_by_wx_and_kept", () => {
    const d = tmp();
    let first = true;
    const racing: TemplateFs = {
      ...fs,
      openSync: ((p: string, flags: string) => {
        if (first) { first = false; fs.writeFileSync(p, "racer"); } // another process wins the race
        return fs.openSync(p, flags);
      }) as TemplateFs["openSync"],
    };
    const r = createFromTemplate({ name: "links", directory: d }, { fs: racing });
    expect(r).toMatchObject({ success: false, code: "io_error" });
    if (!r.success) expect(r.error).toContain("EEXIST");
    expect(fs.readdirSync(d)).toEqual(["index.html"]);
    expect(fs.readFileSync(path.join(d, "index.html"), "utf8")).toBe("racer");
  });

  test("a failed cleanup is reported, not swallowed", () => {
    const base = tmp();
    const target = path.join(base, "site");
    const broken: TemplateFs = {
      ...failingFs("writeSync", 2, "ENOSPC"),
      unlinkSync: (() => { throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" }); }) as TemplateFs["unlinkSync"],
    };
    const r = createFromTemplate({ name: "links", directory: target }, { fs: broken });
    if (r.success) throw new Error("expected failure");
    expect(r.error).toContain("Could not remove");
    expect(r.error).toContain("EPERM");
  });
});

describe("DW-2.5: symlinks, tmpdir and relative paths", () => {
  test("test_DW_2_5_target_symlink_pointing_outside_its_parent_is_refused", () => {
    const outside = tmp();
    const parent = tmp();
    fs.symlinkSync(outside, path.join(parent, "site"));
    const r = createFromTemplate({ name: "links", directory: path.join(parent, "site") });
    expect(r).toMatchObject({ success: false, code: "symlink_escape" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("test_DW_2_5_parent_symlink_pointing_outside_is_refused", () => {
    const outside = tmp();
    const parent = tmp();
    fs.symlinkSync(outside, path.join(parent, "out"));
    const r = createFromTemplate({ name: "links", directory: path.join(parent, "out", "site") });
    expect(r).toMatchObject({ success: false, code: "symlink_escape" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("test_DW_2_5_dangling_symlink_target_is_refused", () => {
    const parent = tmp();
    fs.symlinkSync(path.join(parent, "gone"), path.join(parent, "site"));
    expect(createFromTemplate({ name: "links", directory: path.join(parent, "site") })).toMatchObject({ success: false, code: "symlink_escape" });
    expect(fs.existsSync(path.join(parent, "gone"))).toBe(false);
  });

  test("test_DW_2_5_symlink_resolving_inside_its_parent_is_allowed", () => {
    const parent = tmp();
    fs.mkdirSync(path.join(parent, "real"));
    fs.symlinkSync(path.join(parent, "real"), path.join(parent, "alias"));
    const r = ok(createFromTemplate({ name: "links", directory: path.join(parent, "alias") }));
    expect(r.realDirectory).toBe(path.join(fs.realpathSync(parent), "real"));
    expect(fs.existsSync(path.join(parent, "real", "index.html"))).toBe(true);
  });

  test("test_DW_2_5_os_tmpdir_paths_are_not_refused_falsely", () => {
    // On macOS os.tmpdir() is under /var → /private/var (and /tmp → /private/tmp): system symlinks at the root.
    const d = tmp();
    const r = ok(createFromTemplate({ name: "links", directory: path.join(d, "site") }));
    expect(r.directory).toBe(path.join(d, "site"));
    expect(r.realDirectory).toBe(path.join(fs.realpathSync(d), "site"));
    if (process.platform === "darwin") {
      const viaTmp = fs.mkdtempSync("/tmp/tpl-");
      tmpDirs.push(viaTmp);
      const t = ok(createFromTemplate({ name: "links", directory: path.join(viaTmp, "site") }));
      expect(t.realDirectory).toBe(path.join("/private", viaTmp, "site"));
    }
  });

  test("test_DW_2_5_dotdot_relative_directory_works", () => {
    const base = tmp();
    const cwd = path.join(base, "project");
    fs.mkdirSync(cwd);
    const r = ok(createFromTemplate({ name: "landing", directory: "../my-site" }, { cwd }));
    expect(r.directory).toBe(path.join(base, "my-site"));
    expect(fs.existsSync(path.join(base, "my-site", "index.html"))).toBe(true);
  });
});

describe("DW-2.9: a created folder passes publish preflight", () => {
  test.each(SIX)("test_DW_2_9_%s_passes_preflight_with_no_warnings", (name) => {
    const target = path.join(tmp(), name);
    ok(createFromTemplate({ name, directory: target }));
    const { files, excluded, warnings } = listFiles(target);
    expect(() => preflightCheck(files, excluded, {})).not.toThrow();
    expect(warnings).toEqual([]);
    expect(files.map((f) => f.relPath).sort()).toEqual(templateFiles(name));
  });
});
