export function isTransientSftpError(error) {
  const message = String(error).toLowerCase();
  return ["transport", "connection", "连接", "broken pipe", "eof", "socket", "session(-37)"]
    .some((token) => message.includes(token));
}

export function appendTextLines(lines, chunk) {
  if (!chunk) return lines;
  const result = lines.length ? [...lines] : [""];
  const added = chunk.split("\n");
  result[result.length - 1] += added.shift() || "";
  result.push(...added);
  return result;
}

export function normalizeImportedSessions(imported, existingIds, createId) {
  const existing = new Set(existingIds);
  return imported.flatMap((session) => {
    const port = Number(session?.port);
    if (!session || typeof session.name !== "string" || !session.name.trim()
      || typeof session.host !== "string" || !session.host.trim()
      || !Number.isInteger(port) || port < 1 || port > 65535) return [];
    const id = typeof session.id === "string" && session.id && !existing.has(session.id) ? session.id : createId();
    existing.add(id);
    return [{
      ...session,
      id,
      name: session.name.trim(),
      host: session.host.trim(),
      port,
      group: typeof session.group === "string" && session.group.trim() ? session.group.trim() : "默认分组",
      authType: ["password", "publickey", "agent"].includes(session.authType) ? session.authType : "password",
      terminalType: typeof session.terminalType === "string" && session.terminalType ? session.terminalType : "xterm-256color",
      timeout: Math.max(1, Math.min(300, Number(session.timeout) || 20)),
      rememberPassword: false,
      fingerprint: typeof session.fingerprint === "string" ? session.fingerprint : "",
    }];
  });
}
