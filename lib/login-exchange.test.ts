/**
 * Phase 5 tests — unified login via auth-code + PKCE exchange.
 *
 * The login flow no longer receives tokens in the OAuth redirect. The callback
 * server now delivers a single-use authorization `code` (or rejects on `error`),
 * and login() exchanges {code, code_verifier} at POST /auth/token/exchange for
 * tokens that arrive only in the response body.
 *
 * Covers:
 *   DW-5.1 — new-user login completes code → exchange → credentials saved;
 *            login is identical for new vs returning users (both arrive as a code).
 *   DW-5.2 — tokens appear only in the exchange response body, never in URLs/logs.
 *   DW-5.6 — abandoned-onboarding / failed-exchange / network-failure paths
 *            produce actionable errors and leave no partial credentials.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { login, buildAuthUrl } from "./auth.ts";
import type { LoginDeps, CallbackServer } from "./auth.ts";

const BASE_URL = "https://api.example.com";

// ─── Test plumbing ────────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

function tmpCredPath(tag: string): string {
  const p = path.join(os.tmpdir(), `upublish-p5-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

/** A callback server that yields a fixed auth code (the happy path). */
function codeServer(code: string, onClose?: () => void): () => Promise<CallbackServer> {
  return async () => ({
    port: 12345,
    waitForCode: async () => code,
    close: async () => {
      onClose?.();
    },
  });
}

/** A callback server that rejects as if the redirect carried ?error=. */
function errorServer(reason: string, onClose?: () => void): () => Promise<CallbackServer> {
  return async () => ({
    port: 12345,
    waitForCode: async () => {
      throw new Error(`OAuth error: ${reason}`);
    },
    close: async () => {
      onClose?.();
    },
  });
}

/** Builds a LoginDeps bag with sensible defaults; override per test. */
function makeDeps(overrides: Partial<LoginDeps>): LoginDeps {
  return {
    apiBaseUrl: BASE_URL,
    openBrowser: async () => {},
    startCallbackServer: codeServer("auth-code-123"),
    log: () => {},
    ...overrides,
  };
}

/** A fetch that returns a successful exchange response, capturing the request. */
function exchangeOk(capture?: { url?: string; body?: Record<string, unknown> }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    }
    return new Response(
      JSON.stringify({
        access_token: "access-tok-xyz",
        refresh_token: "refresh-tok-abc",
        expires_in: 3600,
        username: "newuser",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ─── DW-5.1: code → exchange → credentials ────────────────────────────────────

describe("DW-5.1: login exchanges auth code for tokens", () => {
  it("test_DW_5_1_login_exchanges_code_for_tokens", async () => {
    const credFile = tmpCredPath("exchange");
    const capture: { url?: string; body?: Record<string, unknown> } = {};

    const result = await login(
      makeDeps({
        credentialsFilePath: credFile,
        startCallbackServer: codeServer("the-auth-code"),
        fetchFn: exchangeOk(capture),
      }),
    );

    // Exchange hit the right endpoint with the code + a verifier.
    expect(capture.url).toBe(`${BASE_URL}/auth/token/exchange`);
    expect(capture.body?.code).toBe("the-auth-code");
    expect(typeof capture.body?.code_verifier).toBe("string");
    expect((capture.body?.code_verifier as string).length).toBeGreaterThan(0);

    // Refresh token from the body was saved (not anything from a URL).
    expect(result.username).toBe("newuser");
    const saved = fs.readFileSync(credFile, "utf-8");
    expect(saved).toBe("refresh-tok-abc");
  });

  it("test_DW_5_1_login_writes_credentials_0600", async () => {
    const credFile = tmpCredPath("perms");
    await login(
      makeDeps({ credentialsFilePath: credFile, fetchFn: exchangeOk() }),
    );
    const mode = fs.statSync(credFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("test_DW_5_1_login_returns_username_from_exchange", async () => {
    const credFile = tmpCredPath("uname");
    const result = await login(
      makeDeps({ credentialsFilePath: credFile, fetchFn: exchangeOk() }),
    );
    expect(result.username).toBe("newuser");
    expect(result.credentialsFilePath).toBe(credFile);
  });

  it("test_DW_5_1_login_agnostic_to_new_vs_returning", async () => {
    // The client cannot tell a new user (browser-onboarding detour) from a
    // returning one — both arrive as a `code`. Same login path, same result.
    const credA = tmpCredPath("new");
    const credB = tmpCredPath("returning");

    const r1 = await login(
      makeDeps({ credentialsFilePath: credA, startCallbackServer: codeServer("code-new"), fetchFn: exchangeOk() }),
    );
    const r2 = await login(
      makeDeps({ credentialsFilePath: credB, startCallbackServer: codeServer("code-returning"), fetchFn: exchangeOk() }),
    );

    expect(r1.username).toBe(r2.username);
    expect(fs.readFileSync(credA, "utf-8")).toBe(fs.readFileSync(credB, "utf-8"));
  });
});

// ─── DW-5.1 / DW-5.2: auth URL targets unified entry, carries no tokens ────────

describe("DW-5.1/5.2: buildAuthUrl targets the unified flow", () => {
  it("test_DW_5_1_auth_url_targets_unified_entry", () => {
    const url = buildAuthUrl({
      apiBaseUrl: BASE_URL,
      redirectUri: "http://127.0.0.1:51234/callback",
      codeChallenge: "challenge-abc",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/auth/google");
    expect(parsed.searchParams.get("flow")).toBe("local");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51234/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("test_DW_5_2_auth_url_has_no_tokens", () => {
    const url = buildAuthUrl({
      apiBaseUrl: BASE_URL,
      redirectUri: "http://127.0.0.1:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(url).not.toMatch(/access_token/i);
    expect(url).not.toMatch(/refresh_token/i);
    // The verifier (PKCE secret) must never appear in the URL — only the challenge.
    expect(url).not.toMatch(/code_verifier/i);
  });
});

// ─── DW-5.2: no tokens in logs ────────────────────────────────────────────────

describe("DW-5.2: tokens never logged", () => {
  it("test_DW_5_2_no_tokens_logged", async () => {
    const credFile = tmpCredPath("nolog");
    const logged: string[] = [];

    await login(
      makeDeps({
        credentialsFilePath: credFile,
        startCallbackServer: codeServer("auth-code-secret"),
        fetchFn: exchangeOk(),
        log: (m) => logged.push(m),
      }),
    );

    const joined = logged.join("\n");
    expect(joined).not.toContain("access-tok-xyz");
    expect(joined).not.toContain("refresh-tok-abc");
    // The auth code and PKCE verifier are secrets too.
    expect(joined).not.toContain("auth-code-secret");
    expect(joined).not.toMatch(/code_verifier/i);
  });
});

// ─── DW-5.6: failed exchange / abandon / network — no partial credentials ──────

describe("DW-5.6: failure paths leave no partial credentials", () => {
  it("test_DW_5_6_exchange_401_no_credentials", async () => {
    const credFile = tmpCredPath("ex401");
    let closed = false;

    const fetchFn = async () =>
      new Response(
        JSON.stringify({ error: "PKCE verification failed", code: "invalid_grant" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );

    await expect(
      login(
        makeDeps({
          credentialsFilePath: credFile,
          startCallbackServer: codeServer("stale-code", () => {
            closed = true;
          }),
          fetchFn,
        }),
      ),
    ).rejects.toThrow(/login again/i);

    expect(closed).toBe(true);
    expect(fs.existsSync(credFile)).toBe(false);
  });

  it("test_DW_5_6_exchange_400_expired_code_actionable", async () => {
    const credFile = tmpCredPath("ex400");
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ error: "Invalid or expired authorization code", code: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    await expect(
      login(makeDeps({ credentialsFilePath: credFile, fetchFn })),
    ).rejects.toThrow(/login again/i);
    expect(fs.existsSync(credFile)).toBe(false);
  });

  it("test_DW_5_6_callback_error_clean_failure", async () => {
    const credFile = tmpCredPath("cberr");
    let closed = false;

    await expect(
      login(
        makeDeps({
          credentialsFilePath: credFile,
          startCallbackServer: errorServer("account_banned", () => {
            closed = true;
          }),
          // fetch should never be called — the flow fails before exchange.
          fetchFn: async () => {
            throw new Error("exchange must not run after a callback error");
          },
        }),
      ),
    ).rejects.toThrow(/account_banned/);

    expect(closed).toBe(true);
    expect(fs.existsSync(credFile)).toBe(false);
  });

  it("test_DW_5_6_exchange_network_failure_no_partial", async () => {
    const credFile = tmpCredPath("net");
    let closed = false;

    const fetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      login(
        makeDeps({
          credentialsFilePath: credFile,
          startCallbackServer: codeServer("code-x", () => {
            closed = true;
          }),
          fetchFn,
        }),
      ),
    ).rejects.toThrow();

    expect(closed).toBe(true);
    expect(fs.existsSync(credFile)).toBe(false);
  });
});
