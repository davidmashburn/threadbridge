const { parseCursorChat, resolveCursorChat } = require("../../cursor");
const { createIrFromTranscriptSession } = require("../../ir");

function readCursorChatAsIr({ target }) {
  const chatId = resolveCursorChat(target);
  const chat = parseCursorChat(chatId);
  return createIrFromTranscriptSession({
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
