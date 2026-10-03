const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const audit = require("../scripts/audit_public_surface.js");

test("public audit passes static surface and marks missing artifacts unavailable", () => {
  const report = audit.audit();
  assert.equal(report.schema, "slipstream-public-audit/v1");
  assert.equal(report.result, "pass");
  for (const key of ["dependency_inventory", "license_inventory", "release_provenance", "privacy_scan"]) assert.equal(report[key].state, "pass");
  assert.equal(report.artifact_audit.state, "unavailable");
});

test("public audit flags a synthetic private key", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slipstream-audit-"));
  const file = path.join(directory, "fixture.txt");
  fs.writeFileSync(file, "-----BEGIN " + "PRIVATE KEY-----\nsynthetic\n");
  const result = audit.secretScan([file]);
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.findings, [{path: path.relative(process.cwd(), file).split(path.sep).join("/"), class: "private_key"}]);
});

test("public audit blocks checksum mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slipstream-dist-"));
  fs.writeFileSync(path.join(directory, "demo.tgz"), "package");
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${"0".repeat(64)}  demo.tgz\n`);
  const result = audit.artifactAudit(directory);
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.mismatches, ["demo.tgz"]);
});
