---
author: David Mashburn
created_at: 2026-04-22T08:00:00Z
modified_at: 2026-07-15T04:48:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
---

# threadbridge

`threadbridge` is a harness thread interconversion toolkit.

Current scope:
- `t3 list`: list recent threads in a T3 SQLite DB
- `<harness> search`: find sessions by title or prompt; T3 also searches message bodies
- `<harness> show`: inspect a thread as a transcript or canonical Threadbridge IR
- `t3 copy`: copy one thread from a source T3 DB to a target T3 DB as a new thread ID
- `t3 copy-to-workspace`: copy a thread to a new workspace/project within the same DB with optional provider change
- `t3 to-codex`: export one T3 thread into a Codex session file
- `t3 to-claude`: export one T3 thread into a Claude session file
- `t3 to-cursor`: export one T3 thread into a Cursor chat
- `t3 to-opencode`: export one T3 thread into an OpenCode session
- `codex list`: list recent Codex sessions
- `codex copy`: copy one Codex session to another Codex root as a new session ID
- `codex to-t3`: import one Codex session into T3 as a new thread
- `claude list|copy|to-t3`: inspect, duplicate, and import Claude sessions
- `cursor list|copy|to-t3`: inspect, duplicate, and import Cursor ACP/Composer chats
- `opencode list|copy|to-t3`: inspect, duplicate, and import OpenCode sessions
- `--json`: return stable success/error envelopes for agent and script integration

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

Prerequisites:
- Node.js 22+
- `sqlite3` available on `PATH` for backup-enabled T3 import/copy flows

## Usage

### Agent and script usage

Every command accepts `--json`. Successful commands write one JSON object to stdout:

```json
{
  "ok": true,
  "command": "codex list",
  "data": []
}
```

Failures exit non-zero and write `{ "ok": false, "error": { "message": "..." } }` to stdout as well, keeping the JSON channel reliable even when the Node runtime emits warnings on stderr. List and search commands return arrays in `data`; copy and conversion commands return operation receipts with source, target, created IDs, counts, warnings, and backup path.

Use `show --json` to read a complete thread in the versioned, harness-neutral Threadbridge IR without changing anything:

```bash
./bin/threadbridge.js codex show last --root ~/.codex/sessions --json
./bin/threadbridge.js t3 show <thread-id> --db-path ~/.t3/userdata/state.sqlite --json
./bin/threadbridge.js claude show last --project-path ~/src/my-project --json
```

The IR includes `schemaVersion`, source metadata, thread/project metadata, normalized content blocks, messages, turns, activities, plans, runtime capabilities, warnings, and adapter extensions. T3 runtime bindings remain excluded unless `--copy-runtime` is explicitly supplied.

Search before choosing a target instead of relying on `last`:

```bash
./bin/threadbridge.js t3 search "PLAT-403" --db-path ~/.t3/userdata/state.sqlite --json
./bin/threadbridge.js codex search "persistence" --root ~/.codex/sessions --json
```

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

Copy thread to a new workspace/project within the same DB (useful for changing providers or workdir):

```bash
./bin/threadbridge.js t3 copy-to-workspace 09ae8d8f-d340-4f2f-b14b-e152daf4e3a7 \
  --db-path ~/.t3/userdata/state.sqlite \
  --new-project-id 872e5864-f911-47e2-8958-1b4d9acadcc9 \
  --new-provider opencode \
  --new-model "opencode/big-pickle" \
  --title "Continued in t3code workspace with OpenCode"
```

Convert from Claude to OpenCode with zen big-pickle model:

```bash
./bin/threadbridge.js t3 copy-to-workspace last \
  --db-path ~/.t3/userdata/state.sqlite \
  --new-project-id 872e5864-f911-47e2-8958-1b4d9acadcc9 \
  --new-provider opencode \
  --new-model "opencode/big-pickle"
```

Use custom model selection JSON for advanced configuration:

```bash
./bin/threadbridge.js t3 copy-to-workspace last \
  --db-path ~/.t3/userdata/state.sqlite \
  --new-project-id 872e5864-f911-47e2-8958-1b4d9acadcc9 \
  --new-model-selection '{"provider":"opencode","model":"opencode/big-pickle","options":[{"id":"agent","value":"build"}]}' \
  --title "Custom OpenCode config"
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

List Claude sessions for a project:

```bash
./bin/threadbridge.js claude list ~/src/my-project --limit 5
```

Copy a Claude session into another project:

```bash
./bin/threadbridge.js claude copy last \
  --project-path ~/src/my-project \
  --dest-project-path ~/src/other-project
```

Import a Cursor chat into T3:

```bash
./bin/threadbridge.js cursor to-t3 last \
  --db-path ~/.t3/userdata/state.sqlite
```

List OpenCode sessions:

```bash
./bin/threadbridge.js opencode list --root ~/.local/share/opencode/storage --limit 5
```

Copy an OpenCode session between roots:

```bash
./bin/threadbridge.js opencode copy last \
  --root ~/.local/share/opencode/storage \
  --dest-root ~/.local/share/opencode/storage
```

Optional flags:
- `--title "New thread title"`: override copied title
- `--new-thread-id <uuid>`: set target thread ID manually
- `--copy-runtime`: also copy session/runtime rows
- `--no-backup`: skip automatic backup
- `--json`: emit machine-readable output (available on every command)

## Notes

- Default behavior does **not** copy runtime/session bindings.
- That keeps copied threads as safe historical snapshots unless you explicitly opt in with `--copy-runtime`.
- `copy` and `to-t3` commands require the source database or session root to exist.
- Ambiguous targets fail fast instead of guessing.
- Live T3 copy/import flows use a lock retry/backoff loop and a pre-write SQLite backup unless `--no-backup` is set.
