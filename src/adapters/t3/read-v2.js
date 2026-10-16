const { createThreadbridgeIr } = require("../../ir");
const {
  attachmentsFromPayloadJson,
  parseMaybeJson,
  planMarkdownFromV2Payload,
  tableExists,
  textFromPayloadJson,
  withReadTransaction,
} = require("./storage");

function columnExists(db, table, name) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
}

function warning(code, message, details = {}) {
  return { code, message, ...details };
}

function jsonPayload(text, warnings, context) {
  if (text === undefined || text === null || text === "") {
    return {};
  }
  const value = parseMaybeJson(text);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  warnings.push(warning("t3_v2_invalid_payload", "A v2 payload was not valid JSON.", context));
  return {};
}

function readRows(db, table, threadId) {
  return db.prepare(`SELECT * FROM ${table} WHERE thread_id = ?`).all(threadId);
}

function isSupersededInterrupt(item, attempts, items) {
  if (item.type !== "run_interrupt_result" || !item.runId || !item.nodeId) {
    return false;
  }
  const superseded = attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!superseded) {
    return false;
  }
  return !items.some(
    (candidate) =>
      candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
}

function isLocalItemVisible(item, state) {
  const runStatus = item.runId ? state.runStatus.get(item.runId) : undefined;
  if (runStatus === "rolled_back") {
    return false;
  }
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId &&
    runStatus === "cancelled"
  ) {
    return false;
  }
  return !isSupersededInterrupt(item, state.attempts, state.items);
}

function localItems(state) {
  return state.items
    .filter((item) => isLocalItemVisible(item, state))
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
}

function renumber(rows) {
  return rows.map((row, position) => ({ ...row, position }));
}

function localRows(threadId, state) {
  return localItems(state).map((item) => ({
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));
}

function sourcePrefixItems(state, sourceRun) {
  const runOrdinals = new Map(state.runs.map((run) => [run.runId, run.ordinal]));
  return state.items
    .filter((item) => !isSupersededInterrupt(item, state.attempts, state.items))
    .filter((item) => {
      if (item.runId === null || item.runId === undefined) {
        return state.payload.historyOrigin === "v1_import";
      }
      return (runOrdinals.get(item.runId) ?? Infinity) <= sourceRun.ordinal;
    })
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
}

function makeForkMarker(state, fork) {
  return {
    id: `turn-item:fork:${state.thread.thread_id}`,
    threadId: state.thread.thread_id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: state.thread.created_at,
    updatedAt: state.thread.created_at,
    type: "fork",
    source: {
      type: "run",
      threadId: fork.threadId,
      runId: fork.runId,
    },
    targetThreadId: state.thread.thread_id,
  };
}

function loadState(db, threadId, warnings, { allowDeleted = false } = {}) {
  const deletedAt = columnExists(db, "orchestration_v2_projection_threads", "deleted_at")
    ? " AND deleted_at IS NULL"
    : "";
  const thread = db
    .prepare(
      `SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ?${allowDeleted ? "" : deletedAt}`,
    )
    .get(threadId);
  if (!thread) {
    return null;
  }

  const payload = jsonPayload(thread.payload_json, warnings, { threadId });
  const runs = tableExists(db, "orchestration_v2_projection_runs")
    ? readRows(db, "orchestration_v2_projection_runs", threadId)
        .map((row) => {
          const runPayload = jsonPayload(row.payload_json, warnings, {
            threadId,
            runId: row.run_id,
          });
          return {
            runId: row.run_id,
            ordinal: row.ordinal,
            status: row.status,
            requestedAt: row.requested_at,
            startedAt: runPayload.startedAt || row.requested_at,
            completedAt: row.completed_at || runPayload.completedAt || null,
          };
        })
        .sort((left, right) => left.ordinal - right.ordinal || left.runId.localeCompare(right.runId))
    : [];
  const attempts = tableExists(db, "orchestration_v2_projection_run_attempts")
    ? readRows(db, "orchestration_v2_projection_run_attempts", threadId).map((row) => ({
        runId: row.run_id,
        rootNodeId: row.root_node_id,
        status: row.status,
      }))
    : [];
  const items = tableExists(db, "orchestration_v2_projection_turn_items")
    ? readRows(db, "orchestration_v2_projection_turn_items", threadId)
        .map((row) => {
          const itemPayload = jsonPayload(row.payload_json, warnings, {
            threadId,
            turnItemId: row.turn_item_id,
          });
          return {
            ...itemPayload,
            id: row.turn_item_id || itemPayload.id,
            threadId,
            runId: row.run_id ?? itemPayload.runId ?? null,
            nodeId: row.node_id ?? itemPayload.nodeId ?? null,
            providerThreadId:
              row.provider_thread_id ?? itemPayload.providerThreadId ?? null,
            providerTurnId: row.provider_turn_id ?? itemPayload.providerTurnId ?? null,
            parentItemId: row.parent_item_id ?? itemPayload.parentItemId ?? null,
            ordinal: row.ordinal ?? itemPayload.ordinal ?? 0,
            type: row.type || itemPayload.type,
            status: row.status || itemPayload.status,
            updatedAt: row.updated_at || itemPayload.updatedAt || null,
          };
        })
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    : [];
  const project = tableExists(db, "projection_projects")
    ? db
        .prepare(
          "SELECT title, workspace_root AS workspaceRoot FROM projection_projects WHERE project_id = ? LIMIT 1",
        )
        .get(thread.project_id)
    : null;

  return {
    thread,
    project,
    payload,
    runs,
    attempts,
    items,
    runStatus: new Map(runs.map((run) => [run.runId, run.status])),
    turnItemsTable: tableExists(db, "orchestration_v2_projection_turn_items"),
  };
}

function normalizeFork(payload, threadId, warnings) {
  if (payload.forkedFrom === null || payload.forkedFrom === undefined) {
    return null;
  }
  if (
    !payload.forkedFrom ||
    typeof payload.forkedFrom !== "object" ||
    payload.forkedFrom.type !== "run" ||
    typeof payload.forkedFrom.threadId !== "string" ||
    typeof payload.forkedFrom.runId !== "string"
  ) {
    warnings.push(
      warning("t3_v2_malformed_fork", "A v2 fork reference was malformed; local history was used.", {
        threadId,
      }),
    );
    return null;
  }
  return payload.forkedFrom;
}

function visibleItems(db, threadId, warnings, seen = new Set(), allowDeleted = false) {
  const state = loadState(db, threadId, warnings, {
    allowDeleted: allowDeleted || seen.has(threadId),
  });
  if (!state) {
    warnings.push(warning("t3_v2_missing_ancestor", "A fork ancestor was not found.", { threadId }));
    return [];
  }

  if (seen.has(threadId)) {
    warnings.push(warning("t3_v2_ancestor_cycle", "Fork ancestry contains a cycle.", { threadId }));
    return renumber(localRows(threadId, state));
  }

  const nextSeen = new Set(seen).add(threadId);
  const fork = normalizeFork(state.payload, threadId, warnings);
  if (!fork) {
    return renumber(localRows(threadId, state));
  }

  // ProjectionStore stops at the fork boundary when the source has already
  // been visited. Loading that source again would duplicate the cycle's local
  // rows and can make a malformed lineage grow on every recursive edge.
  if (seen.has(fork.threadId)) {
    warnings.push(
      warning("t3_v2_ancestor_cycle", "Fork ancestry contains a cycle.", {
        threadId,
        sourceThreadId: fork.threadId,
      }),
    );
    return renumber(localRows(threadId, state));
  }

  const source = loadState(db, fork.threadId, warnings, { allowDeleted: true });
  const marker = makeForkMarker(state, fork);
  const local = localRows(threadId, state);
  if (!source) {
    warnings.push(
      warning(
        "t3_v2_missing_ancestor",
        "A fork ancestor was not found; local history was used.",
        { threadId, sourceThreadId: fork.threadId },
      ),
    );
    return renumber(local);
  }

  const sourceRun = source.runs.find((run) => run.runId === fork.runId);
  if (!sourceRun) {
    warnings.push(
      warning(
        "t3_v2_missing_fork_run",
        "A fork source run was not found; inherited history is empty.",
        { threadId, sourceThreadId: fork.threadId, sourceRunId: fork.runId },
      ),
    );
    return renumber([
      {
        visibility: "synthetic",
        sourceThreadId: fork.threadId,
        sourceItemId: marker.id,
        item: marker,
      },
      ...local,
    ]);
  }

  const inherited = visibleItems(db, fork.threadId, warnings, nextSeen, true);
  const inheritedPrefix = inherited
    .filter(
      (row) =>
        row.item.threadId !== source.thread.thread_id || row.item.type === "fork",
    )
    .map((row) => ({ ...row, visibility: "inherited" }));
  const localPrefix = sourcePrefixItems(source, sourceRun).map((item) => ({
    visibility: "inherited",
    sourceThreadId: fork.threadId,
    sourceItemId: item.id,
    item,
  }));

  return renumber([
    ...inheritedPrefix,
    ...localPrefix,
    {
      visibility: "synthetic",
      sourceThreadId: fork.threadId,
      sourceItemId: marker.id,
      item: marker,
    },
    ...local,
  ]);
}

function plansFromVisibleItems(visible) {
  const plans = [];
  const seen = new Set();
  for (const row of visible) {
    const item = row.item;
    if (item.type !== "proposed_plan" && item.type !== "todo_list") {
      continue;
    }
    const planId = item.planId || item.id;
    if (!planId || seen.has(`${row.sourceThreadId}\u0000${planId}`)) {
      continue;
    }
    seen.add(`${row.sourceThreadId}\u0000${planId}`);
    const updatedAt = item.updatedAt || item.completedAt || item.startedAt || null;
    plans.push({
      planId,
      turnId: item.runId || null,
      markdown:
        typeof item.markdown === "string"
          ? item.markdown
          : planMarkdownFromV2Payload(JSON.stringify(item)),
      createdAt: item.createdAt || item.startedAt || updatedAt,
      updatedAt,
      implementedAt: item.implementedAt || null,
      implementationThreadId: item.implementationThreadId || null,
      metadata: {
        sourceThreadId: row.sourceThreadId,
        sourceItemId: row.sourceItemId,
        visibility: row.visibility,
        kind: item.type,
        status: item.status || null,
      },
    });
  }
  return plans;
}

function readV2Runtime(db, threadId, includeRuntime, warnings) {
  if (
    !includeRuntime ||
    !tableExists(db, "orchestration_v2_projection_provider_session_bindings") ||
    !tableExists(db, "orchestration_v2_projection_provider_sessions")
  ) {
    return null;
  }
  const row = db
    .prepare(
      "SELECT b.provider_session_id AS providerSessionId, s.provider, s.status, s.model, s.updated_at AS updatedAt, s.payload_json AS payloadJson, s.driver, s.provider_instance_id AS providerInstanceId FROM orchestration_v2_projection_provider_session_bindings b JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = b.provider_session_id WHERE b.thread_id = ? ORDER BY s.updated_at DESC LIMIT 1",
    )
    .get(threadId);
  if (!row) {
    return null;
  }
  return {
    session: {
      threadId,
      status: row.status,
      providerName: row.provider,
      providerInstanceId: row.providerInstanceId || null,
      updatedAt: row.updatedAt,
    },
    providerRuntime: {
      threadId,
      providerName: row.provider,
      adapterKey: row.driver || row.provider,
      status: row.status,
      model: row.model || null,
      payload: jsonPayload(row.payloadJson, warnings, {
        threadId,
        providerSessionId: row.providerSessionId,
      }),
    },
  };
}

function readProjectedMessages(db, threadId, warnings = []) {
  if (!tableExists(db, "orchestration_v2_projection_messages")) {
    return [];
  }
  return db
    .prepare(
      "SELECT message_id AS messageId, role, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt, run_id AS runId, streaming FROM orchestration_v2_projection_messages WHERE thread_id = ? AND streaming = 0 ORDER BY created_at ASC, message_id ASC",
    )
    .all(threadId)
    .map((row) => ({
      messageId: row.messageId,
      role: row.role,
      text: textFromPayloadJson(row.payloadJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      turnId: row.runId || null,
      attachments: attachmentsFromPayloadJson(row.payloadJson),
      isStreaming: false,
      metadata: { degraded: true },
    }));
}

function visibleMessage(row) {
  const item = row.item;
  const role =
    item.type === "user_message"
      ? "user"
      : item.type === "assistant_message"
        ? "assistant"
        : null;
  if (!role) {
    return null;
  }
  return {
    messageId: item.messageId || item.id,
    role,
    text:
      typeof item.text === "string"
        ? item.text
        : typeof item.input?.text === "string"
          ? item.input.text
          : "",
    createdAt: item.createdAt || item.startedAt || item.updatedAt || null,
    updatedAt: item.updatedAt || item.completedAt || item.startedAt || null,
    turnId: item.runId || null,
    attachments: Array.isArray(item.attachments) ? item.attachments : [],
    isStreaming: item.streaming === true,
    metadata: {
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      visibility: row.visibility,
    },
  };
}

function readT3V2ThreadAsIrFromDb({
  db,
  dbPath,
  threadId,
  includeRuntime = false,
  warnings = [],
}) {
  const state = loadState(db, threadId, warnings);
  if (!state) {
    return null;
  }

  const visible = visibleItems(db, threadId, warnings);
  let messages = visible
    .filter(
      (row) =>
        row.item.type === "user_message" || row.item.type === "assistant_message",
    )
    .map(visibleMessage)
    .filter(Boolean);
  if (visible.length === 0 && !state.turnItemsTable) {
    messages = readProjectedMessages(db, threadId, warnings);
    if (messages.length > 0) {
      warnings.push(
        warning(
          "t3_v2_degraded_message_fallback",
          "No turn items were projected; transcript was read from v2 message rows.",
        ),
      );
    }
  } else if (visible.length === 0) {
    warnings.push(
      warning("t3_v2_no_visible_turn_items", "No visible turn items were projected."),
    );
  }

  const payload = state.payload;
  const workspaceRoot =
    state.project?.workspaceRoot ||
    payload.workspaceRoot ||
    payload.projectRoot ||
    payload.worktreePath ||
    process.cwd();
  const plans = plansFromVisibleItems(visible);
  const runtime = readV2Runtime(db, threadId, includeRuntime, warnings);
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
      title: state.thread.title,
      createdAt: state.thread.created_at,
      updatedAt: state.thread.updated_at,
      workspaceRoot,
      branch: payload.branch || null,
      worktreePath: payload.worktreePath || null,
      runtimeMode:
        state.thread.runtime_mode || payload.runtimeMode || "approval-required",
      interactionMode:
        state.thread.interaction_mode || payload.interactionMode || "default",
      modelSelection: payload.modelSelection || null,
    },
    project: {
      projectId: state.thread.project_id,
      title: state.project?.title || null,
      workspaceRoot,
    },
    messages,
    turns: state.runs.map((run) => ({
      turnId: run.runId,
      pendingMessageId: null,
      assistantMessageId: null,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      state: run.status,
      checkpoint: {
        turnCount: run.ordinal,
        ref: null,
        status: run.status,
        files: [],
      },
      metadata: {},
    })),
    // Native v2 history comes only from canonical visible turn items. The
    // legacy activity projection may contain stale or hidden entries.
    activities: [],
    plans,
    runtime,
    lineage: {
      sourceThreadId: threadId,
      forkedFrom: payload.forkedFrom || null,
    },
    capabilities: {
      supportsLosslessClone: false,
      supportsRuntimeRebind: false,
      supportsTranscriptOnlyWrite: true,
      containsOpaqueData: true,
    },
    extensions: {
      t3OrchestrationV2: {
        storage: "orchestration_v2",
        providerInstanceId:
          state.thread.provider_instance_id ||
          payload.providerInstanceId ||
          payload.modelSelection?.instanceId ||
          null,
        thread: { ...state.thread, payload },
        visibleTurnItems: visible,
        plans,
        warnings,
      },
    },
    warnings,
  });
}

function readT3V2ThreadAsIr({
  db,
  dbPath,
  threadId,
  includeRuntime = false,
  warnings = [],
}) {
  if (db) {
    return readT3V2ThreadAsIrFromDb({
      db,
      dbPath,
      threadId,
      includeRuntime,
      warnings,
    });
  }
  return withReadTransaction(dbPath, (transactionDb) =>
    readT3V2ThreadAsIrFromDb({
      db: transactionDb,
      dbPath,
      threadId,
      includeRuntime,
      warnings,
    }),
  );
}

module.exports = {
  loadV2State: loadState,
  readProjectedMessages,
  readT3V2ThreadAsIr,
  readT3V2ThreadAsIrFromDb,
  visibleV2Items: visibleItems,
};
