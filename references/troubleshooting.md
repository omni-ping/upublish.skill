# Troubleshooting

## "MCP tools not found"

The upublish MCP server isn't registered. The plugin needs to be installed and the session restarted. Check `.mcp.json` in the project root for an `upublish` entry under `mcpServers`.

## "Not authenticated" or authentication errors

Credentials have expired or the credentials file is missing. The MCP server reads a refresh token from `~/.upublish/credentials`.

**Fix:** Call the `login` tool to re-authenticate — this opens the sign-in page in a browser. Tell the user what's happening ("Your session expired, opening the browser to re-authenticate").

## 404 from an auth route, or `login` fails after a plugin update

The sign-in flow was consolidated (provider chooser at `/login`, single-use code + PKCE
exchange) and the old per-provider auth routes were removed. An outdated plugin that still
calls them gets a plain **404**, not a "please upgrade" message. Nothing is wrong with the
account or the server.

**Fix:** Update the upublish plugin to the latest version, then restart the session so the
new MCP server is loaded. After updating, run `login` again; a first-time user is taken
through the browser onboarding page, and a returning user is signed in directly.

## "Invalid slug"

Slug must be 1-255 characters: lowercase letters, numbers, and hyphens only. Must start and end with a letter or number.

**Fix:** Suggest a valid slug based on what the user intended. Don't error out — fix it and confirm.

## "Directory is empty — no files to publish"

The directory had no files after the default exclusions (`.git`, `node_modules`, `.env`, keys, source maps and so on were skipped), or the path points at a folder of empty subfolders.

**Fix:** Verify the directory path points to actual files (`ls -la <dir>`). If the user pointed to a parent directory, look for the build output (e.g., `dist/`, `build/`, `out/`, `public/`).

## "No index.html at the top level of the folder"

`publish` refuses a folder with no top-level `index.html` because visitors to the URL would get a 404. The message names a build folder (`dist/`, `build/`, `out/`) when it finds one.

**Fix:** Publish the build folder. If the folder really is not a web page (a downloads folder), pass `allow_no_index: true`.

## "This looks like a project folder, not a built site"

The folder has two or more repo signals (`package.json`, `tsconfig.json`, a lockfile, `Dockerfile`, `src/`, `.git/`). Publishing it would upload source files.

**Fix:** Build the project and publish the output folder. Pass `allow_project_files: true` only when the user confirms they want the project files public.

## Publish stops with "Storage pack approval required" (402)

The upload would exceed the plan's storage. The message contains an approval URL and the price of the extra storage block. The tool never approves the charge itself.

**Fix:** Give the user the URL and wait for them to approve it in the browser, then retry the publish. No extra flag is needed.

## Storage or file-size limit reached (403)

| Limit | Free | Paid |
|---|---|---|
| Single file | 10 MB | 1 GB |
| Total storage | **100 MB** across all sites | 10 GB (Pro), 100 GB (Max) |

Free accounts have no overage option. Compress or drop large files (`references/optimization.md`), delete sites with `delete`, or use `upgrade`.

## "requires a paid plan" / "requires the Max plan" (403)

Passcode protection, restoring versions, turning analytics off and custom domains need a paid plan; form gates and team members need Max. Tell the user which plan the feature needs and offer `upgrade` (it opens Stripe Checkout; the user enters payment in the browser).

## "Passcode added" but the site is still public

Older plugin versions let `passcode_add` succeed on a public site, where the code was never enforced. Current versions refuse. Fix the site with `visibility(slug, "passcode", passcode: "<code>")` and read back the visibility it prints.

## A published SPA 404s on deep links

SPA mode is per publish. Republish with `spa: true` (see `references/content-types/spa.md`).

## Site published but not loading

Edge metadata propagation takes up to 60 seconds globally. If a passcode-protected site was just published (or its visibility just changed) and isn't enforcing access control yet, wait a minute.

Public sites are available immediately. The Worker serves content when the metadata is missing (fail-open), but returns 503 if storage cannot be read; retry in a moment.

## "Upload failed" or network errors

Check if the API server is reachable:
```bash
curl -s https://api.upubli.sh/health
```

If it returns `{"status":"ok"}`, the issue is likely auth-related. If it's unreachable, tell the user the server is down and to try again later.
