const fs = require("fs");
const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        `
          SELECT 1 AS ok
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
          LIMIT 1
        `,
      )
      .get(name),
  );
}

function columnExists(db, table, name) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
}

function hasOrchestrationV2Projection(dbOrPath) {
  if (typeof dbOrPath !== "string") {
    return tableExists(dbOrPath, "orchestration_v2_projection_threads");
  }

  return withReadTransaction(dbOrPath, (db) => hasOrchestrationV2Projection(db));
}

function resolveDefaultT3DbPath({ env = "userdata" } = {}) {
  const stateDir = path.join(os.homedir(), ".t3", env);
  const v2Path = path.join(stateDir, "statev2.sqlite");
  const v1Path = path.join(stateDir, "state.sqlite");
  if (fs.existsSync(v2Path)) {
    return v2Path;
  }
  return v1Path;
}

function textFromPayloadJson(payloadJson) {
  const parsed = parseMaybeJson(payloadJson);
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  if (typeof parsed.text === "string") {
    return parsed.text;
  }
  if (parsed.input && typeof parsed.input.text === "string") {
    return parsed.input.text;
  }
  return "";
}

function attachmentsFromPayloadJson(payloadJson) {
  const parsed = parseMaybeJson(payloadJson);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.attachments)) {
    return [];
  }
  return parsed.attachments;
}

function planMarkdownFromV2Payload(payloadJson) {
  const parsed = parseMaybeJson(payloadJson);
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  if (typeof parsed.planMarkdown === "string") {
    return parsed.planMarkdown;
  }
  if (typeof parsed.markdown === "string") {
    return parsed.markdown;
  }
  if (Array.isArray(parsed.steps)) {
    return parsed.steps
      .map((step) => {
        if (!step || typeof step !== "object") return "";
        const text = typeof step.text === "string" ? step.text : "";
        return text ? `- ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function listV2ThreadIndex(db) {
  const deletedAt = columnExists(db, "orchestration_v2_projection_threads", "deleted_at")
    ? "threads.deleted_at"
    : "NULL";
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.updated_at AS updatedAt,
        ${deletedAt} AS deletedAt
      FROM orchestration_v2_projection_threads AS threads
      ORDER BY threads.updated_at DESC, threads.thread_id DESC
    `)
    .all();
}

function listV1ThreadIndex(db) {
  const deletedAt = columnExists(db, "projection_threads", "deleted_at")
    ? "threads.deleted_at"
    : "NULL";
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.created_at AS updatedAt,
        ${deletedAt} AS deletedAt
      FROM projection_threads AS threads
      ORDER BY threads.created_at DESC, threads.thread_id DESC
    `)
    .all();
}

function mergeThreadIndexRows(v2Rows, v1Rows) {
  const byId = new Map();
  const v2Ids = new Set(v2Rows.map((row) => row.threadId));
  for (const row of v1Rows) {
    if (row.deletedAt !== null && row.deletedAt !== undefined) continue;
    // A v2 shell, including a tombstone, owns the id. Do not let an old
    // projection row resurrect after the v2 thread has been deleted.
    if (v2Ids.has(row.threadId)) continue;
    byId.set(row.threadId, { ...row, source: "v1" });
  }
  for (const row of v2Rows) {
    if (row.deletedAt !== null && row.deletedAt !== undefined) continue;
    byId.set(row.threadId, { ...row, source: "v2" });
  }
  return [...byId.values()].sort((left, right) => {
    const leftTs = left.updatedAt || left.createdAt || "";
    const rightTs = right.updatedAt || right.createdAt || "";
    if (leftTs !== rightTs) {
      return rightTs.localeCompare(leftTs);
    }
    return right.threadId.localeCompare(left.threadId);
  });
}

function listThreadIndexRowsFromDb(db) {
  const v2 = hasOrchestrationV2Projection(db) ? listV2ThreadIndex(db) : [];
  const v1 = tableExists(db, "projection_threads") ? listV1ThreadIndex(db) : [];
  return mergeThreadIndexRows(v2, v1);
}

function listV2ThreadIndexRowsFromDb(db) {
  return hasOrchestrationV2Projection(db) ? listV2ThreadIndex(db) : [];
}

function listThreadIndexRows(dbPath) {
  return withReadTransaction(dbPath, (db) => listThreadIndexRowsFromDb(db));
}

function hasPendingV1TranscriptFromDb(db, threadId) {
  if (!tableExists(db, "orchestration_v2_legacy_imports")) return false;
  return Boolean(
    db
      .prepare(
        `
          SELECT 1 AS ok
          FROM orchestration_v2_legacy_imports
          WHERE thread_id = ? AND transcript_imported_at IS NULL
          LIMIT 1
        `,
      )
      .get(threadId),
  );
}

function hasPendingV1Transcript(dbOrPath, threadId) {
  if (typeof dbOrPath !== "string") {
    return hasPendingV1TranscriptFromDb(dbOrPath, threadId);
  }
  return withReadTransaction(dbOrPath, (db) => hasPendingV1TranscriptFromDb(db, threadId));
}

function withReadTransaction(dbPath, callback) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    db.exec("BEGIN");
    const result = callback(db);
    db.exec("COMMIT");
    return result;
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was committed or the callback failed before BEGIN.
    }
    db.close();
  }
}

function resolveThreadTargetFromIndex({ rows, target, sourceDbPath }) {
  if (rows.length === 0) {
    throw new Error(`No threads found in source DB: ${sourceDbPath}`);
  }

  if (!target || target === "last") {
    return rows[0].threadId;
  }

  const exact = rows.find((row) => row.threadId === target);
  if (exact) {
    return exact.threadId;
  }

  const needle = String(target).toLowerCase();
  const partial = rows.filter(
    (row) => row.threadId.includes(target) || String(row.title || "").toLowerCase().includes(needle),
  );
  if (partial.length === 1) {
    return partial[0].threadId;
  }
  if (partial.length > 1) {
    throw new Error(`Thread target is ambiguous: ${target}`);
  }
  throw new Error(
    `Thread not found: ${target}. Use --db-path ~/.t3/userdata/statev2.sqlite for T3 Code Alpha.`,
  );
}

module.exports = {
  tableExists,
  hasOrchestrationV2Projection,
  resolveDefaultT3DbPath,
  parseMaybeJson,
  textFromPayloadJson,
  attachmentsFromPayloadJson,
  planMarkdownFromV2Payload,
  listThreadIndexRows,
  listThreadIndexRowsFromDb,
  listV2ThreadIndexRowsFromDb,
  mergeThreadIndexRows,
  resolveThreadTargetFromIndex,
  hasPendingV1Transcript,
  hasPendingV1TranscriptFromDb,
  withReadTransaction,
};
