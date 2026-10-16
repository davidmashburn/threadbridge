const { inspectT3Storage, validateV2Projection } = require("./profile");
const {
  hasPendingV1TranscriptFromDb,
  listThreadIndexRowsFromDb,
  listV2ThreadIndexRowsFromDb,
  tableExists,
  withReadTransaction,
  planMarkdownFromV2Payload,
} = require("./storage");
const {
  loadV2State,
  readProjectedMessages,
  visibleV2Items,
} = require("./read-v2");

function collectWarnings(target, warnings) {
  if (Array.isArray(target) && warnings.length > 0) {
    target.push(...warnings);
  }
}

function readV2ProjectDetail(db, threadId) {
  if (!tableExists(db, "projection_projects")) {
    return {
      projectId: null,
      projectTitle: null,
      workspaceRoot: null,
      projectExists: false,
      projectDeletedAt: null,
    };
  }
  const projectDeletedAt = db
    .prepare("PRAGMA table_info(projection_projects)")
    .all()
    .some((column) => column.name === "deleted_at")
    ? "projects.deleted_at"
    : "NULL";
  return db
    .prepare(
      `SELECT
         threads.project_id AS projectId,
         projects.project_id IS NOT NULL AS projectExists,
         projects.title AS projectTitle,
         projects.workspace_root AS workspaceRoot,
         ${projectDeletedAt} AS projectDeletedAt
       FROM orchestration_v2_projection_threads AS threads
       LEFT JOIN projection_projects AS projects
         ON projects.project_id = threads.project_id
       WHERE threads.thread_id = ?
       LIMIT 1`,
    )
    .get(threadId);
}

function readV1ProjectDetail(db, threadId) {
  return db
    .prepare(
      `SELECT
         projects.title AS projectTitle,
         projects.workspace_root AS workspaceRoot
       FROM projection_threads AS threads
       LEFT JOIN projection_projects AS projects
         ON projects.project_id = threads.project_id
       WHERE threads.thread_id = ?
       LIMIT 1`,
    )
    .get(threadId);
}

/**
 * List projection index rows. Callers that need read-compatibility diagnostics may
 * pass a mutable `warnings` array; the returned rows stay CLI-compatible.
 */
function listT3Threads({ dbPath, limit, warnings: warningCollector = null }) {
  return withReadTransaction(dbPath, (db) => {
    const storage = inspectT3Storage(db, { write: false });
    collectWarnings(warningCollector, storage.warnings || []);
    if (storage.kind === "v2") {
      validateV2Projection(db, { write: false });
    }
    const rows =
      limit === undefined
        ? listThreadIndexRowsFromDb(db)
        : listThreadIndexRowsFromDb(db).slice(0, limit);
    return rows.map((row) => {
      const detail =
        row.source === "v2"
          ? readV2ProjectDetail(db, row.threadId)
          : readV1ProjectDetail(db, row.threadId);
      return {
        threadId: row.threadId,
        title: row.title,
        createdAt: row.createdAt,
        projectTitle: detail?.projectTitle || null,
        workspaceRoot: detail?.workspaceRoot || null,
      };
    });
  });
}

function searchV1Threads(db, { query, allowedThreadIds = null }) {
  if (!tableExists(db, "projection_threads")) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT
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
         )`,
    )
    .all(query, query, query, query, query, query, query);
  return allowedThreadIds
    ? rows.filter((row) => allowedThreadIds.has(row.threadId))
    : rows;
}

function v2SearchText(item) {
  if (item.type === "proposed_plan" || item.type === "todo_list") {
    return typeof item.markdown === "string"
      ? item.markdown
      : planMarkdownFromV2Payload(JSON.stringify(item));
  }
  if (item.type === "user_message" || item.type === "assistant_message") {
    if (typeof item.text === "string") return item.text;
    if (typeof item.input?.text === "string") return item.input.text;
  }
  return "";
}

function v2SearchRows(visible) {
  const foldedAnswers = new Set(
    visible.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer?.requestId
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );
  return visible.filter(({ item }) => {
    if (
      item.type !== "user_message" &&
      item.type !== "assistant_message" &&
      item.type !== "proposed_plan" &&
      item.type !== "todo_list"
    ) {
      return false;
    }
    return !(
      item.type === "user_message" && foldedAnswers.has(item.messageId)
    );
  });
}

function v2MatchForRows(rows, query) {
  const needle = String(query || "").toLocaleLowerCase();
  let match = null;
  for (const row of rows) {
    const text = v2SearchText(row.item);
    if (text.toLocaleLowerCase().includes(needle)) {
      match = {
        matchedRole:
          row.item.type === "proposed_plan" || row.item.type === "todo_list"
            ? "plan"
            : row.item.type === "user_message"
              ? "user"
              : "assistant",
        matchedText: text,
      };
    }
  }
  return match;
}

function searchV2Threads(db, { query, rows, warningCollector = null }) {
  if (!tableExists(db, "orchestration_v2_projection_threads")) {
    return [];
  }
  const results = [];
  for (const row of rows) {
    const warnings = [];
    const state = loadV2State(db, row.threadId, warnings);
    if (!state) {
      collectWarnings(warningCollector, warnings);
      continue;
    }
    if (state.thread.archived_at != null) {
      collectWarnings(warningCollector, warnings);
      continue;
    }
    const detail = readV2ProjectDetail(db, row.threadId);
    if (!detail?.projectExists || detail.projectDeletedAt != null) {
      collectWarnings(warningCollector, warnings);
      continue;
    }
    const titleMatch = String(row.title || "")
      .toLocaleLowerCase()
      .includes(String(query || "").toLocaleLowerCase());
    let bodyMatch = null;
    if (state.turnItemsTable) {
      bodyMatch = v2MatchForRows(
        v2SearchRows(visibleV2Items(db, row.threadId, warnings)),
        query,
      );
    } else {
      const messageMatch = readProjectedMessages(db, row.threadId, warnings)
        .filter((message) =>
          message.text
            .toLocaleLowerCase()
            .includes(String(query || "").toLocaleLowerCase()),
        )
        .at(-1);
      if (messageMatch) {
        bodyMatch = {
          matchedRole: messageMatch.role,
          matchedText: messageMatch.text,
        };
      }
    }
    collectWarnings(warningCollector, warnings);
    if (!titleMatch && !bodyMatch) {
      continue;
    }
    results.push({
      threadId: row.threadId,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      projectTitle: detail?.projectTitle || null,
      workspaceRoot: detail?.workspaceRoot || null,
      matchedRole: titleMatch ? null : bodyMatch.matchedRole,
      matchedText: titleMatch ? null : bodyMatch.matchedText,
      titleRank: titleMatch ? 0 : 1,
    });
  }
  return results;
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
    .slice(0, limit === undefined ? undefined : limit)
    .map(({ titleRank, storage, ...row }) => row);
}

/**
 * Search visible v1/v2 history. Warning collection is opt-in so existing
 * callers still receive an array of rows; collected entries cover storage
 * verification, pending legacy fallback, and v2 visibility traversal.
 */
function searchT3Threads({ dbPath, limit, query, warnings: warningCollector = null }) {
  return withReadTransaction(dbPath, (db) => {
    const storage = inspectT3Storage(db, { write: false });
    collectWarnings(warningCollector, storage.warnings || []);
    if (storage.kind === "v2") {
      validateV2Projection(db, { write: false });
    }

    const indexRows = listThreadIndexRowsFromDb(db);
    const allV2Rows = listV2ThreadIndexRowsFromDb(db);
    const activeV2Rows = allV2Rows.filter(
      (row) => row.deletedAt === null || row.deletedAt === undefined,
    );
    const pendingV2Ids = new Set(
      activeV2Rows
        .filter((row) => hasPendingV1TranscriptFromDb(db, row.threadId))
        .map((row) => row.threadId),
    );
    for (const threadId of pendingV2Ids) {
      collectWarnings(warningCollector, [
        {
          code: "t3_legacy_transcript_pending",
          message:
            "The v2 thread is still importing its transcript; the legacy projection was used for query results.",
          threadId,
        },
      ]);
    }
    const allowedV1Ids = new Set(
      indexRows
        .filter(
          (row) => row.source === "v1" || pendingV2Ids.has(row.threadId),
        )
        .map((row) => row.threadId),
    );
    const v1Rows = searchV1Threads(db, {
      query,
      allowedThreadIds: allowedV1Ids,
    });
    const v2Rows = searchV2Threads(db, {
      query,
      rows: activeV2Rows.filter((row) => !pendingV2Ids.has(row.threadId)),
      warningCollector,
    });
    return mergeSearchResults(v1Rows, v2Rows, limit);
  });
}

module.exports = {
  listT3Threads,
  searchT3Threads,
};
