const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} = require("./t3-copy");

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
      if (!isSqliteLockedError(error) || attempt > retries) throw error;
      lastError = error;
      sleepMs(retryDelayMs);
    }
  }
  throw lastError || new Error("Exhausted sqlite lock retries.");
}

function backupSqlite(dbPath, busyTimeoutMs) {
  const { spawnSync } = require("child_process");
  const backupPath = `${dbPath}.threadbridge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
  const result = spawnSync(
    "sqlite3",
    ["-cmd", `PRAGMA busy_timeout = ${busyTimeoutMs};`, dbPath, `.backup ${backupPath}`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "sqlite backup failed");
  }
  return backupPath;
}

function mapTranscriptToTurns(transcript) {
  const normalized = [];
  let currentTurn = null;

  for (const entry of transcript) {
    if (entry.role === "user") {
      const messageId = crypto.randomUUID();
      currentTurn = {
        turnId: crypto.randomUUID(),
        pendingMessageId: messageId,
        assistantMessageId: null,
        requestedAt: entry.timestamp,
        startedAt: null,
        completedAt: entry.timestamp,
      };
      normalized.push({
        messageId,
        role: "user",
        text: entry.text,
        turnId: null,
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        isStreaming: false,
      });
      normalized.push({ turnMarker: currentTurn });
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
      };
      normalized.push({ turnMarker: currentTurn });
    }
    if (currentTurn.startedAt === null) currentTurn.startedAt = entry.timestamp;
    currentTurn.assistantMessageId = messageId;
    currentTurn.completedAt = entry.timestamp;
    normalized.push({
      messageId,
      role: "assistant",
      text: entry.text,
      turnId: currentTurn.turnId,
      createdAt: entry.timestamp,
      updatedAt: entry.timestamp,
      isStreaming: false,
    });
  }

  const messages = normalized.filter((e) => !e.turnMarker);
  const turns = normalized.filter((e) => e.turnMarker).map((e) => ({
    turnId: e.turnMarker.turnId,
    pendingMessageId: e.turnMarker.pendingMessageId,
    assistantMessageId: e.turnMarker.assistantMessageId,
    requestedAt: e.turnMarker.requestedAt,
    startedAt: e.turnMarker.startedAt,
    completedAt: e.turnMarker.completedAt,
    state: "completed",
  }));
  return { messages, turns };
}

function importCodexIntoT3({
  codexSession,
  dbPath,
  title = null,
  projectId = null,
  workspaceRoot = null,
  backup = true,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  lockRetries = DEFAULT_LOCK_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`T3 database not found: ${dbPath}`);
  }

  const now = new Date().toISOString();
  const transcript = codexSession.transcript.map((entry, index) => ({
    ...entry,
    timestamp: new Date(Date.parse(now) + index * 1000).toISOString(),
  }));
  const { messages, turns } = mapTranscriptToTurns(transcript);
  const latestTurnId = turns.length ? turns[turns.length - 1].turnId : null;
  const latestUserMessageAt =
    [...messages].reverse().find((message) => message.role === "user")?.createdAt || null;
  const threadCreatedAt = messages[0]?.createdAt || now;
  const threadUpdatedAt = messages[messages.length - 1]?.updatedAt || now;

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot || codexSession.originalCwd);
  const modelSelection = {
    provider: "codex",
    model: codexSession.model,
    ...(codexSession.reasoningEffort
      ? { options: { reasoningEffort: codexSession.reasoningEffort } }
      : {}),
  };
  const threadTitle =
    title ||
    (codexSession.transcript.find((entry) => entry.role === "user")?.text || codexSession.sessionId)
      .trim()
      .slice(0, 120);
  const runtimeMode = codexSession.runtimeMode;
  const interactionMode = codexSession.interactionMode;
  const projectTitle = path.basename(resolvedWorkspaceRoot) || resolvedWorkspaceRoot;
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

      let resolvedProjectId = projectId;
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
        JSON.stringify(modelSelection),
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
        JSON.stringify(modelSelection),
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
      for (const message of messages) {
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
        ) VALUES (?, ?, NULL, 'info', 'import.codex.session', ?, ?, 1, ?)
      `).run(
        activityId,
        threadId,
        `Imported Codex session ${codexSession.sessionId}`,
        JSON.stringify({
          source: "threadbridge",
          sessionId: codexSession.sessionId,
          sessionFile: codexSession.filePath,
          importedAt: now,
          transcriptMessageCount: messages.length,
          turnCount: turns.length,
        }),
        now,
      );

      db.exec("COMMIT");
      return {
        threadId,
        threadTitle,
        projectId: resolvedProjectId,
        projectTitle,
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      db.close();
    }
  }, retryConfig);

  return {
    dbPath,
    backupPath,
    threadId,
    threadTitle,
    messageCount: messages.length,
    turnCount: turns.length,
  };
}

function ensureDbExists(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`T3 database not found: ${dbPath}`);
  }
  return dbPath;
}

function buildT3Export(threadId, dbPath) {
  ensureDbExists(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const thread = db
      .prepare(`
        SELECT
          threads.thread_id AS threadId,
          threads.title AS title,
          threads.created_at AS createdAt,
          threads.updated_at AS updatedAt,
          threads.model_selection_json AS modelSelectionJson,
          projects.workspace_root AS workspaceRoot
        FROM projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ?
          AND threads.deleted_at IS NULL
        LIMIT 1
      `)
      .get(threadId);
    if (!thread) {
      throw new Error(`T3 thread not found: ${threadId}`);
    }
    const messages = db
      .prepare(`
        SELECT role, text, created_at AS createdAt, updated_at AS updatedAt
        FROM projection_thread_messages
        WHERE thread_id = ?
        ORDER BY created_at ASC, message_id ASC
      `)
      .all(threadId);

    return {
      threadId: thread.threadId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      workspaceRoot: thread.workspaceRoot || process.cwd(),
      modelSelection: parseMaybeJson(thread.modelSelectionJson),
      messages,
    };
  } finally {
    db.close();
  }
}

function generateCodexSessionFromT3({
  t3Thread,
  targetRoot,
  sessionId = null,
}) {
  const now = new Date().toISOString();
  const id = sessionId || `tb-${crypto.randomUUID()}`;
  const model = t3Thread.modelSelection?.model || "gpt-5.4";
  const reasoningEffort = t3Thread.modelSelection?.options?.reasoningEffort || "medium";
  const cwd = t3Thread.workspaceRoot || process.cwd();

  const lines = [];
  lines.push({
    type: "session_meta",
    payload: {
      id,
      timestamp: t3Thread.createdAt || now,
      cwd,
      originator: "threadbridge",
      source: "t3",
    },
    timestamp: now,
  });
  lines.push({
    type: "turn_context",
    payload: {
      cwd,
      model,
      approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write" },
      collaboration_mode: {
        mode: "default",
        settings: { reasoning_effort: reasoningEffort },
      },
    },
    timestamp: now,
  });

  for (const message of t3Thread.messages) {
    const phase = message.role === "assistant" ? "final" : undefined;
    lines.push({
      type: "response_item",
      payload: {
        type: "message",
        role: message.role,
        ...(phase ? { phase } : {}),
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.text,
          },
        ],
      },
      timestamp: message.createdAt || now,
    });
  }

  const date = new Date(now);
  const rel = path.join(
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    `${id}.jsonl`,
  );
  const outputPath = path.join(targetRoot, rel);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return {
    sessionId: id,
    outputPath,
    messageCount: t3Thread.messages.length,
    sourceThreadId: t3Thread.threadId,
  };
}

module.exports = {
  importCodexIntoT3,
  mapTranscriptToTurns,
  buildT3Export,
  generateCodexSessionFromT3,
  withLockRetries,
};
