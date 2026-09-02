---
author: David Mashburn
created_at: 2026-09-01T00:00:00Z
generated_by: Codex
generated_for: David Mashburn
repo: https://github.com/davidmashburn/threadbridge
branch: main
---

# Antigravity Skill: threadbridge

## Purpose

Inspect an Antigravity conversation and import its portable transcript into T3.

## Command Mapping

The default Antigravity data root is `~/.gemini/antigravity`. Use `--root` for another Antigravity app-data directory. Prefer `--json` for agent-driven reads, and resolve an exact conversation ID before writing:

```bash
threadbridge antigravity list --root ~/.gemini/antigravity --limit 10 --json
threadbridge antigravity search "<QUERY>" --root ~/.gemini/antigravity --json
threadbridge antigravity show <CONVERSATION_ID> --root ~/.gemini/antigravity --json
```

Import into T3:

```bash
threadbridge antigravity to-t3 <CONVERSATION_ID> \
  --root ~/.gemini/antigravity \
  --db-path ~/.t3/userdata/state.sqlite
```

## Transcript Boundary

Threadbridge reads Antigravity's `brain/<conversationId>/.system_generated/logs/transcript.jsonl` transcript and maps it through the canonical Threadbridge IR. System events and private model reasoning are omitted. Completed tool results are represented as assistant text because T3 transcript import has no portable tool-event row. Runtime/session bindings are not copied.

## Safety Rules

- `list`, `search`, and `show` are read-only.
- Use an exact conversation ID for imports; do not rely on `last` when source selection matters.
- Keep T3 backups enabled unless the user explicitly requests `--no-backup`.
- Do not copy runtime/session state unless explicitly requested.

## Response Contract

After an import, report the source conversation ID/path, created T3 thread ID/path, message and turn counts, backup path, and any transcript-loss warnings.
