# Troubleshooting

## "MCP tools not found"

The upublish MCP server isn't registered. The plugin needs to be installed and the session restarted. Check `.mcp.json` in the project root for an `upublish` entry under `mcpServers`.

## "Not authenticated" or authentication errors

Credentials have expired or the credentials file is missing. The MCP server reads a refresh token from `~/.upublish/credentials`.

**Fix:** Call the `login` tool to re-authenticate — this opens the sign-in page in a browser. Tell the user what's happening ("Your session expired, opening the browser to re-authenticate").

## "This client version is no longer supported" / HTTP 410 `upgrade_required`

The plugin is calling a retired authentication endpoint. The sign-in flow was
consolidated (provider chooser at `/login`, single-use code + PKCE exchange), and the
old per-flow auth routes now return **HTTP 410** with
`{"error":"This client version is no longer supported — update the upublish plugin","code":"upgrade_required"}`.

This means an **outdated plugin** is installed. Nothing is wrong with the
account or the server.

**Fix:** Update the upublish plugin to the latest version, then restart the
session so the new MCP server is loaded. After updating, run `login` again — a
first-time user will be taken through the browser onboarding page, and a
returning user is signed in directly.

## "Invalid slug"

Slug must be 1-63 characters: lowercase letters, numbers, and hyphens only. Must start and end with a letter or number.

**Fix:** Suggest a valid slug based on what the user intended. Don't error out — fix it and confirm.

## "Archive contains no files"

The directory was empty or contained only subdirectories with no files.

**Fix:** Verify the directory path points to actual files (`ls -la <dir>`). If the user pointed to a parent directory, look for the build output (e.g., `dist/`, `build/`, `out/`, `public/`).

## Site published but not loading

KV metadata propagation takes up to 60 seconds globally. If a passcode-protected site was just published and isn't enforcing access control yet, wait a minute.

Public sites are available immediately — the Worker serves content when KV metadata is missing (fail-open behavior).

## "Upload failed" or network errors

Check if the API server is reachable:
```bash
curl -s https://api.upubli.sh/health
```

If it returns `{"status":"ok"}`, the issue is likely auth-related. If it's unreachable, tell the user the server is down and to try again later.
