const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_CURSOR_ROOT = path.join(os.homedir(), ".cursor");
const CHATS_ROOT = path.join(DEFAULT_CURSOR_ROOT, "acp-sessions");

// Composer threads live in globalStorage/state.vscdb under cursorDiskKV
// Keys: bubbleId:<composerId>:<bubbleId>
// type 1 = user, type 2 = AI (non-empty text = substantive turn)
const COMPOSER_BUBBLE_TYPE_USER = 1;
const COMPOSER_BUBBLE_TYPE_AI = 2;

function resolveCursorDataDir() {
  if (process.env.CURSOR_DATA_DIR) {
    return process.env.CURSOR_DATA_DIR;
  }
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor", "User");
  }
  return path.join(os.homedir(), ".cursor");
}

function resolveGlobalStorageDir() {
  return path.join(resolveCursorDataDir(), "globalStorage");
}

function resolveWorkspaceStorageDir() {
  return path.join(resolveCursorDataDir(), "workspaceStorage");
}

function resolveAcpSessionsDir() {
  return path.join(resolveCursorDataDir(), "acp-sessions");
}

function resolveChatsDir() {
  const acpSessionsDir = resolveAcpSessionsDir();
  if (fs.existsSync(acpSessionsDir)) {
    return acpSessionsDir;
  }
  const globalStorage = resolveGlobalStorageDir();
  if (fs.existsSync(globalStorage)) {
    return globalStorage;
  }
  return null;
}

function listChats() {
  const chatsDir = resolveChatsDir();
  if (!chatsDir || !fs.existsSync(chatsDir)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(chatsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const chatDir = path.join(chatsDir, entry.name);
      const storePath = path.join(chatDir, "store.db");
      if (fs.existsSync(storePath)) {
        results.push({
          chatId: entry.name,
          chatDir,
          storePath,
        });
      }
    }
  }
  return results;
}

function extractTextFromMessage(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message.text === "string") return message.text;
  if (Array.isArray(message)) {
    return message.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).join("\n").trim();
  }
  if (Array.isArray(message.parts)) {
    return message.parts.map((p) => {
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).join("\n").trim();
  }
  return String(message);
}

function parseCursorStoreDb(storePath) {
  if (!fs.existsSync(storePath)) {
    return { sessions: [], chats: [] };
  }

  const db = new DatabaseSync(storePath, { readonly: true });
  try {
    const sessions = [];
    const chats = [];

    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%chat%'",
      ).all();

      for (const table of tables) {
        const tableName = table.name;
        if (tableName.includes("session") || tableName.includes("chat")) {
          try {
            const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
            for (const row of rows) {
              const rowData = { ...row };
              for (const key of Object.keys(rowData)) {
                const value = rowData[key];
                if (typeof value === "string" && value.startsWith("{")) {
                  try {
                    rowData[key] = JSON.parse(value);
                  } catch {}
                }
              }
              sessions.push(rowData);
            }
          } catch {}
        }
      }
    } catch {}

    return { sessions, chats };
  } finally {
    db.close();
  }
}

function tryParseHexJson(hexString) {
  if (typeof hexString !== "string" || hexString.length % 2 !== 0) {
    return null;
  }
  try {
    const bytes = [];
    for (let i = 0; i < hexString.length; i += 2) {
      bytes.push(parseInt(hexString.slice(i, i + 2), 16));
    }
    const text = String.fromCharCode(...bytes);
    if (text.startsWith("{") || text.startsWith("[")) {
      return JSON.parse(text);
    }
  } catch {}
  return null;
}

function extractCursorChatData(storePath) {
  if (!fs.existsSync(storePath)) {
    return null;
  }

  const db = new DatabaseSync(storePath, { readonly: true });
  try {
    const chatData = [];
    let schemaVersion = 1;
    let chatInfo = null;

    try {
      const versionRows = db.prepare("PRAGMA schema_version").all();
      if (versionRows.length > 0) {
        schemaVersion = versionRows[0].schema_version || 1;
      }
    } catch {}

    // Read meta table (hex-encoded JSON)
    try {
      const metaRows = db.prepare("SELECT * FROM meta").all();
      for (const row of metaRows) {
        const parsed = tryParseHexJson(row.value);
        if (parsed) {
          if (row.key === "0") {
            chatInfo = parsed;
          }
          chatData.push(parsed);
        }
      }
    } catch {}

    // Read blobs table - might contain message data (hex-encoded JSON)
    try {
      const blobRows = db.prepare("SELECT * FROM blobs LIMIT 100").all();
      for (const row of blobRows) {
        if (row.data) {
          // Blobs are hex-encoded JSON
          const parsed = tryParseHexJson(Buffer.from(row.data).toString('hex'));
          if (parsed) {
            chatData.push(parsed);
          }
        }
      }
    } catch {}

    // Also read any JSON files in the chat directory
    try {
      for (const file of fs.readdirSync(path.dirname(storePath))) {
        if (file.endsWith(".json")) {
          const jsonPath = path.join(path.dirname(storePath), file);
          try {
            const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
            chatData.push({ _file: file, ...jsonData });
          } catch {}
        }
      }
    } catch {}

    // ACP exports created by threadbridge store the payload in ChatSessions.data.
    try {
      const sessionRows = db.prepare("SELECT * FROM ChatSessions").all();
      for (const row of sessionRows) {
        const rowData = { ...row };
        for (const key of Object.keys(rowData)) {
          const value = rowData[key];
          if (typeof value === "string" && value.startsWith("{")) {
            try {
              rowData[key] = JSON.parse(value);
            } catch {}
          }
        }
        chatData.push(rowData);
      }
    } catch {}

    return {
      schemaVersion,
      chatInfo,
      chatData,
    };
  } finally {
    db.close();
  }
}

function parseCursorWorkspaceSession(workspacePath) {
  const statePath = path.join(workspacePath, "state.vscdb");
  if (!fs.existsSync(statePath)) {
    return null;
  }

  const db = new DatabaseSync(statePath, { readonly: true });
  try {
    const keysOfInterest = [
      "composer.composerData",
      "workbench.panel.aichat.view.aichat.chatdata",
      "composerChatViewPane",
    ];

    const result = {
      workspaceId: path.basename(workspacePath),
      chats: [],
    };

    for (const key of keysOfInterest) {
      try {
        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = ?",
        ).get(key);
        if (row && row.value) {
          let value = row.value;
          if (typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {}
          }
          if (value && typeof value === "object") {
            result[key] = value;
          }
        }
      } catch {}
    }

    return result;
  } finally {
    db.close();
  }
}

function listCursorChats({ includeHidden = false, limit = 20, composerLimit = null } = {}) {
  const acpResults = [];
  const chats = listChats();

  for (const chat of chats) {
    const data = extractCursorChatData(chat.storePath);
    if (!data) continue;

    let title = chat.chatId;
    let messageCount = 0;
    let createdAt = null;
    const messages = [];

    if (data.chatInfo) {
      if (data.chatInfo.name) title = data.chatInfo.name;
      if (data.chatInfo.createdAt) {
        createdAt = new Date(data.chatInfo.createdAt).toISOString();
      }
    }

    if (data.chatData) {
      for (const item of data.chatData) {
        if (!item) continue;
        if (item.role && (item.content || item.text)) messages.push(item);
        if (item.messages && Array.isArray(item.messages)) messages.push(...item.messages);
      }
    }

    messageCount = messages.length;
    if (messageCount === 0 && data.chatInfo) {
      try {
        const db = new DatabaseSync(chat.storePath, { readonly: true });
        try {
          const blobRows = db.prepare("SELECT data FROM blobs").all();
          for (const row of blobRows) {
            if (row.data) {
              const parsed = tryParseHexJson(Buffer.from(row.data).toString("hex"));
              if (parsed && parsed.role) messages.push(parsed);
            }
          }
          messageCount = messages.length;
        } finally {
          db.close();
        }
      } catch {}
    }

    acpResults.push({
      chatId: chat.chatId,
      chatDir: chat.chatDir,
      title,
      messageCount,
      createdAt,
      source: "acp",
    });
  }

  // Merge with Composer threads from globalStorage
  const composerResults = listComposerThreads({ limit: composerLimit || Math.max(limit, 20) });

  // Deduplicate: ACP takes precedence if same chatId appears in both
  const acpIds = new Set(acpResults.map((r) => r.chatId));
  const merged = [
    ...acpResults,
    ...composerResults.filter((r) => !acpIds.has(r.chatId)),
  ];

  return merged.sort((a, b) => {
    const aTime = (a.lastAt || a.createdAt) || "1970-01-01";
    const bTime = (b.lastAt || b.createdAt) || "1970-01-01";
    return bTime.localeCompare(aTime);
  });
}

function parseCursorChat(chatId) {
  const chats = listChats();
  const target = chats.find((c) => c.chatId === chatId || c.chatDir.endsWith(chatId));

  if (!target) {
    // Try Composer before giving up
    const globalDb = resolveCursorGlobalStateDb();
    if (fs.existsSync(globalDb)) {
      try {
        const resolved = resolveComposerTarget(chatId);
        return parseComposerThread(resolved);
      } catch {}
    }
    throw new Error(`Cursor chat not found in ACP sessions or Composer threads: ${chatId}`);
  }

  const data = extractCursorChatData(target.storePath);
  const transcript = [];
  let title = target.chatId;

  // Get title from chatInfo
  if (data && data.chatInfo && data.chatInfo.name) {
    title = data.chatInfo.name;
  }

  // Extract messages from blobs (hex-encoded JSON)
  if (data && data.chatData) {
    for (const item of data.chatData) {
      if (item.role && item.content) {
        // This is a message
        const role = item.role === "ai" ? "assistant" : item.role;
        const text = extractTextFromMessage(item.content);
        if (text) {
          transcript.push({
            role,
            text,
            timestamp: item.timestamp || item.createdAt,
          });
        }
      } else if (item.messages && Array.isArray(item.messages)) {
        // Array of messages
        for (const msg of item.messages) {
          const role = msg.role || msg.author || "user";
          const text = extractTextFromMessage(msg.content || msg.text || msg.message);
          if (text) {
            transcript.push({
              role: role === "ai" ? "assistant" : role,
              text,
              timestamp: msg.timestamp || msg.createdAt,
            });
          }
        }
      } else if (item.data && Array.isArray(item.data.chatSessions)) {
        for (const session of item.data.chatSessions) {
          if (session.title && title === target.chatId) {
            title = session.title;
          }
          for (const msg of session.messages || []) {
            const role = msg.role || msg.author || "user";
            const text = extractTextFromMessage(msg.content || msg.text || msg.message);
            if (text) {
              transcript.push({
                role: role === "ai" ? "assistant" : role,
                text,
                timestamp: msg.timestamp || msg.createdAt,
              });
            }
          }
        }
      }
    }
  }

  transcript.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  return {
    chatId: target.chatId,
    chatDir: target.chatDir,
    title,
    transcript,
  };
}

function resolveCursorChat(chatTarget) {
  const chats = listChats(); // ACP only (fast)

  if (!chatTarget || chatTarget === "last") {
    // Prefer the most-recently-active across both sources
    const merged = listCursorChats({ limit: 1 });
    if (merged.length === 0) throw new Error("No Cursor chats found");
    return merged[0].chatId;
  }

  // Exact ACP match
  if (chats.some((c) => c.chatId === chatTarget)) return chatTarget;

  // Prefix ACP match
  const partial = chats.filter((c) => c.chatId.includes(chatTarget));
  if (partial.length === 1) return partial[0].chatId;
  if (partial.length > 1) throw new Error(`Ambiguous Cursor chat target: ${chatTarget}`);

  // Fall back to Composer
  try {
    return resolveComposerTarget(chatTarget);
  } catch {
    throw new Error(`Cursor chat not found in ACP sessions or Composer threads: ${chatTarget}`);
  }
}

function buildCursorExport(chatId) {
  const chat = parseCursorChat(chatId);
  return {
    chatId: chat.chatId,
    title: chat.title,
    transcript: chat.transcript,
  };
}

function generateCursorSessionFromT3({
  t3Thread,
  chatId = null,
}) {
  const id = chatId || `tb-${crypto.randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();

  const chatData = {
    version: 1,
    chatSessions: [
      {
        id,
        title: t3Thread.title || "Imported Session",
        messages: t3Thread.messages.map((msg) => ({
          role: msg.role,
          content: [
            {
              type: "text",
              text: msg.text,
            },
          ],
          createdAt: msg.createdAt || now,
        })),
        createdAt: t3Thread.createdAt || now,
        updatedAt: now,
      },
    ],
  };

  const chatsDir = resolveAcpSessionsDir();
  fs.mkdirSync(chatsDir, { recursive: true });
  const chatDir = path.join(chatsDir, id);
  fs.mkdirSync(chatDir, { recursive: true });
  const storePath = path.join(chatDir, "store.db");

  const db = new DatabaseSync(storePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ChatSessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        data TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    db.prepare(`
      INSERT OR REPLACE INTO ChatSessions (id, title, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      t3Thread.title || "Imported Session",
      JSON.stringify(chatData),
      t3Thread.createdAt || now,
      now,
    );
  } finally {
    db.close();
  }

  return {
    chatId: id,
    chatDir,
    messageCount: t3Thread.messages.length,
  };
}

// ---------------------------------------------------------------------------
// Composer adapter (cursorDiskKV in globalStorage/state.vscdb)
// ---------------------------------------------------------------------------

function resolveCursorGlobalStateDb() {
  return path.join(resolveCursorDataDir(), "globalStorage", "state.vscdb");
}

/**
 * Extract composerId from a cursorDiskKV key like:
 *   bubbleId:<composerId>:<bubbleId>
 * The composerId may be a UUID or a non-standard slug (e.g. task-…).
 */
function composerIdFromKey(key) {
  // key starts with "bubbleId:"  (9 chars)
  const rest = key.slice(9);
  const sep = rest.indexOf(":");
  return sep === -1 ? rest : rest.slice(0, sep);
}

function listComposerThreads({ limit = 10, globalStateDbPath = null } = {}) {
  const dbPath = globalStateDbPath || resolveCursorGlobalStateDb();
  if (!fs.existsSync(dbPath)) return [];

  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    // One pass: get composer stats grouped by composerId
    const rows = db.prepare(`
      SELECT
        substr(key, 10, instr(substr(key, 10), ':') - 1) AS composerId,
        COUNT(*) AS bubbleCount,
        MIN(json_extract(CAST(value AS TEXT), '$.createdAt')) AS firstAt,
        MAX(json_extract(CAST(value AS TEXT), '$.createdAt')) AS lastAt
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
      GROUP BY composerId
      ORDER BY lastAt DESC
      LIMIT ?
    `).all(limit);

    const results = [];
    for (const row of rows) {
      let title = null;
      let userCount = 0;
      let aiCount = 0;
      try {
        // First user message → title
        const firstUser = db.prepare(`
          SELECT json_extract(CAST(value AS TEXT), '$.text') AS text
          FROM cursorDiskKV
          WHERE key LIKE ?
            AND json_extract(CAST(value AS TEXT), '$.type') = ${COMPOSER_BUBBLE_TYPE_USER}
            AND length(json_extract(CAST(value AS TEXT), '$.text')) > 0
          ORDER BY json_extract(CAST(value AS TEXT), '$.createdAt') ASC
          LIMIT 1
        `).get(`bubbleId:${row.composerId}:%`);
        if (firstUser && firstUser.text) {
          title = firstUser.text.slice(0, 80).replace(/\n/g, " ");
        }

        // Count user vs AI turns
        const counts = db.prepare(`
          SELECT
            SUM(CASE WHEN json_extract(CAST(value AS TEXT), '$.type') = ${COMPOSER_BUBBLE_TYPE_USER} THEN 1 ELSE 0 END) AS userCount,
            SUM(CASE WHEN json_extract(CAST(value AS TEXT), '$.type') = ${COMPOSER_BUBBLE_TYPE_AI}
                AND length(json_extract(CAST(value AS TEXT), '$.text')) > 0 THEN 1 ELSE 0 END) AS aiCount
          FROM cursorDiskKV
          WHERE key LIKE ?
        `).get(`bubbleId:${row.composerId}:%`);
        if (counts) {
          userCount = counts.userCount || 0;
          aiCount = counts.aiCount || 0;
        }
      } catch {}

      results.push({
        chatId: row.composerId,
        title: title || `Composer ${row.composerId.slice(0, 8)}`,
        messageCount: userCount + aiCount,
        userCount,
        aiCount,
        createdAt: row.firstAt || null,
        lastAt: row.lastAt || null,
        source: "composer",
        chatDir: null,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

function parseComposerThread(composerId, { globalStateDbPath = null } = {}) {
  const dbPath = globalStateDbPath || resolveCursorGlobalStateDb();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor global state DB not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT CAST(value AS TEXT) AS json
      FROM cursorDiskKV
      WHERE key LIKE ?
      ORDER BY json_extract(CAST(value AS TEXT), '$.createdAt') ASC
    `).all(`bubbleId:${composerId}:%`);

    const transcript = [];
    let title = null;

    for (const row of rows) {
      let bubble;
      try { bubble = JSON.parse(row.json); } catch { continue; }

      const { type, text, createdAt } = bubble;
      if (!text || text.length === 0) continue;

      let role;
      if (type === COMPOSER_BUBBLE_TYPE_USER) {
        role = "user";
        if (!title) title = text.slice(0, 80).replace(/\n/g, " ");
      } else if (type === COMPOSER_BUBBLE_TYPE_AI) {
        role = "assistant";
      } else {
        continue;
      }

      transcript.push({ role, text, timestamp: createdAt });
    }

    return {
      chatId: composerId,
      chatDir: null,
      title: title || `Composer ${composerId.slice(0, 8)}`,
      transcript,
      source: "composer",
    };
  } finally {
    db.close();
  }
}

function resolveComposerTarget(target, { globalStateDbPath = null } = {}) {
  const dbPath = globalStateDbPath || resolveCursorGlobalStateDb();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor global state DB not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    if (!target || target === "last") {
      const row = db.prepare(`
        SELECT substr(key, 10, instr(substr(key, 10), ':') - 1) AS composerId
        FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%'
        GROUP BY composerId
        ORDER BY MAX(json_extract(CAST(value AS TEXT), '$.createdAt')) DESC
        LIMIT 1
      `).get();
      if (!row) throw new Error("No Cursor Composer threads found");
      return row.composerId;
    }

    // Collect all known composerIds for prefix matching
    const all = db.prepare(`
      SELECT DISTINCT substr(key, 10, instr(substr(key, 10), ':') - 1) AS composerId
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
    `).all();

    const ids = all.map((r) => r.composerId);
    if (ids.includes(target)) return target;

    const matches = ids.filter((id) => id.startsWith(target));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous Cursor Composer target: ${target}`);

    throw new Error(`Cursor Composer thread not found: ${target}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// End Composer adapter
// ---------------------------------------------------------------------------

function importCursorIntoT3({
  cursorChatId,
  dbPath,
  title = null,
  projectId = null,
  workspaceRoot = null,
  backup = true,
  busyTimeoutMs = 5000,
  lockRetries = 3,
  retryDelayMs = 100,
}) {
  const Bridge = require("./bridge");
  const chat = parseCursorChat(cursorChatId);

  const sessionData = {
    sessionId: chat.chatId,
    transcript: chat.transcript,
    meta: {
      source: "cursor",
      title: chat.title,
    },
  };

  return Bridge.importCodexIntoT3({
    codexSession: {
      ...sessionData,
      sessionId: sessionData.sessionId,
      model: "gpt-5",
      originalCwd: workspaceRoot || process.cwd(),
      reasoningEffort: null,
      interactionMode: "default",
      runtimeMode: "approval-required",
    },
    dbPath,
    title: title || chat.title,
    projectId,
    workspaceRoot,
    backup,
    busyTimeoutMs,
    lockRetries,
    retryDelayMs,
  });
}

module.exports = {
  DEFAULT_CURSOR_ROOT,
  CHATS_ROOT,
  resolveCursorDataDir,
  resolveAcpSessionsDir,
  resolveGlobalStorageDir,
  resolveWorkspaceStorageDir,
  resolveCursorGlobalStateDb,
  listCursorChats,
  listComposerThreads,
  resolveCursorChat,
  resolveComposerTarget,
  parseCursorChat,
  parseComposerThread,
  buildCursorExport,
  generateCursorSessionFromT3,
  importCursorIntoT3,
};
