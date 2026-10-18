# Site data contract fixtures (read-only snapshot)

Verbatim copy of the frozen site-data contract fixtures.

- Source repo: `/Users/r/repos/wt-backend-sitedata` (backend worktree, read-only)
- Source path: `docs/site-data/fixtures/` (`routes/` and `records/`)
- Source commit: `ce2923d`

This is a snapshot. Do not edit these files by hand: refresh them only by
re-copying the whole directory from the source commit (and update the commit
hash above). The skill's parsers and tools are tested against the `api.*`
route fixtures in `routes/`; the other files are kept so the snapshot stays a
complete, unmodified copy.

Route fixture shape: `{ route, request: { method, path, body? }, responses: [{ name, status, body | bodyLines, contentType? }] }`.
