/**
 * Tests for lib/upgrade.ts — the `startUpgrade` orchestrator, the free-tier
 * tier-limit 403 discriminator, and the upgrade-hint appender.
 *
 * Covers:
 *   DW-2.1: startUpgrade posts {plan,interval}, returns structured {url} or
 *           structured error, never throws for expected failures.
 *   DW-2.2: default args post pro/month; on success openBrowser called once
 *           with the URL and the result carries that URL.
 *   DW-2.3: openBrowser throws → result still carries the URL (manual-open path).
 *   DW-2.4: discriminator — tier-limit 403 (limit+usage, no code) gets the hint;
 *           hard_max and admin/auth 403 do not.
 *   DW-2.5: invalid plan/interval → structured error, NO api call.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "./api-client.ts";
import {
  startUpgrade,
  isFreeTierLimit403,
  appendUpgradeHint,
  UPGRADE_HINT,
  type UpgradeApiClient,
} from "./upgrade.ts";

/** A post-only api client stub that records every call and returns `result`. */
function makeApiClient(
  result: unknown | (() => Promise<unknown>),
): { client: UpgradeApiClient; calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client: UpgradeApiClient = {
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body });
      if (typeof result === "function") {
        return (await (result as () => Promise<unknown>)()) as T;
      }
      return result as T;
    },
  };
  return { client, calls };
}

/** A browser opener that records the URLs it was asked to open. */
function makeOpener() {
  const opened: string[] = [];
  return {
    opened,
    open: async (url: string) => {
      opened.push(url);
    },
  };
}

// ─── DW-2.1 / DW-2.2: happy path ────────────────────────────────────────────

describe("DW-2.1/2.2: startUpgrade happy path", () => {
  it("test_DW_2_1_posts_plan_interval_and_returns_url", async () => {
    const { client, calls } = makeApiClient({ url: "https://checkout.stripe/abc", sessionId: "cs_1" });
    const opener = makeOpener();

    const result = await startUpgrade(
      { apiClient: client, openBrowser: opener.open },
      { plan: "max", interval: "year" },
    );

    expect(result).toEqual({ ok: true, url: "https://checkout.stripe/abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/billing/checkout");
    expect(calls[0].body).toEqual({ plan: "max", interval: "year" });
  });

  it("test_DW_2_2_default_args_post_pro_month", async () => {
    const { client, calls } = makeApiClient({ url: "https://checkout.stripe/x" });
    const opener = makeOpener();

    // No args at all — defaults must be applied client-side.
    const result = await startUpgrade({ apiClient: client, openBrowser: opener.open });

    expect(result.ok).toBe(true);
    expect(calls[0].body).toEqual({ plan: "pro", interval: "month" });
  });

  it("test_DW_2_2_success_opens_browser_once_with_url", async () => {
    const { client } = makeApiClient({ url: "https://checkout.stripe/once" });
    const opener = makeOpener();

    const result = await startUpgrade({ apiClient: client, openBrowser: opener.open });

    expect(result).toEqual({ ok: true, url: "https://checkout.stripe/once" });
    expect(opener.opened).toEqual(["https://checkout.stripe/once"]);
  });
});

// ─── DW-2.1: expected failures return structured errors (no throw) ──────────

describe("DW-2.1: expected failures return structured errors", () => {
  it("test_DW_2_1_checkout_400_returns_structured_error_no_throw", async () => {
    const { client } = makeApiClient(async () => {
      throw new ApiError(
        400,
        { error: "You already have an active subscription. Use Manage Billing to change plans." },
        "API error 400: You already have an active subscription. Use Manage Billing to change plans.",
      );
    });
    const opener = makeOpener();

    const result = await startUpgrade({ apiClient: client, openBrowser: opener.open });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Server's message surfaces verbatim within the api client's error string.
      expect(result.error).toContain("already have an active subscription");
    }
    // Browser must NOT open on a failed checkout.
    expect(opener.opened).toEqual([]);
  });

  it("test_DW_2_1_auth_error_returned_as_structured_error", async () => {
    const { client } = makeApiClient(async () => {
      throw new Error("Not authenticated. Use the login tool to sign in.");
    });
    const opener = makeOpener();

    const result = await startUpgrade({ apiClient: client, openBrowser: opener.open });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Not authenticated. Use the login tool to sign in.");
    expect(opener.opened).toEqual([]);
  });

  it("test_DW_2_1_missing_url_in_response_returns_structured_error", async () => {
    // Defensive: a 200 with no usable url must not crash or open a blank page.
    const { client } = makeApiClient({ sessionId: "cs_2" });
    const opener = makeOpener();

    const result = await startUpgrade({ apiClient: client, openBrowser: opener.open });

    expect(result.ok).toBe(false);
    expect(opener.opened).toEqual([]);
  });
});

// ─── DW-2.3: openBrowser throws → URL still returned ────────────────────────

describe("DW-2.3: openBrowser failure still returns the URL", () => {
  it("test_DW_2_3_open_throws_still_returns_url_with_manual_path", async () => {
    const { client } = makeApiClient({ url: "https://checkout.stripe/headless" });
    const failingOpen = async () => {
      throw new Error("no DISPLAY");
    };

    const result = await startUpgrade({ apiClient: client, openBrowser: failingOpen });

    // No unhandled rejection; result is a structured error that still carries the URL.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.url).toBe("https://checkout.stripe/headless");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ─── DW-2.5: invalid args → structured error, no API call ───────────────────

describe("DW-2.5: invalid args produce a structured error with no API call", () => {
  it("test_DW_2_5_invalid_plan_no_api_call", async () => {
    const { client, calls } = makeApiClient({ url: "should-not-be-used" });
    const opener = makeOpener();

    const result = await startUpgrade(
      { apiClient: client, openBrowser: opener.open },
      { plan: "free" }, // "free" is not a checkout plan
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid plan");
    expect(calls).toEqual([]); // NO API call
    expect(opener.opened).toEqual([]);
  });

  it("test_DW_2_5_invalid_interval_no_api_call", async () => {
    const { client, calls } = makeApiClient({ url: "should-not-be-used" });
    const opener = makeOpener();

    const result = await startUpgrade(
      { apiClient: client, openBrowser: opener.open },
      { plan: "pro", interval: "weekly" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid interval");
    expect(calls).toEqual([]);
    expect(opener.opened).toEqual([]);
  });

  it("test_DW_2_5_invalid_plan_checked_before_interval", async () => {
    // Both invalid → plan is validated first (no coercion, no API call).
    const { client, calls } = makeApiClient({ url: "x" });
    const opener = makeOpener();

    const result = await startUpgrade(
      { apiClient: client, openBrowser: opener.open },
      { plan: "PRO", interval: "weekly" }, // wrong case is invalid (no coercion)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid plan");
    expect(calls).toEqual([]);
  });
});

// ─── DW-2.4: tier-limit 403 discriminator ───────────────────────────────────

describe("DW-2.4: isFreeTierLimit403 discriminator", () => {
  it("test_DW_2_4_tier_limit_403_with_limit_usage_no_code_is_true", () => {
    const err = new ApiError(
      403,
      { error: "File exceeds the free-tier limit", limit: 26214400, usage: 405798912 },
      "API error 403: File exceeds the free-tier limit",
    );
    expect(isFreeTierLimit403(err)).toBe(true);
  });

  it("test_DW_2_4_hard_max_403_with_code_is_false", () => {
    const err = new ApiError(
      403,
      { error: "Storage ceiling reached", code: "hard_max", limit: 1, usage: 2 },
      "API error 403: Storage ceiling reached",
    );
    // hard_max carries a `code` → upgrade cannot lift it → excluded.
    expect(isFreeTierLimit403(err)).toBe(false);
  });

  it("test_DW_2_4_admin_or_auth_403_without_limit_usage_is_false", () => {
    const err = new ApiError(
      403,
      { error: "Admin users cannot initiate checkout" },
      "API error 403: Admin users cannot initiate checkout",
    );
    expect(isFreeTierLimit403(err)).toBe(false);
  });

  it("test_DW_2_4_non_403_status_is_false", () => {
    const err = new ApiError(400, { limit: 1, usage: 2 }, "API error 400");
    expect(isFreeTierLimit403(err)).toBe(false);
  });

  it("test_DW_2_4_non_api_error_is_false", () => {
    expect(isFreeTierLimit403(new Error("plain"))).toBe(false);
    expect(isFreeTierLimit403(null)).toBe(false);
    expect(isFreeTierLimit403(undefined)).toBe(false);
  });

  it("test_DW_2_4_403_with_null_body_is_false", () => {
    const err = new ApiError(403, null, "API error 403: forbidden");
    expect(isFreeTierLimit403(err)).toBe(false);
  });
});

describe("DW-2.4: appendUpgradeHint", () => {
  it("test_DW_2_4_appends_hint_on_tier_limit_403", () => {
    const err = new ApiError(403, { limit: 1, usage: 2 }, "msg");
    const out = appendUpgradeHint("Limit reached.", err);
    expect(out).toBe(`Limit reached. ${UPGRADE_HINT}`);
    expect(out).toContain("upgrade");
  });

  it("test_DW_2_4_does_not_append_hint_on_hard_max", () => {
    const err = new ApiError(403, { code: "hard_max", limit: 1, usage: 2 }, "msg");
    const out = appendUpgradeHint("Ceiling reached.", err);
    expect(out).toBe("Ceiling reached.");
    expect(out).not.toContain(UPGRADE_HINT);
  });

  it("test_DW_2_4_does_not_append_hint_on_admin_auth_403", () => {
    const err = new ApiError(403, { error: "forbidden" }, "msg");
    const out = appendUpgradeHint("Forbidden.", err);
    expect(out).toBe("Forbidden.");
  });
});
