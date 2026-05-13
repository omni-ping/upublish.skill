# Publishing a site

## The basics

To publish, you need a directory containing static files (HTML, CSS, JS, images, etc.) and a slug (URL-safe name for the site).

Use the `mcp_upublish_publish` tool:

| Parameter | Required | Description |
|---|---|---|
| `directory` | yes | Path to the directory to publish |
| `slug` | yes | URL-safe name (3-63 chars, lowercase alphanumeric + hyphens) |
| `title` | no | Human-readable title (defaults to slug) |
| `visibility` | no | `public` (default), `unlisted`, or `passcode` |
| `passcode` | no | Required when visibility is `passcode` |

## What happens

1. All files in the directory are zipped and uploaded
2. Files are extracted to R2 storage at `{username}/{slug}/`
3. Site metadata is pushed to Cloudflare KV for edge access control
4. The site is live within seconds at `https://{username}.upubli.sh/{slug}/`

The tool returns the **production URL** — always share this URL with the user, not a localhost URL.

## Republishing

Publishing to an existing slug **replaces the entire site**. All previous files are deleted and replaced with the new ones. There's no merge or diff — it's a full replacement.

## Good slug practices

- Use lowercase, descriptive names: `my-portfolio`, `project-docs`, `demo-v2`
- Slugs must start and end with a letter or number
- Minimum 3 characters, maximum 63

## Example workflow

1. User says "publish this site"
2. Identify the directory containing the files (ask if unclear)
3. Suggest a slug based on the directory name or project
4. Call `mcp_upublish_publish` with the directory and slug
5. Share the production URL with the user

## Common mistakes

- **Don't create a temp directory just to publish one file.** If the user has a single HTML file, create a directory with just that file, then publish the directory.
- **Don't guess the slug.** If the directory could map to multiple reasonable slugs, ask the user.
- **Don't forget to share the URL.** The tool returns the production URL — always include it in your response.
