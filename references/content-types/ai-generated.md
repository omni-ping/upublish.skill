# AI-Generated Content

Content produced by AI assistants (Claude, ChatGPT, v0.dev, Bolt.new, Cursor) that needs to be published as a live site. This is the highest-risk content type — AI output often looks correct in a chat preview but breaks when hosted.

## What this covers

- Claude artifacts (single HTML with inline CSS/JS)
- Claude Code output (files written to disk)
- ChatGPT Canvas output (HTML or code blocks)
- v0.dev exports (React + Tailwind components)
- Bolt.new projects (full Node.js projects)
- Cursor / Copilot-generated files

## Common AI output formats

| Source | Typical output | Deployable as-is? |
|--------|---------------|-------------------|
| Claude artifact | Single HTML file, inline styles + JS | Yes, after basic checks |
| Claude Code | Multi-file directory on disk | Usually yes, after path checks |
| ChatGPT Canvas | Single HTML or code block | Yes, after basic checks |
| v0.dev | React + Tailwind JSX components | No — needs a host page + build step |
| Bolt.new | Full project with package.json | Needs `npm install && npm run build` |
| Cursor / Copilot | Varies by prompt | Depends on what was generated |

## Preparation checklist

AI-generated content needs every check from the plain HTML checklist (see `plain-html.md`) plus these additional validations:

### 1. CDN dependencies

AI assistants frequently link to CDN-hosted libraries:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
```

**Assessment:**
- If the site is for public sharing and CDN reliability is acceptable: leave as-is
- If the site needs to work reliably long-term: download dependencies locally
- Tailwind CDN (`cdn.tailwindcss.com`) is a development-only tool — for production, the CSS should be compiled. But for quick-publish AI output, the CDN version works fine

**Do not break working CDN links** unless the user specifically requests self-hosting. The trade-off (CDN dependency vs local files) is the user's call.

### 2. Missing assets

AI generates references to files that don't exist:

```html
<img src="hero.jpg" alt="Hero image">          <!-- no hero.jpg file -->
<img src="./images/team-photo.png">             <!-- images/ dir doesn't exist -->
<link rel="icon" href="./favicon.ico">          <!-- no favicon -->
```

**Detection:** Cross-reference all `src`, `href`, and `url()` values against actual files in the directory.

**Fix options:**
- Ask the user if they have the actual files
- Replace with placeholder images (warn the user)
- Remove the reference if it's decorative
- For favicons: either provide one or remove the `<link>` tag

### 3. Placeholder content

AI often leaves obvious placeholders:

```html
<title>My App</title>
<meta name="description" content="A brief description of your page">
<p>Lorem ipsum dolor sit amet...</p>
<a href="#">Learn more</a>
<button onclick="alert('Coming soon!')">Sign Up</button>
```

**Flag these to the user** but don't block publishing. The user may want to publish first and fix later, or the placeholders may be intentional.

### 4. Non-functional navigation

AI generates navigation bars and links that don't go anywhere:

```html
<a href="/about">About</a>           <!-- absolute path, no about.html -->
<a href="#features">Features</a>      <!-- anchor might not exist -->
<a href="javascript:void(0)">Menu</a> <!-- intentionally non-functional -->
```

**Fix:**
- Convert absolute paths to relative (`/about` → `./about.html`)
- Verify anchor targets exist
- Flag `javascript:void(0)` and `#` links to the user

### 5. Responsive design

AI-generated layouts frequently break on mobile:

- Fixed-width containers (`width: 1200px` instead of `max-width`)
- Missing viewport meta tag
- Overflow on small screens (horizontal scrolling)
- Text too small on mobile

**Check for viewport meta tag:**
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

If missing, add it. If present, the rest is best verified by the user in a real browser.

### 6. React/JSX components (v0.dev, Bolt.new)

If the AI output is React components (JSX), they're not directly hostable as HTML. They need:

1. A `package.json` with React + build tool (Vite)
2. `npm install`
3. `npm run build`
4. Publish the `dist/` directory

If the user has JSX from v0.dev and wants it hosted: create a minimal Vite + React project, paste the component in, build, and publish the output.

Alternatively, if the component is simple enough, convert it to plain HTML + vanilla JS. This avoids the build step entirely.

### 7. Inline vs external styles

AI artifacts typically use inline styles or a single `<style>` block. This is fine for single-page content. For multi-page sites, extract shared styles to a CSS file.

## AI-specific quality signals

These aren't blockers for publishing, but they're worth flagging:

| Signal | What to flag |
|--------|-------------|
| **Accessibility** | No semantic HTML (all `<div>`), missing alt text, no ARIA labels |
| **SEO** | Default/placeholder title and description, no Open Graph tags |
| **Performance** | Unoptimized images, render-blocking scripts, no lazy loading |
| **Security** | API keys in source, inline event handlers |

## Common issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| CDN library unavailable | Page fails to render, JS errors | Download and serve locally |
| Missing images | Broken image icons | Ask user for files or remove references |
| No viewport meta | Tiny text on mobile | Add viewport meta tag |
| Absolute paths | Assets 404 on subdirectory | Convert to relative `./` paths |
| JSX not HTML | Browser shows raw JSX | Needs React build step |
| Placeholder content | "Lorem ipsum" on live site | Flag to user before publishing |
| `#` links | Click does nothing | Connect to actual targets or remove |
