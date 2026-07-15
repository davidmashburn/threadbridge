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

# Claude Skill: threadbridge

## Purpose

Run `threadbridge` conversions from Claude, including cross-harness operations where Claude is not the source or target.

## Trigger Conditions

Use this skill when the user asks to:

- list Claude or T3 threads/sessions
- copy threads/sessions
- convert between Claude and T3
- recover a thread from dev/non-dev environments
- convert threads between providers (e.g., Claude to OpenCode, Codex to Cursor)

## Command Mapping

For agent-driven reads, append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

### Claude Operations
- List Claude sessions:
  - `threadbridge claude list <PROJECT_PATH> --limit <N>`
- Copy Claude session:
  - `threadbridge claude copy <SESSION|last> --project-path <DIR> --dest-project-path <DIR>`

### T3 Operations with Provider Conversion
- List T3 threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- **Convert Claude thread to OpenCode**:
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <PROJECT_ID> --new-provider opencode --new-model "opencode/big-pickle" --title "Now using OpenCode"`

### Cross-Provider Conversions
- Claude -> T3:
  - `threadbridge claude to-t3 <SESSION|last> --project-path <DIR> --db-path ~/.t3/userdata/state.sqlite`
- T3 -> Claude:
  - `threadbridge t3 to-claude <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --project-path <DIR>`
- **Convert to different provider** (e.g., Codex to Claude):
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <TARGET_PROJECT> --new-provider claudeAgent --new-model "claude-sonnet-4-6"`

### Provider Options
- `--new-provider`: Convert to provider (`codex`, `claudeAgent`, `opencode`, `cursor`)
- `--new-model`: Set model for target provider
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
