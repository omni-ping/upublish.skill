/**
 * Unit tests for mcp/progress.ts (createProgressReporter) and the publish tool's heartbeat-stop guarantees.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { createProgressReporter } from "../mcp/progress.ts";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HB = 30;

function collector() {
  const notes: ProgressNotification[] = [];
  const extra = {
    _meta: { progressToken: "tok" as string | number },
    sendNotification: async (n: ProgressNotification) => {
      notes.push(n);
    },
  };
  return { notes, extra };
}
const msgs = (notes: ProgressNotification[]) => notes.map((n) => n.params.message as string);
const snap = (completed: number, total: number, completedBytes: number, totalBytes: number) => ({
  completed,
  total,
  completedBytes,
  totalBytes,
});

describe("createProgressReporter", () => {
  test("no_progress_token_leaves_both_callbacks_undefined", () => {
    const r = createProgressReporter({ sendNotification: async () => {} }, HB);
    expect(r.onHashProgress).toBeUndefined();
    expect(r.onProgress).toBeUndefined();
    r.stop(); // safe no-op
    expect(createProgressReporter(undefined, HB).onProgress).toBeUndefined();
  });

  test("hash_then_upload_transition_switches_heartbeat_text", async () => {
    const { notes, extra } = collector();
    const r = createProgressReporter(extra, HB);
    r.onHashProgress!(snap(1, 4, 10, 40));
    expect(msgs(notes)[0]).toBe("Hashing 10 B / 40 B (1/4 files)");
    await sleep(HB * 2.5);
    expect(msgs(notes).some((m) => m.endsWith("— still hashing…"))).toBe(true);

    r.onProgress!(snap(0, 2, 0, 2048));
    expect(msgs(notes).at(-1)).toBe("0 B / 2.0 KB (0/2 files)");
    notes.length = 0;
    await sleep(HB * 2.5);
    r.stop();
    expect(notes.length).toBeGreaterThanOrEqual(1);
    for (const m of msgs(notes)) expect(m).toEndWith("— still uploading…");
  });

  test("finished_hashing_heartbeat_says_preparing_upload", async () => {
    const { notes, extra } = collector();
    const r = createProgressReporter(extra, HB);
    r.onHashProgress!(snap(3, 3, 30, 30));
    await sleep(HB * 2.5);
    r.stop();
    expect(msgs(notes)).toContain("preparing upload…");
  });

  test("zero_total_bytes_falls_back_to_file_counts", () => {
    const { notes, extra } = collector();
    const r = createProgressReporter(extra, 10_000);
    r.onProgress!(snap(1, 2, 0, 0));
    r.stop();
    expect(notes[0]!.params.progress).toBe(1);
    expect(notes[0]!.params.total).toBe(2);
    expect(notes[0]!.params.progressToken).toBe("tok");
  });

  test("stop_halts_the_heartbeat_and_is_idempotent", async () => {
    const { notes, extra } = collector();
    const r = createProgressReporter(extra, HB);
    r.onProgress!(snap(0, 1, 0, 100));
    r.stop();
    r.stop();
    const n = notes.length;
    await sleep(HB * 3);
    expect(notes.length).toBe(n);
  });

  test("a_rejected_notification_never_throws", async () => {
    const r = createProgressReporter(
      { _meta: { progressToken: 1 }, sendNotification: async () => Promise.reject(new Error("gone")) },
      10_000,
    );
    expect(() => r.onProgress!(snap(0, 1, 0, 1))).not.toThrow();
    await sleep(5);
    r.stop();
  });
});

// ─── Dirty path: the heartbeat stops when the publish fails ──────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("publish tool stops the heartbeat on failure", () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-progress-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hi</h1>");
    credFile = path.join(os.tmpdir(), `mcp-progress-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(credFile, "test-refresh-token", { mode: 0o600 });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(credFile); } catch { /* ignore */ }
  });

  const run = async (manifestOrUpload: (url: string) => Promise<Response | undefined>) => {
    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) return json({ access_token: "t", expires_in: 3600 });
      if (url.includes("/api/space")) return json({ space: { id: "sp", default_namespace_id: "ns", tier: "pro" } });
      if (/\/api\/ns(\?|$)/.test(url)) return json({ namespaces: [{ id: "ns", name: "d", domain: "u.upubli.sh" }] });
      const special = await manifestOrUpload(url);
      if (special) return special;
      if (url.includes("/manifest")) {
        return json({ needed: [{ path: "index.html", upload_url: "https://r2.example.com/presigned/index.html" }], copied: [] });
      }
      return json({});
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn: mockFetch as never };
    const server = createServer(deps, { localFiles: true, heartbeatIntervalMs: HB });
    const publishTool = (server as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
    })._registeredTools["publish"]!;
    const notes: ProgressNotification[] = [];
    const res = await publishTool.handler(
      { directory: tmpDir, slug: "s" },
      { _meta: { progressToken: "tok" }, sendNotification: async (n: ProgressNotification) => void notes.push(n) },
    );
    const atResponse = notes.length;
    await sleep(HB * 5);
    return { res, atResponse, after: notes.length };
  };

  test("upload_fails_midway_then_no_further_notifications", async () => {
    const { res, atResponse, after } = await run(async (url) => {
      if (!url.includes("r2.example.com")) return undefined;
      await sleep(HB * 3); // heartbeats fire while the upload hangs
      throw new Error("connection reset");
    });
    expect(res.isError).toBe(true);
    expect(atResponse).toBeGreaterThanOrEqual(1);
    expect(after).toBe(atResponse);
  });

  test("storage_approval_error_then_no_further_notifications", async () => {
    const { res, atResponse, after } = await run(async (url) => {
      if (!url.includes("/manifest")) return undefined;
      await sleep(HB * 3); // heartbeat (hash phase) fires before the 402
      return json({ code: "needs_storage_approval", approval_url: "https://upubli.sh/approve" }, 402);
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Storage pack approval required");
    expect(atResponse).toBeGreaterThanOrEqual(1);
    expect(after).toBe(atResponse);
  });
});
