import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./viewer.css";

const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId") || "";
const path = params.get("path") || "";
const name = params.get("name") || path.split("/").pop() || "远程文件";
const english = params.get("language") === "en-US";
const isTauri = "__TAURI_INTERNALS__" in window;
const appWindow = isTauri ? getCurrentWindow() : {
  toggleMaximize: async () => {},
  isFullscreen: async () => false,
  setFullscreen: async () => {},
  destroy: async () => window.close(),
  onCloseRequested: async () => () => {},
};
const el = (id) => document.getElementById(id);
let original = "";
let encoding = "utf8";
let closeApproved = false;
let findIndex = -1;
let toastTimer;
let fileOffset = 0;
let totalSize = 0;
let binary = false;
let streamingDecoder = null;
let sessionClosed = false;
let fileEof = false;
const preferenceMb = (name, fallback, maximum) => Math.max(1, Math.min(maximum, Number(params.get(name)) || fallback)) * 1024 * 1024;
let fileChunkSize = preferenceMb("chunkSizeMb", 4, 64);
let editSizeLimit = preferenceMb("editLimitMb", 32, 1024);

document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.lang = english ? "en" : "zh-CN";
el("fileName").textContent = name;
el("filePath").textContent = path;

function tr(zh, en) { return english ? en : zh; }
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
function showToast(message) {
  clearTimeout(toastTimer);
  el("toast").textContent = message;
  el("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => el("toast").classList.add("hidden"), 2400);
}
function base64ToBytes(base64) {
  const normalized = base64.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function binaryToHex(base64, baseOffset = 0) {
  const binary = atob(base64.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const lines = [];
  for (let offset = 0; offset < binary.length; offset += 16) {
    const bytes = [...binary.slice(offset, offset + 16)].map((char) => char.charCodeAt(0));
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = bytes.map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${(baseOffset + offset).toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}
function updateLines() {
  el("lineNumbers").textContent = Array.from({ length: el("editor").value.split("\n").length }, (_, index) => index + 1).join("\n");
}
async function readRemote() {
  fileOffset = 0;
  totalSize = 0;
  binary = false;
  streamingDecoder = null;
  el("editor").value = "";
  await loadNextChunk();
}
async function loadNextChunk() {
  if (sessionClosed) return showToast(tr("原终端会话已关闭", "The terminal session has been closed"));
  el("loadMore").disabled = true;
  el("status").textContent = tr("正在读取…", "Loading…");
  try {
    let result;
    try { result = await invoke("sftp_read_chunk", { id: sessionId, path, offset: fileOffset, limit: fileChunkSize }); }
    catch (error) {
      if (!/SFTP|session|transport|channel|连接|会话/i.test(String(error))) throw error;
      await invoke("sftp_reconnect", { id: sessionId });
      result = await invoke("sftp_read_chunk", { id: sessionId, path, offset: fileOffset, limit: fileChunkSize });
    }
    const bytes = base64ToBytes(result.data);
    if (fileOffset === 0) {
      try {
        if (bytes.includes(0)) throw new Error("binary");
        new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !result.eof });
        streamingDecoder = new TextDecoder("utf-8");
      } catch {
        binary = true;
        encoding = "binary";
      }
    }
    const chunk = binary
      ? `${fileOffset ? "\n" : ""}${binaryToHex(result.data, fileOffset)}`
      : streamingDecoder.decode(bytes, { stream: !result.eof });
    el("editor").value += chunk;
    fileOffset = result.offset;
    totalSize = result.total;
    fileEof = result.eof;
    encoding = binary ? "binary" : "utf8";
    el("encoding").textContent = binary ? tr("二进制 · HEX（只读）", "Binary · HEX (read-only)") : "UTF-8";
    el("fileSize").textContent = result.eof ? formatSize(totalSize) : `${formatSize(fileOffset)} / ${formatSize(totalSize)}`;
    el("loadMore").classList.toggle("hidden", result.eof);
    el("loadMore").disabled = result.eof;
    const editable = result.eof && !binary && totalSize <= editSizeLimit;
    el("toggleEdit").disabled = !editable;
    if (result.eof) original = el("editor").value;
    el("status").textContent = result.eof
      ? (editable ? tr("只读预览，可切换编辑", "Read-only preview; editing is available") : tr("只读预览", "Read-only preview"))
      : tr("已分块加载，点击“继续加载”读取后续内容", "Loaded in chunks; choose Load more to continue");
    updateLines();
  } catch (error) {
    el("status").textContent = tr("读取失败", "Read failed");
    showToast(String(error));
    el("loadMore").disabled = false;
  } finally { el("loading").classList.add("hidden"); }
}
async function saveRemote() {
  if (sessionClosed) return showToast(tr("原终端会话已关闭，不能保存", "The terminal session is closed and the file cannot be saved"));
  if (encoding !== "utf8" || el("editor").readOnly) return;
  el("saveFile").disabled = true;
  el("status").textContent = tr("正在保存…", "Saving…");
  try {
    await invoke("sftp_write_text", { id: sessionId, path, content: el("editor").value });
    original = el("editor").value;
    el("status").textContent = tr("已保存", "Saved");
    showToast(tr("远程文件已保存", "Remote file saved"));
  } catch (error) {
    el("saveFile").disabled = false;
    el("status").textContent = tr("保存失败", "Save failed");
    showToast(String(error));
  }
}
function find(move = true, previous = false) {
  const query = el("findInput").value;
  if (!query) { el("findCount").textContent = ""; return; }
  const content = el("editor").value.toLowerCase();
  const needle = query.toLowerCase();
  const matches = [];
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) >= 0) { matches.push(offset); offset += Math.max(1, needle.length); }
  if (!matches.length) { findIndex = -1; el("findCount").textContent = tr("无匹配", "No matches"); return; }
  if (move) findIndex = previous ? (findIndex - 1 + matches.length) % matches.length : (findIndex + 1) % matches.length;
  else findIndex = 0;
  const index = matches[findIndex];
  el("editor").focus();
  el("editor").setSelectionRange(index, index + query.length);
  const line = content.slice(0, index).split("\n").length - 1;
  const lineHeight = Number.parseFloat(getComputedStyle(el("editor")).lineHeight) || 20;
  el("editor").scrollTop = Math.max(0, line * lineHeight - el("editor").clientHeight / 2);
  el("findCount").textContent = `${findIndex + 1}/${matches.length}`;
}

el("toggleEdit").addEventListener("click", () => {
  el("editor").readOnly = !el("editor").readOnly;
  const editing = !el("editor").readOnly;
  el("toggleEdit").classList.toggle("active", editing);
  el("toggleEdit").textContent = editing ? tr("只读", "Read only") : tr("编辑", "Edit");
  el("saveFile").disabled = !editing;
  el("status").textContent = editing ? tr("编辑模式", "Edit mode") : tr("只读预览", "Read-only preview");
  if (editing) el("editor").focus();
});
el("toggleLines").addEventListener("click", () => {
  const hidden = el("lineNumbers").classList.toggle("hidden");
  el("editor").classList.toggle("no-lines", hidden);
  el("toggleLines").classList.toggle("active", !hidden);
});
el("editor").addEventListener("input", () => { updateLines(); el("status").textContent = tr("未保存", "Unsaved"); });
el("editor").addEventListener("scroll", () => { el("lineNumbers").scrollTop = el("editor").scrollTop; });
el("saveFile").addEventListener("click", saveRemote);
el("loadMore").addEventListener("click", loadNextChunk);
el("openFind").addEventListener("click", () => { el("findBar").classList.remove("hidden"); el("findInput").focus(); el("findInput").select(); });
el("closeFind").addEventListener("click", () => el("findBar").classList.add("hidden"));
el("findInput").addEventListener("input", () => find(false));
el("findNext").addEventListener("click", () => find(true));
el("findPrevious").addEventListener("click", () => find(true, true));
el("toggleMaximize").addEventListener("click", () => appWindow.toggleMaximize());
el("toggleFullscreen").addEventListener("click", async () => appWindow.setFullscreen(!(await appWindow.isFullscreen())));
el("keepEditing").addEventListener("click", () => el("confirmClose").classList.add("hidden"));
el("discardChanges").addEventListener("click", async () => { closeApproved = true; await appWindow.destroy(); });
appWindow.onCloseRequested((event) => {
  if (!closeApproved && !el("editor").readOnly && el("editor").value !== original) {
    event.preventDefault();
    el("confirmClose").classList.remove("hidden");
  }
}).catch(() => {});
if (isTauri) {
  listen("orbiterm-session-closed", () => {
    sessionClosed = true;
    el("editor").readOnly = true;
    el("toggleEdit").disabled = true;
    el("saveFile").disabled = true;
    el("loadMore").disabled = true;
    el("status").textContent = tr("原终端会话已关闭，仅保留当前预览", "The terminal session is closed; the current preview is retained");
    showToast(tr("原终端会话已关闭", "The terminal session has been closed"));
  }).catch(() => {});
  listen("orbiterm-tool-preferences", ({ payload }) => {
    fileChunkSize = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, Number(payload.chunkSize) || fileChunkSize));
    editSizeLimit = Math.max(1024 * 1024, Math.min(1024 * 1024 * 1024, Number(payload.editLimit) || editSizeLimit));
    const editable = fileEof && !binary && totalSize <= editSizeLimit && !sessionClosed;
    if (!editable && !el("editor").readOnly) {
      el("editor").readOnly = true;
      el("toggleEdit").classList.remove("active");
      el("saveFile").disabled = true;
      showToast(tr("新的文件编辑上限已生效，当前文件切换为只读", "The new edit limit is active; this file is now read-only"));
    }
    el("toggleEdit").disabled = !editable;
  }).catch(() => {});
}
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && key === "s") { event.preventDefault(); void saveRemote(); }
  if (event.ctrlKey && key === "f") { event.preventDefault(); el("findBar").classList.remove("hidden"); el("findInput").focus(); el("findInput").select(); }
  if (event.key === "F11") { event.preventDefault(); void appWindow.isFullscreen().then((value) => appWindow.setFullscreen(!value)); }
  if (event.key === "Escape" && !el("findBar").classList.contains("hidden")) el("findBar").classList.add("hidden");
});

void readRemote();
