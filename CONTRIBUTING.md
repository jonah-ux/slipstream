# Contributing

Small, focused pull requests are welcome. A useful change includes a fixture
or test, a deterministic command, and a short note explaining what the result
proves.

Run the full local gate before opening a pull request:

```bash
npm ci
npm test
git diff --check
```

Keep provider integrations, credentials, private corpora, and generated index
files out of the repository. Slipstream stays provider-neutral: callers own
embedding and pass vectors through the documented contract.
