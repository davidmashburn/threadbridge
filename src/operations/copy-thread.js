const { normalizeWriteIntent } = require("../intents");
const { createOperationReceipt } = require("../receipts");
const { readT3ThreadAsIr } = require("../adapters/t3/read");
const { writeIrToT3 } = require("../adapters/t3/write");
const { readCodexSessionAsIr } = require("../adapters/codex/read");
const { writeIrToCodex } = require("../adapters/codex/write");
const { readClaudeSessionAsIr } = require("../adapters/claude/read");
const { writeIrToClaude } = require("../adapters/claude/write");
const { readOpenCodeSessionAsIr } = require("../adapters/opencode/read");
const { writeIrToOpenCode } = require("../adapters/opencode/write");
const { readCursorChatAsIr } = require("../adapters/cursor/read");
const { writeIrToCursor } = require("../adapters/cursor/write");

function copyThread(args) {
  const intent = normalizeWriteIntent(args.intent || "clone-thread", args);

  if (args.sourceHarness === "t3" && args.targetHarness === "t3") {
    const ir = readT3ThreadAsIr({
      dbPath: args.sourceDbPath,
      target: args.target,
      includeRuntime: intent.copyRuntime,
    });
    return writeIrToT3({
      ir,
      dbPath: args.targetDbPath,
      intent: intent.type,
      options: intent,
      newThreadId: args.newThreadId,
      backup: args.backup,
      busyTimeoutMs: args.busyTimeoutMs,
      lockRetries: args.lockRetries,
      retryDelayMs: args.retryDelayMs,
    });
  }

  if (args.sourceHarness === "codex" && args.targetHarness === "codex") {
    const ir = readCodexSessionAsIr({
      root: args.sourceRoot,
      target: args.target,
      includeBoilerplate: args.includeBoilerplate,
    });
    return writeIrToCodex({
      ir,
      targetRoot: args.targetRoot,
      sessionId: args.newSessionId,
    });
  }

  if (args.sourceHarness === "claude" && args.targetHarness === "claude") {
    const ir = readClaudeSessionAsIr({
      projectPath: args.projectPath,
      target: args.target,
    });
    return writeIrToClaude({
      ir,
      projectPath: args.destProjectPath,
      sessionId: args.newSessionId || null,
    });
  }

  if (args.sourceHarness === "opencode" && args.targetHarness === "opencode") {
    const ir = readOpenCodeSessionAsIr({
      root: args.sourceRoot,
      target: args.target,
    });
    return writeIrToOpenCode({
      ir,
      targetRoot: args.targetRoot,
      sessionId: args.newSessionId || null,
    });
  }

  if (args.sourceHarness === "cursor" && args.targetHarness === "cursor") {
    const ir = readCursorChatAsIr({ target: args.target });
    return writeIrToCursor({ ir, chatId: args.newChatId || null });
  }

  return createOperationReceipt({
    operation: intent.type,
    source: { harness: args.sourceHarness, id: args.target || null },
    target: { harness: args.targetHarness },
    warnings: [`Unsupported copy operation: ${args.sourceHarness} -> ${args.targetHarness}`],
  });
}

module.exports = {
  copyThread,
};
