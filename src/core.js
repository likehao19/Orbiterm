export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

export function safeFileName(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "session";
}

export function parentPath(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}` || "/";
}

export function normalizeRemotePath(value, base = "/") {
  const input = value.trim().replaceAll("\\", "/");
  const combined = input.startsWith("/") ? input : `${base.replace(/\/$/, "")}/${input}`;
  const parts = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function joinRemote(base, name) {
  return normalizeRemotePath(name, base);
}

export function joinLocal(base, name) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${name}`;
}

export function downloadTargetPath(destination, item, itemCount) {
  return item.isDir || itemCount > 1 ? joinLocal(destination, item.name) : destination;
}

export function duplicateBaseNames(paths) {
  const seen = new Set();
  const duplicates = new Set();
  for (const path of paths) {
    const name = String(path).replaceAll("\\", "/").split("/").pop();
    if (seen.has(name)) duplicates.add(name);
    else seen.add(name);
  }
  return [...duplicates];
}

export function appendRollingText(current, addition, limit = 2_000_000) {
  const combined = `${current}${addition}`;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

export function allocateSessionId(candidate, existing, createId) {
  const id = typeof candidate === "string" && candidate && !existing.has(candidate) ? candidate : createId();
  existing.add(id);
  return id;
}

export function isRetryableSftpCommand(command) {
  return ["sftp_list", "sftp_path_info", "sftp_file_size", "sftp_properties", "sftp_read_append", "sftp_read_text"].includes(command);
}

export function sanitizeImportedSession(session) {
  if (!session || typeof session !== "object") return null;
  const name = typeof session.name === "string" ? session.name.trim() : "";
  const host = typeof session.host === "string" ? session.host.trim() : "";
  const username = typeof session.username === "string" ? session.username.trim() : "";
  const port = Number(session.port);
  const timeout = Number(session.timeout ?? 20);
  const authType = session.authType;
  if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) return null;
  if (!["password", "publickey", "agent"].includes(authType)) return null;
  return {
    id: typeof session.id === "string" ? session.id : "",
    name,
    host,
    username,
    port,
    timeout,
    authType,
    privateKey: typeof session.privateKey === "string" ? session.privateKey : "",
    terminalType: typeof session.terminalType === "string" && session.terminalType ? session.terminalType : "xterm-256color",
    shellCommand: typeof session.shellCommand === "string" ? session.shellCommand : "",
    group: typeof session.group === "string" && session.group.trim() ? session.group.trim() : "默认分组",
    fingerprint: typeof session.fingerprint === "string" ? session.fingerprint : "",
    rememberPassword: false,
    syncSftpPath: session.syncSftpPath !== false,
  };
}

export function formatSize(size) {
  if (size === 0) return "0 B";
  if (!Number.isFinite(size) || size < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
