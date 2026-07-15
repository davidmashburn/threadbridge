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

# OpenCode Skill: threadbridge

## Purpose

Run `threadbridge` conversions from OpenCode, including cross-harness operations where OpenCode is not the source or target.

## Trigger Conditions

Use this skill when the user asks to:

- list OpenCode sessions or T3 threads
- copy sessions/threads
- convert between OpenCode and T3
- recover a thread from dev/non-dev environments
- convert threads between providers (e.g., OpenCode to Codex, Claude to Cursor)

## Command Mapping

For agent-driven reads, append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

### OpenCode Operations
- List OpenCode sessions:
  - `threadbridge opencode list --root <OPENCODE_ROOT> --limit <N>`
- Copy OpenCode session:
  - `threadbridge opencode copy <SESSION|last> --root <OPENCODE_ROOT> --dest-root <OPENCODE_ROOT>`

### T3 Operations with Provider Conversion
- List T3 threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- **Convert OpenCode thread to Codex**:
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <PROJECT_ID> --new-provider codex --new-model "gpt-5.4" --title "Now using Codex"`

### Cross-Provider Conversions
- OpenCode -> T3:
  - `threadbridge opencode to-t3 <SESSION|last> --root <OPENCODE_ROOT> --db-path ~/.t3/userdata/state.sqlite`
- T3 -> OpenCode:
  - `threadbridge t3 to-opencode <THREAD|last> --db-path ~/.t3/userdata/state.sqlite`
- **Convert to different provider** (e.g., Claude to OpenCode with zen big-pickle):
  - `threadbridge t3 copy-to-workspace <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --new-project-id <TARGET_PROJECT> --new-provider opencode --new-model "opencode/big-pickle"`

### Provider Options
- `--new-provider`: Convert to provider (`codex`, `claudeAgent`, `opencode`, `cursor`)
- `--new-model`: Set model for target provider (e.g., `opencode/big-pickle`, `gpt-5.4`, `claude-sonnet-4-6`)
- `--new-model-selection`: Full JSON for advanced config
- `--new-project-id`: Target workspace/project ID

### OpenCode-Specific Models
- `opencode/big-pickle` - zen big-pickle model
- `google/gemma-4-31b-it` - Gemma 4 31B
- `openrouter/*` - OpenRouter models

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
