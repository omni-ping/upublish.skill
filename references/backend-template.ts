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
 * It needs no visitor identity, so it works for any visitor, including a first-time anonymous one and a webhook caller.
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
