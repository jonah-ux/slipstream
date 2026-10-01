const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const engine = require('../lib/engine');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'slipstream.js');

function tempDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-test-')), 'index.db'); }

test('CLI builds, queries, and benchmarks the checked-in fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-'));
  const db = path.join(dir, 'index.db');
  const input = path.join(root, 'examples', 'items.json');
  const build = JSON.parse(execFileSync(process.execPath, [cli, 'build', `--input=${input}`, `--db=${db}`, '--dim=8'], { encoding: 'utf8' }));
  assert.equal(build.indexed, 4);
  const query = JSON.parse(execFileSync(process.execPath, [cli, 'query', `--db=${db}`, '--vector=0.9,0.1,0,0,0,0,0,0', '--k=2'], { encoding: 'utf8' }));
  assert.equal(query.schema, 'slipstream/query/v1');
  assert.equal(query.results[0].id, 'chatlens');
  const bench = JSON.parse(execFileSync(process.execPath, [cli, 'bench', `--db=${db}`, '--vector=0.9,0.1,0,0,0,0,0,0', '--n=3'], { encoding: 'utf8' }));
  assert.equal(bench.iterations, 3);
  const inspect = JSON.parse(execFileSync(process.execPath, [cli, 'inspect', `--db=${db}`], { encoding: 'utf8' }));
  assert.equal(inspect.schema, 'slipstream/inspect/v1');
  assert.equal(inspect.ok, true);
  assert.equal(inspect.item_count, 4);
  assert.equal(inspect.vector_count, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('engine inspect reports parity and redacts metadata values', () => {
  const file = tempDb();
  try {
    engine.rebuildAtomic(file, [
      { id: 'near', kind: 'tool', vector: [1, 0, 0, 0] },
      { id: 'far', kind: 'tool', vector: [0, 0, 1, 0] },
    ], { dim: 4, contract: { model: 'fixture', dimension: 4 }, sourceStatus: 'fixture', sourceToken: 'private-token' });
    const inspected = engine.inspectIndex(file);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.dimension, 4);
    assert.equal(inspected.item_count, 2);
    assert.equal(inspected.vector_count, 2);
    assert.deepEqual(inspected.kind_counts, { tool: 2 });
    assert.equal(JSON.stringify(inspected).includes('private-token'), false);
    assert.match(inspected.ids_sha256, /^[0-9a-f]{64}$/);
  } finally { engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('engine inspect refuses item/vector parity drift', () => {
  const file = tempDb();
  try {
    engine.rebuildAtomic(file, [{ id: 'only', vector: [1, 0, 0, 0] }], { dim: 4 });
    const db = engine.openIndex(file);
    db.prepare('delete from vec_items where rowid = ?').run(1n);
    db.close();
    const inspected = engine.inspectIndex(file);
    assert.equal(inspected.ok, false);
    assert.equal(inspected.missing_vectors, 1);
    assert.match(inspected.errors[0], /parity/);
  } finally { engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});
