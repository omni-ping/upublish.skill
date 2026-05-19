#!/usr/bin/env bun
/**
 * upublish CLI entry point.
 *
 * Subcommands: login, publish, list, delete, status, configure, hello, mcp
 *
 * Each exported run*Command function accepts args and injectable deps so
 * tests can call them directly without spawning a subprocess.
 *
 * Deps bags carry optional core function overrides — no ApiClient, no
 * credential reads, no token provider construction in this file.
 *
 * When run as the main module, citty's runMain() wires up real deps and
 * process.argv.
 */

import { defineCommand, runMain } from "citty";
import open from "open";
import {
  list,
  publish,
  deleteOp,
  login as coreLogin,
  status as coreStatus,
  logout as coreLogout,
  addPasscode as coreAddPasscode,
  listPasscodes as coreListPasscodes,
  revokePasscode as coreRevokePasscode,
} from "../lib/core.ts";
import type {
  PublishArgs as CorePublishArgs,
  StatusResult,
  LoginDeps,
  LoginResult,
  PublishResult,
  ListResult,
  DeleteResult,
  LogoutResult,
  Visibility,
  AddPasscodeResult,
  ListPasscodesResult,
  RevokePasscodeResult,
} from "../lib/core.ts";

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
async function createCallbackServer(): Promise<import("../lib/auth.ts").CallbackServer> {
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
  label?: string;
  json: boolean;
}

export interface PublishCommandDeps {
  publishFn?: (args: CorePublishArgs) => Promise<PublishResult>;
}

export interface PasscodeAddArgs {
  slug: string;
  passcode: string;
  label: string;
  json: boolean;
}

export interface PasscodeAddCommandDeps {
  addPasscodeFn?: (slug: string, code: string, label: string) => Promise<AddPasscodeResult>;
}

export interface PasscodeListArgs {
  slug: string;
  json: boolean;
}

export interface PasscodeListCommandDeps {
  listPasscodesFn?: (slug: string) => Promise<ListPasscodesResult>;
}

export interface PasscodeRevokeArgs {
  slug: string;
  id?: string;
  label?: string;
  json: boolean;
}

export interface PasscodeRevokeCommandDeps {
  revokePasscodeFn?: (slug: string, opts: { id?: string; label?: string }) => Promise<RevokePasscodeResult>;
}

export interface ListArgs {
  json: boolean;
}

export interface ListCommandDeps {
  listFn?: () => Promise<ListResult>;
}

export interface DeleteArgs {
  slug: string;
  json: boolean;
}

export interface DeleteCommandDeps {
  deleteFn?: (slug: string) => Promise<DeleteResult>;
}

export interface StatusArgs {
  json: boolean;
}

export interface StatusCommandDeps {
  statusFn?: () => Promise<StatusResult>;
}

export interface ConfigureArgs {
  platform: string;
}

export interface ConfigureCommandDeps {
  execFn?: (command: string, args: string[]) => Promise<{ exitCode: number }>;
}

export interface HelloArgs {}

export interface HelloCommandDeps {
  statusFn?: () => Promise<StatusResult>;
}

export interface LogoutArgs {
  json: boolean;
}

export interface LogoutCommandDeps {
  logoutFn?: () => Promise<LogoutResult>;
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
  const loginFn = deps.loginFn ?? coreLogin;

  const result = await loginFn({
    apiBaseUrl: process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh",
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
 * Delegates entirely to core.publish() — no auth logic here.
 * core.publish() throws "Not authenticated" if no credentials are stored.
 */
export async function runPublishCommand(
  args: PublishArgs,
  deps: PublishCommandDeps = {},
): Promise<void> {
  const publishFn = deps.publishFn ?? publish;

  try {
    const result = await publishFn({
      directory: args.dir,
      slug: args.slug,
      title: args.title,
      visibility: args.visibility as Visibility | undefined,
      passcode: args.passcode,
      passcodeLabel: args.label,
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
 * Delegates entirely to core.list() — no auth logic here.
 */
export async function runListCommand(
  args: ListArgs,
  deps: ListCommandDeps = {},
): Promise<void> {
  const listFn = deps.listFn ?? list;

  try {
    const result = await listFn();

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
 * Delegates entirely to core.deleteOp() — no auth logic here.
 */
export async function runDeleteCommand(
  args: DeleteArgs,
  deps: DeleteCommandDeps = {},
): Promise<void> {
  const deleteFn = deps.deleteFn ?? deleteOp;

  try {
    const result = await deleteFn(args.slug);

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
 * Runs the status subcommand.
 * Delegates entirely to core.status() — no auth logic here.
 */
export async function runStatusCommand(
  args: StatusArgs,
  deps: StatusCommandDeps = {},
): Promise<void> {
  const statusFn = deps.statusFn ?? coreStatus;
  const result = await statusFn();

  if (result.authenticated) {
    if (args.json) {
      console.log(JSON.stringify({ authenticated: true, username: result.username }));
    } else {
      console.log(green("Authenticated"));
      console.log(`Logged in as: ${bold(result.username)}`);
    }
    return;
  }

  // Not authenticated
  if (args.json) {
    console.log(
      JSON.stringify({
        authenticated: false,
        error: "error" in result ? result.error : "No credentials found",
      }),
    );
  } else {
    console.log(red("Not authenticated. No credentials found."));
    console.log("Run `upublish login` to sign in.");
  }
  process.exit(1);
}

// ─── Passcode subcommand runners ─────────────────────────────────────────────

/**
 * Runs the passcode add subcommand.
 * Adds a new passcode to a passcode-protected site.
 */
export async function runPasscodeAddCommand(
  args: PasscodeAddArgs,
  deps: PasscodeAddCommandDeps = {},
): Promise<void> {
  const addFn = deps.addPasscodeFn ?? ((slug, code, label) => coreAddPasscode(slug, code, label));

  try {
    const result = await addFn(args.slug, args.passcode, args.label);

    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(green(`Passcode added to ${bold(args.slug)}`));
      console.log(`  ID:    ${result.passcode.id}`);
      console.log(`  Label: ${result.passcode.label}`);
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Runs the passcode list subcommand.
 * Lists all passcodes for a site.
 */
export async function runPasscodeListCommand(
  args: PasscodeListArgs,
  deps: PasscodeListCommandDeps = {},
): Promise<void> {
  const listFn = deps.listPasscodesFn ?? ((slug) => coreListPasscodes(slug));

  try {
    const result = await listFn(args.slug);

    if (args.json) {
      console.log(JSON.stringify(result));
      return;
    }

    if (result.passcodes.length === 0) {
      console.log(`No passcodes found for ${bold(args.slug)}.`);
      return;
    }

    console.log(bold(`Passcodes for ${args.slug} (${result.passcodes.length}):`));
    console.log(`  ${"ID".padEnd(36)}  ${"Label".padEnd(24)}  Created`);
    console.log(`  ${"-".repeat(36)}  ${"-".repeat(24)}  -------`);
    for (const pc of result.passcodes) {
      const created = new Date(pc.created_at).toLocaleDateString();
      console.log(`  ${pc.id.padEnd(36)}  ${pc.label.padEnd(24)}  ${created}`);
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Runs the passcode revoke subcommand.
 * Removes a passcode by ID or label.
 */
export async function runPasscodeRevokeCommand(
  args: PasscodeRevokeArgs,
  deps: PasscodeRevokeCommandDeps = {},
): Promise<void> {
  const revokeFn =
    deps.revokePasscodeFn ??
    ((slug, opts) => coreRevokePasscode(slug, opts));

  if (!args.id && !args.label) {
    console.log(red("Error: Either --id or --label must be provided."));
    process.exit(1);
  }

  try {
    const result = await revokeFn(args.slug, { id: args.id, label: args.label });

    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      const identifier = args.id ? `id=${args.id}` : `label="${args.label}"`;
      console.log(green(`Passcode revoked from ${bold(args.slug)} (${identifier})`));
    }
  } catch (err) {
    console.log(red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ─── Platform install commands ──────────────────────────────────────────────

const PLATFORM_COMMANDS: Record<string, { command: string; args: string[] }> = {
  claude: { command: "claude", args: ["plugin", "install", "omni-ping/upublish.skill"] },
  gemini: { command: "gemini", args: ["extensions", "install", "omni-ping/upublish.skill"] },
  codex: { command: "npx", args: ["skills", "add", "omni-ping/upublish.skill", "-g", "--agent", "codex"] },
};

const VALID_PLATFORMS = Object.keys(PLATFORM_COMMANDS);

/**
 * Default exec function using Bun.spawn with inherited stdio.
 * Array-based args — no shell interpretation.
 */
async function defaultExecFn(command: string, args: string[]): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([command, ...args], { stdio: ["inherit", "inherit", "inherit"] });
  const exitCode = await proc.exited;
  return { exitCode };
}

/**
 * Runs the configure subcommand.
 * Installs the upublish plugin for the specified platform.
 * Does not require authentication.
 */
export async function runConfigureCommand(
  args: ConfigureArgs,
  deps: ConfigureCommandDeps = {},
): Promise<void> {
  const execFn = deps.execFn ?? defaultExecFn;
  const platformEntry = PLATFORM_COMMANDS[args.platform];

  if (!platformEntry) {
    console.log(red(`Unknown platform: "${args.platform}"`));
    console.log(`Valid platforms: ${VALID_PLATFORMS.join(", ")}`);
    process.exit(1);
  }

  console.log(`Configuring upublish for ${bold(args.platform)}...`);
  console.log(`Running: ${platformEntry.command} ${platformEntry.args.join(" ")}`);

  const result = await execFn(platformEntry.command, platformEntry.args);

  if (result.exitCode !== 0) {
    console.log(red(`Configuration failed (exit code ${result.exitCode}).`));
    console.log(`Try running the command manually: ${platformEntry.command} ${platformEntry.args.join(" ")}`);
    process.exit(1);
  }

  console.log(green(`upublish configured for ${args.platform}!`));
}

/**
 * Runs the hello subcommand.
 * Checks auth status and prints a welcome message with the username.
 * If not authenticated, directs user to `upublish login`.
 */
export async function runHelloCommand(
  _args: HelloArgs,
  deps: HelloCommandDeps = {},
): Promise<void> {
  const statusFn = deps.statusFn ?? coreStatus;
  const result = await statusFn();

  if (result.authenticated) {
    console.log(green(`Welcome, ${bold(result.username)}!`));
    console.log("Your upublish setup is working.");
    console.log("");
    console.log("Coming soon: personalized MBTI-based publishing flow.");
    return;
  }

  console.log(red("Not authenticated."));
  console.log("Run `upublish login` to sign in first.");
  process.exit(1);
}

/**
 * Runs the logout subcommand.
 * Revokes the refresh token server-side (best-effort) and deletes local credentials.
 */
export async function runLogoutCommand(
  args: LogoutArgs,
  deps: LogoutCommandDeps = {},
): Promise<void> {
  const logoutFn = deps.logoutFn ?? coreLogout;
  const result = await logoutFn();

  if (result.loggedOut) {
    if (args.json) {
      console.log(JSON.stringify({ loggedOut: true }));
    } else {
      console.log(green("Logged out."));
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ loggedOut: false, error: result.error }));
  } else {
    console.log(red(`Logout failed: ${result.error}`));
  }
  process.exit(1);
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
    visibility: { type: "string", description: "Visibility: public, unlisted, passcode" },
    passcode: { type: "string", description: "Passcode (required when visibility=passcode)" },
    label: { type: "string", description: "Label for the initial passcode (defaults to \"default\")" },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runPublishCommand({
      dir: args.dir,
      slug: args.slug,
      title: args.title,
      visibility: args.visibility,
      passcode: args.passcode,
      label: args.label,
      json: args.json,
    });
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List your published sites" },
  args: {
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runListCommand({ json: args.json });
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a published site" },
  args: {
    slug: { type: "positional", description: "Slug of site to delete", required: true },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runDeleteCommand({ slug: args.slug, json: args.json });
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Check authentication status" },
  args: {
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runStatusCommand({ json: args.json });
  },
});

const mcpCmd = defineCommand({
  meta: { name: "mcp", description: "Start the MCP stdio server (used by AI assistants)" },
  async run() {
    const { createServer } = await import("../mcp/index.ts");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  },
});

const configureCmd = defineCommand({
  meta: { name: "configure", description: "Install upublish plugin for your AI platform" },
  args: {
    platform: {
      type: "string",
      description: "Platform to configure: claude, gemini, codex",
      required: true,
    },
  },
  async run({ args }) {
    await runConfigureCommand({ platform: args.platform });
  },
});

const helloCmd = defineCommand({
  meta: { name: "hello", description: "Confirm your setup is working and say hello" },
  async run() {
    await runHelloCommand({});
  },
});

const logoutCmd = defineCommand({
  meta: { name: "logout", description: "Sign out and revoke credentials" },
  args: {
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runLogoutCommand({ json: args.json });
  },
});

// ─── Passcode subcommand group ────────────────────────────────────────────────

const passcodeAddCmd = defineCommand({
  meta: { name: "add", description: "Add a passcode to a site" },
  args: {
    slug: { type: "positional", description: "Site slug", required: true },
    passcode: { type: "string", description: "Passcode string", required: true },
    label: { type: "string", description: "Human-readable label (e.g. \"Client A\")", required: true },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runPasscodeAddCommand({
      slug: args.slug,
      passcode: args.passcode,
      label: args.label,
      json: args.json,
    });
  },
});

const passcodeListCmd = defineCommand({
  meta: { name: "list", description: "List passcodes for a site" },
  args: {
    slug: { type: "positional", description: "Site slug", required: true },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runPasscodeListCommand({ slug: args.slug, json: args.json });
  },
});

const passcodeRevokeCmd = defineCommand({
  meta: { name: "revoke", description: "Revoke a passcode from a site" },
  args: {
    slug: { type: "positional", description: "Site slug", required: true },
    id: { type: "string", description: "Passcode ID to revoke" },
    label: { type: "string", description: "Passcode label to revoke" },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    await runPasscodeRevokeCommand({
      slug: args.slug,
      id: args.id,
      label: args.label,
      json: args.json,
    });
  },
});

const passcodeCmd = defineCommand({
  meta: { name: "passcode", description: "Manage passcodes for passcode-protected sites" },
  subCommands: {
    add: passcodeAddCmd,
    list: passcodeListCmd,
    revoke: passcodeRevokeCmd,
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
    logout: logoutCmd,
    status: statusCmd,
    publish: publishCmd,
    list: listCmd,
    delete: deleteCmd,
    passcode: passcodeCmd,
    configure: configureCmd,
    hello: helloCmd,
    mcp: mcpCmd,
  },
});

// Only run when executed as the main module (not imported in tests)
if (import.meta.main) {
  runMain(main);
}
