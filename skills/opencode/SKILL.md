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

# OpenCode Skill: threadbridge

## Purpose

Define OpenCode-side invocation rules for `threadbridge` operations, including non-OpenCode source/target conversions.

## Trigger Conditions

Use this skill when user intent is:

- session/thread migration
- environment recovery
- cross-harness portability

## Command Templates

- `threadbridge codex list --root <codexRoot> --limit <N>`
- `threadbridge codex copy <sessionTarget> --root <codexRoot> --dest-root <codexRoot>`
- `threadbridge codex to-t3 <sessionTarget> --root <codexRoot> --db-path <t3DbPath>`
- `threadbridge t3 list --db-path <t3DbPath> --limit <N>`
- `threadbridge t3 copy <threadTarget> --source-db-path <sourceDb> --db-path <targetDb>`
- `threadbridge t3 to-codex <threadTarget> --db-path <t3DbPath> --root <codexRoot>`

## Safety Rules

- Prompt for approval before write operations.
- Do not disable backup by default.
- Only include `--copy-runtime` on explicit user request.
- Include lock retry flags for T3 DB writes in active environments.

## Receipt Requirements

Always return:

- operation name
- source and target ids/paths
- row/message counts
- backup path
- warnings about UI reload/stale caches when relevant
