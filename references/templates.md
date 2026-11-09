# Starter templates

## When to use it

The user wants a portfolio, landing page, resume, docs site, coming-soon page or links page, and has no files yet. Start from a template. It gives a finished, tested design that only needs their details, which beats writing the site from scratch. If they already have files, publish those instead.

## The templates

| Name | What it is | Best for |
|---|---|---|
| `portfolio` | Name up front, four project cards, a short about section and a contact link | Designers, developers, writers showing their work |
| `landing` | Big headline, three benefits, a how-it-works strip, an FAQ and a closing call to action | Launching a product or project |
| `resume` | One page with experience, education, skills and languages; prints neatly to paper or PDF | A job search, or a CV to link from a profile |
| `docs` | Two pages with a sidebar: an introduction with install and quick start, and a guide with configuration, options and troubleshooting | Documenting a library, tool or API |
| `coming-soon` | Launch date, a one-line pitch and an email link | Holding a spot before launch |
| `links` | Link-in-bio page: initials, name, short bio, a highlighted latest link, four more links, profiles and email | One link to put in a social profile |

The coming-soon page has no signup form on purpose. Templates are static pages that never collect or store visitors' details, so interested people email the user instead. Do not add a form that posts anywhere.

## The flow

1. **Pick.** Call `template(action: "list")` and help the user choose.
2. **Create.** Call `template(action: "create", name, directory)` with a new folder, e.g. `./my-portfolio`. The result lists every placeholder with a hint, and every link still pointing at `#`.
3. **Fill the text.** Every `[[...]]` in the files is a placeholder for the user's real details, e.g. `[[Your name]]` or `[[Launch date, e.g. spring 2027]]`. Replace each one, brackets included. Ask for anything you don't know. Never invent facts about the user (jobs, clients, dates, numbers, quotes). If they have nothing for a section, remove it.
4. **Fill the links.** An element with `href="#"` and a `data-placeholder-href` attribute is a link waiting for a real address; the attribute says what goes there. Set `href` to the real URL (`mailto:` for email) and delete the `data-placeholder-href` attribute, or remove the link.
5. **Scan.** Search every file in the folder for `[[` and `data-placeholder-href`. Both must be gone before you publish. Fix any you find and scan again.
6. **Show the user.** Summarise what is on each page (headline, sections, links and where they go) and ask if it's right. Wait for a yes.
7. **Publish.** Call `publish` on the folder (`references/publishing.md`).

## Customising

Changing colours, wording, sections and layout is fine. Keep the site self-contained: no CDNs, no remote fonts, no analytics or trackers, no external scripts. Use the system font stack and inline SVG. Keep the `prefers-color-scheme` dark styles working if you change colours.

## Limits

- **Local AI tools only.** `template` works in Claude Code, Codex, Gemini CLI and Antigravity. Hosted MCP clients (connectors in a chat app) don't have it yet. There, write the site by hand or ask the user to switch to a local tool.
- **Never overwrites.** `create` refuses a folder that already has files. If the user explicitly wants the template added to an existing folder, pass `allow_non_empty: true`. Even then, any file name clash is refused with nothing written. Don't pass the flag on your own.
- To start over, create into a new folder. Don't delete the user's files to make room.
