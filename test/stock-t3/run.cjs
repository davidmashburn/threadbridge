// Optional acceptance suite against an installed, unmodified stock checkout.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createThreadbridgeIr } = require('../../src/ir');
const { writeIrToT3 } = require('../../src/adapters/t3/write');
const root = process.env.T3_STOCK_ROOT;
if (!root) throw new Error('Set T3_STOCK_ROOT to an installed stock T3 v0.1.0 source checkout (see test/stock-t3/README.md).');
for (const [relative, expected] of Object.entries(require('./source-hashes.json'))) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  assert.equal(actual, expected, `Stock source differs: ${relative}`);
}
const cwd = path.join(root, 'apps/server');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbridge-stock-'));
const token = crypto.randomUUID();
const probePath = path.join(cwd, `tb-stock-${token}.ts`);
const testPath = path.join(cwd, `src/orchestration-v2/testkit/Threadbridge-${token}.integration.test.ts`);
const env = { ...process.env, TB_STOCK_TEST_DIR: dir };
function run(command, args) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  fs.appendFileSync(path.join(dir, 'stock.log'), `${command} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}\n`);
  if (result.error || result.status !== 0) throw new Error(`Stock test failed (${result.error?.message || result.status}); see ${dir}/stock.log`);
}
try {
  const dbPath = path.join(dir, 'base.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, '../fixtures/t3-v0.1.0/schema.sql'), 'utf8')); db.close();
  const ir = createThreadbridgeIr({
    source: { harness: 'codex', sourceId: 'stock-acceptance' },
    thread: { title: 'Threadbridge stock acceptance', workspaceRoot: dir, modelSelection: { instanceId: 'codex', model: 'gpt-5.4' } },
    messages: [{ role: 'user', text: 'FIRST question', attachments: [{ type: 'file', name: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('portable attachment') }, { type: 'image', name: 'pixel.png', mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64') }], createdAt: '2026-01-01T00:00:00.000Z' }, { role: 'assistant', text: 'SECOND answer', createdAt: '2026-01-01T00:00:00.000Z' }],
    plans: [{ markdown: '# Historical plan\nPreserve this plan.' }],
  });
  writeIrToT3({ ir, dbPath, newThreadId: 'thread:portable', backup: true });
  fs.writeFileSync(probePath, fs.readFileSync(path.join(__dirname, 'probe.ts')), { flag: 'wx' });
  run(process.execPath, [probePath, 'inspect', dbPath, path.join(dir, 'before.json')]);
  run(process.execPath, [probePath, 'rebuild', dbPath, path.join(dir, 'after.json')]);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'before.json')));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'after.json')));
  assert.equal(before.projectEvents, 1);
  assert.equal(before.attachments.length, 2);
  assert.equal(before.attachments[0].contents, Buffer.from('portable attachment').toString('base64'));
  assert.equal(before.verify.valid, true); assert.equal(after.verify.valid, true);
  assert.deepEqual(after.threads, before.threads, 'Full canonical projection changed during stock rebuild');
  const source = fs.readFileSync(path.join(cwd, 'src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts'), 'utf8');
  const helpers = source.slice(0, source.indexOf('describe("orchestration v2 provider switching"'));
  assert.ok(helpers.length > 0);
  fs.writeFileSync(testPath, 'import { copyFileSync, writeFileSync } from "node:fs";\nimport { DatabaseSync } from "node:sqlite";\nimport * as NodeServices from "@effect/platform-node/NodeServices";\n' + helpers + fs.readFileSync(path.join(__dirname, 'continuation.ts.txt'), 'utf8'), { flag: 'wx' });
  run('pnpm', ['exec', 'vp', 'test', 'run', path.relative(cwd, testPath)]);
  console.log(`Stock v0.1.0: schema decoding, full projection rebuild equality and provider continuation passed (including negative control). Artifacts: ${dir}`);
} finally {
  fs.rmSync(probePath, { force: true }); fs.rmSync(testPath, { force: true });
}
