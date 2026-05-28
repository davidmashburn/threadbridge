const { DatabaseSync } = require("node:sqlite");
const { createThreadbridgeIr, parseMaybeJson } = require("../../ir");
const { ensureDbExists, resolveThreadTarget, buildSnapshot } = require("../../t3-copy");

function readT3ThreadAsIr({ dbPath, target, includeRuntime = false }) {
  const resolvedDbPath = ensureDbExists(dbPath);
  const threadId = resolveThreadTarget({ sourceDbPath: resolvedDbPath, target });
  const snapshot = buildSnapshot({ sourceDbPath: resolvedDbPath, sourceThreadId: threadId });

  const db = new DatabaseSync(resolvedDbPath, { readonly: true });
  try {
    const threadRow = db
      .prepare(`
        SELECT
          threads.thread_id AS threadId,
          threads.title AS title,
          threads.created_at AS createdAt,
          threads.updated_at AS updatedAt,
          threads.project_id AS projectId,
          threads.branch AS branch,
          threads.worktree_path AS worktreePath,
          threads.runtime_mode AS runtimeMode,
          threads.interaction_mode AS interactionMode,
          threads.model_selection_json AS modelSelectionJson,
          projects.title AS projectTitle,
          projects.workspace_root AS workspaceRoot
        FROM projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ?
          AND threads.deleted_at IS NULL
        LIMIT 1
      `)
      .get(threadId);

    return createThreadbridgeIr({
      source: {
        harness: "t3",
        sourceId: threadId,
        sourcePath: resolvedDbPath,
        extractedAt: new Date().toISOString(),
      },
      thread: {
        threadId,
        title: threadRow.title,
        createdAt: threadRow.createdAt,
        updatedAt: threadRow.updatedAt,
        workspaceRoot: threadRow.workspaceRoot || process.cwd(),
        branch: threadRow.branch || null,
        worktreePath: threadRow.worktreePath || null,
        runtimeMode: threadRow.runtimeMode || "approval-required",
        interactionMode: threadRow.interactionMode || "default",
        modelSelection: parseMaybeJson(threadRow.modelSelectionJson),
      },
      project: {
        projectId: threadRow.projectId,
        title: threadRow.projectTitle || null,
        workspaceRoot: threadRow.workspaceRoot || process.cwd(),
      },
      messages: snapshot.messages.map((row) => ({
        messageId: row.message_id,
        role: row.role,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        turnId: row.turn_id,
        attachments: parseMaybeJson(row.attachments_json) || [],
        isStreaming: Boolean(row.is_streaming),
      })),
      turns: snapshot.turns.map((row) => ({
        turnId: row.turn_id,
        pendingMessageId: row.pending_message_id,
        assistantMessageId: row.assistant_message_id,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        state: row.state,
        checkpoint: {
          turnCount: row.checkpoint_turn_count,
          ref: row.checkpoint_ref,
          status: row.checkpoint_status,
          files: parseMaybeJson(row.checkpoint_files_json) || [],
        },
        metadata: {
          sourceProposedPlanThreadId: row.source_proposed_plan_thread_id,
          sourceProposedPlanId: row.source_proposed_plan_id,
        },
      })),
      activities: snapshot.activities.map((row) => ({
        activityId: row.activity_id,
        turnId: row.turn_id,
        tone: row.tone,
        kind: row.kind,
        summary: row.summary,
        payload: parseMaybeJson(row.payload_json) || {},
        createdAt: row.created_at,
        sequence: row.sequence,
      })),
      plans: snapshot.proposedPlans.map((row) => ({
        planId: row.plan_id,
        turnId: row.turn_id,
        markdown: row.plan_markdown,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        implementedAt: row.implemented_at,
        implementationThreadId: row.implementation_thread_id,
      })),
      runtime: includeRuntime
        ? {
            session: snapshot.session,
            providerRuntime: snapshot.runtime,
          }
        : null,
      lineage: {
        sourceThreadId: threadId,
      },
      capabilities: {
        supportsLosslessClone: true,
        supportsRuntimeRebind: includeRuntime && Boolean(snapshot.runtime || snapshot.session),
        supportsTranscriptOnlyWrite: true,
        containsOpaqueData: false,
      },
      extensions: {
        t3Snapshot: snapshot,
      },
    });
  } finally {
    db.close();
  }
}

module.exports = {
  readT3ThreadAsIr,
};
