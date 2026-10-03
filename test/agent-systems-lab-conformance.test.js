const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const manifestPath = path.join(__dirname, '..', 'conformance', 'agent-systems-lab.json');

test('manifest pins native Slipstream schemas and Agent Proof handoff', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schema, 'agent-systems-lab-slipstream-conformance/v1');
  assert.equal(manifest.owner, 'slipstream');
  assert.deepEqual(manifest.native_schemas, ['slipstream/query/v1', 'slipstream/inspect/v1', 'slipstream/manifest/v1', 'slipstream/verify/v1']);
  assert.equal(manifest.shared_adapter.schema, 'agent-proof/interop/v1');
  assert.equal(manifest.cases.length, 5);
  assert.equal(manifest.privacy.vectors_exported, false);
});

test('offline self-test proves query, inspect, manifest, verify, and tamper boundaries', () => {
  const output = execFileSync(process.execPath, ['bin/slipstream.js', 'self-test'], { encoding: 'utf8' });
  const receipt = JSON.parse(output);
  assert.equal(receipt.schema, 'slipstream/self-test/v1');
  assert.equal(receipt.pass, true);
  assert.equal(receipt.indexed, 2);
  assert.equal(receipt.nearest, 'alpha');
  assert.equal(receipt.inspect_ok, true);
  assert.equal(receipt.manifest_verified, true);
  assert.equal(receipt.manifest_deterministic, true);
  assert.equal(receipt.db_removed, true);
});
