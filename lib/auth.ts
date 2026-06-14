/**
 * Authentication module for upublish.
 *
 * Exports:
 *   login()               — interactive OAuth flow (opens browser, receives tokens)
 *   createTokenProvider()  — runtime token refresh (auto-refreshes before expiry)
 *   readCredentials()      — reads refresh token from credentials file
 *   saveCredentials()      — writes refresh token to credentials file
 *
 * All side-effectful operations are injectable for testability.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { FetchFn, TokenProvider } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  username: string;
}

export interface CallbackServer {
  port: number;
  /**
   * Resolves with the single-use authorization `code` the unified OAuth flow
   * redirects back to the loopback `redirect_uri`. Rejects if the redirect
   * instead carries an `?error=…` (e.g. consent denied, banned account) or is
   * missing the code. Tokens NEVER travel through this redirect — only the code.
   */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface LoginDeps {
  /** API base URL, e.g. "https://api.upubli.sh" — used for token exchange. */
  apiBaseUrl: string;
  /**
   * Website base URL, e.g. "https://upubli.sh" — used for the provider chooser
   * (/login). Defaults to "https://upubli.sh" when omitted.
   */
  siteBaseUrl?: string;
  /** Credentials file path (defaults to ~/.upublish/credentials) */
  credentialsFilePath?: string;
  /** Opens a URL in the default browser. */
  openBrowser(url: string): Promise<void>;
  /** Starts the localhost callback server (receives the auth code via redirect). */
  startCallbackServer(): Promise<CallbackServer>;
  /** Logger (defaults to console.log). Must never receive secrets. */
  log(msg: string): void;
  /**
   * Injectable fetch for the token-exchange POST. Defaults to global fetch.
   * Present here (not just CoreDeps) so login() can be driven entirely from
   * the deps bag in tests with no real network.
   */
  fetchFn?: FetchFn;
}

export interface LoginResult {
  username: string;
  credentialsFilePath: string;
}

interface TokenProviderOptions {
  /** The long-lived refresh token stored in ~/.upublish/credentials. */
  refreshToken: string;
  /** API base URL, e.g. https://api.upubli.sh */
  apiBaseUrl: string;
  /** Injectable fetch function (defaults to global fetch). */
  fetchFn?: FetchFn;
}

interface RefreshResponse {
  access_token: string;
  /** Seconds until the access token expires. */
  expires_in: number;
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/** Returns the default absolute path to the credentials file. */
export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), ".upublish", "credentials");
}

/**
 * Reads a refresh token from the credentials file.
 * Returns null if the file does not exist or is empty.
 */
export async function readCredentials(
  filePath: string,
): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim() || null;
}

/**
 * Saves a refresh token to the credentials file.
 * Creates parent directories if they don't exist.
 * File permissions: owner read/write only (0o600).
 */
export async function saveCredentials(
  filePath: string,
  refreshToken: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, refreshToken, { mode: 0o600 });
}

// ─── Token Provider ──────────────────────────────────────────────────────────

/**
 * Creates a token provider that automatically refreshes the access token
 * before it expires. Calls POST /auth/token/refresh with the stored refresh
 * token. Caches the access token and refreshes 60 seconds before expiry.
 */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const { refreshToken, apiBaseUrl } = opts;
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));

  let cachedToken: string | null = null;
  let expiresAt = 0;

  return async function getToken(): Promise<string> {
    const now = Date.now();
    const needsRefresh = cachedToken === null || now >= expiresAt - 60_000;

    if (!needsRefresh) {
      return cachedToken!;
    }

    const response = await fetchFn(`${apiBaseUrl}/auth/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string };
        detail = body.error ? ` — ${body.error}` : "";
      } catch {
        // Ignore parse error
      }
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}${detail}`,
      );
    }

    const data = (await response.json()) as RefreshResponse;
    cachedToken = data.access_token;
    expiresAt = Date.now() + data.expires_in * 1000;

    return cachedToken;
  };
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

/**
 * Generates a PKCE (RFC 7636) code_verifier and code_challenge pair.
 * Uses Web Crypto API (no node:crypto).
 */
export async function generatePkce(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  const codeVerifier = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoded = new TextEncoder().encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashBytes = new Uint8Array(hashBuffer);
  const codeChallenge = btoa(String.fromCharCode(...hashBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}

// ─── URL Building ────────────────────────────────────────────────────────────

/**
 * Builds the URL to open in the browser for the provider-chooser OAuth flow.
 *
 * Targets `{siteBaseUrl}/login` with `flow=local`. The website's /login page
 * renders a button per enabled provider and forwards all five params verbatim
 * into `{API}/auth/:provider`. A brand-new or still-pending account is detoured
 * through the browser onboarding page before bouncing back; a returning account
 * bounces straight back. Either way the loopback `redirect_uri` ultimately
 * receives a single-use `?code=…` — never a token. The PKCE `code_challenge`
 * binds that code to the verifier login holds.
 *
 * A trailing slash on `siteBaseUrl` is stripped to avoid double-slash paths.
 */
export function buildAuthUrl(opts: {
  siteBaseUrl: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const base = opts.siteBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    flow: "local",
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    intent: "login",
  });
  return `${base}/login?${params.toString()}`;
}

/** Builds the localhost callback URL for a given port. */
export function buildCallbackUrl(port: number): string {
  return `http://localhost:${port}/callback`;
}

// ─── Token Exchange ──────────────────────────────────────────────────────────

/**
 * Redeems a single-use authorization code for tokens via PKCE.
 *
 * POSTs `{code, code_verifier}` to `/auth/token/exchange`. The server verifies
 * S256(code_verifier) against the challenge the code was bound to and returns
 * the tokens in the RESPONSE BODY — they never appear in a URL. The verifier is
 * the PKCE secret; it is sent only in this POST body and is never logged.
 *
 * On a non-2xx response (unknown/expired/reused code → 400, verifier mismatch →
 * 401, network failure → throw), this rejects with an actionable message telling
 * the user to run login again. The caller writes no credentials on rejection.
 */
export async function exchangeCodeForTokens(opts: {
  apiBaseUrl: string;
  code: string;
  codeVerifier: string;
  fetchFn?: FetchFn;
}): Promise<TokenResponse> {
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));

  let response: Response;
  try {
    response = await fetchFn(`${opts.apiBaseUrl}/auth/token/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code: opts.code, code_verifier: opts.codeVerifier }),
    });
  } catch (err) {
    // Network failure mid-exchange — nothing was issued, nothing to clean up.
    throw new Error(
      `Could not reach the upublish API to finish signing in (${(err as Error).message}). ` +
      `Check your connection and run login again.`,
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ? ` — ${body.error}` : "";
    } catch {
      // Ignore parse error — fall back to status text.
    }
    throw new Error(
      `Sign-in could not be completed (HTTP ${response.status}${detail}). ` +
      `The authorization code may have expired or already been used — run login again.`,
    );
  }

  return (await response.json()) as TokenResponse;
}

// ─── Login Orchestrator ──────────────────────────────────────────────────────

/**
 * Runs the interactive OAuth login flow against the unified entry:
 * 1. Start the localhost callback server (it will receive a single-use code).
 * 2. Generate the PKCE pair; the verifier is kept in scope for the exchange.
 * 3. Open the browser to `/login?flow=local` (the provider chooser). A first-time user is
 *    transparently detoured through the browser onboarding page; the agent
 *    simply keeps waiting — there is no client-side branch for new vs returning.
 * 4. Wait for the callback to deliver the auth `code` (or reject on `?error=`).
 * 5. Exchange the code for tokens; tokens arrive only in the response body.
 * 6. Store the refresh token (0600) and return the username + path.
 *
 * The callback server is always closed, and on any failure (callback error,
 * exchange rejection, network drop) no credentials file is written.
 *
 * All side-effectful operations are injected via deps for testability.
 */
export async function login(deps: LoginDeps): Promise<LoginResult> {
  const {
    apiBaseUrl,
    openBrowser: open,
    startCallbackServer,
    log,
  } = deps;

  const credFile = deps.credentialsFilePath ?? defaultCredentialsPath();

  // Start callback server.
  const server = await startCallbackServer();
  const redirectUri = buildCallbackUrl(server.port);

  // Generate PKCE. The verifier is the secret half: it stays in this scope and
  // is sent only in the exchange POST body — never in a URL, never logged.
  const { codeVerifier, codeChallenge } = await generatePkce();

  // Open the browser to the provider chooser (/login).
  const siteBaseUrl = deps.siteBaseUrl ?? "https://upubli.sh";
  const authUrl = buildAuthUrl({ siteBaseUrl, redirectUri, codeChallenge });
  log("Opening browser for sign-in...");
  await open(authUrl);

  // Wait for the single-use code. First-time users finish setup (username +
  // first namespace + ToS) in the browser before the code arrives — this is
  // expected, not a hang, so the message tells the user where to look.
  log("Waiting for sign-in to finish in your browser (first-time setup happens there)...");
  let code: string;
  try {
    code = await server.waitForCode();
  } finally {
    await server.close();
  }

  // Exchange the code for tokens. A rejection here leaves no credentials.
  const tokens = await exchangeCodeForTokens({
    apiBaseUrl,
    code,
    codeVerifier,
    fetchFn: deps.fetchFn,
  });

  // Store refresh token (owner read/write only).
  await saveCredentials(credFile, tokens.refresh_token);

  log("");
  log(`Authenticated as: ${tokens.username}`);
  log(`Credentials stored at: ${credFile}`);

  return {
    username: tokens.username,
    credentialsFilePath: credFile,
  };
}
