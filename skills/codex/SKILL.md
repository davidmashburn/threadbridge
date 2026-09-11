---
author: David Mashburn
created_at: 2026-04-22T09:58:00Z
modified_at: 2026-09-11T20:00:00Z
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

For agent-driven reads, append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

Prefer `search` over `last`. `last` resolves to whichever session was touched most recently, which is frequently not the one the user means.

### Codex Operations
- Find a session by title or prompt text:
  - `threadbridge codex search "<QUERY>" --root ~/.codex/sessions --json`
- List Codex sessions:
  - `threadbridge codex list --root ~/.codex/sessions --limit <N>`
- Inspect a session as canonical IR without writing anything:
  - `threadbridge codex show <SESSION|last> --root ~/.codex/sessions --json`
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

## What a bridged Codex thread contains

A conversion carries the conversation plus the commands that were run. It does not carry
tool output or reasoning, because outputs dominate a rollout's size while the command that
produced them carries the meaning.

- Tool calls appear as `tool-call` blocks, rendered in text as `$ <command>` for shell work
  and `[<tool>] <input>` otherwise. Pass `--no-tool-calls` to omit them.
- Tool results and reasoning are always dropped. The IR's `warnings` array reports how many.
- Harness-injected context — `<environment_context>`, `<recommended_plugins>`, AGENTS.md
  instructions — is filtered per content part, so a real prompt sharing a message with
  injected context survives. Pass `--include-boilerplate` to keep it.

Report the `warnings` array when summarizing a conversion so the user knows what was lost.

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
