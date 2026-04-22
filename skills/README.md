---
author: David Mashburn
created_at: 2026-04-22T09:55:00Z
modified_at: 2026-04-22T09:55:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/eb53314
---

# Threadbridge Skills

This directory contains harness-specific skill specs that wrap the same `threadbridge` core CLI.

Available skills:

- `skills/codex/SKILL.md`
- `skills/t3/SKILL.md`
- `skills/claude/SKILL.md`
- `skills/opencode/SKILL.md`
- `skills/cursor/SKILL.md`

Common expectations across all skills:

- Read commands (`list`) are safe to run immediately.
- Write commands (`copy`, `to-*`) should show the exact command first and require explicit user confirmation.
- Use `--copy-runtime` only when the user explicitly asks for live session/runtime state to be copied.
- Include operation receipts in responses:
  - source id
  - target id
  - rows/messages copied
  - backup path when produced
