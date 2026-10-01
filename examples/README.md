# Integration examples

`caller_owned_vectors.js` shows the intended application boundary: the caller owns embedding generation, while Slipstream owns a bounded local SQLite + sqlite-vec index and its readback contracts.

```bash
npm ci
npm run integration-example
```

The example builds three caller-owned vectors, queries the nearest workflow, checks structural parity, writes a redacted content manifest, and verifies the manifest from the local index. It makes no network calls and deletes its temporary index after the readback.
