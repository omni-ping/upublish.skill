# Backends: a small server-side handler next to a site

A published site is static files. A **backend** is one small JavaScript handler that runs next to a site and answers at `{site}/_api/*`: a form handler, a webhook receiver, or an API route that calls a third party with the owner's own key. You deploy it in one tool call (`publish_backend`) and operate it with `backend`, `backend_secret` and `backend_logs`. It is a paid add-on and the account may not have it (see Step 1).

## Step 1: Enable the add-on (tools)

Do these in order. Stop and report if a step fails; error messages say what to do next.

1. `backend` action `addon_status`. If it says the add-on is **not available for this account**, tell the user and stop. Do not offer or advertise it.
2. `backend` action `addon_enable`, in two steps. Only the address **owner** can enable it.
   - **Consent (no `accept_charge`).** It does NOT charge. The reply says "NOTHING HAS BEEN CHARGED", states that a prorated amount for the rest of the billing period is charged immediately, then the recurring price ($3.00/month or $30.00/year), that the add-on **includes Site data**, and ends with a line `expected: {"would_charge":..,"converts_data_addon":..,"interval":..,"price_cents":..,"month_cents":..,"year_cents":..}`. **Show this to the user and get a clear yes.** If the user said no, stop. Consent is needed on every enable, even when the server reports no charge.
   - **Accept (after the yes).** Call `addon_enable` again with `accept_charge: true` and that exact `expected` object, copied unchanged. If anything drifted since the consent (a price, the billing interval, whether an existing Site data item gets converted), nothing is charged and a new consent is printed: show it and ask again.
   - If the address already has the Site data add-on, enabling Backend **moves that item to the Backend price** (one subscription item, no double billing, no data lost); the consent says so.
   - Free plan: it needs a Pro or Max plan; use the `upgrade` tool, then run `addon_enable` again WITHOUT `accept_charge`. Complimentary plan with no Stripe subscription: `no_subscription`. A subscription managed by a subscription schedule: `409 conflict`, nothing changed (use the Stripe billing portal).
   - "Already on the subscription" or paused: nothing was posted; check `addon_status` in a minute, or resume the paused subscription in the billing portal.
   - Billing 503: the change may not have happened. Check `addon_status`; if it is still not enabled, run `addon_enable` again WITHOUT `accept_charge` (a fresh consent), never straight to `accept_charge: true`.
   - After enabling, the edge can take up to about a minute to start serving (`activating`).
3. Write the handler (below), then `publish_backend`.
4. Set secrets with `backend_secret` (ask the user for the values), then call the endpoint and read `backend_logs` if it misbehaves.

`backend` action `addon_disable` stops every `/_api` endpoint at once; backends are kept for 30 days and then their scripts are deleted. Re-enabling within 30 days restores them as they were. After the scripts are deleted, `status` shows `deployed: false`; redeploy with `backend` action `rollback` (an archived version is the one-call redeploy) or a fresh `publish_backend`, and set the secrets again.

## Step 2: Write the handler

A backend is **one ES module with a default export** that has a `fetch` handler. Use TypeScript or JavaScript; `publish_backend` bundles it for you locally (npm imports are fine, the whole bundle must stay under 1 MB). There are no Node built-ins (no `node:fs`, no `Buffer` import, no `nodejs_compat`): use Web APIs (`fetch`, `Request`, `Response`, `URL`, `crypto.subtle`, `TextEncoder`).

```ts
export default {
  async fetch(request: Request, env: Record<string, string>, ctx: { props: { upublish: Upublish } }): Promise<Response> {
    const { pathname } = new URL(request.url); // /contact/_api/submit arrives as /submit
    return Response.json({ ok: true });
  },
};
```

**Routing: the forwarded path.** The handler sees the same host and query, and a pathname equal to `/` plus the segments after `_api`. A request to `/contact/_api/submit?x=1` arrives as `/submit?x=1`; `/contact/_api` and `/contact/_api/` arrive as `/`. Route on that pathname, not on the site slug.

**Where it answers.** `{site url}/_api/...`, for example `https://alice.upubli.sh/contact/_api/submit`; for the address root site (`_root`) it is `https://alice.upubli.sh/_api/submit`. It also works on nested addresses and custom domains. `_api` is a reserved path segment (any case, any depth): a published file with an `_api` path segment is never served, and `publish` warns about it.

**Config.** `env.NAME` holds the plain-text `vars` you passed to `publish_backend` and the secrets set with `backend_secret`. `vars` are plain text and stay in every archived version: never put keys in them.

### The props: who is calling

`ctx.props.upublish` is set by the platform and cannot be forged by a visitor. User code never sees upublish cookies or `x-upublish-*` headers (they are stripped before the handler runs).

```
ctx.props.upublish = {
  site:     { id, address, namespace },   // address: the site's address or "_root"; namespace e.g. "alice.upubli.sh"
  identity: { kind, subject, claims?, label? } | null,
  data?:    SiteDataApi                    // only while the Site data entitlement is active
}
```

### Identity kinds

| `identity.kind` | `subject` | extra | When |
|---|---|---|---|
| `anonymous` | a random per-browser id (clearing cookies mints a new one) | none | the browser presented the `/_data` visitor cookie |
| `passcode` | the passcode id | `label` (the owner's name for the passcode) | the visitor entered a site passcode |
| `jwt` | `{iss}\|{sub}` | `claims` (verified claims) | a bring-your-own JWT issuer is configured (`data_jwt`) and the `Authorization: Bearer` token verified |
| `null` | none | none | no identity resolved, for example a webhook with no cookies: treat as unauthenticated |

- **`/_api` never gives a first-time visitor an anonymous identity.** With no valid cookie, passcode or JWT, `identity` is `null`. Writing through `data` then fails with `forbidden`. A fully public anonymous form is simpler to build with the Site data add-on straight from the browser (see `references/site-data.md`); use a backend when you need a secret, a third-party call or your own logic.
- **Forms must post from the site's own origin.** An unsafe request (anything but GET, HEAD, OPTIONS) that is not same-origin gets no cookie identity (`identity: null` unless it carries a bearer JWT) and no `data` capability, and on `access: site` backends it is refused with `403 access_denied`. Webhooks are cross-origin by design: they are dispatched on `access: public` with `identity: null`.
- When no JWT issuer is configured, the `Authorization` header passes through to your code untouched and is **not** an identity (your own API keys and webhook signatures work). When an issuer is configured the header is consumed by the platform and an invalid token is `401 invalid_token`.

### Access modes

| `access` | Meaning |
|---|---|
| `site` (default on the first deploy) | the site's own protection also protects `/_api`: a passcode- or gate-protected site needs the visitor to have passed it, otherwise `403 access_denied`. Denials are JSON, never the HTML passcode form |
| `public` | anyone can call it (use for webhooks); the code must authenticate callers itself, for example by verifying a signature header with a secret |

Change it without redeploying: `backend` action `access`. Redeploying without `access` keeps the current value.

### SiteDataApi: `ctx.props.upublish.data`

The same operations as the `/_data` routes, without the HTTP gates: `me()`, `list(collection, { limit?, cursor?, author? })`, `get(collection, id)`, `create(collection, data)`, `put(collection, id, data)`, `delete(collection, id)`. It can only reach the address and site in its props and acts as `identity`; with `identity: null` anything that needs an identity answers `forbidden`. Results are values, never throws: `{ ok: true, value }` or `{ ok: false, code, error }`, where `code` is one of `invalid_request`, `forbidden`, `data_unavailable`, `data_plane_disabled`, `not_found`, `exists`, `identity_limit_reached`, `collection_full`, `row_too_large`, `rate_limited`, `overloaded`, `unavailable`. Create the collections first with `data_collection` (see `references/site-data.md`).

### Responses: JSON, never HTML

`/_api` shares an origin with the whole address, so responses are policed:

- Allowed `Content-Type`: `application/json` (and any `application/*+json`), `application/x-ndjson`, `application/octet-stream`, `text/plain`, `text/csv`, `text/markdown`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`. Anything else (`text/html`, `image/svg+xml`, XML, JavaScript, `text/css`, PDF, event streams) is replaced by `502 content_type_not_allowed`. A response with no Content-Type is served as `application/octet-stream`.
- Forced on every response: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: no-store`.
- `Set-Cookie` is host-only (no `Domain`), a `Path` must lie inside the site's path, and no cookie name may contain `upublish`; refused cookies are dropped. `Access-Control-Allow-Origin` passes through; `Access-Control-Allow-Credentials` is stripped.

### Outbound requests

Your `fetch()` goes through an egress filter. It answers `{ error, code }`: `egress_denied` (403: the host is a hosted upubli.sh / pinn.sh name or a custom domain, so a backend cannot call another site), `egress_private_address` (403: private, loopback, metadata addresses and IP literals), `egress_scheme_denied` (403: not http/https), `egress_rate_limited` (429: 600 requests per minute per address). Raw sockets (`connect()`) are unavailable.

## Step 3: Deploy and operate

| Task | Tool |
|---|---|
| Deploy or redeploy (becomes the live version at once) | `publish_backend` with `site` and `entry` (a file) or `code` (inline, for hosted use); optional `access`, `vars` |
| Check what is live (version, access, var and secret NAMES, calls this month) | `backend` action `status` |
| List versions; undo a bad deploy | `backend` actions `versions`, `rollback` |
| Stop serving without deleting / serve again | `backend` actions `disable`, `enable` |
| Remove a backend for good (script, all versions and secrets; frees one of the 5 slots) | `backend` action `delete` with `confirm_site` equal to the site slug. Irreversible: prefer `disable` unless the user wants it gone |
| Set a secret, list names, delete one | `backend_secret` actions `set`, `list`, `delete` |
| See what the handler logged and how requests ended | `backend_logs` |

`publish_backend` bundles locally, so a compiler error or a bundle over 1 MB is reported before anything is sent. Bundling is sandboxed: macros are off, and `entry` may import only files inside its project folder (the nearest folder with a package.json) and npm packages installed there. The hosted server cannot see your files, so there you pass `code`: one self-contained module that imports nothing except `cloudflare:*` (no relative, absolute, URL or npm imports; bundle first on your machine if you need packages). Roles: the address owner enables or disables the add-on; the owner or an admin member deploys, sets secrets, rolls back and changes settings; any member can read the add-on status.

**Secrets.** Ask the user for the value and pass it to `backend_secret` `set`. It is sent once and never shown, logged or written to a local file; `list` returns names only. A secret persists across deploys and takes effect on the next request. Never put a secret in the code, in `vars`, or in a message back to the user.

## Limits

| Limit | Value |
|---|---|
| Bundled module | 1 MB (1,048,576 bytes) |
| Backends | 5 per address, 1 per site |
| Secrets / vars | 64 secrets and 32 vars per backend; names `[A-Za-z_][A-Za-z0-9_]*` up to 64 characters; each value up to 5 KB |
| Archived versions | 10 per backend (oldest pruned) |
| Deploys and rollbacks | 30 per address per hour |
| CPU and outbound requests per call | Pro: 50 ms and 10; Max: 100 ms and 20 |
| Calls | 1,000,000 per backend per month (hard cap, no overage billing); 300 requests per minute per site |
| Logs | the last 100 lines |
| Add-on retention | scripts are deleted 30 days after the add-on is disabled |

## Error codes

What a caller of `/_api` can receive (always JSON `{ "error": text, "code": code }`):

| Code | Status | Meaning |
|---|---|---|
| `request_headers_too_large` | 431 | more than 256 request headers |
| `backend_plane_disabled` | 503 | the backend service is switched off |
| `backend_not_found` | 404 | no backend on this site (or a preview host) |
| `backend_not_deployed` | 404 | the backend exists but nothing is deployed yet |
| `backend_disabled` | 403 | disabled by the owner, add-on cancelled, or site blocked / paused |
| `access_denied` | 403 | `access: site` and the passcode / gate check failed |
| `invalid_token` | 401 | `Authorization` present, issuer configured, token invalid |
| `backend_rate_limited` | 429 | per-site rate limit; honor `Retry-After` |
| `backend_limit` | 503 | CPU, subrequest or monthly-call cap hit |
| `content_type_not_allowed` | 502 | the handler returned a blocked content type |
| `backend_error` | 502 | the handler threw, or the dispatch failed |
| `unavailable` | 503 | a platform failure; retry |
| `egress_denied` | 403 | outbound call to a hosted name or custom domain |
| `egress_private_address` | 403 | outbound call to a private or metadata address |
| `egress_scheme_denied` | 403 | outbound scheme other than http(s) |
| `egress_rate_limited` | 429 | outbound rate limit |

What the tools report (as `[code]` in the error text): `unauthenticated`, `forbidden` (role too low), `not_available` (the add-on is hidden for this account), `not_found`, `invalid_request`, `upgrade_required` and `no_subscription` (plan), `consent_required` (enable without `accept_charge`), `addon_not_enabled` (enable the add-on first), `backend_limit_exceeded`, `deploy_rate_limited`, `bundle_too_large`, `bundle_rejected`, `version_not_found`, `conflict`, `upstream_failed` (the previous version stays live), `unavailable`.

## Starter template: a contact form

This is `references/backend-template.ts`. It works for a **first-time anonymous visitor** (it needs no identity). It routes on the forwarded path (`/submit`), checks the input and a Turnstile token (secret `TURNSTILE_SECRET`), then delivers the message by POSTing JSON to a webhook URL kept in a secret (`CONTACT_WEBHOOK_URL`: a Slack or Discord incoming webhook, or any endpoint that accepts JSON), neutralises chat mentions and markup in the payload, and answers JSON only. Deploy it as is, or copy and adapt it.

```ts
/**
 * Starter backend: a contact-form handler for ANONYMOUS visitors.
 *
 *   POST {site}/_api/submit   body: JSON or form-encoded { name, email, message, "cf-turnstile-response" }
 *
 * What it shows:
 *  - routing on the FORWARDED path: a request to `/contact/_api/submit` arrives here as `/submit`
 *  - verifying a Cloudflare Turnstile token with a SECRET (`TURNSTILE_SECRET`)
 *  - validating and size-limiting the input
 *  - delivering the message by POSTing JSON to a webhook URL kept in a SECRET (`CONTACT_WEBHOOK_URL`):
 *    a Slack or Discord incoming webhook, or any endpoint that accepts JSON
 *  - JSON responses only: an HTML or other non-allowlisted response is replaced by a 502
 *
 * It needs no visitor identity, so it works for a first-time anonymous visitor (`/_api` mints none).
 *
 * Deploy:   publish_backend  site: "<slug>"  entry: "references/backend-template.ts"
 * Secrets:  backend_secret   action: "set"  name: "TURNSTILE_SECRET" | "CONTACT_WEBHOOK_URL"  (ask the user)
 *
 * The page must post from the site's OWN origin. Uses only Web APIs: Node built-ins are not available.
 */

interface Env {
  /** Secret: the Turnstile secret key. */
  TURNSTILE_SECRET?: string;
  /** Secret: https URL that receives the message as JSON. */
  CONTACT_WEBHOOK_URL?: string;
}

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY_BYTES = 8 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ZWJ = "\u200d";
/** `@everyone` / `@here` with a zero-width joiner, so chat apps do not treat them as mentions. */
const defang = (s: string): string => s.replace(/@(everyone|here|channel)/gi, `@${ZWJ}$1`);
/** Slack mrkdwn: `&`, `<` and `>` start markup and links, so user text is escaped. */
const slackEscape = (s: string): string => defang(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
/** One line: newlines and runs of whitespace collapse, so a field cannot forge a header line. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Keeps a message's newlines but prefixes every line, so no line of it can pass for a header. */
const quote = (s: string): string => s.split(/\r\n|[\n\r\u2028\u2029]/).map((l) => `> ${l}`).join("\n");

/** Caps a chat payload (Discord content: 2000, Slack text: far below its 40000) with a trailing ellipsis. */
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const DISCORD_MAX = 2000;
const SLACK_MAX = 3000;

const json = (body: Record<string, unknown>, status = 200): Response => Response.json(body, { status });
const fail = (status: number, code: string, error: string): Response => json({ error, code }, status);

/** Parses a JSON or form-encoded body; null when it cannot be parsed. */
function parseForm(request: Request, text: string): Record<string, unknown> | null {
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** true / false for the verdict; null when Turnstile could not be reached. */
async function turnstileOk(secret: string, token: string): Promise<boolean | null> {
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: new URLSearchParams({ secret, response: token }) });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return null;
  }
}

async function deliver(url: string, name: string, email: string, message: string): Promise<boolean> {
  const header = (s: (v: string) => string) => `New message from ${s(name)} (${s(email)}):\n${quote(s(message))}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text`: Slack (escaped). `content` + `allowed_mentions`: Discord (no pings). The fields: any other receiver.
      body: JSON.stringify({ text: clip(header(slackEscape), SLACK_MAX), content: clip(header(defang), DISCORD_MAX), allowed_mentions: { parse: [] }, name, email, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function submit(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET || !env.CONTACT_WEBHOOK_URL) {
    return fail(500, "backend_misconfigured", "TURNSTILE_SECRET and CONTACT_WEBHOOK_URL must be set with backend_secret");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail(413, "payload_too_large", "Message too large");

  const form = parseForm(request, text);
  const rawName = form?.name, rawEmail = form?.email, message = form?.message, token = form?.["cf-turnstile-response"];
  if (typeof rawName !== "string" || typeof rawEmail !== "string" || typeof message !== "string" || typeof token !== "string") {
    return fail(400, "invalid_request", "name, email, message and cf-turnstile-response are required");
  }
  const name = oneLine(rawName), email = oneLine(rawEmail);
  if (name.length < 1 || name.length > 100 || message.length < 1 || message.length > 2000 || !EMAIL_RE.test(email) || email.length > 200) {
    return fail(400, "invalid_request", "name up to 100 characters, a valid email, message up to 2000 characters");
  }
  const human = await turnstileOk(env.TURNSTILE_SECRET, token);
  if (human === null) return fail(502, "turnstile_unreachable", "Could not reach the Turnstile check");
  if (!human) return fail(400, "turnstile_failed", "Turnstile check failed");

  if (!(await deliver(env.CONTACT_WEBHOOK_URL, name, email, message))) return fail(502, "delivery_failed", "Could not deliver the message");
  return json({ ok: true }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The path is what follows /_api: /contact/_api/submit arrives as /submit.
    const { pathname } = new URL(request.url);
    if (pathname === "/submit") return request.method === "POST" ? submit(request, env) : fail(405, "method_not_allowed", "Use POST");
    return fail(404, "not_found", "Not found");
  },
};
```

To use it: `publish_backend` it, `backend_secret` `set` both `TURNSTILE_SECRET` and `CONTACT_WEBHOOK_URL` (ask the user for the values), and have the page post JSON or a form `{ name, email, message, "cf-turnstile-response" }` to `{site}/_api/submit` from the site itself. Errors are JSON `{ error, code }`: 400 `invalid_request` / `turnstile_failed`, 413 `payload_too_large`, 502 `delivery_failed` / `turnstile_unreachable`, 405 and 404 for other methods and paths.

### Optional: store the message in Site data (visitors with an identity only)

Instead of (or as well as) the webhook, a handler can write a row with `ctx.props.upublish.data`. This only works when the visitor has an identity (a passcode, a bring-your-own JWT, or a `/_data` cookie). `/_api` never mints an anonymous identity, so a first-time anonymous visitor gets `forbidden` from `data`; that is why the template above does not depend on it. Create the collection first (`data_collection` action `set`, rule `inbox`).

```ts
const result = await ctx.props.upublish.data?.create("contact", { name, email, message });
if (!result?.ok) return Response.json({ error: result?.error ?? "Site data is not available", code: result?.code ?? "data_unavailable" }, { status: result?.code === "forbidden" ? 403 : 502 });
```
