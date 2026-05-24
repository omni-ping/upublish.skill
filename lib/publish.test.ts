/**
 * Tests for lib/publish.ts — core publish logic (zip + upload + exclusion).
 *
 * Covers DW-1.2: lib/publish.ts exports publish(opts) that zips a directory
 *   and uploads to API, returns { url, site }.
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { publish, buildZipFromDirectory, isValidSlug, parseIgnoreFile } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

const SAMPLE_SITE = {
  id: "uuid-1",
  user_id: "user-1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 2,
  total_size: 1234,
  visibility: "public" as const,
  passcode_hash: null,
};

const SAMPLE_URL = "https://testuser.upubli.sh/my-site/";

/** Creates a mock fetch that returns a JSON response. */
function mockFetch(
  status: number,
  body: unknown,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

// ─── buildZipFromDirectory unit tests ────────────────────────────────────────

describe("buildZipFromDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-zip-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty Uint8Array for an empty directory", () => {
    const result = buildZipFromDirectory(tmpDir);
    expect(result.zipBytes.byteLength).toBe(0);
    expect(result.fileCount).toBe(0);
  });

  it("returns non-empty zip bytes for a directory with files", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body { margin: 0; }");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.zipBytes.byteLength).toBeGreaterThan(0);
    expect(result.fileCount).toBe(2);
    // ZIP files start with the PK magic bytes (0x50 0x4B)
    expect(result.zipBytes[0]).toBe(0x50);
    expect(result.zipBytes[1]).toBe(0x4b);
  });

  it("recursively includes files from subdirectories", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "subdir", "script.js"), "console.log('hi');");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.zipBytes.byteLength).toBeGreaterThan(0);
    expect(result.fileCount).toBe(2);
  });

  it("excludes .git directory", () => {
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, ".git", "config"), "gitconfig");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain(".git/");
  });

  it("excludes node_modules directory", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "dep.js"), "module");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain("node_modules/");
  });

  it("excludes .DS_Store and Thumbs.db", () => {
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, "Thumbs.db"), "");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain(".DS_Store");
    expect(result.excluded).toContain("Thumbs.db");
  });

  it("excludes .env files", () => {
    writeFileSync(join(tmpDir, ".env"), "SECRET=abc");
    writeFileSync(join(tmpDir, ".env.local"), "SECRET=local");
    writeFileSync(join(tmpDir, ".env.production"), "SECRET=prod");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain(".env");
    expect(result.excluded).toContain(".env.local");
    expect(result.excluded).toContain(".env.production");
  });

  it("excludes .pem and .key files", () => {
    writeFileSync(join(tmpDir, "cert.pem"), "-----BEGIN CERT-----");
    writeFileSync(join(tmpDir, "private.key"), "-----BEGIN KEY-----");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain("cert.pem");
    expect(result.excluded).toContain("private.key");
  });

  it("excludes .upublishignore itself", () => {
    writeFileSync(join(tmpDir, ".upublishignore"), "extra.txt");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain(".upublishignore");
  });

  it("warns about suspicious files", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "nginx.conf"), "server {}");
    writeFileSync(join(tmpDir, "README.md"), "# Readme");
    writeFileSync(join(tmpDir, "deploy.sh"), "#!/bin/bash");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(4);
    expect(result.warnings).toContain("nginx.conf");
    expect(result.warnings).toContain("README.md");
    expect(result.warnings).toContain("deploy.sh");
  });

  it("applies .upublishignore patterns", () => {
    writeFileSync(join(tmpDir, ".upublishignore"), "extra.txt\n*.log\n");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "extra.txt"), "should be excluded");
    writeFileSync(join(tmpDir, "debug.log"), "log output");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain("extra.txt");
    expect(result.excluded).toContain("debug.log");
  });

  it("applies .upublishignore directory patterns", () => {
    writeFileSync(join(tmpDir, ".upublishignore"), "scripts/\n");
    mkdirSync(join(tmpDir, "scripts"));
    writeFileSync(join(tmpDir, "scripts", "deploy.sh"), "#!/bin/bash");
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = buildZipFromDirectory(tmpDir);
    expect(result.fileCount).toBe(1);
    expect(result.excluded).toContain("scripts/");
  });
});

// ─── parseIgnoreFile unit tests ─────────────────────────────────────────────

describe("parseIgnoreFile", () => {
  it("parses lines, skipping comments and blanks", () => {
    const content = "# comment\n\nfoo.txt\n*.log\n  bar/  \n";
    expect(parseIgnoreFile(content)).toEqual(["foo.txt", "*.log", "bar/"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseIgnoreFile("")).toEqual([]);
    expect(parseIgnoreFile("# only comments\n# here")).toEqual([]);
  });
});

// ─── isValidSlug unit tests ─────────────────────────────────────────────────

describe("isValidSlug", () => {
  it("accepts valid slugs", () => {
    expect(isValidSlug("abc")).toBe(true);
    expect(isValidSlug("my-site")).toBe(true);
    expect(isValidSlug("my-awesome-portfolio-2026")).toBe(true);
    expect(isValidSlug("a1b")).toBe(true);
  });

  it("rejects too-short slugs", () => {
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("a")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidSlug("My-Site")).toBe(false);
  });

  it("rejects slugs starting or ending with hyphen", () => {
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("bad-")).toBe(false);
  });

  it("rejects too-long slugs", () => {
    expect(isValidSlug("a".repeat(64))).toBe(false);
  });

  it("rejects _root (format rules only — publish() handles the bypass)", () => {
    expect(isValidSlug("_root")).toBe(false);
  });
});

// ─── DW-1.2: publish function ───────────────────────────────────────────────

describe("DW-1.2: publish", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-publish-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_2_publish_zips_and_uploads", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns-test/sites`);
    expect(capturedMethod).toBe("POST");
    expect(result.url).toBe(SAMPLE_URL);
    expect(result.site.slug).toBe("my-site");
  });

  it("test_DW_1_2_publish_returns_url_and_site", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(201, { site: SAMPLE_SITE, url: SAMPLE_URL }),
    );

    const result = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    expect(result.url).toBe(SAMPLE_URL);
    expect(result.site).toBeDefined();
    expect(result.site.slug).toBe("my-site");
    expect(result.site.file_count).toBe(2);
  });

  it("test_DW_1_2_publish_validates_directory", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      publish({
        apiClient,
        nsId: "ns-test",
        directory: "/nonexistent/path/xyz",
        slug: "my-site",
      }),
    ).rejects.toThrow("does not exist");
  });

  it("test_DW_1_2_publish_validates_slug", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      publish({ apiClient, nsId: "ns-test", directory: tmpDir, slug: "ab" }),
    ).rejects.toThrow("Invalid slug");
  });

  it("test_DW_1_2_publish_rejects_empty_dir", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      publish({ apiClient, nsId: "ns-test", directory: tmpDir, slug: "my-site" }),
    ).rejects.toThrow("empty");
  });

  it("test_DW_1_2_publish_validates_passcode_required", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      publish({
        apiClient,
        nsId: "ns-test",
        directory: tmpDir,
        slug: "my-site",
        visibility: "passcode",
      }),
    ).rejects.toThrow("passcode is required");
  });

  it("rejects file path as directory", async () => {
    const filePath = join(tmpDir, "not-a-dir.txt");
    writeFileSync(filePath, "hello");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      publish({ apiClient, nsId: "ns-test", directory: filePath, slug: "my-site" }),
    ).rejects.toThrow("not a directory");
  });

  it("propagates API upload errors", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(400, { error: "Slug already taken" }),
    );

    await expect(
      publish({ apiClient, nsId: "ns-test", directory: tmpDir, slug: "my-site" }),
    ).rejects.toThrow("Slug already taken");
  });

  it("uses slug as default title when title not provided", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({ apiClient, nsId: "ns-test", directory: tmpDir, slug: "my-site" });

    expect(capturedForm).toBeInstanceOf(FormData);
    expect((capturedForm as FormData).get("title")).toBe("my-site");
  });

  it("passes visibility and passcode when provided", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      visibility: "passcode",
      passcode: "secret123",
    });

    expect((capturedForm as FormData | null)?.get("visibility")).toBe(
      "passcode",
    );
    expect((capturedForm as FormData | null)?.get("passcode")).toBe(
      "secret123",
    );
  });

  it("test_DW_5_1_publish_sends_default_label_when_visibility_passcode", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      visibility: "passcode",
      passcode: "mycode",
    });

    // When no label is provided and visibility=passcode, label defaults to "default"
    expect((capturedForm as FormData | null)?.get("passcode_label")).toBe("default");
  });

  it("test_DW_5_2_publish_sends_custom_label_when_provided", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      visibility: "passcode",
      passcode: "mycode",
      passcodeLabel: "Client A",
    });

    expect((capturedForm as FormData | null)?.get("passcode_label")).toBe("Client A");
  });

  it("does not send passcode_label when visibility is not passcode", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      visibility: "public",
    });

    expect((capturedForm as FormData | null)?.get("passcode_label")).toBeNull();
  });

  it("accepts _root as a slug (bypasses format validation)", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const rootSite = { ...SAMPLE_SITE, slug: "_root" };
    const rootUrl = "https://testuser.upubli.sh/";

    let capturedForm: FormData | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: rootSite, url: rootUrl }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "_root",
    });

    expect(result.url).toBe(rootUrl);
    expect(result.site.slug).toBe("_root");
    expect((capturedForm as FormData)?.get("slug")).toBe("_root");
  });

  it("returns warnings for suspicious files", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, "nginx.conf"), "server {}");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(201, { site: SAMPLE_SITE, url: SAMPLE_URL }),
    );

    const result = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    expect(result.warnings).toContain("nginx.conf");
  });

  it("returns excluded files list", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, ".DS_Store"), "");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(201, { site: SAMPLE_SITE, url: SAMPLE_URL }),
    );

    const result = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    expect(result.excluded).toContain(".DS_Store");
  });
});
