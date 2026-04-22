---
author: David Mashburn
created_at: 2026-04-22T08:00:00Z
modified_at: 2026-04-22T09:05:00Z
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
- `t3 to-codex`: export one T3 thread into a Codex session file
- `codex list`: list recent Codex sessions
- `codex copy`: copy one Codex session to another Codex root as a new session ID
- `codex to-t3`: import one Codex session into T3 as a new thread

The T3 copy/import flows are designed for live usage while T3 is open:
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

List T3 threads:

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

List Codex sessions:

```bash
./bin/threadbridge.js codex list --root ~/.codex/sessions --limit 5
```

Import Codex to T3:

```bash
./bin/threadbridge.js codex to-t3 last \
  --root ~/.codex/sessions \
  --db-path ~/.t3/userdata/state.sqlite
```

Export T3 to Codex:

```bash
./bin/threadbridge.js t3 to-codex last \
  --db-path ~/.t3/userdata/state.sqlite \
  --root ~/.codex/sessions
```

Copy Codex session between roots:

```bash
./bin/threadbridge.js codex copy last \
  --root ~/.codex/sessions \
  --dest-root ~/.codex/sessions
```

Optional flags:
- `--title "New thread title"`: override copied title
- `--new-thread-id <uuid>`: set target thread ID manually
- `--copy-runtime`: also copy session/runtime rows
- `--no-backup`: skip automatic backup

## Notes

- Default behavior does **not** copy runtime/session bindings.
- That keeps copied threads as safe historical snapshots unless you explicitly opt in with `--copy-runtime`.
