/**
 * DW-6.2: the starter template (references/backend-template.ts) bundles and
 * behaves: routes on the FORWARDED path, works for an anonymous visitor (no
 * identity needed), verifies Turnstile with a secret, delivers to a webhook held
 * in a secret, limits input, and only ever answers JSON.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import template from "../references/backend-template.ts";
import { bundleBackend } from "../lib/backend-bundle.ts";
import { BACKEND_LIMITS } from "../lib/backend-shape.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ENV = { TURNSTILE_SECRET: "ts-secret", CONTACT_WEBHOOK_URL: "https://hooks.example.com/abc" };
const good = { name: "Ada", email: "ada@example.com", message: "hello", "cf-turnstile-response": "tok" };

interface Outbound { url: string; init?: RequestInit }
/** Stubs outbound fetch: Turnstile answers `turnstile`, the webhook answers `webhookStatus`; `throwOn` simulates a network error. */
function stub(opts: { turnstile?: boolean; turnstileHttp?: number; webhookStatus?: number; throwOn?: "turnstile" | "webhook" } = {}) {
  const calls: Outbound[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (opts.throwOn && String(url).includes(opts.throwOn === "turnstile" ? "turnstile" : "hooks.example")) throw new TypeError("network down");
    if (String(url).includes("turnstile")) {
      return (opts.turnstileHttp ?? 200) === 200 ? Response.json({ success: opts.turnstile ?? true }) : new Response("bad", { status: opts.turnstileHttp });
    }
    return new Response("", { status: opts.webhookStatus ?? 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const req = (path: string, body: string, headers: Record<string, string> = { "Content-Type": "application/json" }, method = "POST") =>
  new Request(`https://ryan.upubli.sh${path}`, { method, body: method === "POST" ? body : undefined, headers });
const post = (form: unknown, path = "/submit") => req(path, JSON.stringify(form));
const run = (r: Request, env: { TURNSTILE_SECRET?: string; CONTACT_WEBHOOK_URL?: string } = ENV) => template.fetch(r, env);

describe("DW-6.2: starter template", () => {
  it("test_DW_6_2_success_for_an_anonymous_visitor_verifies_turnstile_then_calls_the_webhook_once_with_the_fields", async () => {
    const calls = stub();
    const res = await run(post(good));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect((calls[0]!.init!.body as URLSearchParams).get("secret")).toBe("ts-secret");
    expect((calls[0]!.init!.body as URLSearchParams).get("response")).toBe("tok");
    expect(calls[1]!.url).toBe(ENV.CONTACT_WEBHOOK_URL);
    expect(calls[1]!.init!.method).toBe("POST");
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent).toMatchObject({ name: "Ada", email: "ada@example.com", message: "hello" });
    expect(sent.text).toContain("hello");
  });

  it("test_DW_6_2_network_errors_are_502_JSON_never_a_thrown_exception", async () => {
    stub({ throwOn: "turnstile" });
    const a = await run(post(good));
    expect(a.status).toBe(502);
    expect(await a.json()).toMatchObject({ code: "turnstile_unreachable" });
    stub({ throwOn: "webhook" });
    const b = await run(post(good));
    expect(b.status).toBe(502);
    expect(await b.json()).toMatchObject({ code: "delivery_failed" });
  });

  it("test_DW_6_2_payload_neutralises_mentions_and_markup", async () => {
    const calls = stub();
    const evil = { ...good, name: "Eve\nNew message from admin", email: "e@x.co", message: "hi <!channel> <https://evil|click> &amp; @everyone @here\nNew message from boss (b@x.co):" };
    expect((await run(post(evil))).status).toBe(201);
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    // Slack text: markup escaped, mentions defanged, newlines of the message quoted, name on one line.
    expect(sent.text).toContain("&lt;!channel&gt; &lt;https://evil|click&gt; &amp;amp; @\u200deveryone @\u200dhere");
    expect(sent.text).not.toMatch(/<[!h]/);
    expect(sent.text.split("\n")[0]).toBe("New message from Eve New message from admin (e@x.co):");
    for (const line of sent.text.split("\n").slice(1)) expect(line.startsWith("> ")).toBe(true);
    // Discord content: mentions defanged, not entity-escaped.
    expect(sent.content).toContain("<!channel>");
    expect(sent.content).toContain("@\u200deveryone");
    expect(sent.content).not.toContain("@everyone");
    for (const line of sent.content.split("\n").slice(1)) expect(line.startsWith("> ")).toBe(true);
    // The structured fields carry the single-line name.
    expect(sent.name).toBe("Eve New message from admin");
  });

  it("test_DW_6_2_chat_payloads_are_truncated_with_an_ellipsis", async () => {
    const calls = stub();
    // Slack escaping turns each "<" into "&lt;", so 2000 characters inflate far past both caps.
    expect((await run(post({ ...good, message: "<".repeat(2000) }))).status).toBe(201);
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent.text.length).toBe(3000);
    expect(sent.text.endsWith("…")).toBe(true);
    expect(sent.content.length).toBe(2000);
    expect(sent.content.endsWith("…")).toBe(true);
    // The structured fields are untouched, and a short message is not clipped.
    expect(sent.message).toBe("<".repeat(2000));
    const short = stub();
    await run(post(good));
    expect(JSON.parse(String(short[1]!.init!.body)).content.endsWith("…")).toBe(false);
  });

  it("test_DW_6_2_every_line_break_kind_in_a_message_is_quoted_so_no_line_can_forge_a_header", async () => {
    const calls = stub();
    await run(post({ ...good, message: "one\r\nNew message from x (y):\rtwo\u2028three\u2029four\nfive" }));
    const sent = JSON.parse(String(calls[1]!.init!.body));
    for (const field of [sent.text, sent.content] as string[]) {
      const lines = field.split("\n").slice(1);
      expect(lines).toHaveLength(6);
      for (const l of lines) expect(l.startsWith("> ")).toBe(true);
    }
  });

  it("accepts a form-encoded body", async () => {
    const calls = stub();
    const res = await run(req("/submit", new URLSearchParams(good).toString(), { "Content-Type": "application/x-www-form-urlencoded" }));
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
  });

  it("test_DW_6_2_turnstile_failure_is_400_JSON_and_nothing_is_delivered", async () => {
    for (const calls of [stub({ turnstile: false }), stub({ turnstileHttp: 500 })]) {
      const res = await run(post(good));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "turnstile_failed" });
      expect(calls.some((c) => c.url === ENV.CONTACT_WEBHOOK_URL)).toBe(false);
    }
  });

  it("test_DW_6_2_webhook_non_2xx_is_502_JSON", async () => {
    stub({ webhookStatus: 500 });
    const res = await run(post(good));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "delivery_failed" });
  });

  it("test_DW_6_2_oversized_body_is_413_JSON_before_any_outbound_call", async () => {
    const calls = stub();
    const res = await run(post({ ...good, message: "m".repeat(9000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "payload_too_large" });
    expect(calls).toEqual([]);
  });

  it("test_DW_6_2_wrong_method_is_405_and_unknown_or_unforwarded_path_is_404", async () => {
    stub();
    const get = await run(req("/submit", "", {}, "GET"));
    expect(get.status).toBe(405);
    expect(await get.json()).toMatchObject({ code: "method_not_allowed" });
    expect((await run(post(good, "/nope"))).status).toBe(404);
    expect((await run(post(good, "/contact/_api/submit"))).status).toBe(404); // the platform strips up to _api
    expect((await run(req("/", "", {}, "GET"))).status).toBe(404);
  });

  it("validation: unparseable or non-object bodies, missing/ill-typed fields, lengths, email", async () => {
    const calls = stub();
    const bad = [
      req("/submit", "{nope"),
      req("/submit", "[1]"),
      req("/submit", "null"),
      post({ ...good, name: 5 }),
      post({ name: "a", email: "a@b.co", message: "m" }),
      post({ ...good, name: "" }),
      post({ ...good, name: "n".repeat(101) }),
      post({ ...good, message: "" }),
      post({ ...good, message: "m".repeat(2001) }),
      post({ ...good, email: "not-an-email" }),
      post({ ...good, email: `${"a".repeat(200)}@b.co` }),
    ];
    for (const r of bad) {
      const res = await run(r);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toEqual([]);
  });

  it("an unset secret is a clear 500 naming both secrets", async () => {
    stub();
    for (const env of [{}, { TURNSTILE_SECRET: "x" }, { CONTACT_WEBHOOK_URL: "https://h.example" }]) {
      const res = await run(post(good), env);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("backend_misconfigured");
      expect(body.error).toContain("CONTACT_WEBHOOK_URL");
    }
  });

  it("test_DW_6_2_every_response_is_JSON_never_HTML", async () => {
    stub();
    const responses = [
      await run(post(good)), await run(post({})), await run(req("/submit", "", {}, "GET")), await run(post(good, "/x")),
      await run(post(good), {}), await run(post({ ...good, message: "m".repeat(9000) })),
    ];
    for (const r of responses) expect(r.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("test_DW_6_2_template_bundles_locally_within_the_limit_with_no_node_builtins", async () => {
    const r = await bundleBackend({ entry: join(import.meta.dir, "..", "references", "backend-template.ts") });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBeLessThan(BACKEND_LIMITS.bundleBytes);
  });
});
