---
author: David Mashburn
created_at: 2026-04-22T09:58:00Z
modified_at: 2026-04-22T09:58:00Z
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

Define Cursor command/task integration for `threadbridge` so users can run thread/session conversions from editor workflows.

## Trigger Conditions

Use this skill when user asks for:

- one-click thread import/export actions
- cross-env thread recovery from within Cursor
- Codex/T3 migration from the active workspace context

## Suggested Cursor Commands

- `Threadbridge: List T3 Threads`
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit 10`
- `Threadbridge: Copy T3 Thread (dev -> userdata)`
  - `threadbridge t3 copy <thread> --source-db-path ~/.t3/dev/state.sqlite --db-path ~/.t3/userdata/state.sqlite --busy-timeout-ms 5000 --lock-retries 20 --retry-delay-ms 500`
- `Threadbridge: Import Codex Session to T3`
  - `threadbridge codex to-t3 <session> --root ~/.codex/sessions --db-path ~/.t3/userdata/state.sqlite`
- `Threadbridge: Export T3 Thread to Codex`
  - `threadbridge t3 to-codex <thread> --db-path ~/.t3/userdata/state.sqlite --root ~/.codex/sessions`

## Safety Rules

- Command entries that write state should require explicit target selection and confirmation.
- Keep backups on for write commands.
- Keep `--copy-runtime` out of default command definitions.

## UX Expectations

Each command should print a compact receipt in terminal/output:

- source id
- target id
- copied/exported counts
- backup path (write paths)
- follow-up hint if UI reload is needed
