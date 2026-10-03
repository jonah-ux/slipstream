#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "slipstream-public-audit/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["openai_key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

function digest(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function safeRootPath(relative) {
  const file = path.join(ROOT, relative);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`${relative} is a symlink`);
  const resolved = fs.realpathSync(file);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error(`${relative} escapes root`);
  return resolved;
}
function safeRootText(relative) { return fs.readFileSync(safeRootPath(relative), "utf8"); }
function revision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {cwd: ROOT, encoding: "utf8"});
  const value = (result.stdout || "").trim();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(value) ? value : null;
}
function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {cwd: ROOT});
  if (result.error || result.status !== 0) throw new Error(`git ls-files failed (${result.status ?? "spawn"})`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((item) => path.join(ROOT, item));
}
function secretScan(files = trackedFiles()) {
  const findings = [], errors = [];
  let scanned = 0, skipped = 0;
  if (!files.length) return {state: "blocked", files_scanned: 0, skipped: 0, findings, errors: ["tracked_file_list_empty"]};
  for (const file of files) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { errors.push(`${file}: ${error.message}`); skipped += 1; continue; }
    if (stat.isSymbolicLink()) { findings.push({path: path.relative(ROOT, file), class: "symlink"}); continue; }
    if (!stat.isFile() || path.basename(file) === "SHA256SUMS") { skipped += 1; continue; }
    let raw;
    try { raw = fs.readFileSync(file); } catch (error) { errors.push(`${file}: ${error.message}`); skipped += 1; continue; }
    if (raw.subarray(0, 4096).includes(0)) { skipped += 1; continue; }
    scanned += 1;
    const text = raw.toString("utf8");
    for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push({path: path.relative(ROOT, file).split(path.sep).join("/"), class: name});
  }
  if (!scanned && !errors.length) errors.push("no_readable_text_files");
  return {state: scanned > 0 && !findings.length && !errors.length ? "pass" : "blocked", files_scanned: scanned, skipped, findings, errors};
}
function dependencyInventory() {
  try {
    const project = JSON.parse(safeRootText("package.json"));
    const lock = JSON.parse(safeRootText("package-lock.json"));
    const root = lock.packages && lock.packages[""];
    if (!project || !lock || !project.dependencies || typeof project.dependencies !== "object" || !root || root.name !== project.name || root.version !== project.version) return {state: "blocked", reason: "package_or_lockfile_invalid"};
    return {state: "pass", package_name: project.name, package_version: project.version, runtime_dependencies: Object.keys(project.dependencies).sort(), lockfile: "package-lock.json"};
  } catch (error) { return {state: "blocked", reason: `package_or_lockfile_invalid: ${error.message}`}; }
}
function licenseInventory() {
  try {
    const project = JSON.parse(safeRootText("package.json"));
    const text = safeRootText("LICENSE");
    return {state: typeof project.license === "string" && text.trim() ? "pass" : "blocked", license_file: text.trim() ? "LICENSE" : null, license_declared: project.license || null};
  } catch (error) { return {state: "blocked", error: error.message}; }
}
function releaseProvenance() {
  let workflow;
  try { workflow = safeRootText(".github/workflows/release.yml"); } catch (error) { return {state: "blocked", error: error.message}; }
  workflow = workflow.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const markers = {checksum_manifest: /SHA256SUMS/.test(workflow) && /sha256sum\b/.test(workflow), tag_gate: /refs\/tags/.test(workflow) || /^\s+tags:\s*$/m.test(workflow), artifact_build: /\bnpm pack\b/.test(workflow), release_publish: /gh release create/.test(workflow)};
  const docs = {};
  for (const name of ["PROVENANCE.md", "SECURITY.md"]) { try { docs[name] = Boolean(safeRootText(name).trim()); } catch { docs[name] = false; } }
  return {state: Object.values(markers).every(Boolean) && Object.values(docs).every(Boolean) ? "pass" : "blocked", workflow_markers: markers, docs};
}
function checksums(file) {
  const result = {};
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch (error) { throw new Error(`checksum manifest unreadable: ${error.message}`); }
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const parts = lines[index].trim().split(/\s+/, 2);
    if (parts.length !== 2 || !SHA256.test(parts[0])) throw new Error(`checksum manifest line ${index + 1} is malformed`);
    let name = parts[1].replace(/^\*/, "").replaceAll("\\", "/");
    if (name.startsWith("dist/")) name = name.slice(5);
    if (!name || name.startsWith("/") || name.split("/").includes("..") || path.basename(name) !== name || result[name]) throw new Error(`checksum manifest filename on line ${index + 1} is invalid or duplicated`);
    result[name] = parts[0];
  }
  return result;
}
function artifactAudit(distDir) {
  if (!distDir) return {state: "unavailable", reason: "dist_dir_not_provided"};
  let stat;
  try { stat = fs.lstatSync(distDir); } catch { return {state: "blocked", reason: "dist_dir_missing_or_symlink"}; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return {state: "blocked", reason: "dist_dir_missing_or_symlink"};
  const candidates = fs.readdirSync(distDir).filter((name) => name.endsWith(".tgz"));
  if (candidates.length !== 1) return {state: "blocked", reason: "exactly_one_tgz_required"};
  const sums = path.join(distDir, "SHA256SUMS");
  try { if (fs.lstatSync(sums).isSymbolicLink()) return {state: "blocked", reason: "checksum_manifest_symlink"}; } catch { return {state: "blocked", reason: "checksum_manifest_missing"}; }
  let expected;
  try { expected = checksums(sums); } catch (error) { return {state: "blocked", reason: "checksum_manifest_invalid", error: error.message}; }
  if (Object.keys(expected).length !== 1 || !expected[candidates[0]]) return {state: "blocked", reason: "checksum_manifest_asset_set_mismatch"};
  const file = path.join(distDir, candidates[0]);
  const bytes = fs.readFileSync(file);
  const observed = {name: candidates[0], bytes: bytes.length, sha256: digest(bytes)};
  const mismatches = expected[candidates[0]] === observed.sha256 ? [] : [candidates[0]];
  return {state: mismatches.length ? "blocked" : "pass", assets: [observed], mismatches, checksum_manifest_sha256: digest(fs.readFileSync(sums))};
}
function audit(distDir = null, requireDist = false) {
  const sourceRevision = revision();
  const dependency = dependencyInventory();
  const license = licenseInventory();
  const provenance = releaseProvenance();
  const privacy = secretScan();
  const artifacts = artifactAudit(distDir);
  const staticPass = Boolean(sourceRevision) && [dependency, license, provenance, privacy].every((item) => item.state === "pass");
  const artifactPass = artifacts.state === "pass" || (artifacts.state === "unavailable" && !requireDist);
  return {schema: SCHEMA, source: {revision: sourceRevision, node: process.version}, dependency_inventory: dependency, license_inventory: license, release_provenance: provenance, privacy_scan: privacy, artifact_audit: artifacts, result: staticPass && artifactPass ? "pass" : "blocked", limits: ["secret scanning uses high-signal patterns and is not complete semantic DLP", "artifact checks are unavailable without an explicit dist directory", "pass --require-dist when artifact evidence is required for a release review", "a passing audit does not claim security, deployment, adoption, or production readiness"]};
}
function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const requireDist = argv.includes("--require-dist");
  const index = argv.indexOf("--dist-dir");
  const distDir = index >= 0 ? path.resolve(argv[index + 1]) : null;
  const report = audit(distDir, requireDist);
  console.log(JSON.stringify(report, null, json ? 2 : 0));
  return report.result === "pass" ? 0 : 2;
}
if (require.main === module) process.exitCode = main();
module.exports = {audit, secretScan, artifactAudit};
