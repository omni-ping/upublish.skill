/**
 * Rendering of server- or visitor-supplied free text into multi-line tool
 * output that an AI reads and may act on.
 *
 * A raw newline inside such a string could forge an extra line (for example a
 * fake `author:` line that steers a later `data_rows delete --author`).
 * Every renderer here therefore guarantees the result occupies one physical
 * line: control characters never pass through unescaped.
 */

/** C0 controls, DEL, C1 controls, NEL, and the Unicode line/paragraph separators. */
const CONTROL_CLASS = "[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]";
const CONTROL_RE = new RegExp(CONTROL_CLASS);
const CONTROL_RE_G = new RegExp(CONTROL_CLASS, "g");

export const hasControlChars = (s: string): boolean => CONTROL_RE.test(s);

/** JSON string literal (quoted) with every control character escaped as \uXXXX or its JSON short form. */
export const quoteText = (s: string): string =>
  JSON.stringify(s).replace(CONTROL_RE_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The text as-is when it is a clean single line, otherwise its quoted/escaped form. */
export const safeText = (s: unknown): string => {
  const text = String(s);
  return hasControlChars(text) ? quoteText(text) : text;
};
