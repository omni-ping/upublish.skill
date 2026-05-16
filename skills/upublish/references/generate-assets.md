# Generate: Assets

Techniques for generating visual assets when publishing content via upublish. Everything here produces self-contained output — no external image hosting, no build steps, no API keys.

## What Claude can generate directly

| Technique | Output | Best for |
|-----------|--------|----------|
| Inline SVG | Vector graphics in HTML | Logos, icons, diagrams, abstract art, charts, patterns |
| CSS gradients/shapes | Pure CSS visuals | Hero backgrounds, section dividers, decorative fills |
| Chart.js (CDN) | Canvas charts | Bar, line, pie, radar — quick data viz |
| D3.js (CDN) | SVG charts | Custom data viz, force layouts, treemaps |
| Mermaid (CDN) | Rendered diagrams | Flowcharts, sequence diagrams, architecture |
| HTML Canvas | Bitmap via JS | Generative art, particle effects, noise patterns |
| Excalidraw | Hand-drawn diagrams | Architecture diagrams (via generate MCP tool) |

## Filler art patterns

When real content doesn't exist yet but the page needs something visual.

### Abstract SVG heroes

Geometric patterns that look intentional. Use the project's color palette if one exists, otherwise derive from the content's mood.

Techniques:
- **Layered circles/blobs** — overlapping shapes with opacity, fill from a 2-3 color palette
- **Grid patterns** — repeated geometric shapes with subtle variation (size, rotation, opacity)
- **Wave/flow lines** — SVG paths with bezier curves, layered at different opacities
- **Noise texture** — SVG `<feTurbulence>` filter for organic texture backgrounds
- **Dot grids** — minimal, clean, works for technical content

Keep it simple. One technique per hero, 2-3 colors max. Complex generative art looks like it's trying too hard.

### Section dividers

- Angled SVG dividers (slanted line between sections)
- Subtle gradient fades
- Thin geometric borders (repeating dash/dot patterns)

### Placeholder images

When a content slot expects an image:
- SVG with dimensions matching the expected aspect ratio
- Muted background color + centered icon or text indicating purpose
- Never use `placeholder.com` or external services — generate inline

## Charts and data visualization

### Quick charts (Chart.js)

For simple data — bar, line, doughnut, radar. Include via CDN, data inline.

Works for: metric dashboards, project stats, comparison charts, progress indicators.

Config that looks good by default:
- Hide gridlines or use very light gray
- Round the bars (`borderRadius`)
- Use 2-3 colors from a cohesive palette
- Generous padding

### Custom viz (D3.js)

For anything Chart.js can't do — force-directed graphs, treemaps, custom layouts.

Heavier dependency. Only reach for this when Chart.js doesn't cover the shape.

### Inline SVG charts

For very simple data (3-5 values), skip the library entirely. Hand-write SVG bars/circles. Zero dependencies, smallest footprint, most control.

## Diagrams

### Architecture and flow

Route by complexity:

| Complexity | Technique |
|-----------|-----------|
| Simple flow (< 8 nodes) | Mermaid via CDN |
| Hand-drawn feel | Excalidraw via generate MCP tool |
| Custom layout, precise control | Inline SVG with positioned elements |

### Mermaid quick reference

Include via CDN, write diagram in a `<pre class="mermaid">` block. Renders client-side.

Good for: flowcharts, sequence diagrams, entity relationships, state machines, Gantt charts.

Limitations: styling is constrained, layout algorithm decides positioning.

## Content type asset needs

What each content type typically needs when published:

| Content type | Typical assets | Recommended technique |
|-------------|---------------|----------------------|
| AI-generated | Hero image, favicon, OG image | SVG hero + inline favicon SVG |
| Data viz | The viz IS the asset — but may need framing | CSS layout, section headers |
| Documentation | Architecture diagrams, flow charts | Mermaid or Excalidraw |
| Plain HTML | Hero, icons, backgrounds | Inline SVG + CSS gradients |
| Slide decks | Diagrams, charts, background art | SVG per-slide, Chart.js for data |
| SPAs | Icons, empty states, loading art | Inline SVG icon set |
| SSG output | Blog images, hero banners | SVG heroes, Chart.js for data posts |

## Constraints

- All assets must be self-contained — no external image URLs, no placeholder services
- SVG is the default. Reach for Canvas/libraries only when SVG can't do it.
- Match the content's visual tone. Technical docs get clean geometry. Creative projects get more expressive shapes.
- Filler art should look intentional, not like a placeholder. If it reads as "we didn't have a real image," cut it.
