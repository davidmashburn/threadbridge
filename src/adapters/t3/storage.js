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

function hasOrchestrationV2Projection(dbPath) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`
        SELECT 1 AS ok
        FROM sqlite_master
        WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
        LIMIT 1
      `)
      .get();
    return Boolean(row);
  } finally {
    db.close();
  }
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
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.updated_at AS updatedAt
      FROM orchestration_v2_projection_threads AS threads
      WHERE threads.deleted_at IS NULL
      ORDER BY threads.updated_at DESC, threads.thread_id DESC
    `)
    .all();
}

function listV1ThreadIndex(db) {
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.created_at AS updatedAt
      FROM projection_threads AS threads
      WHERE threads.deleted_at IS NULL
      ORDER BY threads.created_at DESC, threads.thread_id DESC
    `)
    .all();
}

function mergeThreadIndexRows(v2Rows, v1Rows) {
  const byId = new Map();
  for (const row of v1Rows) {
    byId.set(row.threadId, { ...row, source: "v1" });
  }
  for (const row of v2Rows) {
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

function listThreadIndexRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const v2 = hasOrchestrationV2Projection(dbPath) ? listV2ThreadIndex(db) : [];
    const v1 = db
      .prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_threads'
        LIMIT 1
      `)
      .get()
      ? listV1ThreadIndex(db)
      : [];
    return mergeThreadIndexRows(v2, v1);
  } finally {
    db.close();
  }
}

function hasPendingV1Transcript(dbPath, threadId) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const table = db
      .prepare(`
        SELECT 1 AS ok
        FROM sqlite_master
        WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
        LIMIT 1
      `)
      .get();
    if (!table) {
      return false;
    }
    const row = db
      .prepare(`
        SELECT 1 AS ok
        FROM orchestration_v2_legacy_imports
        WHERE thread_id = ? AND transcript_imported_at IS NULL
        LIMIT 1
      `)
      .get(threadId);
    return Boolean(row);
  } finally {
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
    `Thread not found: ${target}. Use --db-path ~/.t3/userdata/statev2.sqlite for T3 Code Alpha; t3 copy still requires v1 projection_threads rows for the source thread.`,
  );
}

module.exports = {
  hasOrchestrationV2Projection,
  resolveDefaultT3DbPath,
  parseMaybeJson,
  textFromPayloadJson,
  attachmentsFromPayloadJson,
  planMarkdownFromV2Payload,
  listThreadIndexRows,
  mergeThreadIndexRows,
  resolveThreadTargetFromIndex,
  hasPendingV1Transcript,
};
