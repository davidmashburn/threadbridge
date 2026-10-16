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

### T3 Code (MCP): read live threads

When the `t3-code` MCP server is available (T3 Code, Cursor harness with T3 orchestration), use it for **read-only** access to threads the user sees in the app. Do not start with `threadbridge t3 show` for “continue from thread \<id\>” or handoff prompts.

- Find threads: `t3_thread_search` with a query (prefer over `last`).
- Read a thread: `t3_thread_read` with `threadId`, paginate with `afterPosition` / `nextPosition`, and recover long text with `itemId` + `textOffset` when `textTruncated` is true.
- Mention another thread to the user: `[title](t3-thread://v1/<threadId>)` using the exact `threadId` from the tool.

`threadbridge t3 list|search|show` reads local SQLite (`--db-path`, default `~/.t3/userdata/statev2.sqlite` when present, else `state.sqlite`). Supported T3 v2 reads follow canonical turn items, including inherited fork history, inside a SQLite snapshot; legacy DBs use `projection_*`. MCP `t3_thread_read` is still fine for in-app handoffs; use threadbridge for IR export and cross-harness work.

Use the CLI below when you need **canonical Threadbridge IR**, **cross-env copy**, or **export/import to another harness** — not for ordinary “load context from this T3 thread” inside T3 Code.

### threadbridge CLI (SQLite + writes)

For agent-driven CLI reads (Codex-only agents, scripts, or IR export), append `--json`. Use `search` to resolve an exact ID and `show <ID> --json` to inspect canonical IR before proposing a write. Parse the JSON envelope instead of human-readable output.

Prefer `search` over `last`. `last` resolves to whichever thread was touched most recently,
which is frequently not the one the user means. T3 search also matches message bodies.

- Find a thread by title, prompt, or message text:
  - `threadbridge t3 search "<QUERY>" --db-path ~/.t3/userdata/statev2.sqlite --json`
- List threads:
  - `threadbridge t3 list --db-path ~/.t3/userdata/statev2.sqlite --limit <N>`
- Inspect a thread as canonical IR without writing anything:
  - `threadbridge t3 show <THREAD|last> --db-path ~/.t3/userdata/statev2.sqlite --json`
- Cross-env copy:
  - `threadbridge t3 copy <THREAD|last> --source-db-path ~/.t3/dev/statev2.sqlite --db-path ~/.t3/userdata/statev2.sqlite --busy-timeout-ms 5000 --lock-retries 20 --retry-delay-ms 500`
- Import from Codex:
  - `threadbridge codex to-t3 <SESSION|last> --root ~/.codex/sessions --db-path ~/.t3/userdata/statev2.sqlite`
- Export to Codex:
  - `threadbridge t3 to-codex <THREAD|last> --db-path ~/.t3/userdata/statev2.sqlite --root ~/.codex/sessions`

## Fidelity when importing from Codex

`codex to-t3` carries the conversation plus the commands that were run, not tool output or
reasoning. The IR's `warnings` array reports the counts that were dropped — surface it when
summarizing, so the user knows the imported thread has the narrative and the commands but
not the command output.

## Safety Rules

- Always prefer a new target thread ID for recovery copies when collisions are likely.
- Stop T3 before writing v2 databases. Native offline imports support the tested stock v0.1.0 schema; unsupported/stale schemas fail without a legacy fallback.
- V2 copies preserve portable history with fresh IDs and no execution bindings. Tool/activity records become labelled text; missing attachment files produce receipt warnings.
- Do not pass `--copy-runtime` unless explicitly requested for a legacy v1 target. It is rejected for v2 targets.
- Preserve backup behavior for writes.
- If locks persist, increase retries/backoff before asking user to stop T3.

## Response Contract

Return:

- source thread/session ID
- target thread/session ID
- copied row/message counts
- backup file path
- follow-up instruction to refresh/reload T3 if UI is stale
