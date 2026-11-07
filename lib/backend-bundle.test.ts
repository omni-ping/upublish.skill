/**
 * DW-6.1: local bundling for publish_backend: success, the 1 MB cap (caught
 * locally, boundary +1 byte), compiler errors surfaced, missing entry, no
 * default export, inline code, Node-built-in warning.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleBackend } from "./backend-bundle.ts";
import { BACKEND_LIMITS } from "./backend-shape.ts";

const dir = mkdtempSync(join(tmpdir(), "backend-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string): string => {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe("DW-6.1: bundleBackend", () => {
  it("bundles a TypeScript entry with a relative import into one ES module", async () => {
    write("lib/greet.ts", "export const greet = (n: string): string => `hi ${n}`;");
    write("ok.ts", `import { greet } from "./lib/greet"; export default { async fetch(): Promise<Response> { return Response.json({ m: greet("x") }); } };`);
    const r = await bundleBackend({ entry: "ok.ts" }, { cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toContain("hi ");
    expect(r.source).not.toMatch(/^import /m);
    expect(r.bytes).toBe(new TextEncoder().encode(r.source).length);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts an absolute entry path", async () => {
    const p = write("abs.js", "export default { fetch() { return new Response('x'); } };");
    expect((await bundleBackend({ entry: p })).ok).toBe(true);
  });

  it("bundles inline code from a virtual entry without touching disk", async () => {
    const r = await bundleBackend({ code: "export default { fetch(): Response { return Response.json({ inline: true }); } };" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toContain("inline");
  });

  it("an empty inline code is rejected", async () => {
    expect(await bundleBackend({ code: "   \n" })).toEqual({ ok: false, kind: "empty", message: "The inline code is empty." });
  });

  it("a missing entry file is reported with the resolved path", async () => {
    const r = await bundleBackend({ entry: "nope.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "entry_not_found" });
    if (!r.ok) expect(r.message).toContain(join(dir, "nope.ts"));
  });

  it("a directory is not an entry file", async () => {
    expect(await bundleBackend({ entry: "lib" }, { cwd: dir })).toMatchObject({ ok: false, kind: "entry_not_found" });
  });

  it("surfaces compiler errors with file:line:column (syntax error)", async () => {
    write("syntax.ts", "export default {{{\n");
    const r = await bundleBackend({ entry: "syntax.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "compile" });
    if (!r.ok) {
      expect(r.message).toMatch(/^Bundling failed:\n/);
      expect(r.message).toContain("syntax.ts");
      expect(r.message).toMatch(/:\d+:\d+: /);
    }
  });

  it("surfaces an unresolvable import", async () => {
    write("missing-import.ts", `import x from "./does-not-exist"; export default { fetch() { return x; } };`);
    const r = await bundleBackend({ entry: "missing-import.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "compile" });
    if (!r.ok) expect(r.message).toContain("does-not-exist");
  });

  it("caps compiler messages at ten and says how many more", async () => {
    const bad = Array.from({ length: 14 }, (_, i) => `import a${i} from "./gone${i}";`).join("\n");
    const use = Array.from({ length: 14 }, (_, i) => `a${i}`).join(", ");
    write("many.ts", `${bad}\nexport default { fetch() { return [${use}]; } };`);
    const r = await bundleBackend({ entry: "many.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "compile" });
    if (!r.ok) expect(r.message).toMatch(/…and \d+ more$/);
  });

  it("Node built-in imports are refused and named (nodejs_compat is off; the bundler would stub them silently)", async () => {
    write("node.ts", `import fs from "node:fs"; import path from "path"; import { x } from "fs/promises"; export default { fetch() { return new Response(String([fs, path, x])); } };`);
    const r = await bundleBackend({ entry: "node.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "node_builtin" });
    if (!r.ok) for (const spec of ["node:fs", "path", "fs/promises"]) expect(r.message).toContain(spec);
  });

  it("cloudflare:* imports stay external and are allowed", async () => {
    write("cf.ts", `import { env } from "cloudflare:workers"; export default { fetch() { return new Response(String(env)); } };`);
    const r = await bundleBackend({ entry: "cf.ts" }, { cwd: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toContain("cloudflare:workers");
  });

  it("an unexpected bundler exception without messages becomes a compile failure", async () => {
    // A virtual-entry name the bundler cannot parse as a path forces the catch path to render something readable.
    const real = Bun.build;
    (Bun as { build: unknown }).build = async () => { throw new Error("boom"); };
    try {
      expect(await bundleBackend({ code: "export default {}" })).toEqual({ ok: false, kind: "compile", message: "Bundling failed:\nboom" });
    } finally {
      (Bun as { build: unknown }).build = real;
    }
  });

  it("a build without an entry-point output or without details is still reported as a compile failure", async () => {
    const real = Bun.build;
    (Bun as { build: unknown }).build = async () => ({ success: true, outputs: [], logs: [] });
    try {
      expect(await bundleBackend({ code: "export default {}" })).toMatchObject({ ok: false, kind: "compile" });
    } finally {
      (Bun as { build: unknown }).build = real;
    }
    (Bun as { build: unknown }).build = async () => ({ success: false, outputs: [], logs: [] });
    try {
      const r = await bundleBackend({ code: "export default {}" });
      expect(r).toMatchObject({ ok: false, kind: "compile" });
      if (!r.ok) expect(r.message).toContain("no details");
    } finally {
      (Bun as { build: unknown }).build = real;
    }
  });

  it("a module with no default export is refused before upload", async () => {
    write("nodefault.ts", "export const fetch = () => new Response('x');");
    const r = await bundleBackend({ entry: "nodefault.ts" }, { cwd: dir });
    expect(r).toMatchObject({ ok: false, kind: "no_default_export" });
    if (!r.ok) expect(r.message).toContain("export default");
  });

  describe("the 1 MB cap is measured in UTF-8 bytes of the OUTPUT and enforced locally", () => {
    // `export default "<padding>"` output is `var e_default = "<padding>";` + export + a path comment: measure then probe the edge.
    const shell = (pad: number): string => `export default { fetch() { return new Response("${"a".repeat(pad)}"); } };`;

    it("one byte over the limit is refused with the size in the message", async () => {
      const probe = await bundleBackend({ code: shell(1000) });
      if (!probe.ok) throw new Error("probe failed");
      const overhead = probe.bytes - 1000;
      const limit = BACKEND_LIMITS.bundleBytes;
      const over = await bundleBackend({ code: shell(limit - overhead + 1) });
      expect(over).toMatchObject({ ok: false, kind: "too_large" });
      if (!over.ok) expect(over.message).toContain(`${limit + 1} bytes`);
      const at = await bundleBackend({ code: shell(limit - overhead) });
      expect(at.ok).toBe(true);
      if (at.ok) expect(at.bytes).toBe(limit);
    });

    it("multi-byte characters count as bytes, not characters", async () => {
      // 2-byte characters: 600k of them are 1.2 MB but only 600k characters.
      const r = await bundleBackend({ code: `export default { fetch() { return new Response("${"é".repeat(600_000)}"); } };` });
      expect(r).toMatchObject({ ok: false, kind: "too_large" });
    });
  });
});

// ─── Sandbox: the bundler must not execute attacker code or read files outside the project ─────────

describe("DW-6.1: bundling is sandboxed (macros, file reads, URL imports)", () => {
  const sbx = mkdtempSync(join(tmpdir(), "backend-sandbox-"));
  afterAll(() => rmSync(sbx, { recursive: true, force: true }));
  const file = (rel: string, body: string): string => {
    const p = join(sbx, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const HANDLER = "export default { fetch() { return new Response(String(x)); } };";

  // project/ has a package.json (its root); outside/ is beside it.
  file("project/package.json", '{"name":"p"}');
  file("outside/secret.ts", 'export const x = "TOP-SECRET-OUTSIDE";');
  file("outside/secret.txt", "TOP-SECRET-TEXT");

  it("test_DW_6_1_a_macro_import_fails_the_bundle_and_executes_nothing", async () => {
    const sentinel = join(sbx, "SENTINEL-macro-ran");
    file("project/macro.ts", `import { writeFileSync } from "node:fs"; export function x() { writeFileSync(${JSON.stringify(sentinel)}, "pwned"); return "v"; }`);
    const entry = file("project/macro-entry.ts", `import { x } from "./macro" with { type: "macro" }; export default { fetch() { return new Response(x()); } };`);
    const r = await bundleBackend({ entry });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Macros are disabled");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("a macro import in inline code is refused too, and runs nothing", async () => {
    const sentinel = join(sbx, "SENTINEL-inline-macro");
    file("project/inline-macro.ts", `import { writeFileSync } from "node:fs"; export function x() { writeFileSync(${JSON.stringify(sentinel)}, "pwned"); return "v"; }`);
    const r = await bundleBackend({ code: `import { x } from "${join(sbx, "project/inline-macro.ts")}" with { type: "macro" }; export default { fetch() { return new Response(x()); } };` });
    expect(r.ok).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("test_DW_6_1_type_text_of_an_absolute_file_is_refused (entry mode and inline mode)", async () => {
    const code = `import t from "/etc/hosts" with { type: "text" }; export default { fetch() { return new Response(t); } };`;
    const entry = file("project/text-entry.ts", code);
    for (const r of [await bundleBackend({ entry }), await bundleBackend({ code })]) {
      expect(r).toMatchObject({ ok: false, kind: "forbidden_import" });
      if (!r.ok) expect(r.message).toMatch(/hosts/);
    }
  });

  it("test_DW_6_1_a_relative_escape_out_of_the_project_is_refused", async () => {
    const entry = file("project/src/escape.ts", `import { x } from "../../outside/secret"; ${HANDLER}`);
    const r = await bundleBackend({ entry });
    expect(r).toMatchObject({ ok: false, kind: "forbidden_import" });
    if (!r.ok) expect(r.message).not.toContain("TOP-SECRET");
    // The same with ?raw-style text attribute on a non-code file
    const text = file("project/src/escape-text.ts", `import t from "../../outside/secret.txt" with { type: "text" }; export default { fetch() { return new Response(t); } };`);
    expect(await bundleBackend({ entry: text })).toMatchObject({ ok: false, kind: "forbidden_import" });
  });

  it("without a package.json the root is the entry's own directory, so even a sibling directory is out", async () => {
    file("loose/lib/a.ts", 'export const x = 1;');
    file("loose/other/b.ts", 'export const y = 2;');
    const entry = file("loose/lib/entry.ts", `import { x } from "./a"; import { y } from "../other/b"; export default { fetch() { return new Response(String(x + y)); } };`);
    expect(await bundleBackend({ entry })).toMatchObject({ ok: false, kind: "forbidden_import" });
  });

  it("test_DW_6_1_a_symlink_that_resolves_outside_the_project_is_refused", async () => {
    const link = join(sbx, "project/linked.ts");
    symlinkSync(join(sbx, "outside/secret.ts"), link);
    const entry = file("project/link-entry.ts", `import { x } from "./linked"; ${HANDLER}`);
    const r = await bundleBackend({ entry });
    expect(r).toMatchObject({ ok: false, kind: "forbidden_import" });
    if (!r.ok) expect(r.message).not.toContain("TOP-SECRET");
  });

  it("a symlinked directory pointing outside is refused as well", async () => {
    symlinkSync(join(sbx, "outside"), join(sbx, "project/dirlink"));
    const entry = file("project/dirlink-entry.ts", `import { x } from "./dirlink/secret"; ${HANDLER}`);
    expect(await bundleBackend({ entry })).toMatchObject({ ok: false, kind: "forbidden_import" });
  });

  it("test_DW_6_1_inline_code_may_import_nothing_from_disk_or_network", async () => {
    const abs = join(sbx, "outside/secret.ts");
    const bad: Array<[string, string]> = [
      ["absolute path", `import { x } from "${abs}"; ${HANDLER}`],
      ["relative path", `import { x } from "./secret"; ${HANDLER}`],
      ["parent path", `import { x } from "../outside/secret"; ${HANDLER}`],
      ["bare package", `import x from "left-pad"; ${HANDLER}`],
      ["file: URL", `import x from "file://${abs}"; ${HANDLER}`],
      ["data: URL", `import x from "data:text/javascript,export default 1"; ${HANDLER}`],
      ["https: URL", `import x from "https://example.com/x.js"; ${HANDLER}`],
      ["dynamic import of a path", `export default { async fetch() { return new Response(String(await import("${abs}"))); } };`],
    ];
    for (const [label, code] of bad) {
      const r = await bundleBackend({ code });
      expect(r, label).toMatchObject({ ok: false, kind: "forbidden_import" });
      if (!r.ok) expect(r.message, label).not.toContain("TOP-SECRET");
    }
  });

  it("entry mode refuses URL imports too", async () => {
    for (const spec of ["file:///etc/hosts", "data:text/javascript,export default 1", "https://example.com/x.js"]) {
      const entry = file("project/url-entry.ts", `import x from "${spec}"; ${HANDLER}`);
      expect(await bundleBackend({ entry }), spec).toMatchObject({ ok: false, kind: "forbidden_import" });
    }
  });

  it("what is still allowed: cloudflare:* in inline code, and node built-ins keep their own message", async () => {
    expect((await bundleBackend({ code: `import { env } from "cloudflare:workers"; export default { fetch() { return new Response(String(env)); } };` })).ok).toBe(true);
    expect(await bundleBackend({ code: `import fs from "node:fs"; export default { fetch() { return new Response(String(fs)); } };` })).toMatchObject({ ok: false, kind: "node_builtin" });
  });

  it("test_DW_6_1_a_normal_TypeScript_project_with_an_npm_package_still_bundles_in_entry_mode", async () => {
    file("app/package.json", '{"name":"app"}');
    file("app/node_modules/tiny-pkg/package.json", '{"name":"tiny-pkg","version":"1.0.0","main":"index.js"}');
    file("app/node_modules/tiny-pkg/index.js", 'export const shout = (s) => s.toUpperCase() + "!";');
    file("app/src/util.ts", "export const greet = (n: string): string => `hi ${n}`;");
    file("app/data.json", '{"k":"json-value"}');
    const entry = file("app/src/entry.ts", `import { shout } from "tiny-pkg"; import { greet } from "./util"; import data from "../data.json";
export default { async fetch(): Promise<Response> { return Response.json({ m: shout(greet("x")), d: data.k }); } };`);
    const r = await bundleBackend({ entry });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toContain("toUpperCase");
      expect(r.source).toContain("json-value");
    }
  });

  it("an absolute import of a file INSIDE the project is fine", async () => {
    file("app2/package.json", '{"name":"app2"}');
    const inside = file("app2/lib/in.ts", "export const x = 1;");
    const entry = file("app2/entry.ts", `import { x } from "${inside}"; ${HANDLER}`);
    expect((await bundleBackend({ entry })).ok).toBe(true);
  });
});
