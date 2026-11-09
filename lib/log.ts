import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

let fileLogging = true;

/**
 * Process-wide switch for the host log file. A hosted server (createHostedServer) turns it off: its callers'
 * data would otherwise be appended to one file on the backend host. Safe because the backend process never
 * runs the stdio entrypoint, which is the only user of this log. Default on.
 */
export function setFileLogging(enabled: boolean): void {
  fileLogging = enabled;
}

export function log(msg: string): void {
  if (!fileLogging) return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    // Resolved per call (not at import), and from $HOME first (Bun's homedir() ignores later changes to it), so a
    // test can point HOME at a temp dir and never touch the real log.
    const dir = join(process.env.HOME ?? homedir(), ".upublish");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "publish.log"), line);
  } catch {
    // logging must never break the publish flow
  }
}
