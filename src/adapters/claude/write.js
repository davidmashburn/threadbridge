const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createOperationReceipt } = require("../../receipts");
const { getTranscriptEntriesFromIr, validateIr } = require("../../ir");
const { DEFAULT_CLAUDE_ROOT, sanitizeProjectPath } = require("../../claude");

function formatClaudeRelativePathFromDate(isoTimestamp, sessionId) {
  const date = new Date(isoTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(year, month, day, `${sessionId}.jsonl`);
}

function writeIrToClaude({ ir, projectPath, sessionId = null }) {
  validateIr(ir);
  const now = new Date().toISOString();
  const resolvedSessionId = sessionId || ir.thread.threadId || `tb-${crypto.randomBytes(4).toString("hex")}`;
  const model = ir.thread.modelSelection?.model || "claude-sonnet-4-20250514";
  const transcript = getTranscriptEntriesFromIr(ir);

  const lines = [{
    type: "session_transcript",
    payload: {
      id: resolvedSessionId,
      project: path.basename(projectPath || ir.thread.workspaceRoot || process.cwd()),
      timestamp: ir.thread.createdAt || now,
    },
    timestamp: now,
  }, {
    type: "project_context",
    payload: {
      workingDirectory: ir.thread.workspaceRoot || process.cwd(),
    },
    timestamp: now,
  }, {
    type: "model_context",
    payload: {
      model,
    },
    timestamp: now,
  }];

  for (const message of transcript) {
    lines.push({
      type: "message",
      message: {
        role: message.role,
        contentblocks: [{ type: "text", text: message.text }],
      },
      timestamp: message.timestamp || now,
    });
  }

  const sanitized = sanitizeProjectPath(projectPath || ir.thread.workspaceRoot || process.cwd());
  const relativePath = formatClaudeRelativePathFromDate(now, resolvedSessionId);
  const outputPath = path.join(DEFAULT_CLAUDE_ROOT, sanitized, "sessions", relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  return createOperationReceipt({
    operation: "export-session",
    source: {
      harness: ir.source.harness,
      id: ir.source.sourceId,
      path: ir.source.sourcePath,
    },
    target: {
      harness: "claude",
      path: outputPath,
    },
    createdIds: {
      sessionId: resolvedSessionId,
    },
    counts: {
      messages: transcript.length,
    },
    warnings: ir.warnings,
    details: {
      outputPath,
    },
  });
}

module.exports = {
  writeIrToClaude,
};
