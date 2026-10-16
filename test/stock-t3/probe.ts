import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { resolveAttachmentPath, resolveAttachmentPathById } from './src/attachmentStore.ts';
import { inspect } from 'node:util';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlClient from 'effect/sql/SqlClient';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { OrchestrationV2ThreadProjection, ThreadId, ApplicationProjectEvent } from '@t3tools/contracts';
import * as Sqlite from './src/persistence/Sqlite.ts';
import * as EventStore from './src/orchestration-v2/EventStore.ts';
import * as ProjectionStore from './src/orchestration-v2/ProjectionStore.ts';
import * as Maintenance from './src/orchestration-v2/ProjectionMaintenance.ts';
import * as Legacy from './src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts';
import * as EventSink from './src/orchestration-v2/EventSink.ts';
const [mode, dbPath, output] = process.argv.slice(2);
if (!process.env.TB_STOCK_TEST_DIR || !dbPath?.startsWith(process.env.TB_STOCK_TEST_DIR + '/')) throw Error('Disposable DB only');
const database = Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(Layer.provideMerge(database));
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const services = Layer.mergeAll(Maintenance.layer, Legacy.layer).pipe(Layer.provideMerge(sink));
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
  if (mode === 'init') {
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at) VALUES ('project:fixture','Fixture','/tmp/tb-t3-feasibility/project',NULL,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`;
  }
  if (mode === 'migrate') {
    const legacy = yield* Legacy.LegacyV1ThreadImporter;
    yield* legacy.reconcileShells;
    const threads = yield* sql`SELECT thread_id FROM orchestration_v2_legacy_imports`;
    for (const row of threads) yield* legacy.ensureTranscript(ThreadId.make(row.thread_id as string));
  }
  if (mode === 'rebuild') yield* maintenance.rebuild;
  const report: any = { verify: yield* maintenance.verify, schema: yield* sql`SELECT * FROM effect_sql_migrations`, threads: [], projectEvents: 0, attachments: [] };
  for (const row of yield* sql`SELECT * FROM orchestration_events WHERE aggregate_kind='project'`) {
    Schema.decodeUnknownSync(ApplicationProjectEvent)({ sequence: row.sequence, eventId: row.event_id, aggregateKind: row.aggregate_kind, aggregateId: row.stream_id, type: row.event_type, occurredAt: row.occurred_at, commandId: row.command_id, causationEventId: row.causation_event_id, correlationId: row.correlation_id, metadata: JSON.parse(row.metadata_json as string), payload: JSON.parse(row.payload_json as string) });
    report.projectEvents++;
  }
  const rows = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
  for (const row of rows) {
    const id = ThreadId.make(row.thread_id as string);
    const projection = yield* projections.getThreadProjection(id);
    for (const message of projection.messages) for (const attachment of message.attachments) {
      const attachmentsDir = join(dirname(dbPath), 'attachments');
      const resolved = resolveAttachmentPath({ attachmentsDir, attachment });
      assert.ok(resolved);
      assert.equal(resolveAttachmentPathById({ attachmentsDir, attachmentId: attachment.id }), resolved);
      report.attachments.push({ id: attachment.id, contents: readFileSync(resolved).toString('base64') });
    }
    report.threads.push({ id, projection: Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadProjection))(projection), nextOrdinal: yield* projections.getNextTurnItemOrdinal(id) });
  }
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({mode, verify: report.verify, threads: report.threads.map((t: any) => ({id:t.id,messages:t.projection.messages.map((m:any)=>m.text),visible:t.projection.visibleTurnItems.length,nextOrdinal:t.nextOrdinal}))}));
});
try { await Effect.runPromise(program.pipe(Effect.provide(services))); }
catch (error) { console.error(inspect(error,{depth:12})); process.exitCode=1; }
