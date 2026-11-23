/**
 * Pure path-safety checks for the site export (R10, R11). The server's file list is hostile input: these
 * functions decide, without touching the disk, whether a path is safe and whether any two collide.
 */

const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;


/** Why `p` is not a safe relative file path, or null when it is. Pure. */
export function validateExportPath(p: unknown): string | null {
  if (typeof p !== "string" || p === "") return "empty path";
  if (Buffer.byteLength(p) > MAX_PATH_BYTES) return `path longer than ${MAX_PATH_BYTES} bytes`;
  if (CONTROL_RE.test(p)) return "control or NUL character";
  if (p.includes("\\")) return "backslash";
  if (p.includes(":")) return "colon (drive letter or alternate data stream)";
  if (p.startsWith("/")) return "absolute path";
  for (const seg of p.split("/")) {
    if (seg === "") return "empty path segment";
    if (seg === ".") return "'.' segment";
    if (seg === "..") return "'..' segment";
    if (Buffer.byteLength(seg) > MAX_SEGMENT_BYTES) return `segment longer than ${MAX_SEGMENT_BYTES} bytes`;
    if (seg.endsWith(".") || seg.endsWith(" ")) return "segment ends with a dot or space";
    if (WINDOWS_RESERVED.test(seg.split(".")[0]!.trimEnd())) return "Windows reserved name";
  }
  return null;
}

/** Case-fold + canonical-normalise: two paths with the same key are the same file on a case/normalisation-folding disk. */
export function foldKey(p: string): string {
  return p.normalize("NFD").toLowerCase().normalize("NFD");
}

/**
 * First collision across the whole path set, or null: case-fold / NFC-NFD duplicates (`A.html` vs `a.html`)
 * and file-vs-directory prefixes (`a` and `a/b`).
 */
export function findPathCollision(paths: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const k = foldKey(p);
    const prev = seen.get(k);
    if (prev !== undefined) return `${JSON.stringify(p)} collides with ${JSON.stringify(prev)}`;
    seen.set(k, p);
  }
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join("/");
      const hit = seen.get(foldKey(prefix));
      if (hit !== undefined) return `${JSON.stringify(hit)} is a file but ${JSON.stringify(p)} needs it to be a directory`;
    }
  }
  return null;
}

/** Short, quoted, control-free rendering of an untrusted path for messages. */
export function show(p: unknown): string {
  const s = JSON.stringify(typeof p === "string" ? p : String(p));
  return s.length > 200 ? `${s.slice(0, 200)}..."` : s;
}

