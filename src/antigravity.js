const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeToolInput } = require("./ir");

const DEFAULT_ANTIGRAVITY_ROOT = path.join(os.homedir(), ".gemini", "antigravity");
const ANTIGRAVITY_ROOT_CANDIDATES = [
  DEFAULT_ANTIGRAVITY_ROOT,
  path.join(os.homedir(), ".gemini", "antigravity-cli"),
  path.join(os.homedir(), ".gemini", "antigravity-ide"),
];

function hasAntigravityData(root) {
  return fs.existsSync(path.join(root, "conversations")) || fs.existsSync(path.join(root, "brain"));
}

function resolveAntigravityRoot(root = null) {
  if (root) return path.resolve(root);
  const existingRoot = ANTIGRAVITY_ROOT_CANDIDATES.find(hasAntigravityData);
  return path.resolve(existingRoot || DEFAULT_ANTIGRAVITY_ROOT);
}

function ensureAntigravityRoot(root) {
  const resolvedRoot = resolveAntigravityRoot(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Antigravity data root does not exist: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

function existsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function transcriptPathFor(root, conversationId) {
  const candidates = [
    path.join(root, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(root, "conversations", conversationId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(root, "conversations", `${conversationId}.jsonl`),
    path.join(root, `${conversationId}.jsonl`),
  ];
  return candidates.find(existsFile) || null;
}

function databasePathFor(root, conversationId) {
  const candidate = path.join(root, "conversations", `${conversationId}.db`);
  return existsFile(candidate) ? candidate : null;
}

function idFromPath(filePath) {
  const resolvedPath = path.resolve(filePath);
  const parts = resolvedPath.split(path.sep);
  const brainIndex = parts.lastIndexOf("brain");
  if (brainIndex >= 0 && parts[brainIndex + 1]) {
    return parts[brainIndex + 1];
  }

  const baseName = path.basename(resolvedPath);
  if (baseName.endsWith(".db")) return baseName.slice(0, -3);
  if (baseName.endsWith(".jsonl")) return baseName.slice(0, -6);
  return baseName;
}

function collectConversationEntries(root) {
  const resolvedRoot = ensureAntigravityRoot(root);
  const entries = new Map();

  function add(conversationId, values = {}) {
    if (!conversationId) return;
    const previous = entries.get(conversationId) || {};
    entries.set(conversationId, {
      conversationId,
      databasePath: values.databasePath || previous.databasePath || databasePathFor(resolvedRoot, conversationId),
      transcriptPath: values.transcriptPath || previous.transcriptPath || transcriptPathFor(resolvedRoot, conversationId),
    });
  }

  const conversationsDir = path.join(resolvedRoot, "conversations");
  if (fs.existsSync(conversationsDir)) {
    for (const entry of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        add(entry.name.slice(0, -3), { databasePath: path.join(conversationsDir, entry.name) });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        add(entry.name.slice(0, -6), { transcriptPath: path.join(conversationsDir, entry.name) });
      } else if (entry.isDirectory()) {
        add(entry.name);
      }
    }
  }

  const brainDir = path.join(resolvedRoot, "brain");
  if (fs.existsSync(brainDir)) {
    for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const conversationId = entry.name;
      add(conversationId, { transcriptPath: transcriptPathFor(resolvedRoot, conversationId) });
    }
  }

  return {
    root: resolvedRoot,
    entries: [...entries.values()].filter((entry) => entry.databasePath || entry.transcriptPath),
  };
}

function readJsonl(filePath) {
  const records = [];
  const warnings = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") {
        records.push({ record, lineNumber: index + 1 });
      } else {
        warnings.push(`Ignored non-object Antigravity transcript record at line ${index + 1}.`);
      }
    } catch {
      warnings.push(`Ignored malformed Antigravity transcript record at line ${index + 1}.`);
    }
  }
  return { records, warnings };
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";

  for (const key of ["text", "content", "output", "message", "value", "parts"]) {
    if (value[key] === undefined) continue;
    const text = extractText(value[key]);
    if (text) return text;
  }
  return "";
}

function removeTaggedBlocks(text, tags) {
  return tags.reduce(
    (current, tag) => current.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), ""),
    text,
  );
}

function extractUserRequest(value) {
  const raw = extractText(value);
  if (!raw) return "";
  const request = raw.match(/<USER_REQUEST\b[^>]*>([\s\S]*?)<\/USER_REQUEST>/i);
  const text = request ? request[1] : raw;
  return removeTaggedBlocks(text, ["ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE"]).trim();
}

function normalizeTimestamp(value, fallback) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    const timestamp = new Date(milliseconds);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  return fallback;
}

function shorten(text, maxLength = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function recordStatus(record) {
  return String(record.status || "").trim().toUpperCase();
}

function isCompletedRecord(record) {
  const status = recordStatus(record);
  return !status || status === "DONE";
}

function visibleTranscriptFromRecords(records, fallbackTimestamp, { includeToolCalls = true } = {}) {
  const transcript = [];
  let skippedPrivateOrSystem = 0;
  let skippedInProgress = 0;
  let carriedToolCalls = 0;
  let droppedToolCalls = 0;

  for (const { record, lineNumber } of records) {
    if (!isCompletedRecord(record)) {
      skippedInProgress += 1;
      continue;
    }

    const source = String(record.source || "").trim().toUpperCase();
    const type = String(record.type || "").trim().toUpperCase();
    const timestamp = normalizeTimestamp(record.created_at || record.createdAt || record.timestamp, fallbackTimestamp);
    const metadata = {
      source,
      type,
      status: recordStatus(record) || "DONE",
      lineNumber,
      ...(record.step_index === undefined ? {} : { stepIndex: record.step_index }),
    };

    if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
      const text = extractUserRequest(record.content || record.text || record.message);
      if (!text) {
        skippedPrivateOrSystem += 1;
        continue;
      }
      transcript.push({ role: "user", text, timestamp, phase: "user-input", metadata });
      continue;
    }

    if (source === "MODEL" && (type === "PLANNER_RESPONSE" || type === "GENERIC")) {
      // Planner tool calls are carried as tool-call blocks; private thinking is not.
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (includeToolCalls) {
        for (const call of toolCalls) {
          if (!call || typeof call !== "object") continue;
          const input = summarizeToolInput(call.args ?? call.arguments);
          if (!input.command && !input.source) continue;
          transcript.push({
            role: "assistant",
            phase: "tool-call",
            timestamp,
            metadata,
            content: [
              {
                type: "tool-call",
                toolName: call.name || "tool_call",
                input,
              },
            ],
          });
          carriedToolCalls += 1;
        }
      } else {
        droppedToolCalls += toolCalls.length;
      }

      const text = extractText(record.content || record.text || record.message).trim();
      if (!text) {
        skippedPrivateOrSystem += 1;
        continue;
      }
      transcript.push({
        role: "assistant",
        text,
        timestamp,
        phase: type === "GENERIC" ? "tool-result" : "message",
        metadata,
      });
      continue;
    }

    skippedPrivateOrSystem += 1;
  }

  return { transcript, skippedPrivateOrSystem, skippedInProgress, carriedToolCalls, droppedToolCalls };
}

function resolveAntigravityConversationTarget({ root, target }) {
  const { root: resolvedRoot, entries } = collectConversationEntries(root);
  if (entries.length === 0) {
    throw new Error(`No Antigravity conversations found under ${resolvedRoot}`);
  }

  if (target && target !== "last" && fs.existsSync(target)) {
    const resolvedTarget = path.resolve(target);
    if (existsFile(resolvedTarget) && resolvedTarget.endsWith(".jsonl")) {
      const conversationId = idFromPath(resolvedTarget);
      const existing = entries.find((entry) => entry.conversationId === conversationId);
      return {
        conversationId,
        databasePath: existing?.databasePath || databasePathFor(resolvedRoot, conversationId),
        transcriptPath: resolvedTarget,
      };
    }

    if (existsFile(resolvedTarget) && resolvedTarget.endsWith(".db")) {
      const conversationId = idFromPath(resolvedTarget);
      const existing = entries.find((entry) => entry.conversationId === conversationId);
      return {
        conversationId,
        databasePath: resolvedTarget,
        transcriptPath: existing?.transcriptPath || transcriptPathFor(resolvedRoot, conversationId),
      };
    }
  }

  const summaries = entries.map((entry) => summarizeAntigravityConversation(entry));
  if (!target || target === "last") {
    summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return entries.find((entry) => entry.conversationId === summaries[0].id);
  }

  const exact = entries.find((entry) => entry.conversationId === target);
  if (exact) return exact;

  const partial = entries.filter(
    (entry) => entry.conversationId.includes(target) || entry.databasePath?.includes(target) || entry.transcriptPath?.includes(target),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`Antigravity target is ambiguous: ${target}`);
  }
  throw new Error(`Could not find Antigravity conversation matching: ${target}`);
}

function parseAntigravityTranscript(
  filePath,
  { conversationId = idFromPath(filePath), databasePath = null, includeToolCalls = true } = {},
) {
  if (!existsFile(filePath)) {
    throw new Error(`Antigravity transcript not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const fallbackTimestamp = stat.mtime.toISOString();
  const { records, warnings: parseWarnings } = readJsonl(filePath);
  const { transcript, skippedPrivateOrSystem, skippedInProgress, carriedToolCalls, droppedToolCalls } =
    visibleTranscriptFromRecords(records, fallbackTimestamp, { includeToolCalls });
  const firstRecordTimestamp = records[0]
    ? normalizeTimestamp(records[0].record.created_at || records[0].record.createdAt || records[0].record.timestamp, fallbackTimestamp)
    : fallbackTimestamp;
  const lastRecordTimestamp = records[records.length - 1]
    ? normalizeTimestamp(
        records[records.length - 1].record.created_at ||
          records[records.length - 1].record.createdAt ||
          records[records.length - 1].record.timestamp,
        fallbackTimestamp,
      )
    : fallbackTimestamp;
  const firstUserMessage = transcript.find((entry) => entry.role === "user");

  return {
    conversationId,
    sessionId: conversationId,
    filePath,
    transcriptPath: filePath,
    databasePath,
    transcript,
    title: shorten(firstUserMessage?.text || conversationId, 120),
    createdAt: firstRecordTimestamp,
    updatedAt: lastRecordTimestamp,
    originalCwd: process.cwd(),
    model: null,
    warnings: [
      "Antigravity system events and private model reasoning were omitted from the portable transcript.",
      "Antigravity tool results were represented as assistant text for T3 transcript import.",
      ...(carriedToolCalls ? [`Carried ${carriedToolCalls} planner tool call(s) as tool-call blocks.`] : []),
      ...(droppedToolCalls ? [`Dropped ${droppedToolCalls} tool call(s) because tool calls were disabled.`] : []),
      ...parseWarnings,
    ],
    extensions: {
      antigravity: {
        conversationId,
        databasePath,
        transcriptPath: filePath,
        recordCount: records.length,
        skippedPrivateOrSystem,
        skippedInProgress,
      },
    },
  };
}

function summarizeAntigravityConversation(entry) {
  const transcriptPath = entry.transcriptPath || transcriptPathFor(
    path.dirname(path.dirname(entry.databasePath || "")),
    entry.conversationId,
  );
  if (!transcriptPath) {
    const timestamp = entry.databasePath && existsFile(entry.databasePath)
      ? fs.statSync(entry.databasePath).mtime.toISOString()
      : new Date(0).toISOString();
    return {
      id: entry.conversationId,
      title: entry.conversationId,
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      userCount: 0,
      assistantCount: 0,
      prompt: "(no transcript found)",
      filePath: entry.databasePath || null,
      databasePath: entry.databasePath || null,
      transcriptPath: null,
    };
  }

  const session = parseAntigravityTranscript(transcriptPath, {
    conversationId: entry.conversationId,
    databasePath: entry.databasePath || null,
  });
  return {
    id: session.conversationId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.transcript.length,
    userCount: session.transcript.filter((message) => message.role === "user").length,
    assistantCount: session.transcript.filter((message) => message.role === "assistant").length,
    prompt: shorten(session.transcript.find((message) => message.role === "user")?.text || "(no user message found)"),
    filePath: session.filePath,
    databasePath: session.databasePath,
    transcriptPath: session.transcriptPath,
  };
}

function listAntigravityConversations({ root = null, limit = 10 } = {}) {
  const { entries } = collectConversationEntries(root);
  return entries
    .map(summarizeAntigravityConversation)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

function searchAntigravityConversations({ root = null, limit = 10, query }) {
  const normalizedQuery = String(query || "").toLowerCase();
  const all = listAntigravityConversations({ root, limit: Number.MAX_SAFE_INTEGER });
  const matches = [];

  for (const summary of all) {
    if (String(summary.title || "").toLowerCase().includes(normalizedQuery) ||
        String(summary.prompt || "").toLowerCase().includes(normalizedQuery)) {
      matches.push({ ...summary, matchedRole: null, matchedText: null });
      continue;
    }

    if (!summary.transcriptPath) continue;
    const entry = resolveAntigravityConversationTarget({ root, target: summary.id });
    const session = parseAntigravityTranscript(summary.transcriptPath, {
      conversationId: entry.conversationId,
      databasePath: entry.databasePath,
    });
    const matched = [...session.transcript]
      .reverse()
      .find((message) => String(message.text || "").toLowerCase().includes(normalizedQuery));
    if (matched) {
      matches.push({
        ...summary,
        matchedRole: matched.role,
        matchedText: matched.text,
      });
    }
  }

  return matches.slice(0, limit);
}

function parseAntigravityConversation({ root = null, target = "last" }) {
  const resolved = resolveAntigravityConversationTarget({ root, target });
  if (!resolved.transcriptPath) {
    throw new Error(
      `Antigravity transcript not found for conversation ${resolved.conversationId}. ` +
        `Expected brain/${resolved.conversationId}/.system_generated/logs/transcript.jsonl under ${resolveAntigravityRoot(root)}`,
    );
  }
  return parseAntigravityTranscript(resolved.transcriptPath, {
    conversationId: resolved.conversationId,
    databasePath: resolved.databasePath,
  });
}

module.exports = {
  DEFAULT_ANTIGRAVITY_ROOT,
  parseAntigravityConversation,
  parseAntigravityTranscript,
  listAntigravityConversations,
  searchAntigravityConversations,
  resolveAntigravityConversationTarget,
  resolveAntigravityRoot,
};
