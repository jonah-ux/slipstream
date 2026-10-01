<img src="./docs/hero.svg" alt="Slipstream local index: build, query, prove" width="1200" />

# Slipstream

**A small local vector index for fast, inspectable agent retrieval.**

Slipstream turns caller-owned vectors and metadata into a local SQLite +
`sqlite-vec` index. Build once, query locally, and get stable JSON back. It is
provider-neutral by design: your application owns embedding, while Slipstream
owns the bounded index and the read path.

```text
JSON vectors → local SQLite index → nearest results + timing receipt
```

## Install and run

Requires Node.js 20+.

```bash
git clone https://github.com/jonah-ux/slipstream.git
cd slipstream
npm ci
npm test
```

Build the included synthetic fixture and query it:

```bash
slipstream build --input=examples/items.json --db=.slipstream/demo.db --dim=8
slipstream query --db=.slipstream/demo.db --vector=0.9,0.1,0,0,0,0,0,0 --k=2
slipstream bench --db=.slipstream/demo.db --vector=0.9,0.1,0,0,0,0,0,0 --n=30
slipstream inspect --db=.slipstream/demo.db
```

The query response is machine-readable and intentionally explicit:

```json
{
  "schema": "slipstream/query/v1",
  "results": [{"id": "chatlens", "distance": 0.020000...}],
  "elapsed_ms": 0.2
}
```

Run the fully offline round trip at any time:

```bash
npm run demo
```

Inspect a built index without exposing item metadata or embedding values:

```json
{
  "schema": "slipstream/inspect/v1",
  "dimension": 8,
  "item_count": 4,
  "vector_count": 4,
  "ok": true
}
```

`inspect` is a read-only integrity readback. It checks the vector dimension, item/vector parity,
orphan and missing rows, metadata JSON, stable identity digest, and kind counts. Metadata values
are represented by type and SHA-256 only; source tokens and caller-owned values are not printed.

## Why this exists

Coding agents repeatedly ask a similar question: *which tool or document is
relevant to this task?* A remote search service adds latency and another
failure boundary. Slipstream keeps the index local, uses memory-mapped reads,
and makes the result easy to inspect in a shell or another agent.

The public repository is the generic core extracted from Jonah's larger
Slipstream work. It deliberately excludes Fleet registries, private memory
corpora, hooks, telemetry, credentials, customer data, and internal adapters.

## Contract

- **Input:** non-empty JSON items with an `id` and a fixed-length numeric
  `vector`; optional `kind`, labels, and JSON metadata.
- **Build:** refuses empty or all-invalid inputs and replaces the index only
  after a complete temporary build succeeds.
- **Query:** returns nearest items with distances, stable schema names, and
  elapsed time; optional `--kind` filtering is supported.
- **Inspect:** reads the index without mutation and reports whether its tables,
  vector rows, metadata, and identity summary agree.
- **Failure:** non-zero exit codes and concise stderr messages; no hidden
  network calls or credential reads.

The library API lives in [`lib/engine.js`](lib/engine.js). The CLI is a thin,
agent-friendly wrapper in [`bin/slipstream.js`](bin/slipstream.js).

## Project status

`0.2.0` is the current source candidate. The local float-vector path, synthetic
fixture, inspect readback, CLI contract, and offline tests are covered. Provider
adapters, embedding orchestration, and hosted indexes are intentionally out of
scope. The existing public release remains `v0.1.0` until a new annotated tag
and fresh consumer readback are published.

See [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), and
[`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change.
