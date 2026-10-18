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

const hex4 = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

export const hasControlChars = (s: string): boolean => CONTROL_RE.test(s);

/** JSON string literal (quoted) with every control character escaped as \uXXXX or its JSON short form. */
export const quoteText = (s: string): string =>
  JSON.stringify(s).replace(CONTROL_RE_G, hex4);

/** The text as-is when it is a clean single line, otherwise its quoted/escaped form. */
export const safeText = (s: unknown): string => {
  const text = String(s);
  return hasControlChars(text) ? quoteText(text) : text;
};

/** Every control character except `\n`, the formatters' own line break. */
const NON_NEWLINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Final output pass, the boundary every site-data formatter result and error
 * message goes through before leaving lib. Escapes as `\uXXXX` every control
 * character except `\n`, so no field (row data, labels, subjects, server text)
 * can add a line break that a line-splitter would honour (CR, NEL, LS, PS) or
 * smuggle other terminal control bytes.
 *
 * It cannot tell a formatter's `\n` from a `\n` inside a field, so per-field
 * `safeText` / `quoteText` stay responsible for keeping `\n` out of fields.
 */
export const sanitizeOutput = (text: string): string => text.replace(NON_NEWLINE_CONTROL_RE, hex4);
