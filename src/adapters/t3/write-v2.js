const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { validateIr, extractPlainTextFromBlocks } = require("../../ir");
const { createOperationReceipt } = require("../../receipts");
const { backupSqlite, withLockRetries, DEFAULT_BUSY_TIMEOUT_MS, DEFAULT_LOCK_RETRIES, DEFAULT_RETRY_DELAY_MS } = require("../../t3-copy");
const { inspectT3Storage, validateV2Projection } = require("./profile");
const { prepareAttachments } = require("./attachments");

function insert(db, table, record) {
  const keys = Object.keys(record);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => record[key]));
}

function assertOffline(dbPath) {
  const result = spawnSync("lsof", ["-t", "--", dbPath], { encoding: "utf8", timeout: 10000 });
  if (result.error || ![0, 1].includes(result.status) || result.stderr.trim()) {
    throw new Error("Cannot check whether T3 has the database open. Offline v2 writes require lsof; install it and stop T3 before retrying.");
  }
  const otherPids = result.stdout.trim().split(/\s+/).filter((pid) => pid && Number(pid) !== process.pid);
  if (otherPids.length) throw new Error("T3 database is open in another process. Stop T3 and other database users before importing.");
}

function iso(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid import timestamp: ${value}`);
  return date.toISOString();
}

function selection(ir, intent, project) {
  let supplied = intent.modelSelection || ir.thread.modelSelection || project?.default_model_selection_json;
  if (typeof supplied === "string") supplied = JSON.parse(supplied);
  supplied ||= {};
  const instanceId = intent.provider || supplied.instanceId || supplied.provider || (ir.source.harness === "t3" ? null : ir.source.harness);
  const model = intent.model || supplied.model;
  if (typeof instanceId !== "string" || !instanceId.trim() || typeof model !== "string" || !model.trim()) {
    throw new Error("T3 v2 imports require a provider instance and model. Supply --new-provider and --new-model, or a model selection JSON object.");
  }
  const options = supplied.options;
  if (options !== undefined && (!options || Array.isArray(options) || typeof options !== "object" || Object.values(options).some((v) => !["string", "boolean"].includes(typeof v)))) {
    throw new Error("T3 model options must be an object containing strings or booleans.");
  }
  return { instanceId: instanceId.trim(), model: model.trim(), ...(options === undefined ? {} : { options }) };
}

// Only these inert history events are emitted. No runs, provider bindings,
// commands, approvals or effects are copied into the destination.
function appendEvent(db, type, payload, occurredAt, provenance = null) {
  const project = type === "project.created";
  const streamId = project ? payload.projectId : payload.threadId || payload.id;
  const kind = project ? "project" : "thread";
  const payloadJson = JSON.stringify(payload);
  insert(db, "orchestration_events", {
    event_id: crypto.randomUUID(), aggregate_kind: kind, stream_id: streamId,
    stream_version: db.prepare("SELECT coalesce(max(stream_version)+1,0) AS n FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?").get(kind, streamId).n,
    event_type: type, occurred_at: occurredAt, command_id: null, causation_event_id: null,
    correlation_id: null, actor_kind: "server", payload_json: payloadJson,
    metadata_json: JSON.stringify(provenance ? { threadbridge: provenance } : {}), application_event_version: 2,
  });
  const p = payload;
  if (type === "thread.created") insert(db, "orchestration_v2_projection_threads", {
    thread_id: p.id, project_id: p.projectId, title: p.title, default_provider: p.providerInstanceId,
    provider_instance_id: p.providerInstanceId, runtime_mode: p.runtimeMode, interaction_mode: p.interactionMode,
    active_provider_thread_id: null, created_at: p.createdAt, updated_at: p.updatedAt,
    archived_at: null, deleted_at: null, payload_json: payloadJson,
  });
  if (type === "message.updated") insert(db, "orchestration_v2_projection_messages", {
    message_id: p.id, thread_id: p.threadId, run_id: null, node_id: null, role: p.role,
    streaming: 0, created_at: p.createdAt, updated_at: p.updatedAt, payload_json: payloadJson,
  });
  if (type === "turn-item.updated") {
    insert(db, "orchestration_v2_projection_turn_items", {
      turn_item_id: p.id, thread_id: p.threadId, run_id: null, node_id: null,
      provider_thread_id: null, provider_turn_id: null, parent_item_id: null,
      ordinal: p.ordinal, type: p.type, status: p.status, updated_at: p.updatedAt, payload_json: payloadJson,
    });
    insert(db, "orchestration_v2_turn_item_positions", { thread_id: p.threadId, turn_item_id: p.id, ordinal: p.ordinal });
  }
  if (type === "plan.updated") insert(db, "orchestration_v2_projection_plans", {
    plan_id: p.id, thread_id: p.threadId, run_id: null, node_id: p.nodeId, kind: p.kind,
    status: p.status, payload_json: payloadJson,
  });
  if (!project && type !== "thread.created") {
    db.prepare("UPDATE orchestration_v2_projection_threads SET updated_at=?,payload_json=json_set(payload_json,'$.updatedAt',?) WHERE thread_id=?").run(occurredAt, occurredAt, streamId);
  }
}

function portableEntries(ir, messages, warnings) {
  const visible = ir.extensions?.t3OrchestrationV2?.visibleTurnItems || [];
  const entries = [];
  const seenMessages = new Set();
  const seenPlans = new Set();
  let archivedItems = 0;
  for (const row of visible) {
    const item = row.item;
    if (["user_message", "assistant_message"].includes(item.type)) {
      const message = messages.find((m) => m.messageId === item.messageId && (!m.metadata?.sourceThreadId || m.metadata.sourceThreadId === row.sourceThreadId));
      if (message) { entries.push({ message }); seenMessages.add(message); }
    } else if (["proposed_plan", "todo_list"].includes(item.type)) {
      const plan = ir.plans.find((p) => p.planId === item.planId && (!p.metadata?.sourceThreadId || p.metadata.sourceThreadId === row.sourceThreadId)) || {
        planId: item.planId, markdown: item.markdown || (item.steps || []).map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.text}`).join("\n"), updatedAt: item.updatedAt,
      };
      entries.push({ plan }); seenPlans.add(plan.planId);
    } else if (item.type !== "fork") {
      // Keep rich history as inert, explicitly labelled text. Native tool and
      // approval records can refer to a provider execution we must not resume.
      entries.push({ message: { role: "assistant", text: `[Imported ${item.type} history]\n${JSON.stringify(item, null, 2)}`, createdAt: item.updatedAt, attachments: [] } });
      archivedItems++;
    }
  }
  for (const message of messages) if (!seenMessages.has(message)) entries.push({ message });
  for (const plan of ir.plans || []) if (!seenPlans.has(plan.planId)) entries.push({ plan });
  for (const activity of ir.activities || []) {
    entries.push({ message: { role: "assistant", text: `[Imported activity: ${activity.kind}]\n${activity.summary}\n${JSON.stringify(activity.payload || {})}`, createdAt: activity.createdAt, attachments: [] } });
    archivedItems++;
  }
  if (archivedItems) warnings.push({ code: "t3_history_archived_as_text", message: `${archivedItems} rich history items or activities preserved as labelled text; executable/provider references are not rebound.` });
  return entries;
}

function writeIrToT3V2({ ir, dbPath, intent, newThreadId = null, backup = true, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, lockRetries = DEFAULT_LOCK_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS }) {
  validateIr(ir);
  if (intent.copyRuntime) throw new Error("Native T3 v2 imports are portable history copies; --copy-runtime is unsupported. Omit it to create a fresh provider session.");
  assertOffline(dbPath);
  const preflight = new DatabaseSync(dbPath, { readonly: true });
  try { inspectT3Storage(preflight, { write: true }); validateV2Projection(preflight, { write: true }); } finally { preflight.close(); }
  const retryConfig = { retries: lockRetries, retryDelayMs };
  const backupPath = backup ? withLockRetries(() => backupSqlite(dbPath, busyTimeoutMs), retryConfig) : null;
  const now = new Date().toISOString();
  const threadId = newThreadId || crypto.randomUUID();
  const createdAt = intent.preserveTimestamps ? iso(ir.thread.createdAt, now) : now;
  const updatedAt = intent.preserveTimestamps ? iso(ir.thread.updatedAt, now) : now;
  const title = String(intent.title || ir.thread.title || "Imported thread").trim();
  const workspaceRoot = path.resolve(intent.workspaceRoot || ir.thread.workspaceRoot || process.cwd());
  const provenance = { sourceHarness: ir.source.harness, sourceId: ir.source.sourceId, importedAt: now, intent: intent.type };
  if (!title || typeof threadId !== "string" || threadId.trim() !== threadId || !threadId) throw new Error("T3 title and thread ID must be nonempty strings.");
  const assets = prepareAttachments({ ir, targetDbPath: dbPath });
  const warnings = [...(ir.warnings || []), ...assets.warnings];
  if (assets.count) warnings.push({ code: "t3_attachment_history_not_replayed", message: "Attachments were copied into T3 storage. Stock T3 does not automatically replay historical attachment bytes to the next provider session." });
  let projectId, modelSelection, counts;
  try {
    const entries = portableEntries(ir, assets.messages, warnings);
    withLockRetries(() => {
      assertOffline(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`PRAGMA busy_timeout=${Number(busyTimeoutMs)}; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE`);
        inspectT3Storage(db, { write: true });
        validateV2Projection(db, { write: true });
        if (db.prepare("SELECT 1 FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? UNION ALL SELECT 1 FROM projection_threads WHERE thread_id=?").get(threadId, threadId)) throw new Error(`T3 thread already exists: ${threadId}`);
        let project = intent.projectId
          ? db.prepare("SELECT * FROM projection_projects WHERE project_id=? AND deleted_at IS NULL").get(intent.projectId)
          : db.prepare("SELECT * FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1").get(workspaceRoot);
        if (intent.projectId && !project) throw new Error(`Target T3 project not found: ${intent.projectId}`);
        projectId = project?.project_id || crypto.randomUUID();
        modelSelection = selection(ir, intent, project);
        if (!project) {
          const payload = { projectId, title: String(ir.project?.title || path.basename(workspaceRoot) || workspaceRoot).trim(), workspaceRoot, defaultModelSelection: modelSelection, scripts: [], createdAt, updatedAt: now };
          appendEvent(db, "project.created", payload, now);
          insert(db, "projection_projects", { project_id: projectId, title: payload.title, workspace_root: workspaceRoot, default_model_selection_json: JSON.stringify(modelSelection), scripts_json: "[]", created_at: createdAt, updated_at: now, deleted_at: null });
        }
        const thread = {
          createdBy: "system", creationSource: "server", id: threadId, projectId, title,
          providerInstanceId: modelSelection.instanceId, modelSelection,
          runtimeMode: "approval-required", interactionMode: ["default", "plan"].includes(ir.thread.interactionMode) ? ir.thread.interactionMode : "default",
          branch: null, worktreePath: null, activeProviderThreadId: null,
          // Stock T3 uses this marker to seed a new provider with runless history.
          historyOrigin: "v1_import", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
          createdAt, updatedAt, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
        };
        appendEvent(db, "thread.created", thread, updatedAt, provenance);
        counts = { messages: 0, plans: 0, turnItems: 0, attachments: assets.count, runs: 0 };
        const baseItem = (timestamp) => ({ id: crypto.randomUUID(), threadId, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: ++counts.turnItems, status: "completed", title: null, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp });
        for (const entry of entries) {
          if (entry.plan) {
            const plan = entry.plan;
            const id = crypto.randomUUID();
            const timestamp = intent.preserveTimestamps ? iso(plan.updatedAt || plan.createdAt, updatedAt) : now;
            appendEvent(db, "plan.updated", { id, threadId, runId: null, nodeId: `imported-plan:${id}`, kind: "proposed_plan", status: "completed", markdown: plan.markdown || "" }, updatedAt);
            appendEvent(db, "turn-item.updated", { ...baseItem(timestamp), type: "proposed_plan", planId: id, markdown: plan.markdown || "", streaming: false }, updatedAt);
            counts.plans++;
          } else {
            const source = entry.message;
            let text = source.text || extractPlainTextFromBlocks(source.content);
            const richBlocks = (source.content || []).filter((block) => block.type !== "text");
            if (richBlocks.length) {
              text += `\n[Imported message content]\n${JSON.stringify(richBlocks, null, 2)}`;
              if (!warnings.some((warning) => warning.code === "t3_message_content_archived")) warnings.push({ code: "t3_message_content_archived", message: "Non-text message blocks were preserved as labelled historical text." });
            }
            const role = source.role === "assistant" ? "assistant" : "user";
            if (!["user", "assistant"].includes(source.role)) text = `[Imported ${source.role} message]\n${text}`;
            if (!text && !source.attachments?.length) continue;
            const timestamp = intent.preserveTimestamps ? iso(source.createdAt, createdAt) : now;
            const message = { id: crypto.randomUUID(), threadId, runId: null, nodeId: null, role, text, attachments: source.attachments || [], streaming: false, createdBy: role === "user" ? "user" : "agent", creationSource: "server", createdAt: timestamp, updatedAt: intent.preserveTimestamps ? iso(source.updatedAt, timestamp) : now };
            appendEvent(db, "message.updated", message, updatedAt);
            appendEvent(db, "turn-item.updated", { ...baseItem(message.updatedAt), startedAt: message.createdAt, type: `${role}_message`, messageId: message.id, text, attachments: message.attachments, ...(role === "user" ? { createdBy: "user", creationSource: "server", inputIntent: "turn_start" } : { streaming: false }) }, updatedAt);
            counts.messages++;
          }
        }
        db.prepare("INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,?,?) ON CONFLICT(projection_name) DO UPDATE SET schema_version=2,last_sequence=excluded.last_sequence,updated_at=excluded.updated_at").run(db.prepare("SELECT max(sequence) AS n FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'").get().n, now);
        assets.publish();
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        assets.rollback();
        throw error;
      } finally { db.close(); }
    }, retryConfig);
  } finally { assets.cleanup(); }
  if (ir.messages.some((m) => m.isStreaming)) warnings.push({ code: "t3_streaming_snapshot", message: "In-progress message text was imported as a completed snapshot." });
  if (ir.messages.some((m) => !["user", "assistant"].includes(m.role))) warnings.push({ code: "t3_imported_role_label", message: "System/developer messages were preserved as labelled historical user text." });
  return createOperationReceipt({ operation: intent.type, source: { harness: ir.source.harness, id: ir.source.sourceId, path: ir.source.sourcePath }, target: { harness: "t3", path: dbPath, projectId }, createdIds: { threadId }, counts, backupPath, warnings, details: { storage: "orchestration_v2", profile: "v0.1.0", threadTitle: title, modelSelection, provenance, portable: true } });
}

module.exports = { writeIrToT3V2 };
