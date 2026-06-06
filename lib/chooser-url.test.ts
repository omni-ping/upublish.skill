/**
 * Phase 5 (multi-provider-oauth) — skill login via chooser tests.
 *
 * Covers:
 *   DW-5.1 — login() opens the chooser URL with exactly the five pinned params
 *   DW-5.3 — MCP/CLI copy is provider-neutral (no "Google" in log messages)
 *   DW-5.4 — site URL configurable via UPUBLISH_SITE_URL, default https://upubli.sh;
 *             trailing slash yields no double-slash
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAuthUrl, login } from "./auth.ts";
import type { LoginDeps, CallbackServer } from "./auth.ts";

const REPO_ROOT = path.join(path.dirname(import.meta.url.replace("file://", "")), "..");

const SITE_URL = "https://site.example.com";
const API_URL = "https://api.example.com";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpCredPath(tag: string): string {
  return path.join(os.tmpdir(), `upublish-p5-chooser-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function codeServer(code: string): () => Promise<CallbackServer> {
  return async () => ({
    port: 12345,
    waitForCode: async () => code,
    close: async () => {},
  });
}

function exchangeOk() {
  return async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        username: "user",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function makeDeps(overrides: Partial<LoginDeps>): LoginDeps {
  return {
    apiBaseUrl: API_URL,
    siteBaseUrl: SITE_URL,
    openBrowser: async () => {},
    startCallbackServer: codeServer("auth-code"),
    log: () => {},
    fetchFn: exchangeOk(),
    ...overrides,
  };
}

// ─── DW-5.1: chooser URL has exactly the five pinned params ───────────────────

describe("DW-5.1: buildAuthUrl emits the chooser URL with five params", () => {
  it("test_DW_5_1_chooser_url_pathname_is_login", () => {
    const url = buildAuthUrl({
      siteBaseUrl: SITE_URL,
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/login");
  });

  it("test_DW_5_1_chooser_url_has_five_params", () => {
    const url = buildAuthUrl({
      siteBaseUrl: SITE_URL,
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    const parsed = new URL(url);
    // All five pinned params must be present
    expect(parsed.searchParams.get("flow")).toBe("local");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:51234/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("intent")).toBe("login");
  });

  it("test_DW_5_1_chooser_url_intent_is_login", () => {
    const url = buildAuthUrl({
      siteBaseUrl: SITE_URL,
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(new URL(url).searchParams.get("intent")).toBe("login");
  });

  it("test_DW_5_1_chooser_url_no_provider_in_path", () => {
    // The chooser URL must not embed a provider (e.g. /auth/google)
    const url = buildAuthUrl({
      siteBaseUrl: SITE_URL,
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(url).not.toContain("/auth/google");
    expect(url).not.toContain("/auth/github");
  });

  it("test_DW_5_1_chooser_url_no_tokens", () => {
    const url = buildAuthUrl({
      siteBaseUrl: SITE_URL,
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(url).not.toMatch(/access_token/i);
    expect(url).not.toMatch(/refresh_token/i);
    expect(url).not.toMatch(/code_verifier/i);
  });

  it("test_DW_5_1_login_opens_chooser_url", async () => {
    const credFile = tmpCredPath("open");
    let capturedUrl = "";

    await login(
      makeDeps({
        credentialsFilePath: credFile,
        openBrowser: async (url) => {
          capturedUrl = url;
        },
      }),
    );

    const parsed = new URL(capturedUrl);
    // Opener receives the chooser URL (site base, /login, five params)
    expect(parsed.hostname).toBe("site.example.com");
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("flow")).toBe("local");
    expect(parsed.searchParams.get("intent")).toBe("login");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri")).toBeTruthy();
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy();

    fs.unlinkSync(credFile);
  });
});

// ─── DW-5.3: provider-neutral copy ────────────────────────────────────────────

describe("DW-5.3: login and MCP copy is provider-neutral", () => {
  it("test_DW_5_3_auth_log_message_is_provider_neutral", async () => {
    const credFile = tmpCredPath("log");
    const logged: string[] = [];

    await login(
      makeDeps({
        credentialsFilePath: credFile,
        log: (m) => logged.push(m),
      }),
    );

    const joined = logged.join("\n");
    // Must not mention a specific provider by name
    expect(joined).not.toMatch(/google/i);
    expect(joined).not.toMatch(/github/i);
    expect(joined).not.toMatch(/microsoft/i);

    fs.unlinkSync(credFile);
  });

  it("test_DW_5_3_mcp_login_description_is_provider_neutral", () => {
    // Read mcp/index.ts as text (no import — preserves hexagonal boundary)
    const mcpSrc = fs.readFileSync(path.join(REPO_ROOT, "mcp", "index.ts"), "utf-8");
    // Locate the login tool registration block
    const loginDescStart = mcpSrc.indexOf('"login"');
    const loginDescEnd = mcpSrc.indexOf("inputSchema", loginDescStart);
    const loginBlock = mcpSrc.slice(loginDescStart, loginDescEnd);
    // The description must not mention "Google" (provider-neutral)
    expect(loginBlock).not.toMatch(/google oauth/i);
  });
});

// ─── DW-5.4: site URL config ──────────────────────────────────────────────────

describe("DW-5.4: siteBaseUrl configures the chooser target", () => {
  it("test_DW_5_4_custom_site_url_used", () => {
    const url = buildAuthUrl({
      siteBaseUrl: "https://custom.example.org",
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(url.startsWith("https://custom.example.org/login")).toBe(true);
  });

  it("test_DW_5_4_trailing_slash_no_double_slash", () => {
    const url = buildAuthUrl({
      siteBaseUrl: "https://upubli.sh/",
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    // No double slash between origin and /login
    expect(url).not.toContain("//login");
    expect(url).toContain("https://upubli.sh/login");
  });

  it("test_DW_5_4_default_site_url_is_upublish", () => {
    // buildAuthUrl with siteBaseUrl = "https://upubli.sh" (the default)
    const url = buildAuthUrl({
      siteBaseUrl: "https://upubli.sh",
      redirectUri: "http://localhost:51234/callback",
      codeChallenge: "challenge-abc",
    });
    expect(url.startsWith("https://upubli.sh/login")).toBe(true);
  });
});
