# Data Visualizations and Dashboards

Interactive charts, notebooks, and dashboards hosted as static sites. The key concern is how data is embedded — inline vs external — and whether interactivity survives the static export.

## What this covers

### JavaScript-native (always static-friendly)
- D3.js (SVG/Canvas)
- Chart.js (Canvas)
- Observable Plot (grammar-of-graphics)
- Vega-Lite / Altair (declarative JSON spec)
- Apache ECharts (Canvas)

### Python exports to static HTML
- Plotly (`fig.write_html()`)
- Bokeh (`file_html()` / `output_file()`)
- Altair (Vega-Lite JSON → HTML)
- Matplotlib / Seaborn (static images only)

### Notebook-to-HTML pipelines
- Jupyter nbconvert (`--to html`)
- Quarto (`quarto render`)
- JupyterBook (Sphinx-based multi-page)
- Observable Framework (`npm run build`)

### WASM Python runtimes
- stlite (Streamlit in browser via Pyodide)
- Shinylive (Shiny in browser via Pyodide)
- Panel + WASM (experimental)

### In-browser analytics
- DuckDB-WASM (SQL queries on Parquet/CSV over HTTP)
- Evidence (BI-as-code SSG, ships DuckDB-WASM)

## Data embedding patterns

How data gets into the page determines file size, interactivity, and hosting complexity:

| Pattern | How it works | Size sweet spot | Interactivity |
|---------|-------------|----------------|---------------|
| Inline JSON in `<script>` | Data baked into HTML at export | < 5 MB | Full client-side |
| External JSON/CSV fetch | JS fetches data files at runtime | < 50 MB | Full client-side |
| External Parquet over HTTP | DuckDB-WASM queries files on CDN/storage | 100 MB – 100 GB+ | Full SQL |
| Build-time baked JSON | Data loaders run at build, output is static JSON | Any (pre-aggregated) | Filtered views |
| WASM Python runtime | Full Python interpreter in browser | < 50 MB practical | Full Python |
| Static image (PNG/SVG) | Chart rendered as image at export | Any | None |

## Preparation by source

### Plotly HTML export

```python
# Self-contained (larger file, no external deps)
fig.write_html("chart.html", include_plotlyjs=True)

# CDN-dependent (smaller file, needs internet)
fig.write_html("chart.html", include_plotlyjs='cdn')
```

- `include_plotlyjs=True` embeds ~3MB of Plotly.js — no external dependency
- `include_plotlyjs='cdn'` loads from `cdn.plot.ly` — smaller file but requires CDN access
- Data is inlined as JSON in a `<script>` tag — file size scales linearly with data size

**Prep:** Wrap in a directory with the HTML as `index.html`. Check for absolute paths if the export references external data files.

### Bokeh HTML export

```python
from bokeh.resources import Resources
from bokeh.embed import file_html

html = file_html(plot, Resources(mode="inline"), title="My Plot")
```

- `mode="inline"` embeds BokehJS (~4MB) — self-contained
- `mode="cdn"` loads from CDN — smaller but requires internet
- Widgets (sliders, dropdowns) work without a server for simple interactions; complex callbacks require a Bokeh server (not compatible with static hosting)

### Jupyter notebook HTML

```bash
jupyter nbconvert --to html notebook.ipynb
```

- Cell outputs (text, Plotly/Bokeh charts, images) are preserved
- **ipywidgets lose interactivity** — sliders, dropdowns, and other interactive widgets require a running Jupyter kernel. In static HTML, they render as their last-displayed state
- Plotly/Bokeh charts embedded via their own JS libraries retain interactivity
- Large notebooks with many image outputs produce very large HTML files

**Quarto** is a better option for notebooks intended for static hosting — it handles the export more cleanly and supports Observable JS cells that remain interactive.

### Observable Framework

```bash
npm run build  # outputs to dist/
```

- Data loaders (SQL, Python scripts, API calls) run at build time
- Results are baked into static JSON files in the output
- Client-side JS does filtering/interaction on the pre-fetched data
- Needs base path config if hosting at a subdirectory

This is the best pattern for "daily report" dashboards that refresh via CI/CD rebuild.

### DuckDB-WASM dashboards

DuckDB-WASM runs a full OLAP engine in the browser, querying Parquet files over HTTP.

- The WASM binary is several MB (initial download)
- Parquet files live on external storage (S3, R2, GitHub LFS)
- **CORS is required** on the storage bucket serving data files (GET/HEAD from `*`)
- Handles 150M+ rows with sub-10ms queries
- All data is visible to users (no server-side access control)

**upublish can host the dashboard HTML.** The Parquet data files typically live on separate object storage due to size.

### stlite / Shinylive (WASM Python)

These bundle a full Python runtime (Pyodide) into the browser:

- **Initial load: 30-100 MB** (Python runtime + packages)
- Any Streamlit or Shiny app becomes static
- No C extensions (TensorFlow, scikit-learn with C backends won't work)
- All code and data visible in browser DevTools

**Prep:** Export produces a directory of HTML + JS + WASM files. Publish the directory. stlite uses relative paths by default. Shinylive (`shinylive export`) outputs a directory with an `index.html` — verify asset paths are relative before publishing.

## Rendering technology notes

| Technology | Best for | Limits |
|-----------|----------|--------|
| SVG (D3, Vega-Lite) | Small-medium datasets, publication quality | Degrades past ~10,000 data points |
| Canvas (Chart.js, ECharts) | Medium-large datasets | Better performance, no DOM per-point |
| WebGL (Deck.gl, Plotly 3D) | Large datasets, 3D, maps | Requires GPU; mobile support varies |
| WASM (DuckDB, Pyodide) | Computation-heavy, large data | Multi-MB initial download |

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| Huge inline data | 50MB+ HTML file, slow load | Use external data files with relative paths |
| CDN Plotly.js blocked | Chart doesn't render | Use `include_plotlyjs=True` for self-contained |
| ipywidgets dead | Sliders/dropdowns frozen | Expected — use Quarto or Observable for interactive notebooks |
| Parquet CORS error | DuckDB-WASM fails to load data | Configure CORS on the storage bucket |
| WASM download slow | 30-second initial load for stlite | Expected — show a loading indicator |
| External data paths | JSON/CSV 404 | Ensure data file paths are relative |
