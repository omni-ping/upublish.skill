import type { CallbackServer } from "../lib/core.ts";

// ─── Callback server (for OAuth login) ───────────────────────────────────────

/**
 * Creates a localhost HTTP server that waits for the unified OAuth callback.
 * The unified flow redirects back with a single-use authorization `code` (or an
 * `error`) on the /callback path — never tokens. The server resolves with that
 * code; login() exchanges it for tokens out of band. New users finish browser
 * onboarding first, so this may wait a while; there is no hard timeout.
 * Returns port, a promise that resolves with the code, and a close fn.
 */
export async function createCallbackServer(): Promise<CallbackServer> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          rejectCode(new Error(`OAuth error: ${error}`));
          return new Response(
            "<html><body><h2>Sign-in failed.</h2><p>You can close this tab and return to your terminal.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!code) {
          rejectCode(new Error("OAuth callback missing the authorization code"));
          return new Response(
            "<html><body><h2>Sign-in error.</h2><p>Missing authorization code. You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        resolveCode(code);

        return new Response(
          "<html><body><h2>Signed in!</h2><p>You can close this tab and return to your terminal.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    port: server.port as number, // always set once Bun.serve({ port: 0 }) is listening
    waitForCode: () => codePromise,
    close: async () => server.stop(),
  };
}
