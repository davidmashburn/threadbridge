const { parseCodexSession, resolveCodexSessionTarget } = require("../../codex");
const { createIrFromTranscriptSession } = require("../../ir");

function readCodexSessionAsIr({ root, target, includeBoilerplate = false }) {
  const sourceFile = resolveCodexSessionTarget({ root, target, includeBoilerplate });
  const session = parseCodexSession(sourceFile, includeBoilerplate);
  return createIrFromTranscriptSession({
    harness: "codex",
    sessionId: session.sessionId,
    filePath: session.filePath,
    transcript: session.transcript,
    originalCwd: session.originalCwd,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    interactionMode: session.interactionMode,
    runtimeMode: session.runtimeMode,
    title: session.transcript.find((entry) => entry.role === "user")?.text?.slice(0, 120) || session.sessionId,
  });
}

module.exports = {
  readCodexSessionAsIr,
};
