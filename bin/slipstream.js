#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const engine = require('../lib/engine');

const args = process.argv.slice(2);
const command = args[0];
const flags = Object.fromEntries(args.slice(1).filter((arg) => arg.startsWith('--')).map((arg) => {
  const [key, ...rest] = arg.slice(2).split('=');
  return [key, rest.length ? rest.join('=') : true];
}));

const usage = `Usage: slipstream <build|query|bench|inspect|self-test> [options]

Commands:
  build      index a JSON fixture or caller-owned vector file
  query      return nearest items as stable JSON
  bench      measure repeated local queries
  inspect    verify index tables, vector parity, metadata, and identity digest
  self-test  run an offline SQLite + sqlite-vec round trip

Options:
  --input=PATH       JSON array (or {items: [...]}) for build
  --db=PATH          index path (default: .slipstream/index.db)
  --dim=N            vector dimension (default: 8 for the CLI)
  --vector=a,b,c     query vector; required for query and bench
  --k=N              number of results (default: 5)
  --kind=NAME        filter results by item kind
  --n=N              benchmark iterations (default: 30)
`;

function die(message) {
  console.error(`slipstream: ${message}`);
  process.exitCode = 1;
}

function dbPath() { return path.resolve(String(flags.db || '.slipstream/index.db')); }

function dimension() {
  const dim = Number(flags.dim || 8);
  if (!Number.isInteger(dim) || dim < 2) throw new Error('--dim must be an integer >= 2');
  return dim;
}

function vector() {
  if (!flags.vector) throw new Error('--vector=a,b,c is required');
  const out = String(flags.vector).split(',').map(Number);
  if (out.some((value) => !Number.isFinite(value))) throw new Error('--vector must contain finite numbers');
  return out;
}

function itemsFrom(file) {
  if (!file) throw new Error('--input=PATH is required');
  const payload = JSON.parse(fs.readFileSync(path.resolve(String(file)), 'utf8'));
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error('input must be a JSON array or an object with an items array');
  return items;
}

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function build() {
  const dim = dimension();
  const items = itemsFrom(flags.input);
  const started = performance.now();
  const db = engine.rebuildAtomic(dbPath(), items, { dim, sourceStatus: 'fixture-or-caller-owned' });
  output({ schema: 'slipstream/build/v1', ...db, db: dbPath(), elapsed_ms: +(performance.now() - started).toFixed(2) });
}

function query() {
  const queryVector = vector();
  const db = engine.openIndex(dbPath(), { readonly: true });
  try {
    const started = performance.now();
    const results = engine.search(db, queryVector, Number(flags.k || 5), { kind: flags.kind });
    output({ schema: 'slipstream/query/v1', db: dbPath(), k: Number(flags.k || 5), results, elapsed_ms: +(performance.now() - started).toFixed(2) });
  } finally { db.close(); }
}

function bench() {
  const queryVector = vector();
  const iterations = Number(flags.n || 30);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('--n must be a positive integer');
  const db = engine.openIndex(dbPath(), { readonly: true });
  try {
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      engine.search(db, queryVector, Number(flags.k || 5), { kind: flags.kind });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
    output({ schema: 'slipstream/bench/v1', db: dbPath(), iterations, p50_ms: +percentile(0.5).toFixed(3), p95_ms: +percentile(0.95).toFixed(3), max_ms: +samples.at(-1).toFixed(3) });
  } finally { db.close(); }
}

function inspect() {
  output(engine.inspectIndex(dbPath()));
}

function selfTest() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-self-test-')), 'index.db');
  const items = [
    { id: 'alpha', kind: 'fixture', name: 'Alpha', one_liner: 'first', vector: [1, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bravo', kind: 'fixture', name: 'Bravo', one_liner: 'second', vector: [0, 1, 0, 0, 0, 0, 0, 0] },
  ];
  const built = engine.rebuildAtomic(file, items, { dim: 8 });
  const db = engine.openIndex(file, { readonly: true });
  try {
    const results = engine.search(db, [0.99, 0.01, 0, 0, 0, 0, 0, 0], 1);
    const inspected = engine.inspectIndex(file);
    if (built.indexed !== 2 || results[0]?.id !== 'alpha' || !inspected.ok || inspected.item_count !== 2 || inspected.vector_count !== 2) throw new Error('nearest-neighbor or inspect assertion failed');
    output({ schema: 'slipstream/self-test/v1', pass: true, indexed: built.indexed, nearest: results[0].id, inspect_ok: inspected.ok, db_removed: true });
  } finally { db.close(); engine.cleanupDbFamily(file); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}

try {
  if (!command || command === '--help' || command === '-h') { console.log(usage); }
  else if (command === 'build') build();
  else if (command === 'query') query();
  else if (command === 'bench') bench();
  else if (command === 'inspect') inspect();
  else if (command === 'self-test') selfTest();
  else die(`unknown command: ${command}\n\n${usage}`);
} catch (error) { die(error.message); }
