const { createOperationReceipt } = require("../../receipts");
const { validateIr } = require("../../ir");
const { generateCursorSessionFromT3 } = require("../../cursor");

function writeIrToCursor({ ir, chatId = null }) {
  validateIr(ir);
  const t3Like = {
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

  const result = generateCursorSessionFromT3({
    t3Thread: t3Like,
    chatId,
  });

  return createOperationReceipt({
    operation: "export-session",
    source: {
      harness: ir.source.harness,
      id: ir.source.sourceId,
      path: ir.source.sourcePath,
    },
    target: {
      harness: "cursor",
      path: result.chatDir,
    },
    createdIds: {
      chatId: result.chatId,
    },
    counts: {
      messages: result.messageCount,
    },
    warnings: ir.warnings,
    details: result,
  });
}

module.exports = {
  writeIrToCursor,
};
