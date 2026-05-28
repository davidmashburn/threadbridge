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

const DEFAULT_T3_DB_PATH = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
const DEFAULT_T3_SOURCE_DB_PATH = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
const DEFAULT_LIST_LIMIT = 10;

function usage() {
  return `Usage:
  threadbridge t3 list [--db-path PATH] [--limit N]
  threadbridge t3 copy [THREAD_ID|last] [--source-db-path PATH] [--db-path PATH] [--new-thread-id ID] [--title TEXT] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  threadbridge t3 copy-to-workspace [THREAD_ID|last] [--db-path PATH] [--new-project-id ID] [--new-provider PROVIDER] [--new-model MODEL] [--new-model-selection JSON] [--title TEXT] [--new-thread-id ID] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]
  threadbridge t3 to-codex [THREAD_ID|last] [--db-path PATH] [--root DIR] [--new-session-id ID]
  threadbridge t3 to-claude [THREAD_ID|last] [--db-path PATH] [--project-path DIR]
  threadbridge t3 to-cursor [THREAD_ID|last] [--db-path PATH]
  threadbridge t3 to-opencode [THREAD_ID|last] [--db-path PATH] [--root DIR] [--opencode-root DIR]

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
      else if (token === "--new-chat-id") args.newChatId = next;
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

  const validT3 = ["list", "copy", "copy-to-workspace", "to-codex", "to-claude", "to-cursor", "to-opencode"];
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
      process.stdout.write(`Imported Cursor session ${receipt.source.id} into T3.\n`);
      process.stdout.write(`Thread ID: ${receipt.createdIds.threadId}\n`);
      process.stdout.write(`Thread title: ${receipt.details.threadTitle}\n`);
      process.stdout.write(`Database: ${receipt.target.path}\n`);
      if (receipt.backupPath) process.stdout.write(`Backup: ${receipt.backupPath}\n`);
      process.stdout.write(`Imported messages: ${receipt.counts.messages || 0}\n`);
      process.stdout.write(`Imported turns: ${receipt.counts.turns || 0}\n`);
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
    fail(error && error.message ? error.message : String(error));
  }
}

module.exports = { runCli, parseArgs };
