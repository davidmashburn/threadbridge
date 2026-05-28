const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createOperationReceipt } = require("../../receipts");
const { getTranscriptEntriesFromIr, validateIr } = require("../../ir");

function generateSessionId() {
  return `ses_${crypto.randomBytes(18).toString("hex")}`;
}

function generateMessageId() {
  return `msg_${crypto.randomBytes(18).toString("hex")}`;
}

function writeIrToOpenCode({ ir, targetRoot, sessionId = null }) {
  validateIr(ir);
  const now = Date.now();
  const id = sessionId || generateSessionId();
  const projectId = ir.project.projectId || crypto.createHash("sha1").update(ir.thread.workspaceRoot || process.cwd()).digest("hex").slice(0, 40);
  const title = ir.thread.title || "(imported from threadbridge)";
  const transcript = getTranscriptEntriesFromIr(ir);

  const session = {
    id,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "imported-session",
    version: "1.1.40",
    projectID: projectId,
    directory: ir.thread.workspaceRoot || process.cwd(),
    title,
    time: {
      created: now,
      updated: now,
    },
    summary: { additions: 0, deletions: 0, files: 0 },
  };

  const projectDir = path.join(targetRoot, "session", projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, `${id}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  const messageDir = path.join(targetRoot, "message", id);
  fs.mkdirSync(messageDir, { recursive: true });

  let msgIndex = 0;
  for (const msg of transcript) {
    msgIndex += 1;
    const msgId = generateMessageId();
    const msgTime = new Date(new Date(ir.thread.createdAt || Date.now()).getTime() + msgIndex * 1000);
    const message = {
      id: msgId,
      sessionID: id,
      role: msg.role,
      time: { created: msgTime.getTime(), completed: msgTime.getTime() },
      parentID: null,
      modelID: ir.thread.modelSelection?.model || "kimi-k2.5-free",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    };
    fs.writeFileSync(path.join(messageDir, `${msgId}.json`), JSON.stringify(message, null, 2));

    const partDir = path.join(targetRoot, "part", msgId);
    fs.mkdirSync(partDir, { recursive: true });
    const partId = `prt_${crypto.randomBytes(18).toString("hex")}`;
    const part = {
      id: partId,
      sessionID: id,
      messageID: msgId,
      type: "text",
      text: msg.text || "",
    };
    fs.writeFileSync(path.join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
  }

  return createOperationReceipt({
    operation: "export-session",
    source: {
      harness: ir.source.harness,
      id: ir.source.sourceId,
      path: ir.source.sourcePath,
    },
    target: {
      harness: "opencode",
      path: sessionPath,
    },
    createdIds: {
      sessionId: id,
    },
    counts: {
      messages: transcript.length,
    },
    warnings: ir.warnings,
    details: {
      sessionPath,
    },
  });
}

module.exports = {
  writeIrToOpenCode,
};
