const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'slipstream.js');

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
  fs.rmSync(dir, { recursive: true, force: true });
});
