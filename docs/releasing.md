# Releasing

Slipstream releases are package artifacts, not source snapshots. A release is ready only when the reviewed commit, package metadata, changelog, tag, GitHub release asset, and clean consumer readback all agree.

## Pre-release gate

Run the same checks as CI from a clean checkout:

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm test
npm pack --pack-destination /tmp/slipstream-package
```

Install the generated tarball in a separate directory rather than invoking the source checkout:

```bash
mkdir /tmp/slipstream-consumer
cd /tmp/slipstream-consumer
npm init -y
npm install --ignore-scripts /tmp/slipstream-package/slipstream-local-index-*.tgz
npm rebuild better-sqlite3
./node_modules/.bin/slipstream self-test
```

The self-test must report `pass: true`, `inspect_ok: true`, `manifest_verified: true`, `manifest_deterministic: true`, and `db_removed: true`. If the local npm policy blocks the native `better-sqlite3` build, approve that existing dependency build explicitly or use the hosted CI result; do not claim a consumer pass from a source checkout.

## Publishing a version

1. Update `package.json` and the matching `CHANGELOG.md` entry on a reviewed pull request.
2. Confirm the README install/version language names the same candidate.
3. Merge the reviewed pull request and record the landed commit.
4. Create an annotated tag `vX.Y.Z` on that landed commit and create the GitHub release from the tag.
5. Download the published tarball from the release asset into a new consumer directory.
6. Run the consumer commands above against the published asset, then record the exact version and self-test output in the release notes or issue.
7. Keep the prior release unchanged if any identity, package, runtime, or consumer check disagrees.

The release does not claim provider quality, hosted adoption, or embedding quality. It proves that the published package can build and verify its bounded local index in the tested runtime.
