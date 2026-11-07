/**
 * Local bundling for `publish_backend`.
 *
 * The server accepts ONE already-bundled ES module as text (contract section 9),
 * so the skill bundles the user's entry file (or inline `code`) with
 * `Bun.build`, using exactly the options Phase 1 spike (e) verified against the
 * Workers upload API. All failures an author can fix locally are caught HERE,
 * before any request: a missing entry, compiler errors (surfaced verbatim with
 * file:line:column), Node built-in imports, a bundle over 1 MB, a module with no
 * default export.
 *
 * Failures are values (`ok: false`), never throws, so the caller renders them
 * as an actionable result.
 *
 * SANDBOX. The bundler runs on whatever host runs the skill, and on the hosted
 * /mcp router that host is our API server while the code is attacker-supplied.
 * `Bun.build` can execute code at build time (macros) and read any file an
 * import names (`with { type: "text" }` and friends), so the build is confined:
 *  - macros are disabled (`macros: false`; a macro import fails the build and
 *    runs nothing);
 *  - inline `code` may import NOTHING from the filesystem or network: only
 *    `cloudflare:*` is allowed, node built-ins are reported;
 *  - an entry file may import only files whose REAL path (symlinks resolved) is
 *    inside its project root (the nearest ancestor with a package.json, else
 *    the entry's directory); URL imports (`file:`, `data:`, `http(s):`) are
 *    refused. Every loaded file is checked again at load time, so a tsconfig
 *    path alias or a symlink cannot reach outside either.
 * Entry mode is for a local stdio server only: `runPublishBackend` refuses it
 * unless the caller opted in.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { BACKEND_LIMITS } from "./backend-shape.ts";
import { safeText } from "./site-data-text.ts";

export type BundleInput = { entry: string; code?: undefined } | { code: string; entry?: undefined };

export type BundleResult =
  | { ok: true; source: string; bytes: number; sha256: string }
  | { ok: false; kind: "entry_not_found" | "compile" | "node_builtin" | "forbidden_import" | "too_large" | "no_default_export" | "empty"; message: string };

/** Compiler messages shown to the author; more are summarized. */
const MAX_COMPILER_MESSAGES = 10;

/** Virtual entry used for inline `code` (nothing is written to disk). */
const INLINE_ENTRY = "/__upublish_inline__/entry.ts";

/** `export default ...` or the bundler's `export { x as default }` form. */
const DEFAULT_EXPORT_RE = /\bexport\s+default\b|\bas\s+default\b/;

/**
 * Import specifiers that name a Node built-in (`node:fs`, `fs`, `fs/promises`, ...). The backend runtime has no
 * `nodejs_compat` (Decided #15), and `Bun.build` for the browser would otherwise replace them with an empty stub
 * that fails later at runtime, so they are intercepted at resolve time and reported.
 */
const NODE_BUILTIN_RE = new RegExp(
  `^(node:.+|${builtinModules.filter((m) => !m.startsWith("_")).map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`,
);

/** A URL-style specifier (`file:`, `data:`, `https:`, `bun:`, ...). `cloudflare:*` and Node built-ins are handled before this. */
const URL_SPECIFIER_RE = /^[a-z][a-z0-9+.-]*:/i;

/** The nearest ancestor directory of the (real) entry that holds a package.json, else the entry's own directory. */
function projectRoot(realEntry: string): string {
  for (let dir = dirname(realEntry), up = dirname(dir); ; dir = up, up = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (up === dir) return dirname(realEntry);
  }
}

const isInside = (root: string, file: string): boolean => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);

const sha256Hex = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

interface CompilerMessage { message: string; position?: { file?: string; line?: number; column?: number } | null }

function describe(m: CompilerMessage): string {
  const p = m.position;
  const where = p?.file ? `${p.file}${p.line !== undefined ? `:${p.line}` : ""}${p.column !== undefined ? `:${p.column}` : ""}: ` : "";
  return safeText(`${where}${m.message}`);
}

function compileFailure(messages: CompilerMessage[]): BundleResult {
  const shown = messages.slice(0, MAX_COMPILER_MESSAGES).map(describe);
  const extra = messages.length - shown.length;
  const body = shown.length > 0 ? shown.join("\n") : "the bundler reported no details";
  return { ok: false, kind: "compile", message: `Bundling failed:\n${body}${extra > 0 ? `\n…and ${extra} more` : ""}` };
}

function forbiddenResult(forbidden: ReadonlySet<string>): BundleResult {
  return {
    ok: false, kind: "forbidden_import",
    message: `The code imports something outside what a backend bundle may read: ${[...forbidden].map(safeText).join("; ")}. Imports must stay inside the project folder (or be npm packages installed there); macros, URLs and absolute paths are refused.`,
  };
}

/**
 * Bundles a backend entry file (relative paths resolve against `cwd`) or inline code
 * into the single ES module the deploy route takes.
 */
export async function bundleBackend(input: BundleInput, opts: { cwd?: string } = {}): Promise<BundleResult> {
  let entrypoint: string;
  let files: Record<string, string> | undefined;
  /** Real directory entry-mode files must live under; null in inline mode (no filesystem imports at all). */
  let root: string | null = null;
  let inlineCode = "";
  if (input.code !== undefined) {
    if (input.code.trim() === "") return { ok: false, kind: "empty", message: "The inline code is empty." };
    entrypoint = INLINE_ENTRY;
    files = { [INLINE_ENTRY]: input.code };
    inlineCode = input.code;
  } else {
    entrypoint = resolve(opts.cwd ?? process.cwd(), input.entry);
    let isFile = false;
    try {
      isFile = statSync(entrypoint).isFile();
    } catch {
      // handled below
    }
    if (!isFile) return { ok: false, kind: "entry_not_found", message: `Entry file not found: ${safeText(entrypoint)}` };
    root = projectRoot(realpathSync(entrypoint));
  }

  const nodeBuiltins = new Set<string>();
  const forbidden = new Set<string>();
  /** Records a violation and aborts that resolve / load (the build then fails; the set explains why). */
  const forbid = (what: string): never => {
    forbidden.add(what);
    throw new Error(`forbidden import: ${what}`);
  };
  let build: Awaited<ReturnType<typeof Bun.build>>;
  try {
    build = await Bun.build({
      entrypoints: [entrypoint],
      ...(files ? { files } : {}),
      target: "browser",
      format: "esm",
      external: ["cloudflare:*"],
      conditions: ["workerd", "worker", "browser"],
      throw: false,
      // Not in Bun's BuildConfig typings (as of 1.4.4) but honoured: a macro import then fails with "Macros are disabled".
      ...({ macros: false } as object),
      plugins: [{
        name: "sandbox",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            // The virtual inline entry must be claimed here: with a plugin present Bun no longer finds it in `files`.
            if (a.kind === "entry-point-build") return root === null ? { path: a.path } : undefined;
            if (a.path.startsWith("cloudflare:")) return undefined;
            if (NODE_BUILTIN_RE.test(a.path)) return (nodeBuiltins.add(a.path), { path: a.path, external: true });
            if (URL_SPECIFIER_RE.test(a.path)) forbid(`${a.path} (URL imports are not allowed)`);
            // Inline code has no project: it may import nothing from disk (relative, absolute or bare).
            if (root === null) forbid(`${a.path} (inline code cannot import files or packages; bundle a file with 'entry' instead)`);
            return undefined; // entry mode: allowed here, confirmed by the real-path check at load time
          });
          b.onLoad({ filter: /.*/ }, (a) => {
            // Inline mode: the only file that may load is the virtual entry, served from memory here (a plugin that
            // handles loading takes over from the `files` map).
            if (root === null) {
              if (a.path !== INLINE_ENTRY) forbid(`${a.path} (inline code cannot read files)`);
              return { contents: inlineCode, loader: "ts" };
            }
            if (!isInside(root, realpathSync(a.path))) forbid(`${a.path} (outside the project folder)`);
            return undefined;
          });
        },
      }],
    });
  } catch (err) {
    if (forbidden.size > 0) return forbiddenResult(forbidden);
    // Syntax errors reject with an AggregateError of BuildMessages even with throw:false on some inputs.
    const errors = (err as { errors?: CompilerMessage[] }).errors;
    return compileFailure(errors ?? [{ message: err instanceof Error ? err.message : String(err) }]);
  }
  if (forbidden.size > 0) return forbiddenResult(forbidden);
  if (!build.success) return compileFailure(build.logs.filter((l) => l.level === "error"));
  if (nodeBuiltins.size > 0) {
    return {
      ok: false, kind: "node_builtin",
      message: `The code imports Node built-ins (${[...nodeBuiltins].map(safeText).join(", ")}), which a backend does not have (no nodejs_compat). Use Web APIs instead: fetch, crypto.subtle, URL, TextEncoder.`,
    };
  }

  const output = build.outputs.find((o) => o.kind === "entry-point");
  if (!output) return compileFailure([{ message: "the bundler produced no entry output" }]);
  const source = await output.text();

  const bytes = new TextEncoder().encode(source).length;
  if (bytes > BACKEND_LIMITS.bundleBytes) {
    return { ok: false, kind: "too_large", message: `The bundle is ${bytes} bytes; the limit is ${BACKEND_LIMITS.bundleBytes} (1 MB). Nothing was uploaded. Drop large dependencies or move that work elsewhere.` };
  }
  if (!DEFAULT_EXPORT_RE.test(source)) {
    return { ok: false, kind: "no_default_export", message: "The module has no default export. Export an object with a fetch handler: `export default { async fetch(request, env, ctx) { ... } }`." };
  }

  return { ok: true, source, bytes, sha256: sha256Hex(source) };
}
