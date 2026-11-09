# Managing published sites

## Listing sites

Use `list` (no parameters) to see all published sites. Returns each site with:
- Slug, title, production URL
- File count and total size
- Last updated date
- Visibility mode (if not public)

## Deleting a site

Use `delete` with the `slug` parameter. This:
- Removes all files from R2 storage
- Deletes the site record from the database
- Removes metadata from KV (so the Worker stops serving it)

Deleting a **whole site** is **permanent and immediate** — it removes the site and every retained version, and there is no undo for a deleted site. Confirm with the user before deleting. (This is distinct from republishing or rolling back a version, which are recoverable — see "Versions and rollback" below.)

## Updating a site

There is no "update" tool: republish to the same slug to serve a new version. Use `publish` with the same slug; the new upload replaces the live files at once. On a paid plan the previous version is retained, so an unwanted republish can be rolled back (see below). **On the free plan there is no undo**; confirm before replacing a site the user cares about.

## Versions and rollback

On paid plans every publish to a slug is saved as a retained **version**, so you can return a site to an earlier state. The free plan keeps no restorable versions. The publish output prints `Undo: versions_restore(slug, B)` when an undo exists.

- `versions_list` — list a site's versions with each version's number, whether it is currently live, its date, file count, and size. Use this to find the version number to restore.
- `versions_restore` — roll the site back to a previous version, making it live again. Takes `slug` and `version` (the number from `versions_list`), plus an optional `namespace`. **Requires a paid plan** (free-tier accounts get a clear "requires a paid plan" message). "Undo that" = `versions_list`, then `versions_restore` with the version the publish output named.
- `versions_limit` — set or clear how many versions are retained per site. Older versions beyond the limit are pruned; the live version is always kept.
- `versions_delete` — delete a single archived (non-live) version to reclaim storage.

## Preview and promote

`publish(slug, preview: true)` stages a version without touching the live site and returns a `preview_url` to review. `promote(slug)` makes the staged version live.

## Custom domain

Needs Pro or Max. A connected domain becomes its own address, so sites serve at `yourname.com/slug/`.

1. `domain add` with `hostname` (the root, `example.com`, not `www.`; a subdomain such as `blog.example.com` also works). It returns the DNS records to add. Only the user can create DNS records at their registrar, so hand them over and wait.
2. `domain status` with the domain `id` (from `domain list`) until it reports active. A pending domain can show validation errors such as CAA.
3. `publish(directory, slug, namespace: "yourname.com")`. Use `slug: "_root"` for the domain's home page.

`domain remove` disconnects a domain; confirm first.

## Address home page

`publish(slug: "_root")` publishes the address's own page (`you.upubli.sh/`, no slug). Republishing `_root` replaces the live home page like any other republish (the output names the replaced and new version), and `delete` of `_root` is refused: the home page goes only with its address.

## Renaming

`rename(nsId, site?, newName, redirect?)`. Give `site` to rename a site inside the address; leave it out to rename the address itself. `nsId` is the address name (see `status`), not an optional `namespace`. `redirect` is `30d` (default; old URLs keep working 30 days), `permanent` (301 with no expiry) or `off` (old name released immediately). Free accounts get one rename per resource; Pro and Max wait 30 days between renames of the same resource.

## QR codes and analytics

- `qrcode(slug, outputDir?)` prints a QR code and writes `qr.svg` and `qr.png` (default: the current directory). The code encodes the canonical URL with `?ref=qr`.
- `analytics(slug, enabled)` turns the analytics script on or off without republishing. It is on by default; turning it off needs a paid plan.

## Team members

On a shared address (Max plan), `members` lists, adds, removes and re-roles members: `action` is `list`, `add`, `remove` or `role`, with `username` (the member's sign-in email) and `role` (`admin` or `user`). `action: "leave"` (`namespace` required) lets a non-owner member leave the address themselves; the owner cannot leave.

## Checking site status

After publishing, you can verify a site is live by noting the production URL returned by the publish tool. Its shape is `https://{address}.upubli.sh/{slug}/` (or `.pinn.sh`, or `https://{hostname}/{slug}/` on a custom domain), with any `path_prefix` before the slug. The `_root` site is the address home page, with no slug.

If a user asks "is my site working?" — the best answer is to tell them the URL and suggest they visit it. The MCP tools don't have a health-check endpoint.
