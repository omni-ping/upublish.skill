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

**Current upublish behavior:** upublish does not support SPA routing fallback. Direct links to client-side routes will 404.

**Workarounds:**

| Approach | Trade-off |
|----------|-----------|
| **Hash routing** (`#/path`) | URLs contain `#`; no server config needed; universally works. Enable in your router config. |
| **Pre-rendering** | Generate an HTML file for each route at build time. Works if routes are known ahead of time. Vite: `vite-plugin-ssr`, React: `react-snap`, Angular: `ng prerender` |
| **404 fallback** | Create a `404.html` that's a copy of `index.html`. upublish does not currently serve custom 404 pages — this workaround **does not work** on upublish. Use hash routing or pre-rendering instead. |

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
| Direct link 404 | Deep links return 404 | Switch to hash routing or pre-render |
| Chunk load failure | "Loading chunk failed" errors | Rebuild with correct base path |
| Env vars wrong | API calls to wrong URL | Rebuild with correct env, or use runtime injection |
| SW caching stale content | Users stuck on old version | Cache-bust sw.js, use skipWaiting |
| Source maps exposed | `.map` files publicly accessible | Exclude from publish directory or accept the risk |
