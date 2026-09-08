import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/browser.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export function", "function");

function harness(invokeHook = async () => {}) {
  const nodes = new Map();
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const handlers = {};
    const item = { id, value: id === "browserZoom" ? "1" : "", textContent: "", disabled: false,
      classList: { contains: (v) => classes.has(v), add: (v) => classes.add(v), remove: (v) => classes.delete(v),
        toggle(v, force = !classes.has(v)) { force ? classes.add(v) : classes.delete(v); } },
      style: { setProperty(key, value) { this[key] = value; } }, clientWidth: 900,
      setAttribute() {}, focus() {}, setPointerCapture() {},
      addEventListener: (event, handler) => { handlers[event] = handler; },
      fire: (event, values = {}) => handlers[event]?.({ preventDefault() {}, pointerId: 1, button: 0, ...values }),
      getBoundingClientRect: () => ({ x: 500, y: 150, width: 400, height: 500 }),
      querySelector: (selector) => node(selector.slice(1)),
    };
    nodes.set(id, item);
    return item;
  }
  const panel = node("panel");
  panel.classList.add("hidden");
  panel.parentElement = node("parent");
  const calls = [], frames = [], events = {};
  const overlay = { id: "settings", visible: false, getClientRects() { return this.visible ? [1] : []; } };
  const context = vm.createContext({
    invoke: async (command, args) => { calls.push(args); return invokeHook(command, args); },
    listen: async (name, handler) => { events[name] = handler; },
    document: { hidden: false, activeElement: null, querySelectorAll: () => [overlay], addEventListener() {} },
    window: { devicePixelRatio: 1.5, addEventListener() {} },
    getComputedStyle: () => ({ visibility: "visible" }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
  });
  vm.runInContext(source, context);
  let opens = 0;
  const controller = context.createBrowserController({ panel, button: node("button"), isTauri: true, tr: (zh) => zh, onLayout() {}, onOpen() { opens++; } });
  const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); frames.splice(0).forEach(fn => fn()); } };
  const open = async () => {
    controller.setAvailable(true);
    node("button").fire("click");
    node("browserAddress").value = "example.com";
    node("browserForm").fire("submit");
    await flush();
  };
  return { node, panel, calls, overlay, controller, events, flush, open, context, opens: () => opens };
}

test("switching to an existing drawer closes the entire browser pane, not only its webview", async () => {
  const h = harness();
  await h.open();
  assert.equal(h.opens(), 1);
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const code = main.slice(main.indexOf("function applyActiveDrawer()"), main.indexOf("function renderTailFiles()"));
  const drawerNodes = new Map();
  const context = vm.createContext({
    state: { activeId: "one", drawerByTerminal: new Map([["one", "sftp"]]) },
    DEFAULT_PREFERENCES: { sftpWidth: 540 }, setSftpWidth() {}, setDrawerWidth() {},
    browserController: h.controller, clearTimeout() {}, requestAnimationFrame() {},
    el: (id) => { if (!drawerNodes.has(id)) drawerNodes.set(id, { classList: { contains: () => true, toggle() {} }, toggleAttribute() {}, setAttribute() {} }); return drawerNodes.get(id); },
  });
  vm.runInContext(code, context);
  context.applyActiveDrawer();
  await h.flush();
  assert.equal(h.panel.classList.contains("hidden"), true);
  assert.equal(h.calls.at(-1).action, "hide");
});

test("browser drawer uses the SFTP width limits inside the workspace", () => {
  const h = harness();
  assert.equal(h.context.clampBrowserWidth(1000, 900), 900);
  assert.equal(h.context.clampBrowserWidth(100, 900), 360);
  assert.equal(h.context.clampBrowserWidth(600, 400), 400);
  assert.equal(h.context.clampBrowserWidth(540, 280), 280);
});

test("reopening the browser resets its dragged width to the shared default", async () => {
  const h = harness();
  await h.open();
  h.node("browserResize").fire("keydown", { key: "ArrowLeft" });
  assert.equal(h.panel.style["--browser-width"], "560px");
  h.node("browserClose").fire("click");
  h.node("button").fire("click");
  await h.flush();
  assert.equal(h.panel.style["--browser-width"], "540px");
});

test("dragging resizes only the browser, hides the native view until release, and supports keyboard resizing", async () => {
  const h = harness();
  await h.open();
  const handle = h.node("browserResize");
  assert.equal(h.panel.style["--browser-width"], "540px");
  handle.fire("pointerdown", { clientX: 500 });
  await h.flush();
  assert.equal(h.calls.at(-1).action, "hide");
  handle.fire("pointermove", { clientX: 400 });
  assert.equal(h.panel.style["--browser-width"], "500px");
  handle.fire("pointerup");
  await h.flush();
  assert.equal(h.calls.at(-1).action, "layout");
  handle.fire("keydown", { key: "ArrowRight" });
  assert.equal(h.panel.style["--browser-width"], "480px");
  handle.fire("pointerdown", { clientX: 500 });
  handle.fire("lostpointercapture");
  await h.flush();
  assert.equal(h.panel.classList.contains("resizing"), false);
});

test("browser is unavailable without a session; navigation and physical layout are ordered", async () => {
  const h = harness();
  h.node("button").fire("click");
  assert.equal(h.panel.classList.contains("hidden"), true);
  await h.open();
  assert.deepEqual(h.calls.map(c => c.action), ["navigate", "zoom", "layout"]);
  assert.equal(h.calls[2].bounds.scale, 1.5);
  assert.equal(h.calls[2].bounds.width, 400);
  assert.equal(h.panel.classList.contains("hidden"), false);
});

test("dialogs hide the native view and closing them restores its bounds", async () => {
  const h = harness();
  await h.open();
  h.overlay.visible = true;
  h.controller.syncLayout();
  await h.flush();
  assert.equal(h.calls.at(-1).action, "hide");
  h.overlay.visible = false;
  h.controller.syncLayout();
  await h.flush();
  assert.equal(h.calls.at(-1).action, "layout");
  const count = h.calls.length;
  h.controller.syncLayout();
  await h.flush();
  assert.equal(h.calls.length, count, "unchanged bounds must not repeatedly resize the native view");
});

test("history, reload and zoom use native controls; last session resets browser state", async () => {
  const h = harness();
  await h.open();
  h.events["orbiterm-browser-state"]({ payload: { url: "https://example.com/next", title: "Next", canGoBack: true, canGoForward: false } });
  assert.equal(h.node("browserAddress").value, "https://example.com/next");
  assert.equal(h.node("browserBack").disabled, false);
  assert.equal(h.node("browserForward").disabled, true);
  h.node("browserBack").fire("click");
  h.node("browserReload").fire("click");
  h.node("browserZoom").value = "1.25";
  h.node("browserZoom").fire("change");
  await h.flush();
  assert.deepEqual(h.calls.slice(-3).map(c => c.action), ["back", "reload", "zoom"]);
  assert.equal(h.calls.at(-1).zoom, 1.25);
  h.controller.setAvailable(false);
  await h.flush();
  assert.equal(h.calls.at(-1).action, "close");
  assert.equal(h.panel.classList.contains("hidden"), true);
  assert.equal(h.node("browserTitle").textContent, "浏览器");
  assert.equal(h.node("browserAddress").value, "");
});

test("closing the last session during navigation cannot resurrect the native browser", async () => {
  let finish;
  const h = harness(async (_, args) => { if (args.action === "navigate") await new Promise(resolve => { finish = resolve; }); });
  await h.open();
  h.controller.setAvailable(false);
  finish();
  await h.flush();
  assert.deepEqual(h.calls.map(c => c.action), ["navigate", "close"]);
  assert.equal(h.panel.classList.contains("hidden"), true);
});

test("browser child does not inherit main window privileges", () => {
  const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.equal(capability.windows, undefined);
  assert.deepEqual(capability.webviews, ["main", "tool-*"]);
  const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(backend, /webview_ref\(\)\.label\(\) == browser::LABEL/);
  assert.match(backend, /Browser pages cannot invoke application commands/);
});
