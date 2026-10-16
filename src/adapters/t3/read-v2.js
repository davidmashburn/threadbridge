const { DatabaseSync } = require("node:sqlite");
const { createThreadbridgeIr, parseMaybeJson } = require("../../ir");
const {
  parseMaybeJson: parseStorageJson,
  textFromPayloadJson,
  attachmentsFromPayloadJson,
  planMarkdownFromV2Payload,
} = require("./storage");

function tableExists(db, name) {
  const row = db
    .prepare(`
      SELECT 1 AS ok
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `)
    .get(name);
  return Boolean(row);
}

function readV2Activities(db, threadId) {
  if (!tableExists(db, "projection_thread_activities")) {
    return [];
  }
  return db
    .prepare(`
      SELECT
        activity_id AS activityId,
        turn_id AS turnId,
        tone,
        kind,
        summary,
        payload_json AS payloadJson,
        created_at AS createdAt,
        sequence
      FROM projection_thread_activities
      WHERE thread_id = ?
      ORDER BY sequence ASC, created_at ASC, activity_id ASC
    `)
    .all(threadId)
    .map((row) => ({
      activityId: row.activityId,
      turnId: row.turnId,
      tone: row.tone,
      kind: row.kind,
      summary: row.summary,
      payload: parseMaybeJson(row.payloadJson) || {},
      createdAt: row.createdAt,
      sequence: row.sequence,
    }));
}

function readV2Plans(db, threadId) {
  if (!tableExists(db, "orchestration_v2_projection_plans")) {
    return [];
  }
  return db
    .prepare(`
      SELECT
        plan_id AS planId,
        run_id AS runId,
        kind,
        status,
        payload_json AS payloadJson
      FROM orchestration_v2_projection_plans
      WHERE thread_id = ?
      ORDER BY plan_id ASC
    `)
    .all(threadId)
    .map((row) => {
      const payload = parseStorageJson(row.payloadJson) || {};
      const updatedAt = payload.updatedAt || payload.createdAt || new Date().toISOString();
      return {
        planId: row.planId,
        turnId: row.runId || null,
        markdown: planMarkdownFromV2Payload(row.payloadJson),
        createdAt: payload.createdAt || updatedAt,
        updatedAt,
        implementedAt: payload.implementedAt || null,
        implementationThreadId: payload.implementationThreadId || null,
        metadata: {
          kind: row.kind,
          status: row.status,
        },
      };
    });
}

function readV2Runtime(db, threadId, includeRuntime) {
  if (!includeRuntime) {
    return null;
  }
  if (
    !tableExists(db, "orchestration_v2_projection_provider_session_bindings")
    || !tableExists(db, "orchestration_v2_projection_provider_sessions")
  ) {
    return null;
  }
  const binding = db
    .prepare(`
      SELECT
        bindings.provider_session_id AS providerSessionId,
        sessions.provider AS provider,
        sessions.status AS status,
        sessions.model AS model,
        sessions.updated_at AS updatedAt,
        sessions.payload_json AS payloadJson,
        sessions.driver AS driver,
        sessions.provider_instance_id AS providerInstanceId
      FROM orchestration_v2_projection_provider_session_bindings AS bindings
      INNER JOIN orchestration_v2_projection_provider_sessions AS sessions
        ON sessions.provider_session_id = bindings.provider_session_id
      WHERE bindings.thread_id = ?
      ORDER BY sessions.updated_at DESC
      LIMIT 1
    `)
    .get(threadId);
  if (!binding) {
    return null;
  }
  return {
    session: {
      threadId,
      status: binding.status,
      providerName: binding.provider,
      providerInstanceId: binding.providerInstanceId || null,
      updatedAt: binding.updatedAt,
    },
    providerRuntime: {
      threadId,
      providerName: binding.provider,
      adapterKey: binding.driver || binding.provider,
      status: binding.status,
      model: binding.model || null,
      payload: parseMaybeJson(binding.payloadJson) || {},
    },
  };
}

function readT3V2ThreadAsIr({ dbPath, threadId, includeRuntime = false }) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const threadRow = db
      .prepare(`
        SELECT
          threads.thread_id AS threadId,
          threads.title AS title,
          threads.created_at AS createdAt,
          threads.updated_at AS updatedAt,
          threads.project_id AS projectId,
          threads.runtime_mode AS runtimeMode,
          threads.interaction_mode AS interactionMode,
          threads.provider_instance_id AS providerInstanceId,
          threads.payload_json AS payloadJson,
          projects.title AS projectTitle,
          projects.workspace_root AS workspaceRoot
        FROM orchestration_v2_projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ?
          AND threads.deleted_at IS NULL
        LIMIT 1
      `)
      .get(threadId);

    if (!threadRow) {
      return null;
    }

    const payload = parseStorageJson(threadRow.payloadJson) || {};
    const messageRows = db
      .prepare(`
        SELECT
          message_id AS messageId,
          role,
          payload_json AS payloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          run_id AS runId
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ?
          AND streaming = 0
        ORDER BY created_at ASC, message_id ASC
      `)
      .all(threadId);

    const runRows = db
      .prepare(`
        SELECT
          run_id AS runId,
          ordinal,
          status,
          requested_at AS requestedAt,
          completed_at AS completedAt
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ?
        ORDER BY ordinal ASC, run_id ASC
      `)
      .all(threadId);

    const activities = readV2Activities(db, threadId);
    const plans = readV2Plans(db, threadId);
    const runtime = readV2Runtime(db, threadId, includeRuntime);
    const warnings = [];

    return createThreadbridgeIr({
      source: {
        harness: "t3",
        sourceId: threadId,
        sourcePath: dbPath,
        extractedAt: new Date().toISOString(),
        storage: "orchestration_v2",
      },
      thread: {
        threadId,
        title: threadRow.title,
        createdAt: threadRow.createdAt,
        updatedAt: threadRow.updatedAt,
        workspaceRoot: threadRow.workspaceRoot || process.cwd(),
        branch: payload.branch || null,
        worktreePath: payload.worktreePath || null,
        runtimeMode: threadRow.runtimeMode || payload.runtimeMode || "approval-required",
        interactionMode: threadRow.interactionMode || payload.interactionMode || "default",
        modelSelection: payload.modelSelection || null,
      },
      project: {
        projectId: threadRow.projectId,
        title: threadRow.projectTitle || null,
        workspaceRoot: threadRow.workspaceRoot || process.cwd(),
      },
      messages: messageRows.map((row) => ({
        messageId: row.messageId,
        role: row.role,
        text: textFromPayloadJson(row.payloadJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnId: row.runId || null,
        attachments: attachmentsFromPayloadJson(row.payloadJson),
        isStreaming: false,
      })),
      turns: runRows.map((row) => ({
        turnId: row.runId,
        pendingMessageId: null,
        assistantMessageId: null,
        requestedAt: row.requestedAt,
        startedAt: row.requestedAt,
        completedAt: row.completedAt,
        state: row.status,
        checkpoint: {
          turnCount: row.ordinal,
          ref: null,
          status: row.status,
          files: [],
        },
        metadata: {},
      })),
      activities,
      plans,
      runtime,
      lineage: {
        sourceThreadId: threadId,
      },
      capabilities: {
        supportsLosslessClone: false,
        supportsRuntimeRebind: false,
        supportsTranscriptOnlyWrite: true,
        containsOpaqueData: true,
      },
      extensions: {
        t3OrchestrationV2: {
          providerInstanceId: threadRow.providerInstanceId || payload.providerInstanceId || null,
        },
      },
      warnings,
    });
  } finally {
    db.close();
  }
}

module.exports = {
  readT3V2ThreadAsIr,
};
