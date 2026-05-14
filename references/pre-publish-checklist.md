# Pre-publish checklist

Run through every item below **before** calling `mcp_upublish_publish`. Fix any issues found — do not publish until all checks pass.

## 1. Asset paths are relative

Sites are served at `https://{username}.upubli.sh/{slug}/`. Absolute paths like `/styles.css` resolve to the domain root, not the slug directory, causing 404s.

**Check:** Scan all HTML files for `src`, `href`, and inline `url()` references. Flag any path that starts with `/` (but not `//` — those are protocol-relative URLs and are fine).

**Fix:** Convert absolute paths to relative ones:
- `/styles.css` → `./styles.css`
- `/js/app.js` → `./js/app.js`
- `/images/logo.png` → `./images/logo.png`

Also check CSS files for `url()` references with absolute paths and fix them the same way.

**Common patterns to scan for:**
```
src="/
href="/
url("/
url('/
url(/
```

**Exceptions — do NOT change these:**
- Protocol-relative URLs: `//cdn.example.com/...`
- Full URLs: `https://...`, `http://...`
- Data URIs: `data:...`
- Anchor links: `#section`
- mailto/tel links: `mailto:`, `tel:`

## 2. Referenced files exist

**Check:** For each CSS, JS, image, or font file referenced in HTML, verify the file actually exists in the publish directory at the expected relative path.

**Fix:** Either correct the path or add the missing file. If a file is genuinely missing (not just a wrong path), tell the user.

## 3. Entry point exists

**Check:** The directory must contain an `index.html` at the root level. Without it, visitors to `https://{username}.upubli.sh/{slug}/` will get a 404 or directory listing.

**Fix:** If there's an HTML file with a different name, ask the user if it should be renamed to `index.html`. If there's no HTML file at all, something is wrong — ask the user.

## 4. Base tag compatibility

**Check:** If any HTML file contains a `<base href="...">` tag, verify the href value is compatible with being served at `/{slug}/`. A `<base href="/">` will break all relative URLs on the page.

**Fix:** Remove the `<base>` tag or set it to `./` unless the user has a specific reason for it.

## 5. Local dev server references

**Check:** Scan all files for references to `localhost`, `127.0.0.1`, or non-standard ports (e.g., `http://localhost:3000/`). These will not resolve on the published site.

**Fix:** Remove or replace with the appropriate production URL or relative path. Tell the user about any you find.

## Running the checklist

Use `find` and `grep` on the publish directory to perform these checks efficiently. Example:

```bash
# Check for absolute asset paths in HTML files
grep -rn 'src="\/' /path/to/dir --include="*.html"
grep -rn 'href="\/' /path/to/dir --include="*.html"
grep -rn "src='\/" /path/to/dir --include="*.html"
grep -rn "href='\/" /path/to/dir --include="*.html"

# Check for absolute url() in CSS
grep -rn 'url("\/' /path/to/dir --include="*.css"
grep -rn "url('\/" /path/to/dir --include="*.css"
grep -rn 'url(\/' /path/to/dir --include="*.css"

# Check for localhost references
grep -rn 'localhost\|127\.0\.0\.1' /path/to/dir --include="*.html" --include="*.css" --include="*.js"

# Check for index.html
ls /path/to/dir/index.html

# Check for base tag
grep -rn '<base' /path/to/dir --include="*.html"
```

Report what you found and fixed. If everything passes, proceed to publish.
