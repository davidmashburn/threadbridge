---
author: David Mashburn
created_at: 2026-04-22T09:58:00Z
modified_at: 2026-05-01T03:30:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/eb53314
---

# Codex Skill: threadbridge

## Purpose

Run `threadbridge` conversions from Codex, including cross-harness operations where Codex is not the source or target.

## Trigger Conditions

Use this skill when the user asks to:

- list Codex or T3 threads/sessions
- copy threads/sessions
- convert between Codex and T3
- recover a thread from dev/non-dev environments
- convert threads between providers (e.g., Claude to OpenCode, Cursor to Codex)

## Command Mapping

### Codex Operations
- List Codex sessions:
  - `threadbridge codex list --root ~/.codex/sessions --limit <N>`
- Copy Codex session:
  - `threadbridge codex copy <SESSION|last> --root ~/.codex/sessions --dest-root ~/.codex/sessions`

### T3 Operations
- List T3 threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- Copy T3 thread (same DB):
  - `threadbridge t3 copy <THREAD|last> --source-db-path ~/.t3/dev/state.sqlite --db-path ~/.t3/userdata/state.sqlite`
- **Copy T3 thread to new workspace with provider conversion**:
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <PROJECT_ID> --new-provider opencode --new-model "opencode/big-pickle" --title "Converted to OpenCode"`

### Cross-Provider Conversions
- Codex -> T3:
  - `threadbridge codex to-t3 <SESSION|last> --root ~/.codex/sessions --db-path ~/.t3/userdata/state.sqlite`
- T3 -> Codex:
  - `threadbridge t3 to-codex <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --root ~/.codex/sessions`
- **Convert to different provider** (e.g., Claude to OpenCode):
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <TARGET_PROJECT> --new-provider opencode --new-model "opencode/big-pickle"`

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
