import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schemeAnsiColors } from "../src/terminal-schemes.js";

test("client-side terminal colors use packaged ANSI palette classes", () => {
  const colors = schemeAnsiColors();
  assert.equal(colors.green, "\x1b[32m");
  assert.equal(colors.blue, "\x1b[34m");
  assert.equal(colors.dim, "\x1b[90m");
  assert.equal(Object.values(colors).some((value) => value.includes("38;2")), false);
});

test("packaged xterm fallback preserves terminal whitespace metrics", () => {
  const css = readFileSync(new URL("../src/styles/v2-refinements.css", import.meta.url), "utf8");
  assert.match(css, /\.xterm-rows\s*\{[^}]*white-space:\s*pre;/s);
  assert.match(css, /\.xterm-rows\s*\{[^}]*font-family:\s*var\(--term-font-family/s);
  assert.match(css, /\.xterm-rows span\s*\{[^}]*display:\s*inline-block;/s);
});

test("terminal cursor rendering remains owned by xterm", () => {
  const css = readFileSync(new URL("../src/styles/v2-refinements.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.xterm-cursor[^,{]*::before/);
  assert.doesNotMatch(css, /\.xterm-cursor[^{}]*\{[^}]*background:\s*transparent\s*!important/s);
  assert.doesNotMatch(css, /\.xterm-cursor[^{}]*\{[^}]*outline:\s*none\s*!important/s);
});

test("xterm keeps cursor coordinates across wide text and the vi alternate screen", async () => {
  globalThis.self ??= globalThis;
  const xterm = await import("@xterm/xterm");
  const Terminal = xterm.Terminal || xterm.default?.Terminal;
  const terminal = new Terminal({ cols: 20, rows: 6, cursorStyle: "bar", cursorBlink: true });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  try {
    await write("abc");
    assert.deepEqual([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY], [3, 0]);

    await write("\r\n你A");
    assert.deepEqual([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY], [3, 1]);

    await write("\x1b[?1049h\x1b[3;5Hvi\x1b[2 q");
    assert.equal(terminal.buffer.active.type, "alternate");
    assert.deepEqual([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY], [6, 2]);
    assert.equal(terminal._core.optionsService.rawOptions.cursorStyle, "block");
    assert.equal(terminal._core.optionsService.rawOptions.cursorBlink, false);

    await write("\x1b[5 q");
    assert.equal(terminal._core.optionsService.rawOptions.cursorStyle, "bar");
    assert.equal(terminal._core.optionsService.rawOptions.cursorBlink, true);

    await write("\x1b[?1049l");
    assert.equal(terminal.buffer.active.type, "normal");
    assert.deepEqual([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY], [3, 1]);
  } finally {
    terminal.dispose();
  }
});
