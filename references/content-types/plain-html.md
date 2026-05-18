# Plain HTML

Single or multi-file HTML sites with no build step. The simplest content type — and the most common for hand-authored and AI-generated content.

## What this covers

- Hand-written HTML/CSS/JS pages
- Exported HTML from tools (Pandoc, Google Docs, Notion)
- Template-based sites (HTML5 Up, Bootstrap templates)
- Single-file reports and documents
- Email templates repurposed as hosted pages

## Preparation checklist

### 1. Directory structure

The publish directory must contain an `index.html` at the root level. If there's only one HTML file with a different name, rename it to `index.html`.

```
my-site/
├── index.html          ← required
├── styles.css
├── script.js
├── images/
│   ├── hero.jpg
│   └── logo.png
└── fonts/
    └── custom.woff2
```

For a single HTML file: create a directory, put the file inside as `index.html`, and publish the directory.

### 2. Asset paths

Scan all HTML files for references that start with `/`:

```
src="/          → src="./
href="/         → href="./
url("/          → url("./
url('/          → url('./
```

**Do not change:**
- Protocol-relative URLs: `//cdn.example.com/...`
- Full URLs: `https://...`, `http://...`
- Data URIs: `data:...`
- Anchor links: `#section`
- `mailto:` and `tel:` links

Also scan CSS files for `url()` references with absolute paths.

### 3. External dependencies

Check for CDN-hosted libraries and fonts:

```html
<!-- Common patterns -->
<script src="https://cdn.jsdelivr.net/npm/..."></script>
<link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet">
<link href="https://cdn.tailwindcss.com/..." rel="stylesheet">
```

These work as long as the CDN is available. For maximum portability:
- Download the library and serve it locally
- Use `<link rel="preconnect">` for critical external resources
- For Google Fonts: consider self-hosting (GDPR compliance in EU, plus resilience)

If the site should work offline or in restricted networks, all dependencies must be local.

### 4. Embedded fonts

Font files referenced via `@font-face` in CSS must use relative paths:

```css
/* Broken on subdirectory hosting */
@font-face {
  src: url("/fonts/custom.woff2");
}

/* Works */
@font-face {
  src: url("./fonts/custom.woff2");
}
```

If fonts are loaded from a different origin (CDN, Google Fonts), CORS headers on the font server are required. This is not something upublish controls — it depends on the font source.

### 5. Self-contained HTML (single-file)

For truly portable single-file output (reports, documents), Pandoc's `--embed-resources` flag (formerly `--self-contained`) base64-encodes all images, CSS, and fonts into the HTML file. The result is a single file with no external dependencies.

This produces large files but eliminates all path issues.

### 6. Meta tags and SEO

Check for placeholder or missing meta tags:

```html
<title>My Site</title>                    <!-- placeholder -->
<meta name="description" content="">      <!-- empty -->
<!-- missing og:image, og:title -->
```

Not required for publishing, but worth flagging to the user.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| Missing `index.html` | 404 at site root | Rename main HTML file |
| Absolute paths | CSS/JS/images 404 | Convert to `./` relative |
| `<base href="/">` | All relative links break | Remove or set to `./` |
| Case mismatch | Image shows on Mac, 404 on prod | Match filename case exactly |
| Localhost URLs | Broken links after deploy | Remove or replace |
| Large images | Slow load, potential size limits | Compress with quality target ~80% |
