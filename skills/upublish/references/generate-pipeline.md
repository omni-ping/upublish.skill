# Generate: Pipeline

End-to-end workflow for turning generated content (brag docs, markdown, assets) into a publishable HTML page and shipping it via upublish.

## The flow

```
Source content (markdown, data, code analysis)
    ↓
Generate assets (SVGs, charts, diagrams)  ← generate-assets.md
    ↓
Wrap in HTML template (styled, self-contained)
    ↓
Write to a publish directory
    ↓
Run pre-publish checklist  ← references/pre-publish-checklist.md
    ↓
Publish via MCP tool or CLI
```

## Wrapping markdown in HTML

Generated content like brag docs starts as markdown. To publish it, wrap it in a self-contained HTML page.

### The template

Write a single `index.html` with:

1. **DOCTYPE and meta** — charset, viewport, title, description, OG tags
2. **Inline CSS** — all styles in a `<style>` block, no external stylesheet
3. **Rendered markdown** — converted to HTML elements directly (not a markdown renderer at runtime)
4. **Inline assets** — SVGs embedded directly in the HTML, not as external files
5. **No build step** — the output should be a directory you can publish immediately

### Markdown to HTML conversion

Convert markdown to HTML elements yourself. Don't include a client-side markdown renderer — it adds weight and flashes unstyled content.

| Markdown | HTML |
|----------|------|
| `# Heading` | `<h1>` |
| `**bold**` | `<strong>` |
| `> blockquote` | `<blockquote>` |
| `- list item` | `<ul><li>` |
| `` `code` `` | `<code>` |
| Code blocks | `<pre><code>` |

### Styling principles

The HTML template should look like a designed page, not a raw markdown render. Apply design hierarchy directly:

**Typography:**
- System font stack for body: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Monospace for code: `'SF Mono', 'Fira Code', 'JetBrains Mono', monospace`
- Base size 18px, line-height 1.6 for body
- Scale headings proportionally — H1 at 2.5em, H2 at 1.75em, H3 at 1.25em

**Layout:**
- Max-width container (720px for prose, 960px if charts/diagrams need room)
- Generous vertical spacing between sections
- Blockquotes with left border accent, slightly indented
- Code blocks with subtle background, rounded corners

**Color:**
- Start with a neutral palette — dark text on light background
- One accent color for links, blockquote borders, and emphasis
- Don't use more than 3 colors total unless the content demands it

**Responsive:**
- Viewport meta tag (required)
- Fluid typography with clamp() if targeting mobile
- SVGs scale naturally — no responsive work needed for inline SVGs
- Charts may need a min-width or horizontal scroll wrapper on mobile

### Example structure

```
my-brag-doc/
├── index.html          ← self-contained HTML with inline CSS + SVGs
└── og-image.png        ← social preview image (1200x630)
```

That's it. Two files. The `index.html` contains everything — styles, content, embedded SVGs, charts. The `og-image.png` is for social sharing and can't be inline (platforms fetch it by URL).

## Embedding generated assets

### Inline SVGs

Place SVGs directly in the HTML. Don't reference external `.svg` files — inline is smaller (no extra request) and allows CSS styling.

```html
<figure>
  <svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg">
    <!-- generated diagram or chart -->
  </svg>
  <figcaption>Architecture overview</figcaption>
</figure>
```

### Chart.js / D3 charts

Include the library via CDN, data inline in a `<script>` block:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<canvas id="metrics-chart" width="800" height="400"></canvas>
<script>
  new Chart(document.getElementById('metrics-chart'), {
    type: 'bar',
    data: { /* inline data */ }
  });
</script>
```

Keep CDN dependencies to a minimum. One chart library is fine. Three is a smell.

### Mermaid diagrams

```html
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>
<pre class="mermaid">
graph LR
  A[Input] --> B[Process] --> C[Output]
</pre>
```

## Generating the OG image

Social platforms need a real image file at a URL — data URIs and inline SVGs don't work for og:image.

Options, from simplest to most polished:

1. **SVG rendered to Canvas → exported as PNG** — write an SVG, draw it onto a `<canvas>`, export with `toDataURL()`, save as `og-image.png`. Do this in a script, not at runtime.
2. **Hand-crafted PNG** — create a simple 1200x630 image with project name and accent color. Can be done with ImageMagick if available.
3. **Skip it** — if no image tool is available, publish without og:image. A missing preview is better than a broken one.

For the generate series, option 1 is the default path — the same SVG techniques from `generate-assets.md` work here.

## Pre-publish integration

Before publishing the generated output:

1. **Run the pre-publish checklist** from `references/pre-publish-checklist.md` — even generated content can have path issues
2. **Check SEO tags** — title, description, OG tags should reflect the actual content, not template placeholders
3. **Verify assets render** — open the HTML locally or check that SVGs are well-formed

## Publishing

Use the standard publish flow from `references/publishing.md`:

```
mcp_upublish_publish(directory: "./my-brag-doc", slug: "project-brag-doc")
```

Suggest a slug derived from the project name. Default visibility to `public` unless the user says otherwise.

After publishing, share the production URL: `https://{address}.upubli.sh/{slug}/`
