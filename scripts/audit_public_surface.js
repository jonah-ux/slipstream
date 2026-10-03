#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "slipstream-public-audit/v1";
const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["openai_key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

function digest(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

function revision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {cwd: ROOT, encoding: "utf8"});
  const value = (result.stdout || "").trim();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {cwd: ROOT});
  if (result.status !== 0) return [];
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((item) => path.join(ROOT, item));
}

function secretScan(files = trackedFiles()) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (path.basename(file) === "SHA256SUMS" || !fs.existsSync(file)) continue;
    let raw;
    try { raw = fs.readFileSync(file); } catch { continue; }
    if (raw.subarray(0, 4096).includes(0)) continue;
    scanned += 1;
    const text = raw.toString("utf8");
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) findings.push({path: path.relative(ROOT, file).replaceAll(path.sep, "/"), class: name});
    }
  }
  return {state: findings.length === 0 ? "pass" : "blocked", files_scanned: scanned, findings};
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function dependencyInventory() {
  const project = readJson(path.join(ROOT, "package.json"));
  const lock = readJson(path.join(ROOT, "package-lock.json"));
  if (!project || !lock || typeof project.dependencies !== "object" || !project.dependencies) {
    return {state: "blocked", reason: "package_or_lockfile_invalid"};
  }
  const root = lock.packages && lock.packages[""];
  const valid = root && root.name === project.name && root.version === project.version;
  return {
    state: valid ? "pass" : "blocked",
    package_name: project.name,
    package_version: project.version,
    runtime_dependencies: Object.keys(project.dependencies).sort(),
    lockfile: "package-lock.json",
  };
}

function licenseInventory() {
  const project = readJson(path.join(ROOT, "package.json"));
  let text;
  try { text = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"); } catch { text = ""; }
  return {state: project && typeof project.license === "string" && text.trim() ? "pass" : "blocked", license_file: text.trim() ? "LICENSE" : null, license_declared: project?.license || null};
}

function releaseProvenance() {
  let workflow;
  try { workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8"); } catch { return {state: "blocked", reason: "release_workflow_missing"}; }
  const markers = {checksum_manifest: "SHA256SUMS", tag_gate: "refs/tags", artifact_build: "npm pack", release_publish: "gh release"};
  const present = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, workflow.includes(marker)]));
  const docs = Object.fromEntries(["PROVENANCE.md", "SECURITY.md"].map((name) => [name, fs.existsSync(path.join(ROOT, name))]));
  return {state: Object.values(present).every(Boolean) && Object.values(docs).every(Boolean) ? "pass" : "blocked", workflow_markers: present, docs};
}

function checksums(file) {
  const result = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[0])) result[path.basename(parts[parts.length - 1])] = parts[0];
  }
  return result;
}

function artifactAudit(distDir) {
  if (!distDir) return {state: "unavailable", reason: "dist_dir_not_provided"};
  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) return {state: "unavailable", reason: "dist_dir_missing"};
  const sums = path.join(distDir, "SHA256SUMS");
  const assets = fs.readdirSync(distDir).filter((name) => name.endsWith(".tgz")).sort();
  if (!assets.length || !fs.existsSync(sums)) return {state: "unavailable", reason: "artifacts_or_checksums_missing"};
  const expected = checksums(sums);
  const observations = assets.map((name) => ({name, bytes: fs.statSync(path.join(distDir, name)).size, sha256: digest(fs.readFileSync(path.join(distDir, name)))}));
  const mismatches = observations.filter((item) => expected[item.name] !== item.sha256).map((item) => item.name);
  return {state: mismatches.length === 0 ? "pass" : "blocked", assets: observations, mismatches, checksum_manifest_sha256: digest(fs.readFileSync(sums))};
}

function audit(distDir = null) {
  const dependency = dependencyInventory();
  const license = licenseInventory();
  const provenance = releaseProvenance();
  const privacy = secretScan();
  const artifacts = artifactAudit(distDir);
  const staticPass = [dependency, license, provenance, privacy].every((item) => item.state === "pass");
  return {
    schema: SCHEMA,
    source: {revision: revision(), node: process.version},
    dependency_inventory: dependency,
    license_inventory: license,
    release_provenance: provenance,
    privacy_scan: privacy,
    artifact_audit: artifacts,
    result: staticPass ? "pass" : "blocked",
    limits: ["secret scanning uses high-signal patterns and is not complete semantic DLP", "artifact checks are unavailable without an explicit dist directory", "a passing audit does not claim security, deployment, adoption, or production readiness"],
  };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const index = argv.indexOf("--dist-dir");
  const distDir = index >= 0 ? path.resolve(argv[index + 1]) : null;
  const report = audit(distDir);
  console.log(JSON.stringify(report, null, json ? 2 : 0));
  return report.result === "pass" ? 0 : 2;
}

if (require.main === module) process.exitCode = main();
module.exports = {audit, secretScan, artifactAudit};
