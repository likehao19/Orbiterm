import test from "node:test";
import assert from "node:assert/strict";
import { allocateSessionId, appendRollingText, downloadTargetPath, duplicateBaseNames, escapeHtml, formatSize, isRetryableSftpCommand, joinLocal, joinRemote, normalizeRemotePath, parentPath, safeFileName, sanitizeImportedSession } from "../src/core.js";

test("escapes untrusted HTML", () => {
  assert.equal(escapeHtml(`<img src=x onerror='bad'>`), "&lt;img src=x onerror=&#39;bad&#39;&gt;");
});

test("normalizes remote paths without escaping the root", () => {
  assert.equal(normalizeRemotePath("../logs/./app.log", "/srv/app"), "/srv/logs/app.log");
  assert.equal(joinRemote("/", "../../etc"), "/etc");
  assert.equal(parentPath("/srv/log/app.log"), "/srv/log");
});

test("joins native-looking local paths", () => {
  assert.equal(joinLocal("C:\\Temp", "report.log"), "C:\\Temp\\report.log");
  assert.equal(joinLocal("/tmp", "report.log"), "/tmp/report.log");
});

test("places downloaded directories below the selected destination", () => {
  assert.equal(downloadTargetPath("/tmp", { name: "logs", isDir: true }, 1), "/tmp/logs");
  assert.equal(downloadTargetPath("/tmp/report.log", { name: "report.log", isDir: false }, 1), "/tmp/report.log");
  assert.equal(downloadTargetPath("/tmp", { name: "report.log", isDir: false }, 2), "/tmp/report.log");
});

test("formats sizes and safe file names", () => {
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(Number.NaN), "—");
  assert.equal(safeFileName("prod/server:*"), "prod_server__");
});

test("detects duplicate upload basenames", () => {
  assert.deepEqual(duplicateBaseNames(["C:\\a\\config.json", "C:\\b\\config.json", "C:\\b\\readme.md"]), ["config.json"]);
});

test("keeps only the newest rolling log text", () => {
  assert.equal(appendRollingText("1234", "5678", 5), "45678");
});

test("validates and normalizes imported sessions", () => {
  const valid = sanitizeImportedSession({ name: " prod ", host: " example.com ", username: "root", port: "22", timeout: 20, authType: "password", rememberPassword: true });
  assert.equal(valid.name, "prod");
  assert.equal(valid.port, 22);
  assert.equal(valid.rememberPassword, false);
  assert.equal(sanitizeImportedSession({ name: "bad", host: "x", username: "u", port: 70000, authType: "password" }), null);
  assert.equal(sanitizeImportedSession({ name: "bad", host: "x", username: "u", port: 22, authType: "unknown" }), null);
});

test("allocates unique imported session ids", () => {
  const existing = new Set();
  assert.equal(allocateSessionId("same", existing, () => "generated-1"), "same");
  assert.equal(allocateSessionId("same", existing, () => "generated-1"), "generated-1");
  assert.deepEqual([...existing], ["same", "generated-1"]);
});

test("retries only read-only SFTP commands", () => {
  assert.equal(isRetryableSftpCommand("sftp_read_text"), true);
  assert.equal(isRetryableSftpCommand("sftp_remove"), false);
  assert.equal(isRetryableSftpCommand("sftp_write_text"), false);
});
