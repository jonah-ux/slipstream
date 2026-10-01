// Slipstream's reusable local index engine: build once, then query a
// memory-mapped SQLite + sqlite-vec file without a hosted search dependency.
// The engine is provider-neutral and supports any fixed vector dimension.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DIM = 1536;

// macOS system sqlite3 is OMIT_LOAD_EXTENSION; better-sqlite3 bundles a load-extension build.
function vec0Path() {
  const cands = [
    path.join(__dirname, '..', 'node_modules', 'sqlite-vec-darwin-arm64', 'vec0.dylib'),
    path.join(__dirname, '..', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so'),
    process.env.SLIPSTREAM_VEC0_PATH,
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p));
}

function openIndex(dbPath, { readonly = false, mmapMB = 512 } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  try { require('sqlite-vec').load(db); }
  catch { const p = vec0Path(); if (!p) throw new Error('vec0 extension not found'); db.loadExtension(p); }
  db.pragma(`mmap_size=${mmapMB * 1024 * 1024}`); // memory-mapped reads = zero-copy, the speed trick
  if (!readonly) { db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL'); }
  return db;
}

function createSchema(db, dim = DIM) {
  db.exec(`create table if not exists items (
    rowid integer primary key, id text unique, kind text, name text, title text, one_liner text, meta text);`);
  db.exec(`create index if not exists items_kind on items(kind);`);
  db.exec(`create virtual table if not exists vec_items using vec0(emb float[${dim}]);`);
  db.exec(`create table if not exists index_meta (k text primary key, v text not null);`);
}

const f32buf = (arr) => Buffer.from(Float32Array.from(arr).buffer);

// build the index from items [{id, kind, name, title, one_liner, vector:[..dim], meta}]
function build(db, items, dim = DIM) {
  createSchema(db, dim);
  if (!Array.isArray(items) || items.length === 0) throw new Error('refusing empty index build');
  const insItem = db.prepare(`insert into items(id,kind,name,title,one_liner,meta) values (@id,@kind,@name,@title,@one_liner,@meta)`);
  const insVec = db.prepare(`insert into vec_items(rowid,emb) values (?,?)`);
  let n = 0, skipped = 0;
  const tx = db.transaction((rows) => {
    db.exec('delete from items'); db.exec('delete from vec_items');
    for (const r of rows) {
      if (!r.vector || r.vector.length !== dim) { skipped++; continue; }
      const info = insItem.run({ id: String(r.id), kind: r.kind || null, name: r.name || null, title: r.title || null, one_liner: r.one_liner || null, meta: r.meta ? JSON.stringify(r.meta) : null });
      insVec.run(BigInt(info.lastInsertRowid), f32buf(r.vector)); // vec0 requires BigInt rowid, not Number

      n++;
    }
    if (n === 0) throw new Error(`no valid ${dim}-dimension vectors; existing index preserved`);
  });
  tx(items);
  return { indexed: n, skipped };
}

function cleanupDbFamily(file) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
}

function setIndexMetadata(db, key, value) {
  if (value === undefined || value === null) return;
  db.prepare(`insert into index_meta(k,v) values (?,?)
    on conflict(k) do update set v=excluded.v`).run(key, JSON.stringify(value));
}

function setIndexContract(db, contract) {
  setIndexMetadata(db, 'embedding_contract', contract);
}

function getIndexMetadata(dbOrPath, key) {
  let db = dbOrPath, close = false;
  try {
    if (typeof dbOrPath === 'string') { db = openIndex(dbOrPath, { readonly: true }); close = true; }
    const row = db.prepare('select v from index_meta where k=?').get(key);
    return row ? JSON.parse(row.v) : null;
  } catch { return null; }
  finally { if (close && db) try { db.close(); } catch {} }
}

function getIndexContract(dbOrPath) {
  return getIndexMetadata(dbOrPath, 'embedding_contract');
}

// Build into a same-directory temporary database and atomically replace the live
// file only after schema, vectors, metadata, and WAL checkpoint all succeed.
// Dimension changes therefore never reuse an incompatible vec0 virtual table.
function rebuildAtomic(dbPath, items, { dim = DIM, contract = null, sourceStatus = null, sourceToken = null } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.building-${process.pid}-${Date.now()}`;
  cleanupDbFamily(tmp);
  let db;
  try {
    db = openIndex(tmp);
    const result = build(db, items, dim);
    setIndexContract(db, contract);
    setIndexMetadata(db, 'source_status', sourceStatus);
    setIndexMetadata(db, 'source_token', sourceToken);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close(); db = null;
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    fs.renameSync(tmp, dbPath);
    return { ...result, dimension: dim, contract };
  } catch (error) {
    if (db) try { db.close(); } catch {}
    cleanupDbFamily(tmp);
    throw error;
  }
}

// KNN search: queryVec [..dim] → top-k items, sub-ms. Optional kind filter (over-fetch then filter).
function search(db, queryVec, k = 8, { kind } = {}) {
  const over = kind ? k * 6 : k;
  const knn = db.prepare(`select rowid, distance from vec_items where emb match ? order by distance limit ?`).all(f32buf(queryVec), over);
  if (!knn.length) return [];
  const dist = new Map(knn.map((r) => [r.rowid, r.distance]));
  const ph = knn.map(() => '?').join(',');
  let rows = db.prepare(`select rowid,id,kind,name,title,one_liner,meta from items where rowid in (${ph})`).all(...knn.map((r) => r.rowid));
  if (kind) rows = rows.filter((r) => r.kind === kind);
  for (const r of rows) r.distance = dist.get(r.rowid);
  rows.sort((a, b) => a.distance - b.distance);
  return rows.slice(0, k);
}

// ── binary (bit) vector support ────────────────────────────────────────────
// Some callers already have binary-quantized embeddings. The optional bit
// helpers keep those callers local too, without requiring a hosted vector DB.
// sqlite-vec quirk (proven 2026-06-24): bit columns MUST be bound via the vec_bit(?)
// SQL constructor, NOT a bare parameter (bare bind is validated as float32 → throws).

// pack a '0'/'1' bitstring (dim chars, dim%8===0) → Buffer(dim/8), char 0 = MSB of byte 0.
// Stored vectors (from bq::text) and query vectors (from quantize()) MUST use this same
// packing so sqlite-vec's XOR-popcount hamming equals dimension-wise hamming.
function packBits(bitstring) {
  const n = bitstring.length;
  const buf = Buffer.alloc(n >> 3);
  for (let i = 0; i < n; i++) if (bitstring.charCodeAt(i) === 49) buf[i >> 3] |= 0x80 >> (i & 7);
  return buf;
}

// quantize a float vector → '0'/'1' bitstring, matching pgvector binary_quantize EXACTLY
// (bit = 1 iff component > 0). Proven bit-exact vs `binary_quantize()::bit(1536)` 2026-06-24.
function quantizeBits(vec) {
  let s = '';
  for (let i = 0; i < vec.length; i++) s += vec[i] > 0 ? '1' : '0';
  return s;
}

function createSchemaBit(db, dim = DIM) {
  db.exec(`create table if not exists docs (
    rowid integer primary key, id text unique, meta text);`);
  db.exec(`create table if not exists corpus_meta (k text primary key, v text);`);
  db.exec(`create virtual table if not exists vec_docs using vec0(bq bit[${dim}]);`);
}

// build a bit index from items [{id, bitstring:'0/1'*dim, meta}]. Returns {indexed, skipped}.
function buildBit(db, items, dim = DIM) {
  createSchemaBit(db, dim);
  db.transaction(() => { db.exec('delete from docs'); db.exec('delete from vec_docs'); })();
  const insDoc = db.prepare(`insert into docs(id,meta) values (@id,@meta)`);
  const insVec = db.prepare(`insert into vec_docs(rowid,bq) values (?, vec_bit(?))`);
  let n = 0, skipped = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      if (!r.bitstring || r.bitstring.length !== dim) { skipped++; continue; }
      const info = insDoc.run({ id: String(r.id), meta: r.meta ? JSON.stringify(r.meta) : null });
      insVec.run(BigInt(info.lastInsertRowid), packBits(r.bitstring)); // vec0 needs BigInt rowid
      n++;
    }
  });
  // chunk so one transaction doesn't hold the whole 405k set in memory at once
  for (let i = 0; i < items.length; i += 20000) tx(items.slice(i, i + 20000));
  return { indexed: n, skipped };
}

// hamming KNN over a bit index: queryBits = '0'/'1' bitstring → top-k docs with hamming distance.
function searchBit(db, queryBits, k = 10) {
  const knn = db.prepare(`select rowid, distance from vec_docs where bq match vec_bit(?) order by distance limit ?`).all(packBits(queryBits), k);
  if (!knn.length) return [];
  const dist = new Map(knn.map((r) => [r.rowid, r.distance]));
  const ph = knn.map(() => '?').join(',');
  const rows = db.prepare(`select rowid,id,meta from docs where rowid in (${ph})`).all(...knn.map((r) => r.rowid));
  for (const r of rows) { r.distance = dist.get(r.rowid); if (r.meta) try { r.meta = JSON.parse(r.meta); } catch {} }
  rows.sort((a, b) => a.distance - b.distance);
  return rows;
}

module.exports = { DIM, openIndex, createSchema, build, search, rebuildAtomic, getIndexContract,
  getIndexMetadata, setIndexContract, setIndexMetadata, cleanupDbFamily, vec0Path, f32buf,
  packBits, quantizeBits, createSchemaBit, buildBit, searchBit };
