import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const windowLabel = "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "";
const requestedTool = new URLSearchParams(location.search).get("tool");
const viewer = window.__ORBITERM_TOOL_KIND__ === "file-viewer"
  || requestedTool === "file-viewer"
  || windowLabel.startsWith("tool-file-viewer-");

if (viewer) {
  try {
    await import("./viewer.js");
  } catch (error) {
    const message = document.createElement("pre");
    message.textContent = `File viewer failed to start / 文件预览器启动失败\n\n${String(error)}`;
    document.body.replaceChildren(message);
  }
} else {
  if (windowLabel.startsWith("tool-sftp-")) {
    try {
      window.__ORBITERM_SFTP_REQUEST__ = await invoke("current_tool_window_request");
      await import("./main.js");
    } catch (error) {
      const message = document.createElement("pre");
      message.textContent = `SFTP failed to start / SFTP 窗口启动失败\n\n${String(error)}`;
      const close = document.createElement("button");
      close.textContent = "关闭 / Close";
      close.addEventListener("click", () => invoke("close_current_tool_window"));
      document.body.replaceChildren(message, close);
    }
  } else {
    await import("./main.js");
  }
}
