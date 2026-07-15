const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");
const {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} = require("./t3-copy");
const {
  DEFAULT_CODEX_ROOT,
  listCodexSessions,
} = require("./codex");
const {
  DEFAULT_CLAUDE_ROOT,
  listClaudeSessions,
} = require("./claude");
const {
  listCursorChats,
} = require("./cursor");
const {
  DEFAULT_OPENCODE_ROOT,
  listOpenCodeSessions,
} = require("./opencode");
const { copyThread } = require("./operations/copy-thread");
const { convertThread } = require("./operations/convert-thread");
const { readT3ThreadAsIr } = require("./adapters/t3/read");
const { readCodexSessionAsIr } = require("./adapters/codex/read");
const { readClaudeSessionAsIr } = require("./adapters/claude/read");
const { readCursorChatAsIr } = require("./adapters/cursor/read");
const { readOpenCodeSessionAsIr } = require("./adapters/opencode/read");

const DEFAULT_T3_DB_PATH = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
const DEFAULT_T3_SOURCE_DB_PATH = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
const DEFAULT_LIST_LIMIT = 10;

function usage() {
  return `Usage:
  threadbridge t3 list [--db-path PATH] [--limit N] [--json]
  threadbridge t3 search QUERY [--db-path PATH] [--limit N] [--json]
  threadbridge t3 show [THREAD_ID|last] [--db-path PATH] [--copy-runtime] [--json]
  threadbridge t3 copy [THREAD_ID|last] [--source-db-path PATH] [--db-path PATH] [--new-thread-id ID] [--title TEXT] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  threadbridge t3 copy-to-workspace [THREAD_ID|last] [--db-path PATH] [--new-project-id ID] [--new-provider PROVIDER] [--new-model MODEL] [--new-model-selection JSON] [--title TEXT] [--new-thread-id ID] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  threadbridge t3 to-codex [THREAD_ID|last] [--db-path PATH] [--root DIR] [--new-session-id ID]
  threadbridge t3 to-claude [THREAD_ID|last] [--db-path PATH] [--project-path DIR]
  threadbridge t3 to-cursor [THREAD_ID|last] [--db-path PATH]
  threadbridge t3 to-opencode [THREAD_ID|last] [--db-path PATH] [--root DIR] [--opencode-root DIR]

  threadbridge codex list [--root DIR] [--limit N] [--include-boilerplate] [--json]
  threadbridge codex search QUERY [--root DIR] [--limit N] [--include-boilerplate] [--json]
  threadbridge codex show [SESSION_ID|SESSION_PATH|last] [--root DIR] [--include-boilerplate] [--json]
  threadbridge codex copy [SESSION_ID|SESSION_PATH|last] [--root DIR] [--dest-root DIR] [--new-session-id ID]
  threadbridge codex to-t3 [SESSION_ID|SESSION_PATH|last] [--root DIR] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

  threadbridge claude list [PROJECT_PATH] [--limit N] [--json]
  threadbridge claude search QUERY [PROJECT_PATH] [--limit N] [--json]
  threadbridge claude show [SESSION_ID|SESSION_PATH|last] [--project-path DIR] [--json]
  threadbridge claude copy [SESSION_ID|SESSION_PATH|last] [--project-path DIR] [--dest-project-path DIR] [--new-session-id ID]
  threadbridge claude to-t3 [SESSION_ID|SESSION_PATH|last] [--project-path DIR] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

  threadbridge cursor list [--limit N] [--json]
  threadbridge cursor search QUERY [--limit N] [--json]
  threadbridge cursor show [CHAT_ID|COMPOSER_ID|last] [--json]
  threadbridge cursor copy [CHAT_ID|last] [--dest-chat-id ID]
  threadbridge cursor to-t3 [CHAT_ID|COMPOSER_ID|last] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  (cursor list shows both ACP sessions [acp] and Composer threads [composer])

  threadbridge opencode list [--root DIR] [--limit N] [--json]
  threadbridge opencode search QUERY [--root DIR] [--limit N] [--json]
  threadbridge opencode show [SESSION_ID|SESSION_PATH|last] [--root DIR] [--json]
  threadbridge opencode copy [SESSION_ID|SESSION_PATH|last] [--root DIR] [--dest-root DIR] [--new-session-id ID]
  threadbridge opencode to-t3 [SESSION_ID|SESSION_PATH|last] [--root DIR] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

Defaults:
  --source-db-path ${DEFAULT_T3_SOURCE_DB_PATH}
  --db-path        ${DEFAULT_T3_DB_PATH}
  --root           ${DEFAULT_CODEX_ROOT}
  --project-path  ${DEFAULT_CLAUDE_ROOT}
  --busy-timeout-ms ${DEFAULT_BUSY_TIMEOUT_MS}
  --lock-retries    ${DEFAULT_LOCK_RETRIES}
  --retry-delay-ms  ${DEFAULT_RETRY_DELAY_MS}

Global output:
  --json           Emit a stable JSON envelope on stdout; errors use stderr
`;
}

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function emitJson(args, data) {
  if (!args.json) return false;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: `${args.adapter} ${args.command}`,
    data,
  }, null, 2)}\n`);
  return true;
}

function parsePositiveInt(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

function usesOpenCodeRoot(adapter, command) {
  return adapter === "opencode" || (adapter === "t3" && command === "to-opencode");
}

function parseArgs(argv) {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const [adapter, command, ...rest] = argv;
  if (!["t3", "codex", "claude", "cursor", "opencode"].includes(adapter)) {
    fail(`Unsupported adapter '${adapter}'. Supported: t3, codex, claude, cursor, opencode`);
  }

  const args = {
    adapter,
    command,
    target: "last",
    dbPath: DEFAULT_T3_DB_PATH,
    sourceDbPath: DEFAULT_T3_SOURCE_DB_PATH,
    root: DEFAULT_CODEX_ROOT,
    destRoot: DEFAULT_CODEX_ROOT,
    projectPath: DEFAULT_CLAUDE_ROOT,
    destProjectPath: DEFAULT_CLAUDE_ROOT,
    opencodeRoot: DEFAULT_OPENCODE_ROOT,
    destOpenCodeRoot: DEFAULT_OPENCODE_ROOT,
    limit: DEFAULT_LIST_LIMIT,
    newThreadId: null,
    newSessionId: null,
    newChatId: null,
    newOpenCodeSessionId: null,
    title: null,
    workspaceRoot: null,
    projectId: null,
    newProjectId: null,
    newProvider: null,
    newModel: null,
    newModelSelection: null,
    copyRuntime: false,
    includeBoilerplate: false,
    json: false,
    backup: true,
    query: null,
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    lockRetries: DEFAULT_LOCK_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  };

  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--copy-runtime") {
      args.copyRuntime = true;
      continue;
    }
    if (token === "--no-backup") {
      args.backup = false;
      continue;
    }
    if (token === "--include-boilerplate") {
      args.includeBoilerplate = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (
      token === "--db-path" ||
      token === "--source-db-path" ||
      token === "--root" ||
      token === "--dest-root" ||
      token === "--project-path" ||
      token === "--dest-project-path" ||
      token === "--limit" ||
      token === "--new-thread-id" ||
      token === "--new-session-id" ||
      token === "--new-chat-id" ||
      token === "--dest-chat-id" ||
      token === "--new-opencode-session-id" ||
      token === "--title" ||
      token === "--workspace-root" ||
      token === "--project-id" ||
      token === "--new-project-id" ||
      token === "--new-provider" ||
      token === "--new-model" ||
      token === "--new-model-selection" ||
      token === "--busy-timeout-ms" ||
      token === "--lock-retries" ||
      token === "--retry-delay-ms" ||
      token === "--opencode-root" ||
      token === "--dest-opencode-root"
    ) {
      const next = rest[i + 1];
      if (!next) fail(`Missing value for ${token}`);
      i += 1;
      if (token === "--db-path") args.dbPath = next;
      else if (token === "--source-db-path") args.sourceDbPath = next;
      else if (token === "--root") {
        args.root = next;
        if (usesOpenCodeRoot(adapter, command)) args.opencodeRoot = next;
      } else if (token === "--dest-root") {
        args.destRoot = next;
        if (adapter === "opencode") args.destOpenCodeRoot = next;
      } else if (token === "--limit") args.limit = parsePositiveInt(token, next);
      else if (token === "--new-thread-id") args.newThreadId = next;
      else if (token === "--new-session-id") {
        args.newSessionId = next;
        if (adapter === "opencode") args.newOpenCodeSessionId = next;
      } else if (token === "--title") args.title = next;
      else if (token === "--workspace-root") args.workspaceRoot = next;
      else if (token === "--project-id") args.projectId = next;
      else if (token === "--busy-timeout-ms") args.busyTimeoutMs = parsePositiveInt(token, next);
      else if (token === "--lock-retries") args.lockRetries = parsePositiveInt(token, next);
      else if (token === "--retry-delay-ms") args.retryDelayMs = parsePositiveInt(token, next);
      else if (token === "--project-path") args.projectPath = next;
      else if (token === "--dest-project-path") args.destProjectPath = next;
      else if (token === "--new-chat-id" || token === "--dest-chat-id") args.newChatId = next;
      else if (token === "--opencode-root") args.opencodeRoot = next;
      else if (token === "--dest-opencode-root") args.destOpenCodeRoot = next;
      else if (token === "--new-opencode-session-id") args.newOpenCodeSessionId = next;
      else if (token === "--new-project-id") args.newProjectId = next;
      else if (token === "--new-provider") args.newProvider = next;
      else if (token === "--new-model") args.newModel = next;
      else if (token === "--new-model-selection") args.newModelSelection = next;
      continue;
    }
    if (token.startsWith("--")) fail(`Unknown option: ${token}`);
    positionals.push(token);
  }

  const validT3 = ["list", "search", "show", "copy", "copy-to-workspace", "to-codex", "to-claude", "to-cursor", "to-opencode"];
  const validCodex = ["list", "search", "show", "copy", "to-t3"];
  const validClaude = ["list", "search", "show", "copy", "to-t3"];
  const validCursor = ["list", "search", "show", "copy", "to-t3"];
  const validOpenCode = ["list", "search", "show", "copy", "to-t3"];
  if (adapter === "t3" && !validT3.includes(command)) {
    fail(`Unsupported t3 command '${command}'.`);
  }
  if (adapter === "codex" && !validCodex.includes(command)) {
    fail(`Unsupported codex command '${command}'.`);
  }
  if (adapter === "claude" && !validClaude.includes(command)) {
    fail(`Unsupported claude command '${command}'.`);
  }
  if (adapter === "cursor" && !validCursor.includes(command)) {
    fail(`Unsupported cursor command '${command}'.`);
  }
  if (adapter === "opencode" && !validOpenCode.includes(command)) {
    fail(`Unsupported opencode command '${command}'.`);
  }

  if (command === "search") {
    if (positionals.length === 0) {
      fail("`search` requires a QUERY argument.");
    }
    args.query = positionals[0];
    if (adapter === "claude" && positionals.length > 1) {
      args.projectPath = positionals[1];
    } else if (adapter !== "claude" && positionals.length > 1) {
      fail("`search` accepts only one positional argument (QUERY).");
    }
  } else if (command !== "list") {
    args.target = positionals[0] || "last";
  } else if (adapter === "claude") {
    if (positionals.length > 1) {
      fail("`claude list` accepts at most one PROJECT_PATH positional.");
    }
    if (positionals.length === 1) {
      args.projectPath = positionals[0];
    }
  } else if (positionals.length > 0) {
    fail("`list` does not accept a target.");
  }

  return args;
}

function listT3Threads({ dbPath, limit }) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`
        SELECT
          threads.thread_id AS threadId,
          threads.title AS title,
          threads.created_at AS createdAt,
          projects.title AS projectTitle,
          projects.workspace_root AS workspaceRoot
        FROM projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
        ORDER BY threads.created_at DESC, threads.thread_id DESC
        LIMIT ?
      `)
      .all(limit);
  } finally {
    db.close();
  }
}

function runT3List(args) {
  const rows = listT3Threads(args);
  if (emitJson(args, rows)) return;
  for (const row of rows) {
      process.stdout.write(`${row.createdAt}  ${row.threadId}\n`);
      process.stdout.write(`  title: ${row.title}\n`);
      if (row.projectTitle || row.workspaceRoot) {
        process.stdout.write(
          `  project: ${row.projectTitle || "(unknown)"}${row.workspaceRoot ? `  [${row.workspaceRoot}]` : ""}\n`,
        );
      }
      process.stdout.write("\n");
  }
}

function runCodexList(args) {
  const { root, limit, includeBoilerplate } = args;
  const sessions = listCodexSessions({ root, limit, includeBoilerplate });
  if (emitJson(args, sessions)) return;
  for (const session of sessions) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.cwd) process.stdout.write(`  cwd: ${session.cwd}\n`);
    if (session.model) process.stdout.write(`  model: ${session.model}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runClaudeList(args) {
  const { projectPath, limit } = args;
  const sessions = listClaudeSessions(projectPath || process.cwd(), { limit });
  if (emitJson(args, sessions)) return;
  for (const session of sessions) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.workingDir) process.stdout.write(`  cwd: ${session.workingDir}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runCursorList(args) {
  const { limit } = args;
  const chats = listCursorChats({ limit });
  if (emitJson(args, chats)) return;
  for (const chat of chats) {
    const source = chat.source || "acp";
    const ts = (chat.lastAt || chat.createdAt) || "unknown";
    process.stdout.write(`${ts}  ${chat.chatId}  [${source}]\n`);
    process.stdout.write(`  title: ${chat.title}\n`);
    if (source === "composer") {
      process.stdout.write(`  turns: ${chat.userCount} user / ${chat.aiCount} ai  (${chat.messageCount} substantive)\n`);
    } else {
      process.stdout.write(`  messages: ${chat.messageCount}\n`);
      if (chat.chatDir) process.stdout.write(`  dir: ${chat.chatDir}\n`);
    }
    process.stdout.write("\n");
  }
}

function runOpenCodeList(args) {
  const { opencodeRoot, limit } = args;
  const sessions = listOpenCodeSessions({ root: opencodeRoot, limit });
  if (emitJson(args, sessions)) return;
  for (const session of sessions) {
    process.stdout.write(`${session.createdAt || "unknown"}  ${session.sessionId}\n`);
    if (session.directory) process.stdout.write(`  cwd: ${session.directory}\n`);
    process.stdout.write(`  title: ${session.title}\n`);
    process.stdout.write(`  slug: ${session.slug}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function matchesQuery(text, query) {
  return String(text || "").toLowerCase().includes(query.toLowerCase());
}

function searchT3Threads({ dbPath, limit, query }) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`
        SELECT
          threads.thread_id AS threadId,
          threads.title AS title,
          threads.created_at AS createdAt,
          threads.updated_at AS updatedAt,
          projects.title AS projectTitle,
          projects.workspace_root AS workspaceRoot,
          CASE
            WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
            ELSE (
              SELECT messages.role
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = threads.thread_id
                AND INSTR(LOWER(messages.text), LOWER(?)) > 0
              ORDER BY messages.created_at DESC, messages.message_id DESC
              LIMIT 1
            )
          END AS matchedRole,
          CASE
            WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN NULL
            ELSE (
              SELECT messages.text
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = threads.thread_id
                AND INSTR(LOWER(messages.text), LOWER(?)) > 0
              ORDER BY messages.created_at DESC, messages.message_id DESC
              LIMIT 1
            )
          END AS matchedText
        FROM projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND (
            INSTR(LOWER(threads.title), LOWER(?)) > 0
            OR EXISTS (
              SELECT 1
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = threads.thread_id
                AND INSTR(LOWER(messages.text), LOWER(?)) > 0
            )
          )
        ORDER BY
          CASE WHEN INSTR(LOWER(threads.title), LOWER(?)) > 0 THEN 0 ELSE 1 END,
          threads.updated_at DESC,
          threads.thread_id DESC
        LIMIT ?
      `)
      .all(query, query, query, query, query, query, query, limit);
  } finally {
    db.close();
  }
}

function formatMatchExcerpt(text, query, maxLength = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const matchIndex = normalized.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const end = Math.min(normalized.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function runT3Search(args) {
  const { dbPath, limit, query } = args;
  const rows = searchT3Threads({ dbPath, limit, query });
  if (emitJson(args, rows.map((row) => ({
    ...row,
    matchedExcerpt: row.matchedText ? formatMatchExcerpt(row.matchedText, query) : null,
  })))) return;

  for (const row of rows) {
    process.stdout.write(`${row.updatedAt || row.createdAt}  ${row.threadId}\n`);
    process.stdout.write(`  title: ${row.title}\n`);
    if (row.projectTitle || row.workspaceRoot) {
      process.stdout.write(
        `  project: ${row.projectTitle || "(unknown)"}${row.workspaceRoot ? `  [${row.workspaceRoot}]` : ""}\n`,
      );
    }
    if (row.matchedText) {
      process.stdout.write(`  match (${row.matchedRole || "message"}): ${formatMatchExcerpt(row.matchedText, query)}\n`);
    }
    process.stdout.write("\n");
  }
}

function runCodexSearch(args) {
  const { root, limit, query, includeBoilerplate } = args;
  const all = listCodexSessions({ root, limit: 99999, includeBoilerplate });
  const matches = all.filter((s) => matchesQuery(s.prompt, query)).slice(0, limit);
  if (emitJson(args, matches)) return;
  for (const session of matches) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.cwd) process.stdout.write(`  cwd: ${session.cwd}\n`);
    if (session.model) process.stdout.write(`  model: ${session.model}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runClaudeSearch(args) {
  const { projectPath, limit, query } = args;
  const all = listClaudeSessions(projectPath || process.cwd(), { limit: 99999 });
  const matches = all.filter((s) => matchesQuery(s.prompt, query)).slice(0, limit);
  if (emitJson(args, matches)) return;
  for (const session of matches) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.workingDir) process.stdout.write(`  cwd: ${session.workingDir}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runCursorSearch(args) {
  const { limit, query } = args;
  const all = listCursorChats({ limit: 99999 });
  const matches = all.filter((c) => matchesQuery(c.title, query)).slice(0, limit);
  if (emitJson(args, matches)) return;
  for (const chat of matches) {
    const source = chat.source || "acp";
    const ts = (chat.lastAt || chat.createdAt) || "unknown";
    process.stdout.write(`${ts}  ${chat.chatId}  [${source}]\n`);
    process.stdout.write(`  title: ${chat.title}\n`);
    if (source === "composer") {
      process.stdout.write(`  turns: ${chat.userCount} user / ${chat.aiCount} ai  (${chat.messageCount} substantive)\n`);
    } else {
      process.stdout.write(`  messages: ${chat.messageCount}\n`);
      if (chat.chatDir) process.stdout.write(`  dir: ${chat.chatDir}\n`);
    }
    process.stdout.write("\n");
  }
}

function runOpenCodeSearch(args) {
  const { opencodeRoot, limit, query } = args;
  const all = listOpenCodeSessions({ root: opencodeRoot, limit: 99999 });
  const matches = all
    .filter((s) => matchesQuery(s.title, query) || matchesQuery(s.slug, query))
    .slice(0, limit);
  if (emitJson(args, matches)) return;
  for (const session of matches) {
    process.stdout.write(`${session.createdAt || "unknown"}  ${session.sessionId}\n`);
    if (session.directory) process.stdout.write(`  cwd: ${session.directory}\n`);
    process.stdout.write(`  title: ${session.title}\n`);
    process.stdout.write(`  slug: ${session.slug}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function readThreadAsIr(args) {
  if (args.adapter === "t3") {
    return readT3ThreadAsIr({ dbPath: args.dbPath, target: args.target, includeRuntime: args.copyRuntime });
  }
  if (args.adapter === "codex") {
    return readCodexSessionAsIr({ root: args.root, target: args.target, includeBoilerplate: args.includeBoilerplate });
  }
  if (args.adapter === "claude") {
    return readClaudeSessionAsIr({ projectPath: args.projectPath, target: args.target });
  }
  if (args.adapter === "cursor") return readCursorChatAsIr({ target: args.target });
  if (args.adapter === "opencode") {
    return readOpenCodeSessionAsIr({ root: args.opencodeRoot, target: args.target });
  }
  throw new CliError(`Unsupported adapter '${args.adapter}'.`);
}

function runShow(args) {
  const ir = readThreadAsIr(args);
  if (emitJson(args, ir)) return;
  process.stdout.write(`${ir.thread.title}\n`);
  process.stdout.write(`Source: ${ir.source.harness} ${ir.source.sourceId || "(unknown)"}\n`);
  if (ir.thread.workspaceRoot) process.stdout.write(`Workspace: ${ir.thread.workspaceRoot}\n`);
  process.stdout.write(`Messages: ${ir.messages.length}; turns: ${ir.turns.length}\n\n`);
  for (const message of ir.messages) {
    process.stdout.write(`[${message.role}] ${message.text || "(non-text content)"}\n\n`);
  }
}

function runCli(argv) {
  try {
    const args = parseArgs(argv);

    if (args.command === "show") {
      runShow(args);
      return;
    }

    if (args.adapter === "t3" && args.command === "list") {
      runT3List(args);
      return;
    }
    if (args.adapter === "codex" && args.command === "list") {
      runCodexList(args);
      return;
    }
    if (args.adapter === "claude" && args.command === "list") {
      runClaudeList(args);
      return;
    }
    if (args.adapter === "cursor" && args.command === "list") {
      runCursorList(args);
      return;
    }

    if (args.adapter === "t3" && args.command === "search") {
      runT3Search(args);
      return;
    }
    if (args.adapter === "codex" && args.command === "search") {
      runCodexSearch(args);
      return;
    }
    if (args.adapter === "claude" && args.command === "search") {
      runClaudeSearch(args);
      return;
    }
    if (args.adapter === "cursor" && args.command === "search") {
      runCursorSearch(args);
      return;
    }
    if (args.adapter === "opencode" && args.command === "search") {
      runOpenCodeSearch(args);
      return;
    }

    if (args.adapter === "t3" && args.command === "copy") {
      const receipt = copyThread({
        sourceHarness: "t3",
        targetHarness: "t3",
        sourceDbPath: args.sourceDbPath,
        targetDbPath: args.dbPath,
        target: args.target,
        newThreadId: args.newThreadId,
        title: args.title,
        copyRuntime: args.copyRuntime,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "clone-thread",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Copied thread ${receipt.source.id} -> ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Source DB: ${receipt.source.path}\n`);
      process.stdout.write(`Target DB: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(
        `Copied rows: messages=${receipt.counts.messages || 0}, turns=${receipt.counts.turns || 0}, activities=${receipt.counts.activities || 0}, proposedPlans=${receipt.counts.proposedPlans || 0}\n`,
      );
      return;
    }

    if (args.adapter === "t3" && args.command === "copy-to-workspace") {
      if (!args.newProjectId) {
        fail("--new-project-id is required for copy-to-workspace");
      }
      const receipt = copyThread({
        sourceHarness: "t3",
        targetHarness: "t3",
        sourceDbPath: args.dbPath,
        targetDbPath: args.dbPath,
        target: args.target,
        newThreadId: args.newThreadId,
        newProjectId: args.newProjectId,
        newProvider: args.newProvider,
        newModel: args.newModel,
        newModelSelection: args.newModelSelection,
        title: args.title,
        copyRuntime: args.copyRuntime,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "copy-to-workspace",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Copied thread ${receipt.source.id} -> ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`DB: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(
        `Copied rows: messages=${receipt.counts.messages || 0}, turns=${receipt.counts.turns || 0}, activities=${receipt.counts.activities || 0}, proposedPlans=${receipt.counts.proposedPlans || 0}\n`,
      );
      return;
    }

    if (args.adapter === "codex" && args.command === "copy") {
      const receipt = copyThread({
        sourceHarness: "codex",
        targetHarness: "codex",
        sourceRoot: args.root,
        targetRoot: args.destRoot,
        target: args.target,
        includeBoilerplate: args.includeBoilerplate,
        newSessionId: args.newSessionId,
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(
        `Copied Codex session ${receipt.source.id} -> ${receipt.createdIds.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${receipt.source.path}\n`);
      process.stdout.write(`Target file: ${receipt.target.path}\n`);
      return;
    }

    if (args.adapter === "codex" && args.command === "to-t3") {
      const receipt = convertThread({
        sourceHarness: "codex",
        targetHarness: "t3",
        root: args.root,
        target: args.target,
        includeBoilerplate: args.includeBoilerplate,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "import-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Imported Codex session ${receipt.source.id} into T3.\n`);
      process.stdout.write(`Thread ID: ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Thread title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Database: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(`Imported messages: ${receipt.counts.messages || 0}\n`);
      process.stdout.write(`Imported turns: ${receipt.counts.turns || 0}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-codex") {
      const receipt = convertThread({
        sourceHarness: "t3",
        targetHarness: "codex",
        dbPath: args.dbPath,
        target: args.target,
        root: args.root,
        newSessionId: args.newSessionId,
        intent: "export-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Exported T3 thread ${receipt.source.id} to Codex session.\n`);
      process.stdout.write(`Session ID: ${receipt.createdIds.sessionId}\n`);
      process.stdout.write(`Output file: ${receipt.target.path}\n`);
      process.stdout.write(`Messages exported: ${receipt.counts.messages || 0}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-claude") {
      const receipt = convertThread({
        sourceHarness: "t3",
        targetHarness: "claude",
        dbPath: args.dbPath,
        target: args.target,
        projectPath: args.projectPath,
        intent: "export-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Exported T3 thread to Claude session.\n`);
      process.stdout.write(`Session ID: ${receipt.createdIds.sessionId}\n`);
      process.stdout.write(`Output file: ${receipt.target.path}\n`);
      process.stdout.write(`Messages exported: ${receipt.counts.messages || 0}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-cursor") {
      const receipt = convertThread({
        sourceHarness: "t3",
        targetHarness: "cursor",
        dbPath: args.dbPath,
        target: args.target,
        newChatId: args.newChatId,
        intent: "export-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Exported T3 thread to Cursor chat.\n`);
      process.stdout.write(`Chat ID: ${receipt.createdIds.chatId}\n`);
      process.stdout.write(`Chat directory: ${receipt.target.path}\n`);
      process.stdout.write(`Messages exported: ${receipt.counts.messages || 0}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-opencode") {
      const receipt = convertThread({
        sourceHarness: "t3",
        targetHarness: "opencode",
        dbPath: args.dbPath,
        target: args.target,
        opencodeRoot: args.opencodeRoot,
        intent: "export-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Exported T3 thread to OpenCode session.\n`);
      process.stdout.write(`Session ID: ${receipt.createdIds.sessionId}\n`);
      process.stdout.write(`Session path: ${receipt.target.path}\n`);
      process.stdout.write(`Messages exported: ${receipt.counts.messages || 0}\n`);
      return;
    }

    if (args.adapter === "claude" && args.command === "list") {
      runClaudeList(args);
      return;
    }

    if (args.adapter === "claude" && args.command === "to-t3") {
      const receipt = convertThread({
        sourceHarness: "claude",
        targetHarness: "t3",
        projectPath: args.projectPath,
        target: args.target,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "import-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Imported Claude session ${receipt.source.id} into T3.\n`);
      process.stdout.write(`Thread ID: ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Thread title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Database: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(`Imported messages: ${receipt.counts.messages || 0}\n`);
      process.stdout.write(`Imported turns: ${receipt.counts.turns || 0}\n`);
      return;
    }

    if (args.adapter === "claude" && args.command === "copy") {
      const receipt = copyThread({
        sourceHarness: "claude",
        targetHarness: "claude",
        projectPath: args.projectPath,
        destProjectPath: args.destProjectPath,
        target: args.target,
        newSessionId: args.newSessionId,
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(
        `Copied Claude session ${receipt.source.id} -> ${receipt.createdIds.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${receipt.source.path}\n`);
      process.stdout.write(`Target file: ${receipt.target.path}\n`);
      return;
    }

    if (args.adapter === "cursor" && args.command === "list") {
      runCursorList(args);
      return;
    }

    if (args.adapter === "cursor" && args.command === "to-t3") {
      const receipt = convertThread({
        sourceHarness: "cursor",
        targetHarness: "t3",
        target: args.target,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "import-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Imported Cursor session ${receipt.source.id} into T3.\n`);
      process.stdout.write(`Thread ID: ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Thread title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Database: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(`Imported messages: ${receipt.counts.messages || 0}\n`);
      process.stdout.write(`Imported turns: ${receipt.counts.turns || 0}\n`);
      return;
    }

    if (args.adapter === "cursor" && args.command === "copy") {
      const receipt = copyThread({
        sourceHarness: "cursor",
        targetHarness: "cursor",
        target: args.target,
        newChatId: args.newChatId,
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Copied Cursor chat ${receipt.source.id} -> ${receipt.createdIds.chatId}\n`);
      process.stdout.write(`Target directory: ${receipt.target.path}\n`);
      return;
    }

    if (args.adapter === "opencode" && args.command === "list") {
      runOpenCodeList(args);
      return;
    }

    if (args.adapter === "opencode" && args.command === "copy") {
      const receipt = copyThread({
        sourceHarness: "opencode",
        targetHarness: "opencode",
        sourceRoot: args.opencodeRoot,
        targetRoot: args.destOpenCodeRoot,
        target: args.target,
        newSessionId: args.newOpenCodeSessionId,
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(
        `Copied OpenCode session ${receipt.source.id} -> ${receipt.createdIds.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${receipt.source.path}\n`);
      process.stdout.write(`Target file: ${receipt.target.path}\n`);
      return;
    }

    if (args.adapter === "opencode" && args.command === "to-t3") {
      const receipt = convertThread({
        sourceHarness: "opencode",
        targetHarness: "t3",
        opencodeRoot: args.opencodeRoot,
        target: args.target,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
        intent: "import-session",
      });
      if (emitJson(args, receipt)) return;
      process.stdout.write(`Imported OpenCode session ${receipt.source.id} into T3.\n`);
      process.stdout.write(`Thread ID: ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Thread title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Database: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(`Imported messages: ${receipt.counts.messages || 0}\n`);
      process.stdout.write(`Imported turns: ${receipt.counts.turns || 0}\n`);
      return;
    }

    fail("Unsupported command combination.");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (argv.includes("--json")) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

module.exports = { runCli, parseArgs, listT3Threads, searchT3Threads, formatMatchExcerpt, readThreadAsIr };
