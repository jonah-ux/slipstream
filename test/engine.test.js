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
