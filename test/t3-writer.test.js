const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createThreadbridgeIr } = require('../src/ir');
const { writeIrToT3 } = require('../src/adapters/t3/write');
const { normalizeWriteIntent } = require('../src/intents');
const { readT3ThreadAsIr } = require('../src/adapters/t3/read');
const schema = fs.readFileSync(path.join(__dirname, 'fixtures/t3-v0.1.0/schema.sql'), 'utf8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-v2-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath); db.exec(schema); db.close();
  return dbPath;
}
function sql(dbPath, fn) { const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } }
function ir(extra = {}) {
  return createThreadbridgeIr({
    source: { harness: 'codex', sourceId: 'original' },
    thread: { title: 'Import test', modelSelection: { instanceId: 'codex', model: 'gpt-5.4' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    messages: [{ messageId: 'z-first', role: 'user', text: 'FIRST', createdAt: '2026-01-01T00:00:00Z' }, { messageId: 'a-second', role: 'assistant', text: 'SECOND', createdAt: '2026-01-01T00:00:00Z' }],
    plans: [{ markdown: '# Plan' }], ...extra,
  });
}
function write(dbPath, extra = {}) { return writeIrToT3({ dbPath, ir: ir(), backup: false, lockRetries: 0, busyTimeoutMs: 1, ...extra }); }

test('native v2 import writes durable history and project without legacy rows or execution state', (t) => {
  const dbPath = fixture(t);
  const result = write(dbPath, { newThreadId: 'imported', backup: true });
  assert.equal(result.createdIds.threadId, 'imported');
  assert.equal(result.details.storage, 'orchestration_v2');
  assert.ok(fs.existsSync(result.backupPath));
  sql(result.backupPath, (db) => assert.equal(db.prepare('SELECT count(*) n FROM orchestration_events').get().n, 0));
  sql(dbPath, (db) => {
    for (const table of ['projection_threads', 'orchestration_v2_projection_runs', 'orchestration_v2_effect_outbox', 'orchestration_v2_projection_provider_sessions']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    const payload = JSON.parse(db.prepare('SELECT payload_json FROM orchestration_v2_projection_threads').get().payload_json);
    assert.equal(payload.historyOrigin, 'v1_import');
    assert.equal(payload.activeProviderThreadId, null);
    assert.equal(payload.lineage.rootThreadId, 'imported');
    const items = db.prepare('SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal').all().map((r) => JSON.parse(r.payload_json));
    assert.deepEqual(items.map((i) => i.text || i.markdown), ['FIRST', 'SECOND', '# Plan']);
    assert.ok(items.every((i) => i.runId === null && i.nodeId === null));
    assert.equal(db.prepare("SELECT count(*) n FROM orchestration_events WHERE event_type='project.created'").get().n, 1);
    assert.equal(db.prepare('SELECT last_sequence FROM orchestration_v2_projection_metadata').get().last_sequence, db.prepare('SELECT max(sequence) n FROM orchestration_events').get().n);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('normalized overrides survive the operation adapter boundary', (t) => {
  const dbPath = fixture(t);
  const options = normalizeWriteIntent('clone-thread', { newProvider: 'custom', newModel: 'custom-model', title: 'Override' });
  const result = write(dbPath, { intent: options.type, options });
  assert.deepEqual(result.details.modelSelection, { instanceId: 'custom', model: 'custom-model' });
  assert.equal(result.details.threadTitle, 'Override');
});

test('unsupported schema, stale projections and runtime copies fail without fallback writes', (t) => {
  const dbPath = fixture(t);
  assert.throws(() => write(dbPath, { options: { copyRuntime: true } }), /copy-runtime/);
  sql(dbPath, (db) => db.exec("INSERT INTO effect_sql_migrations VALUES(63,'Future','2026-01-01')"));
  assert.throws(() => write(dbPath), /Unsupported T3 v2/);
  sql(dbPath, (db) => { db.exec('DELETE FROM effect_sql_migrations WHERE migration_id=63'); db.exec("UPDATE orchestration_v2_projection_metadata SET last_sequence=99"); });
  assert.throws(() => write(dbPath), /stale/);
  sql(dbPath, (db) => {
    assert.equal(db.prepare('SELECT count(*) n FROM projection_threads').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM orchestration_events').get().n, 0);
  });
});

test('duplicate IDs and injected SQL failure roll back the entire import', (t) => {
  const dbPath = fixture(t);
  write(dbPath, { newThreadId: 'once' });
  const before = sql(dbPath, (db) => db.prepare('SELECT count(*) n FROM orchestration_events').get().n);
  assert.throws(() => write(dbPath, { newThreadId: 'once' }), /already exists/);
  sql(dbPath, (db) => db.exec("CREATE TRIGGER fail_item BEFORE INSERT ON orchestration_v2_projection_turn_items BEGIN SELECT RAISE(ABORT,'injected failure'); END"));
  assert.throws(() => write(dbPath), /injected failure/);
  sql(dbPath, (db) => {
    assert.equal(db.prepare('SELECT count(*) n FROM orchestration_events').get().n, before);
    assert.equal(db.prepare('SELECT count(*) n FROM orchestration_v2_projection_threads').get().n, 1);
  });
});

test('system text, streaming snapshots and rich history are preserved with explicit warnings', (t) => {
  const dbPath = fixture(t);
  const source = ir({ messages: [{ role: 'system', text: 'Historical instruction', isStreaming: true }], extensions: { t3OrchestrationV2: { visibleTurnItems: [{ item: { type: 'tool_call', toolName: 'shell', input: 'pwd' } }] } } });
  const result = write(dbPath, { ir: source });
  assert.deepEqual(result.warnings.map((w) => w.code), ['t3_history_archived_as_text', 't3_streaming_snapshot', 't3_imported_role_label']);
  sql(dbPath, (db) => {
    const text = db.prepare('SELECT payload_json FROM orchestration_v2_projection_messages').all().map((r) => JSON.parse(r.payload_json).text).join('\n');
    assert.match(text, /Imported system message/); assert.match(text, /pwd/);
  });
});

test('missing projects, active work and a held write lock are rejected without writes', (t) => {
  const dbPath = fixture(t);
  assert.throws(() => write(dbPath, { options: { projectId: 'missing' } }), /project not found/);
  const lock = new DatabaseSync(dbPath);
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.throws(() => write(dbPath), /database is locked/);
    lock.exec('ROLLBACK');
    lock.exec("INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,available_at,created_at,updated_at) VALUES('effect','command','thread','test','{}','pending','2026-01-01','2026-01-01','2026-01-01')");
    assert.throws(() => write(dbPath), /pending effects/);
    assert.equal(lock.prepare('SELECT count(*) n FROM orchestration_events').get().n, 0);
  } finally { lock.close(); }
});

test('backup paths containing spaces and quotes remain usable', (t) => {
  const original = fixture(t);
  const dbPath = path.join(path.dirname(original), "state user's copy.sqlite");
  fs.renameSync(original, dbPath);
  const result = write(dbPath, { backup: true });
  assert.ok(fs.existsSync(result.backupPath));
  sql(result.backupPath, (db) => assert.equal(db.prepare('SELECT count(*) n FROM orchestration_events').get().n, 0));
});

test('attachments survive a commit retry and a same-database copy with fresh IDs', (t) => {
  const dbPath = fixture(t);
  const source = ir({ messages: [{ role: 'user', text: 'Attached', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', attachments: [{ type: 'file', name: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('portable bytes'), source: { invalid: 'foreign capture metadata' } }] }] });
  const originalExec = DatabaseSync.prototype.exec;
  let attempts = 0;
  t.mock.method(DatabaseSync.prototype, 'exec', function (statement) {
    if (statement === 'COMMIT' && attempts++ === 0) throw new Error('database is locked');
    return originalExec.call(this, statement);
  });
  const first = write(dbPath, { ir: source, newThreadId: 'first', lockRetries: 1, retryDelayMs: 1 });
  assert.equal(attempts, 2);
  t.mock.restoreAll();
  assert.ok(first.warnings.some((w) => w.code === 'attachment_source_omitted'));
  const imported = readT3ThreadAsIr({ dbPath, target: 'first' });
  assert.equal(imported.messages[0].createdAt, '2026-01-01T00:00:00.000Z');
  const second = write(dbPath, { ir: imported, newThreadId: 'second', options: { projectId: first.target.projectId } });
  assert.equal(second.target.projectId, first.target.projectId);
  const copied = readT3ThreadAsIr({ dbPath, target: 'second' });
  const attachments = [imported.messages[0].attachments[0], copied.messages[0].attachments[0]];
  assert.notEqual(attachments[0].id, attachments[1].id);
  for (const attachment of attachments) assert.equal(fs.readFileSync(path.join(path.dirname(dbPath), 'attachments', `${attachment.id}.txt`), 'utf8'), 'portable bytes');
  assert.equal(fs.readdirSync(path.join(path.dirname(dbPath), 'attachments')).length, 2);
  sql(dbPath, (db) => assert.equal(db.prepare('SELECT count(*) n FROM projection_projects').get().n, 1));
});

test('a terminal commit failure rolls back published assets and database rows', (t) => {
  const dbPath = fixture(t);
  const originalExec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (statement) {
    if (statement === 'COMMIT') throw new Error('injected commit failure');
    return originalExec.call(this, statement);
  });
  assert.throws(() => write(dbPath, { ir: ir({ messages: [{ role: 'user', attachments: [{ type: 'file', name: 'notes.txt', bytes: Buffer.from('bytes') }] }] }) }), /injected commit failure/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(dbPath), 'attachments')), []);
  sql(dbPath, (db) => assert.equal(db.prepare('SELECT count(*) n FROM orchestration_events').get().n, 0));
});

test('non-text content is retained as labelled history', (t) => {
  const dbPath = fixture(t);
  const result = write(dbPath, { ir: ir({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'search', input: { query: 'preserve full input' } }, { type: 'opaque-unknown', value: 'future content' }] }] }) });
  assert.ok(result.warnings.some((w) => w.code === 't3_message_content_archived'));
  const imported = readT3ThreadAsIr({ dbPath, target: result.createdIds.threadId });
  assert.match(imported.messages[0].text, /preserve full input/);
  assert.match(imported.messages[0].text, /future content/);
});

test('an open database in another process is refused before backup or writes', async (t) => {
  const dbPath = fixture(t);
  const child = spawn(process.execPath, ['-e', "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.prepare('SELECT count(*) FROM orchestration_events').get(); process.send('ready'); setInterval(() => {}, 1000);", dbPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    assert.throws(() => write(dbPath, { backup: true }), /open in another process/);
    assert.equal(fs.readdirSync(path.dirname(dbPath)).some((name) => name.includes('backup')), false);
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

test('missing native guard tables are an unsupported schema', (t) => {
  const dbPath = fixture(t);
  sql(dbPath, (db) => db.exec('DROP TABLE orchestration_v2_effect_outbox'));
  assert.throws(() => write(dbPath), /Unsupported T3 v2 storage/);
});

test('CLI v2 copy, show and search retain the JSON envelope and provider override', (t) => {
  const dbPath = fixture(t);
  const source = write(dbPath, { newThreadId: 'cli-source' });
  function cli(...args) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/threadbridge.js'), 't3', ...args, '--db-path', dbPath, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(typeof envelope.command, 'string');
    return envelope.data;
  }
  const receipt = cli('copy-to-workspace', 'cli-source', '--new-project-id', source.target.projectId, '--new-thread-id', 'cli-copy', '--new-provider', 'custom', '--new-model', 'custom-model', '--title', 'CLI copy');
  assert.ok(fs.existsSync(receipt.backupPath));
  const copied = cli('show', 'cli-copy');
  assert.deepEqual(copied.thread.modelSelection, { instanceId: 'custom', model: 'custom-model' });
  assert.deepEqual(copied.messages.map((m) => m.text), ['FIRST', 'SECOND']);
  assert.ok(cli('search', 'FIRST').some((row) => row.threadId === 'cli-copy'));
  sql(dbPath, (db) => db.exec("INSERT INTO effect_sql_migrations VALUES(63,'Future','2026-01-01')"));
  const unknown = spawnSync(process.execPath, [path.join(__dirname, '../bin/threadbridge.js'), 't3', 'list', '--db-path', dbPath, '--json'], { encoding: 'utf8' });
  assert.equal(unknown.status, 0);
  assert.ok(JSON.parse(unknown.stdout).warnings.some((w) => w.code === 't3_unverified_storage'));
});
