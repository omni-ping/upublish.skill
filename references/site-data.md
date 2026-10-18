# Site data: shared data for published sites

Published sites are static files. The **site data add-on** gives pages a small same-origin data API at `/_data`, so a site can have votes, guestbooks, signups, comments or counters without an outside backend. This guide covers (1) enabling and configuring it with the tools and (2) writing the browser code. It is a paid add-on and the account may not have it (see Step 1).

## Step 1: Enable it (tools)

Do these in order. Stop and report if a step fails; error messages say what to do next.

1. `data` action `status`. If it says site data is **not available for this account**, tell the user and stop. Do not offer or advertise it.
2. `data` action `enable` (no `accept_charge`). It does NOT charge: it returns the price. **Show the price to the user and get a clear yes.** Then call `enable` again with `accept_charge: true`. If the user said no, stop.
   - Free plan: `upgrade_required` (use the `upgrade` tool first). Complimentary plan with no subscription: `no_subscription`.
   - After enabling, the edge can take up to about a minute to start serving (`activating`). `403 data_unavailable` from the site in that window is expected.
3. `data_collection` action `set` to create the collections the site needs (see "Choosing a preset").
4. If visitors will use passcodes as identities, add them with `passcode_add` before writing claim matchers that name their labels.
5. Write the browser code (below), `publish`, then verify with `data_rows` action `list` that rows arrive.

Other tools: `data_rows` (list, export to a file, archive = reset, delete one row, create/put rows as the owner, import up to 500 rows per call with explicit authors and timestamps), `data_jwt` (bring-your-own sign-in), `data` actions `disable` (data kept 30 days, then permanently deleted) and `wipe` (**destructive**: deletes everything now; needs `confirm_namespace` equal to the address name).

Do not name a `_data` directory in the site's files: `/_data` is reserved and files there are never served (publish warns). Sites are named by slug in tool arguments (`_root` for the root site); the tools translate to ids.

## Step 2: Choosing a preset

| Preset (`rule`) | Visitors with write access can | Who can read | Edit / delete |
|---|---|---|---|
| `append-only` | add rows | everyone who can open the site | nobody edits (a PUT to an existing id with the identical body is a harmless 200; a different body is 409 `exists`); admins delete |
| `own-rows` | add or replace their own rows | each visitor sees only their own rows; admin claims read all | the author edits and deletes their own; admins delete |
| `inbox` | submit rows | admins only | nobody edits; admins delete |
| `owner-only` | nothing (only admin claims and the owner write) | everyone who can open the site | admins edit and delete |

- `writers`: which identity kinds may write: `anonymous`, `passcode`, `jwt`.
- `write_claims`: writers must match one matcher. `admin_claims`: visitors matching one get admin powers (read all rows, delete, `?author=`). A matcher is `{kind:"passcode", claims:{site:"<slug>", label:"<passcode label>"}}`; passcode matchers must include `site`, and that site must be in `sites`. Matchers in a list are OR; claims inside one are AND.
- `sites`: only pages on these sites can reach the collection (a results page on another slug must be listed too).
- `per_identity_limit`: max active rows one visitor owns (1 = one vote each).
- Defaults: `max_rows` 10,000 (ceiling 100,000), `max_row_bytes` 16,384 (ceiling 65,536), `writes_per_min` 60 per identity (ceiling 600). Up to 20 collections per address; names are lowercase letters, digits, hyphens.
- `owner-only` collections (and seeding any collection) are written by you with `data_rows` `create` / `put` / `import`.

## Step 3: Browser code

### URLs and requests

Same origin only: `https://{address}.upubli.sh/{slug}/_data/{collection}`. For the `_root` site it is `/_data/{collection}`; custom domains work the same. Use absolute paths in code: `/{slug}/_data/votes` (or `/_data/votes` for `_root`). There is **no CORS**: no `Access-Control-*` header is sent, so another origin cannot call it. Every response has `Cache-Control: no-store`.

| Method and path | Success | Purpose |
|---|---|---|
| `GET /_data/_me` | 200 | Caller's identity kind, passcode label and per-collection access |
| `GET /_data/{collection}` | 200 | List rows. Query `limit` 1..100 (default 50), `cursor`, `author` (admins only) |
| `POST /_data/{collection}` | 201 | Create a row with a server-generated UUID id |
| `GET /_data/{collection}/{id}` | 200 | One row. Query `author` (admins only) |
| `PUT /_data/{collection}/{id}` | 200 or 201 | Create or replace by client-chosen id (idempotent retries) |
| `DELETE /_data/{collection}/{id}` | 204 | Delete (admins, or the author in `own-rows`). Query `author` (admins) |

(Each path is under `/{slug}` for non-root sites.) Rules that cause most failures:

- Send `Content-Type: application/json` on POST and PUT, and `credentials: "same-origin"`.
- The body is the row's `data` object **directly**: `JSON.stringify({ choice: "blue" })`, not `{ data: {...} }`. It must be a JSON object, at most `max_row_bytes` (default 16 KB), nesting at most 16.
- DELETE has **no body** and no Content-Type.
- Writes are checked for same origin. A browser sends `Origin` automatically. A non-browser script (Node, curl, a test harness) **must send `Origin`** equal to the site's origin, or the write is refused with `csrf_blocked`.
- Row ids: 1..128 characters from `A-Za-z0-9._~-`, not `.` or `..`. They go into the URL raw; never percent-encode them (any `%` is `invalid_request`).
- Always handle non-2xx: the body is `{ "error": "...", "code": "..." }`; branch on `code`.

### Wire shapes

```js
// GET /_data/votes  ->  { rows: VisitorRow[], next_cursor: string | null }
// VisitorRow = { id, data, created_at, updated_at, mine, author? }
//   created_at / updated_at: ISO-8601 UTC with milliseconds
//   mine: true for the caller's own rows
//   author: { kind, subject, label? } ONLY for callers matching admin_claims
// Rows come ordered by created_at then id; archived rows are never returned.
// Page with: next_cursor non-null -> GET ...?cursor=<next_cursor>
// GET /_data/_me -> { kind: "anonymous"|"passcode"|"jwt", label: string|null,
//                     collections: { [name]: { read: "all"|"own"|"none", write: boolean, admin: boolean } } }
```

An admin addresses another author's row with `?author=` set to the percent-encoded `identityKey`, e.g. `?author=passcode%3A<passcode_id>` (`encodeURIComponent("passcode:" + id)`).

### Helper

```js
const BASE = "/for-her/_data"; // use "/_data" for the _root site

async function api(method, path, data) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, code: body.code, retryAfter: res.headers.get("Retry-After") });
  return body;
}

const listAll = async (collection) => {
  const rows = [];
  let cursor = null;
  do {
    const page = await api("GET", `/${collection}?limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    rows.push(...page.rows);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
};
```

### Idempotent writes: upsert by id

Network failures and retries must not duplicate rows. Choose the row id **on the client, once**, and write with `PUT /{collection}/{id}`. Retrying the same PUT is safe: in `own-rows` and `owner-only` it replaces; in `append-only` and `inbox` an identical body returns 200 with no write (even at a limit, at no rate cost), and a different body returns 409 `exists`. Use `POST` only when you do not care about duplicates.

### Offline queue

Keep writes in `localStorage`, send with PUT-by-id so replaying is always safe, and flush when the browser comes back online.

```js
const QUEUE_KEY = "site-data-queue";
const load = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } };
const save = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} };

function enqueue(collection, id, data) {
  save([...load().filter((w) => !(w.collection === collection && w.id === id)), { collection, id, data }]);
  return flush();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const w of load()) {
      try {
        await api("PUT", `/${w.collection}/${w.id}`, w.data); // 200 or 201: stored (or identical replay)
        save(load().filter((x) => !(x.collection === w.collection && x.id === w.id)));
      } catch (e) {
        if (e.status === undefined || e.status >= 500 || e.code === "invalid_token" || e.code === "data_unavailable") return; // offline, server trouble, token to refresh, or site not unlocked/active yet: keep, retry later
        if (e.code === "rate_limited") { setTimeout(flush, (Number(e.retryAfter) || 30) * 1000); return; }
        // Permanent for this write (409 exists / limits, 400, 403, 404, 413): drop it and tell the user.
        save(load().filter((x) => !(x.collection === w.collection && x.id === w.id)));
        window.dispatchEvent(new CustomEvent("site-data-rejected", { detail: { write: w, code: e.code, message: e.message } }));
      }
    }
  } finally { flushing = false; }
}

addEventListener("online", flush);
addEventListener("load", flush);
```

Treat 200 and 201 as success. For append-only collections an identical-body 200 after a lost response is success, not an error. `409 exists` means a *different* row already has that id: a real conflict.

## Identity: who is the visitor?

Rows are owned by the visitor's identity. The kind decides how strong that is.

- **anonymous**: the edge sets an `HttpOnly` cookie (`__Host-upublish_did`, about 400 days) on the first request. It is per browser: clearing cookies, a private window or another device is a different person. Weak by design; fine for "one vote per browser". Never put secrets or trust decisions on it.
- **passcode**: for passcode-protected sites. After the visitor enters the site's passcode, the access cookie carries the passcode id and label, so rows are tied to *which passcode* (for example the `her` passcode writes, the `founder` passcode reads all). Code needs nothing extra: the cookie is sent automatically. When a site is first added to any collection, visitors who already unlocked it must **enter the passcode again** to get the new cookie; until then they act as anonymous on `/_data`. Gate (form) cookies are also anonymous here.
- **jwt** (bring-your-own sign-in, set with `data_jwt`): send the token on each call as `Authorization: Bearer <jwt>` (max 8,192 bytes; asymmetric signature; `iss` and `aud` must match the configured issuer). An invalid token is **401 `invalid_token`** and is never downgraded to anonymous; refresh the token and retry. The identity is `iss|sub`; claims can be matched in `write_claims` / `admin_claims`. Supabase projects must use the new asymmetric JWT signing keys.

`GET /_data/_me` tells the page what the current visitor may do (hide the form when `write` is false):

```js
const me = await api("GET", "/_me");
const canVote = me.collections["votes"]?.write === true;
```

## Errors: what the code should do

| `code` | Status | Meaning | Client should |
|---|---|---|---|
| `invalid_request` | 400 | Malformed JSON, id, query or body | Fix the request (a bug); do not retry |
| `invalid_token` | 401 | `Authorization` JWT present but invalid | Get a fresh token, retry; do not fall back silently |
| `forbidden` | 403 | Identity known but not allowed (wrong kind or claims, or not an admin) | Show "not allowed"; no retry |
| `csrf_blocked` | 403 | Origin / Sec-Fetch-Site / Content-Type check failed | Send JSON with the right header from the site's own origin (scripts: add `Origin`) |
| `data_unavailable` | 403 | Fails closed: add-on not enabled or not yet active, passcode/gated site without a valid cookie, blocked or paused site, bad config | Tell the visitor to unlock the site; otherwise ask the owner to check `data status` |
| `not_found` | 404 | Unknown collection, site not in the collection's `sites`, or missing row | Check the collection name and its `sites`; for a row, treat as absent |
| `method_not_allowed` | 405 | Wrong method for the path | Fix the request (bug) |
| `exists` | 409 | append-only/inbox PUT to an existing id with a different body | Treat as already submitted (for example "you already voted") |
| `identity_limit_reached` | 409 | `per_identity_limit` hit | Tell the visitor they reached their limit |
| `collection_full` | 409 | `max_rows` hit | Tell the visitor it is full; owner raises `max_rows` or archives |
| `site_moved` | 410 | The site's address now redirects (renamed or moved); `/_data` never redirects | Use the site's new address |
| `row_too_large` | 413 | Row exceeds `max_row_bytes` | Send less data |
| `rate_limited` | 429 | Per-IP or per-identity writes per minute (default 60) | Wait `Retry-After` seconds, then retry |
| `overloaded` | 503 | The data object is overloaded | Retry with backoff |
| `data_plane_disabled` | 503 | The service is switched off | Retry later |
| `unavailable` | 503 | Other store failure | Retry with backoff |

Treat any 5xx, a network failure, `invalid_token` (after refreshing) and `data_unavailable` as retryable, and any other 4xx as permanent for that request. The `bad_signature`, `stale_timestamp` and `replayed_nonce` (401) codes belong to the server-to-edge channel and never reach page code. `unauthenticated`, `not_available`, `upgrade_required`, `no_subscription`, `consent_required`, `addon_not_enabled`, `collection_exists`, `collection_not_found`, `limit_exceeded` and `admin_channel_failed` are owner-side (tool) errors; the tools explain them.

## Worked example: a one-vote poll with a results page

Goal: visitors on `/poll/` pick a colour once; `/results/` shows totals. Anonymous visitors, one vote per browser, everyone can read.

Tools:

```
data              action: status            -> available, then enable (confirm the price with the user)
data_collection   action: set, collection: "votes", rule: "append-only",
                  sites: ["poll", "results"], writers: ["anonymous"],
                  per_identity_limit: 1, max_rows: 5000
```

`/poll/index.html` (`BASE = "/poll/_data"`, helper and offline queue from above):

```js
// One id per browser, chosen once, so retries are the same PUT.
const voteId = localStorage.getItem("voteId") || crypto.randomUUID();
localStorage.setItem("voteId", voteId);

async function vote(choice) {
  try {
    await api("PUT", `/votes/${voteId}`, { choice });
    show("Thanks, your vote is in.");
  } catch (e) {
    if (e.code === "exists") show("You already voted.");
    else if (e.code === "identity_limit_reached") show("This browser already voted.");
    else if (e.code === "collection_full") show("Voting is closed.");
    else if (e.code === "rate_limited") show("Too many tries, wait a moment.");
    else if (e.status === undefined || e.status >= 500) { await enqueue("votes", voteId, { choice }); show("Saved; it will send when you are online."); }
    else show("Could not record your vote.");
  }
}
```

`/results/index.html` (`BASE = "/results/_data"`; `results` is in the collection's `sites`):

```js
const rows = await listAll("votes");
const totals = {};
for (const r of rows) totals[r.data.choice] = (totals[r.data.choice] || 0) + 1;
renderChart(totals);
```

Why this works: `append-only` lets everyone read and nobody edit; the client-chosen id makes the retry idempotent (same body, 200); a second, different vote from the same browser is `exists`; clearing localStorage gives a new id but the same cookie identity, which hits `per_identity_limit: 1`. Reset for a new round with `data_rows` `archive` (history is kept, active rows go to zero).

## Owner operations on rows

- Inspect: `data_rows` `list` (use `limit` and `cursor`; `include_archived` for history).
- Backup or privacy export: `data_rows` `export` with a file `path`; it streams every row, including archived, as NDJSON (one row object per line).
- Remove a visitor's row on request: `data_rows` `delete` with `id`; for `own-rows` collections also pass `author` as `kind:subject` exactly as `list` shows it.
- Migrate old data: `data_rows` `import` (owner only, 500 rows per call, each with `id`, `author`, `data`, `created_at`; existing ids are skipped; the `max_rows` and `max_row_bytes` limits still apply).

Changes made with the tools can take up to about a minute to reach the edge; `data status` reports edge sync.
