# Troubleshooting

## "MCP tools not found"

The upublish MCP server isn't registered. The plugin needs to be installed and the session restarted. Check `.mcp.json` in the project root for an `upublish` entry under `mcpServers`.

## "Not authenticated" or authentication errors

Credentials have expired or the credentials file is missing. The MCP server reads a refresh token from `~/.upublish/credentials`.

**Fix:** Call the `login` tool to re-authenticate — this opens a browser for Google sign-in. Tell the user what's happening ("Your session expired, opening the browser to re-authenticate").

## "Invalid slug"

Slug must be 3-63 characters: lowercase letters, numbers, and hyphens only. Must start and end with a letter or number.

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
