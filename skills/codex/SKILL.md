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

# Codex Skill: threadbridge

## Purpose

Run `threadbridge` conversions from Codex, including cross-harness operations where Codex is not the source or target.

## Trigger Conditions

Use this skill when the user asks to:

- list Codex or T3 threads/sessions
- copy threads/sessions
- convert between Codex and T3
- recover a thread from dev/non-dev environments

## Command Mapping

- List Codex sessions:
  - `threadbridge codex list --root ~/.codex/sessions --limit <N>`
- Copy Codex session:
  - `threadbridge codex copy <SESSION|last> --root ~/.codex/sessions --dest-root ~/.codex/sessions`
- Codex -> T3:
  - `threadbridge codex to-t3 <SESSION|last> --root ~/.codex/sessions --db-path ~/.t3/userdata/state.sqlite`
- List T3 threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/state.sqlite --limit <N>`
- Copy T3 thread:
  - `threadbridge t3 copy <THREAD|last> --source-db-path ~/.t3/dev/state.sqlite --db-path ~/.t3/userdata/state.sqlite`
- T3 -> Codex:
  - `threadbridge t3 to-codex <THREAD|last> --db-path ~/.t3/userdata/state.sqlite --root ~/.codex/sessions`

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
