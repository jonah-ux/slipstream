# Changelog

## 0.2.0 — unreleased

- added a read-only `inspect` command and `slipstream/inspect/v1` contract for
  vector dimension, item/vector parity, orphan and missing rows, stable item
  identity digests, kind counts, and redacted metadata readback;
- added `slipstream/manifest/v1` and `verify` for redacted row/vector content
  identity, sqlite-vec runtime readback, and changed-index refusal;
- made manifests deterministic across input and metadata key ordering, and made
  failed verification return a non-zero CLI exit;
- added finite float32 and non-empty string ID validation, package identity,
  stored-vector byte checks, metric parsing, and atomic manifest output guards;
- resolved symlinked index paths before copying SQLite sidecars and labeled the
  stored vector byte order in the manifest;
- extended the offline self-test and CLI suite to prove the inspect contract and
  refusal behavior when vector parity is damaged.

## 0.1.0 — 2026-09-30

- extracted the generic local SQLite + `sqlite-vec` index core from Jonah's
  internal Slipstream work;
- added an agent-friendly JSON CLI for build, query, benchmark, and self-test;
- added a read-only `inspect` contract for vector parity, metadata validity,
  stable identity digests, and integrity readback;
- added synthetic fixtures, CI, release documentation, and explicit provider
  and privacy boundaries.
