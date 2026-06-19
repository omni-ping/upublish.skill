# Managing published sites

## Listing sites

Use `mcp_upublish_list` (no parameters) to see all published sites. Returns each site with:
- Slug, title, production URL
- File count and total size
- Last updated date
- Visibility mode (if not public)

## Deleting a site

Use `mcp_upublish_delete` with the `slug` parameter. This:
- Removes all files from R2 storage
- Deletes the site record from the database
- Removes metadata from KV (so the Worker stops serving it)

Deleting a **whole site** is **permanent and immediate** — it removes the site and every retained version, and there is no undo for a deleted site. Confirm with the user before deleting. (This is distinct from republishing or rolling back a version, which are recoverable — see "Versions and rollback" below.)

## Updating a site

There is no "update" tool — republish to the same slug to serve a new version. Use `mcp_upublish_publish` with the same slug; the new upload replaces the previously live files. The previous version is retained, not lost, so an unwanted republish can be rolled back (see below).

## Versions and rollback

Every publish to a slug is saved as a retained **version**, so you can return a site to an earlier state:

- `mcp_upublish_versions_list` — list a site's versions with each version's number, whether it is currently live, its date, file count, and size. Use this to find the version number to restore.
- `mcp_upublish_versions_restore` — roll the site back to a previous version, making it live again. Takes `slug` and `version` (the number from `versions_list`), plus an optional `namespace`. **Requires a paid plan** (free-tier accounts get a clear "requires a paid plan" message).
- `mcp_upublish_versions_limit` — set or clear how many versions are retained per site. Older versions beyond the limit are pruned; the live version is always kept.
- `mcp_upublish_versions_delete` — delete a single archived (non-live) version to reclaim storage.

## Checking site status

After publishing, you can verify a site is live by noting the production URL returned by the publish tool. The URL format is always `https://{address}.upubli.sh/{slug}/`.

If a user asks "is my site working?" — the best answer is to tell them the URL and suggest they visit it. The MCP tools don't have a health-check endpoint.
