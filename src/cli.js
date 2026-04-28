const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");
const {
  copyThreadBetweenT3Dbs,
  resolveThreadTarget,
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} = require("./t3-copy");
const {
  DEFAULT_CODEX_ROOT,
  listCodexSessions,
  copyCodexSession,
  resolveCodexSessionTarget,
  parseCodexSession,
} = require("./codex");
const {
  importCodexIntoT3,
  buildT3Export,
  generateCodexSessionFromT3,
} = require("./bridge");
const {
  DEFAULT_CLAUDE_ROOT,
  listClaudeSessions,
  resolveClaudeSession,
  parseClaudeSession,
  parseClaudeSessionWithContext,
  copyClaudeSession,
  exportT3ToClaudeFormat,
} = require("./claude");
const {
  DEFAULT_CURSOR_ROOT,
  listCursorChats,
  resolveCursorChat,
  parseCursorChat,
  buildCursorExport,
  generateCursorSessionFromT3,
  importCursorIntoT3,
} = require("./cursor");
const {
  DEFAULT_OPENCODE_ROOT,
  listOpenCodeSessions,
  resolveOpenCodeSessionTarget,
  parseOpenCodeSession,
  copyOpenCodeSession,
  generateOpenCodeSessionFromT3,
} = require("./opencode");

const DEFAULT_T3_DB_PATH = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
const DEFAULT_T3_SOURCE_DB_PATH = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
const DEFAULT_LIST_LIMIT = 10;

function usage() {
  return `Usage:
  threadbridge t3 list [--db-path PATH] [--limit N]
  threadbridge t3 copy [THREAD_ID|last] [--source-db-path PATH] [--db-path PATH] [--new-thread-id ID] [--title TEXT] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  threadbridge t3 to-codex [THREAD_ID|last] [--db-path PATH] [--root DIR] [--new-session-id ID]
  threadbridge t3 to-claude [THREAD_ID|last] [--db-path PATH] [--project-path DIR]
  threadbridge t3 to-cursor [THREAD_ID|last] [--db-path PATH]
  threadbridge t3 to-opencode [THREAD_ID|last] [--db-path PATH]

  threadbridge codex list [--root DIR] [--limit N] [--include-boilerplate]
  threadbridge codex copy [SESSION_ID|SESSION_PATH|last] [--root DIR] [--dest-root DIR] [--new-session-id ID]
  threadbridge codex to-t3 [SESSION_ID|SESSION_PATH|last] [--root DIR] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

  threadbridge claude list [PROJECT_PATH] [--limit N]
  threadbridge claude copy [SESSION_ID|SESSION_PATH|last] [--project-path DIR] [--dest-project-path DIR] [--new-session-id ID]
  threadbridge claude to-t3 [SESSION_ID|SESSION_PATH|last] [--project-path DIR] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

  threadbridge cursor list [--limit N]
  threadbridge cursor copy [CHAT_ID|last] [--dest-chat-id ID]
  threadbridge cursor to-t3 [CHAT_ID|COMPOSER_ID|last] [--db-path PATH] [--title TEXT] [--workspace-root DIR] [--project-id ID] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  (cursor list shows both ACP sessions [acp] and Composer threads [composer])

  threadbridge opencode list [--root DIR] [--limit N]
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
`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parsePositiveInt(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
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
    copyRuntime: false,
    includeBoilerplate: false,
    backup: true,
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
      token === "--new-opencode-session-id" ||
      token === "--title" ||
      token === "--workspace-root" ||
      token === "--project-id" ||
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
      else if (token === "--root") args.root = next;
      else if (token === "--dest-root") args.destRoot = next;
      else if (token === "--limit") args.limit = parsePositiveInt(token, next);
      else if (token === "--new-thread-id") args.newThreadId = next;
      else if (token === "--new-session-id") args.newSessionId = next;
      else if (token === "--title") args.title = next;
      else if (token === "--workspace-root") args.workspaceRoot = next;
      else if (token === "--project-id") args.projectId = next;
      else if (token === "--busy-timeout-ms") args.busyTimeoutMs = parsePositiveInt(token, next);
      else if (token === "--lock-retries") args.lockRetries = parsePositiveInt(token, next);
      else if (token === "--retry-delay-ms") args.retryDelayMs = parsePositiveInt(token, next);
      else if (token === "--project-path") args.projectPath = next;
      else if (token === "--dest-project-path") args.destProjectPath = next;
      else if (token === "--new-chat-id") args.newChatId = next;
      else if (token === "--opencode-root") args.opencodeRoot = next;
      else if (token === "--dest-opencode-root") args.destOpenCodeRoot = next;
      else if (token === "--new-opencode-session-id") args.newOpenCodeSessionId = next;
      continue;
    }
    if (token.startsWith("--")) fail(`Unknown option: ${token}`);
    positionals.push(token);
  }

  const validT3 = ["list", "copy", "to-codex", "to-claude", "to-cursor", "to-opencode"];
  const validCodex = ["list", "copy", "to-t3"];
  const validClaude = ["list", "copy", "to-t3"];
  const validCursor = ["list", "copy", "to-t3"];
  const validOpenCode = ["list", "copy", "to-t3"];
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

  if (command !== "list") {
    args.target = positionals[0] || "last";
  } else if (positionals.length > 0) {
    fail("`list` does not accept a target.");
  }

  return args;
}

function runT3List({ dbPath, limit }) {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
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
  } finally {
    db.close();
  }
}

function runCodexList({ root, limit, includeBoilerplate }) {
  const sessions = listCodexSessions({ root, limit, includeBoilerplate });
  for (const session of sessions) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.cwd) process.stdout.write(`  cwd: ${session.cwd}\n`);
    if (session.model) process.stdout.write(`  model: ${session.model}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runClaudeList({ projectPath, limit }) {
  const sessions = listClaudeSessions(projectPath || process.cwd(), { limit });
  for (const session of sessions) {
    process.stdout.write(`${session.startedAt}  ${session.id}\n`);
    if (session.workingDir) process.stdout.write(`  cwd: ${session.workingDir}\n`);
    process.stdout.write(`  prompt: ${session.prompt}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runCursorList({ limit }) {
  const chats = listCursorChats({ limit });
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

function runOpenCodeList({ opencodeRoot, limit }) {
  const sessions = listOpenCodeSessions({ root: opencodeRoot, limit });
  for (const session of sessions) {
    process.stdout.write(`${session.createdAt || "unknown"}  ${session.sessionId}\n`);
    if (session.directory) process.stdout.write(`  cwd: ${session.directory}\n`);
    process.stdout.write(`  title: ${session.title}\n`);
    process.stdout.write(`  slug: ${session.slug}\n`);
    process.stdout.write(`  file: ${session.filePath}\n\n`);
  }
}

function runCli(argv) {
  try {
    const args = parseArgs(argv);

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

    if (args.adapter === "t3" && args.command === "copy") {
      const result = copyThreadBetweenT3Dbs({
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
      });
      process.stdout.write(`Copied thread ${result.sourceThreadId} -> ${result.newThreadId}\n`);
      process.stdout.write(`Title: ${result.title}\n`);
      process.stdout.write(`Source DB: ${result.sourceDbPath}\n`);
      process.stdout.write(`Target DB: ${result.targetDbPath}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
      process.stdout.write(
        `Copied rows: messages=${result.counts.messages}, turns=${result.counts.turns}, activities=${result.counts.activities}, proposedPlans=${result.counts.proposedPlans}\n`,
      );
      return;
    }

    if (args.adapter === "codex" && args.command === "copy") {
      const result = copyCodexSession({
        sourceRoot: args.root,
        targetRoot: args.destRoot,
        target: args.target,
        includeBoilerplate: args.includeBoilerplate,
        newSessionId: args.newSessionId,
      });
      process.stdout.write(
        `Copied Codex session ${result.sourceSessionId} -> ${result.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${result.sourceFile}\n`);
      process.stdout.write(`Target file: ${result.targetFile}\n`);
      return;
    }

    if (args.adapter === "codex" && args.command === "to-t3") {
      const sourceFile = resolveCodexSessionTarget({
        root: args.root,
        target: args.target,
        includeBoilerplate: args.includeBoilerplate,
      });
      const codexSession = parseCodexSession(sourceFile, args.includeBoilerplate);
      const result = importCodexIntoT3({
        codexSession,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
      });
      process.stdout.write(`Imported Codex session ${codexSession.sessionId} into T3.\n`);
      process.stdout.write(`Thread ID: ${result.threadId}\n`);
      process.stdout.write(`Thread title: ${result.threadTitle}\n`);
      process.stdout.write(`Database: ${result.dbPath}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
      process.stdout.write(`Imported messages: ${result.messageCount}\n`);
      process.stdout.write(`Imported turns: ${result.turnCount}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-codex") {
      const sourceThreadId = resolveThreadTarget({
        sourceDbPath: args.dbPath,
        target: args.target,
      });

      const t3Export = buildT3Export(sourceThreadId, args.dbPath);
      const result = generateCodexSessionFromT3({
        t3Thread: t3Export,
        targetRoot: args.root,
        sessionId: args.newSessionId,
      });
      process.stdout.write(`Exported T3 thread ${result.sourceThreadId} to Codex session.\n`);
      process.stdout.write(`Session ID: ${result.sessionId}\n`);
      process.stdout.write(`Output file: ${result.outputPath}\n`);
      process.stdout.write(`Messages exported: ${result.messageCount}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-claude") {
      const sourceThreadId = resolveThreadTarget({
        sourceDbPath: args.dbPath,
        target: args.target,
      });

      const t3Export = buildT3Export(sourceThreadId, args.dbPath);
      const result = exportT3ToClaudeFormat({
        t3Thread: t3Export,
        targetRoot: args.projectPath,
        projectPath: args.projectPath,
      });
      process.stdout.write(`Exported T3 thread to Claude session.\n`);
      process.stdout.write(`Session ID: ${result.sessionId}\n`);
      process.stdout.write(`Output file: ${result.outputPath}\n`);
      process.stdout.write(`Messages exported: ${result.messageCount}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-cursor") {
      const sourceThreadId = resolveThreadTarget({
        sourceDbPath: args.dbPath,
        target: args.target,
      });

      const t3Export = buildT3Export(sourceThreadId, args.dbPath);
      const result = generateCursorSessionFromT3({
        t3Thread: t3Export,
        chatId: args.newChatId,
      });
      process.stdout.write(`Exported T3 thread to Cursor chat.\n`);
      process.stdout.write(`Chat ID: ${result.chatId}\n`);
      process.stdout.write(`Chat directory: ${result.chatDir}\n`);
      process.stdout.write(`Messages exported: ${result.messageCount}\n`);
      return;
    }

    if (args.adapter === "t3" && args.command === "to-opencode") {
      const sourceThreadId = resolveThreadTarget({
        sourceDbPath: args.dbPath,
        target: args.target,
      });

      const t3Export = buildT3Export(sourceThreadId, args.dbPath);
      const result = generateOpenCodeSessionFromT3({
        t3Thread: t3Export,
        targetRoot: args.opencodeRoot,
      });
      process.stdout.write(`Exported T3 thread to OpenCode session.\n`);
      process.stdout.write(`Session ID: ${result.sessionId}\n`);
      process.stdout.write(`Session path: ${result.sessionPath}\n`);
      process.stdout.write(`Messages exported: ${result.messageCount}\n`);
      return;
    }

    if (args.adapter === "claude" && args.command === "list") {
      runClaudeList(args);
      return;
    }

  if (args.adapter === "claude" && args.command === "to-t3") {
    const sourceFile = resolveClaudeSession(args.projectPath, args.target);
    const claudeSession = parseClaudeSessionWithContext(sourceFile);
    const result = importCodexIntoT3({
      codexSession: {
        sessionId: claudeSession.sessionId,
        transcript: claudeSession.transcript,
        model: claudeSession.model || "claude-sonnet-4-20250514",
        originalCwd: claudeSession.originalCwd,
        reasoningEffort: null,
        interactionMode: "default",
        runtimeMode: "approval-required",
      },
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
      });
      process.stdout.write(`Imported Claude session ${claudeSession.sessionId} into T3.\n`);
      process.stdout.write(`Thread ID: ${result.threadId}\n`);
      process.stdout.write(`Thread title: ${result.threadTitle}\n`);
      process.stdout.write(`Database: ${result.dbPath}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
      process.stdout.write(`Imported messages: ${result.messageCount}\n`);
      process.stdout.write(`Imported turns: ${result.turnCount}\n`);
      return;
    }

    if (args.adapter === "claude" && args.command === "copy") {
      const result = copyClaudeSession({
        sourceRoot: args.projectPath,
        targetRoot: args.destProjectPath,
        sourceProject: args.projectPath,
        targetProject: args.destProjectPath,
        newSessionId: args.newSessionId,
      });
      process.stdout.write(
        `Copied Claude session ${result.sourceSessionId} -> ${result.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${result.sourceFile}\n`);
      process.stdout.write(`Target file: ${result.targetFile}\n`);
      return;
    }

    if (args.adapter === "cursor" && args.command === "list") {
      runCursorList(args);
      return;
    }

    if (args.adapter === "cursor" && args.command === "to-t3") {
      const chatId = resolveCursorChat(args.target);
      const chat = parseCursorChat(chatId);
      const result = importCursorIntoT3({
        cursorChatId: chatId,
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
      });
      const sourceLabel = chat.source === "composer" ? "Cursor Composer thread" : "Cursor ACP chat";
      process.stdout.write(`Imported ${sourceLabel} ${chat.chatId} into T3.\n`);
      process.stdout.write(`Thread ID: ${result.threadId}\n`);
      process.stdout.write(`Thread title: ${result.threadTitle}\n`);
      process.stdout.write(`Database: ${result.dbPath}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
      process.stdout.write(`Imported messages: ${result.messageCount}\n`);
      process.stdout.write(`Imported turns: ${result.turnCount}\n`);
      return;
    }

    if (args.adapter === "opencode" && args.command === "list") {
      runOpenCodeList(args);
      return;
    }

    if (args.adapter === "opencode" && args.command === "copy") {
      const result = copyOpenCodeSession({
        sourceRoot: args.opencodeRoot,
        targetRoot: args.destOpenCodeRoot,
        target: args.target,
        newSessionId: args.newOpenCodeSessionId,
      });
      process.stdout.write(
        `Copied OpenCode session ${result.sourceSessionId} -> ${result.sessionId}\n`,
      );
      process.stdout.write(`Source file: ${result.sourceFile}\n`);
      process.stdout.write(`Target file: ${result.targetFile}\n`);
      return;
    }

    if (args.adapter === "opencode" && args.command === "to-t3") {
      const sourceFile = resolveOpenCodeSessionTarget({
        root: args.opencodeRoot,
        target: args.target,
      });
      const opencodeSession = parseOpenCodeSession(sourceFile);
      const result = importCodexIntoT3({
        codexSession: {
          sessionId: opencodeSession.sessionId,
          transcript: opencodeSession.transcript,
          model: opencodeSession.model || "kimi-k2.5-free",
          originalCwd: opencodeSession.originalCwd,
          reasoningEffort: null,
          interactionMode: "default",
          runtimeMode: "approval-required",
        },
        dbPath: args.dbPath,
        title: args.title,
        projectId: args.projectId,
        workspaceRoot: args.workspaceRoot,
        backup: args.backup,
        busyTimeoutMs: args.busyTimeoutMs,
        lockRetries: args.lockRetries,
        retryDelayMs: args.retryDelayMs,
      });
      process.stdout.write(`Imported OpenCode session ${opencodeSession.sessionId} into T3.\n`);
      process.stdout.write(`Thread ID: ${result.threadId}\n`);
      process.stdout.write(`Thread title: ${result.threadTitle}\n`);
      process.stdout.write(`Database: ${result.dbPath}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
      process.stdout.write(`Imported messages: ${result.messageCount}\n`);
      process.stdout.write(`Imported turns: ${result.turnCount}\n`);
      return;
    }

    fail("Unsupported command combination.");
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
}

module.exports = { runCli };
