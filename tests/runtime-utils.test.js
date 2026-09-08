import test from "node:test";
import assert from "node:assert/strict";
import { appendTextLines, findLimitedLineMatches, isTransientSftpError, normalizeImportedSessions, splitTrailingShellPrompt } from "../src/runtime-utils.js";

test("SFTP retry only accepts transport failures", () => {
  assert.equal(isTransientSftpError("transport read"), true);
  assert.equal(isTransientSftpError("Broken pipe"), true);
  assert.equal(isTransientSftpError("Permission denied"), false);
  assert.equal(isTransientSftpError("No such file"), false);
});

test("tail chunks preserve partial and complete lines", () => {
  let lines = appendTextLines([], "first\nsec");
  lines = appendTextLines(lines, "ond\nthird\n");
  assert.deepEqual(lines, ["first", "second", "third", ""]);
});

test("tail search limits matches and reports truncation", () => {
  assert.deepEqual(findLimitedLineMatches(["one", "two", "ONE"], "one"), {
    matches: [0, 2],
    truncated: false,
  });
  assert.deepEqual(findLimitedLineMatches(["x", "x", "x"], "x", 2), {
    matches: [0, 1],
    truncated: true,
  });
});

test("separates a trailing shell prompt without removing its preceding line break", () => {
  assert.deepEqual(splitTrailingShellPrompt("Welcome\r\n[tus@node52 ~]$ "), {
    before: "Welcome\r\n",
    prompt: "[tus@node52 ~]$ ",
  });
  assert.deepEqual(splitTrailingShellPrompt("[tus@node52 ~]$ "), {
    before: "",
    prompt: "[tus@node52 ~]$ ",
  });
  assert.equal(splitTrailingShellPrompt("command output\r\n"), null);
});

test("session import rejects invalid entries and replaces duplicate ids", () => {
  let sequence = 0;
  const sessions = normalizeImportedSessions([
    { id: "same", name: " One ", host: " host ", port: 22 },
    { id: "same", name: "Two", host: "host", port: 22 },
    { name: "Bad", host: "host", port: 70000 },
  ], [], () => `generated-${++sequence}`);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, "same");
  assert.equal(sessions[1].id, "generated-1");
  assert.equal(sessions[0].name, "One");
  assert.equal(sessions[0].rememberPassword, false);
});
