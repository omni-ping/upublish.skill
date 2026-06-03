/**
 * Tests for retry classification in uploadChangedFiles / uploadOneFile.
 *
 * DW-5.1: A 403 on a presigned PUT fails immediately with an actionable message;
 *         5xx/network errors still retry up to the cap.
 */

import { describe, it, expect } from "bun:test";
import { uploadChangedFiles } from "./publish.ts";
import type { FetchFn } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a FetchFn that returns the given statuses in sequence, then 200. */
function makeSequenceFetch(statuses: number[]): { fetchFn: FetchFn; callCount: () => number } {
  let calls = 0;
  const fetchFn: FetchFn = async (_url, _init) => {
    const status = statuses[calls] ?? 200;
    calls++;
    return new Response("", { status });
  };
  return { fetchFn, callCount: () => calls };
}

/** Builds a FetchFn that always returns the given status. */
function makeConstantFetch(status: number): { fetchFn: FetchFn; callCount: () => number } {
  return makeSequenceFetch(Array(10).fill(status));
}

/** Builds a FetchFn that throws a network error on every call. */
function makeNetworkErrorFetch(): { fetchFn: FetchFn; callCount: () => number } {
  let calls = 0;
  const fetchFn: FetchFn = async (_url, _init) => {
    calls++;
    throw new Error("Network error");
  };
  return { fetchFn, callCount: () => calls };
}

const SAMPLE_FILE = { path: "index.html", upload_url: "https://r2.example.com/presigned" };
const SAMPLE_FILE_MAP: Record<string, Uint8Array> = {
  "index.html": new TextEncoder().encode("<h1>Hello</h1>"),
};

// ─── DW-5.1: 403 fails immediately ────────────────────────────────────────────

describe("DW-5.1: uploadOneFile — 403 fails immediately", () => {
  it("test_DW_5_1_403_fails_immediately_with_actionable_message", async () => {
    const { fetchFn, callCount } = makeConstantFetch(403);

    await expect(
      uploadChangedFiles({
        needed: [SAMPLE_FILE],
        fileMap: SAMPLE_FILE_MAP,
        fetchFn,
      }),
    ).rejects.toThrow(/presigned URL expired/);

    // Only 1 attempt — no retries on 403
    expect(callCount()).toBe(1);
  });

  it("test_DW_5_1_403_error_message_names_upload_window", async () => {
    const { fetchFn } = makeConstantFetch(403);

    let errorMessage = "";
    try {
      await uploadChangedFiles({
        needed: [SAMPLE_FILE],
        fileMap: SAMPLE_FILE_MAP,
        fetchFn,
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    // Must mention the file name and the upload window duration
    expect(errorMessage).toContain("index.html");
    expect(errorMessage).toMatch(/6.hour|6-hour/i);
    expect(errorMessage).toContain("403");
  });

  it("test_DW_5_1_200_ok_succeeds_first_attempt", async () => {
    const { fetchFn, callCount } = makeConstantFetch(200);

    await uploadChangedFiles({
      needed: [SAMPLE_FILE],
      fileMap: SAMPLE_FILE_MAP,
      fetchFn,
    });

    expect(callCount()).toBe(1);
  });
});

// ─── DW-5.1: 5xx retries up to the cap ───────────────────────────────────────

describe("DW-5.1: uploadOneFile — 5xx retries to cap", () => {
  it("test_DW_5_1_5xx_retries_to_cap", async () => {
    // UPLOAD_MAX_RETRIES is 3 — all 3 attempts return 500
    const { fetchFn, callCount } = makeConstantFetch(500);

    await expect(
      uploadChangedFiles({
        needed: [SAMPLE_FILE],
        fileMap: SAMPLE_FILE_MAP,
        fetchFn,
      }),
    ).rejects.toThrow(/3 attempt/);

    // Should have made exactly 3 attempts
    expect(callCount()).toBe(3);
  });

  it("test_DW_5_1_5xx_succeeds_after_transient_failure", async () => {
    // First attempt 500, second succeeds
    const { fetchFn, callCount } = makeSequenceFetch([500, 200]);

    await uploadChangedFiles({
      needed: [SAMPLE_FILE],
      fileMap: SAMPLE_FILE_MAP,
      fetchFn,
    });

    expect(callCount()).toBe(2);
  });

  it("test_DW_5_1_503_retries_to_cap", async () => {
    const { fetchFn, callCount } = makeConstantFetch(503);

    await expect(
      uploadChangedFiles({
        needed: [SAMPLE_FILE],
        fileMap: SAMPLE_FILE_MAP,
        fetchFn,
      }),
    ).rejects.toThrow(/3 attempt/);

    expect(callCount()).toBe(3);
  });

  it("test_DW_5_1_network_error_retries", async () => {
    const { fetchFn, callCount } = makeNetworkErrorFetch();

    await expect(
      uploadChangedFiles({
        needed: [SAMPLE_FILE],
        fileMap: SAMPLE_FILE_MAP,
        fetchFn,
      }),
    ).rejects.toThrow();

    // Network errors should also retry to the cap
    expect(callCount()).toBe(3);
  });
});
