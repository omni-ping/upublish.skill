/**
 * QR code generation for published sites.
 *
 * Resolves the site URL via list(), appends ?ref=qr per the QR contract,
 * generates a unicode terminal QR, and writes SVG + PNG files to the target dir.
 *
 * QR contract (docs/qr-contract.md):
 *   - Data: canonical site URL + ?ref=qr
 *   - Error correction: M (medium)
 *   - Quiet zone: library default (4 modules)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import QRCode from "qrcode";
import type { Namespace, Site } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QrCodeArgs {
  /** URL-safe slug of the site to generate a QR for. */
  slug: string;
  /** Optional namespace name. Defaults to the user's default namespace. */
  namespace?: string;
  /** Directory to write qr.svg and qr.png into. Defaults to cwd. */
  outputDir?: string;
}

export interface QrCodeResult {
  /** The encoded URL (canonical site URL + ?ref=qr). */
  siteUrl: string;
  /** Multi-line unicode QR string suitable for terminal/agent display. */
  unicodeQr: string;
  /** Absolute path to the written SVG file. */
  svgPath: string;
  /** Absolute path to the written PNG file. */
  pngPath: string;
}

/** Injectable deps for qrCode() — allows test injection without network calls. */
export interface QrCodeDeps {
  /**
   * Function that lists sites in a namespace.
   * Mirrors the signature of core.list() so core.ts can pass it directly.
   */
  listFn: (namespaceName?: string) => Promise<{ sites: Site[]; namespace: Namespace }>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Generates a QR code for a published site.
 *
 * Resolves the site's canonical URL via listFn, appends ?ref=qr, generates
 * a unicode terminal QR, and writes qr.svg + qr.png to the output dir.
 * Overwrites existing files (QR is deterministic — overwrite is intended).
 *
 * @param args - Slug, optional namespace, optional output dir.
 * @param deps - Injectable deps (listFn for test injection).
 * @returns The encoded URL, unicode QR string, and written file paths.
 * @throws Error if the slug is not found in the namespace.
 * @throws Error if the site has no canonical URL.
 */
export async function qrCode(args: QrCodeArgs, deps: QrCodeDeps): Promise<QrCodeResult> {
  const { slug, namespace, outputDir } = args;
  const { listFn } = deps;

  // Resolve sites in the namespace
  const { sites, namespace: ns } = await listFn(namespace);

  // Find the site by slug
  const site = sites.find((s) => s.slug === slug);
  if (!site) {
    throw new Error(
      `Site '${slug}' not found in namespace '${ns.name}'. ` +
      `Available slugs: ${sites.map((s) => s.slug).join(", ") || "(none)"}`,
    );
  }

  // Validate canonical URL — server-authoritative; must be present
  if (!site.url) {
    throw new Error(
      `Site '${slug}' has no URL. Re-publish the site to get the canonical URL.`,
    );
  }

  // Build the encoded URL per the QR contract: canonical URL + ?ref=qr
  const encodedUrl = `${site.url}?ref=qr`;

  // Generate unicode QR for terminal/agent display
  const unicodeQr = await QRCode.toString(encodedUrl, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });

  // Determine output directory (default: cwd)
  const targetDir = outputDir ?? process.cwd();

  const svgPath = path.join(targetDir, "qr.svg");
  const pngPath = path.join(targetDir, "qr.png");

  // Write SVG via toString (no canvas required)
  const svgContent = await QRCode.toString(encodedUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
  });
  await fs.promises.writeFile(svgPath, svgContent, "utf-8");

  // Write PNG via toFile (qrcode handles canvas internally under Bun)
  await QRCode.toFile(pngPath, encodedUrl, {
    errorCorrectionLevel: "M",
  });

  return { siteUrl: encodedUrl, unicodeQr, svgPath, pngPath };
}
