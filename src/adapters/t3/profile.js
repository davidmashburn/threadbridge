const profile = require("./profile-v2.json");

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function unsupported(detail) {
  throw new Error(`Unsupported T3 v2 storage: ${detail}. Supported offline writer: T3 ${profile.release} (${profile.commit.slice(0, 7)}). No legacy fallback was written.`);
}

function inspectT3Storage(db, { write = false } = {}) {
  if (!tableExists(db, "orchestration_v2_projection_threads")) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name GLOB 'orchestration_v2_*'").get()) unsupported("incomplete v2 schema");
    if (tableExists(db, "orchestration_events") &&
        db.prepare("PRAGMA table_info(orchestration_events)").all().some((column) => column.name === "application_event_version") &&
        db.prepare("SELECT 1 FROM orchestration_events WHERE application_event_version=2 LIMIT 1").get()) unsupported("v2 events without v2 projections");
    return { kind: "v1", warnings: [] };
  }
  const warnings = [];
  const migration = tableExists(db, "effect_sql_migrations")
    ? db.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get().id : null;
  const differences = [];
  for (const [table, expected] of Object.entries(profile.tables)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name, type, notnull, pk, dflt_value }) => ({ name, type, notnull, pk, dflt_value }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push(table);
  }
  if (migration !== profile.migration || differences.length) {
    const detail = `migration ${migration ?? "unknown"}${differences.length ? `; unrecognized schema: ${differences.join(", ")}` : ""}`;
    if (write) unsupported(detail);
    warnings.push({ code: "t3_unverified_storage", message: `${detail}. Read compatibility is not verified against the supported stock release.` });
  }
  return { kind: "v2", profile: profile.release, verified: warnings.length === 0, warnings };
}

function validateV2Projection(db, { write = false } = {}) {
  if (!tableExists(db, "orchestration_v2_projection_metadata") || !tableExists(db, "orchestration_events")) {
    if (write) unsupported("missing event log or projection metadata");
    return;
  }
  const columns = db.prepare("PRAGMA table_info(orchestration_events)").all();
  if (!columns.some((column) => column.name === "application_event_version")) {
    if (write) unsupported("missing application event version");
    return;
  }
  const meta = db.prepare("SELECT * FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'").get();
  const sequence = db.prepare("SELECT coalesce(max(sequence),0) AS n FROM orchestration_events WHERE aggregate_kind='thread' AND application_event_version=2").get().n;
  const count = db.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get().n;
  const empty = sequence === 0 && count === 0;
  if (!meta || (meta.schema_version !== 2 && !(empty && meta.schema_version === 1)) || meta.last_sequence !== sequence) {
    throw new Error("T3 v2 projections are stale or unsupported. Let the matching T3 version rebuild them, then stop T3 and retry; Threadbridge will not advance an inconsistent watermark.");
  }
  const missing = db.prepare(`SELECT stream_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND event_type='thread.created'
    EXCEPT SELECT thread_id FROM orchestration_v2_projection_threads`).get();
  const unexpected = db.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads EXCEPT
    SELECT stream_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND event_type='thread.created'`).get();
  if (missing || unexpected) throw new Error("T3 v2 event log and projected threads disagree. Rebuild with the matching T3 version before using Threadbridge.");
  if (write) {
    if (tableExists(db, "orchestration_v2_effect_outbox") && db.prepare("SELECT 1 FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running') LIMIT 1").get()) {
      throw new Error("T3 has pending effects. Let T3 settle, then stop it before importing.");
    }
    const unknown = db.prepare("SELECT 1 FROM orchestration_events WHERE application_event_version NOT IN (1,2) LIMIT 1").get();
    if (unknown) unsupported("unknown application event version");
    if (tableExists(db, "orchestration_v2_projection_runs") && db.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE status IN ('preparing','queued','starting','running','waiting') LIMIT 1").get()) {
      throw new Error("T3 has unfinished runs. Finish or cancel them in T3, then stop T3 before importing.");
    }
  }
}

module.exports = { tableExists, inspectT3Storage, validateV2Projection };
