# Publishing a site

## The basics

To publish, you need a directory containing static files (HTML, CSS, JS, images, etc.) and a slug (URL-safe name for the site).

Use the `publish` tool:

| Parameter | Required | Description |
|---|---|---|
| `directory` | yes | Path to the directory to publish (the build output, with a top-level `index.html`) |
| `slug` | yes | URL-safe name (1-255 chars, lowercase alphanumeric + hyphens). `_root` publishes the address home page (`you.upubli.sh/`) |
| `title` | no | Human-readable title (defaults to slug) |
| `visibility` | no | `public` (default) or `passcode` (paid plan). Never loosens an existing passcode site; use the `visibility` tool |
| `passcode` | no | Required when visibility is `passcode` |
| `namespace` | no | Address to publish into: an address name, or a custom domain hostname. Defaults to the default address |
| `spa` | no | `true` for single-page apps with client-side routes. Pass it on **every** publish of that site (`references/content-types/spa.md`) |
| `preview` | no | Stage the version without changing the live site; `promote` makes it live |
| `path_prefix` | no | Nested path, e.g. `2026/q3` publishes at `2026/q3/{slug}` |
| `analytics_enabled` | no | `false` publishes without the analytics script (paid plan) |
| `force` | no | Re-checks every stored file and re-uploads any that are missing or corrupt; healthy files are never re-uploaded |
| `allow_no_index`, `allow_project_files`, `include_sourcemaps` | no | Opt-outs for the guards below |

## Before anything uploads

`publish` checks the folder first and refuses, naming what it found:

- **No top-level `index.html`** (pass `allow_no_index` for a deliberate downloads folder).
- **A project folder:** two or more of `package.json`, `tsconfig.json`, a lockfile, `Dockerfile`, `src/`, `.git/`. It names the build folder (`dist/`, `build/`, `out/`) when it finds one (pass `allow_project_files` to override).

It always skips `.git`, `node_modules`, `.env*`, private keys (`*.pem`, `*.key`, `id_rsa`, `*.p12`, `*.pfx`), `.npmrc`, `.netrc`, `.pypirc`, `.envrc`, `.aws/`, `.ssh/`, `credentials.json`, `secrets.*`, source maps (`*.map`) and OS files. To publish a skipped file anyway, rename it (source maps: `include_sourcemaps`). Add a `.upublishignore` file for your own exclusions.

## What happens

1. Files are hashed locally; only changed files are uploaded (incremental publish)
2. Changed files are uploaded directly to the site's version prefix in R2
3. Site metadata is pushed to Cloudflare KV for edge access control
4. The site is live within seconds at `https://{address}.upubli.sh/{slug}/` (or `.pinn.sh`, or `https://{hostname}/{slug}/` on a custom domain)

The tool returns the **production URL** — always share this URL with the user, not a localhost URL.

## Republishing

Publishing to an existing slug **replaces the live site at once**: the new upload becomes what visitors see (no merge; each publish is a full snapshot of the directory). The output says what happened:

- Paid plan: `Replaced live version vB → vN. Undo: versions_restore(slug, B)`
- Free plan: `Replaced live version vB → vN (free plan: the previous version can't be restored)`
- `preview: true`: `Live site unchanged (preview)`

Paid plans keep the previous version, so `versions_list` and `versions_restore` undo a republish (see `references/managing.md`). **Free plans have no undo:** the old version is gone. Before replacing a site on a free plan, or a slug the user did not name, confirm with them. Check `list` first when unsure.

## Good slug practices

- Use lowercase, descriptive names: `my-portfolio`, `project-docs`, `demo-v2`
- Slugs must start and end with a letter or number
- Minimum 1 character, maximum 255

## Example workflow

1. User says "publish this site"
2. Identify the directory containing the files (ask if unclear)
3. Suggest a slug based on the directory name or project
4. **Quick asset-path check** — see `references/pre-publish-checklist.md`. The tool itself blocks a missing `index.html`, project folders and secret files.
5. Call `publish` with the directory and slug
6. Share the production URL with the user

## Size limits

| Limit | Free tier | Paid tier | What happens |
|-------|-----------|-----------|-------------|
| Single file | 10 MB | 1 GB | Files over the plan limit are rejected by the server |
| Total storage | 100 MB | 10 GB (Pro), 100 GB (Max) | Over the cap: free is refused; paid gets a storage approval URL for the user (`references/troubleshooting.md`); complimentary plans get `comp_cap` |
| Slug length | 1-255 characters | 1-255 characters | Rejected at API level |

Upload sessions are valid for 6 hours. If an upload takes longer (e.g. uploading a very large file on a slow connection), start a new publish to get fresh upload URLs.

### When the site is too big

| Cause | Fix |
|-------|-----|
| Large images (hero, photos) | Compress — see `references/optimization.md` |
| Video files | Host on YouTube/Vimeo and embed. Upload only if under your plan's single-file limit. |
| `node_modules/` included | Publish the build output directory, not the source tree |
| Source maps (`.map` files) | Skipped by default; leave `include_sourcemaps` off |
| Full font families | Subset to Latin or switch to system fonts |
| Uncompressed data files | Use gzip/brotli-compressed JSON, or external hosting for large datasets |

## Common mistakes

- **Don't skip the asset-path check.** Broken asset paths are the #1 cause of sites that publish successfully but look broken. Run the quick check in `references/pre-publish-checklist.md` unless you know the folder is clean build output.
- **Don't use absolute paths for assets.** Paths like `/styles.css` resolve to the domain root, not the slug directory. Use `./styles.css` instead.
- **Don't create a temp directory just to publish one file.** If the user has a single HTML file, create a directory with just that file, then publish the directory.
- **Don't guess the slug.** If the directory could map to multiple reasonable slugs, ask the user.
- **Don't forget to share the URL.** The tool returns the production URL — always include it in your response.
