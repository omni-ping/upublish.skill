# Slide Decks and Presentations

HTML-based presentations hosted as static sites. Complexity varies from fully self-contained single files (Marp) to full SPA builds (Slidev).

## What this covers

- Marp (Markdown → HTML/PDF/PPTX)
- reveal.js (HTML presentation framework)
- Slidev (Vue-powered, Markdown)
- Remark.js / mdx-deck
- Impress.js

## Tool comparison

| Tool | Output format | Self-contained? | Build required? |
|------|--------------|-----------------|-----------------|
| Marp | Single HTML file | Yes — fonts/styles inlined | `marp --html` or CLI export |
| reveal.js | HTML + asset directory | No — needs `dist/` assets or CDN | Optional (can author directly) |
| Slidev | `dist/` directory | No — Vue SPA bundle | `slidev build` |
| Remark.js | Single HTML file | Depends on setup | No |

## Preparation by tool

### Marp

**Simplest case.** Marp produces a self-contained HTML file with all styles and fonts inlined.

```bash
marp slides.md -o slides.html
```

To publish:
1. Create a directory
2. Place the HTML file as `index.html`
3. Publish the directory

No path issues — everything is inlined. If the presentation references external images, those images must be in the publish directory with relative paths.

**PDF/PPTX export:** Marp also exports to PDF and PPTX, but these are not hostable as web pages. For web hosting, use HTML output.

### reveal.js

reveal.js presentations need the framework's assets alongside the HTML.

**Option A: CDN-hosted reveal.js**

The HTML file loads reveal.js from a CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/reveal.js/dist/reveal.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js/dist/reveal.css">
```

Publish the HTML file (as `index.html`) plus any local assets (images, custom CSS). External CDN must be accessible — won't work offline.

**Option B: Self-hosted reveal.js**

Bundle the reveal.js `dist/` directory with the presentation:
```
my-presentation/
├── index.html
├── dist/              ← reveal.js framework files
│   ├── reveal.js
│   ├── reveal.css
│   └── theme/
├── plugin/            ← reveal.js plugins
└── images/            ← presentation images
```

All paths in `index.html` must be relative:
```html
<script src="./dist/reveal.js"></script>
<link rel="stylesheet" href="./dist/reveal.css">
<link rel="stylesheet" href="./dist/theme/white.css">
```

**Limitation:** reveal.js uses DOM elements for slides. Performance degrades past ~2,500 slides.

### Slidev

Slidev is a Vue-based SPA. Treat it like an SPA (see `spa.md`) with one addition:

```bash
slidev build --base /{slug}/
```

The `--base` flag sets the Vite base path. Output goes to `dist/`.

Slidev's build includes the Vue runtime, syntax highlighting (Shiki), and any imported components. The output directory can be 5-20MB depending on content.

**If base path is unknown at build time:** Use `--base ./` for relative paths.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| reveal.js assets 404 | Slides render without styling | Bundle `dist/` directory or check CDN link |
| Absolute paths in reveal.js | Theme/plugin 404 on subdirectory | Convert all paths to relative `./` |
| Slidev blank page | White screen after deploy | Set `--base` flag and rebuild |
| Marp external images | Broken images in presentation | Include image files in publish directory |
| Large Slidev bundle | Slow initial load | Expected — Vue runtime + Shiki is heavy |
| Speaker notes not working | Notes window fails to open | Speaker notes require same-origin — works on upublish |
