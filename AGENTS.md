---
author: David Mashburn
created_at: 2026-07-15T01:18:18Z
modified_at: 2026-07-15T04:48:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/a4bcda821c8974a9e2ff559dd62b286ca560de27
---

# Agent guide

Threadbridge reads, searches, copies, and converts AI-harness threads across T3, Codex, Claude, Cursor, and OpenCode.

## Working contract

- Run `npm run check && npm test` after code changes.
- Preserve the canonical IR boundary in `src/ir.js`; adapters read into IR and write from IR.
- **Inside T3 Code**, prefer `t3_thread_search` and `t3_thread_read` for T3 thread discovery and read-only inspection. Local `threadbridge t3 list|search|show` reads the SQLite projection only; live app threads can be absent there (see `skills/t3/SKILL.md`).
- Outside T3 Code, prefer `threadbridge <harness> search <query> --json` before selecting a source.
- Outside T3 Code, prefer `threadbridge <harness> show <id> --json` for read-only inspection and canonical IR.
- Use `--json` for automation. Parse the top-level `ok`, `command`, and `data` fields; do not scrape human output.
- Treat `list`, `search`, and `show` as read-only. Copy and conversion commands write files or databases.
- Keep SQLite backups enabled and runtime/session bindings excluded unless the user explicitly requests otherwise.
- Never assume `last` when ambiguity matters; search and use an exact returned ID.

## Useful commands

```bash
npm run check
npm test
./bin/threadbridge.js --help
./bin/threadbridge.js t3 search "<query>" --db-path ~/.t3/userdata/statev2.sqlite --json
./bin/threadbridge.js t3 show <thread-id> --db-path ~/.t3/userdata/statev2.sqlite --json
./bin/threadbridge.js codex show <session-id> --root ~/.codex/sessions --json
```

JSON commands emit one object to stdout for both success and failure. Failures also exit non-zero; ignore unrelated runtime warnings on stderr.
