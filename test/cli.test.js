const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { formatMatchExcerpt, parseArgs, searchT3Threads } = require("../src/cli");
const {
  copyCodexSession,
  extractUserText,
  isBoilerplateContentPart,
  listCodexSessions,
  parseCodexSession,
  resolveCodexSessionTarget,
  summarizeToolInput,
} = require("../src/codex");
const { mapTranscriptToTurns, withLockRetries: bridgeWithLockRetries } = require("../src/bridge");
const {
  copyClaudeSession,
  exportT3ToClaudeFormat,
  listClaudeSessions,
  parseClaudeSessionWithContext,
  sanitizeProjectPath,
} = require("../src/claude");
const { generateCursorSessionFromT3, parseCursorChat } = require("../src/cursor");
const {
  copyOpenCodeSession,
  generateOpenCodeSessionFromT3,
  parseOpenCodeSession,
  resolveOpenCodeSessionTarget,
} = require("../src/opencode");
const {
  listAntigravityConversations,
  parseAntigravityConversation,
  parseAntigravityTranscript,
} = require("../src/antigravity");
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

function createAntigravityFixture(root, conversationId = "antigravity-test") {
  const databasePath = path.join(root, "conversations", `${conversationId}.db`);
  const transcriptPath = path.join(
    root,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(databasePath, "placeholder database", "utf8");

  const records = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-08-01T12:00:00.000Z",
      content: "<USER_REQUEST>  First question  </USER_REQUEST><ADDITIONAL_METADATA>private context</ADDITIONAL_METADATA>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-08-01T12:00:01.000Z",
      thinking: "private reasoning must not be copied",
      tool_calls: [{ name: "search" }],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "RUNNING",
      created_at: "2026-08-01T12:00:02.000Z",
      content: "in-progress output",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-08-01T12:00:03.000Z",
      content: "tool result",
    },
    {
      step_index: 4,
      source: "SYSTEM",
      type: "CHECKPOINT",
      status: "DONE",
      created_at: "2026-08-01T12:00:04.000Z",
      content: "system checkpoint must not be copied",
    },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-08-01T12:00:05.000Z",
      thinking: "more private reasoning",
      content: "visible answer",
    },
    {
      step_index: 6,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-08-01T12:00:06.000Z",
      content: "<USER_REQUEST>Follow-up</USER_REQUEST><USER_SETTINGS_CHANGE>{}</USER_SETTINGS_CHANGE>",
    },
  ];
  fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { databasePath, transcriptPath, records };
}

test("Antigravity transcript parser preserves visible turns and omits private/system records", () => {
  withTempDir("threadbridge-antigravity-parse-", (root) => {
    const conversationId = "antigravity-test";
    const fixture = createAntigravityFixture(root, conversationId);
    const session = parseAntigravityConversation({ root, target: conversationId });

    assert.equal(session.databasePath, fixture.databasePath);
    assert.deepEqual(
      session.transcript.map((message) => [message.role, message.text, message.phase]),
      [
        ["user", "First question", "user-input"],
        ["assistant", "tool result", "tool-result"],
        ["assistant", "visible answer", "message"],
        ["user", "Follow-up", "user-input"],
      ],
    );
    assert.equal(session.extensions.antigravity.recordCount, fixture.records.length);
    assert.equal(session.extensions.antigravity.skippedInProgress, 1);
    assert.equal(session.extensions.antigravity.skippedPrivateOrSystem, 2);
  });
});

test("Antigravity list and CLI show resolve a conversation by exact id", () => {
  withTempDir("threadbridge-antigravity-show-", (root) => {
    const conversationId = "antigravity-show";
    createAntigravityFixture(root, conversationId);
    const listed = listAntigravityConversations({ root, limit: 10 });
    assert.deepEqual(listed.map((conversation) => conversation.id), [conversationId]);

    const args = parseArgs(["antigravity", "show", conversationId, "--root", root]);
    assert.equal(args.antigravityRoot, root);

    const result = runCliProcess(["antigravity", "show", conversationId, "--root", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.source.harness, "antigravity");
    assert.equal(output.data.source.sourceId, conversationId);
    assert.equal(output.data.messages.length, 4);
    assert.equal(output.data.messages.some((message) => message.text.includes("system checkpoint")), false);
    assert.equal(output.data.messages.some((message) => message.text.includes("private reasoning")), false);
  });
});

test("Antigravity to-t3 imports the canonical IR transcript", () => {
  withTempDir("threadbridge-antigravity-import-", (root) => {
    const conversationId = "antigravity-import";
    createAntigravityFixture(root, conversationId);
    const dbPath = path.join(root, "target.sqlite");
    const db = new DatabaseSync(dbPath);
    createMinimalT3Schema(db);
    db.close();

    const result = runCliProcess([
      "antigravity",
      "to-t3",
      conversationId,
      "--root",
      root,
      "--db-path",
      dbPath,
      "--workspace-root",
      "/tmp/antigravity-import-project",
      "--no-backup",
      "--json",
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.command, "antigravity to-t3");
    assert.equal(output.data.source.id, conversationId);
    assert.equal(output.data.counts.messages, 4);
    assert.equal(output.data.counts.turns, 2);

    const targetDb = new DatabaseSync(dbPath, { readonly: true });
    try {
      const thread = targetDb
        .prepare("SELECT title, project_id FROM projection_threads WHERE thread_id = ?")
        .get(output.data.createdIds.threadId);
      assert.equal(thread.title, "First question");
      const modelSelection = targetDb
        .prepare("SELECT model_selection_json FROM projection_threads WHERE thread_id = ?")
        .get(output.data.createdIds.threadId);
      assert.equal(typeof modelSelection.model_selection_json, "string");
      assert.equal(typeof JSON.parse(modelSelection.model_selection_json), "object");
      const messages = targetDb
        .prepare("SELECT role, text FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at, message_id")
        .all(output.data.createdIds.threadId);
      assert.deepEqual(messages.map((message) => [message.role, message.text]), [
        ["user", "First question"],
        ["assistant", "tool result"],
        ["assistant", "visible answer"],
        ["user", "Follow-up"],
      ]);
    } finally {
      targetDb.close();
    }
  });
});

test("Antigravity to-t3 inherits the target project's model selection", () => {
  withTempDir("threadbridge-antigravity-project-default-", (root) => {
    const conversationId = "antigravity-project-default";
    createAntigravityFixture(root, conversationId);
    const dbPath = path.join(root, "target.sqlite");
    const db = new DatabaseSync(dbPath);
    createMinimalT3Schema(db);
    db.prepare(
      "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      "target-project",
      "Target Project",
      "/tmp/antigravity-project-default",
      JSON.stringify({ instanceId: "codex", model: "gpt-5.4" }),
      "[]",
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:00.000Z",
    );
    db.close();

    const result = runCliProcess([
      "antigravity",
      "to-t3",
      conversationId,
      "--root",
      root,
      "--db-path",
      dbPath,
      "--workspace-root",
      "/tmp/antigravity-project-default",
      "--project-id",
      "target-project",
      "--no-backup",
      "--json",
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    const targetDb = new DatabaseSync(dbPath, { readonly: true });
    try {
      const row = targetDb
        .prepare("SELECT model_selection_json FROM projection_threads WHERE thread_id = ?")
        .get(output.data.createdIds.threadId);
      assert.equal(row.model_selection_json, JSON.stringify({ instanceId: "codex", model: "gpt-5.4" }));
    } finally {
      targetDb.close();
    }
  });
});

test("t3 show reads orchestration v2 projection threads", () => {
  withTempDir("threadbridge-t3-v2-show-", (root) => {
    const dbPath = path.join(root, "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT,
          workspace_root TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT,
          runtime_mode TEXT,
          interaction_mode TEXT,
          provider_instance_id TEXT,
          payload_json TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT,
          role TEXT,
          payload_json TEXT,
          streaming INTEGER,
          created_at TEXT,
          updated_at TEXT,
          run_id TEXT
        );
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT,
          ordinal INTEGER,
          status TEXT,
          requested_at TEXT,
          started_at TEXT,
          completed_at TEXT
        );
      `);
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("project-v2", "V2 Project", "/tmp/v2", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, provider_instance_id,
          payload_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        "thread-v2",
        "project-v2",
        "V2 thread",
        "approval-required",
        "default",
        "claudeAgent",
        JSON.stringify({ branch: "main", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-7" } }),
        "2026-07-01T00:00:00.000Z",
        "2026-07-02T00:00:00.000Z",
      );
      db.prepare(`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, payload_json, streaming, created_at, updated_at, run_id
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        "msg-1",
        "thread-v2",
        "user",
        JSON.stringify({ text: "hello v2" }),
        "2026-07-01T00:00:01.000Z",
        "2026-07-01T00:00:01.000Z",
        "run-1",
      );
      db.prepare(`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, status, requested_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "run-1",
        "thread-v2",
        1,
        "completed",
        "2026-07-01T00:00:01.000Z",
        "2026-07-01T00:00:01.000Z",
        "2026-07-01T00:00:02.000Z",
      );
    } finally {
      db.close();
    }

    const { readT3ThreadAsIr } = require("../src/adapters/t3/read");
    const ir = readT3ThreadAsIr({ dbPath, target: "thread-v2" });
    assert.equal(ir.thread.threadId, "thread-v2");
    assert.ok(ir.extensions.t3OrchestrationV2);
    assert.equal(ir.messages.length, 1);
    assert.equal(ir.messages[0].text, "hello v2");
    assert.equal(ir.turns.length, 1);
  });
});

test("copyThreadToNewWorkspace rejects unverified orchestration v2 target schemas", () => {
  withTempDir("threadbridge-t3-v2-copyws-", (root) => {
    const dbPath = path.join(root, "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      createMinimalT3Schema(db);
      db.exec(`
        CREATE TABLE orchestration_v2_projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT,
          runtime_mode TEXT,
          interaction_mode TEXT,
          provider_instance_id TEXT,
          payload_json TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT,
          role TEXT,
          payload_json TEXT,
          streaming INTEGER,
          created_at TEXT,
          updated_at TEXT,
          run_id TEXT
        );
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT,
          ordinal INTEGER,
          status TEXT,
          requested_at TEXT,
          completed_at TEXT
        );
        CREATE TABLE orchestration_v2_legacy_imports (
          thread_id TEXT PRIMARY KEY,
          source_updated_at TEXT NOT NULL,
          shell_imported_at TEXT NOT NULL,
          transcript_imported_at TEXT,
          imported_message_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
      `);
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run("project-source", "Source", "/tmp/source", null, "[]", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run("project-target", "Target", "/tmp/target", null, "[]", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, provider_instance_id,
          payload_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        "thread-v2-only",
        "project-source",
        "V2 only",
        "approval-required",
        "default",
        "claudeAgent",
        JSON.stringify({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-7" } }),
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      );
      db.prepare(`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, payload_json, streaming, created_at, updated_at, run_id
        ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
      `).run(
        "msg-v2",
        "thread-v2-only",
        "user",
        JSON.stringify({ text: "copy me" }),
        "2026-07-01T00:00:01.000Z",
        "2026-07-01T00:00:01.000Z",
      );
    } finally {
      db.close();
    }

    assert.throws(() => copyThreadToNewWorkspace({
      dbPath, target: "thread-v2-only", newThreadId: "explicit-copy-id", backup: false,
    }), /Unsupported T3 v2 storage/);
    const targetDb = new DatabaseSync(dbPath, { readonly: true });
    try {
      assert.equal(targetDb.prepare("SELECT COUNT(*) AS n FROM projection_threads").get().n, 0);
    } finally { targetDb.close(); }
  });
});

test("t3 read uses v1 only while a v2 shell awaits transcript migration", () => {
  withTempDir("threadbridge-t3-dual-", (root) => {
    const dbPath = path.join(root, "dual.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      createMinimalT3Schema(db);
      db.exec(`
        CREATE TABLE orchestration_v2_projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT,
          runtime_mode TEXT,
          interaction_mode TEXT,
          provider_instance_id TEXT,
          payload_json TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT,
          role TEXT,
          payload_json TEXT,
          streaming INTEGER,
          created_at TEXT,
          updated_at TEXT,
          run_id TEXT
        );
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT,
          ordinal INTEGER,
          status TEXT,
          requested_at TEXT,
          completed_at TEXT
        );
      `);
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("project-dual", "Dual", "/tmp/dual", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(
        "INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at, runtime_mode, interaction_mode) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      ).run("thread-dual", "project-dual", "Dual thread", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "approval-required", "default");
      db.prepare(
        "INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      ).run("v1-msg", "thread-dual", "user", "from v1", "2026-07-01T00:00:01.000Z", "2026-07-01T00:00:01.000Z");
      db.prepare(`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, provider_instance_id,
          payload_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        "thread-dual",
        "project-dual",
        "Dual thread v2 title",
        "approval-required",
        "default",
        "claudeAgent",
        "{}",
        "2026-07-01T00:00:00.000Z",
        "2026-07-02T00:00:00.000Z",
      );
      db.prepare(`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, payload_json, streaming, created_at, updated_at, run_id
        ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
      `).run(
        "v2-msg",
        "thread-dual",
        "user",
        JSON.stringify({ text: "from v2" }),
        "2026-07-01T00:00:02.000Z",
        "2026-07-01T00:00:02.000Z",
      );
    } finally {
      db.close();
    }

    const { readT3ThreadAsIr } = require("../src/adapters/t3/read");
    const ir = readT3ThreadAsIr({ dbPath, target: "thread-dual" });
    assert.ok(ir.extensions.t3OrchestrationV2);
    assert.equal(ir.messages[0].text, "from v2");
    assert.equal(ir.capabilities.supportsLosslessClone, false);

    const migrationDb = new DatabaseSync(dbPath);
    try {
      migrationDb.exec(`
        CREATE TABLE orchestration_v2_legacy_imports (
          thread_id TEXT PRIMARY KEY,
          transcript_imported_at TEXT
        );
        INSERT INTO orchestration_v2_legacy_imports VALUES ('thread-dual', NULL);
      `);
      const pending = readT3ThreadAsIr({ dbPath, target: "thread-dual" });
      assert.ok(pending.extensions.t3Snapshot);
      assert.equal(pending.messages[0].text, "from v1");

      migrationDb.exec("UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = '2026-07-02T00:00:00.000Z'");
      const completed = readT3ThreadAsIr({ dbPath, target: "thread-dual" });
      assert.ok(completed.extensions.t3OrchestrationV2);
      assert.equal(completed.messages[0].text, "from v2");
    } finally {
      migrationDb.close();
    }
  });
});

test("t3 search matches orchestration v2 message bodies", () => {
  withTempDir("threadbridge-t3-v2-search-", (root) => {
    const dbPath = path.join(root, "statev2.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT,
          workspace_root TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT,
          runtime_mode TEXT,
          interaction_mode TEXT,
          provider_instance_id TEXT,
          payload_json TEXT,
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT,
          role TEXT,
          payload_json TEXT,
          streaming INTEGER,
          created_at TEXT,
          updated_at TEXT,
          run_id TEXT
        );
      `);
      db.prepare(
        "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("p1", "P", "/tmp", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, provider_instance_id,
          payload_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run("only-v2", "p1", "Unrelated title", "approval-required", "default", null, "{}", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      db.prepare(`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, payload_json, streaming, created_at, updated_at, run_id
        ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
      `).run("m1", "only-v2", "assistant", JSON.stringify({ text: "unique-v2-body-token" }), "2026-07-01T00:00:01.000Z", "2026-07-01T00:00:01.000Z");
    } finally {
      db.close();
    }

    const rows = searchT3Threads({ dbPath, limit: 5, query: "unique-v2-body-token" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].threadId, "only-v2");
    assert.equal(rows[0].matchedRole, "assistant");
  });
});

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
  const output = JSON.parse(result.stdout);
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

test("isBoilerplateContentPart matches any self-closing harness block, not a fixed list", () => {
  assert.equal(isBoilerplateContentPart("<environment_context>\ncwd\n</environment_context>"), true);
  // A tag the harness introduced after this code was written.
  assert.equal(isBoilerplateContentPart("<recommended_plugins>\nAirtable\n</recommended_plugins>"), true);
  assert.equal(isBoilerplateContentPart("# AGENTS.md instructions for /repo"), true);
  assert.equal(isBoilerplateContentPart("Please fix the failing test"), false);
  assert.equal(isBoilerplateContentPart("Compare <a> and <b> in the parser"), false);
});

test("extractUserText keeps the prompt when it shares a message with injected context", () => {
  const content = [
    { type: "input_text", text: "<recommended_plugins>\nAirtable\n</recommended_plugins>" },
    { type: "input_text", text: "Make a new ticket for Page Shuffle" },
    { type: "input_text", text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>" },
  ];
  assert.equal(extractUserText(content), "Make a new ticket for Page Shuffle");
  assert.equal(extractUserText(content, true).includes("recommended_plugins"), true);
});

test("summarizeToolInput recovers a shell command and falls back to the raw source", () => {
  const wrapped = 'const r = await tools.exec_command({"cmd":"just lint main ui","workdir":"/repo"});';
  assert.deepEqual(summarizeToolInput(wrapped), { command: "just lint main ui" });
  assert.deepEqual(summarizeToolInput('await tools.view_image({path:"/tmp/a.png"})'), {
    source: 'await tools.view_image({path:"/tmp/a.png"})',
  });
});

test("parseCodexSession carries tool calls and reports what it dropped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-codex-tools-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "s1", timestamp: "2026-05-15T12:00:00.000Z" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ text: "run the linter" }] },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "c1",
          input: 'await tools.exec_command({"cmd":"just lint main ui"});',
        },
      },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "x".repeat(5000) } },
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
    ];
    fs.writeFileSync(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const session = parseCodexSession(sessionPath);
    const toolCalls = session.transcript.filter((entry) => entry.phase === "tool-call");
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(toolCalls[0].content[0].input, { command: "just lint main ui" });
    assert.equal(toolCalls[0].content[0].toolCallId, "c1");
    // The 5000-character output must not ride along.
    assert.equal(JSON.stringify(session.transcript).includes("xxxxx"), false);
    assert.equal(
      session.warnings.some((w) => w.includes("1 tool result")),
      true,
    );
    assert.equal(
      session.warnings.some((w) => w.includes("1 reasoning item")),
      true,
    );

    const withoutTools = parseCodexSession(sessionPath, false, { includeToolCalls: false });
    assert.equal(withoutTools.transcript.filter((e) => e.phase === "tool-call").length, 0);
    assert.equal(
      withoutTools.warnings.some((w) => w.includes("1 tool call(s) because tool calls were disabled")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarizeToolInput normalizes structured and string tool inputs", () => {
  const { summarizeToolInput } = require("../src/ir");
  assert.deepEqual(summarizeToolInput({ command: "just lint main ui" }), { command: "just lint main ui" });
  assert.deepEqual(summarizeToolInput({ pattern: "**/*.js" }), { source: '{"pattern":"**/*.js"}' });
  assert.deepEqual(summarizeToolInput({}), {});
  assert.equal(summarizeToolInput({ command: "x".repeat(2000) }).command.length, 1000);
});

test("extractPlainTextFromBlocks renders tool calls so text-only writers keep them", () => {
  const { extractPlainTextFromBlocks } = require("../src/ir");
  assert.equal(
    extractPlainTextFromBlocks([{ type: "tool-call", toolName: "exec", input: { command: "ls -la" } }]),
    "$ ls -la",
  );
  assert.equal(
    extractPlainTextFromBlocks([{ type: "tool-call", toolName: "glob", input: { source: '{"p":1}' } }]),
    '[glob] {"p":1}',
  );
});

test("sanitizeProjectPath keeps the leading dash Claude Code uses for project directories", () => {
  assert.equal(sanitizeProjectPath("/Users/x/repo"), "-Users-x-repo");
});

test("parseClaudeSessionWithContext carries tool_use blocks and drops results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-claude-tools-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    const records = [
      {
        type: "user",
        sessionId: "s1",
        cwd: "/repo",
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "run the linter" }] },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-05-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "just lint main ui" } },
          ],
        },
      },
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-05-15T12:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(4000) }] },
      },
    ];
    fs.writeFileSync(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const session = parseClaudeSessionWithContext(sessionPath);
    const calls = session.transcript.filter((e) => e.phase === "tool-call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].content[0].input, { command: "just lint main ui" });
    assert.equal(session.originalCwd, "/repo");
    assert.equal(JSON.stringify(session.transcript).includes("yyyyy"), false);
    assert.equal(session.warnings.some((w) => w.includes("1 tool result")), true);
    assert.equal(session.warnings.some((w) => w.includes("1 thinking block")), true);
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
