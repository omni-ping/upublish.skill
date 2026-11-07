/**
 * DW-6.1: local bundling for publish_backend: success, the 1 MB cap (caught
 * locally, boundary +1 byte), compiler errors surfaced, missing entry, no
 * default export, inline code, Node-built-in warning.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
