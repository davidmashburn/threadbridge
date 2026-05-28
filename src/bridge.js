const { createIrFromTranscriptSession } = require("./ir");
const { readT3ThreadAsIr } = require("./adapters/t3/read");
const { writeIrToT3 } = require("./adapters/t3/write");
const { writeIrToCodex } = require("./adapters/codex/write");

function importCodexIntoT3({
  codexSession,
  dbPath,
  title = null,
  projectId = null,
  workspaceRoot = null,
  backup = true,
  busyTimeoutMs,
  lockRetries,
  retryDelayMs,
}) {
  const ir = createIrFromTranscriptSession({
    harness: codexSession.provider || codexSession.harness || "codex",
    sessionId: codexSession.sessionId,
    filePath: codexSession.filePath,
    transcript: codexSession.transcript,
    originalCwd: workspaceRoot || codexSession.originalCwd,
    model: codexSession.model,
    provider: codexSession.provider || codexSession.harness || "codex",
    reasoningEffort: codexSession.reasoningEffort || null,
    interactionMode: codexSession.interactionMode || "default",
    runtimeMode: codexSession.runtimeMode || "approval-required",
    title: title || codexSession.title || codexSession.sessionId,
  });

  const receipt = writeIrToT3({
    ir,
    dbPath,
    intent: "import-session",
    options: {
      title,
      projectId,
      workspaceRoot,
    },
    backup,
    busyTimeoutMs,
    lockRetries,
    retryDelayMs,
  });

  return {
    dbPath,
    backupPath: receipt.backupPath,
    threadId: receipt.createdIds.threadId,
    threadTitle: receipt.details.threadTitle,
    messageCount: receipt.counts.messages || 0,
    turnCount: receipt.counts.turns || 0,
  };
}

function buildT3Export(threadId, dbPath) {
  const ir = readT3ThreadAsIr({
    dbPath,
    target: threadId,
    includeRuntime: false,
  });

  return {
    threadId: ir.thread.threadId,
    title: ir.thread.title,
    createdAt: ir.thread.createdAt,
    updatedAt: ir.thread.updatedAt,
    workspaceRoot: ir.thread.workspaceRoot,
    modelSelection: ir.thread.modelSelection,
    messages: ir.messages.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
  };
}

function generateCodexSessionFromT3({
  t3Thread,
  targetRoot,
  sessionId = null,
}) {
  const ir = createIrFromTranscriptSession({
    harness: "t3",
    threadId: t3Thread.threadId,
    title: t3Thread.title,
    transcript: (t3Thread.messages || []).map((message) => ({
      role: message.role,
      text: message.text,
      timestamp: message.createdAt,
    })),
    originalCwd: t3Thread.workspaceRoot,
    model: t3Thread.modelSelection?.model || "gpt-5.4",
    provider: t3Thread.modelSelection?.provider || "t3",
  });
  ir.thread.threadId = t3Thread.threadId;
  ir.thread.createdAt = t3Thread.createdAt;
  ir.thread.updatedAt = t3Thread.updatedAt;
  ir.thread.modelSelection = t3Thread.modelSelection || null;

  const receipt = writeIrToCodex({
    ir,
    targetRoot,
    sessionId,
  });

  return {
    sessionId: receipt.createdIds.sessionId,
    outputPath: receipt.details.outputPath,
    messageCount: receipt.counts.messages || 0,
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
