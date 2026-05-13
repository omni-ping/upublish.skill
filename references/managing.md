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

Deletion is **permanent and immediate**. There is no undo. Confirm with the user before deleting.

## Updating a site

There is no "update" tool — republish to the same slug to replace the site entirely. Use `mcp_upublish_publish` with the same slug. All previous files are replaced.

## Checking site status

After publishing, you can verify a site is live by noting the production URL returned by the publish tool. The URL format is always `https://{username}.upubli.sh/{slug}/`.

If a user asks "is my site working?" — the best answer is to tell them the URL and suggest they visit it. The MCP tools don't have a health-check endpoint.
