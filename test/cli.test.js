const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { formatMatchExcerpt, parseArgs, searchT3Threads } = require("../src/cli");
const { copyCodexSession, listCodexSessions, resolveCodexSessionTarget } = require("../src/codex");
const { mapTranscriptToTurns, withLockRetries: bridgeWithLockRetries } = require("../src/bridge");
const {
  copyClaudeSession,
  exportT3ToClaudeFormat,
  listClaudeSessions,
  sanitizeProjectPath,
} = require("../src/claude");
const { generateCursorSessionFromT3, parseCursorChat } = require("../src/cursor");
const {
  copyOpenCodeSession,
  generateOpenCodeSessionFromT3,
  parseOpenCodeSession,
  resolveOpenCodeSessionTarget,
} = require("../src/opencode");
const { importCodexIntoT3 } = require("../src/bridge");
const { copyThreadToNewWorkspace, withLockRetries } = require("../src/t3-copy");
const { DatabaseSync } = require("node:sqlite");

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCliProcess(args) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "threadbridge.js"), ...args], {
    encoding: "utf8",
  });
}

function createMinimalT3Schema(db) {
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_root TEXT,
      default_model_selection_json TEXT,
      scripts_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      model_selection_json TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      latest_user_message_at TEXT,
      archived_at TEXT,
      deleted_at TEXT,
      pending_approval_count INTEGER,
      pending_user_input_count INTEGER,
      has_actionable_proposed_plan INTEGER
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      role TEXT,
      text TEXT,
      attachments_json TEXT,
      is_streaming INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      turn_id TEXT,
      pending_message_id TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      assistant_message_id TEXT,
      state TEXT,
      requested_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      tone TEXT,
      kind TEXT,
      summary TEXT,
      payload_json TEXT,
      sequence INTEGER,
      created_at TEXT
    );
    CREATE TABLE projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      plan_markdown TEXT,
      created_at TEXT,
      updated_at TEXT,
      implemented_at TEXT,
      implementation_thread_id TEXT
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT,
      runtime_mode TEXT
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT,
      adapter_key TEXT,
      runtime_mode TEXT,
      status TEXT,
      last_seen_at TEXT,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    );
  `);
}

test("t3 search finds message-body matches and ranks title matches first", () => {
  withTempDir("threadbridge-t3-search-", (root) => {
    const dbPath = path.join(root, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      createMinimalT3Schema(db);
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("project-1", "Reviews", "/tmp/reviews", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

      const insertThread = db.prepare(
        "INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
      );
      insertThread.run("title-hit", "project-1", "PLAT-403 review", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      insertThread.run("message-hit", "project-1", "Per-segment review", "2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z");
      insertThread.run("no-hit", "project-1", "Unrelated", "2026-07-04T00:00:00.000Z", "2026-07-04T00:00:00.000Z");

      db.prepare(
        "INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      ).run(
        "message-1",
        "message-hit",
        "assistant",
        "The PLAT-403 empty-list regression still stands.",
        "2026-07-03T00:00:00.000Z",
        "2026-07-03T00:00:00.000Z",
      );
    } finally {
      db.close();
    }

    const rows = searchT3Threads({ dbPath, limit: 10, query: "PLAT-403" });
    assert.deepEqual(rows.map((row) => row.threadId), ["title-hit", "message-hit"]);
    assert.equal(rows[0].matchedText, null);
    assert.equal(rows[1].matchedRole, "assistant");
    assert.match(rows[1].matchedText, /empty-list regression/);
  });
});

test("formatMatchExcerpt centers and normalizes a message match", () => {
  const excerpt = formatMatchExcerpt(`before\n${"x".repeat(100)} PLAT-403 after`, "PLAT-403", 60);
  assert.match(excerpt, /^…/);
  assert.match(excerpt, /PLAT-403/);
});

test("list --json returns a stable success envelope", () => {
  withTempDir("threadbridge-json-list-", (root) => {
    const sessionDir = path.join(root, "2026", "07", "14");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "agent-session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "agent-session", timestamp: "2026-07-14T12:00:00.000Z", cwd: "/tmp/agent" },
          timestamp: "2026-07-14T12:00:00.000Z",
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ text: "Agent-readable output" }] },
          timestamp: "2026-07-14T12:00:01.000Z",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = runCliProcess(["codex", "list", "--root", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.command, "codex list");
    assert.equal(output.data[0].id, "agent-session");
  });
});

test("show --json emits canonical Threadbridge IR", () => {
  withTempDir("threadbridge-json-show-", (root) => {
    const sessionDir = path.join(root, "2026", "07", "14");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "show-session.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "show-session", timestamp: "2026-07-14T12:00:00.000Z", cwd: "/tmp/show" },
          timestamp: "2026-07-14T12:00:00.000Z",
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ text: "Inspect this thread" }] },
          timestamp: "2026-07-14T12:00:01.000Z",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = runCliProcess(["codex", "show", "last", "--root", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.data.schemaVersion, "1.0");
    assert.equal(output.data.source.sourceId, "show-session");
    assert.equal(output.data.messages[0].text, "Inspect this thread");
  });
});

test("--json formats CLI failures for programmatic handling", () => {
  const result = runCliProcess(["unknown", "list", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr);
  assert.equal(output.ok, false);
  assert.match(output.error.message, /Unsupported adapter/);
});

test("opencode commands map generic root flags to OpenCode roots", () => {
  const args = parseArgs([
    "opencode",
    "copy",
    "last",
    "--root",
    "/tmp/source-root",
    "--dest-root",
    "/tmp/dest-root",
    "--new-session-id",
    "ses_test",
  ]);

  assert.equal(args.target, "last");
  assert.equal(args.root, "/tmp/source-root");
  assert.equal(args.destRoot, "/tmp/dest-root");
  assert.equal(args.opencodeRoot, "/tmp/source-root");
  assert.equal(args.destOpenCodeRoot, "/tmp/dest-root");
  assert.equal(args.newSessionId, "ses_test");
  assert.equal(args.newOpenCodeSessionId, "ses_test");
});

test("t3 to-opencode accepts root as the OpenCode destination root", () => {
  const args = parseArgs([
    "t3",
    "to-opencode",
    "last",
    "--db-path",
    "/tmp/state.sqlite",
    "--root",
    "/tmp/opencode-storage",
  ]);

  assert.equal(args.dbPath, "/tmp/state.sqlite");
  assert.equal(args.root, "/tmp/opencode-storage");
  assert.equal(args.opencodeRoot, "/tmp/opencode-storage");
});

test("cursor copy accepts the documented destination chat id flag", () => {
  const args = parseArgs(["cursor", "copy", "last", "--dest-chat-id", "cursor-target"]);
  assert.equal(args.newChatId, "cursor-target");
});

test("resolveOpenCodeSessionTarget throws a clear error when the root is empty", () => {
  withTempDir("threadbridge-opencode-empty-", (tempRoot) => {
    assert.throws(
      () => resolveOpenCodeSessionTarget({ root: tempRoot, target: "last" }),
      /No OpenCode sessions found under/,
    );
  });
});

test("resolveCodexSessionTarget reports ambiguous targets", () => {
  withTempDir("threadbridge-codex-ambiguous-", (root) => {
    const nested = path.join(root, "2026", "05", "15");
    fs.mkdirSync(nested, { recursive: true });
    for (const id of ["alpha-one", "alpha-two"]) {
      fs.writeFileSync(
        path.join(nested, `${id}.jsonl`),
        JSON.stringify({
          type: "session_meta",
          payload: { id, timestamp: "2026-05-15T12:00:00.000Z" },
          timestamp: "2026-05-15T12:00:00.000Z",
        }) + "\n",
        "utf8",
      );
    }
    assert.throws(
      () => resolveCodexSessionTarget({ root, target: "alpha" }),
      /Codex target is ambiguous/,
    );
  });
});

test("resolveThreadTarget reports missing threads", () => {
  withTempDir("threadbridge-t3-missing-", (root) => {
    const dbPath = path.join(root, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE projection_threads (
          thread_id TEXT,
          title TEXT,
          created_at TEXT,
          deleted_at TEXT
        );
      `);
      const { resolveThreadTarget } = require("../src/t3-copy");
      assert.throws(
        () => resolveThreadTarget({ sourceDbPath: dbPath, target: "last" }),
        /No threads found in source DB/,
      );
    } finally {
      db.close();
    }
  });
});

test("Claude export writes under the requested target root and remains listable", () => {
  withTempDir("threadbridge-claude-export-", (tempRoot) => {
    const projectPath = "/tmp/example-project";
    const result = exportT3ToClaudeFormat({
      t3Thread: {
        threadId: "thread-123",
        title: "Imported Thread",
        workspaceRoot: projectPath,
        createdAt: "2026-05-15T12:00:00.000Z",
        modelSelection: { model: "claude-sonnet-4-20250514" },
        messages: [
          { role: "user", text: "hello", createdAt: "2026-05-15T12:00:01.000Z" },
          { role: "assistant", text: "world", createdAt: "2026-05-15T12:00:02.000Z" },
        ],
      },
      targetRoot: tempRoot,
      projectPath,
    });

    const expectedStorageRoot = path.join(tempRoot, sanitizeProjectPath(projectPath));
    assert.match(result.outputPath, new RegExp(`^${escapeRegex(expectedStorageRoot)}`));

    const sessions = listClaudeSessions(expectedStorageRoot, { limit: 5 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "thread-123");
  });
});

test("Claude copy respects the requested target root", () => {
  withTempDir("threadbridge-claude-source-", (sourceRoot) => {
    withTempDir("threadbridge-claude-target-", (targetRoot) => {
      const sourceProjectPath = "/tmp/source-project";
      exportT3ToClaudeFormat({
        t3Thread: {
          threadId: "thread-abc",
          title: "Source Thread",
          workspaceRoot: sourceProjectPath,
          createdAt: "2026-05-15T12:00:00.000Z",
          modelSelection: { model: "claude-sonnet-4-20250514" },
          messages: [
            { role: "user", text: "copy me", createdAt: "2026-05-15T12:00:01.000Z" },
          ],
        },
        targetRoot: sourceRoot,
        projectPath: sourceProjectPath,
      });

      const sourceStorageRoot = path.join(sourceRoot, sanitizeProjectPath(sourceProjectPath));
      const result = copyClaudeSession({
        target: "last",
        sourceRoot: sourceStorageRoot,
        targetRoot,
        targetProject: "/tmp/target-project",
        newSessionId: "tb-copy-test",
      });

      const expectedTargetRoot = path.join(targetRoot, sanitizeProjectPath("/tmp/target-project"));
      assert.match(result.targetFile, new RegExp(`^${escapeRegex(expectedTargetRoot)}`));
      assert.ok(fs.existsSync(result.targetFile));
    });
  });
});

test("Codex copy respects the requested target root and remains listable", () => {
  withTempDir("threadbridge-codex-source-", (sourceRoot) => {
    withTempDir("threadbridge-codex-target-", (targetRoot) => {
      const sourceFile = path.join(sourceRoot, "2026", "05", "15", "tb-source.jsonl");
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(
        sourceFile,
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "tb-source",
              timestamp: "2026-05-15T12:00:00.000Z",
              cwd: "/tmp/codex-project",
            },
            timestamp: "2026-05-15T12:00:00.000Z",
          }),
          JSON.stringify({
            type: "turn_context",
            payload: {
              cwd: "/tmp/codex-project",
              model: "gpt-5.4",
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ text: "Ship this" }],
            },
            timestamp: "2026-05-15T12:00:01.000Z",
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const result = copyCodexSession({
        sourceRoot,
        targetRoot,
        target: "last",
        newSessionId: "tb-copied",
      });

      assert.match(result.targetFile, new RegExp(`^${escapeRegex(targetRoot)}`));
      assert.ok(fs.existsSync(result.targetFile));

      const sessions = listCodexSessions({ root: targetRoot, limit: 5 });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, "tb-copied");
    });
  });
});

test("OpenCode export and parse honor the requested custom root", () => {
  withTempDir("threadbridge-opencode-root-", (tempRoot) => {
    const result = generateOpenCodeSessionFromT3({
      t3Thread: {
        threadId: "thread-open-1",
        title: "OpenCode Thread",
        workspaceRoot: "/tmp/opencode-project",
        createdAt: "2026-05-15T12:00:00.000Z",
        modelSelection: { model: "kimi-k2.5-free" },
        messages: [
          { role: "user", text: "hello opencode" },
          { role: "assistant", text: "hi there" },
        ],
      },
      targetRoot: tempRoot,
      sessionId: "ses_test_open",
    });

    const parsed = parseOpenCodeSession(result.sessionPath, { root: tempRoot });
    assert.equal(parsed.sessionId, "ses_test_open");
    assert.equal(parsed.transcript.length, 2);
    assert.equal(parsed.transcript[0].text, "hello opencode");
    assert.equal(parsed.transcript[1].text, "hi there");
  });
});

test("OpenCode copy respects custom source and target roots", () => {
  withTempDir("threadbridge-opencode-source-", (sourceRoot) => {
    withTempDir("threadbridge-opencode-target-", (targetRoot) => {
      generateOpenCodeSessionFromT3({
        t3Thread: {
          threadId: "thread-open-2",
          title: "OpenCode Copy Source",
          workspaceRoot: "/tmp/opencode-copy-project",
          createdAt: "2026-05-15T12:00:00.000Z",
          modelSelection: { model: "kimi-k2.5-free" },
          messages: [
            { role: "user", text: "copy this session" },
            { role: "assistant", text: "copied" },
          ],
        },
        targetRoot: sourceRoot,
        sessionId: "ses_source_open",
      });

      const result = copyOpenCodeSession({
        sourceRoot,
        targetRoot,
        target: "last",
        newSessionId: "ses_target_open",
      });

      assert.match(result.targetFile, new RegExp(`^${escapeRegex(targetRoot)}`));
      assert.ok(fs.existsSync(result.targetFile));

      const parsed = parseOpenCodeSession(result.targetFile, { root: targetRoot });
      assert.equal(parsed.sessionId, "ses_target_open");
      assert.equal(parsed.transcript.length, 2);
      assert.equal(parsed.transcript[0].text, "copy this session");
      assert.equal(parsed.transcript[1].text, "copied");
    });
  });
});

test("Cursor export produces a parseable ACP chat payload", () => {
  withTempDir("threadbridge-cursor-root-", (cursorRoot) => {
    const originalCursorDataDir = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = cursorRoot;
    try {
      const result = generateCursorSessionFromT3({
        t3Thread: {
          threadId: "thread-cursor-1",
          title: "Cursor Thread",
          createdAt: "2026-05-15T12:00:00.000Z",
          messages: [
            { role: "user", text: "cursor hello", createdAt: "2026-05-15T12:00:01.000Z" },
            { role: "assistant", text: "cursor hi", createdAt: "2026-05-15T12:00:02.000Z" },
          ],
        },
        chatId: "cursor_chat_test",
      });

      assert.ok(fs.existsSync(result.chatDir));
      const parsed = parseCursorChat("cursor_chat_test");
      assert.equal(parsed.chatId, "cursor_chat_test");
      assert.equal(parsed.transcript.length, 2);
      assert.equal(parsed.transcript[0].text, "cursor hello");
      assert.equal(parsed.transcript[1].text, "cursor hi");
    } finally {
      process.env.CURSOR_DATA_DIR = originalCursorDataDir;
    }
  });
});

test("cursor copy executes through the CLI and returns a JSON receipt", () => {
  withTempDir("threadbridge-cursor-copy-cli-", (cursorRoot) => {
    const originalCursorDataDir = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = cursorRoot;
    try {
      generateCursorSessionFromT3({
        t3Thread: {
          threadId: "thread-cursor-copy",
          title: "Cursor Copy Source",
          createdAt: "2026-07-14T12:00:00.000Z",
          messages: [{ role: "user", text: "copy via CLI", createdAt: "2026-07-14T12:00:01.000Z" }],
        },
        chatId: "cursor_source_cli",
      });

      const result = runCliProcess([
        "cursor",
        "copy",
        "cursor_source_cli",
        "--new-chat-id",
        "cursor_target_cli",
        "--json",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.data.createdIds.chatId, "cursor_target_cli");
      assert.equal(parseCursorChat("cursor_target_cli").transcript[0].text, "copy via CLI");
    } finally {
      process.env.CURSOR_DATA_DIR = originalCursorDataDir;
    }
  });
});

test("mapTranscriptToTurns creates stable turns for mixed transcripts", () => {
  const { messages, turns } = mapTranscriptToTurns([
    { role: "assistant", text: "preface", timestamp: "2026-05-15T12:00:00.000Z" },
    { role: "user", text: "question", timestamp: "2026-05-15T12:00:01.000Z" },
    { role: "assistant", text: "answer", timestamp: "2026-05-15T12:00:02.000Z" },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].pendingMessageId, null);
  assert.equal(turns[0].assistantMessageId, messages[0].messageId);
  assert.equal(turns[1].pendingMessageId, messages[1].messageId);
  assert.equal(turns[1].assistantMessageId, messages[2].messageId);
});

test("resolveCodexSessionTarget finds the newest session in a nested root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-codex-resolve-"));
  try {
    const nested = path.join(root, "2026", "05", "15");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, "alpha.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "alpha", timestamp: "2026-05-15T12:00:00.000Z" },
        timestamp: "2026-05-15T12:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    assert.equal(resolveCodexSessionTarget({ root, target: "last" }), path.join(nested, "alpha.jsonl"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveThreadTarget finds the most recent thread in a minimal T3 database", () => {
  withTempDir("threadbridge-t3-resolve-", (root) => {
    const dbPath = path.join(root, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE projection_threads (
          thread_id TEXT,
          title TEXT,
          created_at TEXT,
          deleted_at TEXT
        );
      `);
      db.prepare(
        "INSERT INTO projection_threads (thread_id, title, created_at, deleted_at) VALUES (?, ?, ?, NULL)",
      ).run("thread-old", "Old Thread", "2026-05-15T12:00:00.000Z");
      db.prepare(
        "INSERT INTO projection_threads (thread_id, title, created_at, deleted_at) VALUES (?, ?, ?, NULL)",
      ).run("thread-new", "New Thread", "2026-05-15T13:00:00.000Z");

      const { resolveThreadTarget } = require("../src/t3-copy");
      assert.equal(resolveThreadTarget({ sourceDbPath: dbPath, target: "last" }), "thread-new");
      assert.equal(resolveThreadTarget({ sourceDbPath: dbPath, target: "New Thread" }), "thread-new");
    } finally {
      db.close();
    }
  });
});

test("importCodexIntoT3 writes a minimal thread snapshot", () => {
  withTempDir("threadbridge-t3-import-", (root) => {
    const dbPath = path.join(root, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      createMinimalT3Schema(db);

      const result = importCodexIntoT3({
        codexSession: {
          sessionId: "codex-source",
          transcript: [
            { role: "user", text: "hello import", timestamp: "2026-05-15T12:00:00.000Z" },
            { role: "assistant", text: "imported", timestamp: "2026-05-15T12:00:01.000Z" },
          ],
          originalCwd: "/tmp/import-project",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          interactionMode: "default",
          runtimeMode: "approval-required",
        },
        dbPath,
        workspaceRoot: "/tmp/import-project",
        backup: false,
      });

      assert.equal(result.messageCount, 2);
      assert.equal(result.turnCount, 1);
      const threadRow = db.prepare("SELECT * FROM projection_threads WHERE thread_id = ?").get(result.threadId);
      assert.ok(threadRow);
      assert.equal(threadRow.title, "hello import");
    } finally {
      db.close();
    }
  });
});

test("copyThreadToNewWorkspace remaps thread and project ids", () => {
  withTempDir("threadbridge-t3-copy-", (root) => {
    const dbPath = path.join(root, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      createMinimalT3Schema(db);

      const projectId = "project-source";
      const threadId = "thread-source";
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(projectId, "Source Project", "/tmp/source", null, "[]", "2026-05-15T12:00:00.000Z", "2026-05-15T12:00:00.000Z");
      db.prepare(
        "INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at, latest_user_message_at, archived_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)",
      ).run(threadId, projectId, "Source Thread", JSON.stringify({ provider: "codex", model: "gpt-5.4" }), "approval-required", "default", "2026-05-15T12:00:00.000Z", "2026-05-15T12:00:00.000Z");
      db.prepare(
        "INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("msg-1", threadId, null, "user", "hello", "[]", 0, "2026-05-15T12:00:00.000Z", "2026-05-15T12:00:00.000Z");

      const result = copyThreadToNewWorkspace({
        dbPath,
        target: "last",
        newProjectId: "project-target",
        newProvider: "opencode",
        newModel: "opencode/big-pickle",
        backup: false,
      });

      const newThreadRow = db.prepare("SELECT * FROM projection_threads WHERE thread_id = ?").get(result.newThreadId);
      assert.ok(newThreadRow);
      assert.equal(newThreadRow.project_id, "project-target");
      assert.match(newThreadRow.model_selection_json, /opencode\/big-pickle/);
    } finally {
      db.close();
    }
  });
});

test("copyThreadToNewWorkspace rejects a missing database", () => {
  assert.throws(
    () =>
      copyThreadToNewWorkspace({
        dbPath: path.join(os.tmpdir(), "threadbridge-missing.sqlite"),
        target: "last",
        newProjectId: "project-target",
        backup: false,
      }),
    /Database not found/,
  );
});

test("importCodexIntoT3 rejects a missing database", () => {
  assert.throws(
    () =>
      importCodexIntoT3({
        codexSession: {
          sessionId: "codex-source",
          transcript: [],
          originalCwd: "/tmp/import-project",
          model: "gpt-5.4",
          interactionMode: "default",
          runtimeMode: "approval-required",
        },
        dbPath: path.join(os.tmpdir(), "threadbridge-missing-import.sqlite"),
        backup: false,
      }),
    /T3 database not found/,
  );
});

test("withLockRetries retries locked operations", () => {
  let attempts = 0;
  const result = withLockRetries(
    () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("database is locked");
      }
      return "ok";
    },
    { retries: 5, retryDelayMs: 1 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("bridge withLockRetries retries locked operations", () => {
  let attempts = 0;
  const result = bridgeWithLockRetries(
    () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("database busy");
      }
      return "ok";
    },
    { retries: 4, retryDelayMs: 1 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});
