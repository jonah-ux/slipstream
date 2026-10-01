#!/usr/bin/env node
// A complete local retrieval round trip for an application that owns embeddings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../lib/engine');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-integration-'));
const dbPath = path.join(root, 'index.db');
const manifestPath = path.join(root, 'index.manifest.json');
const items = [
  { id: 'release-checks', kind: 'workflow', name: 'Release checks', meta: { owner: 'ci' }, vector: [1, 0, 0, 0] },
  { id: 'session-recovery', kind: 'workflow', name: 'Session recovery', meta: { owner: 'local' }, vector: [0, 1, 0, 0] },
  { id: 'worktree-archive', kind: 'workflow', name: 'Worktree archive', meta: { owner: 'git' }, vector: [0, 0, 1, 0] },
];
try {
  const built = engine.rebuildAtomic(dbPath, items, { dim: 4, sourceStatus: 'caller-owned' });
  const db = engine.openIndex(dbPath, { readonly: true });
  let nearest;
  try { nearest = engine.search(db, [0.98, 0.02, 0, 0], 1, { kind: 'workflow' }); }
  finally { db.close(); }
  const inspected = engine.inspectIndex(dbPath);
  const manifest = engine.createManifest(dbPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const verified = engine.verifyManifest(dbPath, manifestPath);
  console.log(JSON.stringify({ schema: 'slipstream/integration-example/v1', built, nearest: nearest[0]?.id, inspect_ok: inspected.ok, manifest_verified: verified.ok, source_status: manifest.source_status }, null, 2));
  if (!inspected.ok || !verified.ok || nearest[0]?.id !== 'release-checks') process.exitCode = 1;
} finally {
  engine.cleanupDbFamily(dbPath);
  fs.rmSync(root, { recursive: true, force: true });
}
