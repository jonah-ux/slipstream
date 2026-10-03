# Release provenance

Slipstream publishes source releases from annotated `vMAJOR.MINOR.PATCH` tags. The release workflow
checks that the tag version matches `package.json`, that the annotated tag resolves to the checked-out
commit, runs the offline test suite, packs the npm artifact, writes `SHA256SUMS`, and publishes the
packed asset as a prerelease.

The public audit checks these workflow markers, the lockfile/package identity, and the tracked source
surface. It does not claim that npm, GitHub, native-module compilation, or a downstream machine
provides a complete supply-chain guarantee. Artifact verification is only `pass` when an explicit
packed directory and checksum manifest are supplied; otherwise the audit reports `unavailable`.
