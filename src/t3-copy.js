const crypto = require("crypto");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { listThreadIndexRows, resolveThreadTargetFromIndex } = require("./adapters/t3/storage");

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRIES = 20;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_T3_MODEL_SELECTION_JSON = JSON.stringify({
  instanceId: "claudeAgent",
  model: "claude-opus-4-7",
});

function fail(message) {
  throw new Error(message);
}

function ensureDbExists(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    fail(`Database not found: ${dbPath}`);
  }
  return dbPath;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeModelSelectionJson(value, { fallback = DEFAULT_T3_MODEL_SELECTION_JSON } = {}) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  if (candidate === undefined || candidate === null || candidate === "") return null;

  let parsed = candidate;
  if (typeof candidate === "string") {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      fail("T3 model selection must be valid JSON.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("T3 model selection must be a JSON object.");
  }
  return JSON.stringify(parsed);
}

function backupSqlite(dbPath, busyTimeoutMs) {
  const backupPath = `${dbPath}.threadbridge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  const result = spawnSync(
    "sqlite3",
    ["-cmd", `PRAGMA busy_timeout = ${busyTimeoutMs};`, dbPath, `.backup ${backupPath}`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    fail(result.stderr || result.error?.message || "sqlite backup failed");
  }
  return backupPath;
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

function isSqliteLockedError(error) {
  const text = String(error && error.message ? error.message : error || "");
  return text.includes("database is locked") || text.includes("database busy");
}

function withLockRetries(fn, { retries, retryDelayMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteLockedError(error) || attempt > retries) {
        throw error;
      }
      lastError = error;
      sleepMs(retryDelayMs);
    }
  }
  throw lastError || new Error("Exhausted sqlite lock retries.");
}

function resolveThreadTarget({ sourceDbPath, target }) {
  const rows = listThreadIndexRows(sourceDbPath);
  try {
    return resolveThreadTargetFromIndex({ rows, target, sourceDbPath });
  } catch (error) {
    fail(error.message);
  }
}

function buildSnapshot({ sourceDbPath, sourceThreadId }) {
  const db = new DatabaseSync(sourceDbPath);
  try {
    const thread = db
      .prepare(`SELECT * FROM projection_threads WHERE thread_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(sourceThreadId);
    if (!thread) {
      fail(`Source thread not found: ${sourceThreadId}`);
    }

    const project = db
      .prepare(`SELECT * FROM projection_projects WHERE project_id = ? LIMIT 1`)
      .get(thread.project_id);
    if (!project) {
      fail(`Source project missing for thread ${sourceThreadId}: ${thread.project_id}`);
    }

    const messages = db
      .prepare(`SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC`)
      .all(sourceThreadId);
    const turns = db
      .prepare(`SELECT * FROM projection_turns WHERE thread_id = ? ORDER BY row_id ASC`)
      .all(sourceThreadId);
    const activities = db
      .prepare(`
        SELECT * FROM projection_thread_activities
        WHERE thread_id = ?
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `)
      .all(sourceThreadId);
    const proposedPlans = db
      .prepare(`SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ? ORDER BY created_at ASC, plan_id ASC`)
      .all(sourceThreadId);
    const session = db
      .prepare(`SELECT * FROM projection_thread_sessions WHERE thread_id = ? LIMIT 1`)
      .get(sourceThreadId);
    const runtime = db
      .prepare(`SELECT * FROM provider_session_runtime WHERE thread_id = ? LIMIT 1`)
      .get(sourceThreadId);

    return {
      thread,
      project,
      messages,
      turns,
      activities,
      proposedPlans,
      session: session || null,
      runtime: runtime || null,
    };
  } finally {
    db.close();
  }
}

function remapSnapshotIds(snapshot, newThreadId) {
  const messageIdMap = new Map();
  const turnIdMap = new Map();
  const activityIdMap = new Map();
  const planIdMap = new Map();

  for (const row of snapshot.messages) {
    messageIdMap.set(row.message_id, crypto.randomUUID());
  }
  for (const row of snapshot.turns) {
    if (row.turn_id) {
      turnIdMap.set(row.turn_id, crypto.randomUUID());
    }
  }
  for (const row of snapshot.activities) {
    activityIdMap.set(row.activity_id, crypto.randomUUID());
  }
  for (const row of snapshot.proposedPlans) {
    planIdMap.set(row.plan_id, crypto.randomUUID());
  }

  const remapTurnId = (id) => (id && turnIdMap.has(id) ? turnIdMap.get(id) : id);
  const remapMessageId = (id) => (id && messageIdMap.has(id) ? messageIdMap.get(id) : id);

  return {
    thread: {
      ...snapshot.thread,
      thread_id: newThreadId,
      latest_turn_id: remapTurnId(snapshot.thread.latest_turn_id),
    },
    project: snapshot.project,
    messages: snapshot.messages.map((row) => ({
      ...row,
      thread_id: newThreadId,
      message_id: messageIdMap.get(row.message_id),
      turn_id: remapTurnId(row.turn_id),
    })),
    turns: snapshot.turns.map((row) => ({
      ...row,
      thread_id: newThreadId,
      turn_id: remapTurnId(row.turn_id),
      pending_message_id: remapMessageId(row.pending_message_id),
      assistant_message_id: remapMessageId(row.assistant_message_id),
      source_proposed_plan_thread_id:
        row.source_proposed_plan_thread_id === snapshot.thread.thread_id
          ? newThreadId
          : row.source_proposed_plan_thread_id,
    })),
    activities: snapshot.activities.map((row) => ({
      ...row,
      thread_id: newThreadId,
      activity_id: activityIdMap.get(row.activity_id),
      turn_id: remapTurnId(row.turn_id),
    })),
    proposedPlans: snapshot.proposedPlans.map((row) => ({
      ...row,
      thread_id: newThreadId,
      plan_id: planIdMap.get(row.plan_id),
      turn_id: remapTurnId(row.turn_id),
      implementation_thread_id:
        row.implementation_thread_id === snapshot.thread.thread_id
          ? newThreadId
          : row.implementation_thread_id,
    })),
    session: snapshot.session
      ? {
          ...snapshot.session,
          thread_id: newThreadId,
          active_turn_id: remapTurnId(snapshot.session.active_turn_id),
        }
      : null,
    runtime: snapshot.runtime
      ? {
          ...snapshot.runtime,
          thread_id: newThreadId,
          runtime_payload_json: (() => {
            const payload = parseMaybeJson(snapshot.runtime.runtime_payload_json);
            if (!payload || typeof payload !== "object") {
              return snapshot.runtime.runtime_payload_json;
            }
            const next = { ...payload };
            if (next.activeTurnId && turnIdMap.has(next.activeTurnId)) {
              next.activeTurnId = turnIdMap.get(next.activeTurnId);
            }
            return JSON.stringify(next);
          })(),
        }
      : null,
  };
}

function insertSnapshot({ targetDbPath, snapshot, copyRuntime, titleOverride, busyTimeoutMs, newProjectId, newModelSelection }) {
  const db = new DatabaseSync(targetDbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("BEGIN IMMEDIATE");

    const thread = {
      ...snapshot.thread,
      title: titleOverride || snapshot.thread.title,
      updated_at: new Date().toISOString(),
    };

    // Use new project if specified
    if (newProjectId) {
      thread.project_id = newProjectId;
    }

    // Update model selection if specified. The final value is resolved against
    // the target project's default inside the transaction below.
    if (newModelSelection !== undefined && newModelSelection !== null) {
      thread.model_selection_json = newModelSelection;
    }

    const targetProject = db
      .prepare("SELECT default_model_selection_json FROM projection_projects WHERE project_id = ? LIMIT 1")
      .get(thread.project_id);
    const sourceProjectModelSelection = thread.project_id === snapshot.project.project_id
      ? snapshot.project.default_model_selection_json
      : null;
    const modelSelectionCandidate = [
      thread.model_selection_json,
      targetProject?.default_model_selection_json,
      sourceProjectModelSelection,
    ].find((value) => value !== undefined && value !== null && value !== "");
    thread.model_selection_json = normalizeModelSelectionJson(modelSelectionCandidate);

    // Insert project if it doesn't exist
    db.prepare(`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, default_model_selection_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO NOTHING
    `).run(
      thread.project_id === snapshot.project.project_id ? snapshot.project.project_id : newProjectId,
      thread.project_id === snapshot.project.project_id ? snapshot.project.title : 'New Project',
      thread.project_id === snapshot.project.project_id ? snapshot.project.workspace_root : '',
      thread.project_id === snapshot.project.project_id ? snapshot.project.scripts_json : '[]',
      thread.project_id === snapshot.project.project_id ? snapshot.project.created_at : new Date().toISOString(),
      thread.project_id === snapshot.project.project_id ? snapshot.project.updated_at : new Date().toISOString(),
      thread.project_id === snapshot.project.project_id ? snapshot.project.deleted_at : null,
      thread.project_id === snapshot.project.project_id
        ? normalizeModelSelectionJson(snapshot.project.default_model_selection_json, { fallback: null })
        : thread.model_selection_json,
    );

    db.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at,
        runtime_mode, interaction_mode, model_selection_json, archived_at, latest_user_message_at,
        pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.thread_id,
      thread.project_id,
      thread.title,
      thread.branch,
      thread.worktree_path,
      thread.latest_turn_id,
      thread.created_at,
      thread.updated_at,
      thread.deleted_at,
      thread.runtime_mode,
      thread.interaction_mode,
      thread.model_selection_json,
      thread.archived_at,
      thread.latest_user_message_at,
      thread.pending_approval_count,
      thread.pending_user_input_count,
      thread.has_actionable_proposed_plan,
    );

    const insertMessage = db.prepare(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.messages) {
      insertMessage.run(
        row.message_id,
        row.thread_id,
        row.turn_id,
        row.role,
        row.text,
        row.is_streaming,
        row.created_at,
        row.updated_at,
        row.attachments_json,
      );
    }

    const insertTurn = db.prepare(`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at,
        checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json,
        source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.turns) {
      insertTurn.run(
        row.thread_id,
        row.turn_id,
        row.pending_message_id,
        row.assistant_message_id,
        row.state,
        row.requested_at,
        row.started_at,
        row.completed_at,
        row.checkpoint_turn_count,
        row.checkpoint_ref,
        row.checkpoint_status,
        row.checkpoint_files_json,
        row.source_proposed_plan_thread_id,
        row.source_proposed_plan_id,
      );
    }

    const insertActivity = db.prepare(`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.activities) {
      insertActivity.run(
        row.activity_id,
        row.thread_id,
        row.turn_id,
        row.tone,
        row.kind,
        row.summary,
        row.payload_json,
        row.created_at,
        row.sequence,
      );
    }

    const insertPlan = db.prepare(`
      INSERT INTO projection_thread_proposed_plans (
        plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at, implementation_thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of snapshot.proposedPlans) {
      insertPlan.run(
        row.plan_id,
        row.thread_id,
        row.turn_id,
        row.plan_markdown,
        row.created_at,
        row.updated_at,
        row.implemented_at,
        row.implementation_thread_id,
      );
    }

    if (copyRuntime && snapshot.session) {
      db.prepare(`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id, active_turn_id, last_error, updated_at, runtime_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.session.thread_id,
        snapshot.session.status,
        snapshot.session.provider_name,
        snapshot.session.provider_session_id,
        snapshot.session.provider_thread_id,
        snapshot.session.active_turn_id,
        snapshot.session.last_error,
        snapshot.session.updated_at,
        snapshot.session.runtime_mode,
      );
    }

    if (copyRuntime && snapshot.runtime) {
      db.prepare(`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.runtime.thread_id,
        snapshot.runtime.provider_name,
        snapshot.runtime.adapter_key,
        snapshot.runtime.runtime_mode,
        snapshot.runtime.status,
        snapshot.runtime.last_seen_at,
        snapshot.runtime.resume_cursor_json,
        snapshot.runtime.runtime_payload_json,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function copyThreadBetweenT3Dbs(options) {
  const { readT3ThreadAsIr } = require("./adapters/t3/read");
  const { writeIrToT3 } = require("./adapters/t3/write");
  const {
    sourceDbPath,
    targetDbPath,
    target,
    title = null,
    newThreadId = null,
    copyRuntime = false,
    backup = true,
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
    lockRetries = DEFAULT_LOCK_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    newProjectId = null,
    newModelSelection = null,
  } = options;

  const resolvedSource = ensureDbExists(sourceDbPath);
  const resolvedTarget = ensureDbExists(targetDbPath);
  const sourceThreadId = resolveThreadTarget({
    sourceDbPath: resolvedSource,
    target,
  });
  const ir = readT3ThreadAsIr({
    dbPath: resolvedSource,
    target: sourceThreadId,
    includeRuntime: copyRuntime,
  });
  const receipt = writeIrToT3({
    ir,
    dbPath: resolvedTarget,
    intent: "clone-thread",
    options: {
      title,
      newProjectId,
      newModelSelection,
      copyRuntime,
    },
    newThreadId,
    backup,
    busyTimeoutMs,
    lockRetries,
    retryDelayMs,
  });

  return {
    sourceThreadId,
    newThreadId: receipt.createdIds.threadId,
    title: receipt.details.threadTitle,
    sourceDbPath: resolvedSource,
    targetDbPath: resolvedTarget,
    backupPath: receipt.backupPath,
    counts: receipt.counts,
    warnings: receipt.warnings,
  };
}

function copyThreadToNewWorkspace(options) {
  const { readT3ThreadAsIr } = require("./adapters/t3/read");
  const { writeIrToT3 } = require("./adapters/t3/write");
  const {
    dbPath,
    target,
    newProjectId,
    newProvider,
    newModel,
    newModelSelection,
    title = null,
    newThreadId = null,
    copyRuntime = false,
    backup = true,
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
    lockRetries = DEFAULT_LOCK_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const resolvedDbPath = ensureDbExists(dbPath);
  const sourceThreadId = resolveThreadTarget({
    sourceDbPath: resolvedDbPath,
    target,
  });
  const ir = readT3ThreadAsIr({
    dbPath: resolvedDbPath,
    target: sourceThreadId,
    includeRuntime: copyRuntime,
  });
  const receipt = writeIrToT3({
    ir,
    dbPath: resolvedDbPath,
    intent: "copy-to-workspace",
    options: {
      title: title || `${ir.thread.title} (new workspace)`,
      newProjectId,
      newProvider,
      newModel,
      newModelSelection,
      copyRuntime,
    },
    newThreadId,
    backup,
    busyTimeoutMs,
    lockRetries,
    retryDelayMs,
  });

  return {
    sourceThreadId,
    newThreadId: receipt.createdIds.threadId,
    title: receipt.details.threadTitle,
    dbPath: resolvedDbPath,
    backupPath: receipt.backupPath,
    counts: receipt.counts,
    warnings: receipt.warnings,
  };
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  backupSqlite,
  buildSnapshot,
  ensureDbExists,
  insertSnapshot,
  normalizeModelSelectionJson,
  remapSnapshotIds,
  resolveThreadTarget,
  withLockRetries,
  copyThreadBetweenT3Dbs,
  copyThreadToNewWorkspace,
};
