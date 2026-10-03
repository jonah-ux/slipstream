# Agent Systems Lab Slipstream conformance

Slipstream remains the owner of its local index and integrity contracts:
`slipstream/query/v1`, `slipstream/inspect/v1`, `slipstream/manifest/v1`, and
`slipstream/verify/v1`. This fixture and test make the native self-test boundary
explicit without importing Agent Proof at runtime.

The owner self-test proves nearest-neighbor query, read-only inspection, redacted
content manifest generation, deterministic identity across equivalent input order,
and tamper-refusing verification. Vectors and caller metadata remain local; the
existing Agent Proof interop registry is the downstream handoff owner.

Run `npm test` from a fresh checkout. The self-test constructs and removes only
temporary local indexes.
