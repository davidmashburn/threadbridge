---
author: David Mashburn
created_at: 2026-07-15T01:18:18Z
modified_at: 2026-07-15T01:18:18Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/cf2fd573366617324c67ae5f382a16b09911d8a6
---

# Agent guide

Threadbridge reads, searches, copies, and converts AI-harness threads across T3, Codex, Claude, Cursor, and OpenCode.

## Working contract

- Run `npm run check && npm test` after code changes.
- Preserve the canonical IR boundary in `src/ir.js`; adapters read into IR and write from IR.
- Prefer `threadbridge <harness> search <query> --json` before selecting a source.
- Prefer `threadbridge <harness> show <id> --json` for read-only inspection.
- Use `--json` for automation. Parse the top-level `ok`, `command`, and `data` fields; do not scrape human output.
- Treat `list`, `search`, and `show` as read-only. Copy and conversion commands write files or databases.
- Keep SQLite backups enabled and runtime/session bindings excluded unless the user explicitly requests otherwise.
- Never assume `last` when ambiguity matters; search and use an exact returned ID.

## Useful commands

```bash
npm run check
npm test
./bin/threadbridge.js --help
./bin/threadbridge.js t3 search "<query>" --db-path ~/.t3/userdata/state.sqlite --json
./bin/threadbridge.js t3 show <thread-id> --db-path ~/.t3/userdata/state.sqlite --json
./bin/threadbridge.js codex show <session-id> --root ~/.codex/sessions --json
```

Successful JSON commands emit one object to stdout. Failures exit non-zero and emit a JSON error object to stderr when `--json` is present.
