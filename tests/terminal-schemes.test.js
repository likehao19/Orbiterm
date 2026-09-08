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
