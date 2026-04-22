const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Codex sessions root does not exist: ${rootDir}`);
  }

  const stack = [rootDir];
  const results = [];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", payload: { line } };
      }
    });
}

function writeJsonl(filePath, records) {
  const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function shorten(text, maxLength = 220) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractTextParts(content = []) {
  const parts = [];
  for (const item of content) {
    if (typeof item?.text === "string") parts.push(item.text);
    else if (typeof item?.output === "string") parts.push(item.output);
    else if (typeof item?.input === "string") parts.push(item.input);
    else if (typeof item?.content === "string") parts.push(item.content);
  }
  return parts.join("\n").trim();
}

function isBoilerplateUserMessage(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<INSTRUCTIONS>") ||
    trimmed.startsWith("<app-context>") ||
    trimmed.startsWith("<permissions instructions>")
  );
}

function summarizeCodexSession(filePath, includeBoilerplate = false) {
  const records = readJsonl(filePath);
  let meta = null;
  let turnContext = null;
  const userMessages = [];
  for (const record of records) {
    if (record.type === "session_meta" && record.payload) {
      meta = record.payload;
    } else if (record.type === "turn_context" && record.payload && !turnContext) {
      turnContext = record.payload;
    } else if (
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload.role === "user"
    ) {
      const text = extractTextParts(record.payload.content);
      if (!text) continue;
      if (!includeBoilerplate && isBoilerplateUserMessage(text)) continue;
      userMessages.push(text);
    }
  }
  const stat = fs.statSync(filePath);
  return {
    filePath,
    id: meta?.id || path.basename(filePath, ".jsonl"),
    startedAt: meta?.timestamp || stat.mtime.toISOString(),
    cwd: meta?.cwd || turnContext?.cwd || "",
    model: turnContext?.model || "",
    prompt: userMessages[0] ? shorten(userMessages[0]) : "(no non-boilerplate prompt found)",
    source: meta?.source || "",
    originator: meta?.originator || "",
  };
}

function listCodexSessions({ root, limit = 10, includeBoilerplate = false }) {
  const summaries = walkFiles(root)
    .map((filePath) => summarizeCodexSession(filePath, includeBoilerplate))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries.slice(0, limit);
}

function resolveCodexSessionTarget({ root, target, includeBoilerplate = false }) {
  const files = walkFiles(root);
  if (files.length === 0) {
    throw new Error(`No Codex sessions found under ${root}`);
  }
  const summaries = files
    .map((filePath) => summarizeCodexSession(filePath, includeBoilerplate))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (!target || target === "last") return summaries[0].filePath;
  if (fs.existsSync(target)) return path.resolve(target);

  const exact = summaries.find((s) => s.id === target);
  if (exact) return exact.filePath;

  const partial = summaries.filter(
    (s) => s.id.includes(target) || path.basename(s.filePath).includes(target),
  );
  if (partial.length === 1) return partial[0].filePath;
  if (partial.length > 1) {
    throw new Error(`Codex target is ambiguous: ${target}`);
  }
  throw new Error(`Could not find Codex session matching: ${target}`);
}

function parseCodexSession(filePath, includeBoilerplate = false) {
  const records = readJsonl(filePath);
  let meta = null;
  let turnContext = null;
  const transcript = [];
  for (const record of records) {
    if (record.type === "session_meta" && record.payload) {
      meta = record.payload;
      continue;
    }
    if (record.type === "turn_context" && record.payload && !turnContext) {
      turnContext = record.payload;
      continue;
    }
    if (
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant")
    ) {
      const text = extractTextParts(record.payload.content);
      if (!text) continue;
      if (record.payload.role === "user" && !includeBoilerplate && isBoilerplateUserMessage(text)) {
        continue;
      }
      transcript.push({
        role: record.payload.role,
        text,
        phase: record.payload.role === "assistant" ? record.payload.phase || "message" : null,
        timestamp: record.timestamp || meta?.timestamp || new Date().toISOString(),
      });
    }
  }

  return {
    filePath,
    sessionId: meta?.id || path.basename(filePath, ".jsonl"),
    meta,
    turnContext,
    transcript,
    originalCwd: meta?.cwd || turnContext?.cwd || process.cwd(),
    model: turnContext?.model || "gpt-5.4",
    reasoningEffort: turnContext?.collaboration_mode?.settings?.reasoning_effort || null,
    interactionMode: turnContext?.collaboration_mode?.mode === "plan" ? "plan" : "default",
    runtimeMode:
      turnContext?.approval_policy === "never" && turnContext?.sandbox_policy?.type === "danger-full-access"
        ? "full-access"
        : "approval-required",
  };
}

function generateSessionId() {
  return `tb-${crypto.randomUUID()}`;
}

function formatCodexRelativePathFromDate(isoTimestamp, sessionId) {
  const date = new Date(isoTimestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(year, month, day, `${sessionId}.jsonl`);
}

function copyCodexSession({
  sourceRoot,
  targetRoot,
  target,
  includeBoilerplate = false,
  newSessionId = null,
}) {
  const sourceFile = resolveCodexSessionTarget({ root: sourceRoot, target, includeBoilerplate });
  const records = readJsonl(sourceFile);
  const sourceSummary = summarizeCodexSession(sourceFile, includeBoilerplate);
  const sessionId = newSessionId || generateSessionId();
  const now = new Date().toISOString();

  const rewritten = records.map((record) => {
    if (record.type === "session_meta" && record.payload) {
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

  const relativePath = formatCodexRelativePathFromDate(now, sessionId);
  const targetFile = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  writeJsonl(targetFile, rewritten);

  return {
    sourceFile,
    targetFile,
    sourceSessionId: sourceSummary.id,
    sessionId,
  };
}

module.exports = {
  DEFAULT_CODEX_ROOT,
  listCodexSessions,
  resolveCodexSessionTarget,
  parseCodexSession,
  copyCodexSession,
};
