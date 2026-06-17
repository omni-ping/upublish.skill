# Publishing a site

## The basics

To publish, you need a directory containing static files (HTML, CSS, JS, images, etc.) and a slug (URL-safe name for the site).

Use the `mcp_upublish_publish` tool:

| Parameter | Required | Description |
|---|---|---|
| `directory` | yes | Path to the directory to publish |
| `slug` | yes | URL-safe name (1-255 chars, lowercase alphanumeric + hyphens) |
| `title` | no | Human-readable title (defaults to slug) |
| `visibility` | no | `public` (default) or `passcode` |
| `passcode` | no | Required when visibility is `passcode` |

## What happens

1. Files are hashed locally; only changed files are uploaded (incremental publish)
2. Changed files are uploaded directly to R2 storage at `{address}/{slug}/`
3. Site metadata is pushed to Cloudflare KV for edge access control
4. The site is live within seconds at `https://{address}.upubli.sh/{slug}/`

The tool returns the **production URL** — always share this URL with the user, not a localhost URL.

## Republishing

Publishing to an existing slug **replaces the entire site**. All previous files are deleted and replaced with the new ones. There's no merge or diff — it's a full replacement.

## Good slug practices

- Use lowercase, descriptive names: `my-portfolio`, `project-docs`, `demo-v2`
- Slugs must start and end with a letter or number
- Minimum 1 character, maximum 63

## Example workflow

1. User says "publish this site"
2. Identify the directory containing the files (ask if unclear)
3. Suggest a slug based on the directory name or project
4. **Run the pre-publish checklist** — read `references/pre-publish-checklist.md` and complete every check. Fix any issues before proceeding.
5. Call `mcp_upublish_publish` with the directory and slug
6. Share the production URL with the user

## Size limits

| Limit | Free tier | Paid tier | What happens |
|-------|-----------|-----------|-------------|
| Single file | 10 MB | 1 GB | Files over the plan limit are rejected by the server |
| Slug length | 1-255 characters | 1-255 characters | Rejected at API level |

Upload sessions are valid for 6 hours. If an upload takes longer (e.g. uploading a very large file on a slow connection), start a new publish to get fresh upload URLs.

### When the site is too big

| Cause | Fix |
|-------|-----|
| Large images (hero, photos) | Compress — see `references/optimization.md` |
| Video files | Host on YouTube/Vimeo and embed. Upload only if under your plan's single-file limit. |
| `node_modules/` included | Publish the build output directory, not the source tree |
| Source maps (`.map` files) | Remove them — they often double the JS size |
| Full font families | Subset to Latin or switch to system fonts |
| Uncompressed data files | Use gzip/brotli-compressed JSON, or external hosting for large datasets |

## Common mistakes

- **Don't skip the pre-publish checklist.** Broken asset paths are the #1 cause of sites that publish successfully but look broken. Always run through `references/pre-publish-checklist.md` before publishing.
- **Don't use absolute paths for assets.** Paths like `/styles.css` resolve to the domain root, not the slug directory. Use `./styles.css` instead.
- **Don't create a temp directory just to publish one file.** If the user has a single HTML file, create a directory with just that file, then publish the directory.
- **Don't guess the slug.** If the directory could map to multiple reasonable slugs, ask the user.
- **Don't forget to share the URL.** The tool returns the production URL — always include it in your response.
