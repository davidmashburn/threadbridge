const { DatabaseSync } = require("node:sqlite");
const { createThreadbridgeIr, parseMaybeJson } = require("../../ir");
const { ensureDbExists } = require("../../t3-copy");
const { inspectT3Storage, validateV2Projection } = require("./profile");
const {
  hasOrchestrationV2Projection,
  hasPendingV1TranscriptFromDb,
  listThreadIndexRowsFromDb,
  resolveThreadTargetFromIndex,
} = require("./storage");
const { readT3V2ThreadAsIrFromDb } = require("./read-v2");

function readV1SnapshotFromDb(db, sourceThreadId) {
  const thread = db
    .prepare(
      "SELECT * FROM projection_threads WHERE thread_id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .get(sourceThreadId);
  if (!thread) {
    throw new Error(`Source thread not found: ${sourceThreadId}`);
  }

  const project = db
    .prepare("SELECT * FROM projection_projects WHERE project_id = ? LIMIT 1")
    .get(thread.project_id);
  if (!project) {
    throw new Error(
      `Source project missing for thread ${sourceThreadId}: ${thread.project_id}`,
    );
  }

  return {
    thread,
    project,
    messages: db
      .prepare(
        "SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC",
      )
      .all(sourceThreadId),
    turns: db
      .prepare(
        "SELECT * FROM projection_turns WHERE thread_id = ? ORDER BY row_id ASC",
      )
      .all(sourceThreadId),
    activities: db
      .prepare(
        `SELECT * FROM projection_thread_activities
         WHERE thread_id = ?
         ORDER BY
           CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
           sequence ASC,
           created_at ASC,
           activity_id ASC`,
      )
      .all(sourceThreadId),
    proposedPlans: db
      .prepare(
        "SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ? ORDER BY created_at ASC, plan_id ASC",
      )
      .all(sourceThreadId),
    session:
      db
        .prepare(
          "SELECT * FROM projection_thread_sessions WHERE thread_id = ? LIMIT 1",
        )
        .get(sourceThreadId) || null,
    runtime:
      db
        .prepare(
          "SELECT * FROM provider_session_runtime WHERE thread_id = ? LIMIT 1",
        )
        .get(sourceThreadId) || null,
  };
}

function v1IrFromSnapshot({ snapshot, dbPath, threadId, includeRuntime, warnings }) {
  const thread = snapshot.thread;
  const project = snapshot.project;
  return createThreadbridgeIr({
    source: {
      harness: "t3",
      sourceId: threadId,
      sourcePath: dbPath,
      extractedAt: new Date().toISOString(),
    },
    thread: {
      threadId,
      title: thread.title,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      workspaceRoot: project.workspace_root || process.cwd(),
      branch: thread.branch || null,
      worktreePath: thread.worktree_path || null,
      runtimeMode: thread.runtime_mode || "approval-required",
      interactionMode: thread.interaction_mode || "default",
      modelSelection: parseMaybeJson(thread.model_selection_json),
    },
    project: {
      projectId: thread.project_id,
      title: project.title || null,
      workspaceRoot: project.workspace_root || process.cwd(),
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
    lineage: { sourceThreadId: threadId },
    capabilities: {
      supportsLosslessClone: true,
      supportsRuntimeRebind:
        includeRuntime && Boolean(snapshot.runtime || snapshot.session),
      supportsTranscriptOnlyWrite: true,
      containsOpaqueData: false,
    },
    extensions: { t3Snapshot: snapshot },
    warnings,
  });
}

function readT3ThreadAsIr({ dbPath, target, includeRuntime = false }) {
  const resolvedDbPath = ensureDbExists(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { readonly: true });
  try {
    db.exec("BEGIN");

    const storage = inspectT3Storage(db, { write: false });
    if (storage.kind === "v2") {
      validateV2Projection(db, { write: false });
    }
    const rows = listThreadIndexRowsFromDb(db);
    const threadId = resolveThreadTargetFromIndex({
      rows,
      target,
      sourceDbPath: resolvedDbPath,
    });
    const warnings = [...(storage.warnings || [])];
    const preferV1Snapshot = hasPendingV1TranscriptFromDb(db, threadId);

    if (!preferV1Snapshot && hasOrchestrationV2Projection(db)) {
      const v2Ir = readT3V2ThreadAsIrFromDb({
        db,
        dbPath: resolvedDbPath,
        threadId,
        includeRuntime,
        warnings,
      });
      if (v2Ir) {
        db.exec("COMMIT");
        return v2Ir;
      }
    }

    if (preferV1Snapshot) {
      warnings.push({
        code: "t3_legacy_transcript_pending",
        message:
          "The v2 thread is still importing its transcript; the legacy projection was used.",
        threadId,
      });
    }
    const snapshot = readV1SnapshotFromDb(db, threadId);
    const ir = v1IrFromSnapshot({
      snapshot,
      dbPath: resolvedDbPath,
      threadId,
      includeRuntime,
      warnings,
    });
    db.exec("COMMIT");
    return ir;
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was committed or the callback failed before BEGIN.
    }
    db.close();
  }
}

module.exports = {
  readT3ThreadAsIr,
  readV1SnapshotFromDb,
};
