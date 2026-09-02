const { parseAntigravityConversation } = require("../../antigravity");
const { createIrFromTranscriptSession } = require("../../ir");

function readAntigravityConversationAsIr({ root, target }) {
  const session = parseAntigravityConversation({ root, target });
  return createIrFromTranscriptSession({
    harness: "antigravity",
    sessionId: session.conversationId,
    filePath: session.filePath,
    transcript: session.transcript,
    originalCwd: session.originalCwd,
    model: session.model,
    provider: "antigravity",
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    warnings: session.warnings,
    extensions: session.extensions,
  });
}

module.exports = {
  readAntigravityConversationAsIr,
};
