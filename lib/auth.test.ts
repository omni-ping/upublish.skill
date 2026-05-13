/**
 * Tests for lib/auth.ts — authentication, token provider, credential storage.
 *
 * Covers DW-1.6: lib/auth.ts exports login(), createTokenProvider(),
 *   readCredentials(), saveCredentials().
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createTokenProvider,
  readCredentials,
  saveCredentials,
  login,
} from "./auth.ts";
import type { LoginDeps } from "./auth.ts";

const BASE_URL = "https://api.example.com";
const REFRESH_TOKEN = "test-refresh-token-abc";
const ACCESS_TOKEN = "test-access-token-xyz";

// ─── createTokenProvider tests (DW-1.6) ─────────────────────────────────────

describe("DW-1.6: createTokenProvider", () => {
  it("test_DW_1_6_create_token_provider_caches", async () => {
    let callCount = 0;

    const fetchFn = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          access_token: `token-${callCount}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tokenProvider = createTokenProvider({
      refreshToken: REFRESH_TOKEN,
      apiBaseUrl: BASE_URL,
      fetchFn,
    });

    const token1 = await tokenProvider();
    const token2 = await tokenProvider();
    const token3 = await tokenProvider();

    // Only one refresh call for three token requests
    expect(callCount).toBe(1);
    expect(token1).toBe("token-1");
    expect(token2).toBe("token-1");
    expect(token3).toBe("token-1");
  });

  it("test_DW_1_6_create_token_provider_refreshes", async () => {
    let callCount = 0;

    const fetchFn = async () => {
      callCount++;
      // Return a token that "expires" in 0 seconds (already past buffer)
      return new Response(
        JSON.stringify({
          access_token: `token-${callCount}`,
          expires_in: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tokenProvider = createTokenProvider({
      refreshToken: REFRESH_TOKEN,
      apiBaseUrl: BASE_URL,
      fetchFn,
    });

    const token1 = await tokenProvider();
    const token2 = await tokenProvider();

    expect(callCount).toBe(2);
    expect(token1).toBe("token-1");
    expect(token2).toBe("token-2");
  });

  it("exchanges refresh token via POST to /auth/token/refresh", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tokenProvider = createTokenProvider({
      refreshToken: REFRESH_TOKEN,
      apiBaseUrl: BASE_URL,
      fetchFn,
    });

    const token = await tokenProvider();

    expect(token).toBe(ACCESS_TOKEN);
    expect(capturedUrl).toBe(`${BASE_URL}/auth/token/refresh`);
    expect(capturedBody.refresh_token).toBe(REFRESH_TOKEN);
  });

  it("throws descriptive error on refresh failure", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });

    const tokenProvider = createTokenProvider({
      refreshToken: "expired-refresh-token",
      apiBaseUrl: BASE_URL,
      fetchFn,
    });

    await expect(tokenProvider()).rejects.toThrow("Token refresh failed: 401");
  });
});

// ─── readCredentials / saveCredentials tests (DW-1.6) ────────────────────────

describe("DW-1.6: readCredentials and saveCredentials", () => {
  const tmpFiles: string[] = [];

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

  it("test_DW_1_6_save_credentials_to_file", async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-save-${Date.now()}`,
    );
    tmpFiles.push(tmpFile);

    await saveCredentials(tmpFile, "my-refresh-token");

    const contents = fs.readFileSync(tmpFile, "utf-8");
    expect(contents).toBe("my-refresh-token");
  });

  it("test_DW_1_6_read_credentials_from_file", async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-read-${Date.now()}`,
    );
    tmpFiles.push(tmpFile);
    fs.writeFileSync(tmpFile, "my-refresh-token\n");

    const token = await readCredentials(tmpFile);
    expect(token).toBe("my-refresh-token");
  });

  it("test_DW_1_6_read_credentials_returns_null_missing", async () => {
    const token = await readCredentials("/definitely/does/not/exist");
    expect(token).toBeNull();
  });

  it("returns null for empty file", async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-empty-${Date.now()}`,
    );
    tmpFiles.push(tmpFile);
    fs.writeFileSync(tmpFile, "");

    const token = await readCredentials(tmpFile);
    expect(token).toBeNull();
  });

  it("creates parent directories when saving", async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `upublish-test-nested-${Date.now()}`,
    );
    const tmpFile = path.join(tmpDir, "credentials");
    tmpFiles.push(tmpFile);

    await saveCredentials(tmpFile, "nested-token");

    const contents = fs.readFileSync(tmpFile, "utf-8");
    expect(contents).toBe("nested-token");

    // Clean up directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── login tests (DW-1.6) ───────────────────────────────────────────────────

describe("DW-1.6: login", () => {
  it("test_DW_1_6_login_orchestrates_oauth", async () => {
    const events: string[] = [];
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-login-${Date.now()}`,
    );

    const deps: LoginDeps = {
      apiBaseUrl: BASE_URL,
      credentialsFilePath: tmpFile,
      openBrowser: async (url: string) => {
        events.push(`open:${url.substring(0, 20)}`);
      },
      startCallbackServer: async () => ({
        port: 12345,
        waitForTokens: async () => ({
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          expires_in: 3600,
          username: "testuser",
        }),
        close: async () => {
          events.push("server:closed");
        },
      }),
      log: (msg: string) => {
        events.push(`log:${msg.substring(0, 30)}`);
      },
    };

    const result = await login(deps);

    // Verify the orchestration happened
    expect(events.some((e) => e.startsWith("open:"))).toBe(true);
    expect(events).toContain("server:closed");
    expect(result.username).toBe("testuser");

    // Verify credentials were saved
    const saved = fs.readFileSync(tmpFile, "utf-8");
    expect(saved).toBe("refresh-tok");

    // Clean up
    fs.unlinkSync(tmpFile);
  });

  it("login returns username and tokens from callback", async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-login2-${Date.now()}`,
    );

    const deps: LoginDeps = {
      apiBaseUrl: BASE_URL,
      credentialsFilePath: tmpFile,
      openBrowser: async () => {},
      startCallbackServer: async () => ({
        port: 12345,
        waitForTokens: async () => ({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          username: "alice",
        }),
        close: async () => {},
      }),
      log: () => {},
    };

    const result = await login(deps);
    expect(result.username).toBe("alice");

    // Clean up
    fs.unlinkSync(tmpFile);
  });

  it("closes callback server even on error", async () => {
    let serverClosed = false;
    const tmpFile = path.join(
      os.tmpdir(),
      `upublish-test-login3-${Date.now()}`,
    );

    const deps: LoginDeps = {
      apiBaseUrl: BASE_URL,
      credentialsFilePath: tmpFile,
      openBrowser: async () => {},
      startCallbackServer: async () => ({
        port: 12345,
        waitForTokens: async () => {
          throw new Error("OAuth error: access_denied");
        },
        close: async () => {
          serverClosed = true;
        },
      }),
      log: () => {},
    };

    await expect(login(deps)).rejects.toThrow("OAuth error: access_denied");
    expect(serverClosed).toBe(true);
  });
});
