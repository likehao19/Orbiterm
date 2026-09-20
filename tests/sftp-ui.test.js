import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const pauseCode = section("async function toggleTransferPause(", "function scheduleTailSearch(");
const queueCode = section("function pumpTransferQueue(", "function scheduleTransferProgressRender(");
const widthCode = section("function setSftpWidth(", "function setTransferHeight(");
const drawerWidthCode = section("function setDrawerWidth(", "function installDrawerResize(");

test("each tool drawer resets width when reopened but not while already open", () => {
  const code = section("function applyActiveDrawer()", "function renderTailFiles()");
  for (const type of ["sftp", "tail", "manual"]) {
    let hidden = true;
    const calls = [];
    const context = vm.createContext({
      state: { activeId: "one", drawerByTerminal: new Map([["one", type]]) },
      DEFAULT_PREFERENCES: { sftpWidth: 540 }, browserController: null,
      setSftpWidth: width => calls.push(["sftp", width]), setDrawerWidth: (name, width) => calls.push([name, width]),
      clearTimeout() {}, requestAnimationFrame() {},
      el: () => ({ classList: { contains: () => hidden, toggle() {} }, toggleAttribute() {}, setAttribute() {} }),
    });
    vm.runInContext(code, context);
    context.applyActiveDrawer();
    assert.deepEqual(calls, [[type, 540]]);
    hidden = false;
    context.applyActiveDrawer();
    assert.equal(calls.length, 1);
    hidden = true;
    context.applyActiveDrawer();
    assert.deepEqual(calls, [[type, 540], [type, 540]]);
  }
});

test("Tail and manual drawers use SFTP default width and the same workspace bounds", () => {
  for (const type of ["tail", "manual"]) {
    const panel = { parentElement: { clientWidth: 820 }, style: { setProperty() {} } };
    const context = vm.createContext({ state: { preferences: {} }, el: () => panel, savePreferences() {} });
    vm.runInContext(drawerWidthCode, context);
    context.setDrawerWidth(type, 540);
    assert.equal(panel.style.width, "540px");
    context.setDrawerWidth(type, 1200);
    assert.equal(panel.style.width, "820px");
    panel.parentElement.clientWidth = 280;
    context.setDrawerWidth(type, 540);
    assert.equal(panel.style.width, "280px");
  }
  assert.match(source, /sftpWidth: 540, tailWidth: 540, manualWidth: 540/);
  assert.match(source, /getDefaultWidth: \(\) => DEFAULT_PREFERENCES\.sftpWidth/);
  assert.match(source, /updateActiveStatus\(\);\s*setSftpWidth\(DEFAULT_PREFERENCES\.sftpWidth\);\s*setDrawerWidth\("tail", DEFAULT_PREFERENCES\.sftpWidth\);\s*setDrawerWidth\("manual", DEFAULT_PREFERENCES\.sftpWidth\);/);
});

test("SFTP width stays inside the terminal content, including very narrow workspaces", () => {
  const panel = { parentElement: { clientWidth: 820 }, style: { setProperty() {} } };
  const state = { preferences: {} };
  const context = vm.createContext({ state, detachedSftp: false, el: () => panel, savePreferences() {} });
  vm.runInContext(widthCode, context);
  context.setSftpWidth(1920);
  assert.equal(state.preferences.sftpWidth, 820);
  panel.parentElement.clientWidth = 280;
  context.setSftpWidth(500);
  assert.equal(panel.style.width, "280px");
  context.detachedSftp = true;
  context.setSftpWidth(800);
  assert.equal(panel.style.width, "280px");
});

test("native file drag highlights SFTP and uploads dropped paths", () => {
  const code = section("function handleSftpFileDrag(payload)", "async function openRemoteEditor(");
  const classes = new Set();
  const uploads = [];
  const panel = { dataset: {}, classList: {
    contains: value => classes.has(value),
    toggle: (value, force) => force ? classes.add(value) : classes.delete(value),
    remove: value => classes.delete(value),
  } };
  const context = vm.createContext({
    el: () => panel,
    activeTerminal: () => ({ connected: true }),
    uploadPaths: paths => uploads.push(paths),
    toast() {},
    tr: value => value,
  });
  vm.runInContext(code, context);
  context.handleSftpFileDrag({ type: "enter" });
  assert.equal(classes.has("file-drag-active"), true);
  context.handleSftpFileDrag({ type: "drop", paths: ["C:\\tmp\\a.txt"] });
  assert.equal(classes.has("file-drag-active"), false);
  assert.deepEqual(uploads, [["C:\\tmp\\a.txt"]]);
  assert.match(readFileSync(new URL("../src/styles/v2-tools.css", import.meta.url), "utf8"), /#sftpPanel\.file-drag-active::after/);
});

function pauseHarness(invoke = async () => {}) {
  const task = { terminalId: "one", status: "running", transferred: 256, total: 1024 };
  const context = vm.createContext({ detachedSftp: false, state: { transferMeta: new Map([["t", task]]) },
    invoke, renderTransferTasks() {}, pumpTransferQueue() {} });
  vm.runInContext(pauseCode, context);
  return { context, task };
}
test("pause/resume reaches the backend and preserves the task's byte progress", async () => {
  const calls = [];
  const { context, task } = pauseHarness(async (command, args) => calls.push([command, args.paused]));
  await context.toggleTransferPause("t");
  assert.equal(task.paused, true);
  assert.equal(task.transferred, 256);
  await context.toggleTransferPause("t");
  assert.equal(task.paused, false);
  assert.deepEqual(calls, [["pause_transfer", true], ["pause_transfer", false]]);
});
test("a failed pause does not claim the transfer is paused", async () => {
  const { context, task } = pauseHarness(async () => { throw new Error("disconnected"); });
  await assert.rejects(context.toggleTransferPause("t"), /disconnected/);
  assert.equal(Boolean(task.paused), false);
  assert.equal(task.pausePending, false);
});
test("a detached window forwards controls to the main task owner", async () => {
  const { context, task } = pauseHarness(() => assert.fail("must not own backend tasks"));
  context.detachedSftp = { scopeId: "one" };
  const calls = [];
  context.sendSftpAction = (action, data) => calls.push([action, data.transferId]);
  await context.toggleTransferPause("t");
  assert.deepEqual(calls, [["pause", "t"]]);
  assert.equal(task.transferred, 256);
});
test("paused queued tasks stay queued while other files can transfer", async () => {
  const state = { transferMeta: new Map([["a", { status: "queued", paused: true }], ["b", { status: "queued" }]]),
    transferQueues: { upload: [] }, transferActiveSlots: { upload: new Set() } };
  const context = vm.createContext({ state, transferConcurrency: () => 2 });
  vm.runInContext(queueCode, context);
  const started = [];
  const first = context.enqueueTransferJob("upload", "a", async () => started.push("a"));
  await context.enqueueTransferJob("upload", "b", async () => started.push("b"));
  assert.deepEqual(started, ["b"]);
  state.transferMeta.get("a").paused = false;
  context.pumpTransferQueue("upload");
  await first;
  assert.deepEqual(started, ["b", "a"]);
});
test("new tool-window paths reuse the same frontend and do not restore main window geometry", () => {
  const entry = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8");
  assert.match(entry, /tool-sftp-/);
  assert.match(source, /if \(!detachedSftp\) \{\s*setSidebarCollapsed[\s\S]*?revealMainWindow/);
  assert.match(section("async function requestAppClose()", '  if (state.closing) return;'), /close_current_tool_window/);
});

test("detached controls cannot target another session's transfer", async () => {
  let handler;
  const calls = [];
  const context = vm.createContext({ isTauri: true, detachedSftp: null,
    detachedSftpWindows: new Map([["one", { label: "tool-sftp-one-1" }]]),
    state: { activeId: "two", transferMeta: new Map([["foreign", { terminalId: "two" }], ["own", { terminalId: "one" }]]) },
    listen: async (event, callback) => { handler = callback; },
    emitTo: async () => {}, publishSftpTransfers() {},
    toggleTransferPause: async (id) => calls.push(id),
  });
  vm.runInContext(section("async function installSftpWindowEvents()", "function toggleSftp("), context);
  await context.installSftpWindowEvents();
  await handler({ payload: { action: "pause", sessionId: "one", label: "tool-sftp-one-1", transferId: "foreign" } });
  assert.deepEqual(calls, []);
  await handler({ payload: { action: "pause", sessionId: "one", label: "tool-sftp-one-1", transferId: "own" } });
  assert.deepEqual(calls, ["own"]);
  assert.equal(context.state.activeId, "two");
});

test("closing the detached window only returns the panel; it does not cancel transfers", async () => {
  let handler;
  let reopened = false;
  const tasks = new Map([["active", { terminalId: "one", status: "running", paused: true }]]);
  const context = vm.createContext({ isTauri: true, detachedSftp: null,
    detachedSftpWindows: new Map([["one", { label: "tool-sftp-one-1" }]]),
    state: { activeId: "one", closing: false, transferMeta: tasks },
    listen: async (event, callback) => { handler = callback; },
    toggleSftp: () => { reopened = true; }, emitTo: async () => {},
    cancelTransferTask: () => assert.fail("closing a tool must not cancel transfers"),
  });
  vm.runInContext(section("async function installSftpWindowEvents()", "function toggleSftp("), context);
  await context.installSftpWindowEvents();
  await handler({ payload: { action: "closed", sessionId: "one", label: "tool-sftp-one-1" } });
  assert.equal(reopened, true);
  assert.equal(tasks.get("active").status, "running");
  assert.equal(context.detachedSftpWindows.size, 0);
});
