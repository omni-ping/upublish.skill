/**
 * Starter-template content checks (plan 2026-11-08-starter-templates, Phase 1).
 *
 * Each `templates/<name>/` folder must be directly publishable and self-contained,
 * and `templates/<name>.json` (outside the folder, never copied) must describe its
 * `[[placeholder]]` tokens exactly. The rendered checks (DW-1.4: layout at 360/1280 px,
 * axe in light and dark) need a headless browser and live in the build log, not here.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const TEMPLATES = resolve(import.meta.dir, "..", "templates");
const NAMES = ["coming-soon", "docs", "landing", "links", "portfolio", "resume"];
const SVG_NS = "http://www.w3.org/2000/svg";
const TOKEN = /\[\[[^\[\]]+\]\]/g;
const MAX_FOLDER_BYTES = 50 * 1024;
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".svg"]);

interface Placeholder {
  token: string;
  hint: string;
}
interface Manifest {
  name: string;
  title: string;
  description: string;
  placeholders: Placeholder[];
}

/** Every file in a folder, recursively, as paths relative to that folder. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

function readManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(TEMPLATES, `${name}.json`), "utf-8")) as Manifest;
}

function files(name: string): { path: string; text: string }[] {
  const dir = join(TEMPLATES, name);
  return walk(dir).map((path) => ({ path, text: readFileSync(join(dir, path), "utf-8") }));
}

function htmlPages(name: string): string[] {
  return walk(join(TEMPLATES, name)).filter((p) => p.endsWith(".html"));
}

/** Facts about one HTML page, gathered with Bun's streaming HTMLRewriter. */
interface PageFacts {
  lang: string | null;
  viewport: boolean;
  colorScheme: string | null;
  counts: Record<"main" | "header" | "footer" | "h1", number>;
  /** One entry per <svg>: whether it is hidden or carries an accessible name. */
  svgs: { hidden: boolean; named: boolean }[];
  ids: Set<string>;
  /** href/src values from every element that has one. */
  refs: string[];
}

async function inspect(html: string): Promise<PageFacts> {
  const facts: PageFacts = {
    lang: null,
    viewport: false,
    colorScheme: null,
    counts: { main: 0, header: 0, footer: 0, h1: 0 },
    svgs: [],
    ids: new Set(),
    refs: [],
  };
  const rw = new HTMLRewriter()
    .on("html", { element: (el) => void (facts.lang = el.getAttribute("lang")) })
    .on("meta[name]", {
      element: (el) => {
        const n = el.getAttribute("name");
        if (n === "viewport") facts.viewport = (el.getAttribute("content") ?? "").includes("width=device-width");
        if (n === "color-scheme") facts.colorScheme = el.getAttribute("content");
      },
    })
    .on("[id]", { element: (el) => void facts.ids.add(el.getAttribute("id") ?? "") })
    .on("[href], [src]", {
      element: (el) => {
        for (const a of ["href", "src"]) {
          const v = el.getAttribute(a);
          if (v !== null) facts.refs.push(v);
        }
      },
    })
    .on("svg", {
      element: (el) => {
        const hidden = el.getAttribute("aria-hidden") === "true";
        const named = el.getAttribute("role") === "img" && !!(el.getAttribute("aria-label") ?? "").trim();
        facts.svgs.push({ hidden, named });
      },
    })
    .on("svg > title", { element: () => void (facts.svgs[facts.svgs.length - 1]!.named = true) });
  for (const tag of ["main", "header", "footer", "h1"] as const) {
    rw.on(tag, { element: () => void facts.counts[tag]++ });
  }
  await rw.transform(new Response(html)).text();
  return facts;
}

/** A URL with no scheme, no host and no leading slash: it resolves next to the page. */
function isRelativePath(value: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("/") && !value.startsWith("\\");
}

describe("starter templates: manifests and placeholders", () => {
  test("test_DW_1_1_six_folders_and_six_manifests_and_nothing_else", () => {
    const entries = readdirSync(TEMPLATES, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(NAMES);
    expect(entries.filter((e) => e.isFile()).map((e) => e.name).sort()).toEqual(NAMES.map((n) => `${n}.json`));
  });

  test("test_DW_1_1_manifest_shape_and_name_match_folder", () => {
    for (const name of NAMES) {
      const m = readManifest(name);
      expect(Object.keys(m).sort()).toEqual(["description", "name", "placeholders", "title"]);
      expect(m.name).toBe(name);
      expect(m.title.trim().length).toBeGreaterThan(0);
      expect(m.description.trim().length).toBeGreaterThan(0);
      expect(m.placeholders.length).toBeGreaterThan(0);
      for (const p of m.placeholders) {
        expect(Object.keys(p).sort()).toEqual(["hint", "token"]);
        expect(p.token).toMatch(/^\[\[[^\[\]]+\]\]$/);
        expect(p.hint.trim().length).toBeGreaterThan(0);
      }
      const tokens = m.placeholders.map((p) => p.token);
      expect(new Set(tokens).size).toBe(tokens.length);
    }
  });

  test("test_DW_1_1_every_manifest_token_appears_in_the_files", () => {
    for (const name of NAMES) {
      const all = files(name).map((f) => f.text).join("\n");
      const missing = readManifest(name).placeholders.map((p) => p.token).filter((t) => !all.includes(t));
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
  });

  test("test_DW_1_1_every_token_in_the_files_is_in_the_manifest", () => {
    for (const name of NAMES) {
      const declared = new Set(readManifest(name).placeholders.map((p) => p.token));
      const found = files(name).flatMap((f) => f.text.match(TOKEN) ?? []);
      const undeclared = [...new Set(found)].filter((t) => !declared.has(t));
      expect({ name, undeclared }).toEqual({ name, undeclared: [] });
    }
  });

  test("placeholder_brackets_are_never_malformed", () => {
    // A stray `[[` or `]]` outside a well-formed token would slip past the reverse check.
    for (const name of NAMES) {
      for (const f of files(name)) {
        const rest = f.text.replace(TOKEN, "");
        expect({ file: `${name}/${f.path}`, stray: /\[\[|\]\]/.test(rest) }).toEqual({ file: `${name}/${f.path}`, stray: false });
      }
    }
  });

  test("placeholder_hrefs_are_hash_only", () => {
    // A link that carries a data-placeholder-href hint must still point at `#` until filled in.
    for (const name of NAMES) {
      for (const f of files(name).filter((x) => x.path.endsWith(".html"))) {
        for (const m of f.text.matchAll(/<a\b[^>]*data-placeholder-href[^>]*>/g)) {
          expect(m[0]).toContain('href="#"');
        }
      }
    }
  });
});

describe("starter templates: self-contained", () => {
  const BANNED: [string, RegExp][] = [
    ["absolute http(s) URL", /https?:\/\//i],
    ["protocol-relative URL", /(^|["'(\s=,])\/\/[^\s/*]/],
    ["@import", /@import/i],
    ["external script", /<script\b[^>]*\bsrc\s*=/i],
    ["iframe", /<iframe\b/i],
    ["meta refresh", /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i],
    ["fetch()", /\bfetch\s*\(/],
    ["data: font", /data:font/i],
    ["/_data", /\/_data/],
    ["/_api", /\/_api/],
    ["form", /<form\b/i],
    ["Site data copy", /site data/i],
    ["Backend copy", /\bbackend\b/i],
  ];

  test("test_DW_1_2_no_external_references_or_dark_add_ons", () => {
    const hits: string[] = [];
    for (const name of NAMES) {
      for (const f of files(name)) {
        const text = f.text.replaceAll(SVG_NS, "");
        for (const [label, re] of BANNED) if (re.test(text)) hits.push(`${name}/${f.path}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("test_DW_1_2_css_url_stylesheet_and_srcset_are_relative", () => {
    const hits: string[] = [];
    for (const name of NAMES) {
      for (const f of files(name)) {
        for (const m of f.text.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
          if (!m[1] || !isRelativePath(m[1])) hits.push(`${name}/${f.path}: url(${m[1]})`);
        }
        for (const m of f.text.matchAll(/<link\b[^>]*>/gi)) {
          const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? "";
          if (/stylesheet/i.test(m[0]) && !isRelativePath(href)) hits.push(`${name}/${f.path}: <link ${href}>`);
        }
        for (const m of f.text.matchAll(/srcset\s*=\s*["']([^"']*)["']/gi)) {
          const urls = m[1]!.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "");
          if (urls.some((u) => !isRelativePath(u))) hits.push(`${name}/${f.path}: srcset ${m[1]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("ban_list_catches_each_pattern", () => {
    // Guard the guard: every banned pattern must actually match a representative sample.
    const samples: Record<string, string> = {
      "absolute http(s) URL": '<a href="https://example.com">',
      "protocol-relative URL": '<img src="//cdn.example.com/x.png">',
      "@import": "@import 'x.css';",
      "external script": '<script src="app.js"></script>',
      iframe: "<iframe></iframe>",
      "meta refresh": '<meta http-equiv="refresh" content="0">',
      "fetch()": "fetch ('/x')",
      "data: font": "src: url(data:font/woff2;base64,AA)",
      "/_data": '"/_data/rows"',
      "/_api": '"/_api/x"',
      form: '<form action="#">',
      "Site data copy": "Uses Site data",
      "Backend copy": "Add a backend",
    };
    for (const [label, re] of BANNED) expect({ label, hit: re.test(samples[label]!) }).toEqual({ label, hit: true });
    expect(/https?:\/\//i.test(`<svg xmlns="${SVG_NS}">`.replaceAll(SVG_NS, ""))).toBe(false);
  });

  test("only_html_css_and_svg_files_ship", () => {
    // No README.md (publish flags it), no raster images, no fonts, no scripts.
    for (const name of NAMES) {
      const bad = walk(join(TEMPLATES, name)).filter((p) => !ALLOWED_EXTENSIONS.has(extname(p)));
      expect({ name, bad }).toEqual({ name, bad: [] });
      expect(existsSync(join(TEMPLATES, name, "index.html"))).toBe(true);
    }
  });
});

describe("starter templates: size", () => {
  test("test_DW_1_3_each_folder_is_under_50_kb", () => {
    for (const name of NAMES) {
      const dir = join(TEMPLATES, name);
      const bytes = walk(dir).reduce((sum, p) => sum + statSync(join(dir, p)).size, 0);
      expect({ name, under: bytes < MAX_FOLDER_BYTES }).toEqual({ name, under: true });
    }
  });
});

describe("starter templates: page structure", () => {
  test("test_DW_1_5_lang_viewport_color_scheme_landmarks_and_one_h1", async () => {
    for (const name of NAMES) {
      for (const page of htmlPages(name)) {
        const f = await inspect(readFileSync(join(TEMPLATES, name, page), "utf-8"));
        const where = `${name}/${page}`;
        expect({ where, lang: !!f.lang?.trim() }).toEqual({ where, lang: true });
        expect({ where, viewport: f.viewport }).toEqual({ where, viewport: true });
        expect({ where, colorScheme: f.colorScheme }).toEqual({ where, colorScheme: "light dark" });
        expect({ where, main: f.counts.main, h1: f.counts.h1 }).toEqual({ where, main: 1, h1: 1 });
        expect({ where, header: f.counts.header >= 1, footer: f.counts.footer >= 1 }).toEqual({ where, header: true, footer: true });
      }
    }
  });

  test("test_DW_1_5_every_svg_is_hidden_or_named", async () => {
    for (const name of NAMES) {
      for (const page of htmlPages(name)) {
        const f = await inspect(readFileSync(join(TEMPLATES, name, page), "utf-8"));
        const unlabelled = f.svgs.filter((s) => !s.hidden && !s.named).length;
        expect({ where: `${name}/${page}`, svgs: f.svgs.length > 0, unlabelled }).toEqual({ where: `${name}/${page}`, svgs: true, unlabelled: 0 });
      }
    }
  });

  test("test_DW_1_5_links_are_relative_and_resolve_inside_the_folder", async () => {
    const broken: string[] = [];
    for (const name of NAMES) {
      const root = join(TEMPLATES, name);
      const idsByPage = new Map<string, Set<string>>();
      for (const page of htmlPages(name)) idsByPage.set(page, (await inspect(readFileSync(join(root, page), "utf-8"))).ids);
      for (const page of htmlPages(name)) {
        const { refs } = await inspect(readFileSync(join(root, page), "utf-8"));
        for (const ref of refs) {
          if (ref === "#") continue;
          const where = `${name}/${page} -> ${ref}`;
          if (!isRelativePath(ref)) {
            broken.push(`${where} (not a relative path)`);
            continue;
          }
          const [pathPart = "", fragment] = ref.split("#");
          const target = pathPart ? resolve(root, dirname(page), pathPart.split("?")[0]!) : join(root, page);
          if (target !== root && !target.startsWith(root + sep)) {
            broken.push(`${where} (escapes the folder)`);
            continue;
          }
          if (!existsSync(target) || !statSync(target).isFile()) {
            broken.push(`${where} (no such file)`);
            continue;
          }
          const targetPage = relative(root, target);
          if (fragment && !idsByPage.get(targetPage)?.has(fragment)) broken.push(`${where} (no #${fragment} in ${targetPage})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("docs_has_two_pages_that_link_to_each_other", async () => {
    const root = join(TEMPLATES, "docs");
    expect(htmlPages("docs").sort()).toEqual(["guide.html", "index.html"]);
    const index = await inspect(readFileSync(join(root, "index.html"), "utf-8"));
    const guide = await inspect(readFileSync(join(root, "guide.html"), "utf-8"));
    expect(index.refs).toContain("guide.html");
    expect(guide.refs).toContain("index.html");
  });

  test("relative_path_rule_rejects_root_absolute_and_schemes", () => {
    expect(isRelativePath("styles.css")).toBe(true);
    expect(isRelativePath("guide.html#options")).toBe(true);
    expect(isRelativePath("/styles.css")).toBe(false);
    expect(isRelativePath("mailto:a@b.c")).toBe(false);
    expect(isRelativePath("data:image/png;base64,AA")).toBe(false);
  });
});
