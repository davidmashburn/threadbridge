const { DatabaseSync } = require("node:sqlite");
const { createThreadbridgeIr } = require("../../ir");
const { parseMaybeJson, textFromPayloadJson } = require("./storage");

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

    const payload = parseMaybeJson(threadRow.payloadJson) || {};
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

    const warnings = [];
    if (includeRuntime) {
      warnings.push({
        code: "t3_v2_runtime_excluded",
        message: "Orchestration v2 read does not include provider runtime/session bindings.",
      });
    }

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
        attachments: [],
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
      activities: [],
      plans: [],
      runtime: null,
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
