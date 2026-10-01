// Slipstream's reusable local index engine: build once, then query a
// memory-mapped SQLite + sqlite-vec file without a hosted search dependency.
// The engine is provider-neutral and supports any fixed vector dimension.
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
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

function openReadOnlyIndex(dbPath) {
  const requested = path.resolve(String(dbPath));
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error(`index file does not exist: ${requested}`);
  const resolved = fs.realpathSync(requested);
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slipstream-readonly-'));
  const copied = path.join(tempDir, path.basename(resolved));
  try {
    fs.copyFileSync(resolved, copied);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = resolved + suffix;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, copied + suffix);
    }
    const db = openIndex(copied, { readonly: true });
    return {
      db,
      close() {
        try { db.close(); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function createSchema(db, dim = DIM) {
  db.exec(`create table if not exists items (
    rowid integer primary key, id text unique, kind text, name text, title text, one_liner text, meta text);`);
  db.exec(`create index if not exists items_kind on items(kind);`);
  db.exec(`create virtual table if not exists vec_items using vec0(emb float[${dim}]);`);
  db.exec(`create table if not exists index_meta (k text primary key, v text not null);`);
}

function f32Array(arr) {
  if (!Array.isArray(arr) && !(ArrayBuffer.isView(arr) && typeof arr.length === 'number')) return null;
  const floats = Float32Array.from(arr, (value) => Number(value));
  if (floats.length !== arr.length || Array.from(floats).some((value) => !Number.isFinite(value))) return null;
  return floats;
}

function f32Bytes(floats) {
  const bytes = Buffer.alloc(floats.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < floats.length; i++) view.setFloat32(i * Float32Array.BYTES_PER_ELEMENT, floats[i], true);
  return bytes;
}

const f32buf = (arr) => {
  const floats = f32Array(arr);
  if (!floats) throw new Error('vector must contain finite float32 values');
  return f32Bytes(floats);
};

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
      const vector = f32Array(r.vector);
      if (typeof r.id !== 'string' || r.id.trim() === '' || !vector || vector.length !== dim) { skipped++; continue; }
      const info = insItem.run({ id: String(r.id), kind: r.kind || null, name: r.name || null, title: r.title || null, one_liner: r.one_liner || null, meta: r.meta ? JSON.stringify(r.meta) : null });
      insVec.run(BigInt(info.lastInsertRowid), f32Bytes(vector)); // vec0 requires BigInt rowid, not Number

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function inspectDb(db, resolved) {
  const errors = [];
  const tableNames = new Set(db.prepare("select name from sqlite_master where type in ('table','shadow')").all().map((row) => row.name));
  const hasItems = tableNames.has('items');
  const hasVectors = tableNames.has('vec_items');
  const hasMetadata = tableNames.has('index_meta');
  const schemaSql = hasVectors ? db.prepare("select sql from sqlite_master where name='vec_items'").get()?.sql || '' : '';
  const dimensionMatch = schemaSql.match(/emb\s+float\[(\d+)\]/i);
  const dimension = dimensionMatch ? Number(dimensionMatch[1]) : null;
  const itemCount = hasItems ? Number(db.prepare('select count(*) as count from items').get().count) : 0;
  const vectorCount = hasVectors ? Number(db.prepare('select count(*) as count from vec_items').get().count) : 0;
  const missingVectors = hasItems && hasVectors
    ? Number(db.prepare('select count(*) as count from items i left join vec_items v on v.rowid=i.rowid where v.rowid is null').get().count)
    : itemCount;
  const orphanVectors = hasItems && hasVectors
    ? Number(db.prepare('select count(*) as count from vec_items v left join items i on i.rowid=v.rowid where i.rowid is null').get().count)
    : vectorCount;

  const ids = hasItems ? db.prepare('select id from items order by id').all().map((row) => String(row.id)) : [];
  const kindCounts = {};
  if (hasItems) {
    for (const row of db.prepare("select coalesce(kind, '') as kind, count(*) as count from items group by kind order by kind").all()) {
      kindCounts[row.kind || 'untyped'] = Number(row.count);
    }
  }

  const metadata = {};
  const metadataErrors = [];
  if (hasMetadata) {
    for (const row of db.prepare('select k,v from index_meta order by k').all()) {
      try {
        const parsed = JSON.parse(row.v);
        const canonical = canonicalJson(parsed);
        metadata[row.k] = { type: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed, sha256: sha256Text(canonical) };
      } catch (error) {
        metadataErrors.push(`metadata ${row.k} is invalid JSON: ${error.message}`);
      }
    }
  }
  const checks = {
    schema_present: hasItems && hasVectors && hasMetadata,
    dimension_detected: Number.isInteger(dimension) && dimension > 0,
    item_vector_parity: itemCount === vectorCount && missingVectors === 0 && orphanVectors === 0,
    metadata_valid: metadataErrors.length === 0,
  };
  errors.push(...metadataErrors);
  if (!checks.schema_present) errors.push('index schema is incomplete');
  if (!checks.dimension_detected) errors.push('vector dimension could not be read from vec_items');
  if (!checks.item_vector_parity) errors.push(`item/vector parity failed: items=${itemCount} vectors=${vectorCount} missing=${missingVectors} orphan=${orphanVectors}`);
  return {
    schema: 'slipstream/inspect/v1',
    db: resolved,
    dimension,
    item_count: itemCount,
    vector_count: vectorCount,
    missing_vectors: missingVectors,
    orphan_vectors: orphanVectors,
    ids_sha256: sha256Text(canonicalJson(ids)),
    kind_counts: kindCounts,
    metadata_keys: Object.keys(metadata).sort(),
    metadata,
    checks,
    ok: errors.length === 0,
    errors,
  };
}

function inspectIndex(dbPath) {
  const resolved = path.resolve(String(dbPath));
  const readOnly = openReadOnlyIndex(resolved);
  try { return inspectDb(readOnly.db, resolved); }
  finally { readOnly.close(); }
}

function parseVecDebug(debug) {
  const fields = {};
  for (const line of String(debug || '').split('\n')) {
    const split = line.indexOf(':');
    if (split > 0) fields[line.slice(0, split).trim().toLowerCase().replaceAll(' ', '_')] = line.slice(split + 1).trim();
  }
  return fields;
}

function parseVecMetric(schemaSql) {
  const match = String(schemaSql || '').match(/distance_metric\s*=\s*([a-z0-9_]+)/i);
  return match ? match[1].toLowerCase() : 'l2';
}

function packageIdentity() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || null;
    return { name: pkg.name || null, version: pkg.version || null, repository };
  } catch { return { name: null, version: null, repository: null }; }
}

function vectorManifestRows(db, dimension) {
  const items = db.prepare('select rowid,id,kind,name,title,one_liner,meta from items order by rowid').all();
  const vectors = new Map(db.prepare('select rowid,emb from vec_items order by rowid').all().map((row) => [String(row.rowid), row.emb]));
  return items.map((row) => {
    const vector = vectors.get(String(row.rowid));
    if (!vector) throw new Error(`missing vector for item rowid ${row.rowid}`);
    if (!Buffer.isBuffer(vector) || vector.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) throw new Error(`item rowid ${row.rowid} vector has invalid float32 byte length`);
    const floats = new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength / Float32Array.BYTES_PER_ELEMENT);
    if (Array.from(floats).some((value) => !Number.isFinite(value))) throw new Error(`item rowid ${row.rowid} vector contains non-finite values`);
    const optionalDigest = (value) => value === null || value === undefined ? null : sha256Text(String(value));
    let metaDigest = null;
    if (row.meta !== null) {
      let parsed;
      try { parsed = JSON.parse(row.meta); }
      catch (error) { throw new Error(`item ${row.id} metadata is invalid JSON: ${error.message}`); }
      metaDigest = sha256Text(canonicalJson(parsed));
    }
    return {
      id_sha256: sha256Text(String(row.id)),
      kind_sha256: optionalDigest(row.kind),
      name_sha256: optionalDigest(row.name),
      title_sha256: optionalDigest(row.title),
      one_liner_sha256: optionalDigest(row.one_liner),
      meta_sha256: metaDigest,
      vector_sha256: crypto.createHash('sha256').update(vector).digest('hex'),
    };
  }).sort((a, b) => a.id_sha256.localeCompare(b.id_sha256));
}

function manifestMetadata(db) {
  const rows = db.prepare('select k,v from index_meta order by k').all();
  const summary = {};
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.v); }
    catch (error) { throw new Error(`metadata ${row.k} is invalid JSON: ${error.message}`); }
    summary[row.k] = {
      type: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
      sha256: sha256Text(canonicalJson(parsed)),
    };
  }
  return summary;
}

function createManifest(dbPath) {
  const resolved = path.resolve(String(dbPath));
  const readOnly = openReadOnlyIndex(resolved);
  const db = readOnly.db;
  try {
    const inspected = inspectDb(db, resolved);
    if (!inspected.ok) throw new Error(`cannot create manifest from invalid index: ${inspected.errors.join('; ')}`);
    const sql = db.prepare("select sql from sqlite_master where name='vec_items'").get()?.sql || '';
    const dimensionMatch = sql.match(/emb\s+float\[(\d+)\]/i);
    const rows = vectorManifestRows(db, dimensionMatch ? Number(dimensionMatch[1]) : null);
    const version = db.prepare('select vec_version() as version').get()?.version || null;
    const debug = db.prepare('select vec_debug() as debug').get()?.debug || '';
    const debugFields = parseVecDebug(debug);
    const pkg = packageIdentity();
    const manifest = {
      schema: 'slipstream/manifest/v1',
      package: pkg,
      package_version: pkg.version,
      index_family: 'float',
      vector_type: 'float32',
      vector_byte_order: 'little-endian',
      metric: parseVecMetric(sql),
      dimension: dimensionMatch ? Number(dimensionMatch[1]) : null,
      sqlite_version: db.prepare('select sqlite_version() as version').get()?.version || null,
      sqlite_vec: {
        version,
        commit: debugFields.commit || null,
        build_flags: debugFields.build_flags || null,
        debug_sha256: sha256Text(debug),
      },
      item_count: rows.length,
      vector_count: rows.length,
      ids_sha256: sha256Text(canonicalJson(db.prepare('select id from items order by id').all().map((row) => sha256Text(String(row.id))))),
      rows_sha256: sha256Text(canonicalJson(rows)),
      metadata: manifestMetadata(db),
      rows,
    };
    manifest.manifest_sha256 = sha256Text(canonicalJson(manifest));
    return manifest;
  } finally { readOnly.close(); }
}

function verifyManifest(dbPath, manifestPath) {
  const resolved = path.resolve(String(dbPath));
  const source = path.resolve(String(manifestPath));
  const errors = [];
  let expected;
  try { expected = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch (error) { return { schema: 'slipstream/verify/v1', ok: false, index_state: 'unknown', errors: [`manifest is unreadable JSON: ${error.message}`] }; }
  if (!expected || expected.schema !== 'slipstream/manifest/v1') errors.push('manifest schema is unsupported');
  if (expected && expected.manifest_sha256 !== sha256Text(canonicalJson(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'manifest_sha256'))))) errors.push('manifest_sha256 does not match canonical manifest content');
  let actual = null;
  try { actual = createManifest(resolved); }
  catch (error) { errors.push(error.message); }
  if (actual && expected) {
    const expectedUnsigned = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'manifest_sha256'));
    const actualUnsigned = Object.fromEntries(Object.entries(actual).filter(([key]) => key !== 'manifest_sha256'));
    if (canonicalJson(expectedUnsigned) !== canonicalJson(actualUnsigned)) errors.push('manifest does not match current index content');
  }
  return {
    schema: 'slipstream/verify/v1',
    ok: errors.length === 0,
    index_state: errors.length === 0 ? 'matched' : actual ? 'mismatch' : 'unknown',
    manifest_sha256: typeof expected?.manifest_sha256 === 'string' ? expected.manifest_sha256 : null,
    current_manifest_sha256: actual?.manifest_sha256 || null,
    errors,
  };
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
  packBits, quantizeBits, createSchemaBit, buildBit, searchBit, inspectIndex, createManifest, verifyManifest };
