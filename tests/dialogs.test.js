import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogCss = readFileSync(new URL("../src/styles/v2-dialogs.css", import.meta.url), "utf8");
const viewerCss = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("lightweight prompts float without a full-window mask", () => {
  assert.doesNotMatch(dialogCss, /\.modal,\s*\.settings-overlay,\s*\.app-prompt\s*\{/);
  assert.match(dialogCss, /\.app-prompt\s*\{[^}]*top:\s*72px[^}]*left:\s*50%[^}]*width:\s*min\(380px/s);
  const rule = dialogCss.match(/\.app-prompt\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(rule, /inset:\s*auto/);
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /backdrop-filter:\s*none/);
  assert.match(mainSource, /id="appPrompt"[^>]*aria-modal="false"/);
});

test("new-session dialog follows the settings two-column layout", () => {
  assert.match(dialogCss, /#sessionModal \.dialog-body\s*\{[^}]*grid-template-columns:\s*156px minmax\(0, 1fr\)/s);
  assert.match(dialogCss, /#sessionModal \.session-form-tabs\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(dialogCss, /#sessionModal \.session-form-page\s*\{[^}]*grid-column:\s*2/s);
  assert.match(mainSource, /class="session-page-title">基本信息</);
});

test("file viewer confirmations use the same mask-free prompt treatment", () => {
  const rule = viewerCss.match(/\.viewer-confirm\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(rule, /top:\s*44px/);
  assert.match(rule, /left:\s*50%/);
  assert.doesNotMatch(rule, /inset:|background:/);
});

test("blocking dialogs keep only a light static backdrop", () => {
  const rule = dialogCss.match(/\.modal,\s*\.settings-overlay\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(rule, /background:\s*rgba\(0, 0, 0, 0\.32\)/);
  assert.doesNotMatch(rule, /backdrop-filter:/);
});
