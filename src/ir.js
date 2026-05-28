const crypto = require("crypto");

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "assistant" || normalized === "user" || normalized === "system" || normalized === "developer") {
    return normalized;
  }
  return "user";
}

function normalizeContentBlocks(content, fallbackText = "") {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((block) => {
      if (!block || typeof block !== "object") {
        return { type: "opaque-unknown", value: block };
      }
      if (block.type === "text" && typeof block.text === "string") {
        return { type: "text", text: block.text };
      }
      if (block.type === "reasoning-summary" && typeof block.text === "string") {
        return { type: "reasoning-summary", text: block.text };
      }
      if (block.type === "tool-call") {
        return {
          type: "tool-call",
          toolName: block.toolName || block.name || "tool_call",
          toolCallId: block.toolCallId || block.callId || crypto.randomUUID(),
          input: block.input || {},
        };
      }
      if (block.type === "tool-result") {
        return {
          type: "tool-result",
          toolCallId: block.toolCallId || block.callId || crypto.randomUUID(),
          output: block.output || "",
          isError: block.isError === true,
        };
      }
      if (block.type === "image-reference") {
        return {
          type: "image-reference",
          url: block.url || "",
        };
      }
      return { type: "opaque-unknown", value: block };
    });
  }

  const text = String(fallbackText || "").trim();
  return text ? [{ type: "text", text }] : [];
}

function extractPlainTextFromBlocks(blocks = []) {
  return blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "text" || block.type === "reasoning-summary") {
        return typeof block.text === "string" ? [block.text] : [];
      }
      if (block.type === "tool-result") {
        return typeof block.output === "string" ? [block.output] : [];
      }
      return [];
    })
    .join("\n\n")
    .trim();
}

function deriveTitleFromMessages(messages, fallback) {
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser ? extractPlainTextFromBlocks(firstUser.content) : "";
  return (text || fallback || "Imported thread").trim().slice(0, 120);
}

function normalizeMessage(message, index = 0) {
  const role = normalizeRole(message.role);
  const createdAt = message.createdAt || message.timestamp || new Date().toISOString();
  const updatedAt = message.updatedAt || createdAt;
  const content = normalizeContentBlocks(message.content, message.text);

  return {
    messageId: message.messageId || message.id || `${role}:msg_${crypto.randomBytes(12).toString("hex")}`,
    role,
    content,
    text: extractPlainTextFromBlocks(content),
    createdAt,
    updatedAt,
    turnId: message.turnId || null,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    isStreaming: message.isStreaming === true,
    phase: message.phase || null,
    metadata: message.metadata && typeof message.metadata === "object" ? message.metadata : {},
  };
}

function normalizeTurn(turn) {
  return {
    turnId: turn.turnId,
    pendingMessageId: turn.pendingMessageId || null,
    assistantMessageId: turn.assistantMessageId || null,
    requestedAt: turn.requestedAt || null,
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null,
    state: turn.state || "completed",
    checkpoint: turn.checkpoint || null,
    metadata: turn.metadata && typeof turn.metadata === "object" ? turn.metadata : {},
  };
}

function normalizeActivity(activity) {
  return {
    activityId: activity.activityId || crypto.randomUUID(),
    turnId: activity.turnId || null,
    tone: activity.tone || "info",
    kind: activity.kind || "note",
    summary: activity.summary || "",
    payload: activity.payload && typeof activity.payload === "object" ? activity.payload : parseMaybeJson(activity.payloadJson) || {},
    createdAt: activity.createdAt || new Date().toISOString(),
    sequence: activity.sequence ?? null,
  };
}

function normalizePlan(plan) {
  return {
    planId: plan.planId || crypto.randomUUID(),
    turnId: plan.turnId || null,
    markdown: plan.markdown || plan.planMarkdown || "",
    createdAt: plan.createdAt || new Date().toISOString(),
    updatedAt: plan.updatedAt || plan.createdAt || new Date().toISOString(),
    implementedAt: plan.implementedAt || null,
    implementationThreadId: plan.implementationThreadId || null,
  };
}

function mapMessagesToTurns(messages) {
  const normalizedMessages = [];
  const turns = [];
  let currentTurn = null;

  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (normalized.role === "user") {
      currentTurn = {
        turnId: crypto.randomUUID(),
        pendingMessageId: normalized.messageId,
        assistantMessageId: null,
        requestedAt: normalized.createdAt,
        startedAt: null,
        completedAt: normalized.createdAt,
        state: "completed",
      };
      normalizedMessages.push({
        ...normalized,
        turnId: null,
      });
      turns.push(currentTurn);
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        turnId: crypto.randomUUID(),
        pendingMessageId: null,
        assistantMessageId: null,
        requestedAt: normalized.createdAt,
        startedAt: normalized.createdAt,
        completedAt: normalized.createdAt,
        state: "completed",
      };
      turns.push(currentTurn);
    }

    if (!currentTurn.startedAt) currentTurn.startedAt = normalized.createdAt;
    currentTurn.assistantMessageId = normalized.messageId;
    currentTurn.completedAt = normalized.updatedAt;
    normalizedMessages.push({
      ...normalized,
      turnId: currentTurn.turnId,
    });
  }

  return {
    messages: normalizedMessages,
    turns: turns.map(normalizeTurn),
  };
}

function createThreadbridgeIr(input) {
  const normalizedMessages = Array.isArray(input.messages)
    ? input.messages.map((message, index) => normalizeMessage(message, index))
    : [];
  const normalizedTurns = Array.isArray(input.turns) ? input.turns.map(normalizeTurn) : [];
  const normalizedActivities = Array.isArray(input.activities) ? input.activities.map(normalizeActivity) : [];
  const normalizedPlans = Array.isArray(input.plans) ? input.plans.map(normalizePlan) : [];

  const ir = {
    schemaVersion: input.schemaVersion || "1.0",
    source: {
      harness: input.source?.harness || "unknown",
      version: input.source?.version || null,
      sourceId: input.source?.sourceId || null,
      sourcePath: input.source?.sourcePath || null,
      extractedAt: input.source?.extractedAt || new Date().toISOString(),
    },
    thread: {
      threadId: input.thread?.threadId || null,
      title: input.thread?.title || deriveTitleFromMessages(normalizedMessages, input.source?.sourceId),
      createdAt: input.thread?.createdAt || normalizedMessages[0]?.createdAt || new Date().toISOString(),
      updatedAt: input.thread?.updatedAt || normalizedMessages[normalizedMessages.length - 1]?.updatedAt || new Date().toISOString(),
      workspaceRoot: input.thread?.workspaceRoot || process.cwd(),
      branch: input.thread?.branch || null,
      worktreePath: input.thread?.worktreePath || null,
      runtimeMode: input.thread?.runtimeMode || "approval-required",
      interactionMode: input.thread?.interactionMode || "default",
      modelSelection: input.thread?.modelSelection || null,
    },
    project: {
      projectId: input.project?.projectId || null,
      title: input.project?.title || null,
      workspaceRoot: input.project?.workspaceRoot || input.thread?.workspaceRoot || process.cwd(),
      defaults: input.project?.defaults || {},
    },
    messages: normalizedMessages,
    turns: normalizedTurns,
    activities: normalizedActivities,
    plans: normalizedPlans,
    runtime: input.runtime || null,
    lineage: input.lineage || {},
    capabilities: {
      supportsLosslessClone: input.capabilities?.supportsLosslessClone === true,
      supportsRuntimeRebind: input.capabilities?.supportsRuntimeRebind === true,
      supportsTranscriptOnlyWrite: input.capabilities?.supportsTranscriptOnlyWrite !== false,
      containsOpaqueData: input.capabilities?.containsOpaqueData === true,
    },
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    extensions: input.extensions && typeof input.extensions === "object" ? input.extensions : {},
  };

  return ir;
}

function createIrFromTranscriptSession(session) {
  const transcriptMessages = (session.transcript || []).map((entry) => ({
    role: entry.role,
    text: entry.text,
    content: entry.content,
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
    phase: entry.phase || null,
    metadata: entry.metadata || {},
  }));
  const { messages, turns } = mapMessagesToTurns(transcriptMessages);

  return createThreadbridgeIr({
    source: {
      harness: session.harness,
      version: session.version || null,
      sourceId: session.sessionId || session.threadId || null,
      sourcePath: session.filePath || session.sourcePath || null,
      extractedAt: new Date().toISOString(),
    },
    thread: {
      threadId: session.threadId || null,
      title: session.title || deriveTitleFromMessages(messages, session.sessionId || session.threadId),
      createdAt: session.createdAt || messages[0]?.createdAt || new Date().toISOString(),
      updatedAt: session.updatedAt || messages[messages.length - 1]?.updatedAt || new Date().toISOString(),
      workspaceRoot: session.originalCwd || session.workspaceRoot || process.cwd(),
      runtimeMode: session.runtimeMode || "approval-required",
      interactionMode: session.interactionMode || "default",
      modelSelection: session.model
        ? {
            provider: session.provider || session.harness,
            model: session.model,
            ...(session.reasoningEffort ? { options: { reasoningEffort: session.reasoningEffort } } : {}),
          }
        : null,
    },
    project: {
      projectId: session.projectId || null,
      title: session.projectTitle || null,
      workspaceRoot: session.originalCwd || session.workspaceRoot || process.cwd(),
    },
    messages,
    turns,
    activities: session.activities || [],
    plans: session.plans || [],
    runtime: session.runtime || null,
    lineage: session.lineage || {},
    capabilities: {
      supportsLosslessClone: false,
      supportsRuntimeRebind: false,
      supportsTranscriptOnlyWrite: true,
      containsOpaqueData: false,
    },
    warnings: session.warnings || [],
    extensions: session.extensions || {},
  });
}

function validateIr(ir) {
  if (!ir || typeof ir !== "object") {
    throw new Error("Invalid ThreadbridgeIR: expected object.");
  }
  if (!ir.source || !ir.thread || !Array.isArray(ir.messages)) {
    throw new Error("Invalid ThreadbridgeIR: missing source, thread, or messages.");
  }
  return ir;
}

function getTranscriptEntriesFromIr(ir, { includeSystem = false } = {}) {
  validateIr(ir);
  return ir.messages
    .filter((message) => includeSystem || (message.role !== "system" && message.role !== "developer"))
    .map((message) => ({
      role: message.role === "developer" ? "system" : message.role,
      text: message.text || extractPlainTextFromBlocks(message.content),
      timestamp: message.createdAt,
      phase: message.phase || null,
      content: message.content,
    }));
}

module.exports = {
  createThreadbridgeIr,
  createIrFromTranscriptSession,
  deriveTitleFromMessages,
  extractPlainTextFromBlocks,
  getTranscriptEntriesFromIr,
  mapMessagesToTurns,
  normalizeContentBlocks,
  normalizeRole,
  parseMaybeJson,
  validateIr,
};
