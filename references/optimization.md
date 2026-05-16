# Content Optimization

Improve load time and reduce site size before publishing. This is optional — run it when the model notices large assets, slow-loading content, or the user asks for optimization.

## When to optimize

| Signal | Action |
|--------|--------|
| Total directory size > 10 MB | Review what's large |
| Any single image > 500 KB | Compress it |
| Unminified CSS/JS in production build | Minify or flag |
| Unused CSS/JS files in the directory | Remove them |
| Custom fonts with full character sets | Subset or switch to system fonts |

Don't optimize aggressively by default. A 2 MB site is fine. Optimization matters when things are noticeably slow or oversized.

## Images

Images are almost always the largest assets. Check sizes first:

```bash
find <dir> -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \) -exec ls -lh {} \; | sort -k5 -h -r
```

### Compression strategies

| Format | Tool | Command | Notes |
|--------|------|---------|-------|
| PNG | `pngquant` | `pngquant --quality=65-80 image.png` | Lossy, massive savings (60-80%) |
| JPEG | `jpegoptim` | `jpegoptim --max=80 image.jpg` | Lossy, target 80% quality |
| SVG | hand-edit or `svgo` | `svgo input.svg -o output.svg` | Remove editor metadata, simplify paths |
| All → WebP | `cwebp` | `cwebp -q 80 image.png -o image.webp` | 25-35% smaller than JPEG at same quality |

If compression tools aren't installed, flag the large files to the user rather than silently skipping. Don't install tools without asking.

### Format selection

| Content | Best format |
|---------|------------|
| Photos, screenshots | JPEG or WebP |
| Icons, logos, diagrams | SVG (vector) |
| Screenshots with text | PNG or WebP |
| Animated content | GIF (short) or video (long) |

### Responsive images

For sites with large hero images, suggest `srcset` for responsive loading:

```html
<img src="hero-800.jpg"
     srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1200.jpg 1200w"
     sizes="(max-width: 600px) 400px, (max-width: 1000px) 800px, 1200px"
     alt="...">
```

Only suggest this for image-heavy sites. For a single-page brag doc, a single reasonably-sized image is fine.

## CSS and JavaScript

### Minification

If the site was hand-authored (no build step), CSS and JS are probably unminified. Options:

| Tool | What it does | When to use |
|------|-------------|-------------|
| `esbuild` | Minifies CSS and JS, tree-shakes | Best general option — fast, no config |
| `cssnano` | CSS-only minification | When you only need CSS |
| `terser` | JS-only minification | When you only need JS |

Quick minification with esbuild (if available):

```bash
esbuild styles.css --minify --outfile=styles.min.css
esbuild script.js --minify --outfile=script.min.js
```

If built by a framework (Vite, Next, Astro), the output is already minified. Don't double-minify.

### Dead asset removal

Scan for CSS/JS/image files that aren't referenced anywhere:

```bash
# List all files in the directory
find <dir> -type f -not -name 'index.html' | while read f; do
  basename=$(basename "$f")
  if ! grep -rq "$basename" <dir> --include='*.html' --include='*.css' --include='*.js'; then
    echo "Unreferenced: $f"
  fi
done
```

Flag unreferenced files to the user — don't delete without confirmation. They might be loaded dynamically.

## Fonts

Custom fonts are often the second-largest asset after images.

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| Use system font stack | 100% of font weight | Lose brand typography |
| Subset to Latin characters | 60-80% | Breaks non-Latin text |
| Use `woff2` only | 30% vs woff/ttf | Drops IE11 (acceptable) |
| Preload critical fonts | No size change, faster render | Extra `<link>` tags |

System font stack for when custom fonts aren't worth the weight:

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

## Lazy loading

For pages with many images below the fold:

```html
<img src="photo.jpg" loading="lazy" alt="...">
```

Don't lazy-load the hero image or anything above the fold — it delays the first meaningful paint.

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| 5 MB hero image | Page takes 10+ seconds on mobile | Compress to < 200 KB, use WebP |
| 3 custom font weights loaded | 500 KB+ of fonts, FOUT | Subset or reduce to 1-2 weights |
| Unminified jQuery + Bootstrap | 300 KB+ of JS for a simple page | Replace with vanilla JS or minify |
| Unused CSS from template | 200 KB+ CSS, 10% actually used | PurgeCSS or manual cleanup |
| Full source maps shipped | Doubles JS size | Remove `.map` files (also a security concern) |
