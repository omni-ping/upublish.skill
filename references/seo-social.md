# SEO and Social Previews

Meta tags, social cards, and discoverability for sites published to upublish. Not required for publishing, but the difference between a link that looks professional when shared and one that shows a blank preview.

## The minimum viable set

Every published page should have these in `<head>`:

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Descriptive page title</title>
<meta name="description" content="One sentence explaining what this page is.">
```

If these are missing or contain placeholders ("My App", "A brief description"), flag to the user before publishing.

## Open Graph tags

These control how the page looks when shared on Slack, Discord, Twitter/X, LinkedIn, iMessage, and most other platforms.

```html
<meta property="og:title" content="Project Name — What It Does">
<meta property="og:description" content="One compelling sentence.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://address.upubli.sh/slug/">
<meta property="og:image" content="https://address.upubli.sh/slug/og-image.png">
```

### og:image requirements

| Platform | Min size | Recommended | Aspect ratio |
|----------|----------|-------------|-------------|
| Twitter/X | 120x120 | 1200x630 | 1.91:1 |
| LinkedIn | 200x200 | 1200x627 | 1.91:1 |
| Slack | 200x200 | 1200x630 | 1.91:1 |
| Discord | 200x200 | 1200x630 | 1.91:1 |
| iMessage | any | 1200x630 | 1.91:1 |

**Safe default: 1200x630 PNG.** Works everywhere.

If no og:image exists, generate one using inline SVG (see `generate-assets.md` for techniques) — project name on a colored background is better than no preview image.

### Twitter/X cards

Twitter uses its own tags, falling back to OG:

```html
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Project Name">
<meta name="twitter:description" content="One compelling sentence.">
<meta name="twitter:image" content="https://address.upubli.sh/slug/og-image.png">
```

`summary_large_image` shows the full-width preview. `summary` shows a small square thumbnail.

## Favicon

Without a favicon, browsers show a generic icon and the console logs a 404 for `/favicon.ico`.

### Inline SVG favicon (no file needed)

```html
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
```

Replace the emoji with one that fits the project. This is a single line, zero extra files, works in all modern browsers.

### File-based favicon

If the user has a logo or icon:
- `favicon.ico` (32x32) for legacy browsers
- `favicon.svg` for modern browsers
- `apple-touch-icon.png` (180x180) for iOS home screen

```html
<link rel="icon" href="./favicon.svg" type="image/svg+xml">
<link rel="icon" href="./favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="./apple-touch-icon.png">
```

## Canonical URL

Sites on upublish are served at a subdirectory path. The canonical URL should reflect this:

```html
<link rel="canonical" href="https://address.upubli.sh/slug/">
```

This prevents search engines from treating the same content at different URLs as duplicates. Replace `username` and `slug` with actual values.

## robots.txt

upublish serves sites at `/{slug}/`, so a `robots.txt` in the published directory lands at `/{slug}/robots.txt` — not at the domain root (`/robots.txt`) where crawlers look for it.

**This means per-site robots.txt doesn't work on upublish.** Don't create one unless the platform adds domain-root support. If the user needs to block crawlers, use a meta tag instead:

```html
<meta name="robots" content="noindex, nofollow">
```

## Structured data (optional)

For project pages, a minimal JSON-LD block helps search engines:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Project Name",
  "description": "What it does.",
  "url": "https://address.upubli.sh/slug/",
  "applicationCategory": "DeveloperApplication"
}
</script>
```

Only suggest this for public-facing project pages, not internal tools or drafts.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| Placeholder `<title>` | "My App" shows in search results and share previews | Write a real title |
| Missing og:image | Blank preview when shared on Slack/Discord | Generate an SVG-based OG image |
| og:url points to localhost | Share preview links back to `localhost:3000` | Set to production URL |
| No favicon | Console 404, generic browser icon | Add inline SVG favicon |
| robots.txt in slug directory | Crawlers ignore it (wrong path) | Use meta robots tag instead |
