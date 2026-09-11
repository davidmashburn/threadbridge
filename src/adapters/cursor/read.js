const { parseCursorChat, resolveCursorChat } = require("../../cursor");
const { createIrFromTranscriptSession } = require("../../ir");

function readCursorChatAsIr({ target, includeToolCalls = true }) {
  const chatId = resolveCursorChat(target);
  const chat = parseCursorChat(chatId, { includeToolCalls });
  return createIrFromTranscriptSession({
    warnings: chat.warnings,
    harness: "cursor",
    sessionId: chat.chatId,
    transcript: chat.transcript,
    originalCwd: process.cwd(),
    model: "gpt-5",
    provider: "cursor",
    title: chat.title || chat.chatId,
  });
}

module.exports = {
  readCursorChatAsIr,
};
