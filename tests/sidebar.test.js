import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("empty-session sidebar recovery is outside the hidden terminal toolbar", () => {
  const pane = source.indexOf('<section class="terminal-pane terminal-empty">');
  const button = source.indexOf('id="expandEmptySidebar"', pane);
  const toolbar = source.indexOf('<div class="ws-topbar">', pane);
  assert.ok(button > pane && button < toolbar);
  assert.match(source, /el\("expandEmptySidebar"\)\.addEventListener\("click", \(\) => setSidebarCollapsed\(false\)\)/);
});

test("expanding the sidebar clears the persisted collapsed state without requiring a session", () => {
  let collapsed = true, saved = 0, fitted = 0;
  const context = vm.createContext({
    state: { preferences: { sidebarCollapsed: true } },
    document: { querySelector: () => ({ classList: { toggle: (_, value) => { collapsed = value; } } }) },
    savePreferences: () => saved++, requestAnimationFrame: fn => fn(), fitVisibleTerminals: () => fitted++,
  });
  vm.runInContext(source.slice(source.indexOf("function setSidebarCollapsed("), source.indexOf("function persistSessions(")), context);
  context.setSidebarCollapsed(false);
  assert.equal(collapsed, false);
  assert.equal(context.state.preferences.sidebarCollapsed, false);
  assert.equal(saved, 1);
  assert.equal(fitted, 1);
});
