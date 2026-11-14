/**
 * Starter templates: list the bundled templates and copy one into a local folder.
 *
 * Templates live at `templates/<name>/` in the package, each described by a manifest at `templates/<name>.json`
 * (outside the copied folder, so it is never copied or published). The agent fills in the `[[...]]` placeholders
 * and publishes the folder with the normal `publish` tool.
 *
 * `createFromTemplate` writes to the user's filesystem from a caller-supplied path, so it is all or nothing:
 *   - the target, and every existing ancestor, may be a symlink only if it resolves inside its own parent
 *     (realpath compared with realpath, so macOS `/tmp` → `/private/tmp` is fine and `./out` → `/etc` is not);
 *   - a non-empty target is refused unless `allowNonEmpty`, and even then any name clash (case-insensitive,
 *     dangling symlinks included) is refused before anything is written;
 *   - every file is created with an exclusive open (`wx`), and on ANY error exactly the files and folders this
 *     call created are removed, in reverse order. Pre-existing entries are never touched.
 * Residual risk: a symlink swapped in by another process between the checks and the writes. The real path is
 * re-checked after the folders are created, which narrows that window but cannot close it without openat().
 *
 * Both functions return structured results and never throw for expected failures.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The filesystem calls this module makes; injectable so tests can fail any one of them. */
export type TemplateFs = Pick<
  typeof nodeFs,
  | "readdirSync"
  | "readFileSync"
  | "lstatSync"
  | "statSync"
  | "realpathSync"
  | "mkdirSync"
  | "openSync"
  | "writeSync"
  | "closeSync"
  | "unlinkSync"
  | "rmdirSync"
>;

export interface TemplateDeps {
  /** The folder holding `<name>/` and `<name>.json`. Defaults to the package's `templates/`. */
  root?: string;
  /** Base for a relative `directory`. Defaults to `process.cwd()`. */
  cwd?: string;
  fs?: TemplateFs;
}

export interface TemplatePlaceholder {
  token: string;
  hint: string;
}

export interface TemplateInfo {
  name: string;
  title: string;
  description: string;
}

/** A link whose href is `#` until the user's address goes in; `hint` says what belongs there. */
export interface PlaceholderHref {
  file: string;
  hint: string;
}

export type TemplateErrorCode =
  | "unknown_template"
  | "missing_directory"
  | "not_a_directory"
  | "not_empty"
  | "clash"
  | "symlink_escape"
  | "bad_template"
  | "io_error";

export type TemplateFailure = { success: false; code: TemplateErrorCode; error: string };

export type ListTemplatesResult = { success: true; templates: TemplateInfo[] } | TemplateFailure;

export interface CreateFromTemplateArgs {
  name?: string;
  directory?: string;
  allowNonEmpty?: boolean;
}

export type CreateFromTemplateResult =
  | {
      success: true;
      name: string;
      /** The absolute target path, as the caller named it (resolved against cwd). */
      directory: string;
      /** Where the files really are; differs from `directory` only through an allowed symlink. */
      realDirectory: string;
      /** Files written, relative to the target, `/`-separated. */
      files: string[];
      placeholders: TemplatePlaceholder[];
      placeholderHrefs: PlaceholderHref[];
    }
  | TemplateFailure;

/** The package's `templates/` folder: one level above this file in source (`lib/`) and in the bundle (`dist/`). */
export function templatesRoot(fromUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../templates/", fromUrl)).replace(/[\\/]$/, "");
}

const fail = (code: TemplateErrorCode, error: string): TemplateFailure => ({ success: false, code, error });
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;
/** APFS and NTFS compare names case- and normalization-insensitively. */
const fold = (name: string): string => name.normalize("NFC").toLowerCase();

interface Manifest extends TemplateInfo {
  placeholders: TemplatePlaceholder[];
}

function parseManifest(raw: string, expectedName: string): Manifest | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null; // malformed JSON: the caller reports the manifest as invalid
  }
  const o = m as Partial<Manifest> | null;
  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!o || o.name !== expectedName || !isStr(o.title) || !isStr(o.description) || !Array.isArray(o.placeholders)) return null;
  if (!o.placeholders.every((p) => p && isStr(p.token) && typeof p.hint === "string")) return null;
  return { name: o.name, title: o.title, description: o.description, placeholders: o.placeholders };
}

function readCatalog(root: string, fs: TemplateFs): { success: true; manifests: Manifest[] } | TemplateFailure {
  let entries: string[];
  try {
    entries = fs.readdirSync(root).sort();
  } catch (err) {
    return fail("bad_template", `Cannot read the templates folder ${root}: ${errMessage(err)}`);
  }
  const manifests: Manifest[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    try {
      if (!fs.lstatSync(path.join(root, name)).isDirectory()) continue;
    } catch {
      continue; // a manifest with no folder beside it is not a template
    }
    const manifest = parseManifest(String(fs.readFileSync(path.join(root, file), "utf8")), name);
    if (!manifest) return fail("bad_template", `The template manifest ${file} is invalid.`);
    manifests.push(manifest);
  }
  return { success: true, manifests };
}

/** Lists every bundled template with its title and description. */
export function listTemplates(deps: TemplateDeps = {}): ListTemplatesResult {
  const fs = deps.fs ?? nodeFs;
  try {
    const catalog = readCatalog(deps.root ?? templatesRoot(), fs);
    if (!catalog.success) return catalog;
    return { success: true, templates: catalog.manifests.map(({ name, title, description }) => ({ name, title, description })) };
  } catch (err) {
    return fail("bad_template", `Cannot read the templates: ${errMessage(err)}`);
  }
}

interface SourceEntry {
  rel: string; // `/`-separated, relative to the template folder
  dir: boolean;
  bytes?: Buffer;
}

/** Walks a template folder, parents before children. Symlinks in a template are refused, not followed. */
function readTemplateFiles(dir: string, fs: TemplateFs, rel = ""): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const full = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) out.push({ rel: childRel, dir: true }, ...readTemplateFiles(full, fs, childRel));
    else if (st.isFile()) out.push({ rel: childRel, dir: false, bytes: Buffer.from(fs.readFileSync(full)) });
    else throw new Error(`template entry ${childRel} is not a regular file or folder`);
  }
  return out;
}

/** True when `child` is strictly inside `parent` (both real paths). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

type Resolved = { success: true; realBase: string; missing: string[]; targetExists: boolean } | TemplateFailure;

/**
 * Walks `abs` from the filesystem root. Every existing component that is a symlink must resolve inside its own
 * parent's real path. Returns the real path of the deepest existing component and the names still to create.
 */
function resolveTarget(abs: string, fs: TemplateFs): Resolved {
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]!);
    let st: nodeFs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      if (errCode(err) === "ENOENT") return { success: true, realBase: fs.realpathSync(current), missing: parts.slice(i), targetExists: false };
      if (errCode(err) === "ENOTDIR") return fail("not_a_directory", `${current} is a file, not a folder.`);
      throw err;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = fs.realpathSync(next);
      } catch {
        return fail("symlink_escape", `${next} is a symlink that points nowhere. Choose another folder.`);
      }
      if (!isInside(fs.realpathSync(current), real)) {
        return fail(
          "symlink_escape",
          `${next} is a symlink to ${real}, outside ${current}. Refusing to write through it; pass the real folder instead if that is where you want the site.`,
        );
      }
    }
    if (!fs.statSync(next).isDirectory()) {
      return fail("not_a_directory", `${next} is a file, not a folder. Choose a folder (new or empty) for the template.`);
    }
    current = next;
  }
  return { success: true, realBase: fs.realpathSync(current), missing: [], targetExists: true };
}

/** Names already in each pre-existing target folder, keyed by `/`-relative folder path ("" = the target). */
function findClashes(realTarget: string, entries: SourceEntry[], fs: TemplateFs): { clashes: string[]; existingDirs: Set<string> } {
  const listings = new Map<string, string[]>([["", fs.readdirSync(realTarget)]]);
  const existingDirs = new Set<string>();
  const clashes: string[] = [];
  for (const e of entries) {
    const slash = e.rel.lastIndexOf("/");
    const parentRel = slash === -1 ? "" : e.rel.slice(0, slash);
    const listing = listings.get(parentRel);
    if (!listing) continue; // the parent is a folder this call will create: nothing can clash inside it
    const base = e.rel.slice(slash + 1);
    const match = listing.find((n) => fold(n) === fold(base));
    if (match === undefined) continue;
    const existing = path.join(realTarget, parentRel, match);
    // An exact-name real folder is merged into; anything else (file, symlink, dangling link, case variant) clashes.
    if (e.dir && match === base && fs.lstatSync(existing).isDirectory()) {
      existingDirs.add(e.rel);
      listings.set(e.rel, fs.readdirSync(existing));
    } else {
      clashes.push(parentRel ? `${parentRel}/${match}` : match);
    }
  }
  return { clashes, existingDirs };
}

const HREF_HINT = /data-placeholder-href="([^"]*)"/g;

/**
 * Copies `templates/<name>/` into `directory`, all or nothing. See the module comment for the safety rules.
 */
export function createFromTemplate(args: CreateFromTemplateArgs, deps: TemplateDeps = {}): CreateFromTemplateResult {
  const fs = deps.fs ?? nodeFs;
  const root = deps.root ?? templatesRoot();
  const { name, directory, allowNonEmpty = false } = args;

  let catalog: ReturnType<typeof readCatalog>;
  try {
    catalog = readCatalog(root, fs);
  } catch (err) {
    return fail("bad_template", `Cannot read the templates: ${errMessage(err)}`);
  }
  if (!catalog.success) return catalog;
  const valid = catalog.manifests.map((m) => m.name);
  // Matched against the catalog, never joined raw, so a name like "../x" cannot reach outside the templates folder.
  const manifest = catalog.manifests.find((m) => m.name === name);
  if (!manifest) {
    return fail("unknown_template", `${name ? `There is no template named "${name}".` : "Name a template."} Choose one of: ${valid.join(", ")}.`);
  }
  if (typeof directory !== "string" || directory.trim() === "") {
    return fail("missing_directory", "Give a directory to create the site in (a new or empty folder, e.g. ./my-site).");
  }
  if (directory.includes("\0")) return fail("missing_directory", "The directory path contains a NUL character.");

  let entries: SourceEntry[];
  try {
    entries = readTemplateFiles(path.join(root, manifest.name), fs);
  } catch (err) {
    return fail("bad_template", `Cannot read the "${manifest.name}" template: ${errMessage(err)}`);
  }

  const abs = path.resolve(deps.cwd ?? process.cwd(), directory);
  let realBase: string;
  let realTarget: string;
  let missing: string[];
  let existingDirs = new Set<string>();
  try {
    const resolved = resolveTarget(abs, fs);
    if (!resolved.success) return resolved;
    realBase = resolved.realBase;
    realTarget = path.join(realBase, ...resolved.missing);
    missing = resolved.missing;
    if (resolved.targetExists) {
      const present = fs.readdirSync(realTarget);
      if (present.length > 0 && !allowNonEmpty) {
        return fail(
          "not_empty",
          `${abs} is not empty (${present.length} entr${present.length === 1 ? "y" : "ies"}). Choose a new or empty folder, or pass allow_non_empty: true to add the template beside what is there.`,
        );
      }
      const check = findClashes(realTarget, entries, fs);
      if (check.clashes.length > 0) {
        return fail("clash", `Nothing was written: ${abs} already has ${check.clashes.join(", ")}, which the template would overwrite.`);
      }
      existingDirs = check.existingDirs;
    }
  } catch (err) {
    return fail("io_error", `Cannot check ${abs}: ${errMessage(err)}`);
  }

  // Everything this call creates, in creation order, so a failure removes exactly these and nothing else.
  const created: Array<{ path: string; dir: boolean }> = [];
  try {
    let dir = realBase; // the deepest existing folder
    for (const part of missing) {
      dir = path.join(dir, part);
      fs.mkdirSync(dir); // not recursive: EEXIST from a racing creator fails the call
      created.push({ path: dir, dir: true });
    }
    if (fs.realpathSync(realTarget) !== realTarget) throw new Error(`${abs} changed while the template was being created`);
    for (const e of entries) {
      const dest = path.join(realTarget, ...e.rel.split("/"));
      if (e.dir) {
        if (existingDirs.has(e.rel)) continue;
        fs.mkdirSync(dest);
        created.push({ path: dest, dir: true });
        continue;
      }
      const fd = fs.openSync(dest, "wx"); // exclusive: never replaces a file (or follows a link) that appeared
      created.push({ path: dest, dir: false });
      try {
        const bytes = e.bytes!;
        for (let off = 0; off < bytes.length; ) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    const leftovers: string[] = [];
    for (const c of created.reverse()) {
      try {
        if (c.dir) fs.rmdirSync(c.path);
        else fs.unlinkSync(c.path);
      } catch (cleanupErr) {
        leftovers.push(`${c.path} (${errMessage(cleanupErr)})`);
      }
    }
    const tail = leftovers.length
      ? ` Could not remove: ${leftovers.join(", ")}.`
      : " Everything this call created was removed; nothing that was there before was touched.";
    return fail("io_error", `Creating the "${manifest.name}" template in ${abs} failed: ${errMessage(err)}.${tail}`);
  }

  const files = entries.filter((e) => !e.dir);
  const placeholderHrefs = files
    .filter((e) => e.rel.endsWith(".html"))
    .flatMap((e) => [...e.bytes!.toString("utf8").matchAll(HREF_HINT)].map((m) => ({ file: e.rel, hint: m[1]! })));
  return {
    success: true,
    name: manifest.name,
    directory: abs,
    realDirectory: realTarget,
    files: files.map((e) => e.rel),
    placeholders: manifest.placeholders,
    placeholderHrefs,
  };
}
