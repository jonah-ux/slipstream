const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../lib/engine');

function tempDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-test-')), 'index.db'); }

test('builds and searches a local vector index', () => {
  const file = tempDb();
  try {
    const result = engine.rebuildAtomic(file, [
      { id: 'near', kind: 'tool', name: 'Near', vector: [1, 0, 0, 0] },
      { id: 'far', kind: 'tool', name: 'Far', vector: [0, 0, 1, 0] },
    ], { dim: 4 });
    assert.equal(result.indexed, 2);
    const db = engine.openIndex(file, { readonly: true });
    assert.equal(engine.search(db, [0.9, 0.1, 0, 0], 1)[0].id, 'near');
    db.close();
  } finally { engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('refuses an empty build', () => {
  const file = tempDb();
  try { assert.throws(() => engine.rebuildAtomic(file, [], { dim: 4 }), /refusing empty index build/); }
  finally { engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('inspects index parity and redacts metadata values', () => {
  const file = tempDb();
  try {
    engine.rebuildAtomic(file, [
      { id: 'near', kind: 'tool', vector: [1, 0, 0, 0] },
      { id: 'far', kind: 'tool', vector: [0, 0, 1, 0] },
    ], { dim: 4, contract: { model: 'fixture', dimension: 4 }, sourceStatus: 'fixture', sourceToken: 'private-token' });
    const inspected = engine.inspectIndex(file);
    assert.equal(inspected.schema, 'slipstream/inspect/v1');
    assert.equal(inspected.ok, true);
    assert.equal(inspected.dimension, 4);
    assert.equal(inspected.item_count, 2);
    assert.equal(inspected.vector_count, 2);
    assert.deepEqual(inspected.kind_counts, { tool: 2 });
    assert.deepEqual(inspected.metadata_keys, ['embedding_contract', 'source_status', 'source_token']);
    assert.equal(JSON.stringify(inspected).includes('private-token'), false);
    assert.match(inspected.ids_sha256, /^[0-9a-f]{64}$/);
  } finally { engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('inspect refuses item/vector parity drift', () => {
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
