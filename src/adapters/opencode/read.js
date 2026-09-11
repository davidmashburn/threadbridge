const { parseOpenCodeSession, resolveOpenCodeSessionTarget } = require("../../opencode");
const { createIrFromTranscriptSession } = require("../../ir");

function readOpenCodeSessionAsIr({ root, target, includeToolCalls = true }) {
  const sourceFile = resolveOpenCodeSessionTarget({ root, target });
  const session = parseOpenCodeSession(sourceFile, { includeToolCalls });
  return createIrFromTranscriptSession({
    warnings: session.warnings,
    harness: "opencode",
    sessionId: session.sessionId,
    filePath: sourceFile,
    transcript: session.transcript,
    originalCwd: session.originalCwd,
    model: session.model || "kimi-k2.5-free",
    provider: "opencode",
    projectId: session.projectId,
    title: session.title || session.sessionId,
  });
}

module.exports = {
  readOpenCodeSessionAsIr,
};
