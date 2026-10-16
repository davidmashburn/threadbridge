# T3 storage compatibility

Threadbridge can read and write local T3 databases without a running T3 server or changes to T3. In-app MCP reads remain preferable for live thread inspection.

## Supported native writer

The native v2 writer is tested against stock T3 **v0.1.0**, commit `81493efb71e8e8244f95d3e9f71d8369654ab151`, migration 62. `src/adapters/t3/profile-v2.json` records the storage columns it relies on. A matching schema does not establish that a fork has identical runtime behavior; stock source is the compatibility reference. Future schema versions require a verified profile update.

Stop T3 before running a copy or import. The writer uses `lsof` to reject other processes holding the database, checks for unfinished runs and pending effects, then validates the schema and projection watermark again under `BEGIN IMMEDIATE`. Keep T3 stopped until completion: a process check cannot prevent another process starting afterward. Offline writes currently require macOS/Linux with `lsof`; read-only operations do not.

A SQLite backup is enabled by default. Native imports append a project event when creating a project, then append thread, message, plan and turn-item events together with the matching projections and ordinal positions. The projection watermark advances in the same transaction. Existing project IDs must resolve to an undeleted project. Unknown schemas and inconsistent projections fail without writing legacy rows. Open the database with its matching T3 version to rebuild stale projections, then stop T3 and retry.

## Portable history

Messages retain visible order even when timestamps tie. Fork ancestors are materialized through the fork cutoff. Each import gets fresh thread, message, plan, turn-item and attachment IDs; `--new-thread-id` can explicitly select the thread ID. Source provenance appears in the receipt and the thread-created event's `threadbridge` metadata. Foreign provider identities, executable state and lineage pointers are not rebound.

The import has no execution runs or provider session. Stock T3 requires `historyOrigin: "v1_import"` to deliver runless imported messages to the next fresh provider session. This marker describes T3's continuation mechanism; the import itself uses native v2 events and does not create v1 transcript rows.

- Available supported attachment files are copied with canonical metadata and fresh names. Missing or unsupported attachments produce warnings; source files remain untouched. Optional capture metadata is omitted with a warning. Stock T3's continuation handoff sends historical text; it does not automatically replay those attachment bytes to the next provider.
- Plans preserve their text as completed historical plans. Non-text message blocks and rich tool/activity items preserve their data in labelled assistant text instead of active tool/approval objects. Fork markers are represented by the materialized history and source provenance.
- System/developer messages become labelled historical user messages. Partial streaming messages become completed snapshots, with warnings.
- Runtime bindings, approvals, command receipts, effects, checkpoints and execution runs are excluded. `--copy-runtime` fails on v2 targets.
- Existing source-adapter omissions remain visible in the IR/receipt warnings. This is a portable history copy, not a lossless clone of provider execution.

Attachments are staged before publication, published without overwriting existing files, and removed on an ordinary transaction failure. A process/OS crash between file publication and SQLite commit can leave unreferenced attachment files. SQLite history remains atomic; the database backup does not include the attachment directory.

## Reads and legacy compatibility

Read operations use SQLite snapshots. Canonical v2 visibility includes inherited history and omits rolled-back runs, cancelled queued messages and superseded interruption artifacts. Unknown read schemas report compatibility warnings where the stored layout remains readable. Malformed ancestry or payloads carry warnings rather than silently claiming complete fidelity.

Legacy-only targets keep the existing v1 writer. Pending legacy transcripts remain readable until T3 finishes migration. Native v2 writes never silently fall back to that writer.

## Verification

Run `npm run check && npm test` for CLI, reader, writer and filesystem tests using disposable databases. Run the optional [stock acceptance suite](../test/stock-t3/README.md) for real T3 schema decoding, full projection equality after rebuild, and a simulated provider turn through the stock orchestrator. The negative control removes the history marker and verifies that the imported messages are then absent from provider input.

These checks do not establish desktop UI behavior or real remote provider behavior, and do not certify future T3 versions. No production database is used by the suite.
