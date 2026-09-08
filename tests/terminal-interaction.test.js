import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { schemeAnsiColors } from "../src/terminal-schemes.js";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
function section(start, end) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset);
  return source.slice(offset, limit);
}

// Execute the app's actual functions without mounting its WebView-only UI.
const outputCode = section("function paint(style, text)", "const linuxCommands");
const pollingCode = section("function prioritizeTerminalInput(record)", "function scheduleAutoReconnect(record)");
const resizeCode = section("function hasUsableTerminalGeometry(record)", "function createTerminalView(session)");
const bootstrapCode = section("const BOOTSTRAP_MARKER", "function toast(message");
const emptyRead = { data: [], eof: false, pendingInput: false };
const settle = () => new Promise(setImmediate);

function harness() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const reads = [];
  const writes = [];
  const context = vm.createContext({
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    invoke: (command, args) => new Promise((resolve, reject) => reads.push({ command, args, resolve, reject })),
    schemeAnsiColors,
    Uint8Array,
    state: { activeId: "one" },
    updateTerminalState: () => {},
    updateActiveStatus: () => {},
    scheduleAutoReconnect: () => {},
    localizeRuntimeText: String,
    tr: (text) => text,
    toast: () => {},
  });
  vm.runInContext(outputCode + pollingCode, context);
  const record = {
    id: "one", session: { local: false }, connected: true, stopped: false,
    interactiveUntil: 0, readTimer: null, readInFlight: false, readWakeRequested: false,
    emptyReadCount: 0, colorizePending: "", colorizeTimer: null, altScreen: false,
    textDecoder: new TextDecoder(),
    terminal: {
      write: (text) => writes.push({ at: now, text }),
      writeln: (text) => writes.push({ at: now, text }),
    },
  };
  return {
    context, record, reads, writes, timers,
    setNow: (time) => { now = time; },
    async advance(until) {
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = until;
    },
    nextDelay: () => Math.min(...[...timers.values()].map((timer) => timer.at - now)),
  };
}

test("interactive echoes are written immediately instead of waiting 40ms", async () => {
  const h = harness();
  h.context.prioritizeTerminalInput(h.record);
  for (const [at, text] of [[0, "a"], [30, "b"], [60, "c"]]) {
    await h.advance(at);
    h.context.writeColorizedOutput(h.record, text);
  }
  assert.deepEqual(h.writes, [{ at: 0, text: "a" }, { at: 30, text: "b" }, { at: 60, text: "c" }]);
  assert.equal(h.timers.size, 0);
});

test("typing flushes a pending colored prompt before the echo", async () => {
  const h = harness();
  h.context.writeColorizedOutput(h.record, "[user@host ~]$ ");
  assert.equal(h.writes.length, 0);
  await h.advance(10);
  h.context.prioritizeTerminalInput(h.record);
  h.context.writeColorizedOutput(h.record, "x");
  assert.match(h.writes[0].text, /\x1b\[32muser@host/);
  const plain = h.writes.map(({ text }) => text).join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(plain, "[user@host ~]$ x");
  assert.ok(h.writes.every(({ at }) => at === 10));
});

test("non-interactive output retains complete-line rendering and tail batching", async () => {
  const h = harness();
  const complete = "\x1b[32moutput\x1b[0m\r\n".repeat(1000);
  h.context.writeColorizedOutput(h.record, complete + "tail");
  assert.deepEqual(h.writes, [{ at: 0, text: complete }]);
  assert.equal(h.nextDelay(), 40);
  await h.advance(40);
  assert.equal(h.writes[1].text, "tail");
});

test("full-screen applications and editing controls do not wait for a newline", () => {
  const h = harness();
  const chunks = ["\x1b[?1049h", "\x1b[2J\x1b[Habc", "\b \b", "\x1b[?1049l"];
  for (const text of chunks) h.context.writeColorizedOutput(h.record, text);
  assert.equal(h.writes.map(({ text }) => text).join(""), chunks.join(""));
  assert.ok(h.writes.every(({ at }) => at === 0));
  assert.equal(h.timers.size, 0);
  assert.equal(h.record.altScreen, false);
});

test("input wakes an idle reader and keeps echo polling at 16ms", async () => {
  const h = harness();
  h.record.emptyReadCount = 2;
  const idleRead = h.context.readLoop(h.record);
  h.reads[0].resolve(emptyRead);
  await idleRead;
  assert.equal(h.nextDelay(), 150);
  h.context.prioritizeTerminalInput(h.record);
  h.context.wakeTerminalRead(h.record);
  assert.equal(h.reads.length, 2);
  assert.equal(h.timers.size, 0);
  h.reads[1].resolve({ ...emptyRead, data: [97] });
  await settle();
  assert.deepEqual(h.writes, [{ at: 0, text: "a" }]);
  assert.equal(h.nextDelay(), 16);
});

test("rapid wakeups never overlap reads or reorder output", async () => {
  const h = harness();
  h.context.prioritizeTerminalInput(h.record);
  const firstRead = h.context.readLoop(h.record);
  for (let index = 0; index < 20; index += 1) h.context.wakeTerminalRead(h.record);
  assert.equal(h.reads.length, 1);
  h.reads[0].resolve({ ...emptyRead, data: [97] });
  await firstRead;
  assert.equal(h.nextDelay(), 0);
  assert.equal(h.timers.size, 1);
  await h.advance(0);
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve({ ...emptyRead, data: [98] });
  await settle();
  assert.equal(h.writes.map(({ text }) => text).join(""), "ab");
  assert.equal(h.timers.size, 1);
});

test("polling returns to idle frequency after interaction ends", async () => {
  const h = harness();
  h.context.prioritizeTerminalInput(h.record);
  h.setNow(1001);
  const read = h.context.readLoop(h.record);
  h.reads[0].resolve(emptyRead);
  await read;
  assert.equal(h.nextDelay(), 75);
  await h.advance(1076);
  h.reads[1].resolve(emptyRead);
  await settle();
  assert.equal(h.nextDelay(), 150);
});

test("closing a session discards an outstanding read and never restarts polling", async () => {
  const h = harness();
  const read = h.context.readLoop(h.record);
  h.record.stopped = true;
  h.reads[0].resolve({ ...emptyRead, data: [97] });
  await read;
  h.context.wakeTerminalRead(h.record);
  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.reads.length, 1);
  assert.equal(h.record.readInFlight, false);
});

test("interaction priority is isolated per session and also works for local terminals", async () => {
  const h = harness();
  const other = { ...h.record, id: "two" };
  h.record.session.local = true;
  h.context.prioritizeTerminalInput(h.record);
  h.context.writeColorizedOutput(other, "b");
  assert.equal(h.writes.length, 0);
  const read = h.context.readLoop(h.record);
  assert.equal(h.reads[0].command, "local_terminal_read");
  h.reads[0].resolve({ ...emptyRead, data: [97] });
  await read;
  assert.equal(h.writes[0].text, "a");
  await h.advance(40);
  assert.equal(h.writes[1].text, "b");
});

test("input prioritization is wired to both key events and completed writes", () => {
  assert.match(source, /terminal\.onData\(\(data\) => \{\s*if \(record\.connected\) \{\s*prioritizeTerminalInput\(record\)/);
  assert.match(source, /local_terminal_write" : "ssh_write"[^\n]*\n\s*\.then\(\(\) => \{\s*prioritizeTerminalInput\(record\);\s*wakeTerminalRead\(record\)/);
});

function resizeHarness() {
  let timer = null;
  const calls = [];
  const host = { isConnected: true, getBoundingClientRect: () => ({ width: 900, height: 600 }) };
  const context = vm.createContext({
    document: { hidden: false }, window: { innerWidth: 1200, innerHeight: 800 },
    getComputedStyle: () => ({ display: "flex" }), clearTimeout: () => { timer = null; },
    setTimeout: callback => { timer = callback; return 1; }, invoke: (command, args) => { calls.push({ command, args }); return Promise.resolve(); },
    Number,
  });
  vm.runInContext(resizeCode, context);
  const record = { id: "one", host, fit: { fit() {} }, resizeTimer: null, connected: true, session: { local: false }, terminal: { cols: 120, rows: 40 } };
  return { context, record, calls, runTimer: () => timer?.() };
}

test("tiny or hidden terminal geometry never reaches the remote PTY", () => {
  const h = resizeHarness();
  assert.equal(h.context.scheduleTerminalResize(h.record, 2, 30), false);
  assert.equal(h.context.scheduleTerminalResize(h.record, 120, 1), false);
  h.context.document.hidden = true;
  assert.equal(h.context.scheduleTerminalResize(h.record, 120, 40), false);
  h.runTimer();
  assert.equal(h.calls.length, 0);
});

test("a valid terminal resize is rechecked when its debounce expires", () => {
  const h = resizeHarness();
  assert.equal(h.context.scheduleTerminalResize(h.record, 120, 40), true);
  h.record.terminal.cols = 2;
  h.runTimer();
  assert.equal(h.calls.length, 0);
  h.record.terminal.cols = 100;
  assert.equal(h.context.scheduleTerminalResize(h.record, 100, 30), true);
  h.runTimer();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, "ssh_resize");
  assert.equal(h.calls[0].args.id, "one");
  assert.equal(h.calls[0].args.cols, 100);
  assert.equal(h.calls[0].args.rows, 40);
});

test("fit skips collapsed and minimized terminal hosts", () => {
  const h = resizeHarness();
  let fits = 0;
  h.record.fit.fit = () => fits++;
  assert.equal(h.context.fitTerminalRecord(h.record), true);
  h.record.host.getBoundingClientRect = () => ({ width: 2, height: 600 });
  assert.equal(h.context.fitTerminalRecord(h.record), false);
  h.context.window.innerHeight = 0;
  h.record.host.getBoundingClientRect = () => ({ width: 900, height: 600 });
  assert.equal(h.context.fitTerminalRecord(h.record), false);
  assert.equal(fits, 1);
});

test("new SSH and local terminals never start with transient tiny PTY dimensions", () => {
  assert.match(source, /cols: Math\.max\(20, record\.terminal\.cols \|\| 80\), rows: Math\.max\(3, record\.terminal\.rows \|\| 24\), timeoutSeconds/);
  assert.match(source, /local_terminal_open[\s\S]*?cols: Math\.max\(20, record\.terminal\.cols \|\| 80\),\s*rows: Math\.max\(3, record\.terminal\.rows \|\| 24\)/);
});

test("cwd integration waits for a real shell prompt and is attempted only once", () => {
  assert.doesNotMatch(source, /bootstrapFallbackTimer = setTimeout\(\(\) => installCwdIntegration/);
  assert.match(source, /record\.bootstrapAttempted \|\| !record\.bootstrapWanted/);
  assert.match(source, /record\.bootstrapAttempted = true;\s*record\.bootstrapInstalling = true;/);
  assert.match(source, /bootstrapAttempted: false/);
  assert.match(source, /A failed bootstrap must never expose or retry Orbiterm's internal shell command/);
});

test("concurrent cwd integration requests send one command and hide it on timeout", async () => {
  const writes = [], commands = [], timers = [];
  const context = vm.createContext({
    encoder: new TextEncoder(), TextEncoder, TextDecoder, Uint8Array,
    clearTimeout() {}, setTimeout: callback => { timers.push(callback); return timers.length; },
    invoke: async (command, args) => commands.push({ command, args }),
    colorizeClientOutput: (_, text) => text,
  });
  vm.runInContext(bootstrapCode, context);
  const record = {
    id: "one", connected: true, bootstrapInstalled: false, bootstrapInstalling: false,
    bootstrapAttempted: false, bootstrapWanted: true, bootstrapPending: false,
    bootstrapBuffer: new Uint8Array(), bootstrapHiddenPrompt: "[user@host ~]$ ",
    terminal: { write: text => writes.push(text) },
  };
  await Promise.all([context.installCwdIntegration(record, false), context.installCwdIntegration(record, false)]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "ssh_write");
  assert.match(new TextDecoder().decode(new Uint8Array(commands[0].args.data)), /__orbiterm_cwd/);
  record.bootstrapBuffer = new TextEncoder().encode("if [ -n \"$BASH_VERSION\" ]; then internal command");
  timers[0]();
  assert.deepEqual(writes, ["[user@host ~]$ "]);
  await context.installCwdIntegration(record, false);
  assert.equal(commands.length, 1);
});
