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

# T3 Skill: threadbridge

## Purpose

Provide T3-side operational recipes for thread recovery, cross-env copy, and Codex import/export using `threadbridge`.

## Trigger Conditions

Use this skill when the user asks to:

- copy threads between `~/.t3/dev` and `~/.t3/userdata`
- import a Codex session into T3
- export a T3 thread to Codex
- diagnose missing recovered thread entries after copy

## Command Mapping

For agent-driven reads, append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

- List threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- Cross-env copy:
  - `threadbridge t3 copy <THREAD|last> --source-db-path ~/.t3/dev/state.sqlite --db-path ~/.t3/userdata/state.sqlite --busy-timeout-ms 5000 --lock-retries 20 --retry-delay-ms 500`
- Import from Codex:
  - `threadbridge codex to-t3 <SESSION|last> --root ~/.codex/sessions --db-path ~/.t3/userdata/state.sqlite`
- Export to Codex:
  - `threadbridge t3 to-codex <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --root ~/.codex/sessions`

## Safety Rules

- Always prefer a new target thread ID for recovery copies when collisions are likely.
- Do not pass `--copy-runtime` unless explicitly requested.
- Preserve backup behavior for writes.
- If locks persist, increase retries/backoff before asking user to stop T3.

## Response Contract

Return:

- source thread/session ID
- target thread/session ID
- copied row/message counts
- backup file path
- follow-up instruction to refresh/reload T3 if UI is stale
