---
author: David Mashburn
created_at: 2026-04-22T09:55:00Z
modified_at: 2026-07-15T04:48:00Z
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

- `skills/codex/SKILL.md` - Codex CLI thread bridge operations
- `skills/claude/SKILL.md` - Claude CLI thread bridge operations  
- `skills/cursor/SKILL.md` - Cursor CLI thread bridge operations
- `skills/opencode/SKILL.md` - OpenCode CLI thread bridge operations
- `skills/t3/SKILL.md` - T3 thread bridge operations

## Key Features

All skills now support **provider conversion** using the new `t3 copy-to-workspace` command:

- Convert threads between providers (Codex ↔ Claude ↔ OpenCode ↔ Cursor)
- Change models when switching providers
- Example: Convert Claude thread to OpenCode with zen big-pickle model
- Example: Convert Codex thread to T3 with different workspace/project

## Common Operations

### Agent-readable discovery

Prefer `--json` for all agent-driven commands. Use `search` to resolve a specific source and `show --json` to inspect its canonical IR before proposing a write:

```bash
threadbridge t3 search "<query>" --db-path ~/.t3/userdata/state.sqlite --json
threadbridge t3 show <THREAD_ID> --db-path ~/.t3/userdata/state.sqlite --json
```

Successful output is `{ "ok": true, "command": "...", "data": ... }`. Failures exit non-zero and emit `{ "ok": false, "error": { "message": "..." } }` on stdout. Do not scrape the human-readable format or stderr warnings.

### Provider Conversion (All Skills)
```bash
threadbridge t3 copy-to-workspace <THREAD|last> \
  --db-path ~/.t3/userdata/state.sqlite \
  --new-project-id <PROJECT_ID> \
  --new-provider opencode \
  --new-model "opencode/big-pickle" \
  --title "Converted to OpenCode"
```

### Cross-Provider Support
Each skill includes command templates for:
- Listing sessions/threads
- Copying within same provider
- Converting to/from T3
- **Converting between different providers** (new!)

## Safety Rules

- Read commands (`list`) are safe to run immediately.
- Write commands (`copy`, `to-*`, `copy-to-workspace`) should show the exact command first and require explicit user confirmation.
- Use `--copy-runtime` only when the user explicitly asks for live session/runtime state to be copied.
- Include operation receipts in responses:
  - source id
  - target id
  - rows/messages copied
  - backup path when produced
  - provider conversion details (if applicable)
