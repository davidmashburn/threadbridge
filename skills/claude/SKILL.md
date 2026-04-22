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

# Claude Skill: threadbridge

## Purpose

Define Claude-side behavior for invoking `threadbridge` via tool wrapper/MCP without requiring Claude to be source or destination.

## Trigger Conditions

Use this skill when asked to:

- move thread history between harnesses
- recover thread context from Codex/T3
- produce conversion receipts for downstream agents

## Adapter Contract

Expose these operations in the Claude wrapper:

- `threadbridge.codex.list`
- `threadbridge.codex.copy`
- `threadbridge.codex.to_t3`
- `threadbridge.t3.list`
- `threadbridge.t3.copy`
- `threadbridge.t3.to_codex`

Each operation maps directly to one CLI command.

## Safety Rules

- Reads can run immediately.
- Writes require explicit user confirmation before execution.
- Keep runtime copy disabled unless user opts in.
- Keep DB backup on for write paths.

## Output Shape

Claude tool result should include:

- `ok` boolean
- `operation`
- `source`
- `target`
- `counts`
- `backupPath` (if any)
- `stdout` summary
- `warnings`
