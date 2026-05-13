#!/usr/bin/env bun
/**
 * upublish CLI entry point.
 *
 * Subcommands: login, publish, list, delete, generate
 *
 * Each exported run*Command function accepts args and injectable deps so
 * tests can call them directly without spawning a subprocess.
 *
 * When run as the main module, citty's runMain() wires up real deps and
 * process.argv.
 */

import { defineCommand, runMain } from "citty";
import open from "open";
import { login, createTokenProvider, readCredentials, defaultCredentialsPath } from "../lib/auth.ts";
import { publish } from "../lib/publish.ts";
import { listSites } from "../lib/list.ts";
import { deleteSite } from "../lib/delete.ts";
import { generate } from "../lib/generate.ts";
import { ApiClient } from "../lib/api-client.ts";
import type { LoginDeps, CallbackServer, LoginResult } from "../lib/auth.ts";
import type { PublishResult } from "../lib/publish.ts";
import type { ListResult } from "../lib/list.ts";
import type { DeleteResult } from "../lib/delete.ts";
import type { GenerateResult, GenerateOpts } from "../lib/generate.ts";
import type { PublishOpts } from "../lib/publish.ts";
import type { Visibility } from "../lib/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh";

// ─── ANSI color helpers ───────────────────────────────────────────────────────

/** Wraps a string in ANSI green escape codes. */
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

/** Wraps a string in ANSI red escape codes. */
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

/** Wraps a string in ANSI bold escape codes. */
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

// ─── Callback server (for OAuth login) ───────────────────────────────────────

/**
 * Creates a localhost HTTP server that waits for the OAuth callback redirect.
 * The server reads tokens from query params on the /callback path.
 * Returns port, a promise that resolves on first callback, and a close fn.
 */
async function createCallbackServer(): Promise<CallbackServer> {
  let resolveTokens: (tokens: import("../lib/auth.ts").TokenResponse) => void;
  let rejectTokens: (err: Error) => void;

  const tokenPromise = new Promise<import("../lib/auth.ts").TokenResponse>(
    (resolve, reject) => {
      resolveTokens = resolve;
      rejectTokens = reject;
    },
  );

  // Find an available port by binding on 0 and reading the assigned port
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const accessToken = url.searchParams.get("access_token");
        const refreshToken = url.searchParams.get("refresh_token");
        const expiresIn = url.searchParams.get("expires_in");
        const username = url.searchParams.get("username");
        const error = url.searchParams.get("error");

        if (error) {
          rejectTokens(new Error(`OAuth error: ${error}`));
          return new Response(
            "<html><body><h2>Authentication failed.</h2><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!accessToken || !refreshToken || !expiresIn || !username) {
          rejectTokens(new Error("OAuth callback missing required parameters"));
          return new Response(
            "<html><body><h2>Authentication error.</h2><p>Missing parameters. You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        resolveTokens({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: parseInt(expiresIn, 10),
          username,
        });

        return new Response(
          "<html><body><h2>Authenticated!</h2><p>You can close this tab and return to your terminal.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    port: server.port,
    waitForTokens: () => tokenPromise,
    close: async () => server.stop(),
  };
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

/**
 * Reads credentials and returns an ApiClient.
 * Returns null if no credentials are stored (caller should check and exit 1).
 */
async function loadApiClient(): Promise<ApiClient | null> {
  const credFile = defaultCredentialsPath();
  const refreshToken = await readCredentials(credFile);
  if (!refreshToken) return null;

  const tokenProvider = createTokenProvider({
    refreshToken,
    apiBaseUrl: API_BASE_URL,
  });

  return new ApiClient(API_BASE_URL, tokenProvider);
}

// ─── Command args and deps types ─────────────────────────────────────────────

export interface LoginArgs {
  json: boolean;
}

export interface LoginCommandDeps {
  loginFn?: (deps: LoginDeps) => Promise<LoginResult>;
}

export interface PublishArgs {
  dir: string;
  slug: string;
  title?: string;
  visibility?: string;
  passcode?: string;
  json: boolean;
}

export interface PublishCommandDeps {
  apiClient: ApiClient | null;
  publishFn?: (opts: PublishOpts) => Promise<PublishResult>;
}

export interface ListArgs {
  json: boolean;
}

export interface ListCommandDeps {
  apiClient: ApiClient | null;
  listFn?: (apiClient: ApiClient) => Promise<ListResult>;
}

export interface DeleteArgs {
  slug: string;
  json: boolean;
}

export interface DeleteCommandDeps {
  apiClient: ApiClient | null;
  deleteFn?: (apiClient: ApiClient, slug: string) => Promise<DeleteResult>;
}

export interface GenerateArgs {
  context: string;
  diagramType?: string;
  slug?: string;
  json: boolean;
}

export interface GenerateCommandDeps {
  apiClient: ApiClient | null;
  generateFn?: (opts: GenerateOpts) => Promise<GenerateResult>;
}

// ─── Subcommand runners (exported for testing) ───────────────────────────────

/**
 * Runs the login subcommand.
 * Opens browser for Google OAuth, waits for tokens, stores credentials.
 */
export async function runLoginCommand(
  args: LoginArgs,
  deps: LoginCommandDeps = {},
): Promise<void> {
  const loginFn = deps.loginFn ?? login;

  const result = await loginFn({
    apiBaseUrl: API_BASE_URL,
    openBrowser: (url) => open(url).then(() => undefined),
    startCallbackServer: createCallbackServer,
    log: (msg) => console.log(msg),
  });

  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(green(`Logged in as: ${bold(result.username)}`));
    console.log(`Credentials stored at: ${result.credentialsFilePath}`);
  }
}

/**
 * Runs the publish subcommand.
 * Validates authentication, zips directory, uploads to API, prints URL.
 */
export async function runPublishCommand(
  args: PublishArgs,
  deps: PublishCommandDeps,
): Promise<void> {
  // Auth guard
  if (!deps.apiClient) {
    console.log(red("Not logged in. Run `upublish login` first."));
    process.exit(1);
  }

  const publishFn = deps.publishFn ?? publish;

  try {
    const result = await publishFn({
      apiClient: deps.apiClient,
      directory: args.dir,
      slug: args.slug,
      title: args.title,
      visibility: args.visibility as Visibility | undefined,
      passcode: args.passcode,
    });

    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(green("Published!"));
      console.log(bold(result.url));
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Runs the list subcommand.
 * Fetches all sites and prints them formatted, or a "no sites" message.
 */
export async function runListCommand(
  args: ListArgs,
  deps: ListCommandDeps,
): Promise<void> {
  // Auth guard
  if (!deps.apiClient) {
    console.log(red("Not logged in. Run `upublish login` first."));
    process.exit(1);
  }

  const listFn = deps.listFn ?? listSites;

  try {
    const result = await listFn(deps.apiClient);

    if (args.json) {
      console.log(JSON.stringify(result));
      return;
    }

    if (result.sites.length === 0) {
      console.log("No sites found.");
      return;
    }

    console.log(bold(`${result.sites.length} site(s):`));
    for (const site of result.sites) {
      const url = site.url ?? `https://${site.slug}.upubli.sh`;
      console.log(`  ${bold(site.slug)}  ${url}`);
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Runs the delete subcommand.
 * Deletes the named site and prints confirmation.
 */
export async function runDeleteCommand(
  args: DeleteArgs,
  deps: DeleteCommandDeps,
): Promise<void> {
  // Auth guard
  if (!deps.apiClient) {
    console.log(red("Not logged in. Run `upublish login` first."));
    process.exit(1);
  }

  const deleteFn = deps.deleteFn ?? deleteSite;

  try {
    const result = await deleteFn(deps.apiClient, args.slug);

    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(green(`Deleted: ${bold(args.slug)}`));
      if (result.message) console.log(result.message);
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Runs the generate subcommand.
 * Generates an Excalidraw diagram from context text and prints the URL.
 */
export async function runGenerateCommand(
  args: GenerateArgs,
  deps: GenerateCommandDeps,
): Promise<void> {
  // Auth guard
  if (!deps.apiClient) {
    console.log(red("Not logged in. Run `upublish login` first."));
    process.exit(1);
  }

  const generateFn = deps.generateFn ?? generate;

  try {
    const result = await generateFn({
      apiClient: deps.apiClient,
      context: args.context,
      diagramType: args.diagramType as GenerateOpts["diagramType"],
      slug: args.slug,
    });

    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(green("Generated!"));
      console.log(bold(result.url));
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ─── citty subcommand definitions ────────────────────────────────────────────

const loginCmd = defineCommand({
  meta: { name: "login", description: "Authenticate with upubli.sh via Google OAuth" },
  args: {
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runLoginCommand({ json: args.json });
  },
});

const publishCmd = defineCommand({
  meta: { name: "publish", description: "Publish a directory to upubli.sh" },
  args: {
    dir: { type: "positional", description: "Directory to publish", required: true },
    slug: { type: "string", description: "Site slug (URL identifier)", required: true },
    title: { type: "string", description: "Site title (defaults to slug)" },
    visibility: { type: "string", description: "Visibility: public, unlisted, passcode, signed, identity" },
    passcode: { type: "string", description: "Passcode (required when visibility=passcode)" },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    const apiClient = await loadApiClient();
    await runPublishCommand(
      {
        dir: args.dir,
        slug: args.slug,
        title: args.title,
        visibility: args.visibility,
        passcode: args.passcode,
        json: args.json,
      },
      { apiClient },
    );
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List your published sites" },
  args: {
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    const apiClient = await loadApiClient();
    await runListCommand({ json: args.json }, { apiClient });
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a published site" },
  args: {
    slug: { type: "positional", description: "Slug of site to delete", required: true },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    const apiClient = await loadApiClient();
    await runDeleteCommand({ slug: args.slug, json: args.json }, { apiClient });
  },
});

const generateCmd = defineCommand({
  meta: { name: "generate", description: "Generate an Excalidraw diagram from context text" },
  args: {
    context: { type: "string", description: "Text description to generate a diagram from", required: true },
    "diagram-type": { type: "string", description: "Diagram type: flowchart, sequence, architecture" },
    slug: { type: "string", description: "Optional slug for the published diagram" },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    const apiClient = await loadApiClient();
    await runGenerateCommand(
      {
        context: args.context,
        diagramType: args["diagram-type"],
        slug: args.slug,
        json: args.json,
      },
      { apiClient },
    );
  },
});

// ─── Main command ─────────────────────────────────────────────────────────────

const pkg = await import("../package.json");

const main = defineCommand({
  meta: {
    name: "upublish",
    version: pkg.version,
    description: "Publish static sites to upubli.sh",
  },
  subCommands: {
    login: loginCmd,
    publish: publishCmd,
    list: listCmd,
    delete: deleteCmd,
    generate: generateCmd,
  },
});

// Only run when executed as the main module (not imported in tests)
if (import.meta.main) {
  runMain(main);
}
