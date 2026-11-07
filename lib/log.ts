import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function log(msg: string): void {
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
