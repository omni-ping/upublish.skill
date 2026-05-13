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

import type { FetchFn, TokenProvider } from "./types.ts";

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

  /**
   * POST request with a multipart FormData body — returns parsed JSON body.
   * Used for file uploads (publish).
   */
  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const token = await this.tokenProvider();
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: formData,
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

  /** Parses a fetch Response, throwing a descriptive Error on non-2xx. */
  private async parseResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    let errorMessage: string;
    try {
      const body = (await response.json()) as { error?: string };
      errorMessage = body.error ?? response.statusText;
    } catch {
      errorMessage = response.statusText;
    }

    throw new Error(`API error ${response.status}: ${errorMessage}`);
  }
}
