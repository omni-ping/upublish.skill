import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../lib/core.ts";
import type { HashProgress, UploadProgress } from "../lib/core.ts";
import { formatBytes } from "./format.ts";

/** The slice of the SDK's request-handler `extra` that progress reporting needs. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ProgressNotification) => Promise<void>;
}

/** Wires `publish()` progress callbacks to MCP `notifications/progress`, plus a heartbeat between file events. */
export interface ProgressReporter {
  /** Undefined unless the client supplied a progressToken. */
  onHashProgress?: (p: HashProgress) => void;
  /** Undefined unless the client supplied a progressToken. */
  onProgress?: (p: UploadProgress) => void;
  /** Stops the heartbeat timer. Safe to call multiple times. */
  stop(): void;
}

type Counts = { completed: number; total: number; completedBytes: number; totalBytes: number };

const sizeLine = (p: Counts): string =>
  `${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)} (${p.completed}/${p.total} files)`;

/**
 * Progress + heartbeat for one publish call. A single timer starts on the first event of either phase and
 * re-emits the latest snapshot every `intervalMs`, so a long gap between file completions never goes silent.
 */
export function createProgressReporter(extra: ProgressExtra | undefined, intervalMs: number): ProgressReporter {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra) return { stop() {} };

  let lastProgress: UploadProgress | null = null;
  let lastHashProgress: HashProgress | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Sends one best-effort notification. A dropped one (client gone, transport closed) must never break the publish. */
  function sendProgress(p: Counts, message: string): void {
    // Drive the percentage off bytes when we have them; fall back to file counts when every
    // needed file is zero-length (totalBytes === 0 would divide by zero).
    const useBytes = p.totalBytes > 0;
    extra!
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: progressToken as string | number,
          progress: useBytes ? p.completedBytes : p.completed,
          total: useBytes ? p.totalBytes : p.total,
          message,
        },
      })
      .catch((err: unknown) => log(`[publish] progress notification failed: ${(err as Error).message}`));
  }

  // Heartbeat equivalence: this one tick serves both phases. Before, a timer started by the first upload event
  // (no earlier hash event) had no hash branch; here the hash branch runs only while lastHashProgress is
  // non-null, and onProgress clears it at the phase transition. The output is identical unless a hash event
  // arrives after an upload event, which publish() never does (hashing finishes before the manifest call).
  function tick(): void {
    if (lastProgress !== null) {
      sendProgress(lastProgress, `${sizeLine(lastProgress)} — still uploading…`);
    } else if (lastHashProgress !== null) {
      const hashDone = lastHashProgress.completed === lastHashProgress.total;
      sendProgress(
        lastHashProgress,
        hashDone ? "preparing upload…" : `Hashing ${sizeLine(lastHashProgress)} — still hashing…`,
      );
    }
  }

  const startHeartbeat = (): void => {
    timer ??= setInterval(tick, intervalMs);
  };

  return {
    onHashProgress(p) {
      lastHashProgress = p;
      sendProgress(p, `Hashing ${sizeLine(p)}`);
      startHeartbeat();
    },
    onProgress(p) {
      lastHashProgress = null; // phase transition: the heartbeat now says "still uploading…"
      lastProgress = p;
      sendProgress(p, sizeLine(p));
      startHeartbeat();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
