const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createOperationReceipt } = require("../../receipts");
const { extractPlainTextFromBlocks, getTranscriptEntriesFromIr, validateIr } = require("../../ir");
const { normalizeWriteIntent } = require("../../intents");
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  backupSqlite,
  ensureDbExists,
  insertSnapshot,
  remapSnapshotIds,
  withLockRetries,
} = require("../../t3-copy");

function createModelSelectionFromIr(ir, intent) {
  if (intent.modelSelection) {
    return intent.modelSelection;
  }
  if (intent.provider || intent.model) {
    return JSON.stringify({
      provider: intent.provider || ir.thread.modelSelection?.provider || ir.source.harness,
      model: intent.model || ir.thread.modelSelection?.model || "gpt-5.4",
    });
  }
  return ir.thread.modelSelection ? JSON.stringify(ir.thread.modelSelection) : null;
}

function importIrTranscriptIntoT3({
  ir,
  dbPath,
  intent,
  backup = true,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  lockRetries = DEFAULT_LOCK_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  validateIr(ir);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`T3 database not found: ${dbPath}`);
  }

  const transcript = getTranscriptEntriesFromIr(ir).map((entry, index) => ({
    ...entry,
    timestamp: entry.timestamp || new Date(Date.now() + index * 1000).toISOString(),
  }));

  const normalizedMessages = [];
  const turns = [];
  let currentTurn = null;

  for (const entry of transcript) {
    const text = entry.text || "";
    if (!text.trim()) continue;
    if (entry.role === "user") {
      const messageId = crypto.randomUUID();
      currentTurn = {
        turnId: crypto.randomUUID(),
        pendingMessageId: messageId,
        assistantMessageId: null,
        requestedAt: entry.timestamp,
        startedAt: null,
        completedAt: entry.timestamp,
        state: "completed",
      };
      normalizedMessages.push({
        messageId,
        role: "user",
        text,
        turnId: null,
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        isStreaming: false,
      });
      turns.push(currentTurn);
      continue;
    }

    const messageId = `assistant:msg_${crypto.randomBytes(18).toString("hex")}`;
    if (!currentTurn) {
      currentTurn = {
        turnId: crypto.randomUUID(),
        pendingMessageId: null,
        assistantMessageId: null,
        requestedAt: entry.timestamp,
        startedAt: entry.timestamp,
        completedAt: entry.timestamp,
        state: "completed",
      };
      turns.push(currentTurn);
    }
    if (!currentTurn.startedAt) currentTurn.startedAt = entry.timestamp;
    currentTurn.assistantMessageId = messageId;
    currentTurn.completedAt = entry.timestamp;
    normalizedMessages.push({
      messageId,
      role: "assistant",
      text,
      turnId: currentTurn.turnId,
      createdAt: entry.timestamp,
      updatedAt: entry.timestamp,
      isStreaming: false,
    });
  }

  const now = new Date().toISOString();
  const latestTurnId = turns.length ? turns[turns.length - 1].turnId : null;
  const latestUserMessageAt =
    [...normalizedMessages].reverse().find((message) => message.role === "user")?.createdAt || null;
  const threadCreatedAt = intent.preserveTimestamps !== false
    ? (ir.thread.createdAt || normalizedMessages[0]?.createdAt || now)
    : (normalizedMessages[0]?.createdAt || now);
  const threadUpdatedAt = intent.preserveTimestamps !== false
    ? (ir.thread.updatedAt || normalizedMessages[normalizedMessages.length - 1]?.updatedAt || now)
    : (normalizedMessages[normalizedMessages.length - 1]?.updatedAt || now);

  const resolvedWorkspaceRoot = path.resolve(intent.workspaceRoot || ir.thread.workspaceRoot || process.cwd());
  const modelSelectionJson = createModelSelectionFromIr(ir, intent);
  const parsedModelSelection = modelSelectionJson ? JSON.parse(modelSelectionJson) : null;
  const threadTitle = intent.title || ir.thread.title;
  const runtimeMode = ir.thread.runtimeMode || "approval-required";
  const interactionMode = ir.thread.interactionMode || "default";
  const projectTitle = ir.project.title || path.basename(resolvedWorkspaceRoot) || resolvedWorkspaceRoot;
  const threadId = crypto.randomUUID();
  const activityId = crypto.randomUUID();

  const retryConfig = { retries: lockRetries, retryDelayMs };
  const backupPath = backup
    ? withLockRetries(() => backupSqlite(dbPath, busyTimeoutMs), retryConfig)
    : null;

  withLockRetries(() => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.exec("BEGIN IMMEDIATE");

      let resolvedProjectId = intent.projectId;
      if (!resolvedProjectId) {
        const existing = db
          .prepare(`
            SELECT project_id AS projectId
            FROM projection_projects
            WHERE workspace_root = ?
              AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
          `)
          .get(resolvedWorkspaceRoot);
        resolvedProjectId = existing ? existing.projectId : crypto.randomUUID();
      }

      db.prepare(`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(project_id) DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_model_selection_json = COALESCE(excluded.default_model_selection_json, projection_projects.default_model_selection_json),
          updated_at = excluded.updated_at
      `).run(
        resolvedProjectId,
        projectTitle,
        resolvedWorkspaceRoot,
        modelSelectionJson,
        "[]",
        threadCreatedAt,
        now,
      );

      db.prepare(`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path,
          latest_turn_id, created_at, updated_at, latest_user_message_at, archived_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)
      `).run(
        threadId,
        resolvedProjectId,
        threadTitle,
        modelSelectionJson,
        runtimeMode,
        interactionMode,
        latestTurnId,
        threadCreatedAt,
        threadUpdatedAt,
        latestUserMessageAt,
      );

      const insertMessage = db.prepare(`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of normalizedMessages) {
        insertMessage.run(
          message.messageId,
          threadId,
          message.turnId,
          message.role,
          message.text,
          "[]",
          message.isStreaming ? 1 : 0,
          message.createdAt,
          message.updatedAt,
        );
      }

      const insertTurn = db.prepare(`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id, assistant_message_id,
          state, requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `);
      for (const turn of turns) {
        insertTurn.run(
          threadId,
          turn.turnId,
          turn.pendingMessageId,
          turn.assistantMessageId,
          turn.state,
          turn.requestedAt,
          turn.startedAt,
          turn.completedAt,
          "[]",
        );
      }

      db.prepare(`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (?, ?, NULL, 'info', ?, ?, ?, 1, ?)
      `).run(
        activityId,
        threadId,
        `import.${ir.source.harness}.session`,
        `Imported ${ir.source.harness} session ${ir.source.sourceId || ""}`.trim(),
        JSON.stringify({
          source: "threadbridge",
          sourceHarness: ir.source.harness,
          sourceId: ir.source.sourceId,
          sourcePath: ir.source.sourcePath,
          importedAt: now,
          transcriptMessageCount: normalizedMessages.length,
          turnCount: turns.length,
        }),
        now,
      );

      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      db.close();
    }
  }, retryConfig);

  return createOperationReceipt({
    operation: intent.type,
    source: {
      harness: ir.source.harness,
      id: ir.source.sourceId,
      path: ir.source.sourcePath,
    },
    target: {
      harness: "t3",
      path: dbPath,
      projectId: intent.projectId || null,
    },
    createdIds: {
      threadId,
    },
    counts: {
      messages: normalizedMessages.length,
      turns: turns.length,
    },
    backupPath,
    warnings: ir.warnings,
    details: {
      threadTitle,
      modelSelection: parsedModelSelection,
      dbPath,
    },
  });
}

function cloneIrThreadIntoT3({
  ir,
  dbPath,
  intent,
  newThreadId = null,
  backup = true,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  lockRetries = DEFAULT_LOCK_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  validateIr(ir);
  if (!ir.extensions?.t3Snapshot) {
    return importIrTranscriptIntoT3({
      ir,
      dbPath,
      intent,
      backup,
      busyTimeoutMs,
      lockRetries,
      retryDelayMs,
    });
  }

  const resolvedDbPath = ensureDbExists(dbPath);
  const actualNewThreadId = newThreadId || crypto.randomUUID();
  const snapshot = ir.extensions.t3Snapshot;
  const remapped = remapSnapshotIds(snapshot, actualNewThreadId);

  if (intent.projectId) {
    remapped.thread.project_id = intent.projectId;
  }
  if (intent.title) {
    remapped.thread.title = intent.title;
  }

  const nextModelSelection = createModelSelectionFromIr(ir, intent);
  if (nextModelSelection) {
    remapped.thread.model_selection_json = nextModelSelection;
  }

  const retryConfig = { retries: lockRetries, retryDelayMs };
  const backupPath = backup
    ? withLockRetries(() => backupSqlite(resolvedDbPath, busyTimeoutMs), retryConfig)
    : null;

  withLockRetries(() => insertSnapshot({
    targetDbPath: resolvedDbPath,
    snapshot: remapped,
    copyRuntime: intent.copyRuntime,
    titleOverride: remapped.thread.title,
    busyTimeoutMs,
    newProjectId: intent.projectId,
    newModelSelection: remapped.thread.model_selection_json,
  }), retryConfig);

  return createOperationReceipt({
    operation: intent.type,
    source: {
      harness: "t3",
      id: ir.source.sourceId,
      path: ir.source.sourcePath,
    },
    target: {
      harness: "t3",
      path: resolvedDbPath,
      projectId: remapped.thread.project_id,
    },
    createdIds: {
      threadId: actualNewThreadId,
    },
    counts: {
      messages: remapped.messages.length,
      turns: remapped.turns.length,
      activities: remapped.activities.length,
      proposedPlans: remapped.proposedPlans.length,
    },
    backupPath,
    warnings: ir.warnings,
    details: {
      threadTitle: remapped.thread.title,
    },
  });
}

function writeIrToT3(args) {
  const intent = normalizeWriteIntent(args.intent, args.options);
  if (intent.type === "clone-thread" || intent.type === "copy-to-workspace") {
    return cloneIrThreadIntoT3({
      ir: args.ir,
      dbPath: args.dbPath,
      intent,
      newThreadId: args.newThreadId || null,
      backup: args.backup,
      busyTimeoutMs: args.busyTimeoutMs,
      lockRetries: args.lockRetries,
      retryDelayMs: args.retryDelayMs,
    });
  }
  return importIrTranscriptIntoT3({
    ir: args.ir,
    dbPath: args.dbPath,
    intent,
    backup: args.backup,
    busyTimeoutMs: args.busyTimeoutMs,
    lockRetries: args.lockRetries,
    retryDelayMs: args.retryDelayMs,
  });
}

module.exports = {
  writeIrToT3,
};
