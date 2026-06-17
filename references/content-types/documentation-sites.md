# Documentation Sites

Pre-built documentation sites from dedicated doc generators. These are a specialized subset of SSG output with additional concerns around search, versioning, and API reference rendering.

## What this covers

- Docusaurus (React-based, Meta)
- VitePress (Vue-based, Vite-native)
- MkDocs + Material (Python, YAML-driven)
- Storybook (UI component explorer)
- Sphinx (Python ecosystem, reStructuredText/MyST)
- Swagger UI (OpenAPI browser)
- Redoc (OpenAPI renderer)
- Astro Starlight (docs theme)
- Nextra (Next.js-based docs)

## Build output and base path

| Tool | Output dir | Base path config |
|------|-----------|-----------------|
| Docusaurus | `build/` | `url` + `baseUrl` in `docusaurus.config.js` |
| VitePress | `.vitepress/dist/` | `base` in config |
| MkDocs | `site/` | `site_url` in `mkdocs.yml` |
| Storybook | `storybook-static/` | No built-in base path rewrite |
| Sphinx | `_build/html/` | `html_baseurl` in `conf.py` |
| Starlight (Astro) | `dist/` | `base` in `astro.config.mjs` |
| Nextra (Next.js) | `out/` | `basePath` in `next.config.js` |

**Storybook caveat:** Storybook has no generator-level base path config. It assumes root-level hosting. On upublish, Storybook **will break** at `/{slug}/` because asset paths resolve against the domain root, not the slug subdirectory. Workaround: manually edit the generated `index.html` in `storybook-static/` to add `<base href="./">` before publishing.

## Preparation checklist

### 1. Base URL configuration

Set the base URL before building. This affects all internal links, asset paths, and search index URLs.

**Docusaurus:**
```js
// docusaurus.config.js
module.exports = {
  url: 'https://{address}.upubli.sh',
  baseUrl: '/{slug}/',
};
```

**VitePress:**
```ts
// .vitepress/config.ts
export default {
  base: '/{slug}/',
};
```

**MkDocs:**
```yaml
# mkdocs.yml
site_url: https://{address}.upubli.sh/{slug}/
```

### 2. Client-side search

Doc generators include client-side search (Lunr.js, MiniSearch) that builds a JSON index at build time. The search fetch path must resolve correctly from the subdirectory.

| Tool | Search approach | Index location |
|------|----------------|----------------|
| Docusaurus | Lunr.js (default) or Algolia plugin | `search-index.json` in build output |
| VitePress | MiniSearch (built-in) or Algolia | Embedded in JS bundle |
| MkDocs Material | Lunr.js | `search/search_index.json` |
| Sphinx | `searchindex.js` | Root of build output |

If base path is set correctly before build, search paths resolve automatically. If publishing pre-built output without base path control, verify the search index URL is relative.

**Large doc sites:** Search indexes grow with content. Sites with 5,000+ pages may produce multi-MB indexes that affect initial load. This is an inherent limitation of client-side search — Algolia or Typesense offload this at the cost of an external dependency.

### 3. Versioned documentation

Some doc tools support multiple documentation versions:

| Tool | Versioning support |
|------|-------------------|
| Docusaurus | Native — `versioned_docs/version-X.Y/`, `versions.json` |
| MkDocs | Via `mike` plugin — per-version subdirectories |
| Sphinx | Via `sphinx-multiversion` — `vX.Y/` subdirectories |
| VitePress | No native support — manual subdirectories or separate deploys |
| Storybook | No versioning — separate deploys per version |

Versioned output produces deeply nested paths (`/{slug}/docs/2.0/api/methods/`). Ensure the base URL propagates through all version subdirectories.

### 4. API documentation (OpenAPI/Swagger)

Two static-friendly approaches for API docs:

**Swagger UI (interactive, try-it-out):**
```
swagger-ui/
├── index.html
├── swagger-ui-bundle.js
├── swagger-ui.css
└── openapi.json          ← the spec file
```

The `index.html` initializes SwaggerUIBundle with a URL to the spec:
```js
SwaggerUIBundle({ url: "./openapi.json" })
```

The spec URL must be relative. An absolute `/openapi.json` will break on subdirectory hosting.

**Redoc (clean single-page):**
```bash
redocly build-docs openapi.yaml -o docs/index.html
```

Produces a single ~3MB self-contained HTML file. No external dependencies, no path issues.

**Embedded in a docs site:** Docusaurus has `docusaurus-plugin-redoc` and `docusaurus-openapi-docs` that render OpenAPI specs as pages within the doc site, inheriting the base URL and sidebar navigation.

### 5. Navigation and sidebar

All generators serialize navigation at build time — no server computation required:

- Docusaurus: `sidebars.js` → compiled into JSON chunks loaded on demand
- VitePress: `themeConfig.sidebar` → baked into Vue JS bundle
- MkDocs: `nav:` YAML → rendered as static HTML (no JS needed)
- Sphinx: Sidebar HTML generated statically per page

Navigation works without any special hosting config. The data is fully static.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| `baseUrl` not set | Internal links 404, assets missing | Set base URL config and rebuild |
| Search broken | Search returns no results or errors on fetch | Verify search index URL is relative |
| Storybook at subdirectory | Blank page or broken assets | May need a custom `<base>` tag or path rewrite |
| Versioned docs 404 | Old version links break | Ensure base URL propagates through version subdirs |
| Swagger UI spec 404 | "Failed to load API definition" | Set spec URL to `./openapi.json` (relative) |
| MkDocs Material search | Search index download slow | Expected for large sites — consider Algolia |
