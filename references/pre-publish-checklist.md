# Pre-publish checklist

`publish` already enforces the expensive parts in code, before anything uploads:

| Covered by `publish` | How |
|---|---|
| Entry file | Refuses a folder with no top-level `index.html` |
| Wrong folder | Refuses a repo root (two or more of `package.json`, `src/`, lockfiles, `Dockerfile`, `.git/`) and names the build folder it found |
| Secret and junk files | Skips `.git`, `node_modules`, `.env*`, private keys, `.npmrc`, `.netrc`, `.pypirc`, `.envrc`, `.aws/`, `.ssh/`, `credentials.json`, `secrets.*`, `*.p12`/`*.pfx`, source maps, OS files |

So do not re-check those by hand. What code cannot see is what is **inside** the files. Run the five checks below on the folder you are about to publish, in one pass. If it is fresh build output from a framework you configured with a relative base (see `references/content-types/spa.md`), checks 1 and 3 are usually clean and you can skip straight to 2 and 4.

## 1. Asset paths are relative

Sites are served at `https://{address}.upubli.sh/{slug}/`. Absolute paths like `/styles.css` resolve to the domain root, not the slug directory, and 404. (A site published to `slug: "_root"` or a custom domain's root is served at `/`, where absolute paths work.)

```bash
grep -rnE "(src|href)=[\"']/[^/]|url\(['\"]?/[^/]" <dir> --include='*.html' --include='*.css'
```

**Fix:** make them relative: `/styles.css` → `./styles.css`, `/js/app.js` → `./js/app.js`. Leave alone: `//cdn...`, `https://...`, `data:`, `#anchors`, `mailto:`, `tel:`.

## 2. Referenced files exist

For each CSS, JS, image or font referenced in the HTML, confirm the file exists at that relative path in the folder. Fix the path or add the file; if a file is truly missing, tell the user.

## 3. Base tag

```bash
grep -rn '<base' <dir> --include='*.html'
```

A `<base href="/">` breaks every relative URL at `/{slug}/`. Remove it or set it to `./`, unless the user has a specific reason.

## 4. Local dev references

```bash
grep -rn 'localhost\|127\.0\.0\.1' <dir> --include='*.html' --include='*.css' --include='*.js'
```

These will not resolve on the published site. Replace them with the production URL or a relative path and tell the user.

## 5. Secrets inside the files

`publish` skips secret *files* but does not read file *contents*. Scan scripts and pages for keys:

```bash
grep -rnE 'sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}' <dir> --include='*.html' --include='*.js'
grep -rniE 'api[_-]?key|secret[_-]?key|password' <dir> --include='*.html' --include='*.js'
```

If a match looks like a real secret (not a placeholder or a form label), **stop and warn the user** before publishing.

Server-side files (`.php`, `.py`, `.rb`) will not run on upublish; if you see them, ask whether this is the right folder.

## Then publish

Report what you found and fixed, then call `publish`. A single HTML file is fine: put it in its own folder as `index.html`.
