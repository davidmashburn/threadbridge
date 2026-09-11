const { parseClaudeSessionWithContext, resolveClaudeSession } = require("../../claude");
const { createIrFromTranscriptSession } = require("../../ir");

function readClaudeSessionAsIr({ projectPath, target, includeToolCalls = true }) {
  const sourceFile = resolveClaudeSession(projectPath, target);
  const session = parseClaudeSessionWithContext(sourceFile, false, { includeToolCalls });
  return createIrFromTranscriptSession({
    warnings: session.warnings,
    harness: "claude",
    sessionId: session.sessionId,
    filePath: session.filePath,
    transcript: session.transcript,
    originalCwd: session.originalCwd,
    model: session.model || "claude-sonnet-4-20250514",
    provider: "claude",
    title: session.transcript.find((entry) => entry.role === "user")?.text?.slice(0, 120) || session.sessionId,
  });
}

module.exports = {
  readClaudeSessionAsIr,
};
