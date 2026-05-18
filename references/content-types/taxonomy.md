# Content Type Taxonomy

Classify the content before preparing it for publishing. Each type has different preparation requirements.

## Classification

Examine the directory contents and match against these signals:

| Signal | Content type | Reference |
|--------|-------------|-----------|
| Single `.html` file, no `package.json`, no build tool config | Plain HTML | `plain-html.md` |
| `package.json` with React/Vue/Angular/Svelte + client-side router | SPA | `spa.md` |
| SSG config file (`next.config.*`, `astro.config.*`, `hugo.toml`, `_config.yml`, `eleventy.*`, `gatsby-config.*`, `nuxt.config.*`) | SSG Output | `ssg-output.md` |
| Docusaurus, VitePress, MkDocs, Storybook, Sphinx config | Documentation Site | `documentation-sites.md` |
| reveal.js, Marp, or Slidev files; `.md` files with slide separators (`---`) | Slide Deck | `slide-decks.md` |
| Plotly HTML exports, Jupyter `.html` output, D3/Chart.js dashboards, Quarto project | Data Visualization | `data-visualizations.md` |
| AI chat artifact (single HTML with inline everything), no build tooling | AI-Generated Content | `ai-generated.md` |

If the content matches multiple types, use the most specific one. If unclear, check for a `package.json` — its dependencies reveal the framework.

## Pre-built vs needs-build

| Scenario | Action |
|----------|--------|
| Directory contains only static files (HTML, CSS, JS, images) | Ready to prep — go to the content type reference |
| Directory contains source code + build config | Run the build first, then prep the output directory |
| Directory is a build output (`dist/`, `build/`, `out/`, `_site/`, `public/`) | Ready to prep |

## Build output directories by tool

| Tool | Default output dir | Config key |
|------|-------------------|------------|
| Vite | `dist/` | `build.outDir` |
| Next.js (`output: 'export'`) | `out/` | `distDir` |
| Astro | `dist/` | `outDir` |
| Hugo | `public/` | `publishDir` |
| Jekyll | `_site/` | `destination` |
| 11ty | `_site/` | `dir.output` |
| Gatsby | `public/` | (hardcoded) |
| Nuxt 3 static | `.output/public/` | — |
| Docusaurus | `build/` | — |
| VitePress | `.vitepress/dist/` | `outDir` |
| MkDocs | `site/` | `site_dir` |
| Storybook | `storybook-static/` | `--output-dir` |

## Universal checks (all types)

These apply to every content type. Run them after type-specific preparation.

| Check | What to scan for | Fix |
|-------|-----------------|-----|
| Absolute asset paths | `src="/`, `href="/`, `url("/` | Convert to `./` relative paths |
| `index.html` at root | Must exist | Rename or create |
| Localhost references | `localhost`, `127.0.0.1` | Remove or replace |
| Mixed content | `http://` resources on HTTPS page | Change to `https://` or `//` |
| Case sensitivity | `Hero.jpg` referenced but file is `hero.jpg` | Match exactly |
| `<base>` tag | `<base href="/">` breaks subdirectory hosting | Remove or set to `./` |
| File size | Individual files over 25 MB | Compress or split |
| Server-side code | `.php`, `.py`, `.rb` expecting server execution | Not supported — static only |
