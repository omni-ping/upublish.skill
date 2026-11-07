# Backend contract fixtures (read-only snapshot)

Verbatim copy of the frozen user-backends contract fixtures.

- Source repo: `upublish-backend` (branch `feature/user-backends`, read-only here)
- Source path: `docs/backend/fixtures/` (`routes/`, `records/`, `manifest.json`)
- Last source commit touching the fixtures: `a4f6004`

This is a snapshot. Do not edit these files by hand: refresh them only by re-copying the whole directory from the
source (and update the commit above). `manifest.json` pins the sha256 of every fixture file;
`lib/backend-fixtures.test.ts` fails when a file here drifts from it, or when a file is added or removed.

The skill's parsers and tools are replayed against the `routes/*.json` fixtures. `records/` (KV records, props, upload
and response policy) belongs to the Worker and server; it is kept so the snapshot stays a complete, unmodified copy.

Route fixture shape: `{ route, request: { method, path, query?, body? }, responses: [{ name, status, body }] }`.
