# Architecture

Slipstream is intentionally a small local index, with the CLI kept thin around one engine:

```text
caller-owned JSON vectors
          |
          v
  input normalization + float32 encoding
          |
          v
  atomic SQLite/sqlite-vec build
          |
          +--> query / benchmark (read path)
          +--> inspect (structural parity readback)
          +--> manifest (redacted content identity)
                    |
                    v
                 verify (recomputed readback)
```

## Ownership boundaries

- **CLI** (`bin/slipstream.js`) parses explicit arguments and emits stable JSON or concise errors. It does not implement persistence rules a second time.
- **Build and persistence** (`lib/engine.js`) normalize finite vectors, enforce one dimension, write SQLite and sqlite-vec state in a temporary location, and replace the destination only after a complete build succeeds.
- **Query and benchmark** operate on an opened index and return deterministic item identity plus measured timing. Embedding generation and provider calls remain caller-owned.
- **Inspect** checks table presence, vector dimension, item/vector parity, orphan rows, metadata JSON, stable identity, and kind counts without exposing caller metadata or vectors.
- **Manifest and verify** bind runtime identity, SQLite/sqlite-vec versions, canonical metadata digests, row identity, and little-endian float32 bytes. Verify regenerates the same facts from a read-only copy and refuses drift.

## Invariants

1. Input vectors are finite numeric values with one fixed dimension.
2. A failed build cannot replace an existing valid index.
3. Read-only inspection never mutates the caller's database; it reads a private copy so WAL sidecars are handled consistently.
4. Query output is machine-readable and stable in shape.
5. Metadata and vectors are caller-owned data; manifests expose digests and types rather than raw values.
6. Equivalent object-key ordering and input ordering produce the same canonical content identity.
7. Runtime identity is part of the manifest contract; a different sqlite-vec or package runtime is a verification failure.

## Failure model

Empty or all-invalid input, dimension mismatch, non-finite values, malformed metadata, missing/orphan rows, vector-byte drift, dimension drift, runtime mismatch, and incomplete SQLite schema fail with non-zero results or thrown errors. Temporary build files are cleaned up on failure, and the previous destination remains available for a retry.

Binary-vector callers use the same bounded local boundary. `buildBit` keeps the existing
`docs`/`vec_docs` schema, skips rows whose `bitstring` is not a string, has the wrong dimension,
or contains a character outside `0` and `1`, and returns `{ indexed, skipped, errors }`. Each error
contains the input row index, a stable code, and a concise message. Direct `packBits` calls throw
for the same malformed values instead of coercing unexpected characters to zero. The CLI does not
own a separate bit-index format; callers read the returned accounting and inspect the local SQLite
tables they own.

## Non-goals

Slipstream does not generate embeddings, call a hosted provider, expose a hosted search API, store private corpora, or claim retrieval quality from a synthetic fixture alone. Benchmarks are measurements of the selected local runtime and fixture.
