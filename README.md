---
author: David Mashburn
created_at: 2026-04-22T08:00:00Z
modified_at: 2026-04-22T08:00:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
---

# threadbridge

`threadbridge` is a harness thread interconversion toolkit.

Current scope:
- `t3 list`: list recent threads in a T3 SQLite DB
- `t3 copy`: copy one thread from a source T3 DB to a target T3 DB as a new thread ID

The copy flow is designed for live usage while T3 is open:
- SQLite `busy_timeout`
- lock retry/backoff loop
- pre-write backup by default
- ID remapping for thread/message/turn/activity/plan rows to avoid PK collisions

## Install

```bash
npm install
npm run check
```

## Usage

List threads:

```bash
./bin/threadbridge.js t3 list --db-path ~/.t3/userdata/state.sqlite --limit 5
```

Copy from dev to non-dev:

```bash
./bin/threadbridge.js t3 copy 262fa54b-9c91-4df8-87a8-ed691fde2bb9 \
  --source-db-path ~/.t3/dev/state.sqlite \
  --db-path ~/.t3/userdata/state.sqlite \
  --busy-timeout-ms 5000 \
  --lock-retries 20 \
  --retry-delay-ms 500
```

Optional flags:
- `--title "New thread title"`: override copied title
- `--new-thread-id <uuid>`: set target thread ID manually
- `--copy-runtime`: also copy session/runtime rows
- `--no-backup`: skip automatic backup

## Notes

- Default behavior does **not** copy runtime/session bindings.
- That keeps copied threads as safe historical snapshots unless you explicitly opt in with `--copy-runtime`.
