# Changelog

## 0.2.0 — unreleased

- added a read-only `inspect` command and `slipstream/inspect/v1` contract for
  vector dimension, item/vector parity, orphan and missing rows, stable item
  identity digests, kind counts, and redacted metadata readback;
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
