const { normalizeWriteIntent } = require("../intents");
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

function convertThread(args) {
  const intent = normalizeWriteIntent(args.intent || "transcript-only-conversion", args);

  if (args.sourceHarness === "t3") {
    const ir = readT3ThreadAsIr({
      dbPath: args.dbPath,
      target: args.target,
      includeRuntime: intent.copyRuntime,
    });
    if (args.targetHarness === "codex") {
      return writeIrToCodex({ ir, targetRoot: args.root, sessionId: args.newSessionId });
    }
    if (args.targetHarness === "claude") {
      return writeIrToClaude({ ir, projectPath: args.projectPath });
    }
    if (args.targetHarness === "cursor") {
      return writeIrToCursor({ ir, chatId: args.newChatId });
    }
    if (args.targetHarness === "opencode") {
      return writeIrToOpenCode({ ir, targetRoot: args.opencodeRoot });
    }
  }

  if (args.targetHarness === "t3") {
    let ir;
    if (args.sourceHarness === "codex") {
      ir = readCodexSessionAsIr({
        root: args.root,
        target: args.target,
        includeBoilerplate: args.includeBoilerplate,
      });
    } else if (args.sourceHarness === "claude") {
      ir = readClaudeSessionAsIr({
        projectPath: args.projectPath,
        target: args.target,
      });
    } else if (args.sourceHarness === "opencode") {
      ir = readOpenCodeSessionAsIr({
        root: args.opencodeRoot,
        target: args.target,
      });
    } else if (args.sourceHarness === "cursor") {
      ir = readCursorChatAsIr({
        target: args.target,
      });
    }
    return writeIrToT3({
      ir,
      dbPath: args.dbPath,
      intent: intent.type,
      options: intent,
      backup: args.backup,
      busyTimeoutMs: args.busyTimeoutMs,
      lockRetries: args.lockRetries,
      retryDelayMs: args.retryDelayMs,
    });
  }

  throw new Error(`Unsupported conversion: ${args.sourceHarness} -> ${args.targetHarness}`);
}

module.exports = {
  convertThread,
};
