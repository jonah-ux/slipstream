const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {audit} = require("../scripts/audit_public_surface.js");

test("public audit passes static surface and reports omitted artifacts explicitly", () => {
  const report = audit();
  assert.equal(report.schema, "slipstream-public-audit/v1");
  assert.equal(report.result, "pass");
  assert.equal(report.artifact_audit.state, "unavailable");
});

test("public audit blocks tampered packed artifact checksums", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slipstream-audit-"));
  try {
    fs.writeFileSync(path.join(root, "slipstream.tgz"), "tampered");
    fs.writeFileSync(path.join(root, "SHA256SUMS"), `${"0".repeat(64)}  slipstream.tgz\n`);
    const report = audit(root);
    assert.equal(report.artifact_audit.state, "blocked");
    assert.equal(report.result, "blocked");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("public audit blocks omitted or incomplete artifacts in strict mode", () => {
  assert.equal(audit(null, true).result, "blocked");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slipstream-audit-empty-"));
  try {
    assert.equal(audit(root).result, "blocked");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
