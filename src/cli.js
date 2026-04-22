const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");
const {
  copyThreadBetweenT3Dbs,
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} = require("./t3-copy");

const DEFAULT_T3_DB_PATH = path.join(os.homedir(), ".t3", "userdata", "state.sqlite");
const DEFAULT_T3_SOURCE_DB_PATH = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
const DEFAULT_LIST_LIMIT = 10;

function usage() {
  return `Usage:
  threadbridge t3 list [--db-path PATH] [--limit N]
  threadbridge t3 copy [THREAD_ID|last] [--source-db-path PATH] [--db-path PATH] [--new-thread-id ID] [--title TEXT] [--copy-runtime] [--busy-timeout-ms N] [--lock-retries N] [--retry-delay-ms N] [--no-backup]

Defaults:
  --source-db-path ${DEFAULT_T3_SOURCE_DB_PATH}
  --db-path        ${DEFAULT_T3_DB_PATH}
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
  if (adapter !== "t3") {
    fail(`Unsupported adapter '${adapter}'. Currently supported: t3`);
  }
  if (!["list", "copy"].includes(command)) {
    fail(`Unsupported t3 command '${command}'.`);
  }

  const args = {
    adapter,
    command,
    target: "last",
    dbPath: DEFAULT_T3_DB_PATH,
    sourceDbPath: DEFAULT_T3_SOURCE_DB_PATH,
    limit: DEFAULT_LIST_LIMIT,
    newThreadId: null,
    title: null,
    copyRuntime: false,
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
    if (
      token === "--db-path" ||
      token === "--source-db-path" ||
      token === "--limit" ||
      token === "--new-thread-id" ||
      token === "--title" ||
      token === "--busy-timeout-ms" ||
      token === "--lock-retries" ||
      token === "--retry-delay-ms"
    ) {
      const next = rest[i + 1];
      if (!next) fail(`Missing value for ${token}`);
      i += 1;
      if (token === "--db-path") args.dbPath = next;
      else if (token === "--source-db-path") args.sourceDbPath = next;
      else if (token === "--limit") args.limit = parsePositiveInt(token, next);
      else if (token === "--new-thread-id") args.newThreadId = next;
      else if (token === "--title") args.title = next;
      else if (token === "--busy-timeout-ms") args.busyTimeoutMs = parsePositiveInt(token, next);
      else if (token === "--lock-retries") args.lockRetries = parsePositiveInt(token, next);
      else if (token === "--retry-delay-ms") args.retryDelayMs = parsePositiveInt(token, next);
      continue;
    }
    if (token.startsWith("--")) {
      fail(`Unknown option: ${token}`);
    }
    positionals.push(token);
  }

  if (args.command === "copy") {
    args.target = positionals[0] || "last";
  } else if (positionals.length > 0) {
    fail("`t3 list` does not accept a thread target.");
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

function runCli(argv) {
  try {
    const args = parseArgs(argv);
    if (args.command === "list") {
      runT3List(args);
      return;
    }

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
    if (result.backupPath) {
      process.stdout.write(`Backup: ${result.backupPath}\n`);
    }
    process.stdout.write(
      `Copied rows: messages=${result.counts.messages}, turns=${result.counts.turns}, activities=${result.counts.activities}, proposedPlans=${result.counts.proposedPlans}\n`,
    );
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
}

module.exports = { runCli };
