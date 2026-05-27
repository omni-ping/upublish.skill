/**
 * Thin HTTP client for the upubli.sh API.
 *
 * Handles Bearer token injection via an async token provider and parses JSON
 * responses. All methods throw an Error with a human-readable message on
 * non-2xx responses.
 *
 * The token provider is called before every request, allowing transparent
 * token refresh without any change to callers.
 *
 * Designed for dependency injection in tests — pass a mock fetchFn and a
 * mock tokenProvider to avoid real network calls.
 */

import type { FetchFn, TokenProvider, Site } from "./types.ts";
import { log } from "./log.ts";

export class ApiClient {
  constructor(
    /** API base URL, e.g. https://api.upubli.sh */
    private readonly baseUrl: string,
    /** Async function that returns a fresh Bearer token for each request. */
    private readonly tokenProvider: TokenProvider,
    /** Injectable fetch function (defaults to global fetch). */
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** GET request — returns parsed JSON body. */
  async get<T>(path: string): Promise<T> {
    const token = await this.tokenProvider();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    return this.parseResponse<T>(response);
  }

  /** POST request with a JSON body — returns parsed JSON body. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.tokenProvider();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return this.parseResponse<T>(response);
  }

  /** PUT request with a JSON body — returns parsed JSON body. */
  async put<T>(path: string, body: unknown): Promise<T> {
    const token = await this.tokenProvider();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return this.parseResponse<T>(response);
  }

  /** DELETE request — returns parsed JSON body. */
  async delete<T>(path: string): Promise<T> {
    const token = await this.tokenProvider();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    return this.parseResponse<T>(response);
  }

  /**
   * POST manifest request — sends the client's file manifest to the server,
   * which diffs against the previous version and returns presigned PUT URLs
   * for files that need to be uploaded.
   *
   * @param nsId   - Namespace ID.
   * @param slug   - Site slug.
   * @param body   - Manifest payload: files array plus optional publish options.
   * @returns Needed files with presigned URLs, session ID, and version numbers.
   * @throws Error on non-2xx (propagated from parseResponse).
   */
  async manifest(
    nsId: string,
    slug: string,
    body: {
      files: Array<{ path: string; hash: string; size: number }>;
      title?: string;
      visibility?: string;
      passcode?: string;
      passcode_label?: string;
      preview?: boolean;
    },
  ): Promise<{
    needed: Array<{ path: string; upload_url: string }>;
    version: number;
    session_id: string;
    base_version: number | null;
  }> {
    // Server expects files as Record<path, {hash, size}>, not an Array.
    const filesRecord: Record<string, { hash: string; size: number }> = {};
    for (const f of body.files) {
      filesRecord[f.path] = { hash: f.hash, size: f.size };
    }
    const result = await this.post<{
      needed: Array<{ path: string; upload_url: string }>;
      version: number;
      session_id: string;
      base_version: number | null;
    }>(
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/manifest`,
      { ...body, files: filesRecord },
    );
    log(`[manifest] version=${result.version} session_id=${result.session_id} base_version=${result.base_version} needed=${result.needed.length}`);
    return result;
  }

  /**
   * POST finalize request — tells the server all uploads are complete.
   * The server verifies uploads, creates DB records, and goes live.
   *
   * @param nsId       - Namespace ID.
   * @param slug       - Site slug.
   * @param sessionId  - Session ID returned by the manifest endpoint.
   * @returns Publish result identical to the full-upload publish response.
   * @throws Error if files are missing (422), session expired (404), or other error.
   */
  async finalize(
    nsId: string,
    slug: string,
    sessionId: string,
  ): Promise<{ site: Site; url: string; preview_url?: string }> {
    const result = await this.post<{ site: Site; url: string; preview_url?: string }>(
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/finalize`,
      { session_id: sessionId },
    );
    log(`[finalize] slug=${slug} url=${result.url} preview_url=${result.preview_url ?? "none"}`);
    return result;
  }

  /** Parses a fetch Response, throwing a descriptive Error on non-2xx. */
  private async parseResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    let errorMessage: string;
    let rawBody = "";
    try {
      rawBody = await response.text();
      const body = JSON.parse(rawBody) as { error?: string };
      errorMessage = body.error ?? response.statusText;
    } catch {
      errorMessage = response.statusText;
    }

    log(`[api] status=${response.status} body=${rawBody || response.statusText}`);
    throw new Error(`API error ${response.status}: ${errorMessage}`);
  }
}
