const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createOperationReceipt } = require("../../receipts");
const { getTranscriptEntriesFromIr, validateIr } = require("../../ir");

function formatCodexRelativePathFromDate(isoTimestamp, sessionId) {
  const date = new Date(isoTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(year, month, day, `${sessionId}.jsonl`);
}

function writeIrToCodex({ ir, targetRoot, sessionId = null }) {
  validateIr(ir);
  const now = new Date().toISOString();
  const id = sessionId || `tb-${crypto.randomUUID()}`;
  const model = ir.thread.modelSelection?.model || "gpt-5.4";
  const reasoningEffort = ir.thread.modelSelection?.options?.reasoningEffort || "medium";
  const cwd = ir.thread.workspaceRoot || process.cwd();
  const transcript = getTranscriptEntriesFromIr(ir);

  const lines = [{
    type: "session_meta",
    payload: {
      id,
      timestamp: ir.thread.createdAt || now,
      cwd,
      originator: "threadbridge",
      source: ir.source.harness,
    },
    timestamp: now,
  }, {
    type: "turn_context",
    payload: {
      cwd,
      model,
      approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write" },
      collaboration_mode: {
        mode: ir.thread.interactionMode || "default",
        settings: { reasoning_effort: reasoningEffort },
      },
    },
    timestamp: now,
  }];

  for (const message of transcript) {
    const phase = message.role === "assistant" ? "final" : undefined;
    lines.push({
      type: "response_item",
      payload: {
        type: "message",
        role: message.role,
        ...(phase ? { phase } : {}),
        content: [{
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.text,
        }],
      },
      timestamp: message.timestamp || now,
    });
  }

  const relativePath = formatCodexRelativePathFromDate(now, id);
  const outputPath = path.join(targetRoot, relativePath);
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
      harness: "codex",
      path: outputPath,
    },
    createdIds: {
      sessionId: id,
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
  writeIrToCodex,
};
