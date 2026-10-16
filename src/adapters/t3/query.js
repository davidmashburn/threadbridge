const { DatabaseSync } = require("node:sqlite");
const { hasOrchestrationV2Projection, listThreadIndexRows, textFromPayloadJson } = require("./storage");

function listT3Threads({ dbPath, limit }) {
  const indexRows = listThreadIndexRows(dbPath).slice(0, limit);
  const db = new DatabaseSync(dbPath, { readonly: true });
  const useV2 = hasOrchestrationV2Projection(dbPath);
  try {
    return indexRows.map((row) => {
      if (row.source === "v2" && useV2) {
        const detail = db
          .prepare(`
            SELECT
              threads.project_id AS projectId,
              projects.title AS projectTitle,
              projects.workspace_root AS workspaceRoot
            FROM orchestration_v2_projection_threads AS threads
            LEFT JOIN projection_projects AS projects
              ON projects.project_id = threads.project_id
            WHERE threads.thread_id = ?
            LIMIT 1
          `)
          .get(row.threadId);
        return {
          threadId: row.threadId,
          title: row.title,
          createdAt: row.createdAt,
          projectTitle: detail?.projectTitle || null,
          workspaceRoot: detail?.workspaceRoot || null,
        };
      }

      const detail = db
        .prepare(`
          SELECT
            projects.title AS projectTitle,
            projects.workspace_root AS workspaceRoot
          FROM projection_threads AS threads
          LEFT JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.thread_id = ?
          LIMIT 1
        `)
        .get(row.threadId);
      return {
        threadId: row.threadId,
        title: row.title,
        createdAt: row.createdAt,
        projectTitle: detail?.projectTitle || null,
        workspaceRoot: detail?.workspaceRoot || null,
      };
    });
  } finally {
    db.close();
  }
}

function searchV1Threads(db, { query, limit }) {
  const hasV1 = db
    .prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type = 'table' AND name = 'projection_threads'
      LIMIT 1
    `)
    .get();
  if (!hasV1) {
    return [];
  }
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.updated_at AS updatedAt,
        projects.title AS projectTitle,
        projects.workspace_root AS workspaceRoot,
        CASE
          WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
          ELSE (
            SELECT messages.role
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND INSTR(LOWER(messages.text), LOWER(?)) > 0
            ORDER BY messages.created_at DESC, messages.message_id DESC
            LIMIT 1
          )
        END AS matchedRole,
        CASE
          WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
          ELSE (
            SELECT messages.text
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND INSTR(LOWER(messages.text), LOWER(?)) > 0
            ORDER BY messages.created_at DESC, messages.message_id DESC
            LIMIT 1
          )
        END AS matchedText,
        CASE WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN 0 ELSE 1 END AS titleRank
      FROM projection_threads AS threads
      LEFT JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND (
          INSTR(LOWER(threads.title), LOWER(?)) > 0
          OR EXISTS (
            SELECT 1
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND INSTR(LOWER(messages.text), LOWER(?)) > 0
          )
        )
    `)
    .all(query, query, query, query, query, query, query);
}

function searchV2Threads(db, { query, limit }) {
  if (!hasOrchestrationV2ProjectionFromDb(db)) {
    return [];
  }
  return db
    .prepare(`
      SELECT
        threads.thread_id AS threadId,
        threads.title AS title,
        threads.created_at AS createdAt,
        threads.updated_at AS updatedAt,
        projects.title AS projectTitle,
        projects.workspace_root AS workspaceRoot,
        CASE
          WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
          ELSE (
            SELECT messages.role
            FROM orchestration_v2_projection_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND messages.streaming = 0
              AND INSTR(LOWER(json_extract(messages.payload_json, '$.text')), LOWER(?)) > 0
            ORDER BY messages.created_at DESC, messages.message_id DESC
            LIMIT 1
          )
        END AS matchedRole,
        CASE
          WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
          ELSE (
            SELECT messages.payload_json
            FROM orchestration_v2_projection_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND messages.streaming = 0
              AND INSTR(LOWER(json_extract(messages.payload_json, '$.text')), LOWER(?)) > 0
            ORDER BY messages.created_at DESC, messages.message_id DESC
            LIMIT 1
          )
        END AS matchedPayloadJson,
        CASE WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN 0 ELSE 1 END AS titleRank
      FROM orchestration_v2_projection_threads AS threads
      LEFT JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND (
          INSTR(LOWER(threads.title), LOWER(?)) > 0
          OR EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND messages.streaming = 0
              AND INSTR(LOWER(json_extract(messages.payload_json, '$.text')), LOWER(?)) > 0
          )
        )
    `)
    .all(query, query, query, query, query, query, query)
    .map((row) => ({
      ...row,
      matchedText: row.matchedPayloadJson ? textFromPayloadJson(row.matchedPayloadJson) : null,
      matchedPayloadJson: undefined,
    }));
}

function hasOrchestrationV2ProjectionFromDb(db) {
  const row = db
    .prepare(`
      SELECT 1 AS ok
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
      LIMIT 1
    `)
    .get();
  return Boolean(row);
}

function mergeSearchResults(v1Rows, v2Rows, limit) {
  const byId = new Map();
  for (const row of v1Rows) {
    byId.set(row.threadId, { ...row, storage: "v1" });
  }
  for (const row of v2Rows) {
    byId.set(row.threadId, { ...row, storage: "v2" });
  }
  return [...byId.values()]
    .sort((left, right) => {
      if (left.titleRank !== right.titleRank) {
        return left.titleRank - right.titleRank;
      }
      const leftTs = left.updatedAt || left.createdAt || "";
      const rightTs = right.updatedAt || right.createdAt || "";
      if (leftTs !== rightTs) {
        return rightTs.localeCompare(leftTs);
      }
      return right.threadId.localeCompare(left.threadId);
    })
    .slice(0, limit)
    .map(({ titleRank, storage, ...row }) => row);
}

function searchT3Threads({ dbPath, limit, query }) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const v1Rows = searchV1Threads(db, { query, limit });
    const v2Rows = searchV2Threads(db, { query, limit });
    return mergeSearchResults(v1Rows, v2Rows, limit);
  } finally {
    db.close();
  }
}

module.exports = {
  listT3Threads,
  searchT3Threads,
};
