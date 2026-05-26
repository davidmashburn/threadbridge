---
author: David Mashburn
created_at: 2026-05-26T18:49:25Z
modified_at: 2026-05-26T18:49:25Z
generated_by: Codex
generated_for: David Mashburn
reviewed_by:
approved_by:
repo: https://github.com/davidmashburn/threadbridge
branch: main
repo_branch_url: https://github.com/davidmashburn/threadbridge/tree/main
repo_head_commit_url: https://github.com/davidmashburn/threadbridge/commit/e15e8d9d38d5b4cb774e462d6aa80c7dec5558c2
---

# Thread Copy Refactor Plan

## Goal

Refactor `threadbridge` so thread copying and cross-harness transfer are built on a shared, explicit conversion core instead of a growing set of pairwise adapters.

The immediate motivation is to replace the current "copy threads around" implementation model with a more modular architecture that can:

- preserve `threadbridge`'s current safe T3 write behavior
- support neutral transcript- and event-level interchange
- allow harness-specific resume or fork behavior as an optional layer, not the core abstraction
- make future harness additions incremental instead of combinatorial

This document is a planning artifact only. No implementation is included here.

## Problem Statement

Today the repository mixes two different strategies:

- direct storage cloning for some harnesses
- transcript export/import for other harness pairs

That works for the current narrow surface area, but the architecture will become brittle as additional harnesses and richer message semantics are added.

The main structural issues are:

- T3 copy logic is specialized and highly coupled to SQLite row layouts.
- Harness parsers and writers do not share a formal intermediate representation.
- Pairwise conversions risk duplicating lossy mapping logic.
- Runtime/session continuation semantics are mixed into data conversion concerns.
- The CLI surface does not yet express a first-class distinction between:
  - cloning storage state
  - converting conversational content
  - resuming/forking live sessions through native harness commands

## Current Architecture

### Storage-first paths

- `src/t3-copy.js` snapshots T3 relational rows, remaps IDs, and inserts them into a target DB.
- This path preserves thread metadata, turns, activities, proposed plans, and optional runtime/session rows.
- It is the strongest current implementation in terms of fidelity and safety.

### Transcript-first paths

- `src/bridge.js` converts between T3 exports and Codex session JSONL.
- `src/codex.js`, `src/claude.js`, and `src/opencode.js` read harness-native stores and expose simplified transcript-oriented objects.
- These paths are useful but do not yet share one explicit contract for message/tool/reasoning semantics.

### Consequence

The project currently has useful building blocks, but not a single source of truth for conversion semantics.

## Target Architecture

Refactor around three layers.

### Layer 1: Source adapters

Each harness gets a reader that emits one canonical in-memory object model.

Responsibilities:

- resolve source target IDs or paths
- read native storage
- normalize metadata, transcript content, tool usage, reasoning, attachments, and lineage
- report fidelity markers when source data cannot be represented losslessly

### Layer 2: Canonical conversion core

This becomes the heart of `threadbridge`.

Responsibilities:

- define the intermediate representation
- validate and normalize it
- support transforms between:
  - full-fidelity thread clone intent
  - transcript-only import/export intent
  - workspace rebinding intent
  - model/provider override intent
- generate receipts, warnings, and counts consistently

### Layer 3: Target adapters

Each harness gets one writer that accepts the canonical model plus write intent.

Responsibilities:

- create native storage artifacts
- preserve safe defaults
- surface lossy writes explicitly
- optionally attach runtime/session state only when supported and requested

## Canonical Intermediate Representation

Introduce a versioned internal model, tentatively called `ThreadbridgeIR`.

### Top-level shape

- `schemaVersion`
- `source`
- `thread`
- `project`
- `messages`
- `turns`
- `activities`
- `plans`
- `runtime`
- `lineage`
- `capabilities`
- `warnings`

### `source`

- harness name
- harness version if available
- source thread/session identifier
- original path or DB reference
- extraction timestamp

### `thread`

- logical thread ID
- title
- created/updated timestamps
- workspace root
- branch/worktree metadata
- runtime mode
- interaction mode
- model selection

### `project`

- project/workspace identifier
- title
- workspace root
- harness-specific defaults if relevant

### `messages`

Each message should support more than flat text.

- logical message ID
- role
- timestamp fields
- content blocks
- attachments
- tool-call linkage
- streaming/final flags
- harness-native metadata extension bag

Content block types should cover at minimum:

- text
- reasoning-summary
- tool-call
- tool-result
- image-reference
- opaque-unknown

### `turns`

- logical turn ID
- user/assistant message linkage
- requested/started/completed timestamps
- state
- checkpoint metadata

### `activities`

- activity ID
- linked turn ID
- tone
- kind
- summary
- payload
- ordering info

### `plans`

- plan ID
- linked turn ID
- markdown content
- implementation linkage
- timestamps

### `runtime`

This must stay optional and heavily gated.

- provider session binding
- runtime payload
- resume cursor data
- adapter/runtime identifiers
- fidelity level

### `lineage`

- source IDs
- parent thread or parent session IDs
- import/export provenance
- "forked from" vs "converted from" distinction

### `capabilities`

Describe what the IR actually preserves for the current record set.

- `supportsLosslessClone`
- `supportsRuntimeRebind`
- `supportsTranscriptOnlyWrite`
- `containsOpaqueData`

## Write Intents

Do not let writers infer behavior from missing fields alone. Add explicit write intents.

Initial intent types:

- `clone-thread`
- `copy-to-workspace`
- `export-session`
- `import-session`
- `transcript-only-conversion`

Write options:

- title override
- project/workspace override
- provider/model override
- copy runtime flag
- preserve source timestamps flag
- lossy conversion allowed flag

## Proposed Module Layout

This is a suggested end state, not a required sequence.

- `src/ir.js`
  - IR schema helpers
  - normalization
  - validation
- `src/receipts.js`
  - standard result payloads
  - warning formatting
- `src/intents.js`
  - write intent definitions
  - option normalization
- `src/adapters/t3/read.js`
  - extract T3 DB rows into IR
- `src/adapters/t3/write.js`
  - write IR into T3 storage
- `src/adapters/codex/read.js`
  - Codex JSONL to IR
- `src/adapters/codex/write.js`
  - IR to Codex JSONL
- `src/adapters/claude/read.js`
  - Claude JSONL to IR
- `src/adapters/claude/write.js`
  - IR to Claude format
- `src/adapters/opencode/read.js`
  - OpenCode storage to IR
- `src/adapters/opencode/write.js`
  - IR to OpenCode storage
- `src/operations/copy-thread.js`
  - orchestrate source read, IR transform, target write
- `src/operations/convert-thread.js`
  - transcript-first cross-harness conversions
- `src/operations/list-sessions.js`
  - keep listing separate from write logic

## CLI Refactor Direction

Keep current commands working while moving internals behind the new core.

### Preserve initially

- `t3 copy`
- `t3 copy-to-workspace`
- `t3 to-codex`
- `codex to-t3`
- `codex copy`
- `claude copy`
- `opencode copy`

### Internal change

Each command should become:

1. resolve source through a harness adapter
2. emit IR
3. apply intent-specific transform
4. write through a target adapter
5. emit standard receipt

### Future CLI additions

After the refactor is stable, add explicit generic commands only if they genuinely simplify usage.

Candidates:

- `threadbridge export`
- `threadbridge import`
- `threadbridge convert`
- `threadbridge inspect`

## Phased Implementation Plan

## Phase 0: Freeze and Characterize Current Behavior

Purpose:

- avoid accidental regressions while moving logic around

Tasks:

- document all current command behaviors and defaults
- capture representative fixtures from:
  - T3 thread with activities and plans
  - Codex session with tool calls and reasoning
  - Claude session
  - OpenCode session
- add characterization tests around current copy/import/export flows
- define what is currently lossless vs lossy per harness pair

Exit criteria:

- baseline tests fail on behavior change
- sample fixture corpus exists for future adapter tests

## Phase 1: Introduce `ThreadbridgeIR`

Purpose:

- create one canonical handoff point between readers and writers

Tasks:

- add `src/ir.js` with schema constructors and validation
- formalize message content blocks
- formalize fidelity/warning reporting
- define standard receipt payload shape
- add unit tests for normalization and validation

Exit criteria:

- IR can represent the existing T3 export plus current Codex transcript mapping
- warnings and capability flags are deterministic

## Phase 2: Move Codex and T3 Through IR

Purpose:

- convert the existing strongest source/target pair first

Tasks:

- replace direct `buildT3Export` result shape with IR output
- replace Codex parsing output shape with IR output
- add T3 writer that accepts IR for:
  - `clone-thread`
  - `copy-to-workspace`
  - `import-session`
- add Codex writer that accepts IR for `export-session`
- keep CLI unchanged

Exit criteria:

- `t3 to-codex`, `codex to-t3`, and `t3 copy-to-workspace` all run through IR
- existing command outputs remain functionally compatible

## Phase 3: Isolate T3 Relational Clone Logic

Purpose:

- preserve T3 fidelity without letting T3 row semantics leak across the codebase

Tasks:

- split current `t3-copy.js` into:
  - T3 snapshot extraction
  - T3 row remapping
  - T3 write transaction
- convert the snapshot format to IR plus T3-specific extension fields
- make runtime/session copying an explicit capability-checked path
- centralize DB safety helpers:
  - backup
  - busy timeout
  - retry logic
  - transaction wrapper

Exit criteria:

- T3 clone remains lossless for supported row families
- no non-T3 module knows T3 table shapes directly

## Phase 4: Migrate Claude and OpenCode Adapters

Purpose:

- remove remaining one-off transcript object shapes

Tasks:

- convert Claude reader/writer to IR
- convert OpenCode reader/writer to IR
- normalize attachment/tool/reasoning handling as far as the source formats allow
- add fidelity warnings for unsupported native concepts

Exit criteria:

- all current harness adapters emit and consume IR
- pairwise conversion code paths no longer need bespoke intermediate shapes

## Phase 5: Standardize Operation Orchestration

Purpose:

- make high-level operations uniform and testable

Tasks:

- create explicit operation modules
- standardize receipts across all write paths
- centralize title override, workspace override, and model override transforms
- centralize target resolution semantics and ambiguity handling

Exit criteria:

- all write commands use one orchestration pattern
- command handlers mostly normalize args and call operation functions

## Phase 6: Add Interchange and Inspection Features

Purpose:

- expose the new core directly once it is stable

Tasks:

- add `threadbridge export --format threadbridge-json`
- add `threadbridge import --format threadbridge-json`
- add `threadbridge inspect` or equivalent debugging output for IR
- document schema versioning and compatibility guarantees

Exit criteria:

- IR can be serialized and round-tripped for supported fields
- debugging conversions no longer requires reading raw native stores

## Testing Strategy

### Unit tests

- IR validation and normalization
- warning generation
- ID remapping
- target resolution
- title/model/project override transforms

### Fixture-based adapter tests

- Codex fixture to IR
- Claude fixture to IR
- OpenCode fixture to IR
- T3 fixture to IR
- IR to Codex/T3/Claude/OpenCode writer outputs

### Round-trip tests

- T3 -> IR -> T3 clone
- T3 -> IR -> Codex
- Codex -> IR -> T3
- Claude -> IR -> T3
- OpenCode -> IR -> T3

### Safety tests

- runtime copy default remains off
- backup remains on where currently expected
- SQLite lock retry path still works
- lossy conversion emits warnings

## Risk Register

### Risk: Over-generalizing too early

If the IR is too abstract before enough fixtures exist, the result will be vague and unstable.

Mitigation:

- characterize current formats first
- evolve IR from actual fixtures
- allow harness-specific extension bags when needed

### Risk: Losing T3 fidelity

T3 carries more structured state than transcript-only harnesses.

Mitigation:

- treat T3 as the gold standard for structured thread state
- keep a T3-specific lossless clone path within the target adapter
- separate transcript portability from runtime fidelity

### Risk: Confusing clone vs fork semantics

Users may expect "copy" to mean native harness continuation.

Mitigation:

- keep operation names precise
- document when an operation is a storage clone vs a native resume/fork
- reserve native resume/fork integrations for optional future adapters

### Risk: Schema churn during migration

The CLI may become unstable if command handlers are migrated piecemeal without compatibility discipline.

Mitigation:

- preserve current CLI names and defaults until IR-backed paths are proven
- standardize receipts before changing command contracts

## Non-Goals For This Refactor

- implementing native `vsmux` integration
- replacing storage cloning with CLI-native fork commands
- changing user-facing command names immediately
- broadening scope into UI adapters or editor extensions

## Recommended Sequence of Work

1. Lock in characterization tests around current behavior.
2. Introduce `ThreadbridgeIR` and receipts without changing CLI behavior.
3. Move Codex and T3 conversions onto IR.
4. Extract and isolate T3 clone internals.
5. Move Claude and OpenCode onto IR.
6. Add generic import/export and inspection commands.

This sequence keeps the highest-value existing path, T3 copy fidelity, stable while the architecture is reshaped around it.

## Acceptance Criteria

The refactor should be considered complete when all of the following are true:

- every supported harness reader emits `ThreadbridgeIR`
- every supported harness writer accepts `ThreadbridgeIR`
- no pairwise conversion depends on a bespoke intermediate object shape
- T3 clone fidelity is preserved for messages, turns, activities, plans, and optional runtime rows
- command outputs use one standard receipt format
- lossy conversions are explicit and test-covered
- generic export/import through a versioned interchange format is possible

## Follow-On Work After Refactor

Once this refactor lands, likely next steps are:

- add additional harness pairs with minimal new orchestration code
- consider optional harness-native fork/resume helpers as separate commands
- expose IR inspection for debugging and migration tooling
- decide whether `threadbridge-json` should become a public compatibility contract
