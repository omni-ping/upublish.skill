# Single Page Applications (SPAs)

Client-side rendered applications built with React, Vue, Angular, Svelte, or SolidJS. The build output is a directory of static files, but SPAs have unique hosting requirements around routing and base paths.

## What this covers

- React apps (Create React App, Vite + React)
- Vue apps (Vite + Vue, Vue CLI)
- Angular apps (`ng build`)
- Svelte/SvelteKit apps (`adapter-static`)
- SolidJS, Preact, and other SPA frameworks
- Micro-frontend bundles (single-spa)

## Build output

SPAs must be built before publishing. The output directory depends on the bundler:

| Bundler/Framework | Build command | Output dir |
|-------------------|--------------|------------|
| Vite (any framework) | `npm run build` | `dist/` |
| Create React App | `npm run build` | `build/` |
| Angular CLI | `ng build` | `dist/<project-name>/` |
| SvelteKit (adapter-static) | `npm run build` | `build/` |
| Next.js (static export) | `next build` | `out/` |
| Nuxt (static) | `nuxt generate` | `.output/public/` |

## Preparation checklist

### 1. Base path configuration

upublish serves sites at `https://{address}.upubli.sh/{slug}/`. Every bundler needs to know this subdirectory path so asset URLs resolve correctly.

**Set the base path before building:**

| Bundler | Config | Example |
|---------|--------|---------|
| Vite | `base` in `vite.config.ts` | `base: './'` |
| Webpack | `output.publicPath` in webpack config | `publicPath: './'` |
| Angular CLI | `--base-href` flag | `ng build --base-href './'` |
| Next.js | `basePath` + `assetPrefix` in `next.config.js` | `basePath: '/{slug}'` |
| Nuxt | `app.baseURL` in `nuxt.config.ts` | `baseURL: '/{slug}/'` |

**Recommended:** Use `'./'` (relative) as the base path — it works regardless of the slug, so the same build can be published to any slug. Use `'/{slug}/'` (absolute) only if the app has specific requirements for it.

**Next.js quirk:** `basePath` controls link prefixes, `assetPrefix` controls asset prefixes. `assetPrefix` requires a trailing slash while `basePath` does not. Both must be set for subdirectory hosting.

### 2. Client-side routing

SPAs using the History API (the default in every modern framework) expect the server to return `index.html` for all paths. Without this, navigating directly to `/slug/dashboard` returns a 404 because no `dashboard.html` file exists.

**upublish behavior:** publish with `spa: true` and deep links such as `/slug/dashboard` serve `index.html`. Requests for paths with a file extension (`/slug/assets/app.js`) still 404 normally when the file is missing.

```
publish(directory: "./dist", slug: "my-app", spa: true)
```

**Pass `spa: true` on every publish of the site.** A republish without it turns SPA mode off when it also sets a non-public visibility (a passcode republish does), and the deep links 404 again; a plain public republish leaves the flag alone. No tool switches SPA mode off on purpose, so there is never a reason to leave it out.

With the fallback on, a router that uses the History API works. Keep the base path relative (step 1) so assets load from any depth: `/slug/a/b` must still find `./assets/app.js`. If an app can't get a relative base, use hash routing, which needs no server support:

| Approach | Trade-off |
|----------|-----------|
| **`spa: true`** (recommended) | Clean URLs; every unknown extensionless path serves `index.html`, so the app must render its own "not found" view |
| **Hash routing** (`#/path`) | URLs contain `#`; works with or without `spa`. Enable in your router config. |
| **Pre-rendering** | Generate an HTML file for each route at build time. Works if routes are known ahead of time. Vite: `vite-plugin-ssr`, React: `react-snap`, Angular: `ng prerender` |

A `404.html` copy of `index.html` does **not** work; upublish does not serve custom 404 pages. Use `spa: true`.

**Hash routing configuration:**

```js
// React Router
<BrowserRouter> → <HashRouter>

// Vue Router
createRouter({ history: createWebHistory() })
→ createRouter({ history: createWebHashHistory() })

// Angular
RouterModule.forRoot(routes, { useHash: true })
```

### 3. Code-split chunks

Modern bundlers split the app into multiple JS files loaded on demand. All chunk paths must include the base path prefix. If `base`/`publicPath` is set correctly (step 1), this happens automatically.

**Verify after build:** Check that chunk imports in the generated HTML reference relative paths:

```html
<!-- Correct -->
<script src="./assets/index-3f8a2c.js"></script>

<!-- Broken (absolute, missing base) -->
<script src="/assets/index-3f8a2c.js"></script>
```

### 4. Environment variables

Build-time environment variables (Vite `VITE_*`, CRA `REACT_APP_*`) are baked into the JS bundle as string literals. They cannot be changed after build.

If the app needs different config per environment, the options are:
- Rebuild for each environment (simplest)
- Runtime injection via `window.env` in `index.html` (set values in a `<script>` tag before the app loads)

### 5. Service workers

If the SPA registers a service worker, be aware of the "update bootstrap" trap: the service worker caches itself, so users on an old version never receive the new update logic.

**Recommendations:**
- Set `Cache-Control: no-cache` on `sw.js`
- Use `skipWaiting()` + `clients.claim()` for immediate activation
- Test the update flow before publishing
- Safari honors aggressive SW cache directives more strictly than Chrome

If the service worker isn't essential, consider removing it for hosted deployments.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| Missing base path | CSS/JS 404, blank white page | Set `base`/`publicPath` to `./` |
| Direct link 404 | Deep links return 404 | Publish with `spa: true` (on every publish), or use hash routing |
| Chunk load failure | "Loading chunk failed" errors | Rebuild with correct base path |
| Env vars wrong | API calls to wrong URL | Rebuild with correct env, or use runtime injection |
| SW caching stale content | Users stuck on old version | Cache-bust sw.js, use skipWaiting |
| Source maps | `.map` files are not published by default | Pass `include_sourcemaps: true` only if you want them public |
