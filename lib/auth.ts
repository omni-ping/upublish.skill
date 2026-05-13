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
  waitForTokens(): Promise<TokenResponse>;
  close(): Promise<void>;
}

export interface LoginDeps {
  /** API base URL, e.g. "https://api.upubli.sh" */
  apiBaseUrl: string;
  /** Credentials file path (defaults to ~/.upublish/credentials) */
  credentialsFilePath?: string;
  /** Opens a URL in the default browser. */
  openBrowser(url: string): Promise<void>;
  /** Starts the localhost callback server (receives tokens via redirect). */
  startCallbackServer(): Promise<CallbackServer>;
  /** Logger (defaults to console.log). */
  log(msg: string): void;
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

/** Builds the URL to open in the browser for Google OAuth consent. */
export function buildAuthUrl(opts: {
  apiBaseUrl: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${opts.apiBaseUrl}/auth/google/local?${params.toString()}`;
}

/** Builds the localhost callback URL for a given port. */
export function buildCallbackUrl(port: number): string {
  return `http://localhost:${port}/callback`;
}

// ─── Login Orchestrator ──────────────────────────────────────────────────────

/**
 * Runs the interactive OAuth login flow:
 * 1. Start localhost callback server
 * 2. Generate PKCE pair
 * 3. Open browser to OAuth consent page
 * 4. Wait for tokens (server redirects back with tokens)
 * 5. Store refresh token to credentials file
 * 6. Return username and credentials path
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

  // Start callback server
  const server = await startCallbackServer();
  const redirectUri = buildCallbackUrl(server.port);

  // Generate PKCE
  const { codeChallenge } = await generatePkce();

  // Open browser to OAuth consent
  const authUrl = buildAuthUrl({ apiBaseUrl, redirectUri, codeChallenge });
  log("Opening browser for Google sign-in...");
  await open(authUrl);

  // Wait for tokens
  log("Waiting for authentication (check your browser)...");
  let tokens: TokenResponse;
  try {
    tokens = await server.waitForTokens();
  } finally {
    await server.close();
  }

  // Store refresh token
  await saveCredentials(credFile, tokens.refresh_token);

  log("");
  log(`Authenticated as: ${tokens.username}`);
  log(`Credentials stored at: ${credFile}`);

  return {
    username: tokens.username,
    credentialsFilePath: credFile,
  };
}
