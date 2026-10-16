const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const fixtureRoot = path.join(__dirname, "fixtures", "t3-v0.1.0");
const { readT3ThreadAsIr } = require("../src/adapters/t3/read");
const { listT3Threads, searchT3Threads } = require("../src/adapters/t3/query");

const timestamp = "2026-01-01T00:00:00.000Z";

function run(id, ordinal, status = "completed", threadId = null) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: "codex",
    providerThreadId: null,
    status,
    requestedAt: timestamp,
    startedAt: timestamp,
    completedAt: status === "rolled_back" ? null : timestamp,
  };
}

function turnItem({ id, threadId, runId, ordinal, type = "user_message", text }) {
  return {
    id,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    updatedAt: timestamp,
    type,
    messageId: id,
    text,
    attachments: [],
    inputIntent: "turn_start",
  };
}

function projection({
  id,
  title = id,
  forkedFrom = null,
  runs = [],
  items = [],
  plans = [],
  deletedAt = null,
}) {
  const thread = {
    createdBy: "system",
    creationSource: "server",
    id,
    projectId: "project:fixture",
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: deletedAt,
  };
  return {
    id,
    projection: {
      thread,
      runs: runs.map((value) => ({ ...value, threadId: id })),
      attempts: [],
      messages: items
        .filter((item) => item.type === "user_message" || item.type === "assistant_message")
        .map((item) => ({
          id: item.messageId || item.id,
          threadId: id,
          runId: item.runId,
          nodeId: null,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          attachments: item.attachments || [],
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      plans,
      turnItems: items.map((item) => ({ ...item, threadId: id })),
    },
  };
}

function insertProjection(db, entry) {
  const projectionValue = entry.projection;
  const thread = projectionValue.thread;
  db.prepare(
    `INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      active_provider_thread_id, created_at, updated_at, archived_at, deleted_at,
      payload_json, provider_instance_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    thread.id,
    thread.projectId,
    thread.title,
    thread.providerInstanceId || "codex",
    thread.runtimeMode || "approval-required",
    thread.interactionMode || "default",
    thread.activeProviderThreadId || null,
    thread.createdAt,
    thread.updatedAt,
    thread.archivedAt || null,
    thread.deletedAt || null,
    JSON.stringify(thread),
    thread.providerInstanceId || "codex",
  );

  for (const value of projectionValue.runs || []) {
    db.prepare(
      `INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json, provider_instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id,
      thread.id,
      value.ordinal,
      value.providerInstanceId || "codex",
      value.providerThreadId || null,
      value.status || "completed",
      value.requestedAt || timestamp,
      value.completedAt || null,
      JSON.stringify(value),
      value.providerInstanceId || "codex",
    );
  }

  for (const value of projectionValue.messages || []) {
    db.prepare(
      `INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming,
        created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id,
      thread.id,
      value.runId || null,
      value.nodeId || null,
      value.role,
      value.streaming ? 1 : 0,
      value.createdAt || timestamp,
      value.updatedAt || timestamp,
      JSON.stringify(value),
    );
  }

  for (const value of projectionValue.plans || []) {
    db.prepare(
      `INSERT INTO orchestration_v2_projection_plans (
        plan_id, thread_id, run_id, node_id, kind, status, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id,
      thread.id,
      value.runId || null,
      value.nodeId || `node:${value.id}`,
      value.kind || "proposed_plan",
      value.status || "completed",
      JSON.stringify(value),
    );
  }

  for (const value of projectionValue.turnItems || []) {
    db.prepare(
      `INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id,
        provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id,
      thread.id,
      value.runId || null,
      value.nodeId || null,
      value.providerThreadId || null,
      value.providerTurnId || null,
      value.parentItemId || null,
      value.ordinal,
      value.type,
      value.status || "completed",
      value.updatedAt || timestamp,
      JSON.stringify(value),
    );
  }
}

function insertEvents(db, events) {
  const versions = new Map();
  const insert = db.prepare(
    `INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json,
      metadata_json, application_event_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    const streamVersion = (versions.get(event.threadId) || 0) + 1;
    versions.set(event.threadId, streamVersion);
    insert.run(
      event.id,
      "thread",
      event.threadId,
      streamVersion,
      event.type,
      event.occurredAt || timestamp,
      null,
      null,
      null,
      "system",
      JSON.stringify(event.payload || {}),
      "{}",
      2,
    );
  }
  db.exec(
    `UPDATE orchestration_v2_projection_metadata
     SET schema_version = 2,
         last_sequence = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events),
         updated_at = '${timestamp}'
     WHERE projection_name = 'thread-projections'`,
  );
}

function makeFixtureDb(additional = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-t3-reader-"));
  const dbPath = path.join(root, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(fixtureRoot, "schema.sql"), "utf8"));
  db.prepare(
    `INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "project:fixture",
    "Fixture project",
    "/stock/workspace",
    "{}",
    timestamp,
    timestamp,
  );

  const stockEntries = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "projections.json"), "utf8"),
  );
  for (const entry of [...stockEntries, ...additional]) {
    insertProjection(db, entry);
  }
  const stockEvents = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "events.json"), "utf8"),
  );
  const createdEvents = additional.map((entry) => ({
    id: `event:thread.created:${entry.id}`,
    threadId: entry.id,
    type: "thread.created",
    occurredAt: timestamp,
    payload: entry.projection.thread,
  }));
  insertEvents(db, [...stockEvents, ...createdEvents]);
  db.close();
  return {
    dbPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("reads stock v2 visibility, project workspace, plans, and inherited search", () => {
  const visiblePlan = projection({
    id: "thread:visible-plan",
    runs: [run("run:visible-plan", 1)],
    items: [
      {
        id: "item:visible-plan",
        threadId: "thread:visible-plan",
        runId: "run:visible-plan",
        ordinal: 1,
        status: "completed",
        updatedAt: timestamp,
        type: "proposed_plan",
        planId: "plan:visible",
        markdown: "# Visible plan\nKeep this plan.",
      },
      {
        id: "item:visible-todo",
        threadId: "thread:visible-plan",
        runId: "run:visible-plan",
        ordinal: 2,
        status: "completed",
        updatedAt: timestamp,
        type: "todo_list",
        planId: "plan:todo",
        steps: [{ text: "Draft todo", status: "pending" }],
      },
    ],
  });
  const fixture = makeFixtureDb([visiblePlan]);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare(
      `INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
        created_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "stale-legacy-activity",
      "thread:portable",
      null,
      "info",
      "legacy-only",
      "stale legacy activity",
      JSON.stringify({ stale: true }),
      timestamp,
      1,
    );
  } finally {
    db.close();
  }
  try {
    const fork = readT3ThreadAsIr({ dbPath: fixture.dbPath, target: "thread:fork" });
    assert.equal(fork.thread.workspaceRoot, "/stock/workspace");
    assert.deepEqual(
      fork.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      ["item:parent-first", "turn-item:fork:thread:fork", "item:fork-local"],
    );
    assert.deepEqual(
      fork.messages.map((message) => message.text),
      ["ANCESTOR included", "CHILD local"],
    );
    assert.ok(!fork.messages.some((message) => message.text.includes("LATER")));

    const portable = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:portable",
    });
    assert.equal(portable.messages[0].attachments[0].id, "fixture-image");
    assert.deepEqual(portable.activities, []);
    assert.deepEqual(portable.plans, []);

    const planThread = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:visible-plan",
    });
    assert.equal(planThread.plans[0].planId, "plan:visible");
    assert.match(planThread.plans[0].markdown, /Visible plan/);
    assert.deepEqual(planThread.plans[0].metadata, {
      sourceThreadId: "thread:visible-plan",
      sourceItemId: "item:visible-plan",
      visibility: "local",
      kind: "proposed_plan",
      status: "completed",
    });
    assert.equal(planThread.plans[1].planId, "plan:todo");
    assert.match(planThread.plans[1].markdown, /Draft todo/);
    assert.equal(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "Draft todo",
      })[0].matchedRole,
      "plan",
    );

    const inherited = searchT3Threads({
      dbPath: fixture.dbPath,
      limit: 10,
      query: "ANCESTOR included",
    });
    assert.deepEqual(
      new Set(inherited.map((row) => row.threadId)),
      new Set(["thread:parent", "thread:fork"]),
    );
    const boundary = searchT3Threads({
      dbPath: fixture.dbPath,
      limit: 10,
      query: "LATER excluded",
    });
    assert.deepEqual(boundary.map((row) => row.threadId), ["thread:parent"]);
  } finally {
    fixture.cleanup();
  }
});

test("matches stock fork recursion, rollback prefix, missing sources, and cycles", () => {
  const rollbackSource = projection({
    id: "thread:rollback-source",
    runs: [run("run:rollback:1", 1), run("run:rollback:2", 2, "rolled_back")],
    plans: [
      {
        id: "plan:rollback-stale",
        kind: "proposed_plan",
        status: "completed",
        markdown: "# Stale plan projection",
      },
    ],
    items: [
      turnItem({
        id: "item:rollback-first",
        threadId: "thread:rollback-source",
        runId: "run:rollback:1",
        ordinal: 1,
        text: "rollback source first",
      }),
      turnItem({
        id: "item:rollback-hidden",
        threadId: "thread:rollback-source",
        runId: "run:rollback:2",
        ordinal: 2,
        type: "assistant_message",
        text: "rollback source hidden locally",
      }),
    ],
  });
  const rollbackChild = projection({
    id: "thread:rollback-child",
    forkedFrom: {
      type: "run",
      threadId: "thread:rollback-source",
      runId: "run:rollback:2",
    },
    runs: [run("run:rollback:child", 3)],
    items: [
      turnItem({
        id: "item:rollback-child",
        threadId: "thread:rollback-child",
        runId: "run:rollback:child",
        ordinal: 3,
        text: "rollback child local",
      }),
    ],
  });
  const nestedChild = projection({
    id: "thread:nested-child",
    forkedFrom: { type: "run", threadId: "thread:parent", runId: "run:parent:1" },
    runs: [run("run:nested:child", 2)],
    items: [
      turnItem({
        id: "item:nested-child",
        threadId: "thread:nested-child",
        runId: "run:nested:child",
        ordinal: 2,
        text: "nested child",
      }),
    ],
  });
  const nestedGrandchild = projection({
    id: "thread:nested-grandchild",
    forkedFrom: {
      type: "run",
      threadId: "thread:nested-child",
      runId: "run:nested:child",
    },
    runs: [run("run:nested:grandchild", 3)],
    items: [
      turnItem({
        id: "item:nested-grandchild",
        threadId: "thread:nested-grandchild",
        runId: "run:nested:grandchild",
        ordinal: 3,
        text: "nested grandchild",
      }),
    ],
  });
  const cycleA = projection({
    id: "thread:cycle-a",
    forkedFrom: { type: "run", threadId: "thread:cycle-b", runId: "run:cycle:b" },
    runs: [run("run:cycle:a", 1)],
    items: [
      turnItem({
        id: "item:cycle-a",
        threadId: "thread:cycle-a",
        runId: "run:cycle:a",
        ordinal: 1,
        text: "cycle a",
      }),
    ],
  });
  const cycleB = projection({
    id: "thread:cycle-b",
    forkedFrom: { type: "run", threadId: "thread:cycle-a", runId: "run:cycle:a" },
    runs: [run("run:cycle:b", 1)],
    items: [
      turnItem({
        id: "item:cycle-b",
        threadId: "thread:cycle-b",
        runId: "run:cycle:b",
        ordinal: 1,
        text: "cycle b",
      }),
    ],
  });
  const missingSource = projection({
    id: "thread:missing-source",
    forkedFrom: { type: "run", threadId: "thread:does-not-exist", runId: "run:missing" },
    runs: [run("run:missing-local", 1)],
    items: [
      turnItem({
        id: "item:missing-local",
        threadId: "thread:missing-source",
        runId: "run:missing-local",
        ordinal: 1,
        text: "missing source local",
      }),
    ],
  });
  const malformedFork = projection({
    id: "thread:malformed-fork",
    forkedFrom: { type: "thread", threadId: "thread:parent" },
    runs: [run("run:malformed-local", 1)],
    items: [
      turnItem({
        id: "item:malformed-local",
        threadId: "thread:malformed-fork",
        runId: "run:malformed-local",
        ordinal: 1,
        text: "malformed fork local",
      }),
    ],
  });

  const fixture = makeFixtureDb([
    rollbackSource,
    rollbackChild,
    nestedChild,
    nestedGrandchild,
    cycleA,
    cycleB,
    missingSource,
    malformedFork,
  ]);
  try {
    const source = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:rollback-source",
    });
    assert.deepEqual(
      source.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      ["item:rollback-first"],
    );
    assert.deepEqual(source.plans, []);

    const child = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:rollback-child",
    });
    assert.deepEqual(
      child.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      [
        "item:rollback-first",
        "item:rollback-hidden",
        "turn-item:fork:thread:rollback-child",
        "item:rollback-child",
      ],
    );

    const nested = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:nested-grandchild",
    });
    assert.deepEqual(
      nested.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      [
        "item:parent-first",
        "turn-item:fork:thread:nested-child",
        "item:nested-child",
        "turn-item:fork:thread:nested-grandchild",
        "item:nested-grandchild",
      ],
    );

    const cycle = readT3ThreadAsIr({ dbPath: fixture.dbPath, target: "thread:cycle-a" });
    assert.ok(cycle.messages.some((message) => message.text === "cycle a"));
    assert.ok(
      cycle.warnings.some((entry) => entry.code === "t3_v2_ancestor_cycle"),
    );
    const queryWarnings = [];
    assert.ok(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "cycle a",
        warnings: queryWarnings,
      }).some((row) => row.threadId === "thread:cycle-a"),
    );
    assert.ok(
      queryWarnings.some((entry) => entry.code === "t3_v2_ancestor_cycle"),
    );

    const missing = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:missing-source",
    });
    assert.deepEqual(
      missing.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      ["item:missing-local"],
    );
    assert.ok(
      missing.warnings.some((entry) => entry.code === "t3_v2_missing_ancestor"),
    );

    const malformed = readT3ThreadAsIr({
      dbPath: fixture.dbPath,
      target: "thread:malformed-fork",
    });
    assert.deepEqual(
      malformed.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      ["item:malformed-local"],
    );
    assert.ok(
      malformed.warnings.some((entry) => entry.code === "t3_v2_malformed_fork"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("deleted threads stay out of the index and v2 tombstones suppress legacy rows", () => {
  const tombstone = projection({
    id: "thread:stale",
    title: "deleted v2 shell",
    deletedAt: timestamp,
  });
  const fixture = makeFixtureDb([tombstone]);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare(`INSERT INTO projection_threads (
      thread_id, project_id, title, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      "thread:deleted-legacy", "project:fixture", "deleted legacy", timestamp, timestamp, timestamp,
    );
    db.prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      "thread:stale",
      "project:fixture",
      "stale v1 title",
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      "stale-v1-message",
      "thread:stale",
      "assistant",
      "stale legacy search token",
      timestamp,
      timestamp,
    );
  } finally {
    db.close();
  }
  try {
    assert.ok(
      !listT3Threads({ dbPath: fixture.dbPath }).some(
        (row) => row.threadId === "thread:stale" || row.threadId === "thread:deleted-legacy",
      ),
    );
    assert.deepEqual(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "stale legacy search token",
      }),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test("inherits visible history from a deleted fork source", () => {
  const fixture = makeFixtureDb();
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare(
      "UPDATE orchestration_v2_projection_threads SET deleted_at = ? WHERE thread_id = ?",
    ).run(timestamp, "thread:parent");
  } finally {
    db.close();
  }

  try {
    const fork = readT3ThreadAsIr({ dbPath: fixture.dbPath, target: "thread:fork" });
    assert.deepEqual(
      fork.extensions.t3OrchestrationV2.visibleTurnItems.map((row) => row.sourceItemId),
      ["item:parent-first", "turn-item:fork:thread:fork", "item:fork-local"],
    );
    assert.deepEqual(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "ANCESTOR included",
      }).map((row) => row.threadId),
      ["thread:fork"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("v2 search excludes archived threads and deleted projects", () => {
  const archived = projection({
    id: "thread:archived",
    title: "archived thread",
    items: [
      turnItem({
        id: "item:archived",
        threadId: "thread:archived",
        runId: null,
        ordinal: 1,
        text: "archived search token",
      }),
    ],
  });
  const fixture = makeFixtureDb([archived]);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare(
      "UPDATE orchestration_v2_projection_threads SET archived_at = ? WHERE thread_id = ?",
    ).run(timestamp, "thread:archived");
  } finally {
    db.close();
  }

  try {
    assert.deepEqual(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "archived search token",
      }),
      [],
    );

    const deletedProjectDb = new DatabaseSync(fixture.dbPath);
    try {
      deletedProjectDb.prepare("UPDATE projection_projects SET deleted_at = ?").run(timestamp);
    } finally {
      deletedProjectDb.close();
    }
    assert.deepEqual(
      searchT3Threads({
        dbPath: fixture.dbPath,
        limit: 10,
        query: "ANCESTOR included",
      }),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});
