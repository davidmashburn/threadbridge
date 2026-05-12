---
author: David Mashburn
created_at: 2026-04-22T09:30:00Z
modified_at: 2026-04-22T15:25:00Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/ca70200
---

# Threadbridge Skill Integration Plan

## Goal

Make `threadbridge` callable from multiple harnesses as a common interconversion utility, without requiring the invoking harness to be either the source or target of the conversion.

## Current Reality

This plan keeps **T3 Code out of scope as a direct integration target**.

Working baseline today:

- Codex skills call `threadbridge` CLI.
- `threadbridge` performs Codex/T3 conversions directly.
- T3 can still benefit indirectly when it runs an underlying harness that supports skills (for example Codex).

Out of scope for this plan:

- T3-native server/API/command-palette integration work.

## Guiding Principles

- Keep `threadbridge` CLI as the source of truth for conversion behavior.
- Make harness adapters thin wrappers that translate harness UX into CLI calls.
- Support cross-harness operations directly (`codex -> t3`, `t3 -> codex`, later `codex -> claude`, etc.).
- Bias toward invoking-harness-local workflows, but never require them.
- Keep write operations safe by default (backup on, runtime-copy off, explicit confirmation where supported).

## Shared Contract

Define one adapter-neutral operation model first:

- `list`
- `copy` (within one harness family)
- `to-<target>` (cross-harness)

Standard result payload:

- `operation`
- `source`
- `target`
- `created_ids`
- `counts`
- `backup_path` (if applicable)
- `warnings`

Standard safety defaults:

- backups enabled for write paths
- sqlite lock retries/backoff enabled
- runtime/session state copying disabled unless explicitly requested

## System Scoping

### Codex

- Package as a Codex skill (`SKILL.md`) that shells out to `threadbridge`.
- Support direct cross-harness operations, not just Codex-centric ones.
- Add confirmation gate for production writes.

### T3 Code

- T3 is not a primary skill host in this plan.
- T3 participation is indirect through the active harness underneath it.
- No T3 source modifications are planned here.

### Claude

- Provide an MCP tool wrapper around `threadbridge`.
- Keep read and write paths explicit and separately named.
- Return compact operation receipts for agent chaining.

### OpenCode

- Reuse the same MCP contract as Claude where possible.
- Keep adapter-specific flags hidden from end users.

### Cursor

- Provide command tasks (or extension actions) that invoke `threadbridge`.
- Surface results in terminal/output panel with created IDs and file paths.

## Implementation Phases

### Phase 1: Core Stability

- Freeze command names and flags for current flows:
  - `t3 list/copy/to-codex`
  - `codex list/copy/to-t3`
- Add regression checks for all write/read paths.

### Phase 2: Canonical Interchange

- Add `export --format threadbridge-json` and `import --format threadbridge-json`.
- Define a versioned schema (`schemaVersion`).
- Document compatibility guarantees.

### Phase 3: Harness Adapters

- Codex skill wrapper in `skills/`.
- MCP wrapper for Claude/OpenCode.
- Cursor command pack.
- No T3-native integration phase in this plan.

### Phase 4: Additional Harness Pairs

- Add adapters incrementally:
  - `codex <-> claude`
  - `codex <-> opencode`
  - `claude <-> t3`
- Validate each pair with round-trip tests.

## Risks and Mitigations

- Lock contention in live T3 DB writes.
  - Mitigation: busy timeout + retries + backup + optional stop/start guidance.
- Subtle runtime/session mismatch when copying active sessions.
  - Mitigation: runtime copy off by default and explicitly opt-in.
- Divergent harness semantics for turns/messages/tools.
  - Mitigation: canonical interchange schema with lossy/lossless markers.

## Success Criteria

- A user can run any supported conversion from one command surface.
- All write operations emit deterministic receipts and backup references.
- No harness adapter duplicates conversion logic already in core CLI.
