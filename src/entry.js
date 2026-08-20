import { getCurrentWindow } from "@tauri-apps/api/window";

const windowLabel = "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "";
const requestedTool = new URLSearchParams(location.search).get("tool");
const viewer = window.__ORBITERM_TOOL_KIND__ === "file-viewer"
  || requestedTool === "file-viewer"
  || windowLabel.startsWith("tool-file-viewer-");

if (viewer) {
  const template = document.getElementById("viewerTemplate");
  document.body.replaceChildren(template.content.cloneNode(true));
  try {
    await import("./viewer.js");
  } catch (error) {
    document.getElementById("loading")?.classList.add("hidden");
    const editor = document.getElementById("editor");
    if (editor) editor.value = `文件预览器启动失败\n\n${String(error)}`;
    const status = document.getElementById("status");
    if (status) status.textContent = "预览器启动失败";
    document.getElementById("closeWindow")?.addEventListener("click", () => {
      window.__TAURI_INTERNALS__?.invoke("close_current_tool_window");
    });
  }
} else {
  await import("./main.js");
}
