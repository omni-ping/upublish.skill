import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = join(homedir(), ".upublish");
const LOG_FILE = join(LOG_DIR, "publish.log");

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch {
    // logging must never break the publish flow
  }
}
