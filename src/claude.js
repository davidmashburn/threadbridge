const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");

function sanitizeProjectPath(projectPath) {
  const resolved = path.resolve(projectPath).replace(/[:]/g, "-").replace(/\//g, "-");
  return resolved.replace(/^-+/, "").replace(/-+$/, "");
}

function walkSessions(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(path.join(rootDir, entry.name));
    }
  }

  return results.sort();
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", raw: line };
      }
    });
}

function extractTextFromBlocks(blocks = []) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "output" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }
  return parts.join("\n").trim();
}

function parseClaudeSession(filePath, includeHidden = false) {
  const records = readJsonl(filePath);
  const transcript = [];
  let sessionMeta = null;
  let currentWorkingDir = process.cwd();

  for (const record of records) {
    if (record.type === "session_transcript" && record.payload) {
      sessionMeta = record.payload;
      continue;
    }
    if (record.type === "project_context" && record.payload?.workingDirectory) {
      currentWorkingDir = record.payload.workingDirectory;
      continue;
    }
    if (record.type === "message" && record.message) {
      const msg = record.message;
      if (msg.role === "user" || msg.role === "assistant") {
        const text = extractTextFromBlocks(msg.contentblocks || msg.content);
        if (!text) continue;
        transcript.push({
          role: msg.role,
          text,
          timestamp: record.timestamp,
        });
      }
    }
  }

  return {
    filePath,
    sessionId: path.basename(filePath, ".jsonl"),
    meta: sessionMeta,
    workingDir: currentWorkingDir,
    transcript,
  };
}

function summarizeClaudeSession(filePath) {
  const session = parseClaudeSession(filePath);
  const userMessages = session.transcript.filter((m) => m.role === "user");
  const firstPrompt = userMessages[0]?.text || "";
  return {
    filePath: session.filePath,
    id: session.sessionId,
    workingDir: session.workingDir,
    startedAt: session.meta?.timestamp || fs.statSync(filePath).mtime.toISOString(),
    messageCount: session.transcript.length,
    prompt: firstPrompt.slice(0, 220),
  };
}

function listClaudeSessions(projectPath, { limit = 10 } = {}) {
  const root = fs.existsSync(projectPath) ? projectPath : path.join(DEFAULT_CLAUDE_ROOT, sanitizeProjectPath(projectPath));
  if (!fs.existsSync(root)) {
    return [];
  }

  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(root, e.name));

  return files
    .map((f) => summarizeClaudeSession(f))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

function resolveClaudeSession(projectPath, sessionTarget) {
  const root = fs.existsSync(projectPath) ? projectPath : path.join(DEFAULT_CLAUDE_ROOT, sanitizeProjectPath(projectPath));

  if (!fs.existsSync(root)) {
    throw new Error(`No Claude sessions found for project: ${projectPath}`);
  }

  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(root, e.name));

  if (files.length === 0) {
    throw new Error(`No Claude sessions found for project: ${projectPath}`);
  }

  const summaries = files.map((f) => summarizeClaudeSession(f))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (!sessionTarget || sessionTarget === "last") {
    return summaries[0].filePath;
  }

  if (fs.existsSync(sessionTarget)) {
    return sessionTarget;
  }

  const exact = summaries.find((s) => s.id === sessionTarget);
  if (exact) return exact.filePath;

  const partial = summaries.filter(
    (s) => s.id.includes(sessionTarget) || s.filePath.includes(sessionTarget),
  );
  if (partial.length === 1) return partial[0].filePath;
  if (partial.length > 1) {
    throw new Error(`Ambiguous Claude session target: ${sessionTarget}`);
  }

  throw new Error(`No Claude session matching: ${sessionTarget}`);
}

function parseClaudeSessionWithContext(filePath, includeHidden = false) {
  const records = readJsonl(filePath);
  const transcript = [];
  let sessionMeta = null;
  let turnContext = null;
  let model = "claude-sonnet-4-20250514";

  for (const record of records) {
    if (record.type === "session_transcript" && record.payload) {
      sessionMeta = record.payload;
      continue;
    }
    if (record.type === "model_context" && record.payload?.model) {
      model = record.payload.model;
      continue;
    }
    if (record.type === "project_context" && record.payload) {
      turnContext = record.payload;
      continue;
    }
    if (record.type === "message" && record.message) {
      const msg = record.message;
      if (msg.role === "user" || msg.role === "assistant") {
        const text = extractTextFromBlocks(msg.contentblocks || msg.content);
        if (!text) continue;
        transcript.push({
          role: msg.role,
          text,
          timestamp: record.timestamp,
        });
      }
    }
  }

  return {
    filePath,
    sessionId: path.basename(filePath, ".jsonl"),
    meta: sessionMeta,
    turnContext,
    model,
    originalCwd: turnContext?.workingDirectory || process.cwd(),
    transcript,
  };
}

function formatClaudeRelativePathFromDate(isoTimestamp, sessionId) {
  const date = new Date(isoTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(year, month, day, `${sessionId}.jsonl`);
}

function exportT3ToClaudeFormat({
  t3Thread,
  targetRoot,
  projectPath,
}) {
  const now = new Date().toISOString();
  const sessionId = t3Thread.threadId || `tb-${crypto.randomUUID().slice(0, 8)}`;
  const model = t3Thread.modelSelection?.model || "claude-sonnet-4-20250514";

  const lines = [];
  lines.push({
    type: "session_transcript",
    payload: {
      id: sessionId,
      project: path.basename(projectPath || t3Thread.workspaceRoot || process.cwd()),
      timestamp: t3Thread.createdAt || now,
    },
    timestamp: now,
  });
  lines.push({
    type: "project_context",
    payload: {
      workingDirectory: t3Thread.workspaceRoot || process.cwd(),
    },
    timestamp: now,
  });
  lines.push({
    type: "model_context",
    payload: {
      model,
    },
    timestamp: now,
  });

  for (const message of t3Thread.messages) {
    lines.push({
      type: "message",
      message: {
        role: message.role,
        contentblocks: [
          { type: "text", text: message.text },
        ],
      },
      timestamp: message.createdAt || now,
    });
  }

  const sanitized = sanitizeProjectPath(projectPath || t3Thread.workspaceRoot || process.cwd());
  const relativePath = formatClaudeRelativePathFromDate(now, sessionId);
  const outputPath = path.join(DEFAULT_CLAUDE_ROOT, sanitized, "sessions", relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

  return {
    sessionId,
    outputPath,
    messageCount: t3Thread.messages.length,
  };
}

function copyClaudeSession({
  sourceRoot,
  targetRoot,
  sourceProject,
  targetProject,
  newSessionId = null,
}) {
  const sourceFile = resolveClaudeSession(sourceProject || sourceRoot, sourceRoot);
  const records = readJsonl(sourceFile);
  const summary = summarizeClaudeSession(sourceFile);
  const sessionId = newSessionId || `tb-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();

  const rewritten = records.map((record) => {
    if (record.type === "session_transcript" && record.payload) {
      return {
        ...record,
        payload: {
          ...record.payload,
          id: sessionId,
          timestamp: now,
        },
        timestamp: now,
      };
    }
    return record;
  });

  const targetPath = path.join(DEFAULT_CLAUDE_ROOT, sanitizeProjectPath(targetProject || targetRoot));
  const relativePath = formatClaudeRelativePathFromDate(now, sessionId);
  const targetFile = path.join(targetPath, "sessions", relativePath);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, rewritten.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  return {
    sourceFile,
    targetFile,
    sourceSessionId: summary.id,
    sessionId,
  };
}

module.exports = {
  DEFAULT_CLAUDE_ROOT,
  sanitizeProjectPath,
  listClaudeSessions,
  resolveClaudeSession,
  parseClaudeSession,
  parseClaudeSessionWithContext,
  exportT3ToClaudeFormat,
  copyClaudeSession,
};