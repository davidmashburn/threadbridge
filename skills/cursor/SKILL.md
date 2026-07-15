---
author: David Mashburn
created_at: 2026-04-22T09:58:00Z
modified_at: 2026-07-15T01:18:18Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/eb53314
---

# Cursor Skill: threadbridge

## Purpose

Run `threadbridge` conversions from Cursor, including cross-harness operations where Cursor is not the source or target.

## Trigger Conditions

Use this skill when the user asks to:

- list Cursor chats/threads or T3 threads
- copy Cursor chats or T3 threads
- convert between Cursor and T3
- recover a thread from dev/non-dev environments
- convert threads between providers (e.g., Cursor to OpenCode, Claude to Codex)

## Command Mapping

For agent-driven reads, append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

### Cursor Operations
- List Cursor chats (ACP + Composer):
  - `threadbridge cursor list --limit <N>`
- Copy Cursor chat:
  - `threadbridge cursor copy <CHAT|last> --dest-chat-id <NEW_ID>`

### T3 Operations with Provider Conversion
- List T3 threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- **Convert Cursor thread to OpenCode with zen big-pickle**:
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <PROJECT_ID> --new-provider opencode --new-model "opencode/big-pickle" --title "Now using OpenCode big-pickle"`

### Cross-Provider Conversions
- Cursor -> T3:
  - `threadbridge cursor to-t3 <CHAT|last> --db-path ~/.t3/userdata/state.sqlite`
- T3 -> Cursor:
  - `threadbridge t3 to-cursor <THREAD|last> --db-path ~/.t3/userdata/state.sqlite`
- **Convert to different provider** (e.g., Codex to Cursor):
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <TARGET_PROJECT> --new-provider cursor`

### Provider Options
- `--new-provider`: Convert to provider (`codex`, `claudeAgent`, `opencode`, `cursor`)
- `--new-model`: Set model for target provider (e.g., `opencode/big-pickle`, `gpt-5.4`)
- `--new-model-selection`: Full JSON for advanced config
- `--new-project-id`: Target workspace/project ID

## Safety Rules

- Read commands can execute immediately.
- For write commands, show the exact command and wait for explicit approval.
- Keep runtime/session state out of copies unless user explicitly asks:
  - default: no `--copy-runtime`
  - opt-in only
- Keep backups enabled by default (do not pass `--no-backup` unless requested).

## Response Contract

After running, report:

- source ID/path
- target ID/path
- counts (messages/turns/activities when available)
- backup path for DB writes
- note to reload harness UI if needed
- provider conversion details (if applicable)
