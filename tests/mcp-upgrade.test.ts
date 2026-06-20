/**
 * MCP `upgrade` tool tests + the free-tier tier-limit 403 publish hint.
 *
 * Drives the registered tool handlers via McpServer._registeredTools with an
 * injected mock fetch (CoreDeps) and an injected openBrowser (CreateServerOpts)
 * so no real browser is launched.
 *
 * Covers:
 *   DW-2.2: `upgrade` tool registered with {plan?,interval?} defaulting pro/month;
 *           on success openBrowser is called once with the checkout URL and the
 *           response includes that URL.
 *   DW-2.3: when openBrowser throws, the tool response still contains the URL +
 *           "open manually" text (no crash).
 *   DW-2.4: a tier-limit 403 (limit+usage, no code) from publish includes the
 *           run-`upgrade` hint; a hard_max 403 does NOT.
 *   DW-2.5: invalid plan/interval args → structured error, no checkout call.
 */

import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type InternalServer = { _registeredTools: Record<string, RegisteredTool> };

const REFRESH_TOKEN = "test-refresh-token";
const DEFAULT_NS_ID = "ns-default";

function writeTempCredentials(): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-upgrade-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, REFRESH_TOKEN, { mode: 0o600 });
  return tmpFile;
}

function getTools(server: ReturnType<typeof createServer>): Record<string, RegisteredTool> {
  return (server as unknown as InternalServer)._registeredTools;
}

/** Base mock fetch: token refresh + namespace resolution. Extend via `extra`. */
function baseFetch(
  extra: (url: string, init?: RequestInit) => Response | null,
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) && init?.method !== "POST") {
      return new Response(
        JSON.stringify({ namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const handled = extra(url, init);
    if (handled) return handled;
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

// ─── DW-2.2: upgrade tool registration + success path ────────────────────────

describe("DW-2.2: upgrade tool registered and opens checkout URL", () => {
  test("test_DW_2_2_upgrade_tool_registered", () => {
    const credFile = writeTempCredentials();
    try {
      const server = createServer({ credentialsPath: credFile });
      expect("upgrade" in getTools(server)).toBe(true);
    } finally {
      fs.unlinkSync(credFile);
    }
  });

  test("test_DW_2_2_default_args_post_pro_month_and_open_once", async () => {
    const credFile = writeTempCredentials();
    let checkoutBody: Record<string, unknown> | undefined;
    const opened: string[] = [];
    const fetchFn = baseFetch((url, init) => {
      if (url.endsWith("/api/billing/checkout") && init?.method === "POST") {
        checkoutBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ url: "https://checkout.stripe/sess", sessionId: "cs_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer(
        { credentialsPath: credFile, fetchFn } as CoreDeps,
        { openBrowser: async (u) => { opened.push(u); } },
      );
      const result = await getTools(server)["upgrade"].handler({});

      // Defaults applied client-side.
      expect(checkoutBody).toEqual({ plan: "pro", interval: "month" });
      // openBrowser called exactly once with the checkout URL.
      expect(opened).toEqual(["https://checkout.stripe/sess"]);
      // Response includes the URL.
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("https://checkout.stripe/sess");
    } finally {
      fs.unlinkSync(credFile);
    }
  });

  test("test_DW_2_2_explicit_args_posted_through", async () => {
    const credFile = writeTempCredentials();
    let checkoutBody: Record<string, unknown> | undefined;
    const fetchFn = baseFetch((url, init) => {
      if (url.endsWith("/api/billing/checkout") && init?.method === "POST") {
        checkoutBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ url: "https://checkout.stripe/max", sessionId: "cs_2" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer(
        { credentialsPath: credFile, fetchFn } as CoreDeps,
        { openBrowser: async () => {} },
      );
      await getTools(server)["upgrade"].handler({ plan: "max", interval: "year" });
      expect(checkoutBody).toEqual({ plan: "max", interval: "year" });
    } finally {
      fs.unlinkSync(credFile);
    }
  });
});

// ─── DW-2.3: openBrowser throws → URL still in response, no crash ─────────────

describe("DW-2.3: upgrade tool survives an openBrowser failure", () => {
  test("test_DW_2_3_open_throws_still_returns_url_with_manual_text", async () => {
    const credFile = writeTempCredentials();
    const fetchFn = baseFetch((url, init) => {
      if (url.endsWith("/api/billing/checkout") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ url: "https://checkout.stripe/headless", sessionId: "cs_3" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer(
        { credentialsPath: credFile, fetchFn } as CoreDeps,
        { openBrowser: async () => { throw new Error("no DISPLAY"); } },
      );
      const result = await getTools(server)["upgrade"].handler({});

      // No crash; response carries the URL and the manual-open guidance.
      const text = result.content[0].text;
      expect(text).toContain("https://checkout.stripe/headless");
      expect(text).toMatch(/manually/i);
    } finally {
      fs.unlinkSync(credFile);
    }
  });
});

// ─── DW-2.5: invalid args → structured error, no checkout call ────────────────

describe("DW-2.5: upgrade tool rejects invalid args before any checkout call", () => {
  test("test_DW_2_5_invalid_plan_no_checkout_call", async () => {
    const credFile = writeTempCredentials();
    let checkoutCalled = false;
    const fetchFn = baseFetch((url, init) => {
      if (url.endsWith("/api/billing/checkout") && init?.method === "POST") {
        checkoutCalled = true;
        return new Response(JSON.stringify({ url: "x" }), { status: 200 });
      }
      return null;
    });

    try {
      const server = createServer(
        { credentialsPath: credFile, fetchFn } as CoreDeps,
        { openBrowser: async () => {} },
      );
      // zod enum rejects "free" at the schema boundary OR startUpgrade rejects it;
      // either way no checkout call may fire. Drive the handler directly with the
      // invalid value (bypassing schema) to prove the lib-level guard holds too.
      const result = await getTools(server)["upgrade"].handler({ plan: "free" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/invalid plan/i);
      expect(checkoutCalled).toBe(false);
    } finally {
      fs.unlinkSync(credFile);
    }
  });
});

// ─── DW-2.4: publish tier-limit 403 → run-`upgrade` hint (and hard_max → not) ─

describe("DW-2.4: publish tier-limit 403 includes the upgrade hint", () => {
  /** Writes a one-file site dir and returns its path. */
  function makeSiteDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upgrade-pub-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    return dir;
  }

  test("test_DW_2_4_publish_tier_limit_403_adds_upgrade_hint", async () => {
    const credFile = writeTempCredentials();
    const dir = makeSiteDir();
    const fetchFn = baseFetch((url, init) => {
      if (url.includes("/manifest") && init?.method === "POST") {
        // Free-tier file-size tier-limit 403: limit + usage, NO code.
        return new Response(
          JSON.stringify({
            error: "File exceeds the free-tier 25 MB limit.",
            limit: 26214400,
            usage: 405798912,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer({ credentialsPath: credFile, fetchFn } as CoreDeps);
      const result = await getTools(server)["publish"].handler({ directory: dir, slug: "my-site" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/run the `upgrade` tool/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.unlinkSync(credFile);
    }
  });

  test("test_DW_2_4_publish_hard_max_403_no_hint", async () => {
    const credFile = writeTempCredentials();
    const dir = makeSiteDir();
    const fetchFn = baseFetch((url, init) => {
      if (url.includes("/manifest") && init?.method === "POST") {
        // 1 TiB ceiling: carries code "hard_max" → upgrade can't lift it.
        return new Response(
          JSON.stringify({
            error: "Storage ceiling reached. limit exceeded.",
            code: "hard_max",
            limit: 1099511627776,
            usage: 1099511627777,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer({ credentialsPath: credFile, fetchFn } as CoreDeps);
      const result = await getTools(server)["publish"].handler({ directory: dir, slug: "my-site" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toMatch(/run the `upgrade` tool/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.unlinkSync(credFile);
    }
  });

  test("test_DW_2_4_publish_admin_auth_403_no_hint", async () => {
    const credFile = writeTempCredentials();
    const dir = makeSiteDir();
    const fetchFn = baseFetch((url, init) => {
      if (url.includes("/manifest") && init?.method === "POST") {
        // An auth/ownership 403 carries no limit/usage → no hint.
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return null;
    });

    try {
      const server = createServer({ credentialsPath: credFile, fetchFn } as CoreDeps);
      const result = await getTools(server)["publish"].handler({ directory: dir, slug: "my-site" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toMatch(/run the `upgrade` tool/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.unlinkSync(credFile);
    }
  });
});
