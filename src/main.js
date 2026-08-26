import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { appendTextLines, isTransientSftpError, normalizeImportedSessions } from "./runtime-utils.js";
import { duplicateBaseNames, isRetryableSftpCommand } from "./core.js";
import {
  DEFAULT_TERMINAL_SCHEME_ID,
  getTerminalScheme,
  isSoftwareTerminalScheme,
  listTerminalSchemes,
  resolveTerminalSchemeId,
  schemeAnsiColors,
  schemeDisplayName,
  schemePreviewColors,
  schemeSample,
  schemeToXtermTheme,
  softwareTerminalSchemeId,
} from "./terminal-schemes.js";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "./styles.css";
import "./theme-v2.css";

const STORAGE_KEY = "orbiterm.sessions.v1";
const DEFAULT_GROUP = "默认分组";
const MAX_SPLIT = 7;
const SPLIT_DRAG_THRESHOLD = 14;
let fitVisibleTimer = 0;
const PREFERENCES_KEY = "orbiterm.preferences.v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_PREFERENCES = {
  fontSize: 13, terminalTheme: "dark", appTheme: "system", language: "zh-CN",
  cursorStyle: "bar", cursorBlink: true, scrollback: 10_000,
  fontFamily: "jetbrains", lineHeight: 1.6, letterSpacing: 0, copyOnSelect: false,
  rightClickAction: "menu", bellStyle: "none",
  confirmCloseSessions: true, restoreWindow: true, restoreTabs: false, defaultDrawer: "none",
  defaultTimeout: 20, keepaliveSeconds: 20, autoReconnectAttempts: 0, autoReconnectDelaySeconds: 3,
  previewWrap: false, previewLineNumbers: true, previewFontSize: 13,
  defaultDownloadDirectory: "", confirmOverwrite: true, showHiddenFiles: true, persistRemotePath: true,
  defaultLogDirectory: "", autoSessionLog: false, logFileTemplate: "{session}_{date}.log",
  tailDefaultLines: 100, tailRefreshMs: 2000,
  recentSessionIds: [], lastOpenSessionIds: [], remotePathsBySession: {}, windowBounds: null, windowBoundsVersion: 2,
  sessionGroups: [], collapsedGroups: [],
  sftpWidth: 540, tailWidth: 620, manualWidth: 760, confirmMultiLinePaste: true,
  uploadWorkers: 3, downloadWorkers: 4, tailMaxLines: 200_000, tailAllLimitMb: 64,
  fileChunkSizeMb: 4, fileEditLimitMb: 32, sftpPageSize: 500, sftpFilterDebounceMs: 120,
};
const terminalFontFamilies = {
  cascadia: '"Cascadia Code", "JetBrains Mono", "Microsoft YaHei UI", "PingFang SC", Consolas, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", "Microsoft YaHei UI", "PingFang SC", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Code", "Microsoft YaHei UI", monospace',
  monospace: '"Microsoft YaHei UI", monospace',
};
let commandOptions = {};
let commandOptionsPromise = null;
const isTauri = "__TAURI_INTERNALS__" in window;
const appWindow = isTauri
  ? getCurrentWindow()
  : {
      minimize: async () => {},
      toggleMaximize: async () => {},
      isMaximized: async () => false,
      unmaximize: async () => {},
      isFullscreen: async () => false,
      setFullscreen: async () => {},
      innerPosition: async () => ({ x: 0, y: 0 }),
      innerSize: async () => ({ width: 1280, height: 800 }),
      setPosition: async () => {},
      setSize: async () => {},
      close: async () => {},
      destroy: async () => {},
      startDragging: async () => {},
      onCloseRequested: async () => () => {},
      onMoved: async () => () => {},
      onResized: async () => () => {},
    };

const state = {
  sessions: loadSessions(),
  terminals: new Map(),
  activeId: null,
  editingId: null,
  sessionModalMode: "edit",
  remotePath: "/",
  selectedRemote: null,
  selectedRemotePaths: new Set(),
  remoteSelectionAnchor: null,
  transferStartedAt: 0,
  reconnectingTerminalId: null,
  activeTransferId: null,
  activeTransferIds: new Set(),
  transferPromises: new Map(),
  transferTerminals: new Map(),
  transferMeta: new Map(),
  activeTransferTerminalId: null,
  activeTransferPromise: null,
  transferQueues: { upload: [], download: [] },
  transferActiveSlots: { upload: new Set(), download: new Set() },
  transferPrefix: "",
  transferRenderFrame: null,
  closing: false,
  remotePaths: new Map(),
  remoteEntriesByTerminal: new Map(),
  remoteUiByTerminal: new Map(),
  drawerByTerminal: new Map(),
  tailPaths: new Map(),
  tailEntries: [],
  tailLines: [],
  tailSearchIndex: -1,
  tailSearchMatches: [],
  tailSearchQuery: "",
  tailRenderFrame: null,
  remoteEntries: [],
  remoteFilter: "",
  remoteFilterTimer: null,
  remoteRenderLimit: DEFAULT_PREFERENCES.sftpPageSize,
  remoteSort: { key: "name", direction: "asc" },
  tabContextId: null,
  splitIds: [],
  groupContextName: null,
  libContextSessionId: null,
  pendingSessionGroup: "",
  splitDragging: null,
  pointerSplitDrag: null,
  suppressWsClick: false,
  editorTerminalId: null,
  editorPath: "",
  editorOriginal: "",
  editorEncoding: "utf8",
  tailTimer: null,
  tailPaused: false,
  monitorTimer: null,
  windowBoundsTimer: null,
  restoringWindowBounds: false,
  autoReconnectCounts: new Map(),
  preferences: loadPreferences(),
};
state.remoteRenderLimit = state.preferences.sftpPageSize;
let settingsSearchOrigin = "";

function currentTerminalScheme() {
  return getTerminalScheme(resolveTerminalSchemeId(state.preferences));
}

function currentXtermTheme() {
  return schemeToXtermTheme(currentTerminalScheme());
}

function currentSchemeTone() {
  return currentTerminalScheme().tone === "light" ? "light" : "dark";
}

function paint(style, text) {
  if (!text) return text;
  return `${style}${text}\x1b[0m`;
}

const COLOR_SGR = /\x1b\[(?:\d+;)*?(?:3[0-8]|4[0-8]|9[0-7]|10[0-7])(?:;\d+)*m/;
const LINE_CONTROL_PREFIX = /^(?:\r|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+/;
const ALT_SCREEN_ON = /\x1b\[\?(?:1049|1047|47)h/i;
const ALT_SCREEN_OFF = /\x1b\[\?(?:1049|1047|47)l/i;

function splitLineControls(line) {
  const match = line.match(LINE_CONTROL_PREFIX);
  if (!match) return ["", line];
  return [match[0], line.slice(match[0].length)];
}

function colorizePromptLine(line, c) {
  const bracket = line.match(/^(\[)([^@\]]+)(@)([^ \]]+)( )([^\]]+)(\])([#$%])(\s*)(.*)$/);
  if (bracket) {
    const [, open, user, at, host, space, path, close, mark, pad, rest] = bracket;
    return `${paint(c.dim, open)}${paint(c.green, user + at + host)}${paint(c.dim, space)}${paint(c.blue, path)}${paint(c.dim, close + mark + pad)}${rest}`;
  }
  const debian = line.match(/^([^@\s\[\]]+)(@)([^:\s\[\]]+)(:)(\S*)([#$%])(\s*)(.*)$/);
  if (debian) {
    const [, user, at, host, colon, path, mark, pad, rest] = debian;
    return `${paint(c.green, user + at + host)}${paint(c.dim, colon)}${paint(c.blue, path)}${paint(c.dim, mark + pad)}${rest}`;
  }
  const spaced = line.match(/^([^@\s\[\]]+)(@)([^:\s\[\]]+)(\s+)(\S+)(\s+)([#$%])(\s*)(.*)$/);
  if (spaced) {
    const [, user, at, host, space, path, gap, mark, pad, rest] = spaced;
    return `${paint(c.green, user + at + host)}${space}${paint(c.blue, path)}${paint(c.dim, gap + mark + pad)}${rest}`;
  }
  const powershell = line.match(/^(PS)(\s+)(.+?)(>)(\s*)(.*)$/);
  if (powershell) {
    const [, ps, space, path, mark, pad, rest] = powershell;
    return `${paint(c.cyan, ps)}${space}${paint(c.blue, path)}${paint(c.dim, mark + pad)}${rest}`;
  }
  return null;
}

function colorizeOutputLine(line, c) {
  if (!line) return line;
  const [prefix, body] = splitLineControls(line);
  if (!body || COLOR_SGR.test(prefix) || COLOR_SGR.test(body)) return line;
  const prompt = colorizePromptLine(body, c);
  if (prompt != null) return prefix + prompt;
  if (/^Last login:/i.test(body) || /^Welcome to /i.test(body)) return prefix + paint(c.dim, body);
  if (/^(?:CONTAINER ID|NAMES|STATUS|PORTS|IMAGE|CREATED|COMMAND)(?:\s+[A-Z][A-Z0-9]+)+$/.test(body.trim())) {
    return prefix + paint(c.bold, body);
  }
  let painted = body
    .replace(/\bactive \(running\)|\bactive \(exited\)/gi, (match) => paint(c.green, match))
    .replace(/\binactive \(dead\)/gi, (match) => paint(c.dim, match))
    .replace(/\bactivating\b/gi, (match) => paint(c.amber, match))
    .replace(/(?<=Active:\s*)failed\b/gi, (match) => paint(c.red, match))
    .replace(/\(healthy\)/gi, (match) => paint(c.green, match))
    .replace(/\bUp \d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?)/gi, (match) => paint(c.amber, match))
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{2,5})?/g, (match) => paint(c.amber, match))
    .replace(/(^|[ \t])(●)(?=\s)/g, (_, lead, dot) => `${lead}${paint(c.green, dot)}`)
    .replace(/\b(Loaded|Active|Main PID|Tasks|Memory|Docs):\s/g, (match) => paint(c.dim, match));
  if (/\b(?:Filesystem|Use%|Mem|CPU|Size|Avail)\b|\b\d+(?:\.\d+)?(?:[KMGT]i?B|[KMGT])\b/.test(body)) {
    painted = painted
      .replace(/\b\d{1,3}%/g, (match) => {
        const value = Number.parseInt(match, 10);
        return paint(value >= 90 ? c.red : value >= 70 ? c.amber : c.green, match);
      })
      .replace(/\b\d+\.\d+[KMGT]i?B?\b|\b\d+[KMGT]i?B\b/g, (match) => paint(c.green, match));
  }
  painted = painted.replace(/\b(?:0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|(?:\d{1,3}\.){3}\d{1,3}:\d{1,5})(?::\d+)?(?:-\d+\/(?:tcp|udp))?\b/g, (match) => paint(c.cyan, match));
  return prefix + painted;
}

function colorizeClientOutput(record, text) {
  if (!text) return text;
  const enteredAlt = ALT_SCREEN_ON.test(text);
  const leftAlt = ALT_SCREEN_OFF.test(text);
  if (enteredAlt) record.altScreen = true;
  if (leftAlt) record.altScreen = false;
  if (record.altScreen || enteredAlt) return text;
  if (text.length < 4 && !/[\r\n]/.test(text)) return text;
  const c = schemeAnsiColors(currentTerminalScheme());
  return text.split(/(\r\n|\n|\r)/).map((part, index) => (index % 2 ? part : colorizeOutputLine(part, c))).join("");
}

const linuxCommands = [
  ["文件与目录", "ls", "列出目录内容", "ls -lah"], ["文件与目录", "cd", "切换目录", "cd /var/log"], ["文件与目录", "pwd", "显示当前路径", "pwd"], ["文件与目录", "mkdir", "创建目录", "mkdir -p app/logs"], ["文件与目录", "cp", "复制文件或目录", "cp -a src dest"], ["文件与目录", "mv", "移动或重命名", "mv old new"], ["文件与目录", "rm", "删除文件或目录（谨慎）", "rm file"], ["文件与目录", "find", "按条件查找文件", "find /var -name '*.log'"], ["文件与目录", "touch", "创建空文件或更新时间", "touch app.log"], ["文件与目录", "stat", "查看文件详细信息", "stat file"],
  ["文本处理", "cat", "输出或拼接文件", "cat file"], ["文本处理", "less", "分页查看文本", "less file.log"], ["文本处理", "head / tail", "查看开头或末尾", "tail -f app.log"], ["文本处理", "grep", "搜索文本", "grep -Rni 'error' ."], ["文本处理", "sed", "流式替换与处理", "sed 's/old/new/g' file"], ["文本处理", "awk", "按列处理文本", "awk '{print $1}' file"], ["文本处理", "sort / uniq", "排序与去重", "sort file | uniq -c"], ["文本处理", "wc", "统计行、词、字节", "wc -l file"], ["文本处理", "cut", "按列截取", "cut -d: -f1 /etc/passwd"], ["文本处理", "xargs", "把输入转为命令参数", "find . -name '*.tmp' -print0 | xargs -0 rm"],
  ["权限与用户", "chmod", "修改权限", "chmod 644 file"], ["权限与用户", "chown", "修改所有者", "chown user:group file"], ["权限与用户", "sudo", "以管理员权限执行", "sudo systemctl restart nginx"], ["权限与用户", "id / whoami", "查看当前身份", "id"], ["权限与用户", "useradd / usermod", "管理用户", "sudo useradd -m user"], ["权限与用户", "passwd", "修改密码", "passwd"],
  ["进程与服务", "ps", "查看进程", "ps aux"], ["进程与服务", "top / htop", "实时查看进程", "top"], ["进程与服务", "kill / pkill", "终止进程", "kill -TERM PID"], ["进程与服务", "jobs / bg / fg", "管理 Shell 作业", "jobs -l"], ["进程与服务", "nohup", "后台持续运行", "nohup command >app.log 2>&1 &"], ["进程与服务", "systemctl", "管理 systemd 服务", "systemctl status nginx"], ["进程与服务", "journalctl", "查看 systemd 日志", "journalctl -u nginx -f"],
  ["网络", "ip", "查看和配置网络", "ip addr"], ["网络", "ss", "查看端口与连接", "ss -lntp"], ["网络", "ping", "测试网络连通", "ping host"], ["网络", "curl", "发送 HTTP 请求", "curl -I https://example.com"], ["网络", "wget", "下载文件", "wget URL"], ["网络", "dig / nslookup", "查询 DNS", "dig example.com"], ["网络", "traceroute", "跟踪网络路由", "traceroute host"], ["网络", "scp", "通过 SSH 复制文件", "scp file user@host:/tmp/"], ["网络", "rsync", "增量同步文件", "rsync -avz src/ host:/dest/"], ["网络", "ssh", "远程登录", "ssh user@host"],
  ["磁盘与系统", "df", "查看文件系统空间", "df -h"], ["磁盘与系统", "du", "统计目录占用", "du -sh *"], ["磁盘与系统", "lsblk", "查看块设备", "lsblk -f"], ["磁盘与系统", "mount / umount", "挂载或卸载", "mount | column -t"], ["磁盘与系统", "free", "查看内存", "free -h"], ["磁盘与系统", "uname", "查看内核信息", "uname -a"], ["磁盘与系统", "uptime", "查看运行时间与负载", "uptime"], ["磁盘与系统", "date / timedatectl", "查看时间", "timedatectl"], ["磁盘与系统", "dmesg", "查看内核消息", "dmesg -T | tail"], ["磁盘与系统", "env / export", "查看和设置环境变量", "export NAME=value"],
  ["压缩与软件", "tar", "打包与解包", "tar -czf app.tar.gz app/"], ["压缩与软件", "gzip / gunzip", "gzip 压缩解压", "gzip file"], ["压缩与软件", "zip / unzip", "ZIP 压缩解压", "unzip archive.zip"], ["压缩与软件", "apt", "Debian/Ubuntu 软件管理", "sudo apt update"], ["压缩与软件", "dnf / yum", "RHEL 系软件管理", "sudo dnf install package"], ["压缩与软件", "rpm / dpkg", "查询软件包", "rpm -qa | grep name"],
  ["Shell 工具", "history", "查看命令历史", "history | tail"], ["Shell 工具", "alias", "设置命令别名", "alias ll='ls -lah'"], ["Shell 工具", "which / command -v", "查找命令路径", "command -v python"], ["Shell 工具", "man / --help", "查看命令帮助", "man grep"], ["Shell 工具", "tee", "同时输出到屏幕和文件", "command | tee output.log"], ["Shell 工具", "watch", "周期执行命令", "watch -n 2 'df -h'"], ["Shell 工具", "screen / tmux", "持久终端会话", "tmux new -s work"]
];

linuxCommands.push(
  ["性能诊断", "vmstat", "查看 CPU、内存、进程和 IO 状态", "vmstat 1 10"], ["性能诊断", "iostat", "分析磁盘吞吐与等待时间", "iostat -xz 1"], ["性能诊断", "pidstat", "按进程观察 CPU、内存和 IO", "pidstat -dur 1"], ["性能诊断", "sar", "读取历史或实时系统性能数据", "sar -n DEV 1 5"], ["性能诊断", "lsof", "查看文件、端口被哪些进程占用", "lsof -i :8080"], ["性能诊断", "strace", "跟踪进程系统调用", "strace -p PID"], ["性能诊断", "perf", "采样分析 CPU 热点", "perf top"],
  ["网络诊断", "mtr", "持续诊断网络路由与丢包", "mtr -rw host"], ["网络诊断", "tcpdump", "抓取并过滤网络数据包", "sudo tcpdump -i any port 22"], ["网络诊断", "nmap", "探测主机端口和服务", "nmap -sV host"],
  ["存储管理", "fdisk / parted", "查看或管理磁盘分区", "sudo parted -l"], ["存储管理", "lvs / vgs / pvs", "查看 LVM 逻辑卷、卷组和物理卷", "sudo lvs -a"], ["存储管理", "smartctl", "读取磁盘 SMART 健康信息", "sudo smartctl -a /dev/sda"],
  ["容器", "docker", "管理容器、镜像和日志", "docker ps --format 'table {{.Names}}\\t{{.Status}}'"], ["容器", "podman", "无守护进程容器管理", "podman ps -a"], ["容器", "kubectl", "管理 Kubernetes 工作负载", "kubectl get pods -A -o wide"], ["容器", "crictl", "诊断 CRI 容器运行时", "sudo crictl ps -a"],
  ["服务诊断", "systemd-analyze", "分析系统和服务启动耗时", "systemd-analyze blame"], ["服务诊断", "coredumpctl", "查询并调试崩溃转储", "coredumpctl list"], ["安全", "getfacl / setfacl", "查看或配置文件 ACL 权限", "getfacl file"], ["安全", "ausearch", "查询 Linux 审计日志", "sudo ausearch -m AVC -ts recent"],
  ["开发工具", "jq", "筛选和转换 JSON 数据", "jq '.items[] | .name' data.json"], ["开发工具", "yq", "查询和修改 YAML 数据", "yq '.services' compose.yml"], ["开发工具", "openssl", "检查证书、TLS 和加密数据", "openssl s_client -connect host:443 -servername host"]
);

const ic = (path) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

document.querySelector("#app").innerHTML = `
  <main class="shell">
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <span class="orbit-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.4" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4.4" stroke="currentColor" stroke-width="1.7"/></svg></span>
        <span class="brand-name">Orbiterm</span>
        <span class="brand-tag">SSH</span>
      </div>
      <button class="palette-trigger" id="paletteTrigger" type="button" title="打开命令面板">
        ${ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>')}
        <span class="grow">搜索工作区、会话与命令…</span>
        <kbd class="chip">Ctrl</kbd><kbd class="chip">K</kbd>
      </button>
      <nav class="menubar app-menubar" aria-label="应用菜单">
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">文件</button>
        <div class="menu-popup">
          <button data-menu-action="new-session"><span>新建 SSH 会话</span><kbd>Ctrl+Shift+T</kbd></button>
          <button data-menu-action="quick-connect"><span>快速连接</span></button>
          <button data-menu-action="local-ssh"><span>新建本地 PowerShell</span></button>
          <div id="recentSessionsMenu" class="menu-section"></div>
          <i></i>
          <button data-menu-action="import-sessions"><span>导入会话配置</span></button>
          <button data-menu-action="export-sessions"><span>导出会话配置</span></button>
          <i></i>
          <button data-menu-action="exit"><span>退出 Orbiterm</span><kbd>Alt+F4</kbd></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">编辑</button>
        <div class="menu-popup">
          <button data-menu-action="copy"><span>复制</span><kbd>Ctrl+Shift+C</kbd></button>
          <button data-menu-action="paste"><span>粘贴</span><kbd>Ctrl+Shift+V</kbd></button>
          <i></i>
          <button data-menu-action="select-all"><span>全选终端内容</span><kbd>Ctrl+Shift+A</kbd></button>
          <button data-menu-action="find"><span>查找终端内容</span><kbd>Ctrl+Shift+G</kbd></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">查看</button>
        <div class="menu-popup">
          <button data-menu-action="toggle-sidebar"><span>会话管理器</span><kbd>Ctrl+B</kbd></button>
          <button data-menu-action="toggle-sftp"><span>SFTP 文件管理器</span><kbd>Ctrl+Shift+F</kbd></button>
          <button data-menu-action="toggle-tail"><span>Tail 日志查看</span></button>
          <button data-menu-action="toggle-manual"><span>Linux 命令手册面板</span></button>
          <i></i>
          <button data-menu-action="fullscreen"><span>全屏</span><kbd>F11</kbd></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">终端</button>
        <div class="menu-popup">
          <button data-menu-action="duplicate-terminal"><span>复制当前标签</span></button>
          <button data-menu-action="previous-terminal"><span>上一个标签</span><kbd>Ctrl+PgUp</kbd></button>
          <button data-menu-action="next-terminal"><span>下一个标签</span><kbd>Ctrl+PgDn</kbd></button>
          <i></i>
          <button data-menu-action="disconnect"><span>断开当前连接</span></button>
          <button data-menu-action="reconnect"><span>重新连接</span></button>
          <button data-menu-action="reset-terminal"><span>重置终端</span></button>
          <button data-menu-action="clear"><span>清除屏幕</span></button>
          <i></i>
          <button data-menu-action="toggle-log"><span>开始/停止命令记录</span></button>
          <button data-menu-action="close-terminal"><span>关闭当前标签</span><kbd>Ctrl+Shift+W</kbd></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">工具</button>
        <div class="menu-popup">
          <button data-menu-action="transfer-tasks"><span>传输任务</span></button>
          <button data-menu-action="upload"><span>上传文件到当前目录</span></button>
          <i></i>
          <button data-menu-action="toggle-log"><span>开始/停止命令记录</span></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">设置</button>
        <div class="menu-popup">
          <button data-menu-action="settings"><span>应用设置</span></button>
        </div>
      </div>
      <div class="menu-root">
        <button class="menu-trigger" aria-haspopup="menu" aria-expanded="false">帮助</button>
        <div class="menu-popup">
          <button data-menu-action="guide"><span>使用说明</span></button>
          <button data-menu-action="command-manual"><span>Linux 命令手册</span></button>
          <button data-menu-action="shortcuts"><span>快捷键说明</span></button>
          <i></i>
          <button data-menu-action="about"><span>关于 Orbiterm</span></button>
        </div>
      </div>
      </nav>
      <div class="win-controls window-actions">
        <button id="bellBtn" class="bell-btn" type="button" title="通知">
          ${ic('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>')}
          <span class="badge"></span>
        </button>
        <button id="minimize" class="wc-btn wc-minimize" title="最小化" aria-label="最小化"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M2 6h8"/></svg></button>
        <button id="maximize" class="wc-btn wc-maximize" title="最大化" aria-label="最大化"><svg class="maximize-glyph" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2" y="2" width="8" height="8" rx="1.2"/></svg><svg class="restore-glyph" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 3h6v6H3V3Zm1 1v4h4V4H4zM5 1h6v6h-1V2H5V1z" fill="currentColor" /></svg></button>
        <button id="closeWindow" class="wc-btn wc-close close" title="关闭" aria-label="关闭"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button>
      </div>
      <div id="notifyPop" class="notify-pop hidden"><header>通知</header><div id="notifyList" class="notify-empty">暂无需要处理的会话</div></div>
    </header>
    <div class="app-main">
      <aside class="sidebar" id="sidebar">
        <label class="side-search session-search">
          ${ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>')}
          <input id="sessionSearch" placeholder="过滤…" spellcheck="false" />
        </label>
        <div class="side-scroll">
          <div class="side-sec">工作区 <em id="wsCount">0</em><span class="spring"></span>
            <button class="icon-btn" id="addSession" title="新建会话">${ic('<path d="M12 5v14M5 12h14"/>')}</button>
            <button class="icon-btn" id="collapseSidebar" title="折叠侧栏">${ic('<path d="m14 6-6 6 6 6"/>')}</button>
          </div>
          <div id="wsList"></div>
          <div class="side-sec">会话库 <span class="spring"></span>
            <button class="icon-btn" id="addGroup" title="新建分组">${ic('<path d="M3 7h7l2 2h9v10H3z"/><path d="M12 13v5M9.5 15.5h5"/>')}</button>
          </div>
          <div id="sessionList" class="session-list"></div>
        </div>
        <section class="server-monitor hidden"><div><strong>服务器监控</strong><small id="monitorState"></small></div><dl><span><dt>负载</dt><dd id="monitorLoad">—</dd><i id="monitorLoadBar"></i></span><span><dt>内存</dt><dd id="monitorMemory">—</dd><i id="monitorMemoryBar"></i></span><span><dt>磁盘</dt><dd id="monitorDisk">—</dd><i id="monitorDiskBar"></i></span><span><dt>进程</dt><dd id="monitorProcesses">—</dd><i id="monitorProcessBar"></i></span></dl></section>
        <div class="side-foot">
          <button class="icon-btn" id="sidebarSettings" title="设置">${ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')}</button>
          <button class="icon-btn" id="sidebarKeys" title="凭据">${ic('<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M17 5l2.5 2.5M14 8l2 2"/>')}</button>
          <button class="icon-btn" id="sidebarFingerprint" title="主机指纹">${ic('<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/><path d="m9 11.5 2 2 4-4"/>')}</button>
          <button class="icon-btn" id="themeToggle" title="切换亮色 / 深色">${ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')}</button>
          <span class="ver">0.1.0</span>
        </div>
      </aside>
      <section class="terminal-pane">
        <div class="ws-topbar">
          <button class="icon-btn expand-btn" id="expandSidebar" title="展开侧栏">${ic('<path d="m10 6 6 6-6 6"/>')}</button>
          <span class="crumb">
            <span class="dot" id="tbDot"></span>
            <b id="titlebarContext">Orbiterm</b>
            <span class="host" id="tbHost">未连接</span>
          </span>
          <span class="chipset" id="tbChips"></span>
          <div class="tools">
            <button class="icon-btn" id="openSftpTool" title="SFTP 文件面板">${ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}</button>
            <button class="icon-btn" id="openTailTool" title="Tail 日志">${ic('<path d="M4 6h16M4 12h10M4 18h13"/>')}</button>
            <button class="icon-btn" id="openFindTool" title="终端内查找">${ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>')}</button>
            <button class="icon-btn" id="openManualTool" title="命令手册">${ic('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>')}</button>
            <div class="vline"></div>
            <button class="icon-btn" id="reconnectTool" title="重新连接">${ic('<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>')}</button>
            <button class="icon-btn" id="moreTool" title="更多">${ic('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>')}</button>
          </div>
          <div id="terminalTabs" class="tabs"></div>
        </div>
        <div class="panel-wrap">
          <div class="panel" id="termPanel">
            <div id="findBar" class="find-bar hidden"><input id="findInput" placeholder="在当前终端中查找" /><button id="findPrevious" title="上一个">↑</button><button id="findNext" title="下一个">↓</button><button id="closeFind" title="关闭">×</button></div>
            <div class="term-stage">
              <div id="emptyState" class="empty-state">
                <div class="empty-icon">›_</div><h2>连接到远程主机</h2><p>从左侧会话库打开，或新建一个 SSH 会话</p>
                <button id="emptyNew" class="primary large">新建会话</button>
              </div>
              <div id="terminalStack" class="terminal-stack"></div>
            </div>
            <section id="pastePanel" class="paste-panel hidden"><div><strong>多行粘贴</strong><small id="pasteSummary"></small><button id="closePastePanel">×</button></div><textarea id="pasteEditor" spellcheck="false"></textarea><footer><label class="paste-join-lines" title="可选：把多行内容合并为一行后发送"><input id="pasteJoinLines" type="checkbox" /> 合并换行为空格</label><button id="copyPasteText">复制</button><button id="sendPasteText" class="primary">发送到终端</button></footer></section>
          </div>
      <aside id="sftpPanel" class="sftp-panel hidden" aria-label="SFTP 文件管理器">
        <div id="sftpResize" class="sftp-resize" title="拖动调整宽度"></div>
        <div class="sftp-head"><span><strong>远程文件</strong><small id="sftpHost">未连接</small></span><button id="closeSftp" title="关闭文件管理器" aria-label="关闭文件管理器">×</button></div>
        <div class="sftp-commandbar"><button id="uploadFile" class="accent" title="上传多个文件">↑ 上传</button><button id="downloadFile" disabled>↓ 下载</button><div class="new-remote"><button id="newRemote" aria-haspopup="menu">＋ 新建</button><div id="newRemoteMenu" class="new-remote-menu hidden"><button data-new-remote="file">新建文件</button><button data-new-remote="folder">新建文件夹</button></div></div><div class="sftp-filter"><span>⌕</span><input id="remoteFilter" placeholder="筛选当前目录" aria-label="筛选当前目录" /><button id="clearRemoteFilter" class="hidden" title="清除筛选">×</button></div><span id="remoteSummary">0 项</span></div>
        <div class="sftp-nav"><button id="remoteBack" title="后退" aria-label="后退">‹</button><button id="remoteForward" title="前进" aria-label="前进">›</button><button id="remoteUp" title="上一级" aria-label="上一级">↑</button><div class="sftp-address"><span>⌂</span><input id="remotePath" value="/" aria-label="远程路径" /><button id="copyRemotePath" title="复制路径" aria-label="复制路径">⧉</button></div><button id="remoteRefresh" title="刷新" aria-label="刷新">↻</button></div>
        <div class="file-header"><button data-sort="name">名称 <i></i></button><button data-sort="size">大小 <i></i></button><button data-sort="owner">归属用户 <i></i></button><button data-sort="modified">修改时间 <i></i></button><button data-sort="permissions">权限 <i></i></button></div>
        <div id="remoteFiles" class="remote-files"><div class="file-placeholder">连接后可浏览远程文件</div></div>
        <section id="transferTasks" class="transfer-tasks hidden" aria-label="传输任务">
          <header><strong>传输任务</strong><small id="transferTaskCount"></small><button id="clearTransferTasks">清除已完成</button></header>
          <div id="transferTaskList" class="transfer-task-list"></div>
        </section>
        <div id="transferLog" class="transfer-log"><span class="transfer-icon">⇅</span><span id="transferText">暂无传输任务</span><div id="transferProgress" class="transfer-progress hidden"><i id="transferProgressBar"></i><small id="transferPercent"></small></div><button id="cancelTransfer" class="hidden">全部取消</button></div>
      </aside>
      <aside id="tailPanel" class="drawer-panel tail-panel hidden" aria-label="Tail 日志查看"><div class="drawer-resize" data-resize-drawer="tail" title="拖动调整宽度"></div><div class="tail-head"><span><strong>Tail 日志</strong><small id="tailHost">未连接</small></span><button id="closeTail" aria-label="关闭日志查看">×</button></div><div class="tail-browser"><button id="tailUp" title="上一级">↑</button><div><input id="tailPath" aria-label="日志路径" placeholder="输入目录或日志文件绝对路径" /><button id="tailRefresh" title="刷新目录">↻</button></div></div><div id="tailFiles" class="tail-files hidden"><div>点击路径栏选择日志文件</div></div><div class="tail-config"><select id="tailMode" aria-label="查看范围"><option value="all">全部内容</option><option value="last" selected>最近 N 行</option><option value="first">开头 N 行</option></select><input id="tailLines" type="number" min="1" max="100000" value="100" aria-label="行数" /><label title="持续追加文件新增内容"><input id="tailFollow" type="checkbox" checked /> 持续追加</label><button id="startTail" class="primary">查看</button><button id="pauseTail" disabled>暂停</button><small id="tailModeHint" class="tail-mode-hint"></small></div><div class="tail-search"><span id="tailSelectedFile">尚未选择文件</span><input id="tailSearch" placeholder="搜索日志" /><button id="tailSearchPrevious" title="上一个">↑</button><button id="tailSearchNext" title="下一个">↓</button><small id="tailSearchCount"></small></div><div id="tailOutput" class="tail-output"><div class="tail-empty">请输入绝对路径或从目录中选择文件</div></div></aside>
      <aside id="manualPanel" class="drawer-panel manual-panel hidden" aria-label="Linux 命令手册"><div class="drawer-resize" data-resize-drawer="manual" title="拖动调整宽度"></div><div class="tail-head"><span><strong>Linux 命令手册</strong><small>选择左侧命令查看用法</small></span><button id="closeCommandManual" aria-label="关闭命令手册">×</button></div><div class="manual-search"><span>⌕</span><input id="commandSearch" placeholder="搜索命令、分类或用途" /></div><div class="manual-browser"><nav id="commandList" class="command-list"></nav><article id="commandDetail" class="command-detail"></article></div></aside>
        </div>
      </section>
    </div>
    <footer class="statusbar">
      <span class="item"><span id="statusDot" class="dot status-dot"></span><b id="wsStatusCount">0</b> 个工作区</span>
      <span class="item throughput">⇅ <b id="transferStatus">传输：空闲</b></span>
      <span class="item" id="fingerprintStatus"><span class="status-ok" id="connectionStatus">未连接</span></span>
      <span id="statusHost" class="item">—</span>
      <span class="right">
        <span class="item" id="logStatus">日志：关闭</span>
        <span class="item">UTF-8</span>
        <span class="item" id="latencyStatus">延迟：—</span>
        <span class="item" id="terminalSize">—</span>
      </span>
    </footer>
  </main>

  <div id="terminalContextMenu" class="terminal-context-menu hidden" role="menu" aria-label="终端右键菜单">
    <button data-terminal-context-action="copy"><span>复制</span><kbd>Ctrl+Shift+C</kbd></button>
    <button data-terminal-context-action="paste"><span>粘贴</span><kbd>Ctrl+Shift+V</kbd></button>
    <i></i>
    <button data-terminal-context-action="select-all"><span>全选</span></button>
    <button data-terminal-context-action="find"><span>查找</span><kbd>Ctrl+Shift+G</kbd></button>
    <i></i>
    <button data-terminal-context-action="clear"><span>清屏</span></button>
  </div>
  <div id="tabContextMenu" class="terminal-context-menu hidden" role="menu" aria-label="终端标签菜单">
    <button data-tab-action="duplicate"><span>复制会话标签</span><kbd>新连接</kbd></button>
    <button data-tab-action="disconnect"><span>断开连接</span></button>
    <button data-tab-action="reconnect"><span>重新连接</span></button>
    <button data-tab-action="toggle-log"><span>开始/停止命令记录</span></button>
    <i></i>
    <button data-tab-action="close"><span>关闭标签</span><kbd>Ctrl+Shift+W</kbd></button>
  </div>
  <div id="groupContextMenu" class="terminal-context-menu hidden" role="menu" aria-label="分组菜单">
    <button data-group-action="new-session"><span>在此分组新建会话</span></button>
    <button data-group-action="rename"><span>重命名分组</span></button>
    <button data-group-action="delete" class="text-danger"><span>删除分组</span></button>
  </div>
  <div id="sessionLibContextMenu" class="terminal-context-menu hidden" role="menu" aria-label="会话菜单">
    <button data-lib-action="connect"><span>连接</span></button>
    <button data-lib-action="open-new"><span>新开会话</span><kbd>新连接</kbd></button>
    <button data-lib-action="edit"><span>编辑</span></button>
    <button data-lib-action="move"><span>移动到分组…</span></button>
    <i></i>
    <button data-lib-action="delete" class="text-danger"><span>删除</span></button>
  </div>
  <div id="sftpContextMenu" class="terminal-context-menu sftp-context-menu hidden" role="menu" aria-label="远程文件菜单">
    <button data-sftp-action="open"><span>打开</span><kbd>Enter</kbd></button>
    <button data-sftp-action="download"><span>下载</span></button>
    <i></i>
    <button data-sftp-action="rename"><span>重命名</span><kbd>F2</kbd></button>
    <button data-sftp-action="permissions"><span>修改权限</span></button>
    <button data-sftp-action="properties"><span>属性</span></button>
    <i></i>
    <button data-sftp-action="delete" class="text-danger"><span>删除</span><kbd>Del</kbd></button>
  </div>
  <div id="sessionModal" class="modal hidden" role="dialog" aria-modal="true">
    <form id="sessionForm" class="dialog">
      <div class="dialog-head"><div><strong id="dialogTitle">新建 SSH 会话</strong></div><button type="button" data-close-modal>×</button></div>
      <div class="dialog-body session-dialog-body">
        <div class="session-form-tabs" role="tablist"><button type="button" class="active" data-session-tab="basic">基本信息</button><button type="button" data-session-tab="auth">认证</button><button type="button" data-session-tab="terminal">终端</button></div>
        <section class="session-form-page" data-session-page="basic">
          <div class="field full"><label for="name">连接名称</label><input id="name" required placeholder="例如：生产服务器" /></div>
          <div class="form-grid host-grid"><div class="field"><label for="host">IP / 主机地址</label><input id="host" required placeholder="服务器 IP 或域名" /></div><div class="field"><label for="port">端口</label><input id="port" type="number" min="1" max="65535" value="22" required /></div></div>
          <div class="field full"><label for="username">用户名</label><input id="username" required placeholder="root" /></div>
          <div class="field full"><label for="group">会话分组</label><div class="input-action"><select id="group"></select><button id="newGroupInForm" type="button">新建</button></div></div>
          <div id="passwordFields" class="field full"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入 SSH 登录密码" /><label class="inline-check"><input id="rememberPassword" type="checkbox" /> 使用 Windows 凭据管理器记住密码</label></div>
        </section>
        <section class="session-form-page hidden" data-session-page="auth">
          <div class="field full"><label for="authType">认证方式</label><select id="authType"><option value="password">密码认证</option><option value="publickey">SSH 私钥</option><option value="agent">SSH Agent</option></select></div>
          <div id="keyFields" class="key-fields hidden"><div class="field full"><label for="privateKey">私钥文件</label><div class="input-action"><input id="privateKey" placeholder="选择 OpenSSH 私钥" /><button id="pickKey" type="button">浏览</button></div></div><div class="field full"><label for="passphrase">私钥口令（可选，不保存）</label><input id="passphrase" type="password" /></div></div>
          <p class="setting-note">首次连接会自动保存服务器主机指纹；以后指纹变化时会阻止连接。</p>
        </section>
        <section class="session-form-page hidden" data-session-page="terminal">
          <div class="form-grid advanced-grid"><div class="field"><label for="terminalType">终端类型</label><select id="terminalType"><option>xterm-256color</option><option>xterm</option><option>vt100</option></select></div><div class="field"><label for="timeout">连接超时（秒）</label><input id="timeout" type="number" min="1" max="300" value="20" /></div></div>
          <div class="field full"><label for="shellCommand">启动 Shell / 命令</label><input id="shellCommand" placeholder="留空使用服务器默认 Shell，例如 /bin/bash -l" autocomplete="off" /></div>
          <p class="setting-note">留空时读取远端账户的默认登录 Shell；仅在需要指定 Bash、Zsh 或启动 tmux 时填写。</p>
          <label class="save-session"><input id="syncSftpPath" type="checkbox" checked /> 终端切换目录时同步 SFTP 路径</label>
        </section>
        <label class="save-session session-save"><input id="saveSession" type="checkbox" checked /> 保存此会话</label>
      </div>
      <div class="dialog-foot"><button type="button" data-close-modal>取消</button><button type="submit" id="connectButton" class="primary">保存并连接</button></div>
    </form>
  </div>
  <div id="settingsModal" class="modal settings-overlay hidden" role="dialog" aria-modal="true">
    <form id="settingsForm" class="settings-panel">
      <div class="settings-toolbar">
        <strong class="settings-title" id="settingsWindowTitle">设置</strong>
        <div class="settings-search-wrap"><span aria-hidden="true">⌕</span><input id="settingsSearch" class="settings-search" type="search" placeholder="搜索设置" /></div>
        <button type="button" class="settings-close" data-close-settings aria-label="关闭">×</button>
      </div>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类">
          <button type="button" class="settings-nav-item active" data-settings-page="general">通用</button>
          <button type="button" class="settings-nav-item" data-settings-page="appearance">界面</button>
          <button type="button" class="settings-nav-item" data-settings-page="terminal">终端</button>
          <button type="button" class="settings-nav-item" data-settings-page="connection">连接</button>
          <button type="button" class="settings-nav-item" data-settings-page="files">文件与预览</button>
          <button type="button" class="settings-nav-item" data-settings-page="logging">日志</button>
          <button type="button" class="settings-nav-item" data-settings-page="performance">性能与容量</button>
        </nav>
        <div class="settings-content">
          <section class="settings-page active" data-settings-panel="general"><h2 id="settingsTitle">通用</h2><div class="settings-section">
            <label class="save-session"><input id="confirmCloseSessionsSetting" type="checkbox" /> <span>关闭软件前确认仍在连接的会话</span></label>
            <label class="save-session"><input id="restoreWindowSetting" type="checkbox" /> <span>恢复上次窗口大小和位置</span></label>
            <label class="save-session"><input id="restoreTabsSetting" type="checkbox" /> <span>启动时恢复上次打开的会话</span></label>
            <div class="field full"><label for="defaultDrawerSetting">连接后默认打开</label><select id="defaultDrawerSetting"><option value="none">不打开面板</option><option value="sftp">SFTP 文件管理器</option><option value="tail">Tail 日志</option><option value="manual">Linux 命令手册</option></select></div>
            <div class="settings-inline-actions">
              <button type="button" id="importSessionsSetting">导入会话</button>
              <button type="button" id="exportSessionsSetting">导出会话</button>
              <button type="button" id="openGuideSetting">使用说明</button>
              <button type="button" id="openAboutSetting">关于 Orbiterm</button>
            </div>
          </div></section>
          <section class="settings-page" data-settings-panel="appearance"><h2 id="appearancePageTitle">界面</h2>
          <div class="settings-section"><div class="field full theme-setting-field"><label id="appThemeLabel" for="appThemeSetting">软件主题</label><select id="appThemeSetting" class="settings-native-theme-select" tabindex="-1" aria-hidden="true"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select><div class="theme-picker">
            <button type="button" class="theme-picker-card" data-app-theme-choice="system"><span class="theme-preview-mock theme-preview-system"><span></span><i></i></span><strong>跟随系统</strong></button>
            <button type="button" class="theme-picker-card" data-app-theme-choice="light"><span class="theme-preview-mock theme-preview-light"><span></span><i></i></span><strong>浅色</strong></button>
            <button type="button" class="theme-picker-card" data-app-theme-choice="dark"><span class="theme-preview-mock theme-preview-dark"><span></span><i></i></span><strong>深色</strong></button>
          </div></div><div class="field full"><label id="languageSettingLabel" for="languageSetting">界面语言</label><select id="languageSetting"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></div></div></section>
          <section class="settings-page" data-settings-panel="terminal"><h2 id="terminalSettingsTitle">终端</h2><div class="settings-section"><h3 id="terminalSchemeGroupTitle">配色</h3><div class="field full theme-setting-field"><label id="terminalThemeLabel">终端配色</label><input id="terminalSchemeSetting" type="hidden" /><div id="terminalSchemePicker" class="scheme-picker" role="listbox" aria-labelledby="terminalSchemeGroupTitle" aria-orientation="vertical"></div></div></div><div class="settings-section"><h3 id="terminalDisplayGroupTitle">显示与行为</h3><div class="field full"><label for="fontFamilySetting">终端字体</label><select id="fontFamilySetting"><option value="cascadia">Cascadia Code</option><option value="jetbrains">JetBrains Mono</option><option value="consolas">Consolas</option><option value="monospace">系统等宽字体</option></select></div><div class="form-grid"><div class="field"><label id="fontSizeLabel" for="fontSizeSetting">字体大小</label><input id="fontSizeSetting" type="number" min="10" max="32" /></div><div class="field"><label for="lineHeightSetting">行高</label><input id="lineHeightSetting" type="number" min="1" max="2" step="0.05" /></div></div><div class="field full"><label for="letterSpacingSetting">字符间距</label><input id="letterSpacingSetting" type="number" min="-1" max="5" step="0.25" /></div><div class="field full"><label id="cursorStyleLabel" for="cursorStyleSetting">光标样式</label><select id="cursorStyleSetting"><option value="block">方块</option><option value="bar">竖线</option><option value="underline">下划线</option></select></div><label id="cursorBlinkLabel" class="save-session"><input id="cursorBlinkSetting" type="checkbox" /> <span>光标闪烁</span></label><label class="save-session"><input id="copyOnSelectSetting" type="checkbox" /> <span>选中文本后自动复制</span></label><div class="field full"><label for="rightClickActionSetting">终端右键行为</label><select id="rightClickActionSetting"><option value="menu">打开右键菜单</option><option value="paste">直接粘贴</option></select></div><div class="field full"><label for="bellStyleSetting">终端响铃</label><select id="bellStyleSetting"><option value="none">关闭</option><option value="visual">视觉提示</option><option value="sound">声音</option></select></div><div class="field full"><label id="scrollbackLabel" for="scrollbackSetting">回滚缓冲行数</label><input id="scrollbackSetting" type="number" min="1000" max="100000" step="1000" /><small>默认 10,000 行，数值越大占用内存越多</small></div><label id="confirmPasteLabel" class="save-session"><input id="confirmPasteSetting" type="checkbox" /> <span>粘贴多行文本前确认</span></label></div></section>
          <section class="settings-page" data-settings-panel="connection"><h2>连接</h2><div class="settings-section"><div class="field full"><label for="defaultTimeoutSetting">新连接默认超时</label><div class="setting-number-unit"><input id="defaultTimeoutSetting" type="number" min="1" max="300" /><span>秒</span></div></div><div class="field full"><label for="keepaliveSetting">SSH Keepalive 间隔</label><div class="setting-number-unit"><input id="keepaliveSetting" type="number" min="5" max="300" /><span>秒</span></div></div><div class="field full"><label for="autoReconnectAttemptsSetting">断线自动重连次数</label><input id="autoReconnectAttemptsSetting" type="number" min="0" max="10" /><small>0 表示关闭自动重连</small></div><div class="field full"><label for="autoReconnectDelaySetting">自动重连间隔</label><div class="setting-number-unit"><input id="autoReconnectDelaySetting" type="number" min="1" max="60" /><span>秒</span></div></div></div></section>
          <section class="settings-page" data-settings-panel="files"><h2>文件与预览</h2><div class="settings-section"><label class="save-session"><input id="previewWrapSetting" type="checkbox" /> <span>文件预览默认自动换行</span></label><label class="save-session"><input id="previewLineNumbersSetting" type="checkbox" /> <span>文件预览默认显示行号</span></label><div class="field full"><label for="previewFontSizeSetting">文件预览字体大小</label><input id="previewFontSizeSetting" type="number" min="10" max="24" /></div><div class="field full"><label for="defaultDownloadDirectorySetting">默认下载目录</label><div class="input-action"><input id="defaultDownloadDirectorySetting" placeholder="留空时每次询问" /><button id="pickDownloadDirectory" type="button">浏览</button></div></div><label class="save-session"><input id="confirmOverwriteSetting" type="checkbox" /> <span>覆盖同名远程文件前确认</span></label><label class="save-session"><input id="showHiddenFilesSetting" type="checkbox" /> <span>显示以点开头的隐藏文件</span></label><label class="save-session"><input id="persistRemotePathSetting" type="checkbox" /> <span>记住每个会话最后访问的远程目录</span></label></div></section>
          <section class="settings-page" data-settings-panel="logging"><h2>日志</h2><div class="settings-section"><div class="field full"><label for="defaultLogDirectorySetting">默认日志目录</label><div class="input-action"><input id="defaultLogDirectorySetting" placeholder="留空时每次询问" /><button id="pickLogDirectory" type="button">浏览</button></div></div><label class="save-session"><input id="autoSessionLogSetting" type="checkbox" /> <span>SSH 连接成功后自动记录终端日志</span></label>
            <div class="settings-inline-actions"><button type="button" id="toggleSessionLogSetting">开始/停止当前会话日志</button></div><div class="field full"><label for="logFileTemplateSetting">日志文件名模板</label><input id="logFileTemplateSetting" placeholder="{session}_{date}.log" /><small>支持 {session}、{host}、{date}、{time}</small></div><div class="field full"><label for="tailDefaultLinesSetting">Tail 默认行数</label><input id="tailDefaultLinesSetting" type="number" min="1" max="100000" /></div><div class="field full"><label for="tailRefreshSetting">Tail 刷新间隔</label><div class="setting-number-unit"><input id="tailRefreshSetting" type="number" min="250" max="30000" step="250" /><span>ms</span></div></div></div></section>
          <section class="settings-page" data-settings-panel="performance"><h2 id="performanceSettingsTitle">性能与容量</h2><div class="settings-section"><div class="performance-settings-grid">
          <div class="field"><label id="uploadWorkersLabel" for="uploadWorkersSetting">上传并发数</label><input id="uploadWorkersSetting" type="number" min="1" max="4" /><small>默认 3，单方向最多 4 个连接</small></div>
          <div class="field"><label id="downloadWorkersLabel" for="downloadWorkersSetting">下载并发数</label><input id="downloadWorkersSetting" type="number" min="1" max="4" /><small>默认 4，单方向最多 4 个连接</small></div>
          <div class="field"><label id="tailMaxLinesLabel" for="tailMaxLinesSetting">Tail 最大保留行数</label><input id="tailMaxLinesSetting" type="number" min="1000" max="300000" step="1000" /><small>默认 200,000 行</small></div>
          <div class="field"><label id="tailAllLimitLabel" for="tailAllLimitSetting">Tail 全部内容上限</label><div class="setting-number-unit"><input id="tailAllLimitSetting" type="number" min="1" max="256" /><span>MB</span></div><small>默认 64 MB</small></div>
          <div class="field"><label id="fileChunkSizeLabel" for="fileChunkSizeSetting">文件分块大小</label><div class="setting-number-unit"><input id="fileChunkSizeSetting" type="number" min="1" max="64" /><span>MB</span></div><small>默认每次读取 4 MB</small></div>
          <div class="field"><label id="fileEditLimitLabel" for="fileEditLimitSetting">文件可编辑上限</label><div class="setting-number-unit"><input id="fileEditLimitSetting" type="number" min="1" max="64" /><span>MB</span></div><small>默认 32 MB</small></div>
          <div class="field"><label id="sftpPageSizeLabel" for="sftpPageSizeSetting">SFTP 每批显示项数</label><input id="sftpPageSizeSetting" type="number" min="100" max="5000" step="100" /><small>默认 500 项</small></div>
          <div class="field"><label id="sftpFilterDebounceLabel" for="sftpFilterDebounceSetting">SFTP 筛选延迟</label><div class="setting-number-unit"><input id="sftpFilterDebounceSetting" type="number" min="0" max="2000" step="10" /><span>ms</span></div><small>默认 120 ms，0 表示无延迟</small></div>
          </div></div></section>
          <p id="settingsNote" class="setting-note">设置会自动保存并立即生效；已开始的传输任务保持原并发数，新任务使用新参数。</p>
        </div>
      </div>
    </form>
  </div>
  <div id="helpModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle">
    <section class="dialog help-dialog">
      <div class="dialog-head"><div><strong id="helpModalTitle">帮助</strong></div><button type="button" data-close-help-modal aria-label="关闭帮助">×</button></div>
      <div id="helpModalBody" class="help-modal-body"></div>
      <div class="dialog-foot"><button type="button" data-close-help-modal>关闭</button></div>
    </section>
  </div>
  <div id="editorModal" class="modal hidden" role="dialog" aria-modal="true">
    <section class="dialog editor-dialog">
      <div class="dialog-head"><div><span><strong id="editorName">远程文件</strong><small id="editorPath"></small></span></div><div class="editor-window-actions"><button id="maximizeEditor" type="button" aria-label="最大化预览">□</button><button id="closeEditor" type="button" aria-label="关闭编辑器">×</button></div></div>
      <div class="editor-toolbar"><span id="editorEncoding">UTF-8</span><span id="editorSize">0 字符</span><div id="editorFind" class="editor-find hidden"><input id="editorFindInput" placeholder="查找内容" /><button id="editorFindPrevious">↑</button><button id="editorFindNext">↓</button><button id="closeEditorFind">×</button></div><button id="toggleLineNumbers" type="button">行号</button><button id="toggleEditorMode" type="button">编辑</button></div>
      <div class="editor-content"><pre id="editorLineNumbers" aria-hidden="true"></pre><textarea id="remoteEditor" readonly spellcheck="false" aria-label="远程文件内容"></textarea><div id="editorLoading" class="editor-loading"><i></i><span>正在读取远程文件…</span></div></div>
      <div class="dialog-foot"><button id="cancelEditor" type="button">关闭</button><button id="saveRemoteEditor" type="button" class="primary" disabled>保存到远端</button></div>
    </section>
  </div>
  <div id="appPrompt" class="app-prompt hidden"><section><strong id="appPromptTitle"></strong><p id="appPromptMessage"></p><input id="appPromptInput" /><select id="appPromptSelect" class="hidden"></select><div><button id="appPromptCancel">取消</button><button id="appPromptConfirm" class="primary">确定</button></div></section></div>
  <div id="toast" class="toast hidden"></div>
  <div class="overlay" id="paletteOverlay">
    <div class="palette" role="dialog" aria-label="命令面板">
      <div class="palette-input">
        ${ic('<path d="M4 17l6-6-6-6M12 19h8"/>')}
        <input id="paletteInput" type="text" placeholder="输入命令或搜索会话…" spellcheck="false" autocomplete="off" />
        <kbd class="chip">esc</kbd>
      </div>
      <div class="palette-list" id="paletteList"></div>
      <div class="palette-foot">
        <span><kbd class="chip">↑</kbd><kbd class="chip">↓</kbd> 选择</span>
        <span><kbd class="chip">↵</kbd> 执行</span>
        <span><kbd class="chip">esc</kbd> 关闭</span>
        <span class="spacer"></span>
        <span id="paletteCount"></span>
      </div>
    </div>
  </div>
`;

const el = (id) => document.getElementById(id);

function loadSessions() {
  try {
    const sessions = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function boundedNumber(value, fallback, minimum, maximum, integer = true) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  const bounded = Math.max(minimum, Math.min(maximum, normalized));
  return integer ? Math.round(bounded) : bounded;
}

function normalizePreferences(preferences = {}) {
  const merged = { ...DEFAULT_PREFERENCES, ...preferences };
  return {
    ...merged,
    appTheme: ["system", "light", "dark"].includes(merged.appTheme) ? merged.appTheme : "system",
    terminalScheme: resolveTerminalSchemeId(merged),
    terminalTheme: getTerminalScheme(resolveTerminalSchemeId(merged)).tone,
    cursorStyle: ["block", "bar", "underline"].includes(merged.cursorStyle) ? merged.cursorStyle : "bar",
    cursorBlink: Boolean(merged.cursorBlink),
    fontFamily: Object.hasOwn(terminalFontFamilies, merged.fontFamily) ? merged.fontFamily : "jetbrains",
    fontSize: boundedNumber(merged.fontSize, 13, 10, 32),
    lineHeight: boundedNumber(merged.lineHeight, 1.6, 1, 2, false),
    letterSpacing: boundedNumber(merged.letterSpacing, 0, -1, 5, false),
    copyOnSelect: Boolean(merged.copyOnSelect),
    rightClickAction: ["menu", "paste"].includes(merged.rightClickAction) ? merged.rightClickAction : "menu",
    bellStyle: ["none", "visual", "sound"].includes(merged.bellStyle) ? merged.bellStyle : "none",
    confirmCloseSessions: Boolean(merged.confirmCloseSessions),
    restoreWindow: Boolean(merged.restoreWindow),
    restoreTabs: Boolean(merged.restoreTabs),
    defaultDrawer: ["none", "sftp", "tail", "manual"].includes(merged.defaultDrawer) ? merged.defaultDrawer : "none",
    defaultTimeout: boundedNumber(merged.defaultTimeout, 20, 1, 300),
    keepaliveSeconds: boundedNumber(merged.keepaliveSeconds, 20, 5, 300),
    autoReconnectAttempts: boundedNumber(merged.autoReconnectAttempts, 0, 0, 10),
    autoReconnectDelaySeconds: boundedNumber(merged.autoReconnectDelaySeconds, 3, 1, 60),
    previewWrap: Boolean(merged.previewWrap),
    previewLineNumbers: Boolean(merged.previewLineNumbers),
    previewFontSize: boundedNumber(merged.previewFontSize, 13, 10, 24),
    defaultDownloadDirectory: typeof merged.defaultDownloadDirectory === "string" ? merged.defaultDownloadDirectory : "",
    confirmOverwrite: Boolean(merged.confirmOverwrite),
    showHiddenFiles: Boolean(merged.showHiddenFiles),
    persistRemotePath: Boolean(merged.persistRemotePath),
    defaultLogDirectory: typeof merged.defaultLogDirectory === "string" ? merged.defaultLogDirectory : "",
    autoSessionLog: Boolean(merged.autoSessionLog),
    logFileTemplate: typeof merged.logFileTemplate === "string" && merged.logFileTemplate.trim() ? merged.logFileTemplate.trim() : DEFAULT_PREFERENCES.logFileTemplate,
    tailDefaultLines: boundedNumber(merged.tailDefaultLines, 100, 1, 100_000),
    tailRefreshMs: boundedNumber(merged.tailRefreshMs, 2_000, 250, 30_000),
    recentSessionIds: Array.isArray(merged.recentSessionIds) ? merged.recentSessionIds.filter((id) => typeof id === "string").slice(0, 8) : [],
    lastOpenSessionIds: Array.isArray(merged.lastOpenSessionIds) ? merged.lastOpenSessionIds.filter((id) => typeof id === "string") : [],
    sessionGroups: Array.isArray(merged.sessionGroups) ? merged.sessionGroups.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()) : [],
    collapsedGroups: Array.isArray(merged.collapsedGroups) ? merged.collapsedGroups.filter((name) => typeof name === "string") : [],
    remotePathsBySession: merged.remotePathsBySession && typeof merged.remotePathsBySession === "object" ? merged.remotePathsBySession : {},
    windowBounds: preferences.windowBoundsVersion === 2 && merged.windowBounds && typeof merged.windowBounds === "object" ? merged.windowBounds : null,
    windowBoundsVersion: 2,
    scrollback: boundedNumber(merged.scrollback, 10_000, 1_000, 100_000),
    uploadWorkers: boundedNumber(merged.uploadWorkers, 3, 1, 4),
    downloadWorkers: boundedNumber(merged.downloadWorkers, 4, 1, 4),
    tailMaxLines: boundedNumber(merged.tailMaxLines, 200_000, 1_000, 300_000),
    tailAllLimitMb: boundedNumber(merged.tailAllLimitMb, 64, 1, 256),
    fileChunkSizeMb: boundedNumber(merged.fileChunkSizeMb, 4, 1, 64),
    fileEditLimitMb: boundedNumber(merged.fileEditLimitMb, 32, 1, 64),
    sftpPageSize: boundedNumber(merged.sftpPageSize, 500, 100, 5_000),
    sftpFilterDebounceMs: boundedNumber(merged.sftpFilterDebounceMs, 120, 0, 2_000),
  };
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    const migrated = {
      ...saved,
      terminalTheme: saved.terminalThemeDefaultVersion ? saved.terminalTheme || "dark" : "dark",
      terminalThemeDefaultVersion: 2,
      terminalScheme: saved.terminalScheme || (saved.terminalTheme === "light" ? "orbiterm-light" : undefined),
    };
    if ((saved.terminalChromeVersion || 0) < 3) {
      if (!saved.fontFamily || saved.fontFamily === "cascadia") migrated.fontFamily = "jetbrains";
      if (saved.lineHeight == null || Number(saved.lineHeight) === 1.18) migrated.lineHeight = 1.6;
      if (saved.fontSize == null || Number(saved.fontSize) === 14) migrated.fontSize = 13;
      if (!saved.cursorStyle || saved.cursorStyle === "block") migrated.cursorStyle = "bar";
      migrated.terminalChromeVersion = 3;
    }
    if ((saved.terminalChromeVersion || 0) < 4) {
      if (saved.lineHeight == null || Number(saved.lineHeight) === 1.5 || Number(saved.lineHeight) === 1.18) migrated.lineHeight = 1.6;
      migrated.terminalChromeVersion = 4;
    }
    return normalizePreferences(migrated);
  } catch {
    return normalizePreferences({ terminalThemeDefaultVersion: 2, terminalChromeVersion: 4 });
  }
}

function cssToXtermLineHeight(fontFamily, fontSize, cssLineHeight) {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText("Mq");
    const bbox = (metrics.fontBoundingBoxAscent || 0) + (metrics.fontBoundingBoxDescent || 0);
    if (bbox > 1) return Math.max(1, Number(((fontSize * cssLineHeight) / bbox).toFixed(3)));
  } catch {}
  return 1.2;
}

function terminalThemeName() {
  return currentSchemeTone();
}

function applyTerminalSchemeCss(node) {
  const theme = currentXtermTheme();
  node.style.setProperty("--term-bg", theme.background);
  node.style.setProperty("--term-fg", theme.foreground);
  node.style.setProperty("--term-cursor", theme.cursor);
  node.style.setProperty("--term-font-size", `${state.preferences.fontSize}px`);
  node.dataset.termTheme = currentSchemeTone();
}

function clearRootTerminalSchemeCss() {
  const root = document.documentElement;
  root.style.removeProperty("--term-bg");
  root.style.removeProperty("--term-fg");
  root.style.removeProperty("--term-cursor");
  delete root.dataset.termTheme;
}

function terminalChromeOptions() {
  const fontFamily = terminalFontFamilies[state.preferences.fontFamily];
  const fontSize = state.preferences.fontSize;
  const light = currentSchemeTone() === "light";
  return {
    fontFamily,
    fontSize,
    lineHeight: cssToXtermLineHeight(fontFamily, fontSize, state.preferences.lineHeight),
    letterSpacing: state.preferences.letterSpacing,
    fontWeight: light ? "500" : "400",
    fontWeightBold: "600",
    cursorStyle: state.preferences.cursorStyle,
    cursorBlink: state.preferences.cursorBlink,
    cursorWidth: Math.max(1, Math.round(state.preferences.fontSize / 7)),
    cursorInactiveStyle: "outline",
    theme: currentXtermTheme(),
  };
}

function applyTerminalChrome(record) {
  const options = terminalChromeOptions();
  record.terminal.options.fontFamily = options.fontFamily;
  record.terminal.options.fontSize = options.fontSize;
  record.terminal.options.lineHeight = options.lineHeight;
  record.terminal.options.letterSpacing = options.letterSpacing;
  record.terminal.options.fontWeight = options.fontWeight;
  record.terminal.options.fontWeightBold = options.fontWeightBold;
  record.terminal.options.cursorStyle = options.cursorStyle;
  record.terminal.options.cursorBlink = options.cursorBlink;
  record.terminal.options.cursorWidth = options.cursorWidth;
  record.terminal.options.cursorInactiveStyle = options.cursorInactiveStyle;
  record.terminal.options.theme = options.theme;
  record.host.style.background = options.theme.background;
  applyTerminalSchemeCss(record.host);
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
  applyAppAppearance();
  state.terminals.forEach((record) => {
    applyTerminalChrome(record);
    record.terminal.options.scrollback = state.preferences.scrollback;
    record.terminal.options.bellStyle = state.preferences.bellStyle === "sound" ? "sound" : "none";
    requestAnimationFrame(() => record.fit.fit());
  });
}

async function captureWindowBounds() {
  if (!isTauri || state.restoringWindowBounds || !state.preferences.restoreWindow
    || await appWindow.isMinimized() || await appWindow.isMaximized() || await appWindow.isFullscreen()) return;
  const [position, size] = await Promise.all([appWindow.innerPosition(), appWindow.innerSize()]);
  state.preferences.windowBounds = { x: position.x, y: position.y, width: size.width, height: size.height };
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
}

async function revealMainWindow() {
  if (!isTauri) return;
  try {
    await Promise.race([restoreWindowBounds(), new Promise((resolve) => setTimeout(resolve, 1200))]);
  } catch {}
  try {
    await appWindow.show();
    await appWindow.setFocus();
  } catch {}
}

function scheduleWindowBoundsSave() {
  clearTimeout(state.windowBoundsTimer);
  state.windowBoundsTimer = setTimeout(() => { void captureWindowBounds(); }, 350);
}

async function restoreWindowBounds() {
  const bounds = state.preferences.restoreWindow ? state.preferences.windowBounds : null;
  if (!isTauri || !bounds) return;
  const savedWidth = Number(bounds.width);
  const savedHeight = Number(bounds.height);
  const width = Number.isFinite(savedWidth) && savedWidth >= 900 ? Math.min(7680, savedWidth) : 1280;
  const height = Number.isFinite(savedHeight) && savedHeight >= 600 ? Math.min(4320, savedHeight) : 800;
  const savedX = Number(bounds.x);
  const savedY = Number(bounds.y);
  state.restoringWindowBounds = true;
  try {
    await appWindow.setSize(new PhysicalSize(width, height));
    const monitors = await availableMonitors().catch(() => []);
    const visible = monitors.length === 0 || monitors.some((monitor) => {
      const area = monitor.workArea;
      const centerX = savedX + width / 2;
      const centerY = savedY + height / 2;
      return centerX >= area.position.x
        && centerX < area.position.x + area.size.width
        && centerY >= area.position.y
        && centerY < area.position.y + area.size.height;
    });
    const invalidPosition = !Number.isFinite(savedX) || !Number.isFinite(savedY) || (savedX === 0 && savedY === 0) || !visible;
    if (invalidPosition) await appWindow.center();
    else await appWindow.setPosition(new PhysicalPosition(savedX, savedY));
  } finally {
    state.restoringWindowBounds = false;
  }
}

function applyPerformancePreferences() {
  clearTimeout(state.remoteFilterTimer);
  state.remoteRenderLimit = state.preferences.sftpPageSize;
  updateActiveRemoteUi({ renderLimit: state.remoteRenderLimit });
  if (!el("sftpPanel").classList.contains("hidden")) renderRemoteEntries(state.remoteEntries);
  state.terminals.forEach((record) => {
    if (!record.tailLines?.length) return;
    record.tailLines = limitTailLines(record, record.tailLines);
    if (record.id === state.activeId) state.tailLines = record.tailLines;
  });
  if (!el("tailPanel").classList.contains("hidden")) renderTailOutput(false);
  updateTailModeUi();
  if (isTauri) {
    invoke("update_tool_window_preferences", { preferences: {
      chunkSize: state.preferences.fileChunkSizeMb * 1024 * 1024,
      editLimit: state.preferences.fileEditLimitMb * 1024 * 1024,
      wrap: state.preferences.previewWrap,
      lineNumbers: state.preferences.previewLineNumbers,
      fontSize: state.preferences.previewFontSize,
    } }).catch(() => {});
  }
}

const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedAppTheme() {
  const preference = state.preferences.appTheme || "system";
  return preference === "system" ? (systemThemeQuery.matches ? "dark" : "light") : preference;
}

function applyAppAppearance() {
  const theme = resolvedAppTheme();
  document.documentElement.dataset.appTheme = theme;
  document.documentElement.dataset.appThemePreference = state.preferences.appTheme || "system";
  clearRootTerminalSchemeCss();
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  document.documentElement.lang = state.preferences.language === "en-US" ? "en" : "zh-CN";
  applyInterfaceLanguage();
  if (typeof updateActiveStatus === "function") updateActiveStatus();
}

systemThemeQuery.addEventListener("change", () => {
  if (state.preferences.appTheme !== "system") return;
  if (isSoftwareTerminalScheme(state.preferences.terminalScheme)) {
    state.preferences.terminalScheme = softwareTerminalSchemeId(systemThemeQuery.matches ? "dark" : "light");
    savePreferences();
    return;
  }
  applyAppAppearance();
});

function setSidebarCollapsed(collapsed) {
  document.querySelector(".sidebar").classList.toggle("collapsed", collapsed);
  state.preferences.sidebarCollapsed = collapsed;
  savePreferences();
  requestAnimationFrame(() => fitVisibleTerminals());
}

function persistSessions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions));
}

function renderRecentSessions() {
  const container = el("recentSessionsMenu");
  if (!container) return;
  const sessions = state.preferences.recentSessionIds.map((id) => state.sessions.find((session) => session.id === id)).filter(Boolean);
  if (!sessions.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<i></i><small>${tr("最近连接", "Recent connections")}</small>${sessions.map((session) => `<button type="button" data-recent-session="${escapeHtml(session.id)}"><span>${escapeHtml(session.name)}</span><kbd>${escapeHtml(session.host)}</kbd></button>`).join("")}`;
  container.querySelectorAll("[data-recent-session]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    const session = state.sessions.find((item) => item.id === button.dataset.recentSession);
    if (session) void connectSavedSession(session);
  }));
}

function rememberRecentSession(session) {
  if (!state.sessions.some((item) => item.id === session.id)) return;
  state.preferences.recentSessionIds = [session.id, ...state.preferences.recentSessionIds.filter((id) => id !== session.id)].slice(0, 8);
  savePreferences();
  renderRecentSessions();
}

function persistOpenSessionIds() {
  state.preferences.lastOpenSessionIds = [...state.terminals.values()]
    .map((record) => record.session.id)
    .filter((id) => state.sessions.some((session) => session.id === id));
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

const BOOTSTRAP_MARKER = encoder.encode("\x1b]777;orbiterm-ready\x07");
const BOOTSTRAP_ECHO_PREFIX = encoder.encode("if [ -n \"$BASH_VERSION\" ]");

function byteIndex(haystack, needle) {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function finishTerminalBootstrap(record, chunk) {
  const combined = new Uint8Array(record.bootstrapBuffer.length + chunk.length);
  combined.set(record.bootstrapBuffer);
  combined.set(chunk, record.bootstrapBuffer.length);
  const markerIndex = byteIndex(combined, BOOTSTRAP_MARKER);
  if (markerIndex >= 0) {
    clearTimeout(record.bootstrapTimer);
    record.bootstrapTimer = null;
    record.bootstrapPending = false;
    record.bootstrapInstalling = false;
    record.bootstrapInstalled = true;
    record.bootstrapBuffer = new Uint8Array();
    const echoedCommandIndex = byteIndex(combined, BOOTSTRAP_ECHO_PREFIX);
    if (echoedCommandIndex < 0) {
      const suffix = combined.slice(markerIndex + BOOTSTRAP_MARKER.length);
      const output = new Uint8Array(markerIndex + suffix.length);
      output.set(combined.slice(0, markerIndex));
      output.set(suffix, markerIndex);
      return output;
    }
    let lineStart = echoedCommandIndex;
    while (lineStart > 0 && combined[lineStart - 1] !== 10) lineStart -= 1;
    const suffix = combined.slice(markerIndex + BOOTSTRAP_MARKER.length);
    const output = new Uint8Array(lineStart + suffix.length);
    output.set(combined.slice(0, lineStart));
    output.set(suffix, lineStart);
    return output;
  }
  record.bootstrapBuffer = combined;
  return new Uint8Array();
}

async function installCwdIntegration(record) {
  if (!record.connected || record.bootstrapInstalled || record.bootstrapInstalling || !record.bootstrapWanted) return;
  record.bootstrapInstalling = true;
  record.bootstrapPending = true;
  // The shell prints a fresh prompt after installing the hook. Clear only the
  // currently visible prompt line first so it is not shown twice.
  record.terminal.write("\r\x1b[2K");
  clearTimeout(record.bootstrapFallbackTimer);
  record.bootstrapFallbackTimer = null;
  const integration = "if [ -n \"$BASH_VERSION\" ]; then __orbiterm_cwd(){ printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }; PROMPT_COMMAND=\"__orbiterm_cwd$([ -n \"$PROMPT_COMMAND\" ] && printf ';%s' \"$PROMPT_COMMAND\")\"; elif [ -n \"$ZSH_VERSION\" ]; then autoload -Uz add-zsh-hook 2>/dev/null; __orbiterm_cwd(){ printf '\\033]7;file://%s%s\\033\\\\' \"$HOST\" \"$PWD\"; }; add-zsh-hook precmd __orbiterm_cwd 2>/dev/null; fi; printf '\\033]777;orbiterm-ready\\007'\n";
  await invoke("ssh_write", { id: record.id, data: Array.from(encoder.encode(integration)) }).catch(() => {
    record.bootstrapPending = false;
    record.bootstrapInstalling = false;
  });
  record.bootstrapTimer = setTimeout(() => {
    if (!record.bootstrapPending) return;
    record.bootstrapPending = false;
    record.bootstrapInstalling = false;
    record.terminal.write(colorizeClientOutput(record, new TextDecoder().decode(record.bootstrapBuffer)));
    record.bootstrapBuffer = new Uint8Array();
  }, 2000);
}

function toast(message, kind = "info") {
  const node = el("toast");
  node.textContent = localizeRuntimeText(message);
  node.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), 3200);
}

function refreshNotifyBadge() {
  const attention = openTerminals().filter((record) => record.status === "error" || (record.status === "disconnected" && !record.manualDisconnect));
  el("bellBtn")?.classList.toggle("has-badge", attention.length > 0);
  const list = el("notifyList");
  if (!list) return;
  list.className = attention.length ? "" : "notify-empty";
  list.innerHTML = attention.length
    ? attention.map((record) => `<button type="button" class="notify-item" data-notify-id="${record.id}"><b>${escapeHtml(record.session.name)}</b>${escapeHtml(record.status === "error" ? tr("连接失败", "Connection failed") : tr("已断开", "Disconnected"))}</button>`).join("")
    : tr("暂无需要处理的会话", "No sessions need attention");
}

const PALETTE_ICONS = {
  server: ic('<rect x="3" y="4" width="18" height="6" rx="1.6"/><rect x="3" y="14" width="18" height="6" rx="1.6"/><path d="M7 7h.01M7 17h.01"/>'),
  bolt: ic('<path d="M13 2 4.5 13.5H11L9.5 22 19 9.5h-6.5z"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>'),
};

function paletteItems() {
  return [
    ...state.sessions.map((session) => ({
      sec: tr("会话", "Sessions"), icon: "server", title: `${tr("连接", "Connect")} ${session.name}`, sub: `${session.username}@${session.host} · ${session.group || tr("默认分组", "Default")}`,
      run: () => connectSavedSession(session),
    })),
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("新建会话", "New session"), sub: tr("添加一台主机并连接", "Add a host and connect"), kbd: ["Ctrl", "Shift", "T"], run: () => openSessionModal() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("打开本地 PowerShell", "Open local PowerShell"), sub: tr("在本机启动终端", "Start a local terminal"), run: () => openLocalSshModal() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("打开 SFTP 文件面板", "Open SFTP"), sub: tr("浏览远程目录、上传下载", "Browse and transfer files"), kbd: ["Ctrl", "E"], run: () => toggleSftp(true) },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("打开 Tail 日志", "Open Tail logs"), sub: tr("查看远程日志文件", "Inspect a remote log file"), run: () => void openTailPanel() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("打开 Linux 命令手册", "Open Linux command manual"), sub: tr("离线查看常用命令和参数", "Offline command reference"), run: () => openCommandManual() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("终端内查找", "Find in terminal"), sub: tr("在当前终端输出中搜索", "Search current terminal output"), kbd: ["Ctrl", "Shift", "G"], run: () => showFindBar() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("开始/停止会话日志", "Start/stop session log"), sub: tr("把当前 SSH 输出记到本地文件", "Record the current SSH output to a local file"), run: () => void toggleSessionLog() },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("重新连接当前会话", "Reconnect"), sub: tr("断开并重新建立 SSH 连接", "Drop and re-establish the SSH session"), run: () => runMenuAction("reconnect") },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("清空终端", "Clear terminal"), sub: tr("清除当前终端缓冲", "Clear the current terminal buffer"), run: () => runMenuAction("clear") },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("切换侧栏", "Toggle sidebar"), sub: tr("显示 / 隐藏工作区列表", "Show or hide the workspace list"), kbd: ["Ctrl", "B"], run: () => runMenuAction("toggle-sidebar") },
    { sec: tr("操作", "Actions"), icon: "bolt", title: tr("新建分组", "New group"), sub: tr("在会话库里增加一个分组", "Add a group in the session library"), run: () => void createSessionGroup() },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("导入会话配置", "Import sessions"), sub: tr("从 JSON 文件恢复会话列表", "Restore sessions from a JSON file"), run: () => void importSessions() },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("导出会话配置", "Export sessions"), sub: tr("把会话列表存成 JSON", "Save the session list as JSON"), run: () => void exportSessions() },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("切换亮色 / 深色主题", "Toggle light / dark theme"), sub: tr("纸面亮色工作台 ↔ 深空深色", "Paper light ↔ deep dark"), run: () => toggleAppTheme() },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("打开设置", "Open settings"), sub: tr("终端字体、主题、性能与安全", "Fonts, theme, performance and security"), run: () => openSettingsModal() },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("使用说明", "User guide"), sub: tr("快速了解连接、文件和日志", "A short tour of sessions, files and logs"), run: () => openHelpModal("guide") },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("快捷键一览", "Keyboard shortcuts"), sub: tr("查看全部键盘快捷键", "View all shortcuts"), run: () => runMenuAction("shortcuts") },
    { sec: tr("设置", "Settings"), icon: "gear", title: tr("关于 Orbiterm", "About Orbiterm"), sub: tr("版本与软件说明", "Version and about"), run: () => openHelpModal("about") },
  ];
}

let palSel = 0;
let paletteVisible = [];

function fuzzy(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  let qi = 0;
  const hit = [];
  for (let i = 0; i < text.length && qi < query.length; i += 1) if (text[i] === query[qi]) { hit.push(i); qi += 1; }
  return qi === query.length ? hit : null;
}

function highlightPalette(title, hits) {
  const set = new Set(hits || []);
  return [...title].map((char, index) => (set.has(index) ? `<mark>${escapeHtml(char)}</mark>` : escapeHtml(char))).join("");
}

function renderPalette() {
  const q = el("paletteInput").value.trim();
  const all = paletteItems().map((item) => ({ ...item, hits: q ? fuzzy(q, `${item.title} ${item.sub}`) : [] })).filter((item) => !q || item.hits);
  paletteVisible = all;
  const list = el("paletteList");
  if (!all.length) {
    list.innerHTML = `<div class="palette-empty">${tr("没有匹配的结果", "No matching results")}</div>`;
    el("paletteCount").textContent = "";
    return;
  }
  palSel = Math.min(palSel, all.length - 1);
  let html = "";
  let lastSec = "";
  all.forEach((item, index) => {
    if (item.sec !== lastSec) { html += `<div class="palette-sec">${escapeHtml(item.sec)}</div>`; lastSec = item.sec; }
    html += `<div class="p-item ${index === palSel ? "sel" : ""}" data-i="${index}">
      <span class="pic">${PALETTE_ICONS[item.icon]}</span>
      <span class="ptext"><b>${highlightPalette(item.title, q ? fuzzy(q, item.title) || [] : [])}</b><small>${escapeHtml(item.sub)}</small></span>
      ${item.kbd ? `<span class="pkbd">${item.kbd.map((key) => `<kbd class="chip">${key}</kbd>`).join("")}</span>` : '<span class="go">↵</span>'}
    </div>`;
  });
  list.innerHTML = html;
  el("paletteCount").textContent = tr(`${all.length} 项`, `${all.length} items`);
  list.querySelector(".p-item.sel")?.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  palSel = 0;
  el("paletteInput").value = "";
  el("paletteOverlay").classList.add("open");
  renderPalette();
  setTimeout(() => el("paletteInput").focus(), 30);
}

function closePalette() {
  el("paletteOverlay").classList.remove("open");
}

function softwareSchemeForAppChoice(appTheme) {
  const tone = appTheme === "system" ? (systemThemeQuery.matches ? "dark" : "light") : appTheme;
  return softwareTerminalSchemeId(tone);
}

function withSoftwareTerminalDefault(appTheme, schemeId) {
  if (schemeId && !isSoftwareTerminalScheme(schemeId)) return schemeId;
  return softwareSchemeForAppChoice(appTheme);
}

function toggleAppTheme() {
  const next = resolvedAppTheme() === "dark" ? "light" : "dark";
  state.preferences.appTheme = next;
  state.preferences.terminalScheme = withSoftwareTerminalDefault(next, state.preferences.terminalScheme);
  savePreferences();
  toast(resolvedAppTheme() === "light" ? tr("已切换到亮色主题", "Switched to light theme") : tr("已切换到深色主题", "Switched to dark theme"));
}

function tr(zh, en) {
  return state.preferences.language === "en-US" ? en : zh;
}

const runtimeEnglish = new Map([
  ["请输入登录密码", "Enter the login password"], ["请选择私钥文件", "Choose a private key file"],
  ["启动本地 PowerShell 失败", "Failed to start local PowerShell"], ["请先连接 SSH 会话", "Connect an SSH session first"],
  ["本地 PowerShell 暂不使用 SSH 会话日志", "SSH session logging is not available for local PowerShell"],
  ["会话日志已停止", "Session logging stopped"], ["会话日志已开始记录", "Session logging started"],
  ["未找到匹配内容", "No matching content found"], ["原会话已断开，无法保存", "The original session is disconnected; the file cannot be saved"],
  ["二进制预览为只读，不能直接保存", "Binary previews are read-only"], ["远程文件已保存", "Remote file saved"],
  ["请选择要下载的文件", "Select files to download"], ["目录名称无效", "Invalid folder name"],
  ["请选择要删除的文件或目录", "Select files or folders to delete"], ["请选择要重命名的文件或目录", "Select a file or folder to rename"],
  ["名称无效", "Invalid name"], ["重命名完成", "Rename complete"], ["请选择文件或目录", "Select files or folders"],
  ["请输入 3 或 4 位八进制权限值", "Enter a 3- or 4-digit octal permission value"],
  ["请选择当前目录中的日志文件", "Select a log file"], ["没有可导出的会话", "There are no sessions to export"],
  ["没有可重连的会话", "There is no session to reconnect"], ["请先选择终端内容", "Select terminal text first"],
  ["当前终端未连接", "The current terminal is disconnected"], ["多行文本已复制", "Multi-line text copied"],
  ["命令已复制", "Command copied"], ["远程路径已复制", "Remote path copied"],
  ["请先打开 SFTP 文件管理器", "Open the SFTP file manager first"], ["传输已取消", "Transfer cancelled"],
  ["上传任务已加入队列", "Upload added to the queue"], ["下载任务已加入队列", "Download added to the queue"],
  ["原会话已断开，上传任务已取消", "The original session disconnected; the queued upload was cancelled"],
  ["原会话已断开，下载任务已取消", "The original session disconnected; the queued download was cancelled"],
  ["取消传输并关闭", "Cancel transfers and close"], ["该会话仍有文件正在传输。关闭会话将取消传输，是否继续？", "Files are still being transferred. Close the session and cancel them?"],
  ["覆盖远程文件", "Overwrite remote files"], ["全部覆盖", "Overwrite all"], ["放弃修改", "Discard changes"],
  ["远程文件有未保存的修改，确定关闭吗？", "The remote file has unsaved changes. Close it anyway?"],
  ["新建文件夹", "New folder"], ["新建文件", "New file"], ["删除远程项目", "Delete remote items"],
  ["重命名", "Rename"], ["修改权限", "Change permissions"], ["请输入八进制权限值，例如 644、755", "Enter an octal permission such as 644 or 755"],
  ["文件夹属性", "Folder properties"], ["文件属性", "File properties"], ["关闭", "Close"],
  ["退出 Orbiterm", "Exit Orbiterm"], ["仍有文件正在传输。退出将取消传输，是否继续？", "Files are still being transferred. Exit and cancel them?"],
  ["删除会话", "Delete session"],
  ["确定", "OK"], ["取消", "Cancel"], ["删除", "Delete"], ["关闭会话", "Close session"], ["退出", "Exit"],
]);

function localizeRuntimeText(message) {
  const value = String(message ?? "");
  if (state.preferences.language !== "en-US") return value;
  if (runtimeEnglish.has(value)) return runtimeEnglish.get(value);
  const patterns = [
    [/^连接 (.+) 失败$/, (_, name) => `Failed to connect to ${name}`],
    [/^(\d+) 个文件上传完成$/, (_, count) => `${count} file(s) uploaded`],
    [/^(\d+) 个文件下载完成$/, (_, count) => `${count} file(s) downloaded`],
    [/^权限已修改为 (.+)$/, (_, mode) => `Permissions changed to ${mode}`],
    [/^已导出 (\d+) 个会话$/, (_, count) => `${count} session(s) exported`],
    [/^已导入 (\d+) 个会话$/, (_, count) => `${count} session(s) imported`],
    [/^导入失败：(.*)$/s, (_, detail) => `Import failed: ${detail}`],
    [/^复制失败：(.*)$/s, (_, detail) => `Copy failed: ${detail}`],
    [/^粘贴失败：(.*)$/s, (_, detail) => `Paste failed: ${detail}`],
    [/^复制路径失败：(.*)$/s, (_, detail) => `Failed to copy path: ${detail}`],
    [/^将在 (.+) 中创建$/, (_, path) => `Create in ${path}`],
    [/^远程目录中已存在 (.+)，是否全部覆盖？$/, (_, names) => `${names} already exist in the remote folder. Overwrite all?`],
    [/^确定递归删除选中的 (\d+) 项吗？此操作无法撤销。$/, (_, count) => `Recursively delete ${count} selected item(s)? This cannot be undone.`],
    [/^确定删除会话“(.+)”吗？$/, (_, name) => `Delete session “${name}”?`],
    [/^(\d+\/\d+ · )?正在上传 (.+)…$/, (_, prefix = "", name) => `${prefix}Uploading ${name}…`],
    [/^(\d+\/\d+ · )?正在下载 (.+)…$/, (_, prefix = "", name) => `${prefix}Downloading ${name}…`],
    [/^✓ 已上传 (.+)$/, (_, detail) => `✓ Uploaded ${detail}`],
    [/^✓ 已下载 (.+)$/, (_, detail) => `✓ Downloaded ${detail}`],
    [/^上传失败 · 已完成 (.+)$/, (_, detail) => `Upload failed · Completed ${detail}`],
    [/^下载失败 · 已完成 (.+)$/, (_, detail) => `Download failed · Completed ${detail}`],
    [/^上传已取消 · 已完成 (.+)$/, (_, detail) => `Upload cancelled · Completed ${detail}`],
    [/^下载已取消 · 已完成 (.+)$/, (_, detail) => `Download cancelled · Completed ${detail}`],
    [/^正在取消传输…$/, () => "Cancelling transfers…"],
  ];
  for (const [pattern, replace] of patterns) {
    if (pattern.test(value)) return value.replace(pattern, replace);
  }
  const prefixes = [
    ["无法解析主机：", "Failed to resolve host: "], ["无法连接 ", "Unable to connect "],
    ["SSH 初始化失败：", "SSH initialization failed: "], ["SSH 握手失败：", "SSH handshake failed: "],
    ["认证失败：", "Authentication failed: "], ["主机指纹不匹配。", "Host key mismatch. "],
    ["读取终端失败：", "Failed to read terminal: "], ["SSH keepalive 失败：", "SSH keepalive failed: "],
    ["无法读取远程目录：", "Failed to read remote folder: "], ["无法打开远程文件：", "Failed to open remote file: "],
    ["读取远程文件失败：", "Failed to read remote file: "], ["保存远程文件失败：", "Failed to save remote file: "],
    ["提交远程文件失败：", "Failed to commit remote file: "], ["上传失败：", "Upload failed: "],
    ["下载失败：", "Download failed: "], ["SFTP 初始化失败：", "SFTP initialization failed: "],
    ["新建目录失败：", "Failed to create folder: "], ["删除失败：", "Delete failed: "],
    ["重命名失败：", "Rename failed: "], ["修改权限失败：", "Failed to change permissions: "],
    ["读取新增日志失败：", "Failed to read new log data: "], ["无法打开日志文件：", "Failed to open log file: "],
  ];
  const prefix = prefixes.find(([source]) => value.startsWith(source));
  if (prefix) return `${prefix[1]}${value.slice(prefix[0].length)}`;
  return value;
}

const commandCategoryEnglish = {
  "文件与目录": "Files and directories", "文本处理": "Text processing", "权限与用户": "Permissions and users",
  "进程与服务": "Processes and services", "网络": "Networking", "磁盘与系统": "Disk and system",
  "压缩与软件": "Archives and packages", "Shell 工具": "Shell tools", "性能诊断": "Performance diagnostics",
  "网络诊断": "Network diagnostics", "存储管理": "Storage management", "容器": "Containers",
  "服务诊断": "Service diagnostics", "安全": "Security", "开发工具": "Developer tools",
};

const commandDescriptionEnglish = {
  ls: "List directory contents", cd: "Change the current directory", pwd: "Print the current working directory",
  mkdir: "Create directories", cp: "Copy files and directories", mv: "Move or rename files and directories",
  rm: "Remove files or directories", find: "Search for files by conditions", touch: "Create files or update timestamps",
  stat: "Display detailed file information", cat: "Print or concatenate files", less: "View text one screen at a time",
  head: "Show the beginning or end of a file", grep: "Search text using patterns", sed: "Transform text streams",
  awk: "Process structured text by fields", sort: "Sort and deduplicate text", wc: "Count lines, words, and bytes",
  cut: "Extract fields or columns", xargs: "Build command arguments from input", chmod: "Change file permissions",
  chown: "Change file owner and group", sudo: "Run a command with elevated privileges", id: "Show user identity",
  useradd: "Create or modify user accounts", passwd: "Change an account password", ps: "Display running processes",
  top: "Monitor processes in real time", kill: "Send signals to processes", jobs: "Manage shell jobs",
  nohup: "Keep a command running after logout", systemctl: "Manage systemd services", journalctl: "Read systemd journals",
  ip: "Inspect and configure networking", ss: "Inspect sockets and listening ports", ping: "Test network reachability",
  curl: "Transfer data using URLs", wget: "Download files from the network", dig: "Query DNS records",
  traceroute: "Trace the network route to a host", scp: "Copy files over SSH", rsync: "Synchronize files efficiently",
  ssh: "Open a secure remote shell", df: "Report file-system space usage", du: "Estimate file and directory usage",
  lsblk: "List block devices", mount: "Mount or unmount file systems", free: "Display memory usage",
  uname: "Display kernel and system information", uptime: "Show uptime and system load", date: "Display or configure time",
  dmesg: "Read kernel messages", env: "Display or set environment variables", tar: "Create or extract archives",
  gzip: "Compress or decompress gzip files", zip: "Create or extract ZIP archives", apt: "Manage Debian and Ubuntu packages",
  dnf: "Manage RPM-based packages", rpm: "Query installed packages", history: "Display shell command history",
  alias: "Create command aliases", which: "Locate executable commands", man: "Read command documentation",
  tee: "Copy input to files and standard output", watch: "Run a command periodically", screen: "Manage persistent terminal sessions",
  vmstat: "Report processes, memory, CPU, and I/O", iostat: "Report CPU and device I/O statistics",
  pidstat: "Monitor resource usage by process", sar: "Collect and report system activity", lsof: "List open files and ports",
  strace: "Trace system calls and signals", perf: "Profile CPU performance", mtr: "Diagnose routes and packet loss",
  tcpdump: "Capture and filter network packets", nmap: "Discover hosts, ports, and services", fdisk: "Inspect or edit disk partitions",
  lvs: "Inspect LVM volumes", smartctl: "Read disk SMART health data", docker: "Manage containers and images",
  podman: "Manage daemonless containers", kubectl: "Manage Kubernetes resources", crictl: "Inspect CRI container runtimes",
  "systemd-analyze": "Analyze system and service startup", coredumpctl: "Inspect application crash dumps",
  getfacl: "Inspect or modify file ACLs", ausearch: "Search Linux audit logs", jq: "Query and transform JSON",
  yq: "Query and transform YAML", openssl: "Inspect certificates, TLS, and cryptographic data",
};

function commandEnglishBase(name) {
  return name.split(" /")[0].split("/")[0].trim().split(/\s+/)[0];
}

function commandPresentation(command) {
  const [category, name, description, example] = command;
  if (state.preferences.language !== "en-US") return { category, name, description, example };
  const base = commandEnglishBase(name);
  return {
    category: commandCategoryEnglish[category] || "Linux commands",
    name,
    description: commandDescriptionEnglish[base] || `Reference, options, and examples for the ${base} command`,
    example,
  };
}

function commandOptionDescriptionEnglish(base, item) {
  const optionName = item.option.toLowerCase();
  if (optionName.includes("--help")) return `Display help for the ${base} command.`;
  if (optionName.includes("--version")) return `Display the installed ${base} version.`;
  if (optionName.includes("recursive")) return "Process directories recursively.";
  if (optionName.includes("verbose")) return "Show detailed information while the command runs.";
  if (optionName.includes("quiet") || optionName.includes("silent")) return "Suppress non-essential output.";
  if (optionName.includes("force")) return "Force the requested operation where supported.";
  if (optionName.includes("human-readable")) return "Display sizes in human-readable units.";
  return `Use ${item.option} with ${base}. See the example for the expected syntax.`;
}

function appPrompt({ title, message = "", value = "", input = true, confirmText = "确定", options = null }) {
  return new Promise((resolve) => {
    const root = el("appPrompt");
    const selectMode = Array.isArray(options) && options.length > 0;
    const select = el("appPromptSelect");
    const promptValue = () => selectMode ? select.value : input ? el("appPromptInput").value : true;
    const cancelValue = () => input || selectMode ? null : false;
    el("appPromptTitle").textContent = localizeRuntimeText(title);
    el("appPromptMessage").textContent = localizeRuntimeText(message);
    el("appPromptMessage").classList.toggle("hidden", !message);
    el("appPromptInput").classList.toggle("hidden", !input || selectMode);
    el("appPromptInput").value = value;
    select.classList.toggle("hidden", !selectMode);
    select.replaceChildren(...(options || []).map((option) => new Option(option, option)));
    if (selectMode) select.value = options.includes(value) ? value : options[0];
    el("appPromptConfirm").textContent = localizeRuntimeText(confirmText);
    el("appPromptCancel").textContent = tr("取消", "Cancel");
    const finish = (result) => {
      root.classList.add("hidden");
      el("appPromptConfirm").onclick = null;
      el("appPromptCancel").onclick = null;
      root.onclick = null;
      root.onkeydown = null;
      resolve(result);
    };
    el("appPromptConfirm").onclick = () => finish(promptValue());
    el("appPromptCancel").onclick = () => finish(cancelValue());
    root.onclick = (event) => { if (event.target === root) finish(cancelValue()); };
    root.onkeydown = (event) => {
      if (event.key === "Escape") finish(cancelValue());
      if (event.key === "Enter") finish(promptValue());
    };
    root.classList.remove("hidden");
    setTimeout(() => {
      const target = selectMode ? select : input ? el("appPromptInput") : el("appPromptConfirm");
      target.focus();
      if (input && !selectMode) target.select();
    }, 20);
  });
}

function commandManualView(view = "drawer") {
  return view === "modal"
    ? { search: el("modalCommandSearch"), list: el("modalCommandList"), detail: el("modalCommandDetail") }
    : { search: el("commandSearch"), list: el("commandList"), detail: el("commandDetail") };
}

async function ensureCommandOptions() {
  if (!commandOptionsPromise) {
    commandOptionsPromise = import("./command-options.js").then((module) => {
      commandOptions = module.commandOptions;
    });
  }
  await commandOptionsPromise;
}

async function renderCommandManual(view = "drawer") {
  await ensureCommandOptions();
  const elements = commandManualView(view);
  if (!elements.search || !elements.list || !elements.detail) return;
  const query = elements.search.value.trim().toLowerCase();
  const commands = linuxCommands.filter((command) => [...command, ...Object.values(commandPresentation(command))].join(" ").toLowerCase().includes(query));
  const groups = commands.reduce((map, command) => { const category = commandPresentation(command).category; if (!map.has(category)) map.set(category, []); map.get(category).push(command); return map; }, new Map());
  let first = true;
  elements.list.innerHTML = commands.length ? [...groups].map(([category, items]) => `<section><h3>${escapeHtml(category)}</h3>${items.map((command) => { const active = first; first = false; const presented = commandPresentation(command); return `<button data-command-index="${linuxCommands.indexOf(command)}"${active ? " class=\"active\"" : ""}><code>${escapeHtml(presented.name)}</code><small>${escapeHtml(presented.description)}</small></button>`; }).join("")}</section>`).join("") : `<div class="manual-empty">${tr("没有匹配的命令", "No matching commands")}</div>`;
  if (commands.length) renderCommandDetail(linuxCommands.indexOf(commands[0]), elements.detail);
  else elements.detail.innerHTML = `<div class="manual-empty">${tr("请更换搜索条件", "Try a different search")}</div>`;
}

function commandExamples(name, example) {
  const base = name.split(" /")[0].split(" ")[0];
  return [...new Set([example, `${base} --help`, `man ${base}`, `type ${base}`, `command -V ${base}`])];
}

function renderCommandDetail(index, target = el("commandDetail")) {
  const command = linuxCommands[index];
  if (!command) return;
  const { category, name, description, example } = commandPresentation(command);
  const english = state.preferences.language === "en-US";
  const names = name.split("/").map((value) => value.trim().split(/\s+/)[0]).filter(Boolean);
  const groups = names.map((base) => [base, commandOptions[base] || []]).filter(([, options]) => options.length);
  const total = groups.reduce((count, [, options]) => count + options.length, 0);
  const optionHtml = groups.map(([base, options]) => `<section class="command-options"><h3>${escapeHtml(base)} ${tr("全部参数", "options")} <small>${options.length} ${tr("项", "items")}</small></h3>${options.map((item) => `<article class="command-option"><code>${escapeHtml(item.option)}</code><p>${escapeHtml(english ? commandOptionDescriptionEnglish(base, item) : item.description)}</p><div><kbd>${escapeHtml(item.example)}</kbd><button class="copy-option" data-copy-command="${escapeHtml(item.example)}" title="${tr("复制示例", "Copy example")}" aria-label="${tr("复制示例", "Copy example")}">⧉</button></div></article>`).join("")}</section>`).join("");
  target.innerHTML = `<header><small>${escapeHtml(category)}</small><h2>${escapeHtml(name)}</h2><p>${escapeHtml(description)}</p></header>${optionHtml ? `<p class="manual-option-summary">${tr(`共 ${total} 个参数 · 离线内置资料`, `${total} options · Built-in offline reference`)}</p>${optionHtml}` : `<section><h3>${tr("常用示例", "Common examples")}</h3>${commandExamples(name, example).map((value) => `<div class="command-example"><code>${escapeHtml(value)}</code><button data-copy-command="${escapeHtml(value)}">${tr("复制", "Copy")}</button></div>`).join("")}</section>`}`;
}

function openCommandManual() {
  const record = activeTerminal();
  if (!record) return openHelpModal("command-manual");
  if (state.drawerByTerminal.get(record.id) === "manual") {
    setActiveDrawer(null);
    return;
  }
  setActiveDrawer("manual");
  void renderCommandManual("drawer");
  setTimeout(() => el("commandSearch").focus(), 30);
}

function openTerminals() {
  return [...state.terminals.values()];
}

function terminalForSession(sessionId) {
  return openTerminals().find((record) => record.session.id === sessionId);
}

function workspaceChips(record) {
  const chips = [];
  if (record.session.local) chips.push([tr("PowerShell", "PowerShell"), "acc"]);
  else chips.push([record.session.terminalType === "xterm-256color" ? "xterm" : (record.session.terminalType || "ssh"), ""]);
  if (record.logging) chips.push([tr("日志", "log"), "acc"]);
  if (record.status === "connecting") chips.push([tr("连接中", "connecting"), "hot"]);
  if (!record.session.local && record.session.port && record.session.port !== 22) chips.push([`:${record.session.port}`, "acc"]);
  return chips;
}

function renderWorkspaces(query = "") {
  const q = query.trim().toLowerCase();
  const list = openTerminals().filter((record) => !q || [record.session.name, record.session.host, record.session.username].join(" ").toLowerCase().includes(q));
  if (el("wsCount")) el("wsCount").textContent = String(state.terminals.size);
  if (el("wsStatusCount")) el("wsStatusCount").textContent = String(state.terminals.size);
  if (!el("wsList")) return;
  el("wsList").innerHTML = list.length
    ? list.map((record) => {
      const attention = record.status === "error" || (record.status === "disconnected" && !record.session.local);
      const latency = record.latency != null && record.connected ? `${record.latency}ms` : "";
      const latencyClass = record.latency == null ? "" : record.latency < 50 ? "fast" : record.latency < 150 ? "mid" : "slow";
      const chips = workspaceChips(record).map(([text, kind]) => `<span class="chiplet ${kind}">${escapeHtml(text)}</span>`).join("");
      const host = record.session.local ? tr("本机 PowerShell", "Local PowerShell") : `${record.session.username}@${record.session.host}`;
      const dot = record.status === "connected" ? "on" : record.status === "connecting" || attention ? "warn" : "";
      return `<div class="ws${state.activeId === record.id ? " active" : ""}${attention ? " attention" : ""}${visibleSplitIds().length > 1 && visibleSplitIds().includes(record.id) ? " in-split" : ""}" data-terminal-id="${record.id}" tabindex="0">
        <span class="row1"><span class="dot ${dot}"></span><b>${escapeHtml(record.session.name)}</b>${latency ? `<span class="lat ${latencyClass}">${escapeHtml(latency)}</span>` : ""}</span>
        <span class="row2">${escapeHtml(host)}</span>
        <span class="row3">${attention ? `<span class="need"><i></i>${tr("需要关注", "Needs attention")}</span>` : ""}${chips}</span>
        <button class="x" data-close-terminal="${record.id}" title="${tr("关闭", "Close")}">${ic('<path d="M6 6l12 12M18 6 6 18"/>')}</button>
      </div>`;
    }).join("")
    : `<div class="no-sessions">${q ? tr("没有匹配的工作区", "No matching workspaces") : tr("还没有打开的工作区", "No open workspaces")}</div>`;
}

function renderSessions() {
  const english = state.preferences.language === "en-US";
  const query = el("sessionSearch").value.trim().toLowerCase();
  renderWorkspaces(query);
  const openIds = new Set(openTerminals().map((record) => record.session.id));
  const library = state.sessions.filter((session) => [session.name, session.host, session.group, session.username].join(" ").toLowerCase().includes(query));
  const groups = new Map(sessionGroupNames().map((group) => [group, []]));
  library.forEach((session) => {
    const group = session.group || DEFAULT_GROUP;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(session);
  });
  const visible = [...groups].filter(([, sessions]) => !query || sessions.length);
  el("sessionList").innerHTML = visible.length
    ? visible.map(([group, sessions]) => {
      const collapsed = (state.preferences.collapsedGroups || []).includes(group);
      return `<section class="session-group lib-group${collapsed ? " collapsed closed" : ""}"><button type="button" class="lib-head" data-session-group="${escapeHtml(group)}" tabindex="0" aria-expanded="${!collapsed}">${ic('<path d="m6 9 6 6 6-6"/>')}${escapeHtml(group)}<em>${sessions.length}</em></button><div class="lib-items session-group-items">${sessions.map((session) => `
      <article class="session-item lib-item${openIds.has(session.id) ? " is-open" : ""}${openTerminals().some((record) => record.session.id === session.id && record.id === state.activeId) ? " active" : ""}" data-session-id="${session.id}" tabindex="0">
        <span class="dot${openIds.has(session.id) ? " on" : ""}"></span>
        <span class="session-meta meta"><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.username)}@${escapeHtml(session.host)}:${session.port}</small></span>
        <span class="go">${openIds.has(session.id) ? (english ? "Open" : "已打开") : (english ? "↵ Connect" : "↵ 连接")}</span>
        <span class="session-actions"><button data-action="edit" title="${english ? "Edit" : "编辑"}" aria-label="${english ? "Edit" : "编辑"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm13.5-16.5 3 3-1.7 1.7-3-3 1.7-1.7Z"/></svg></button><button data-action="delete" title="${english ? "Delete" : "删除"}" aria-label="${english ? "Delete" : "删除"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l1 2h4v2H3V6h4l1-2Zm1 6h2v7H9v-7Zm4 0h2v7h-2v-7Zm-6 0h2v9h6v-9h2v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V10Z"/></svg></button></span>
      </article>`).join("")}</div></section>`;
    }).join("")
    : `<div class="no-sessions"><p>${query ? (english ? "No matching sessions" : "没有匹配的会话") : (english ? "No saved sessions. Create a group or a session to get started." : "还没有保存的会话，可先新建分组或会话")}</p></div>`;
  renderRecentSessions();
  refreshNotifyBadge();
}

function sessionGroupNames() {
  const stored = Array.isArray(state.preferences.sessionGroups) ? state.preferences.sessionGroups : [];
  const fromSessions = state.sessions.map((session) => (session.group || "").trim()).filter(Boolean);
  return [...new Set([DEFAULT_GROUP, ...stored, ...fromSessions])];
}

function fillGroupOptions(selected = DEFAULT_GROUP) {
  const groupEl = el("group");
  if (!groupEl) return;
  const current = (selected || groupEl.value || DEFAULT_GROUP).trim() || DEFAULT_GROUP;
  const names = sessionGroupNames();
  const all = names.includes(current) ? names : [...names, current];
  groupEl.innerHTML = all.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  groupEl.value = current;
}

function rememberSessionGroup(name) {
  const group = (name || "").trim() || DEFAULT_GROUP;
  const list = sessionGroupNames();
  if (!list.includes(group)) {
    state.preferences.sessionGroups = [...list, group];
    savePreferences();
  }
  return group;
}

function toggleSessionGroup(group) {
  const collapsed = new Set(state.preferences.collapsedGroups || []);
  if (collapsed.has(group)) collapsed.delete(group);
  else collapsed.add(group);
  state.preferences.collapsedGroups = [...collapsed];
  savePreferences();
  renderSessions();
}

async function createSessionGroup(preset = "") {
  const name = await appPrompt({ title: tr("新建分组", "New group"), message: tr("输入分组名称", "Enter a group name"), value: preset });
  if (!name?.trim()) return "";
  const group = rememberSessionGroup(name);
  renderSessions();
  return group;
}

async function renameSessionGroup(from) {
  const next = await appPrompt({ title: tr("重命名分组", "Rename group"), message: tr("输入新的分组名称", "Enter the new group name"), value: from });
  if (!next?.trim() || next.trim() === from) return;
  const name = next.trim();
  if (sessionGroupNames().includes(name)) return toast(tr("分组已存在", "That group already exists"), "error");
  state.sessions.forEach((session) => {
    if ((session.group || DEFAULT_GROUP) === from) session.group = name;
  });
  persistSessions();
  state.preferences.sessionGroups = sessionGroupNames().map((group) => (group === from ? name : group));
  state.preferences.collapsedGroups = (state.preferences.collapsedGroups || []).map((group) => (group === from ? name : group));
  savePreferences();
  renderSessions();
}

async function deleteSessionGroup(name) {
  if (name === DEFAULT_GROUP) return toast(tr("默认分组不能删除", "The default group cannot be deleted"));
  const count = state.sessions.filter((session) => (session.group || DEFAULT_GROUP) === name).length;
  const accepted = await appPrompt({
    title: tr("删除分组", "Delete group"),
    message: count
      ? tr(`分组内 ${count} 个会话将移到默认分组。`, `${count} sessions will move to the default group.`)
      : tr("确定删除这个空分组？", "Delete this empty group?"),
    input: false,
    confirmText: tr("删除", "Delete"),
  });
  if (!accepted) return;
  state.sessions.forEach((session) => {
    if ((session.group || DEFAULT_GROUP) === name) session.group = DEFAULT_GROUP;
  });
  persistSessions();
  state.preferences.sessionGroups = sessionGroupNames().filter((group) => group !== name);
  state.preferences.collapsedGroups = (state.preferences.collapsedGroups || []).filter((group) => group !== name);
  savePreferences();
  renderSessions();
}

async function moveSessionToGroup(session) {
  if (!session) return;
  const names = sessionGroupNames();
  const current = session.group || DEFAULT_GROUP;
  const picked = await appPrompt({
    title: tr("移动到分组", "Move to group"),
    message: tr("请选择目标分组。", "Select the target group."),
    value: current,
    input: false,
    options: names,
    confirmText: tr("移动", "Move"),
  });
  if (!picked || picked === current) return;
  session.group = picked;
  persistSessions();
  renderSessions();
  void names;
}

async function openSessionModal(session = null, mode = "edit") {
  const english = state.preferences.language === "en-US";
  state.editingId = session?.id || null;
  state.sessionModalMode = mode;
  el("dialogTitle").textContent = session
    ? mode === "connect" ? `${english ? "Connect to" : "连接"} ${session.name}` : tr("编辑 SSH 会话", "Edit SSH Session")
    : mode === "quick" ? tr("快速连接", "Quick Connect") : tr("新建 SSH 会话", "New SSH Session");
  el("connectButton").textContent = ["connect", "quick"].includes(mode) ? tr("连接", "Connect") : tr("保存并连接", "Save and Connect");
  el("name").value = session?.name || "";
  el("host").value = session?.host || "";
  el("port").value = session?.port || 22;
  el("username").value = session?.username || "";
  fillGroupOptions(session?.group || state.pendingSessionGroup || DEFAULT_GROUP);
  el("group").value = session?.group || state.pendingSessionGroup || DEFAULT_GROUP;
  el("group").disabled = false;
  state.pendingSessionGroup = "";
  el("authType").value = session?.authType || "password";
  el("privateKey").value = session?.privateKey || "";
  el("terminalType").value = session?.terminalType || "xterm-256color";
  el("shellCommand").value = session?.shellCommand || "";
  el("timeout").value = session?.timeout || state.preferences.defaultTimeout;
  el("syncSftpPath").checked = session?.syncSftpPath !== false;
  el("password").value = "";
  el("rememberPassword").checked = Boolean(session?.rememberPassword);
  el("passphrase").value = "";
  el("saveSession").checked = mode !== "quick";
  el("rememberPassword").disabled = mode === "quick";
  setSessionFormTab("basic");
  updateAuthFields();
  el("sessionModal").classList.remove("hidden");
  if (session?.rememberPassword && session.authType === "password") {
    try { el("password").value = await invoke("credential_get", { sessionId: session.id }) || ""; }
    catch (error) { toast(String(error), "error"); }
  }
  const focusId = !session ? "name" : session.authType === "password" ? "password" : "connectButton";
  setTimeout(() => el(focusId).focus(), 50);
}

function setSessionFormTab(tab) {
  document.querySelectorAll("[data-session-tab]").forEach((button) => button.classList.toggle("active", button.dataset.sessionTab === tab));
  document.querySelectorAll("[data-session-page]").forEach((page) => page.classList.toggle("hidden", page.dataset.sessionPage !== tab));
}

function closeSessionModal() {
  el("sessionModal").classList.add("hidden");
  state.reconnectingTerminalId = null;
}

async function openLocalSshModal() {
  const cwd = await open({ directory: true, multiple: false, title: tr("选择本地 PowerShell 启动目录", "Choose the PowerShell working folder") });
  if (!cwd) return;
  const session = {
    id: crypto.randomUUID(),
    name: "本地 PowerShell",
    host: "本机",
    port: 0,
    username: "",
    group: "",
    authType: "local",
    privateKey: "",
    terminalType: "xterm-256color",
    shellCommand: "",
    timeout: 0,
    rememberPassword: false,
    syncSftpPath: false,
    fingerprint: "",
    local: true,
    cwd,
  };
  await connectLocalTerminal(session);
}

function updateAuthFields() {
  const authType = el("authType").value;
  el("passwordFields").classList.toggle("hidden", authType !== "password");
  el("keyFields").classList.toggle("hidden", authType !== "publickey");
  if (authType === "password") document.querySelector('[data-session-tab="basic"]').disabled = false;
}

function updateThemePicker() {
  document.querySelectorAll("[data-app-theme-choice]").forEach((button) => {
    const selected = button.dataset.appThemeChoice === el("appThemeSetting").value;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function terminalSchemeCards() {
  return [...(el("terminalSchemePicker")?.querySelectorAll("[data-terminal-scheme]") || [])];
}

function applyTerminalSchemeChoice(id) {
  const setting = el("terminalSchemeSetting");
  if (!setting || setting.value === id) {
    updateTerminalSchemePicker();
    return;
  }
  setting.value = id;
  applySettingsFromControls();
  updateTerminalSchemePicker();
}

function focusTerminalSchemeCard(button) {
  const picker = el("terminalSchemePicker");
  if (!picker || !button) return;
  terminalSchemeCards().forEach((card) => { card.tabIndex = -1; });
  button.tabIndex = 0;
  picker.setAttribute("aria-activedescendant", button.id);
}

function updateTerminalSchemePicker() {
  const picker = el("terminalSchemePicker");
  const setting = el("terminalSchemeSetting");
  if (!picker || !setting) return;
  const selectedId = setting.value || state.preferences.terminalScheme || DEFAULT_TERMINAL_SCHEME_ID;
  const language = state.preferences.language || "zh-CN";
  const toneLabel = (tone) => (language === "en-US" ? (tone === "light" ? "Light" : "Dark") : (tone === "light" ? "浅色" : "深色"));
  const groupLabel = (group) => {
    if (group === "software") return language === "en-US" ? "Terminal theme" : "终端主题";
    return language === "en-US" ? "More colors" : "更多配色";
  };
  if (picker.dataset.ready !== "tone-2") {
    picker.dataset.ready = "";
    picker.innerHTML = "";
  }
  if (!picker.dataset.ready) {
    const groups = [
      ["software", listTerminalSchemes().filter((scheme) => scheme.software)],
      ["extra", listTerminalSchemes().filter((scheme) => !scheme.software)],
    ];
    picker.innerHTML = groups.map(([tone, schemes]) => `
      <div class="scheme-group" data-scheme-tone="${tone}">
        <small></small>
        <div class="scheme-grid">${schemes.map((scheme) => {
          const swatches = schemePreviewColors(scheme).map((color) => `<i style="background:${color}"></i>`).join("");
          const sample = schemeSample(scheme);
          return `<button type="button" class="scheme-card${scheme.software ? " scheme-card-primary" : ""}" role="option" id="term-scheme-${scheme.id}" data-terminal-scheme="${scheme.id}" aria-selected="false" tabindex="-1">
            <span class="scheme-preview" style="background:${sample.background};color:${sample.foreground}">
              <span class="scheme-swatches">${swatches}</span>
              <code><span style="color:${sample.user}">user</span><span style="color:${sample.dim}">@</span><span style="color:${sample.host}">host</span> <span style="color:${sample.path}">~</span> <span style="color:${sample.dim}">$</span> ls</code>
            </span>
            <span class="scheme-meta"><strong></strong>${scheme.software ? "" : "<em></em>"}</span>
          </button>`;
        }).join("")}</div>
      </div>`).join("");
    picker.addEventListener("click", (event) => {
      const button = event.target.closest("[data-terminal-scheme]");
      if (!button) return;
      applyTerminalSchemeChoice(button.dataset.terminalScheme);
    });
    picker.addEventListener("keydown", (event) => {
      const cards = terminalSchemeCards();
      if (!cards.length) return;
      const current = event.target.closest("[data-terminal-scheme]") || cards.find((card) => card.classList.contains("selected")) || cards[0];
      const index = Math.max(0, cards.indexOf(current));
      const columns = 2;
      let next = null;
      if (event.key === "ArrowRight") next = cards[Math.min(cards.length - 1, index + 1)];
      else if (event.key === "ArrowLeft") next = cards[Math.max(0, index - 1)];
      else if (event.key === "ArrowDown") next = cards[Math.min(cards.length - 1, index + columns)];
      else if (event.key === "ArrowUp") next = cards[Math.max(0, index - columns)];
      else if (event.key === "Home") next = cards[0];
      else if (event.key === "End") next = cards[cards.length - 1];
      else if (event.key === "Enter" || event.key === " ") next = current;
      if (!next) return;
      event.preventDefault();
      focusTerminalSchemeCard(next);
      applyTerminalSchemeChoice(next.dataset.terminalScheme);
      next.focus();
    });
    picker.dataset.ready = "tone-2";
  }
  picker.querySelectorAll("[data-scheme-tone] > small").forEach((label) => {
    label.textContent = groupLabel(label.parentElement.dataset.schemeTone);
  });
  terminalSchemeCards().forEach((button) => {
    const scheme = getTerminalScheme(button.dataset.terminalScheme);
    const selected = button.dataset.terminalScheme === selectedId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const name = button.querySelector("strong");
    const badge = button.querySelector("em");
    if (name) name.textContent = schemeDisplayName(scheme, language);
    if (badge) badge.textContent = toneLabel(scheme.tone);
    if (selected) picker.setAttribute("aria-activedescendant", button.id);
  });
}

function openSettingsModal() {
  el("confirmCloseSessionsSetting").checked = state.preferences.confirmCloseSessions;
  el("restoreWindowSetting").checked = state.preferences.restoreWindow;
  el("restoreTabsSetting").checked = state.preferences.restoreTabs;
  el("defaultDrawerSetting").value = state.preferences.defaultDrawer;
  el("appThemeSetting").value = state.preferences.appTheme || "system";
  updateThemePicker();
  el("languageSetting").value = state.preferences.language || "zh-CN";
  el("terminalSchemeSetting").value = state.preferences.terminalScheme;
  updateTerminalSchemePicker();
  el("fontSizeSetting").value = state.preferences.fontSize;
  el("fontFamilySetting").value = state.preferences.fontFamily;
  el("lineHeightSetting").value = state.preferences.lineHeight;
  el("letterSpacingSetting").value = state.preferences.letterSpacing;
  el("cursorStyleSetting").value = state.preferences.cursorStyle;
  el("cursorBlinkSetting").checked = state.preferences.cursorBlink;
  el("copyOnSelectSetting").checked = state.preferences.copyOnSelect;
  el("rightClickActionSetting").value = state.preferences.rightClickAction;
  el("bellStyleSetting").value = state.preferences.bellStyle;
  el("scrollbackSetting").value = state.preferences.scrollback;
  el("confirmPasteSetting").checked = state.preferences.confirmMultiLinePaste;
  el("uploadWorkersSetting").value = state.preferences.uploadWorkers;
  el("downloadWorkersSetting").value = state.preferences.downloadWorkers;
  el("tailMaxLinesSetting").value = state.preferences.tailMaxLines;
  el("tailAllLimitSetting").value = state.preferences.tailAllLimitMb;
  el("fileChunkSizeSetting").value = state.preferences.fileChunkSizeMb;
  el("fileEditLimitSetting").value = state.preferences.fileEditLimitMb;
  el("sftpPageSizeSetting").value = state.preferences.sftpPageSize;
  el("sftpFilterDebounceSetting").value = state.preferences.sftpFilterDebounceMs;
  el("defaultTimeoutSetting").value = state.preferences.defaultTimeout;
  el("keepaliveSetting").value = state.preferences.keepaliveSeconds;
  el("autoReconnectAttemptsSetting").value = state.preferences.autoReconnectAttempts;
  el("autoReconnectDelaySetting").value = state.preferences.autoReconnectDelaySeconds;
  el("previewWrapSetting").checked = state.preferences.previewWrap;
  el("previewLineNumbersSetting").checked = state.preferences.previewLineNumbers;
  el("previewFontSizeSetting").value = state.preferences.previewFontSize;
  el("defaultDownloadDirectorySetting").value = state.preferences.defaultDownloadDirectory;
  el("confirmOverwriteSetting").checked = state.preferences.confirmOverwrite;
  el("showHiddenFilesSetting").checked = state.preferences.showHiddenFiles;
  el("persistRemotePathSetting").checked = state.preferences.persistRemotePath;
  el("defaultLogDirectorySetting").value = state.preferences.defaultLogDirectory;
  el("autoSessionLogSetting").checked = state.preferences.autoSessionLog;
  el("logFileTemplateSetting").value = state.preferences.logFileTemplate;
  el("tailDefaultLinesSetting").value = state.preferences.tailDefaultLines;
  el("tailRefreshSetting").value = state.preferences.tailRefreshMs;
  setSettingsPage("general");
  el("settingsSearch").value = "";
  settingsSearchOrigin = "";
  el("settingsModal").querySelector(".settings-content").scrollTop = 0;
  el("settingsModal").classList.remove("hidden");
  requestAnimationFrame(() => el("settingsSearch").focus());
}

function setSettingsPage(page) {
  document.querySelectorAll("[data-settings-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsPage === page);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.settingsPanel === page);
  });
}

function applyInterfaceLanguage() {
  const english = state.preferences.language === "en-US";
  renderSessions();
  const text = (selector, zh, en) => { const node = document.querySelector(selector); if (node) node.textContent = english ? en : zh; };
  const title = (selector, zh, en) => { const node = document.querySelector(selector); if (node) { node.title = english ? en : zh; node.setAttribute("aria-label", english ? en : zh); } };
  const menuLabels = [
    ["文件", "File"], ["编辑", "Edit"], ["查看", "View"], ["终端", "Terminal"], ["工具", "Tools"], ["设置", "Settings"], ["帮助", "Help"],
  ];
  document.querySelectorAll(".menu-trigger").forEach((node, index) => { if (menuLabels[index]) node.textContent = english ? menuLabels[index][1] : menuLabels[index][0]; });
  document.querySelector(".menubar")?.setAttribute("aria-label", english ? "Application menu" : "应用菜单");
  const actions = {
    "new-session": ["新建 SSH 会话", "New SSH Session"], "quick-connect": ["快速连接", "Quick Connect"], "local-ssh": ["新建本地 PowerShell", "New Local PowerShell"], "import-sessions": ["导入会话配置", "Import Sessions"], "export-sessions": ["导出会话配置", "Export Sessions"], exit: ["退出 Orbiterm", "Exit Orbiterm"],
    copy: ["复制", "Copy"], paste: ["粘贴", "Paste"], "select-all": ["全选终端内容", "Select All"], find: ["查找终端内容", "Find"], "toggle-sidebar": ["会话管理器", "Session Manager"], "toggle-sftp": ["SFTP 文件管理器", "SFTP File Manager"], "toggle-tail": ["Tail 日志查看", "Tail Log Viewer"], "toggle-manual": ["Linux 命令手册面板", "Linux Command Panel"], fullscreen: ["全屏", "Full Screen"], reconnect: ["重新连接", "Reconnect"], disconnect: ["断开当前连接", "Disconnect"], "duplicate-terminal": ["复制当前标签", "Duplicate Current Tab"], "previous-terminal": ["上一个标签", "Previous Tab"], "next-terminal": ["下一个标签", "Next Tab"], "reset-terminal": ["重置终端", "Reset Terminal"], clear: ["清除屏幕", "Clear Screen"], "toggle-log": ["开始/停止命令记录", "Start/Stop Logging"], "close-terminal": ["关闭当前标签", "Close Current Tab"], "transfer-tasks": ["传输任务", "Transfer Tasks"], upload: ["上传文件到当前目录", "Upload to Current Folder"], settings: ["应用设置", "Application Settings"], guide: ["使用说明", "User Guide"], "command-manual": ["Linux 命令手册", "Linux Command Manual"], shortcuts: ["快捷键说明", "Keyboard Shortcuts"], about: ["关于 Orbiterm", "About Orbiterm"],
  };
  document.querySelectorAll("[data-menu-action]").forEach((button) => { const label = actions[button.dataset.menuAction]; const span = button.querySelector("span"); if (!label || !span) return; const icon = span.querySelector("b")?.outerHTML || ""; span.innerHTML = `${icon}${english ? label[1] : label[0]}`; });
  text('[data-settings-page="general"]', "通用", "General");
  text('[data-settings-page="appearance"]', "界面", "Appearance");
  text('[data-settings-page="terminal"]', "终端", "Terminal");
  text('[data-settings-page="connection"]', "连接", "Connection");
  text('[data-settings-page="files"]', "文件与预览", "Files & Preview");
  text('[data-settings-page="logging"]', "日志", "Logging");
  text('[data-settings-page="performance"]', "性能与容量", "Performance & Capacity");
  text(".panel-title > span", "会话管理器", "Session Manager");
  title("#addSession", "新建 SSH 会话", "New SSH session");
  title("#collapseSidebar", "折叠会话管理器", "Collapse session manager");
  title("#expandSidebar", "展开会话管理器", "Expand session manager");
  title("#openSftpTool", "SFTP 文件管理器", "SFTP File Manager");
  title("#openTailTool", "Tail 日志查看", "Tail Log Viewer");
  title("#addGroup", "新建分组", "New group");
  title("#openManualTool", "Linux 命令手册", "Linux Command Manual");
  text(".server-monitor strong", "服务器监控", "Server Monitor");
  const monitorLabels = [["负载", "Load"], ["内存", "Memory"], ["磁盘", "Disk"], ["进程", "Processes"]];
  document.querySelectorAll(".server-monitor dt").forEach((node, index) => { if (monitorLabels[index]) node.textContent = english ? monitorLabels[index][1] : monitorLabels[index][0]; });
  text(".empty-state h2", "连接到远程主机", "Connect to a Remote Host");
  text(".empty-state p", "从左侧会话库打开，或新建一个 SSH 会话", "Open a saved session from the library, or create a new SSH session");
  text("#emptyNew", "新建会话", "New Session");
  text("#settingsWindowTitle", "设置", "Settings");
  text("#settingsTitle", "通用", "General");
  text("#appearancePageTitle", "界面", "Appearance"); text("#terminalSettingsTitle", "终端", "Terminal");
  text("#terminalSchemeGroupTitle", "配色", "Colors"); text("#terminalDisplayGroupTitle", "显示与行为", "Display & behavior");
  text("#appThemeLabel", "软件主题", "Application theme"); text("#languageSettingLabel", "界面语言", "Language");
  text("#terminalThemeLabel", "终端配色", "Terminal colors"); text("#fontSizeLabel", "字体大小", "Font size");
  text("#cursorStyleLabel", "光标样式", "Cursor style"); text("#cursorBlinkLabel span", "光标闪烁", "Blinking cursor"); text("#scrollbackLabel", "回滚缓冲行数", "Scrollback lines");
  text("#performanceSettingsTitle", "性能与容量", "Performance and capacity");
  text("#uploadWorkersLabel", "上传并发数", "Upload concurrency"); text("#downloadWorkersLabel", "下载并发数", "Download concurrency");
  text("#tailMaxLinesLabel", "Tail 最大保留行数", "Maximum retained Tail lines"); text("#tailAllLimitLabel", "Tail 全部内容上限", "Tail full-content limit");
  text("#fileChunkSizeLabel", "文件分块大小", "File chunk size"); text("#fileEditLimitLabel", "文件可编辑上限", "File editing limit");
  text("#sftpPageSizeLabel", "SFTP 每批显示项数", "SFTP items per batch"); text("#sftpFilterDebounceLabel", "SFTP 筛选延迟", "SFTP filter delay");
  text("#confirmPasteLabel span", "粘贴多行文本前确认", "Confirm before pasting multiple lines");
  text("#settingsNote", "设置会自动保存并立即生效；已开始的传输任务保持原并发数，新任务使用新参数。", "Changes are saved and applied automatically. Active transfers keep their current concurrency; new tasks use the new values.");
  text('[data-app-theme-choice="system"] strong', "跟随系统", "System");
  text('[data-app-theme-choice="light"] strong', "浅色", "Light");
  text('[data-app-theme-choice="dark"] strong', "深色", "Dark");
  title("#minimize", "最小化", "Minimize"); title("#maximize", "最大化", "Maximize"); title("#closeWindow", "关闭", "Close");
  document.querySelectorAll("[data-close-help-modal]").forEach((node) => node.setAttribute("aria-label", english ? "Close help" : "关闭帮助"));
  const translations = [
    ["新开会话", "Open new session"],
    ["通用", "General"], ["文件与预览", "Files & Preview"], ["日志", "Logging"], ["关闭软件前确认仍在连接的会话", "Confirm before closing connected sessions"], ["恢复上次窗口大小和位置", "Restore the previous window size and position"], ["启动时恢复上次打开的会话", "Restore previously open sessions at startup"], ["连接后默认打开", "Open after connecting"], ["不打开面板", "Do not open a panel"],
    ["终端字体", "Terminal font"], ["系统等宽字体", "System monospace font"], ["行高", "Line height"], ["字符间距", "Letter spacing"], ["选中文本后自动复制", "Copy selected text automatically"], ["终端右键行为", "Terminal right-click action"], ["打开右键菜单", "Open context menu"], ["直接粘贴", "Paste directly"], ["终端响铃", "Terminal bell"], ["声音", "Sound"], ["视觉提示", "Visual notification"],
    ["连接", "Connection"], ["新连接默认超时", "Default connection timeout"], ["SSH Keepalive 间隔", "SSH keepalive interval"], ["断线自动重连次数", "Automatic reconnect attempts"], ["0 表示关闭自动重连", "0 disables automatic reconnect"], ["自动重连间隔", "Automatic reconnect delay"], ["秒", "seconds"],
    ["文件预览默认自动换行", "Enable word wrap in file previews by default"], ["文件预览默认显示行号", "Show line numbers in file previews by default"], ["文件预览字体大小", "File preview font size"], ["默认下载目录", "Default download directory"], ["覆盖同名远程文件前确认", "Confirm before overwriting remote files"], ["显示以点开头的隐藏文件", "Show dot-prefixed hidden files"], ["记住每个会话最后访问的远程目录", "Remember the last remote folder for each session"],
    ["默认日志目录", "Default log directory"], ["SSH 连接成功后自动记录终端日志", "Start terminal logging after an SSH connection succeeds"], ["开始/停止当前会话日志", "Start/stop current session log"], ["导入会话", "Import sessions"], ["导出会话", "Export sessions"], ["使用说明", "User guide"], ["关于 Orbiterm", "About Orbiterm"], ["日志文件名模板", "Log filename template"], ["支持 {session}、{host}、{date}、{time}", "Supports {session}, {host}, {date}, and {time}"], ["Tail 默认行数", "Default Tail line count"], ["Tail 刷新间隔", "Tail refresh interval"],
    ["基本信息", "Basic"], ["认证", "Authentication"], ["终端", "Terminal"], ["连接名称", "Session name"], ["IP / 主机地址", "IP / Host"], ["端口", "Port"], ["用户名", "Username"], ["密码", "Password"], ["密码认证", "Password"], ["SSH 私钥", "SSH private key"], ["SSH Agent", "SSH Agent"], ["认证方式", "Authentication method"], ["会话分组", "Session group"], ["私钥文件", "Private key"], ["私钥口令（可选，不保存）", "Passphrase (optional, not saved)"], ["终端类型", "Terminal type"], ["连接超时（秒）", "Timeout (seconds)"], ["启动 Shell / 命令", "Startup shell / command"], ["保存此会话", "Save this session"], ["取消", "Cancel"], ["确定", "OK"], ["保存并连接", "Save and Connect"], ["浏览", "Browse"],
    ["首次连接会自动保存服务器主机指纹；以后指纹变化时会阻止连接。", "The server host key is saved automatically on first connection. A changed key will block future connections."], ["留空时读取远端账户的默认登录 Shell；仅在需要指定 Bash、Zsh 或启动 tmux 时填写。", "Leave empty to use the remote account's default login shell. Set this only to start Bash, Zsh, tmux, or another command."],
    ["远程文件", "Remote files"], ["未连接", "Disconnected"], ["上传", "Upload"], ["↑ 上传", "↑ Upload"], ["下载", "Download"], ["↓ 下载", "↓ Download"], ["新建", "New"], ["＋ 新建", "+ New"], ["新建文件", "New file"], ["新建文件夹", "New folder"], ["名称", "Name"], ["大小", "Size"], ["归属用户", "Owner"], ["修改时间", "Modified"], ["权限", "Permissions"], ["暂无传输任务", "No transfers"], ["取消传输", "Cancel transfer"], ["连接后可浏览远程文件", "Connect to browse remote files"], ["0 项", "0 items"],
    ["Tail 日志", "Tail Logs"], ["查看", "View"], ["暂停", "Pause"], ["尚未选择文件", "No file selected"], ["点击路径栏选择日志文件", "Click the path field to select a log file"], ["请输入绝对路径或从目录中选择文件", "Enter an absolute path or select a file from a folder"], ["-N 末尾", "-N From end"], ["+N 开头", "+N From start"], ["默认", "Default"], ["Linux 命令手册", "Linux Command Manual"], ["选择左侧命令查看用法", "Select a command to view details"], ["关闭", "Close"], ["行号", "Line numbers"], ["编辑", "Edit"], ["保存到远端", "Save remotely"], ["多行粘贴", "Multi-line paste"], ["合并换行为空格", "Join lines with spaces"], ["发送到终端", "Send to terminal"],
    ["复制", "Copy"], ["粘贴", "Paste"], ["全选", "Select all"], ["查找", "Find"], ["清屏", "Clear screen"], ["复制会话标签", "Duplicate session tab"], ["新连接", "New connection"], ["断开连接", "Disconnect"], ["重新连接", "Reconnect"], ["开始/停止命令记录", "Start/stop logging"], ["关闭标签", "Close tab"], ["移出分屏", "Remove from split"], ["在此分组新建会话", "New session in group"], ["重命名分组", "Rename group"], ["删除分组", "Delete group"], ["连接", "Connect"], ["移动到分组…", "Move to group…"], ["打开", "Open"], ["重命名", "Rename"], ["修改权限", "Change permissions"], ["属性", "Properties"], ["删除", "Delete"],
    ["远程文件内容", "Remote file content"], ["远程文件", "Remote file"], ["0 字符", "0 characters"], ["查找内容", "Find content"], ["正在读取远程文件…", "Reading remote file…"],
    ["使用 Windows 凭据管理器记住密码", "Remember password in Windows Credential Manager"], ["终端切换目录时同步 SFTP 路径", "Sync SFTP path with terminal directory"], ["浅色", "Light"], ["深色", "Dark"], ["简体中文", "简体中文"], ["浅色终端", "Light terminal"], ["深色终端", "Dark terminal"], ["方块", "Block"], ["竖线", "Bar"], ["下划线", "Underline"],
    ["默认 3，单方向最多 4 个连接", "Default: 3; up to 4 connections per direction"], ["默认 4，单方向最多 4 个连接", "Default: 4; up to 4 connections per direction"], ["默认 200,000 行", "Default: 200,000 lines"], ["默认 64 MB", "Default: 64 MB"], ["默认每次读取 4 MB", "Default: 4 MB per read"], ["默认 32 MB", "Default: 32 MB"], ["默认 500 项", "Default: 500 items"], ["默认 120 ms，0 表示无延迟", "Default: 120 ms; 0 disables the delay"], ["默认 10,000 行，数值越大占用内存越多", "Default: 10,000 lines; larger values use more memory"],
  ];
  const sourceIndex = english ? 0 : 1;
  const targetIndex = english ? 1 : 0;
  const translationMap = new Map(translations.map((pair) => [pair[sourceIndex], pair[targetIndex]]));
  const walker = document.createTreeWalker(document.querySelector("#app"), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue.trim();
    if (translationMap.has(value)) node.nodeValue = node.nodeValue.replace(value, translationMap.get(value));
  }
  const placeholders = {
    sessionSearch: ["搜索会话", "Search sessions"], remoteFilter: ["筛选当前目录", "Filter current folder"], findInput: ["在当前终端中查找", "Find in terminal"], tailPath: ["输入目录或日志文件绝对路径", "Enter an absolute folder or log path"], tailSearch: ["搜索日志", "Search logs"], commandSearch: ["搜索命令、分类或用途", "Search commands, categories or descriptions"], defaultDownloadDirectorySetting: ["留空时每次询问", "Leave empty to ask every time"], defaultLogDirectorySetting: ["留空时每次询问", "Leave empty to ask every time"], logFileTemplateSetting: ["{session}_{date}.log", "{session}_{date}.log"],
    name: ["例如：生产服务器", "For example: Production server"], host: ["服务器 IP 或域名", "Server IP address or hostname"], password: ["输入 SSH 登录密码", "Enter the SSH login password"], privateKey: ["选择 OpenSSH 私钥", "Select an OpenSSH private key"], group: ["默认分组", "Default group"], shellCommand: ["留空使用服务器默认 Shell，例如 /bin/bash -l", "Leave empty to use the server default shell, for example /bin/bash -l"], tailLines: ["默认", "Default"], editorFindInput: ["查找内容", "Find in file"], settingsSearch: ["搜索设置", "Search settings"],
  };
  Object.entries(placeholders).forEach(([id, pair]) => { if (el(id)) el(id).placeholder = english ? pair[1] : pair[0]; });
  if (!state.activeTransferIds.size) el("transferStatus").textContent = english ? "Transfer: idle" : "传输：空闲";
  if (!el("manualPanel").classList.contains("hidden")) void renderCommandManual("drawer");
  updateActiveStatus();
  updateTerminalSchemePicker();
}

function closeSettingsModal() {
  el("settingsModal").classList.add("hidden");
}

function showFindBar() {
  const record = activeTerminal();
  if (!record) return toast(tr("请先打开一个终端会话", "Please open a terminal session first"));
  el("findBar").classList.remove("hidden");
  el("findInput").focus();
  el("findInput").select();
}

function closeFindBar() {
  el("findBar").classList.add("hidden");
  activeTerminal()?.terminal.focus();
}

function terminalSearchDecorations() {
  const theme = currentXtermTheme();
  return {
    decorations: {
      matchBackground: theme.brightBlack,
      matchOverviewRuler: theme.yellow,
      activeMatchBackground: theme.yellow,
      activeMatchColorOverviewRuler: theme.cursor,
    },
  };
}

function findInTerminal(previous = false) {
  const record = activeTerminal();
  const query = el("findInput").value;
  if (!record || !query) return;
  const options = terminalSearchDecorations();
  const found = previous ? record.search.findPrevious(query, options) : record.search.findNext(query, options);
  if (!found) toast(tr("没有更多匹配项", "No more matches"));
}

function formSession() {
  const original = state.sessions.find((item) => item.id === state.editingId);
  const host = el("host").value.trim();
  const port = Number(el("port").value);
  return {
    id: state.editingId || crypto.randomUUID(),
    name: el("name").value.trim(),
    host,
    port,
    username: el("username").value.trim(),
    group: rememberSessionGroup(el("group").value),
    authType: el("authType").value,
    privateKey: el("privateKey").value.trim(),
    terminalType: el("terminalType").value,
    shellCommand: el("shellCommand").value.trim(),
    timeout: Number(el("timeout").value) || state.preferences.defaultTimeout,
    rememberPassword: el("rememberPassword").checked,
    syncSftpPath: el("syncSftpPath").checked,
    fingerprint: original && original.host === host && original.port === port ? original.fingerprint || "" : "",
  };
}

async function submitSession(event) {
  event.preventDefault();
  const session = formSession();
  const secret = session.authType === "password" ? el("password").value : session.authType === "publickey" ? el("passphrase").value : "";
  if (session.authType === "password" && !secret) return toast("请输入登录密码", "error");
  if (session.authType === "publickey" && !session.privateKey) return toast("请选择私钥文件", "error");

  const button = el("connectButton");
  const idleButtonText = ["connect", "quick"].includes(state.sessionModalMode) ? tr("连接", "Connect") : tr("保存并连接", "Save and Connect");
  button.disabled = true;
  button.textContent = tr("正在验证主机…", "Verifying host…");
  try {
    if (!session.fingerprint) {
      const probe = await invoke("probe_host", { request: { host: session.host, port: session.port, timeoutSeconds: session.timeout } });
      session.fingerprint = probe.fingerprint;
    }
    session.rememberPassword = session.rememberPassword && el("saveSession").checked;
    if (el("saveSession").checked) {
      const index = state.sessions.findIndex((item) => item.id === session.id);
      if (index >= 0) state.sessions[index] = session;
      else state.sessions.push(session);
      persistSessions();
      renderSessions();
    }
    const reconnectingId = state.reconnectingTerminalId;
    state.reconnectingTerminalId = null;
    closeSessionModal();
    const connectedRecord = await connectSession(session, secret);
    if (connectedRecord) {
      if (session.authType === "password" && session.rememberPassword) await invoke("credential_set", { sessionId: session.id, password: secret });
      else await invoke("credential_delete", { sessionId: session.id }).catch(() => {});
    }
    if (connectedRecord && reconnectingId && reconnectingId !== connectedRecord.id) {
      await closeTerminal(reconnectingId);
    }
  } catch (error) {
    toast(String(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = idleButtonText;
  }
}

function createTerminalView(session) {
  const id = crypto.randomUUID();
  const host = document.createElement("div");
  host.className = "terminal-host active";
  host.style.background = currentXtermTheme().background;
  host.dataset.terminalId = id;
  host.innerHTML = `<div class="split-pane-bar"><span class="dot"></span><b></b><button type="button" data-unsplit="${id}" title="${tr("移出分屏", "Remove from split")}">×</button></div><div class="split-term"></div>`;
  applyTerminalSchemeCss(host);
  el("terminalStack").append(host);

  const terminal = new Terminal({
    ...terminalChromeOptions(),
    scrollback: state.preferences.scrollback,
    bellStyle: state.preferences.bellStyle === "sound" ? "sound" : "none",
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(host.querySelector(".split-term"));
  fit.fit();
  const fitObserver = new ResizeObserver(() => {
    if (host.classList.contains("active") || host.classList.contains("split-visible")) requestAnimationFrame(() => fit.fit());
  });
  fitObserver.observe(host);
  document.fonts?.ready.then(() => {
    if (!host.isConnected) return;
    const rec = state.terminals.get(id);
    if (rec) applyTerminalChrome(rec);
    requestAnimationFrame(() => fit.fit());
  });
  terminal.writeln(session.local ? "正在启动本地 PowerShell…" : `Connecting to ${session.host}:${session.port}...`);

  const initialRemotePath = state.preferences.persistRemotePath ? state.preferences.remotePathsBySession[session.id] || "/" : "/";
  const record = { id, session, terminal, fit, fitObserver, search, host, connected: false, stopped: false, manualDisconnect: false, reconnectAttempts: 0, reconnectTimer: null, logging: false, logPath: "", latency: null, writeChain: Promise.resolve(), resizeTimer: null, inputTimer: null, inputQueue: [], inputBytes: 0, emptyReadCount: 0, cwdSyncTimer: null, bootstrapPending: false, bootstrapInstalling: false, bootstrapInstalled: false, bootstrapWanted: false, bootstrapBuffer: new Uint8Array(), bootstrapTimer: null, bootstrapFallbackTimer: null, textDecoder: new TextDecoder(), altScreen: false, sftpHistory: [initialRemotePath], sftpHistoryIndex: 0, sftpRequestId: 0, tailFile: "", tailOffset: 0, tailInitialized: false, tailLines: [], tailLineBase: 0, tailPaused: false, tailMode: "last", tailCount: state.preferences.tailDefaultLines, tailFollow: true };
  state.terminals.set(id, record);
  state.remotePaths.set(id, initialRemotePath);
  state.remoteUiByTerminal.set(id, {
    path: initialRemotePath,
    entries: [],
    selected: null,
    selectedPaths: new Set(),
    selectionAnchor: null,
    filter: "",
    sort: { key: "name", direction: "asc" },
    renderLimit: state.preferences.sftpPageSize,
  });
  terminal.onSelectionChange(() => {
    if (!state.preferences.copyOnSelect || !terminal.hasSelection()) return;
    navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
  });
  terminal.onBell(() => {
    if (state.preferences.bellStyle !== "visual") return;
    host.classList.remove("terminal-bell");
    requestAnimationFrame(() => host.classList.add("terminal-bell"));
    setTimeout(() => host.classList.remove("terminal-bell"), 240);
  });
  terminal.parser.registerOscHandler(7, (data) => {
    if (!record.session.syncSftpPath) return true;
    try {
      const url = new URL(data);
      if (url.protocol !== "file:") return true;
      const path = normalizeRemotePath(decodeURIComponent(url.pathname));
      state.remotePaths.set(id, path);
      const remoteUi = remoteUiFor(id);
      if (remoteUi) remoteUi.path = path;
      if (state.preferences.persistRemotePath) {
        state.preferences.remotePathsBySession[record.session.id] = path;
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
      }
      if (state.activeId === id) {
        state.remotePath = path;
        el("remotePath").value = path;
        clearTimeout(record.cwdSyncTimer);
        record.cwdSyncTimer = setTimeout(() => {
          if (record.connected && state.activeId === id && !el("sftpPanel").classList.contains("hidden")) refreshRemote(path);
        }, 250);
      }
    } catch {
      // Ignore malformed OSC 7 messages from remote applications.
    }
    return true;
  });

  const flushInput = () => {
    clearTimeout(record.inputTimer);
    record.inputTimer = null;
    if (!record.connected || !record.inputQueue.length) return;
    const queued = record.inputQueue;
    const size = record.inputBytes;
    record.inputQueue = [];
    record.inputBytes = 0;
    const payload = new Uint8Array(size);
    let offset = 0;
    queued.forEach((chunk) => { payload.set(chunk, offset); offset += chunk.length; });
    record.writeChain = record.writeChain
      .catch(() => {})
      .then(() => invoke(record.session.local ? "local_terminal_write" : "ssh_write", { id, data: Array.from(payload) }))
      .catch((error) => {
        if (!String(error).includes("输入积压")) {
          record.connected = false;
          updateTerminalState(record, "error");
        }
        toast(String(error), "error");
      });
  };
  terminal.onData((data) => {
    if (record.connected) {
      const encoded = encoder.encode(data);
      for (let offset = 0; offset < encoded.length; offset += 32 * 1024) {
        const chunk = encoded.slice(offset, offset + 32 * 1024);
        record.inputQueue.push(chunk);
        record.inputBytes += chunk.length;
      }
      if (record.inputBytes >= 32 * 1024) flushInput();
      else if (!record.inputTimer) record.inputTimer = setTimeout(flushInput, 4);
    }
  });
  terminal.onResize(({ cols, rows }) => {
    clearTimeout(record.resizeTimer);
    record.resizeTimer = setTimeout(() => {
      if (record.connected) invoke(record.session.local ? "local_terminal_resize" : "ssh_resize", { id, cols, rows }).catch(() => {});
    }, 60);
    if (state.activeId === id) el("terminalSize").textContent = `${cols} × ${rows}`;
  });

  const tab = document.createElement("button");
  tab.className = "tab active";
  tab.dataset.terminalId = id;
  tab.innerHTML = `<i></i><span>${escapeHtml(session.name)}</span><small>${escapeHtml(session.host)}</small><b title="关闭">×</b>`;
  el("terminalTabs").append(tab);
  tab.addEventListener("click", (event) => event.target.tagName === "B" ? closeTerminal(id) : activateTerminal(id));
  activateTerminal(id);
  updateTerminalState(record, "connecting");
  return record;
}

function updateTerminalState(record, status) {
  record.status = status;
  const tab = document.querySelector(`.tab[data-terminal-id="${record.id}"]`);
  if (tab) tab.dataset.status = status;
  updateSplitBar(record);
  renderSessions();
  if (state.activeId === record.id) updateActiveStatus();
}

async function connectSession(session, secret) {
  const record = createTerminalView(session);
  record.connectionSecret = secret;
  try {
    const info = await invoke("ssh_connect", { request: {
      id: record.id, host: session.host, port: session.port, username: session.username,
      authType: session.authType, password: session.authType === "password" ? secret : null,
      privateKey: session.privateKey || null, passphrase: session.authType === "publickey" ? secret : null,
      expectedFingerprint: session.fingerprint, terminalType: session.terminalType,
      shellCommand: session.shellCommand || null,
      cols: record.terminal.cols, rows: record.terminal.rows, timeoutSeconds: session.timeout,
      keepaliveSeconds: state.preferences.keepaliveSeconds,
    } });
    record.connected = true;
    record.stopped = false;
    record.manualDisconnect = false;
    record.reconnectAttempts = 0;
    state.autoReconnectCounts.delete(session.id);
    record.latency = info.latencyMs;
    record.terminal.writeln(tr("\x1b[32m连接已建立。\x1b[0m", "\x1b[32mConnection established.\x1b[0m"));
    record.terminal.writeln("\x1b[90mTo disconnect the current session, press 'Ctrl+Alt+]'.\x1b[0m\r\n");
    if (!session.fingerprint && info.fingerprint) {
      session.fingerprint = info.fingerprint;
      const saved = state.sessions.find((item) => item.id === session.id);
      if (saved) {
        saved.fingerprint = info.fingerprint;
        persistSessions();
      }
    }
    updateTerminalState(record, "connected");
    rememberRecentSession(session);
    persistOpenSessionIds();
    record.bootstrapWanted = Boolean(session.syncSftpPath && !session.shellCommand);
    record.terminal.focus();
    updateActiveStatus();
    readLoop(record);
    if (record.bootstrapWanted) record.bootstrapFallbackTimer = setTimeout(() => installCwdIntegration(record), 1500);
    if (!el("sftpPanel").classList.contains("hidden")) refreshRemote();
    if (state.preferences.defaultDrawer === "sftp") toggleSftp(true);
    else if (state.preferences.defaultDrawer === "tail") openTailPanel();
    else if (state.preferences.defaultDrawer === "manual") openCommandManual();
    if (state.preferences.autoSessionLog && !record.session.local) {
      startSessionLog(record, false).then((started) => {
        if (!started) toast(tr("请先在设置中选择默认日志目录", "Choose a default log directory in Settings first"), "error");
      }).catch((error) => toast(String(error), "error"));
    }
    return record;
  } catch (error) {
    record.connected = false;
    updateTerminalState(record, "error");
    record.terminal.writeln(`\r\n\x1b[31m${tr("连接失败", "Connection failed")}：${localizeRuntimeText(error)}\x1b[0m`);
    toast(`连接 ${session.name} 失败`, "error");
    updateActiveStatus();
    scheduleAutoReconnect(record);
    return null;
  }
}

async function connectLocalTerminal(session) {
  const record = createTerminalView(session);
  try {
    const shell = await invoke("local_terminal_open", {
      id: record.id,
      cols: record.terminal.cols,
      rows: record.terminal.rows,
      cwd: record.session.cwd || null,
    });
    record.connected = true;
    record.latency = 0;
    record.terminal.clear();
    record.terminal.writeln(`${tr("本地终端", "Local terminal")} · ${shell}`);
    updateTerminalState(record, "connected");
    record.terminal.focus();
    updateActiveStatus();
    readLoop(record);
    return record;
  } catch (error) {
    record.connected = false;
    updateTerminalState(record, "error");
    record.terminal.writeln(`\r\n\x1b[31m${tr("启动本地终端失败", "Failed to start local terminal")}：${localizeRuntimeText(error)}\x1b[0m`);
    toast("启动本地 PowerShell 失败", "error");
    updateActiveStatus();
    return null;
  }
}

async function connectSavedSession(session) {
  if (!session) return;
  const existing = terminalForSession(session.id);
  if (existing) {
    activateTerminal(existing.id);
    return;
  }
  let secret = "";
  if (session.authType === "password") {
    if (session.rememberPassword) {
      try { secret = await invoke("credential_get", { sessionId: session.id }) || ""; }
      catch (error) { toast(String(error), "error"); }
    }
    if (!secret) return openSessionModal(session, "connect");
  }
  if (session.authType === "publickey") return openSessionModal(session, "connect");
  if (!session.fingerprint) {
    try {
      const probe = await invoke("probe_host", { request: { host: session.host, port: session.port, timeoutSeconds: session.timeout } });
      session.fingerprint = probe.fingerprint;
      persistSessions();
    } catch (error) {
      return toast(String(error), "error");
    }
  }
  await connectSession(session, secret);
}

async function restoreOpenSessions() {
  if (!state.preferences.restoreTabs || !state.preferences.lastOpenSessionIds.length) return;
  const sessions = state.preferences.lastOpenSessionIds.map((id) => state.sessions.find((session) => session.id === id)).filter(Boolean);
  let skipped = 0;
  for (const session of sessions) {
    let secret = "";
    if (session.authType === "password" && session.rememberPassword) {
      secret = await invoke("credential_get", { sessionId: session.id }).catch(() => "") || "";
    }
    if ((session.authType === "password" && !secret) || session.authType === "publickey") { skipped += 1; continue; }
    await connectSession(session, secret);
  }
  if (skipped) toast(tr(`${skipped} 个需要重新认证的会话未自动恢复`, `${skipped} session(s) requiring authentication were not restored`));
}

async function duplicateTerminal(id = state.activeId) {
  const record = state.terminals.get(id);
  if (!record) return;
  if (record.session.local) await connectLocalTerminal({ ...record.session, id: crypto.randomUUID() });
  else await connectSession(record.session, record.connectionSecret || "");
}

async function openAdditionalSavedSession(session) {
  const existing = openTerminals().find((record) => record.session.id === session.id && record.connected) || terminalForSession(session.id);
  if (!existing) return connectSavedSession(session);
  await duplicateTerminal(existing.id);
}


function activateAdjacentTerminal(direction) {
  const split = visibleSplitIds();
  const ids = split.length > 1 ? split : [...state.terminals.keys()];
  if (ids.length < 2) return;
  const index = Math.max(0, ids.indexOf(state.activeId));
  activateTerminal(ids[(index + direction + ids.length) % ids.length]);
}

function resetActiveTerminal() {
  const record = activeTerminal();
  if (!record) return;
  record.terminal.reset();
  requestAnimationFrame(() => { record.fit.fit(); record.terminal.focus(); });
}

async function readLoop(record) {
  if (record.stopped || !record.connected) return;
  try {
    const result = await invoke(record.session.local ? "local_terminal_read" : "ssh_read", { id: record.id });
    if (result.data.length) {
      let output = new Uint8Array(result.data);
      if (record.bootstrapPending) output = finishTerminalBootstrap(record, output);
      if (output.length) {
        const text = record.textDecoder.decode(output, { stream: true });
        record.terminal.write(colorizeClientOutput(record, text));
        if (record.bootstrapWanted && !record.bootstrapInstalling && !record.bootstrapInstalled) {
          if (/(?:^|\r?\n)[^\r\n]{0,160}[#$%>]\s*$/.test(text)) setTimeout(() => installCwdIntegration(record), 120);
        }
      }
    }
    if (result.logError) {
      record.logging = false;
      if (state.activeId === record.id) updateActiveStatus();
      toast(result.logError, "error");
    }
    if (result.eof) {
      record.connected = false;
      updateTerminalState(record, "disconnected");
      const exitText = result.exitStatus == null ? "" : `（退出码 ${result.exitStatus}）`;
      record.terminal.writeln(`\r\n\x1b[90m${record.session.local ? tr("本地终端已结束", "Local terminal ended") : tr("远程会话已结束", "Remote session ended")}${exitText}\x1b[0m`);
      scheduleAutoReconnect(record);
      return;
    }
    record.emptyReadCount = result.data.length ? 0 : Math.min(record.emptyReadCount + 1, 6);
    const idleDelay = state.activeId === record.id
      ? Math.min(150, 75 * 2 ** Math.min(Math.max(record.emptyReadCount - 1, 0), 1))
      : Math.min(1500, 500 * 2 ** Math.min(Math.max(record.emptyReadCount - 1, 0), 2));
    const delay = result.data.length || result.pendingInput ? 16 : idleDelay;
    setTimeout(() => readLoop(record), delay);
  } catch (error) {
    if (!record.stopped) {
      record.connected = false;
      updateTerminalState(record, "error");
      record.terminal.writeln(`\r\n\x1b[31m${tr("连接中断", "Connection interrupted")}：${localizeRuntimeText(error)}\x1b[0m`);
      updateActiveStatus();
      scheduleAutoReconnect(record);
    }
    return;
  }
}

function scheduleAutoReconnect(record) {
  if (record.session.local || record.manualDisconnect || record.stopped || state.closing || record.reconnectTimer) return;
  const maximum = state.preferences.autoReconnectAttempts;
  const attempt = (state.autoReconnectCounts.get(record.session.id) || 0) + 1;
  if (!maximum || attempt > maximum) {
    state.autoReconnectCounts.delete(record.session.id);
    return;
  }
  state.autoReconnectCounts.set(record.session.id, attempt);
  const delay = state.preferences.autoReconnectDelaySeconds;
  record.terminal.writeln(`\r\n\x1b[90m${tr(`${delay} 秒后自动重连（${attempt}/${maximum}）`, `Reconnecting in ${delay}s (${attempt}/${maximum})`)}\x1b[0m`);
  record.reconnectTimer = setTimeout(async () => {
    record.reconnectTimer = null;
    if (!state.terminals.has(record.id) || record.manualDisconnect || state.closing) return;
    const session = record.session;
    const secret = record.connectionSecret || "";
    await closeTerminal(record.id, true);
    await connectSession(session, secret);
  }, delay * 1000);
}

function remoteUiFor(terminalId = state.activeId) {
  return state.remoteUiByTerminal.get(terminalId) || null;
}

function syncActiveRemoteUi(record) {
  const ui = remoteUiFor(record.id);
  if (!ui) return;
  state.remotePath = ui.path;
  state.remoteEntries = ui.entries;
  state.selectedRemote = ui.selected;
  state.selectedRemotePaths = ui.selectedPaths;
  state.remoteSelectionAnchor = ui.selectionAnchor;
  state.remoteFilter = ui.filter;
  state.remoteSort = ui.sort;
  state.remoteRenderLimit = ui.renderLimit;
  el("remotePath").value = ui.path;
  el("remoteFilter").value = ui.filter;
  el("clearRemoteFilter").classList.toggle("hidden", !ui.filter);
}

function updateActiveRemoteUi(patch = {}) {
  const ui = remoteUiFor();
  if (!ui) return;
  Object.assign(ui, patch);
}

function visibleSplitIds() {
  const ids = (state.splitIds || []).filter((id) => state.terminals.has(id));
  if (ids.length) return ids;
  return state.activeId && state.terminals.has(state.activeId) ? [state.activeId] : [];
}

function updateSplitBar(record) {
  if (!record) return;
  const bar = record.host.querySelector(".split-pane-bar");
  if (!bar) return;
  bar.querySelector(".dot").className = `dot ${record.status === "connected" ? "on" : record.status === "connecting" || record.status === "error" ? "warn" : ""}`;
  bar.querySelector("b").textContent = record.session.name;
}

function fitVisibleTerminals() {
  const ids = visibleSplitIds();
  const run = () => {
    ids.forEach((id) => {
      try { state.terminals.get(id)?.fit.fit(); } catch { /* xterm may not be attached yet */ }
    });
  };
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });
  clearTimeout(fitVisibleTimer);
  fitVisibleTimer = setTimeout(run, 60);
}

function applySplitLayout() {
  const ids = visibleSplitIds();
  state.splitIds = ids;
  const count = ids.length || 1;
  const stack = el("terminalStack");
  if (stack) {
    stack.dataset.split = String(count);
    stack.classList.toggle("split-on", count > 1);
  }
  document.querySelectorAll(".terminal-host").forEach((host) => {
    const id = host.dataset.terminalId;
    const index = ids.indexOf(id);
    host.classList.toggle("split-visible", index >= 0);
    host.classList.toggle("active", id === state.activeId);
    if (index >= 0) host.dataset.splitIndex = String(index);
    else delete host.dataset.splitIndex;
    host.classList.toggle("split-span", count % 2 === 1 && index === count - 1);
    updateSplitBar(state.terminals.get(id));
  });
  document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node.dataset.terminalId === state.activeId));
  fitVisibleTerminals();
  requestAnimationFrame(() => activeTerminal()?.terminal.focus());
}

function splitDropZone() {
  return document.querySelector(".term-stage");
}

function setSplitDropTarget(on) {
  const zone = splitDropZone();
  if (!zone) return;
  zone.classList.toggle("drop-target", on);
  zone.dataset.dropHint = on ? tr("放到这里分屏", "Drop to split") : "";
}

function isOverTerminalPane(x, y) {
  const zone = splitDropZone();
  if (!zone) return false;
  const rect = zone.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isOverWorkspaceList(x, y) {
  const list = el("wsList");
  if (!list) return false;
  const rect = list.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clearPointerSplitDrag() {
  const drag = state.pointerSplitDrag;
  state.pointerSplitDrag = null;
  state.splitDragging = null;
  document.body.classList.remove("is-split-dragging");
  document.querySelectorAll(".ws.dragging").forEach((node) => node.classList.remove("dragging"));
  drag?.ghost?.remove();
  setSplitDropTarget(false);
}

function ensureSplitDragGhost(name, x, y) {
  let ghost = state.pointerSplitDrag?.ghost;
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "ws-drag-ghost";
    ghost.textContent = name;
    document.body.append(ghost);
    if (state.pointerSplitDrag) state.pointerSplitDrag.ghost = ghost;
    document.body.classList.add("is-split-dragging");
  }
  ghost.style.left = `${x + 12}px`;
  ghost.style.top = `${y + 12}px`;
  return ghost;
}

function addToSplit(id) {
  if (!state.terminals.has(id)) return;
  const ids = visibleSplitIds();
  if (ids.includes(id)) {
    state.activeId = id;
    applySplitLayout();
    toast(ids.length === 1
      ? tr("再把另一条工作区拖到右侧即可分屏", "Drag another workspace onto the terminal to split")
      : tr("这个工作区已经在分屏里", "This workspace is already in the split"));
    return;
  }
  if (ids.length >= MAX_SPLIT) {
    toast(tr("最多 7 个分屏，先点格子上的 × 移出一格", "Split is limited to 7 panes. Remove one with × first"));
    return;
  }
  state.splitIds = [...ids, id];
  state.activeId = id;
  applySplitLayout();
  renderSessions();
  updateActiveStatus();
}

function removeFromSplit(id) {
  const ids = visibleSplitIds().filter((item) => item !== id);
  state.splitIds = ids.length ? ids : [];
  if (state.activeId === id) state.activeId = ids[0] || [...state.terminals.keys()].at(-1) || null;
  applySplitLayout();
  if (state.activeId) {
    const record = state.terminals.get(state.activeId);
    if (record) {
      syncActiveRemoteUi(record);
      updateActiveStatus();
    }
  }
  renderSessions();
}

function activateTerminal(id) {
  const record = state.terminals.get(id);
  if (!record) return;
  clearTimeout(state.remoteFilterTimer);
  state.remoteFilterTimer = null;
  const ids = (state.splitIds || []).filter((item) => state.terminals.has(item));
  if (ids.length <= 1 || !ids.includes(id)) state.splitIds = [id];
  state.activeId = id;
  renderSessions();
  el("emptyState").classList.add("hidden");
  applySplitLayout();
  syncActiveRemoteUi(record);
  renderRemoteEntries(state.remoteEntries, record.connected ? "正在刷新…" : "连接后可浏览远程文件");
  renderTransferTasks();
  scheduleTransferProgressRender();
  el("openSftpTool").disabled = Boolean(record.session.local);
  el("openTailTool").disabled = Boolean(record.session.local);
  updateActiveStatus();
  updateSftpControls();
  applyActiveDrawer();
  if (!record.session.local && !el("sftpPanel").classList.contains("hidden") && record.connected) refreshRemote();
}

async function closeTerminal(id, reconnecting = false) {
  const record = state.terminals.get(id);
  if (!record) return;
  const sessionTransferIds = [...state.transferTerminals].filter(([, terminalId]) => terminalId === id).map(([transferId]) => transferId);
  if (sessionTransferIds.length) {
    const accepted = await appPrompt({ title: "取消传输并关闭", message: "该会话仍有文件正在传输。关闭会话将取消传输，是否继续？", input: false, confirmText: "关闭会话" });
    if (!accepted) return;
    await Promise.all(sessionTransferIds.map((transferId) => invoke("cancel_transfer", { transferId }).catch(() => {})));
    const sessionPromises = sessionTransferIds.map((transferId) => state.transferPromises.get(transferId)).filter(Boolean);
    if (sessionPromises.length) {
      await Promise.race([
        Promise.allSettled(sessionPromises),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
  record.stopped = true;
  clearTimeout(record.reconnectTimer);
  clearTimeout(record.resizeTimer);
  clearTimeout(record.inputTimer);
  clearTimeout(record.cwdSyncTimer);
  clearTimeout(record.bootstrapTimer);
  clearTimeout(record.bootstrapFallbackTimer);
  record.inputQueue = [];
  record.inputBytes = 0;
  record.connectionSecret = "";
  record.fitObserver.disconnect();
  if (record.logging) await invoke("session_log_stop", { id }).catch(() => {});
  await invoke("notify_tool_windows_closed", { scopeId: id }).catch(() => {});
  await invoke(record.session.local ? "local_terminal_close" : "ssh_disconnect", { id }).catch(() => {});
  record.terminal.dispose();
  record.host.remove();
  document.querySelector(`.tab[data-terminal-id="${id}"]`)?.remove();
  state.terminals.delete(id);
  state.splitIds = (state.splitIds || []).filter((item) => item !== id);
  if (!reconnecting) state.autoReconnectCounts.delete(record.session.id);
  state.remotePaths.delete(id);
  state.remoteEntriesByTerminal.delete(id);
  state.remoteUiByTerminal.delete(id);
  state.drawerByTerminal.delete(id);
  state.tailPaths.delete(id);
  if (state.activeId === id) {
    const next = [...state.terminals.keys()].at(-1);
    if (next) activateTerminal(next);
    else {
      state.activeId = null;
      state.remoteEntries = [];
      state.selectedRemote = null;
      state.selectedRemotePaths = new Set();
      state.remoteSelectionAnchor = null;
      renderRemoteEntries([], "连接 SSH 后可浏览远程文件");
      el("emptyState").classList.remove("hidden");
      ["sftpPanel", "tailPanel", "manualPanel"].forEach((panelId) => el(panelId).classList.add("hidden"));
      el("openSftpTool").disabled = true;
      el("openTailTool").disabled = true;
      document.querySelector(".server-monitor").classList.add("hidden");
      updateActiveStatus();
      updateSftpControls();
      renderSessions();
      applySplitLayout();
    }
  } else {
    applySplitLayout();
  }
  if (!reconnecting) persistOpenSessionIds();
}

function activeTerminal() {
  return state.terminals.get(state.activeId);
}

function updateActiveStatus() {
  const record = activeTerminal();
  const connected = Boolean(record?.connected);
  document.querySelector(".server-monitor")?.classList.add("hidden");
  clearTimeout(state.monitorTimer);
  state.monitorTimer = null;
  el("statusDot").classList.toggle("online", connected);
  el("statusDot").classList.toggle("on", connected);
  const english = state.preferences.language === "en-US";
  const statusText = english ? { connecting: "Connecting", connected: "Connected", disconnected: "Disconnected", error: "Connection failed" } : { connecting: "连接中", connected: "已连接", disconnected: "已断开", error: "连接失败" };
  el("titlebarContext").textContent = record?.session.name || "Orbiterm";
  if (el("tbHost")) el("tbHost").textContent = record ? (record.session.local ? tr("本地 PowerShell", "Local PowerShell") : `${record.session.username}@${record.session.host}`) : tr("未连接", "Disconnected");
  if (el("tbDot")) el("tbDot").className = `dot ${record?.status === "connected" ? "on" : record?.status === "connecting" || record?.status === "error" ? "warn" : ""}`;
  if (el("tbChips")) el("tbChips").innerHTML = record ? workspaceChips(record).map(([text, kind]) => `<span class="chiplet ${kind}">${escapeHtml(text)}</span>`).join("") : "";
  if (el("termPanel")) el("termPanel").classList.toggle("attention", record?.status === "error");
  el("connectionStatus").textContent = record
    ? (record.session.fingerprint ? (english ? "Host key verified" : "主机指纹已验证") : (statusText[record.status] || statusText.disconnected))
    : (english ? "Disconnected" : "未连接");
  el("connectionStatus").className = record?.session.fingerprint && connected ? "status-ok" : "";
  el("statusHost").textContent = record ? record.session.local ? tr("本地 PowerShell", "Local PowerShell") : `${record.session.username}@${record.session.host}:${record.session.port}` : "—";
  el("latencyStatus").textContent = record?.session.local ? (english ? "Local" : "本地") : (connected && record.latency != null ? `${record.latency}ms` : "—");
  el("terminalSize").textContent = record ? `${record.terminal.cols} × ${record.terminal.rows}` : "—";
  el("logStatus").textContent = record?.logging ? (english ? "Log: recording" : "日志：记录中") : (english ? "Log: off" : "日志：关闭");
  const drawer = state.activeId ? state.drawerByTerminal.get(state.activeId) : null;
  el("openSftpTool")?.classList.toggle("on", drawer === "sftp");
  el("openTailTool")?.classList.toggle("on", drawer === "tail");
  el("openManualTool")?.classList.toggle("on", drawer === "manual");
  refreshNotifyBadge();
}

function safeFileName(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "session";
}

function sessionLogFileName(record) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replaceAll(":", "-");
  return safeFileName(state.preferences.logFileTemplate
    .replaceAll("{session}", record.session.name)
    .replaceAll("{host}", record.session.host)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time));
}

async function startSessionLog(record, askForPath = true) {
  const name = sessionLogFileName(record);
  let path = state.preferences.defaultLogDirectory ? joinLocal(state.preferences.defaultLogDirectory, name) : "";
  if (!path && askForPath) path = await save({ defaultPath: name });
  if (!path) return false;
  await invoke("session_log_start", { id: record.id, path });
  record.logging = true;
  record.logPath = path;
  updateActiveStatus();
  return true;
}

async function toggleSessionLog(id = state.activeId) {
  const record = state.terminals.get(id) || activeTerminal();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  if (record.session.local) return toast("本地 PowerShell 暂不使用 SSH 会话日志", "error");
  try {
    if (record.logging) {
      await invoke("session_log_stop", { id: record.id });
      record.logging = false;
      toast("会话日志已停止", "success");
    } else {
      if (!await startSessionLog(record)) return;
      toast("会话日志已开始记录", "success");
    }
    updateActiveStatus();
  } catch (error) {
    toast(String(error), "error");
  }
}

function parentPath(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}` || "/";
}

function normalizeRemotePath(value, base = "/") {
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

function joinRemote(base, name) {
  return normalizeRemotePath(name, base);
}

function joinLocal(base, name) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${name}`;
}

function selectedRemoteEntries() {
  return state.remoteEntries.filter((entry) => state.selectedRemotePaths.has(entry.path));
}

function formatSize(size) {
  if (size === 0) return "0 B";
  if (!Number.isFinite(size) || size < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function fileIcon(entry) {
  if (entry.isDir) {
    return `<i class="file-icon folder-icon">${ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}</i>`;
  }
  const extension = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
  const kind = ["zip", "tar", "gz", "7z", "rar"].includes(extension) ? "archive"
    : ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(extension) ? "image"
      : ["js", "ts", "py", "rs", "go", "java", "html", "css", "json", "yml", "yaml", "sh"].includes(extension) ? "code"
        : ["log", "txt", "md", "conf", "ini"].includes(extension) ? "text" : "file";
  return `<i class="file-icon ${kind}-icon"><small>${escapeHtml(extension.slice(0, 3).toUpperCase())}</small></i>`;
}

function visibleRemoteEntries() {
  const query = state.remoteFilter.trim().toLowerCase();
  const allowed = state.preferences.showHiddenFiles ? state.remoteEntries : state.remoteEntries.filter((entry) => !entry.name.startsWith("."));
  const entries = query ? allowed.filter((entry) => entry.name.toLowerCase().includes(query)) : [...allowed];
  const { key, direction } = state.remoteSort;
  const multiplier = direction === "asc" ? 1 : -1;
  return entries.sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    const a = ["name", "owner"].includes(key) ? String(left[key] || "").toLowerCase() : Number(left[key] || 0);
    const b = ["name", "owner"].includes(key) ? String(right[key] || "").toLowerCase() : Number(right[key] || 0);
    return (typeof a === "string" ? a.localeCompare(b, "zh-CN", { numeric: true }) : a - b) * multiplier;
  });
}

function renderRemoteEntries(entries, emptyText = "此目录为空") {
  const visible = entries === state.remoteEntries ? visibleRemoteEntries() : entries;
  const rendered = visible.slice(0, state.remoteRenderLimit);
  const rows = rendered.map((entry) => `<div class="remote-row${state.selectedRemotePaths.has(entry.path) ? " selected" : ""}" tabindex="0" title="${escapeHtml(entry.path)}" data-path="${escapeHtml(entry.path)}" data-dir="${entry.isDir}" data-name="${escapeHtml(entry.name)}" data-permissions="${entry.permissions}"><span>${fileIcon(entry)}<b>${escapeHtml(entry.name)}</b></span><span>${entry.isDir ? "—" : formatSize(entry.size)}</span><span>${escapeHtml(entry.owner || "—")}</span><span>${entry.modified ? new Date(entry.modified * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : ""}</span><span>${((entry.permissions || 0) & 0o7777).toString(8).padStart(3, "0")}</span></div>`).join("");
  const more = rendered.length < visible.length ? `<button class="remote-load-more" data-load-more-remote>${tr(`继续显示（${rendered.length}/${visible.length}）`, `Show more (${rendered.length}/${visible.length})`)}</button>` : "";
  el("remoteFiles").innerHTML = visible.length ? rows + more : `<div class="file-placeholder">${escapeHtml(state.remoteFilter ? "没有匹配的文件" : emptyText)}</div>`;
  document.querySelectorAll(".file-header [data-sort]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === state.remoteSort.key);
    button.querySelector("i").textContent = button.dataset.sort === state.remoteSort.key ? (state.remoteSort.direction === "asc" ? "↑" : "↓") : "";
  });
}

function updateSftpControls(loading = false) {
  const record = activeTerminal();
  const connected = Boolean(record?.connected && !record.session.local);
  const selectedItems = selectedRemoteEntries();
  el("sftpHost").textContent = connected ? `${record.session.username}@${record.session.host}` : tr("未连接", "Disconnected");
  el("uploadFile").disabled = !connected;
  el("downloadFile").disabled = !connected || !selectedItems.length;
  el("newRemote").disabled = !connected;
  el("remoteUp").disabled = !connected || loading || state.remotePath === "/";
  el("remoteBack").disabled = !connected || loading || record.sftpHistoryIndex <= 0;
  el("remoteForward").disabled = !connected || loading || record.sftpHistoryIndex >= record.sftpHistory.length - 1;
  el("remoteRefresh").disabled = !connected || loading;
  el("remotePath").disabled = !connected || loading;
  const filterQuery = state.remoteFilter.trim().toLowerCase();
  const allowedEntries = state.preferences.showHiddenFiles ? state.remoteEntries : state.remoteEntries.filter((entry) => !entry.name.startsWith("."));
  const visibleCount = filterQuery
    ? allowedEntries.reduce((count, entry) => count + Number(entry.name.toLowerCase().includes(filterQuery)), 0)
    : allowedEntries.length;
  const english = state.preferences.language === "en-US";
  const selectionText = state.selectedRemotePaths.size ? `${english ? "Selected" : "已选"} ${state.selectedRemotePaths.size} ${english ? "· " : "项 · "}` : "";
  const countText = state.remoteFilter ? `${visibleCount} / ${state.remoteEntries.length}` : `${state.remoteEntries.length}`;
  el("remoteSummary").textContent = loading ? "" : `${selectionText}${countText} ${english ? "item(s)" : "项"}`;
}

async function invokeSftpWithReconnect(command, args, terminalId) {
  try {
    return await invoke(command, args);
  } catch (firstError) {
    if (!isRetryableSftpCommand(command) || !isTransientSftpError(firstError)) throw firstError;
    try {
      await invoke("sftp_reconnect", { id: terminalId });
      return await invoke(command, args);
    } catch (retryError) {
      throw retryError || firstError;
    }
  }
}

async function refreshRemote(nextPath = null, trackHistory = true) {
  const record = activeTerminal();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  const path = normalizeRemotePath((nextPath ?? el("remotePath").value) || "/", state.remotePath);
  const requestId = ++record.sftpRequestId;
  const terminalId = record.id;
  updateSftpControls(true);
  el("remoteFiles").setAttribute("aria-busy", "true");
  if (!state.remoteEntries.length) el("remoteFiles").innerHTML = `<div class="file-placeholder">${tr("正在读取…", "Loading…")}</div>`;
  try {
    const entries = await invokeSftpWithReconnect("sftp_list", { id: record.id, path }, record.id);
    if (!state.terminals.has(terminalId) || requestId !== record.sftpRequestId) return;
    if (trackHistory && nextPath !== null && record.sftpHistory[record.sftpHistoryIndex] !== path) {
      record.sftpHistory = record.sftpHistory.slice(0, record.sftpHistoryIndex + 1);
      record.sftpHistory.push(path);
      record.sftpHistoryIndex = record.sftpHistory.length - 1;
    }
    state.remotePaths.set(terminalId, path);
    if (state.preferences.persistRemotePath) {
      state.preferences.remotePathsBySession[record.session.id] = path;
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
    }
    const ui = remoteUiFor(terminalId);
    if (!ui) return;
    ui.path = path;
    ui.entries = entries;
    ui.renderLimit = state.preferences.sftpPageSize;
    ui.selected = null;
    ui.selectedPaths.clear();
    ui.selectionAnchor = null;
    state.remoteEntriesByTerminal.set(terminalId, entries);
    if (state.activeId !== terminalId) return;
    syncActiveRemoteUi(record);
    el("remotePath").value = path;
    renderRemoteEntries(entries);
  } catch (error) {
    if (!state.terminals.has(terminalId) || requestId !== record.sftpRequestId || state.activeId !== terminalId) return;
    el("remotePath").value = state.remotePath;
    if (!state.remoteEntries.length) el("remoteFiles").innerHTML = `<div class="file-placeholder error">${escapeHtml(String(error))}</div>`;
    toast(String(error), "error");
  } finally {
    if (requestId === record.sftpRequestId && state.activeId === terminalId) {
      el("remoteFiles").setAttribute("aria-busy", "false");
      updateSftpControls();
    }
  }
}

function setTransfer(message, active = false, percent = null) {
  el("transferText").textContent = localizeRuntimeText(message);
  const english = state.preferences.language === "en-US";
  el("transferStatus").textContent = active
    ? (english ? "Transfer: active" : "传输：进行中")
    : (english ? "Transfer: idle" : "传输：空闲");
  const showProgress = active && percent != null;
  el("transferProgress").classList.toggle("hidden", !showProgress);
  el("transferProgress").classList.remove("indeterminate");
  el("cancelTransfer").classList.toggle("hidden", !active);
  const value = percent == null ? 0 : Math.max(0, Math.min(percent, 100));
  el("transferProgressBar").style.width = `${value}%`;
  el("transferPercent").textContent = active && percent != null ? `${Math.round(value)}%` : "";
  updateSftpControls();
}

function transferStatusText(status) {
  const english = state.preferences.language === "en-US";
  return ({
    queued: english ? "Queued" : "等待中",
    running: english ? "Transferring" : "传输中",
    completed: english ? "Completed" : "已完成",
    cancelled: english ? "Cancelled" : "已取消",
    error: english ? "Failed" : "失败",
  })[status] || status;
}

function renderTransferTasks() {
  const tasks = [...state.transferMeta.entries()].filter(([, task]) => task.terminalId === state.activeId).reverse();
  el("transferTasks").classList.toggle("hidden", tasks.length === 0);
  el("transferTaskCount").textContent = tasks.length ? `${tasks.length}` : "";
  const list = el("transferTaskList");
  const existing = new Map([...list.children].map((row) => [row.dataset.transferId, row]));
  tasks.forEach(([id, task], index) => {
    let row = existing.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "transfer-task";
      row.dataset.transferId = id;
      row.innerHTML = `<i></i><span><b></b><small></small></span><div class="transfer-task-progress"><progress max="100"></progress><output></output></div><button type="button">×</button>`;
    }
    const percent = task.total > 0 ? Math.min(100, task.transferred / task.total * 100) : 0;
    const progressText = task.status === "running" || task.status === "completed"
      ? `${task.total > 0 ? `${formatSize(task.transferred)} / ${formatSize(task.total)}` : formatSize(task.transferred)} · ${transferStatusText(task.status)}`
      : `${transferStatusText(task.status)}${task.error ? ` · ${task.error}` : ""}`;
    const icon = task.status === "completed" ? "✓" : task.status === "error" ? "!" : task.status === "cancelled" ? "×" : task.kind === "下载" ? "↓" : "↑";
    row.dataset.status = task.status;
    row.querySelector("i").textContent = icon;
    const name = row.querySelector("b");
    name.textContent = task.name;
    name.title = task.name;
    const detail = row.querySelector("small");
    detail.textContent = progressText;
    detail.title = progressText;
    row.querySelector("progress").value = percent;
    row.querySelector("output").textContent = task.total > 0 ? `${Math.round(percent)}%` : "—%";
    const cancel = row.querySelector("button");
    const cancellable = ["queued", "running"].includes(task.status);
    cancel.classList.toggle("hidden", !cancellable);
    cancel.disabled = false;
    if (cancellable) {
      cancel.dataset.cancelTransferId = id;
      cancel.title = tr("取消此任务", "Cancel this task");
      cancel.setAttribute("aria-label", cancel.title);
    } else {
      delete cancel.dataset.cancelTransferId;
      cancel.removeAttribute("title");
      cancel.removeAttribute("aria-label");
    }
    existing.delete(id);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  existing.forEach((row) => row.remove());
}

function transferConcurrency(direction) {
  return direction === "upload" ? state.preferences.uploadWorkers : state.preferences.downloadWorkers;
}

function pumpTransferQueue(direction) {
  const queue = state.transferQueues[direction];
  const activeSlots = state.transferActiveSlots[direction];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (state.transferMeta.get(queue[index].transferId)?.status === "cancelled") {
      queue.splice(index, 1)[0].resolve({ status: "cancelled", bytes: 0 });
    }
  }
  while (queue.length && activeSlots.size < transferConcurrency(direction)) {
    const item = queue.shift();
    let slot = 0;
    while (activeSlots.has(slot)) slot += 1;
    activeSlots.add(slot);
    Promise.resolve()
      .then(() => item.run(slot))
      .then(item.resolve, item.reject)
      .finally(() => {
        activeSlots.delete(slot);
        pumpTransferQueue(direction);
      });
  }
}

function enqueueTransferJob(direction, transferId, run) {
  return new Promise((resolve, reject) => {
    state.transferQueues[direction].push({ transferId, run, resolve, reject });
    pumpTransferQueue(direction);
  });
}

function scheduleTransferProgressRender() {
  if (state.transferRenderFrame !== null) return;
  state.transferRenderFrame = requestAnimationFrame(() => {
    state.transferRenderFrame = null;
    const active = [...state.transferMeta.values()].filter((item) => item.terminalId === state.activeId && item.status === "running");
    if (!active.length) {
      setTransfer(tr("暂无传输任务", "No transfer tasks"));
      return renderTransferTasks();
    }
    const transferred = active.reduce((sum, item) => sum + (item.transferred || 0), 0);
    const total = active.reduce((sum, item) => sum + (item.total || 0), 0);
    const startedAt = Math.min(...active.map((item) => item.startedAt));
    const seconds = Math.max((performance.now() - startedAt) / 1000, 0.01);
    const sizeText = total ? `${formatSize(transferred)} / ${formatSize(total)}` : formatSize(transferred);
    const taskText = active.length > 1 ? `${active.length} 个任务` : active[0].name;
    setTransfer(`${taskText} · ${sizeText} · ${formatSize(transferred / seconds)}/s`, true);
    renderTransferTasks();
  });
}

function trimTransferTasks() {
  const removable = [...state.transferMeta.entries()].filter(([, task]) => !["queued", "running"].includes(task.status));
  removable.slice(0, Math.max(0, removable.length - 100)).forEach(([id]) => {
    state.transferMeta.delete(id);
    state.transferTerminals.delete(id);
  });
}

function queueTransfer(transferId, terminalId, meta) {
  state.transferTerminals.set(transferId, terminalId);
  state.transferMeta.set(transferId, { transferred: 0, total: 0, status: "queued", terminalId, ...meta, startedAt: performance.now() });
  trimTransferTasks();
  renderTransferTasks();
}

function registerTransfer(transferId, terminalId, promise, meta = {}) {
  state.activeTransferId = transferId;
  state.activeTransferIds.add(transferId);
  state.transferPromises.set(transferId, promise);
  state.transferTerminals.set(transferId, terminalId);
  const current = state.transferMeta.get(transferId) || { transferred: 0, total: 0, terminalId, startedAt: performance.now() };
  state.transferMeta.set(transferId, { ...current, ...meta, terminalId, status: "running", startedAt: performance.now() });
  renderTransferTasks();
}

function unregisterTransfer(transferId, status = "completed", error = "") {
  state.activeTransferIds.delete(transferId);
  state.transferPromises.delete(transferId);
  state.transferTerminals.delete(transferId);
  const meta = state.transferMeta.get(transferId);
  if (meta) {
    meta.status = status;
    meta.error = error;
    meta.finishedAt = performance.now();
  }
  if (state.activeTransferId === transferId) {
    state.activeTransferId = [...state.activeTransferIds].at(-1) || null;
  }
  trimTransferTasks();
  renderTransferTasks();
}

async function cancelTransferTask(transferId) {
  const task = state.transferMeta.get(transferId);
  if (!task || !["queued", "running"].includes(task.status)) return;
  const wasRunning = task.status === "running";
  unregisterTransfer(transferId, "cancelled");
  pumpTransferQueue("upload");
  pumpTransferQueue("download");
  if (wasRunning) await invoke("cancel_transfer", { transferId });
}

function finishTransferBatch(message, terminalId) {
  const remaining = [...state.transferMeta.values()].filter((task) => task.terminalId === terminalId && ["queued", "running"].includes(task.status));
  if (state.activeId === terminalId) {
    if (remaining.length) setTransfer(`${message} · 另有 ${remaining.length} 个任务正在传输`, true);
    else setTransfer(message);
  }
  if (!state.activeTransferIds.size) {
    state.activeTransferTerminalId = null;
    state.activeTransferPromise = null;
    state.transferPrefix = "";
  }
}

async function uploadPaths(localPaths) {
  const record = activeTerminal();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  if (!localPaths.length) return;
  const destinationPath = state.remotePath;
  const names = localPaths.map((path) => path.replaceAll("\\", "/").split("/").pop());
  const duplicateNames = duplicateBaseNames(localPaths);
  if (duplicateNames.length) {
    const preview = duplicateNames.slice(0, 5).join("、");
    return toast(`所选项目包含同名文件：${preview}。请分批上传或先重命名。`, "error");
  }
  const conflicts = names.filter((name) => state.remoteEntries.some((entry) => entry.name === name));
  if (conflicts.length && state.preferences.confirmOverwrite) {
    const preview = conflicts.slice(0, 5).join("、");
    const suffix = conflicts.length > 5 ? ` 等 ${conflicts.length} 个文件` : "";
    const overwrite = await appPrompt({ title: "覆盖远程文件", message: `远程目录中已存在 ${preview}${suffix}，是否全部覆盖？`, input: false, confirmText: "全部覆盖" });
    if (!overwrite) return;
  }
  const jobs = localPaths.map((localPath, index) => ({
    id: crypto.randomUUID(), localPath, name: names[index], index,
  }));
  jobs.forEach((job) => queueTransfer(job.id, record.id, { name: job.name, kind: "上传", prefix: localPaths.length > 1 ? `${job.index + 1}/${localPaths.length} · ` : "" }));
  if (state.transferActiveSlots.upload.size) toast("上传任务已加入并行队列");
  if (state.closing || !record.connected || !state.terminals.has(record.id)) {
    jobs.forEach((job) => { if (state.transferMeta.get(job.id)?.status === "queued") unregisterTransfer(job.id, "cancelled"); });
    return toast("原会话已断开，上传任务已取消", "error");
  }
  state.activeTransferTerminalId = record.id;
  const started = performance.now();
  const outcomes = await Promise.all(jobs.map((job) => enqueueTransferJob("upload", job.id, async (workerIndex) => {
      const meta = state.transferMeta.get(job.id);
      if (!meta || meta.status === "cancelled") return { status: "cancelled", bytes: 0 };
      if (state.closing || !record.connected || !state.terminals.has(record.id)) {
        unregisterTransfer(job.id, "cancelled");
        return { status: "cancelled", bytes: 0 };
      }
      state.transferPrefix = meta.prefix;
      state.transferStartedAt = performance.now();
      if (state.activeId === record.id) setTransfer(`${state.transferPrefix}正在上传 ${job.name}…`, true);
      const transferPromise = invoke("sftp_upload", { id: record.id, transferId: job.id, workerId: `upload-${workerIndex}`, localPath: job.localPath, remotePath: joinRemote(destinationPath, job.name) });
      registerTransfer(job.id, record.id, transferPromise);
      state.activeTransferPromise = transferPromise;
      try {
        const bytes = await transferPromise;
        const current = state.transferMeta.get(job.id);
        if (current) { current.transferred = bytes; current.total ||= bytes; }
        unregisterTransfer(job.id, "completed");
        return { status: "completed", bytes };
      } catch (error) {
        const cancelled = String(error).includes("传输已取消") || state.transferMeta.get(job.id)?.status === "cancelled";
        unregisterTransfer(job.id, cancelled ? "cancelled" : "error", cancelled ? "" : String(error));
        return { status: cancelled ? "cancelled" : "error", bytes: 0, error };
      }
  })));
  const completed = outcomes.filter((outcome) => outcome.status === "completed").length;
  const totalBytes = outcomes.reduce((sum, outcome) => sum + outcome.bytes, 0);
  const failure = outcomes.find((outcome) => outcome.status === "error")?.error;
  try {
    if (failure) throw failure;
    const seconds = Math.max((performance.now() - started) / 1000, 0.01);
    finishTransferBatch(`✓ 已上传 ${completed} 个文件 · ${formatSize(totalBytes)} · ${formatSize(totalBytes / seconds)}/s`, record.id);
    toast(`${completed} 个文件上传完成`, "success");
    if (state.activeId === record.id) refreshRemote(destinationPath, false);
  } catch (error) { finishTransferBatch(String(error) === "传输已取消" ? `上传已取消 · 已完成 ${completed}/${localPaths.length}` : `上传失败 · 已完成 ${completed}/${localPaths.length}：${String(error)}`, record.id); toast(String(error), "error"); }
  finally { updateSftpControls(); }
}

async function uploadFile() {
  const selection = await open({ multiple: true, directory: false });
  if (!selection) return;
  await uploadPaths(Array.isArray(selection) ? selection : [selection]);
}

function binaryToHex(base64) {
  const normalized = base64.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const lines = [];
  for (let offset = 0; offset < binary.length; offset += 16) {
    const bytes = [...binary.slice(offset, offset + 16)].map((char) => char.charCodeAt(0));
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = bytes.map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

function updateEditorLineNumbers() {
  const count = el("remoteEditor").value.split("\n").length;
  el("editorLineNumbers").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
}

function findInEditor(previous = false) {
  const query = el("editorFindInput").value;
  const editor = el("remoteEditor");
  if (!query) return;
  const content = editor.value.toLowerCase();
  const needle = query.toLowerCase();
  const start = previous ? Math.max(0, editor.selectionStart - 1) : editor.selectionEnd;
  let index = previous ? content.lastIndexOf(needle, start) : content.indexOf(needle, start);
  if (index < 0) index = previous ? content.lastIndexOf(needle) : content.indexOf(needle);
  if (index < 0) return toast("未找到匹配内容");
  editor.focus();
  editor.setSelectionRange(index, index + query.length);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
  const line = editor.value.slice(0, index).split("\n").length - 1;
  editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
}

async function openRemoteEditor(item = state.selectedRemote) {
  const record = activeTerminal();
  if (!record?.connected || !item || item.isDir) return;
  if (isTauri) {
    const query = new URLSearchParams({
      sessionId: record.id,
      path: item.path,
      name: item.name,
      language: state.preferences.language || "zh-CN",
      theme: resolvedAppTheme(),
      chunkSizeMb: String(state.preferences.fileChunkSizeMb),
      editLimitMb: String(state.preferences.fileEditLimitMb),
      wrap: String(state.preferences.previewWrap),
      lineNumbers: String(state.preferences.previewLineNumbers),
      fontSize: String(state.preferences.previewFontSize),
    });
    try {
      await invoke("open_tool_window", { request: { kind: "file-viewer", title: `${item.name} — Orbiterm`, query: query.toString(), scopeId: record.id } });
    } catch (error) {
      toast(String(error), "error");
    }
    return;
  }
  el("editorName").textContent = item.name;
  el("editorPath").textContent = item.path;
  el("remoteEditor").value = "";
  el("editorLoading").classList.remove("hidden");
  el("remoteEditor").readOnly = true;
  el("toggleEditorMode").textContent = tr("编辑", "Edit");
  el("saveRemoteEditor").disabled = true;
  el("editorModal").classList.remove("hidden");
  try {
    const result = await invokeSftpWithReconnect("sftp_read_text", {
      id: record.id,
      path: item.path,
      maxBytes: state.preferences.fileEditLimitMb * 1024 * 1024,
    }, record.id);
    if (state.activeId !== record.id || el("editorModal").classList.contains("hidden")) return;
    state.editorTerminalId = record.id;
    state.editorPath = item.path;
    state.editorEncoding = result.encoding;
    const content = result.encoding === "utf8" ? result.content : binaryToHex(result.content);
    state.editorOriginal = content;
    el("remoteEditor").value = content;
    el("editorEncoding").textContent = result.encoding === "utf8" ? "UTF-8" : tr("二进制 · HEX", "Binary · HEX");
    el("toggleEditorMode").classList.toggle("hidden", result.encoding !== "utf8");
    updateEditorLineNumbers();
    el("editorLoading").classList.add("hidden");
    el("editorSize").textContent = `${content.length.toLocaleString()} ${tr("字符", "characters")}`;
  } catch (error) {
    el("editorLoading").classList.add("hidden");
    el("editorModal").classList.add("hidden");
    toast(String(error), "error");
  }
}

async function closeRemoteEditor() {
  if (!el("remoteEditor").readOnly && el("remoteEditor").value !== state.editorOriginal) {
    const accepted = await appPrompt({ title: "放弃修改", message: "远程文件有未保存的修改，确定关闭吗？", input: false, confirmText: "放弃修改" });
    if (!accepted) return;
  }
  el("editorModal").classList.add("hidden");
  state.editorTerminalId = null;
  state.editorPath = "";
  state.editorOriginal = "";
  state.editorEncoding = "utf8";
}

async function saveRemoteEditor() {
  const record = state.terminals.get(state.editorTerminalId);
  if (!record?.connected || !state.editorPath) return toast("原会话已断开，无法保存", "error");
  if (state.editorEncoding !== "utf8") return toast("二进制预览为只读，不能直接保存", "error");
  const button = el("saveRemoteEditor");
  button.disabled = true;
    button.textContent = tr("正在保存…", "Saving…");
  try {
    await invokeSftpWithReconnect("sftp_write_text", { id: record.id, path: state.editorPath, content: el("remoteEditor").value }, record.id);
    state.editorOriginal = el("remoteEditor").value;
    toast("远程文件已保存", "success");
    button.textContent = tr("已保存", "Saved");
    setTimeout(() => { button.textContent = tr("保存到远端", "Save remotely"); button.disabled = el("remoteEditor").readOnly; }, 900);
    if (state.activeId === record.id) refreshRemote();
  } catch (error) {
    button.disabled = false;
    button.textContent = tr("保存到远端", "Save remotely");
    toast(String(error), "error");
  }
}

async function downloadFile() {
  const record = activeTerminal();
  const items = selectedRemoteEntries();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  if (!items.length) return toast("请选择要下载的文件", "error");
  const configuredDirectory = state.preferences.defaultDownloadDirectory;
  const destination = configuredDirectory || (items.length === 1 && !items[0].isDir
    ? await save({ defaultPath: items[0].name })
    : await open({ directory: true, multiple: false, title: `选择 ${items.length} 个文件的保存目录` }));
  if (!destination) return;
  const jobs = items.map((item, index) => ({
    id: crypto.randomUUID(), item, index,
    localPath: (configuredDirectory || items.length > 1) ? joinLocal(destination, item.name) : destination,
  }));
  jobs.forEach((job) => queueTransfer(job.id, record.id, { name: job.item.name, kind: "下载", total: job.item.isDir ? 0 : job.item.size, prefix: items.length > 1 ? `${job.index + 1}/${items.length} · ` : "" }));
  if (state.transferActiveSlots.download.size) toast("下载任务已加入并行队列");
  if (state.closing || !record.connected || !state.terminals.has(record.id)) {
    jobs.forEach((job) => { if (state.transferMeta.get(job.id)?.status === "queued") unregisterTransfer(job.id, "cancelled"); });
    return toast("原会话已断开，下载任务已取消", "error");
  }
  state.activeTransferTerminalId = record.id;
  const started = performance.now();
  const outcomes = await Promise.all(jobs.map((job) => enqueueTransferJob("download", job.id, async (workerIndex) => {
      const meta = state.transferMeta.get(job.id);
      if (!meta || meta.status === "cancelled") return { status: "cancelled", bytes: 0 };
      if (state.closing || !record.connected || !state.terminals.has(record.id)) {
        unregisterTransfer(job.id, "cancelled");
        return { status: "cancelled", bytes: 0 };
      }
      if (state.activeId === record.id) setTransfer(`${meta.prefix}正在下载 ${job.item.name}…`, true);
      const transferPromise = invoke(job.item.isDir ? "sftp_download_tree" : "sftp_download", { id: record.id, transferId: job.id, workerId: `download-${workerIndex}`, remotePath: job.item.path, localPath: job.localPath });
      registerTransfer(job.id, record.id, transferPromise);
      state.activeTransferPromise = Promise.allSettled([...state.transferPromises.values()]);
      try {
        const bytes = await transferPromise;
        const current = state.transferMeta.get(job.id);
        if (current) { current.transferred = bytes; current.total ||= bytes; }
        unregisterTransfer(job.id, "completed");
        return { status: "completed", bytes };
      } catch (error) {
        const cancelled = String(error).includes("传输已取消") || state.transferMeta.get(job.id)?.status === "cancelled";
        unregisterTransfer(job.id, cancelled ? "cancelled" : "error", cancelled ? "" : String(error));
        return { status: cancelled ? "cancelled" : "error", bytes: 0, error };
      }
  })));
  const completed = outcomes.filter((outcome) => outcome.status === "completed").length;
  const totalBytes = outcomes.reduce((sum, outcome) => sum + outcome.bytes, 0);
  const failure = outcomes.find((outcome) => outcome.status === "error")?.error;
  try {
    if (failure) throw failure;
    const seconds = Math.max((performance.now() - started) / 1000, 0.01);
    finishTransferBatch(`✓ 已下载 ${completed} 个文件 · ${formatSize(totalBytes)} · ${formatSize(totalBytes / seconds)}/s`, record.id);
    toast(`${completed} 个文件下载完成`, "success");
  } catch (error) { finishTransferBatch(String(error) === "传输已取消" ? `下载已取消 · 已完成 ${completed}/${items.length}` : `下载失败 · 已完成 ${completed}/${items.length}：${String(error)}`, record.id); toast(String(error), "error"); }
  finally { updateSftpControls(); }
}

async function createFolder() {
  const record = activeTerminal();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  const name = await appPrompt({ title: "新建文件夹", message: `将在 ${state.remotePath} 中创建`, value: "新建文件夹" });
  if (!name?.trim() || name.includes("/") || [".", ".."].includes(name.trim())) return toast("目录名称无效", "error");
  try { await invokeSftpWithReconnect("sftp_mkdir", { id: record.id, path: joinRemote(state.remotePath, name.trim()) }, record.id); refreshRemote(); }
  catch (error) { toast(String(error), "error"); }
}

async function createRemoteFile() {
  const record = activeTerminal();
  if (!record?.connected) return toast("请先连接 SSH 会话", "error");
  const name = (await appPrompt({ title: "新建文件", message: `将在 ${state.remotePath} 中创建`, value: "新建文件.txt" }))?.trim();
  if (!name || name.includes("/") || [".", ".."].includes(name)) return;
  try {
    await invokeSftpWithReconnect("sftp_write_text", { id: record.id, path: joinRemote(state.remotePath, name), content: "" }, record.id);
    await refreshRemote();
  } catch (error) { toast(String(error), "error"); }
}

async function removeRemote() {
  const record = activeTerminal();
  const items = selectedRemoteEntries();
  if (!record?.connected || !items.length) return toast("请选择要删除的文件或目录", "error");
  const accepted = await appPrompt({ title: "删除远程项目", message: `确定递归删除选中的 ${items.length} 项吗？此操作无法撤销。`, input: false, confirmText: "删除" });
  if (!accepted) return;
  try { for (const item of items) await invokeSftpWithReconnect("sftp_remove", { id: record.id, path: item.path, isDir: item.isDir }, record.id); refreshRemote(); }
  catch (error) { toast(String(error), "error"); }
}

async function renameRemote() {
  const record = activeTerminal();
  const item = state.selectedRemote;
  if (!record?.connected || !item) return toast("请选择要重命名的文件或目录", "error");
  const name = (await appPrompt({ title: "重命名", value: item.name }))?.trim();
  if (!name || name === item.name) return;
  if (name.includes("/") || [".", ".."].includes(name)) return toast("名称无效", "error");
  try {
    await invokeSftpWithReconnect("sftp_rename", { id: record.id, oldPath: item.path, newPath: joinRemote(state.remotePath, name) }, record.id);
    toast("重命名完成", "success");
    await refreshRemote();
  } catch (error) { toast(String(error), "error"); }
}

async function chmodRemote() {
  const record = activeTerminal();
  const items = selectedRemoteEntries();
  if (!record?.connected || !items.length) return toast("请选择文件或目录", "error");
  const current = ((items[0].permissions || 0) & 0o7777).toString(8).padStart(3, "0");
  const value = (await appPrompt({ title: "修改权限", message: "请输入八进制权限值，例如 644、755", value: current }))?.trim();
  if (value == null || value === "") return;
  if (!/^[0-7]{3,4}$/.test(value)) return toast("请输入 3 或 4 位八进制权限值", "error");
  try {
    for (const item of items) await invokeSftpWithReconnect("sftp_chmod", { id: record.id, path: item.path, permissions: Number.parseInt(value, 8) }, record.id);
    toast(`权限已修改为 ${value}`, "success");
    await refreshRemote();
  } catch (error) { toast(String(error), "error"); }
}

async function showRemoteProperties() {
  const item = selectedRemoteEntries()[0];
  if (!item) return;
  const record = activeTerminal();
  try {
    const properties = await invokeSftpWithReconnect("sftp_properties", { id: record.id, path: item.path }, record.id);
    const permission = ((item.permissions || 0) & 0o7777).toString(8);
    const message = state.preferences.language === "en-US"
      ? `Path: ${item.path}\nType: ${item.isDir ? "Folder" : "File"}\nSize: ${formatSize(properties.size)}\nContents: ${properties.files} file(s), ${properties.directories} folder(s)\nOwner: ${item.owner || "—"}\nPermissions: ${permission}`
      : `路径：${item.path}\n类型：${item.isDir ? "文件夹" : "文件"}\n大小：${formatSize(properties.size)}\n内容：${properties.files} 个文件，${properties.directories} 个文件夹\n归属：${item.owner || "—"}\n权限：${permission}`;
    await appPrompt({ title: item.isDir ? "文件夹属性" : "文件属性", message, input: false, confirmText: "关闭" });
  } catch (error) { toast(String(error), "error"); }
}

function toggleSftp(force) {
  const record = activeTerminal();
  if (!record) return toast(tr("请先打开一个终端会话", "Please open a terminal session first"), "error");
  if (record.session.local) return toast(tr("SFTP 文件管理器仅用于远程 SSH 会话", "SFTP File Manager is available only for remote SSH sessions"), "error");
  const show = force ?? el("sftpPanel").classList.contains("hidden");
  setActiveDrawer(show ? "sftp" : null);
  requestAnimationFrame(() => { fitVisibleTerminals(); if (show && activeTerminal()?.connected) refreshRemote(); });
}

function setActiveDrawer(drawer) {
  if (!state.activeId) return;
  state.drawerByTerminal.set(state.activeId, drawer);
  applyActiveDrawer();
}

function applyActiveDrawer() {
  const drawer = state.activeId ? state.drawerByTerminal.get(state.activeId) : null;
  const panels = { sftp: el("sftpPanel"), tail: el("tailPanel"), manual: el("manualPanel") };
  for (const [name, panel] of Object.entries(panels)) {
    const open = drawer === name;
    panel.classList.toggle("hidden", !open);
    panel.toggleAttribute("inert", !open);
    panel.setAttribute("aria-hidden", String(!open));
  }
  if (drawer !== "tail") { clearTimeout(state.tailTimer); state.tailTimer = null; }
  el("openSftpTool")?.classList.toggle("on", drawer === "sftp");
  el("openTailTool")?.classList.toggle("on", drawer === "tail");
  el("openManualTool")?.classList.toggle("on", drawer === "manual");
  requestAnimationFrame(() => fitVisibleTerminals());
}

function renderTailFiles() {
  el("tailFiles").innerHTML = state.tailEntries.length ? state.tailEntries.map((entry) => `<button data-tail-path="${escapeHtml(entry.path)}" data-dir="${entry.isDir}">${fileIcon(entry)}<b>${escapeHtml(entry.name)}</b>${entry.isDir ? "" : `<small>${formatSize(entry.size)}</small>`}</button>`).join("") : `<div>当前目录没有可访问的文件</div>`;
}

function showTailFiles(show) {
  el("tailFiles").classList.toggle("hidden", !show);
  el("tailPanel").classList.toggle("files-open", show);
}

function updateTailModeUi() {
  const mode = el("tailMode").value;
  const follow = el("tailFollow").checked;
  const count = Math.max(1, Number(el("tailLines").value) || state.preferences.tailDefaultLines);
  el("tailLines").disabled = mode === "all";
  el("pauseTail").disabled = !follow || !activeTerminal()?.tailFile;
  const range = mode === "all"
    ? tr("读取当前全部内容", "Read all current content")
    : mode === "first"
      ? tr(`读取开头 ${count} 行`, `Read the first ${count} lines`)
      : tr(`读取最近 ${count} 行`, `Read the last ${count} lines`);
  const continuation = follow
    ? tr("，随后持续追加文件的新内容", ", then continuously append new content")
    : tr("，读取后停止，不再自动更新", ", then stop without automatic updates");
  el("tailModeHint").textContent = range + continuation;
}

function limitTailLines(record, lines) {
  const maximum = state.preferences.tailMaxLines;
  if (lines.length <= maximum) return lines;
  const removed = lines.length - maximum;
  record.tailLineBase = (record.tailLineBase || 0) + removed;
  return lines.slice(removed);
}

async function refreshTailDirectory(nextPath, preserveInput = false) {
  const record = activeTerminal();
  if (!record?.connected) return;
  const path = normalizeRemotePath(nextPath || el("tailPath").value || state.remotePath, el("tailPath").value || state.remotePath);
  if (!preserveInput) el("tailPath").value = path;
  showTailFiles(true);
  el("tailFiles").innerHTML = `<div>${tr("正在读取…", "Loading…")}</div>`;
  try {
    state.tailEntries = await invokeSftpWithReconnect("sftp_list", { id: record.id, path }, record.id);
    if (record.id !== state.activeId) return;
    state.tailPaths.set(record.id, path);
    renderTailFiles();
  } catch (error) { el("tailFiles").innerHTML = `<div class="error">${escapeHtml(String(error))}</div>`; }
}

async function openTailPanel() {
  const record = activeTerminal();
  if (!record) return toast(tr("请先打开一个终端会话", "Please open a terminal session first"), "error");
  if (record.session.local) return toast(tr("Tail 日志查看仅用于远程 SSH 会话", "Tail Log Viewer is available only for remote SSH sessions"), "error");
  if (state.drawerByTerminal.get(record.id) === "tail") {
    setActiveDrawer(null);
    return;
  }
  setActiveDrawer("tail");
  clearTimeout(state.tailTimer);
  state.tailTimer = null;
  el("tailHost").textContent = record?.connected ? `${record.session.username}@${record.session.host}` : tr("未连接", "Disconnected");
  const path = record.tailFile || state.tailPaths.get(record.id) || state.remotePath || "/";
  el("tailPath").value = path;
  el("tailSelectedFile").textContent = record.tailFile || tr("尚未选择文件", "No file selected");
  state.tailLines = record.tailLines || [];
  state.tailPaused = Boolean(record.tailPaused);
  state.tailSearchIndex = -1;
  state.tailSearchMatches = [];
  state.tailSearchQuery = "";
  el("tailMode").value = record.tailMode || "last";
  el("tailLines").value = record.tailCount || state.preferences.tailDefaultLines;
  el("tailFollow").checked = record.tailFollow !== false;
  el("pauseTail").textContent = state.tailPaused ? tr("继续", "Resume") : tr("暂停", "Pause");
  updateTailModeUi();
  renderTailOutput(false);
  if (el("tailSearch").value.trim()) updateTailSearch(false);
  showTailFiles(false);
  if (record.connected && record.tailFile && !record.tailPaused) refreshTail();
}

function closeTailPanel() {
  setActiveDrawer(null);
  clearTimeout(state.tailTimer);
  state.tailTimer = null;
}

async function refreshTail(reset = false) {
  const record = activeTerminal();
  const path = record?.tailFile || "";
  if (!record?.connected || !path) return toast("请选择当前目录中的日志文件", "error");
  clearTimeout(state.tailTimer);
  el("pauseTail").disabled = false;
  let hasRemaining = false;
  try {
    if (reset || !record.tailInitialized) {
      const mode = el("tailMode").value;
      const lineValue = Number(el("tailLines").value);
      if (mode !== "all" && (!Number.isInteger(lineValue) || lineValue < 1 || lineValue > 100000)) {
        return toast(tr("行数必须是 1 到 100000 之间的整数", "Line count must be an integer from 1 to 100000"), "error");
      }
      record.tailMode = mode;
      record.tailCount = mode === "all" ? null : lineValue;
      record.tailFollow = el("tailFollow").checked;
      const snapshot = await invoke("ssh_tail", { id: record.id, path, lines: mode === "all" ? null : lineValue, fromStart: mode === "first", maxBytes: state.preferences.tailAllLimitMb * 1024 * 1024 });
      if (record.id !== state.activeId || el("tailPanel").classList.contains("hidden")) return;
      record.tailOffset = snapshot.offset;
      record.tailInitialized = true;
      record.tailLineBase = 0;
      const snapshotLines = snapshot.content ? snapshot.content.split("\n") : [];
      record.tailLines = limitTailLines(record, snapshotLines);
      if (snapshotLines.length > state.preferences.tailMaxLines) toast(tr(`日志内容过多，仅保留最近 ${state.preferences.tailMaxLines.toLocaleString()} 行`, `The log is large; only the latest ${state.preferences.tailMaxLines.toLocaleString()} lines are retained`));
      state.tailLines = record.tailLines;
      if (el("tailSearch").value.trim()) updateTailSearch(false);
      else renderTailOutput(true);
    } else {
      const append = await invokeSftpWithReconnect("sftp_read_append", { id: record.id, path, offset: record.tailOffset }, record.id);
      hasRemaining = Boolean(append.remaining);
      if (record.id !== state.activeId || el("tailPanel").classList.contains("hidden")) return;
      if (append.reset) {
        record.tailInitialized = false;
        record.tailOffset = append.offset;
        record.tailLineBase = 0;
        return refreshTail(true);
      }
      record.tailOffset = append.offset;
      if (append.content) {
        record.tailLines = limitTailLines(record, appendTextLines(record.tailLines, append.content));
        state.tailLines = record.tailLines;
        if (el("tailSearch").value.trim()) updateTailSearch(false);
        else renderTailOutput(false);
      }
    }
  } catch (error) { el("tailOutput").textContent = localizeRuntimeText(error); }
  if (record.tailFollow && !record.tailPaused && !el("tailPanel").classList.contains("hidden")) state.tailTimer = setTimeout(refreshTail, hasRemaining ? 25 : state.preferences.tailRefreshMs);
}

async function openTailPath() {
  const record = activeTerminal();
  if (!record?.connected) return;
  const path = normalizeRemotePath(el("tailPath").value, state.tailPaths.get(record.id) || state.remotePath);
  try {
    const info = await invokeSftpWithReconnect("sftp_path_info", { id: record.id, path }, record.id);
    if (info.isDir) return refreshTailDirectory(info.path);
    record.tailFile = info.path;
    record.tailInitialized = false;
    record.tailOffset = 0;
    record.tailLines = [];
    record.tailLineBase = 0;
    record.tailPaused = false;
    state.tailPaused = false;
    el("pauseTail").textContent = tr("暂停", "Pause");
    state.tailPaths.set(record.id, parentPath(info.path));
    el("tailPath").value = info.path;
    el("tailSelectedFile").textContent = info.path;
    showTailFiles(false);
    refreshTail();
  } catch (error) { toast(String(error), "error"); }
}

function toggleTailPause() {
  const record = activeTerminal();
  if (!record?.tailFile) return;
  record.tailPaused = !record.tailPaused;
  state.tailPaused = record.tailPaused;
  clearTimeout(state.tailTimer);
  state.tailTimer = null;
  el("pauseTail").textContent = record.tailPaused ? tr("继续", "Resume") : tr("暂停", "Pause");
  if (!record.tailPaused) refreshTail();
}

function renderTailOutput(forceBottom = false) {
  const output = el("tailOutput");
  const lines = state.tailLines;
  if (!lines.length) {
    output.innerHTML = `<div class="tail-empty">${tr("文件暂无内容", "The file has no content")}</div>`;
    return;
  }
  const lineHeight = Number.parseFloat(getComputedStyle(output).lineHeight) || 20.5;
  const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < lineHeight * 2;
  const previousTop = output.scrollTop;
  const visibleCount = Math.ceil(Math.max(output.clientHeight, lineHeight) / lineHeight);
  const targetTop = forceBottom || wasAtBottom ? Math.max(0, lines.length * lineHeight - output.clientHeight) : previousTop;
  const start = Math.max(0, Math.floor(targetTop / lineHeight) - 40);
  const end = Math.min(lines.length, start + visibleCount + 80);
  const activeLine = state.tailSearchIndex >= 0 ? state.tailSearchMatches[state.tailSearchIndex] : -1;
  const rows = lines.slice(start, end).map((line, offset) => {
    const index = start + offset;
    const lineNumber = (activeTerminal()?.tailLineBase || 0) + index + 1;
    return `<div data-tail-line="${index}"${index === activeLine ? ' class="match"' : ""}><span>${lineNumber}</span><code>${escapeHtml(line) || " "}</code></div>`;
  }).join("");
  output.innerHTML = `<div class="tail-spacer" style="height:${start * lineHeight}px"></div>${rows}<div class="tail-spacer" style="height:${Math.max(0, (lines.length - end) * lineHeight)}px"></div>`;
  output.scrollTop = targetTop;
}

function updateTailSearch(move = false, previous = false) {
  const query = el("tailSearch").value.trim().toLowerCase();
  if (!query) {
    state.tailSearchIndex = -1;
    state.tailSearchMatches = [];
    state.tailSearchQuery = "";
    el("tailSearchCount").textContent = "";
    renderTailOutput(false);
    return;
  }
  const queryChanged = query !== state.tailSearchQuery;
  state.tailSearchQuery = query;
  state.tailSearchMatches = state.tailLines.reduce((matches, line, index) => {
    if (line.toLowerCase().includes(query)) matches.push(index);
    return matches;
  }, []);
  if (!state.tailSearchMatches.length) {
    state.tailSearchIndex = -1;
    el("tailSearchCount").textContent = "0";
    renderTailOutput(false);
    return;
  }
  if (queryChanged || state.tailSearchIndex < 0) state.tailSearchIndex = 0;
  else if (move) state.tailSearchIndex = (state.tailSearchIndex + (previous ? -1 : 1) + state.tailSearchMatches.length) % state.tailSearchMatches.length;
  else state.tailSearchIndex = Math.min(state.tailSearchIndex, state.tailSearchMatches.length - 1);
  const lineHeight = Number.parseFloat(getComputedStyle(el("tailOutput")).lineHeight) || 20.5;
  el("tailOutput").scrollTop = Math.max(0, state.tailSearchMatches[state.tailSearchIndex] * lineHeight - el("tailOutput").clientHeight / 2);
  el("tailSearchCount").textContent = `${state.tailSearchIndex + 1}/${state.tailSearchMatches.length}`;
  renderTailOutput(false);
}

async function refreshServerMonitor() {
  clearTimeout(state.monitorTimer);
  state.monitorTimer = null;
  document.querySelector(".server-monitor")?.classList.add("hidden");
}

function setSftpWidth(width, persist = false) {
  const maxWidth = Math.max(280, window.innerWidth - 24);
  const minWidth = Math.min(360, maxWidth);
  state.preferences.sftpWidth = Math.round(Math.max(minWidth, Math.min(width, maxWidth)));
  el("sftpPanel").style.width = `${state.preferences.sftpWidth}px`;
  if (persist) savePreferences();
}

function setDrawerWidth(type, width, persist = false) {
  const maxWidth = Math.max(360, window.innerWidth - 24);
  const value = Math.round(Math.max(420, Math.min(width, maxWidth)));
  const key = type === "tail" ? "tailWidth" : "manualWidth";
  state.preferences[key] = value;
  el(type === "tail" ? "tailPanel" : "manualPanel").style.width = `${value}px`;
  if (persist) savePreferences();
}

function installDrawerResize(handle) {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const type = handle.dataset.resizeDrawer;
    const panel = el(type === "tail" ? "tailPanel" : "manualPanel");
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const move = (moveEvent) => setDrawerWidth(type, startWidth + startX - moveEvent.clientX);
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setDrawerWidth(type, panel.getBoundingClientRect().width, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
}

function closeMenus() {
  document.querySelectorAll(".menu-root.open").forEach((menu) => {
    menu.classList.remove("open");
    menu.querySelector(".menu-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function updateMenuStates() {
  const record = activeTerminal();
  const states = {
    copy: !record?.terminal.hasSelection(),
    paste: !record?.connected,
    "select-all": !record,
    find: !record,
    reconnect: !record,
    disconnect: !record?.connected,
    "duplicate-terminal": !record,
    "previous-terminal": state.terminals.size < 2,
    "next-terminal": state.terminals.size < 2,
    "reset-terminal": !record,
    clear: !record,
    "toggle-log": !record?.connected,
    "toggle-sftp": !record?.connected || record.session.local,
    "toggle-tail": !record?.connected || record.session.local,
    "transfer-tasks": !record,
    "close-terminal": !record,
    upload: !record?.connected,
    "export-sessions": !state.sessions.length,
  };
  Object.entries(states).forEach(([action, disabled]) => {
    document.querySelectorAll(`[data-menu-action="${action}"]`).forEach((button) => { button.disabled = disabled; });
  });
}

function hideTerminalContextMenu() {
  el("terminalContextMenu").classList.add("hidden");
}

function hideTabContextMenu() {
  el("tabContextMenu").classList.add("hidden");
  state.tabContextId = null;
}

function hideGroupMenus() {
  el("groupContextMenu")?.classList.add("hidden");
  el("sessionLibContextMenu")?.classList.add("hidden");
  state.groupContextName = null;
  state.libContextSessionId = null;
}

function hideSftpMenus() {
  el("sftpContextMenu").classList.add("hidden");
  el("newRemoteMenu").classList.add("hidden");
}

function positionPopup(menu, x, y) {
  menu.style.visibility = "hidden";
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.style.visibility = "visible";
}

function selectRemoteRow(row, event = {}) {
  if (!row) return;
  const rows = [...el("remoteFiles").querySelectorAll(".remote-row")];
  if (event.shiftKey && state.remoteSelectionAnchor) {
    const anchorIndex = rows.findIndex((item) => item.dataset.path === state.remoteSelectionAnchor);
    const currentIndex = rows.indexOf(row);
    if (anchorIndex >= 0 && currentIndex >= 0) {
      if (!event.ctrlKey) state.selectedRemotePaths.clear();
      const [start, end] = [anchorIndex, currentIndex].sort((left, right) => left - right);
      rows.slice(start, end + 1).forEach((item) => state.selectedRemotePaths.add(item.dataset.path));
    }
  } else if (event.ctrlKey) {
    if (state.selectedRemotePaths.has(row.dataset.path)) state.selectedRemotePaths.delete(row.dataset.path);
    else state.selectedRemotePaths.add(row.dataset.path);
    state.remoteSelectionAnchor = row.dataset.path;
  } else {
    state.selectedRemotePaths.clear();
    state.selectedRemotePaths.add(row.dataset.path);
    state.remoteSelectionAnchor = row.dataset.path;
  }
  rows.forEach((item) => item.classList.toggle("selected", state.selectedRemotePaths.has(item.dataset.path)));
  state.selectedRemote = { path: row.dataset.path, name: row.dataset.name, isDir: row.dataset.dir === "true", permissions: Number(row.dataset.permissions) || 0 };
  updateActiveRemoteUi({ selected: state.selectedRemote, selectionAnchor: state.remoteSelectionAnchor });
  updateSftpControls();
}

async function runSftpAction(action) {
  hideSftpMenus();
  if (action === "open") return state.selectedRemote?.isDir ? refreshRemote(state.selectedRemote.path) : openRemoteEditor();
  if (action === "download") return downloadFile();
  if (action === "rename") return renameRemote();
  if (action === "permissions") return chmodRemote();
  if (action === "properties") return showRemoteProperties();
  if (action === "delete") return removeRemote();
  if (action === "refresh") return refreshRemote();
}

function showTerminalContextMenu(x, y) {
  const record = activeTerminal();
  const menu = el("terminalContextMenu");
  menu.querySelector('[data-terminal-context-action="copy"]').disabled = !record?.terminal.hasSelection();
  menu.querySelector('[data-terminal-context-action="paste"]').disabled = !record?.connected;
  menu.querySelector('[data-terminal-context-action="select-all"]').disabled = !record;
  menu.querySelector('[data-terminal-context-action="find"]').disabled = !record;
  menu.querySelector('[data-terminal-context-action="clear"]').disabled = !record;
  menu.style.visibility = "hidden";
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.style.visibility = "visible";
}

function runTerminalContextAction(action) {
  hideTerminalContextMenu();
  switch (action) {
    case "copy": copyTerminalSelection(); break;
    case "paste": pasteTerminalClipboard(); break;
    case "select-all": activeTerminal()?.terminal.selectAll(); break;
    case "find": showFindBar(); break;
    case "clear": activeTerminal()?.terminal.clear(); break;
  }
}

async function runMenuAction(action) {
  closeMenus();
  switch (action) {
    case "new-session": openSessionModal(); break;
    case "quick-connect": openSessionModal(null, "quick"); break;
    case "local-ssh": await openLocalSshModal(); break;
    case "exit": await requestAppClose(); break;
    case "copy": await copyTerminalSelection(); break;
    case "paste": await pasteTerminalClipboard(); break;
    case "select-all": activeTerminal()?.terminal.selectAll(); break;
    case "find": showFindBar(); break;
    case "toggle-sidebar": setSidebarCollapsed(!document.querySelector(".sidebar").classList.contains("collapsed")); break;
    case "toggle-sftp": toggleSftp(); break;
    case "toggle-tail": state.drawerByTerminal.get(state.activeId) === "tail" ? setActiveDrawer(null) : openTailPanel(); break;
    case "toggle-manual": state.drawerByTerminal.get(state.activeId) === "manual" ? setActiveDrawer(null) : openCommandManual(); break;
    case "fullscreen": {
      const fullscreen = await appWindow.isFullscreen();
      if (fullscreen) await appWindow.setFullscreen(false);
      else {
        if (await appWindow.isMaximized()) await appWindow.unmaximize();
        await appWindow.setFullscreen(true);
      }
      break;
    }
    case "reconnect": reconnectActiveTerminal(); break;
    case "disconnect": await disconnectTerminal(); break;
    case "duplicate-terminal": await duplicateTerminal(); break;
    case "previous-terminal": activateAdjacentTerminal(-1); break;
    case "next-terminal": activateAdjacentTerminal(1); break;
    case "reset-terminal": resetActiveTerminal(); break;
    case "clear": activeTerminal()?.terminal.clear(); break;
    case "toggle-log": await toggleSessionLog(); break;
    case "close-terminal": if (state.activeId) await closeTerminal(state.activeId); break;
    case "upload": toggleSftp(true); await uploadFile(); break;
    case "transfer-tasks": toggleSftp(true); el("transferTasks").classList.remove("hidden"); el("transferTasks").scrollIntoView({ block: "nearest" }); break;
    case "settings": openSettingsModal(); break;
    case "import-sessions": await importSessions(); break;
    case "export-sessions": await exportSessions(); break;
    case "guide": openHelpModal("guide"); break;
    case "command-manual": openCommandManual(); break;
    case "shortcuts": openHelpModal("shortcuts"); break;
    case "about": openHelpModal("about"); break;
  }
}

function helpContents(section) {
  const english = state.preferences.language === "en-US";
  const contents = english ? {
    guide: ["User Guide", `<div class="help-hero"><span>›_</span><div><h2>Start working quickly</h2><p>Manage SSH sessions, local PowerShell, files and logs in one window.</p></div></div><div class="help-card-grid"><section><h3>1 · Connect</h3><p>Create an SSH session or double-click a saved session. Passwords are stored only in Windows Credential Manager when requested.</p></section><section><h3>2 · Work with tabs</h3><p>Right-click a tab to duplicate, disconnect, reconnect or close it. Each tab keeps its own SFTP and log drawer state.</p></section><section><h3>3 · Transfer files</h3><p>Open SFTP to drag files for upload, multi-select downloads, edit text files, inspect properties and permissions.</p></section><section><h3>4 · Inspect logs</h3><p>Choose a remote log, configure tail/follow, pause streaming and search by line number.</p></section></div><div class="help-tip"><b>Tip</b><span>Multi-line paste opens a compose pane before sending—review commands before they reach the shell.</span></div>`],
    shortcuts: ["Keyboard Shortcuts", `<div class="shortcut-groups"><section><h3>Sessions</h3><dl><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd></dt><dd>New SSH session</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>W</kbd></dt><dd>Close current tab</dd><dt><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>]</kbd></dt><dd>Disconnect / close session</dd></dl></section><section><h3>Terminal</h3><dl><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>C</kbd></dt><dd>Copy selection</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>V</kbd></dt><dd>Paste or open compose pane</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>G</kbd></dt><dd>Find in terminal</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>A</kbd></dt><dd>Select all terminal text</dd></dl></section><section><h3>Panels & window</h3><dl><dt><kbd>Ctrl</kbd><kbd>B</kbd></dt><dd>Toggle session manager</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F</kbd></dt><dd>Toggle SFTP</dd><dt><kbd>F11</kbd></dt><dd>Toggle full screen</dd><dt><kbd>Esc</kbd></dt><dd>Close the active panel or dialog</dd></dl></section></div>`],
    about: ["About Orbiterm", `<div class="about-mark">›_</div><h2>Orbiterm</h2><p class="about-version">Version 0.1.0 · Tauri 2</p><p>A native Windows SSH, SFTP and local PowerShell workspace built with Rust and xterm.js.</p><div class="about-features"><span>SSH</span><span>SFTP</span><span>ConPTY</span><span>UTF-8</span></div><p class="muted">Passwords are stored in Windows Credential Manager and are never written to session JSON.</p>`],
  } : {
    guide: ["使用说明", `<div class="help-hero"><span>›_</span><div><h2>快速开始工作</h2><p>在一个窗口中管理 SSH 会话、本地 PowerShell、文件与日志。</p></div></div><div class="help-card-grid"><section><h3>1 · 建立连接</h3><p>新建 SSH 会话，或双击左侧已保存会话。勾选记住密码后，仅保存到 Windows 凭据管理器。</p></section><section><h3>2 · 管理标签</h3><p>右键标签可复制同连接会话、断开、重新连接或关闭；每个标签独立保持 SFTP 与日志抽屉状态。</p></section><section><h3>3 · 传输文件</h3><p>打开 SFTP 后可拖拽上传、多选下载、预览编辑文本，并查看属性或修改权限。</p></section><section><h3>4 · 查看日志</h3><p>选择远程日志后可设置 tail/follow、暂停实时刷新，并按行搜索内容。</p></section></div><div class="help-tip"><b>提示</b><span>粘贴多行内容会先进入编辑区，确认无误后再发送到终端。</span></div>`],
    shortcuts: ["快捷键说明", `<div class="shortcut-groups"><section><h3>会话</h3><dl><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd></dt><dd>新建 SSH 会话</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>W</kbd></dt><dd>关闭当前标签</dd><dt><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>]</kbd></dt><dd>断开或关闭当前会话</dd></dl></section><section><h3>终端</h3><dl><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>C</kbd></dt><dd>复制选中内容</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>V</kbd></dt><dd>粘贴或打开多行编辑区</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>G</kbd></dt><dd>在终端中查找</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>A</kbd></dt><dd>全选终端内容</dd></dl></section><section><h3>面板与窗口</h3><dl><dt><kbd>Ctrl</kbd><kbd>B</kbd></dt><dd>展开或折叠会话管理器</dd><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F</kbd></dt><dd>打开或关闭 SFTP</dd><dt><kbd>F11</kbd></dt><dd>进入或退出全屏</dd><dt><kbd>Esc</kbd></dt><dd>关闭当前抽屉或弹窗</dd></dl></section></div>`],
    about: ["关于 Orbiterm", `<div class="about-mark">›_</div><h2>Orbiterm</h2><p class="about-version">版本 0.1.0 · Tauri 2</p><p>基于 Rust 与 xterm.js 构建的 Windows 原生 SSH、SFTP 和本地 PowerShell 工作台。</p><div class="about-features"><span>SSH</span><span>SFTP</span><span>ConPTY</span><span>UTF-8</span></div><p class="muted">密码仅保存到 Windows 凭据管理器，不会写入会话 JSON。</p>`],
  };
  return contents[section];
}

function closeHelpModal() {
  el("helpModal").classList.add("hidden");
}

function openHelpModal(section) {
  const isManual = section === "command-manual";
  const english = state.preferences.language === "en-US";
  el("helpModalTitle").textContent = isManual ? (english ? "Linux Command Manual" : "Linux 命令手册") : helpContents(section)[0];
  document.querySelector(".help-dialog").className = `dialog help-dialog help-${isManual ? "manual" : section}`;
  el("helpModalBody").className = isManual ? "help-modal-body manual-modal-body" : "help-modal-body help-content";
  if (isManual) {
    el("helpModalBody").innerHTML = `<div class="manual-search"><span>⌕</span><input id="modalCommandSearch" placeholder="${english ? "Search commands, categories or descriptions" : "搜索命令、分类或用途"}" /></div><div class="manual-browser"><nav id="modalCommandList" class="command-list"></nav><article id="modalCommandDetail" class="command-detail"></article></div>`;
  } else {
    el("helpModalBody").innerHTML = helpContents(section)[1];
  }
  el("helpModal").classList.remove("hidden");
  if (isManual) {
    void renderCommandManual("modal");
    setTimeout(() => el("modalCommandSearch")?.focus(), 30);
  }
}

async function exportSessions() {
  if (!state.sessions.length) return toast("没有可导出的会话", "error");
  const path = await save({ defaultPath: "orbiterm-sessions.json", filters: [{ name: "Orbiterm 会话配置", extensions: ["json"] }] });
  if (!path) return;
  try {
    const sessions = state.sessions.map((session) => ({ ...session, rememberPassword: false }));
    await invoke("write_text_file", { path, content: JSON.stringify({ version: 1, sessions }, null, 2) });
    toast(`已导出 ${state.sessions.length} 个会话`, "success");
  } catch (error) { toast(String(error), "error"); }
}

async function importSessions() {
  const path = await open({ multiple: false, directory: false, filters: [{ name: "Orbiterm 会话配置", extensions: ["json"] }] });
  if (!path) return;
  try {
    const parsed = JSON.parse(await invoke("read_text_file", { path }));
    const imported = Array.isArray(parsed) ? parsed : parsed.sessions;
    if (!Array.isArray(imported)) throw new Error("配置文件格式无效");
    const valid = normalizeImportedSessions(imported, state.sessions.map((session) => session.id), () => crypto.randomUUID());
    if (!valid.length) throw new Error("配置中没有有效会话");
    state.sessions.push(...valid);
    persistSessions();
    renderSessions();
    toast(`已导入 ${valid.length} 个会话`, "success");
  } catch (error) { toast(`导入失败：${String(error)}`, "error"); }
}

function reconnectActiveTerminal() {
  const record = activeTerminal();
  if (!record) return toast("没有可重连的会话");
  void reconnectTerminal(record.id);
}

async function disconnectTerminal(id = state.activeId) {
  const record = state.terminals.get(id);
  if (!record?.connected) return;
  record.manualDisconnect = true;
  record.connected = false;
  record.stopped = true;
  await invoke(record.session.local ? "local_terminal_close" : "ssh_disconnect", { id }).catch(() => {});
  updateTerminalState(record, "disconnected");
  record.terminal.writeln("\r\n\x1b[90m会话已手动断开\x1b[0m");
}

async function reconnectTerminal(id = state.activeId) {
  const record = state.terminals.get(id);
  if (!record) return;
  const session = record.session;
  let secret = record.connectionSecret || "";
  if (!secret && session.authType === "password" && session.rememberPassword) {
    secret = await invoke("credential_get", { sessionId: session.id }).catch(() => "") || "";
  }
  await closeTerminal(id);
  if (session.local) await connectLocalTerminal({ ...session, id: crypto.randomUUID() });
  else await connectSession(session, secret);
}

async function copyTerminalSelection() {
  const selection = activeTerminal()?.terminal.getSelection();
  if (!selection) return toast("请先选择终端内容");
  try { await navigator.clipboard.writeText(selection); }
  catch (error) { toast(`复制失败：${String(error)}`, "error"); }
}

async function pasteTerminalClipboard() {
  const record = activeTerminal();
  if (!record?.connected) return toast("当前终端未连接");
  try {
    const text = await navigator.clipboard.readText();
    const lineCount = text ? text.split(/\r\n|\r|\n/).length : 0;
    if (state.preferences.confirmMultiLinePaste && lineCount > 1) {
      el("pasteEditor").value = text;
      el("pasteSummary").textContent = `${lineCount} ${tr("行", "lines")} · ${text.length} ${tr("个字符", "characters")}`;
      setPastePanelOpen(true, record);
      return;
    }
    record.terminal.paste(text);
    record.terminal.focus();
  } catch (error) { toast(`粘贴失败：${String(error)}`, "error"); }
}

function setPastePanelOpen(open, record = activeTerminal()) {
  document.querySelector(".terminal-pane")?.classList.toggle("paste-open", open);
  el("pastePanel").classList.toggle("hidden", !open);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fitVisibleTerminals();
    if (open) el("pasteEditor").focus();
    else record?.terminal.focus();
  }));
}

async function syncMaximizeButton() {
  const maximized = await appWindow.isMaximized();
  const button = el("maximize");
  button.classList.toggle("is-maximized", maximized);
  button.title = maximized ? tr("还原", "Restore") : tr("最大化", "Maximize");
  button.setAttribute("aria-label", button.title);
}

el("minimize").addEventListener("click", () => appWindow.minimize());
el("maximize").addEventListener("click", async () => { await appWindow.toggleMaximize(); await syncMaximizeButton(); });
if (isTauri) {
  appWindow.onResized(() => { void syncMaximizeButton(); scheduleWindowBoundsSave(); });
  appWindow.onMoved(scheduleWindowBoundsSave);
}
void syncMaximizeButton();
el("closePastePanel").addEventListener("click", () => setPastePanelOpen(false));
el("copyPasteText").addEventListener("click", async () => { await navigator.clipboard.writeText(el("pasteEditor").value); toast("多行文本已复制", "success"); });
el("sendPasteText").addEventListener("click", () => {
  const record = activeTerminal();
  if (!record?.connected) return toast("当前终端未连接", "error");
  const source = el("pasteEditor").value;
  const text = el("pasteJoinLines").checked ? source.replace(/\r\n|\r|\n/g, " ") : source;
  record.terminal.paste(text);
  setPastePanelOpen(false, record);
});
async function requestAppClose() {
  if (state.closing) return;
  state.closing = true;
  await captureWindowBounds().catch(() => {});
  el("closeWindow").disabled = true;
  const pendingTransferIds = [...state.transferMeta.entries()]
    .filter(([, task]) => ["queued", "running"].includes(task.status))
    .map(([transferId]) => transferId);
  const connectedSessions = [...state.terminals.values()].filter((record) => record.connected);
  if (!pendingTransferIds.length && connectedSessions.length && state.preferences.confirmCloseSessions) {
    const accepted = await appPrompt({ title: tr("退出 Orbiterm", "Exit Orbiterm"), message: tr(`仍有 ${connectedSessions.length} 个会话处于连接状态，确定退出吗？`, `${connectedSessions.length} session(s) are still connected. Exit anyway?`), input: false, confirmText: tr("退出", "Exit") });
    if (!accepted) {
      state.closing = false;
      el("closeWindow").disabled = false;
      return;
    }
  }
  if (pendingTransferIds.length) {
    const accepted = await appPrompt({ title: "退出 Orbiterm", message: "仍有文件正在传输。退出将取消传输，是否继续？", input: false, confirmText: "退出" });
    if (!accepted) {
      state.closing = false;
      el("closeWindow").disabled = false;
      return;
    }
    pendingTransferIds.forEach((transferId) => {
      if (state.transferMeta.get(transferId)?.status === "queued") unregisterTransfer(transferId, "cancelled");
    });
    await Promise.all([...state.activeTransferIds].map((transferId) => invoke("cancel_transfer", { transferId }).catch(() => {})));
    if (state.transferPromises.size) {
      await Promise.race([
        Promise.allSettled([...state.transferPromises.values()]),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
  const cleanup = Promise.all([...state.terminals.values()].map(async (record) => {
    if (record.logging) await invoke("session_log_stop", { id: record.id }).catch(() => {});
    await invoke(record.session.local ? "local_terminal_close" : "ssh_disconnect", { id: record.id }).catch(() => {});
  }));
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 1200))]);
  try {
    await invoke("close_tool_windows", { scopeId: null, force: true }).catch(() => {});
    await appWindow.destroy();
  } catch (error) {
    state.closing = false;
    el("closeWindow").disabled = false;
    toast(`${tr("关闭窗口失败", "Failed to close the window")}：${localizeRuntimeText(error)}`, "error");
  }
}

el("closeWindow").addEventListener("click", requestAppClose);
document.querySelector(".titlebar").addEventListener("dblclick", (event) => {
  if (!event.target.closest("button")) appWindow.toggleMaximize();
});
el("emptyNew").addEventListener("click", () => void openSessionModal());
el("addSession").addEventListener("click", () => void openSessionModal());
el("collapseSidebar").addEventListener("click", () => setSidebarCollapsed(!document.querySelector(".sidebar").classList.contains("collapsed")));
el("expandSidebar").addEventListener("click", () => setSidebarCollapsed(false));
document.querySelectorAll("[data-close-modal]").forEach((node) => node.addEventListener("click", closeSessionModal));
el("sessionModal").addEventListener("mousedown", (event) => { if (event.target === el("sessionModal")) closeSessionModal(); });
el("authType").addEventListener("change", updateAuthFields);
el("saveSession").addEventListener("change", () => {
  el("rememberPassword").disabled = !el("saveSession").checked;
  if (!el("saveSession").checked) el("rememberPassword").checked = false;
});
document.querySelectorAll("[data-session-tab]").forEach((button) => button.addEventListener("click", () => setSessionFormTab(button.dataset.sessionTab)));
el("sessionForm").addEventListener("submit", submitSession);
document.querySelectorAll("[data-close-settings]").forEach((node) => node.addEventListener("click", closeSettingsModal));
el("settingsModal").addEventListener("mousedown", (event) => { if (event.target === el("settingsModal")) closeSettingsModal(); });
document.querySelectorAll("[data-settings-page]").forEach((button) => button.addEventListener("click", () => {
  setSettingsPage(button.dataset.settingsPage);
  if (!el("settingsSearch").value.trim()) settingsSearchOrigin = button.dataset.settingsPage;
}));
el("settingsSearch").addEventListener("input", () => {
  const query = el("settingsSearch").value.trim().toLocaleLowerCase();
  if (!query) {
    if (settingsSearchOrigin) setSettingsPage(settingsSearchOrigin);
    settingsSearchOrigin = "";
    return;
  }
  if (!settingsSearchOrigin) {
    settingsSearchOrigin = document.querySelector("[data-settings-page].active")?.dataset.settingsPage || "general";
  }
  const match = [...document.querySelectorAll("[data-settings-panel]")].find((panel) => panel.textContent.toLocaleLowerCase().includes(query));
  if (match) setSettingsPage(match.dataset.settingsPanel);
});
document.querySelectorAll("[data-close-help-modal]").forEach((node) => node.addEventListener("click", closeHelpModal));
el("helpModalBody").addEventListener("input", (event) => {
  if (event.target.id === "modalCommandSearch") void renderCommandManual("modal");
});
el("helpModalBody").addEventListener("click", async (event) => {
  const commandButton = event.target.closest("[data-command-index]");
  if (commandButton) {
    el("modalCommandList")?.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === commandButton));
    renderCommandDetail(Number(commandButton.dataset.commandIndex), el("modalCommandDetail"));
    return;
  }
  const copyButton = event.target.closest("[data-copy-command]");
  if (copyButton) {
    await navigator.clipboard.writeText(copyButton.dataset.copyCommand);
    toast("命令已复制", "success");
  }
});
function applySettingsFromControls() {
  state.preferences = normalizePreferences({
    ...state.preferences,
    terminalScheme: el("terminalSchemeSetting").value || state.preferences.terminalScheme,
    terminalThemeDefaultVersion: 2,
    appTheme: el("appThemeSetting").value,
    language: el("languageSetting").value,
    confirmCloseSessions: el("confirmCloseSessionsSetting").checked,
    restoreWindow: el("restoreWindowSetting").checked,
    restoreTabs: el("restoreTabsSetting").checked,
    defaultDrawer: el("defaultDrawerSetting").value,
    fontSize: el("fontSizeSetting").value,
    fontFamily: el("fontFamilySetting").value,
    lineHeight: el("lineHeightSetting").value,
    letterSpacing: el("letterSpacingSetting").value,
    cursorStyle: el("cursorStyleSetting").value,
    cursorBlink: el("cursorBlinkSetting").checked,
    copyOnSelect: el("copyOnSelectSetting").checked,
    rightClickAction: el("rightClickActionSetting").value,
    bellStyle: el("bellStyleSetting").value,
    scrollback: el("scrollbackSetting").value,
    confirmMultiLinePaste: el("confirmPasteSetting").checked,
    uploadWorkers: el("uploadWorkersSetting").value,
    downloadWorkers: el("downloadWorkersSetting").value,
    tailMaxLines: el("tailMaxLinesSetting").value,
    tailAllLimitMb: el("tailAllLimitSetting").value,
    fileChunkSizeMb: el("fileChunkSizeSetting").value,
    fileEditLimitMb: el("fileEditLimitSetting").value,
    sftpPageSize: el("sftpPageSizeSetting").value,
    sftpFilterDebounceMs: el("sftpFilterDebounceSetting").value,
    defaultTimeout: el("defaultTimeoutSetting").value,
    keepaliveSeconds: el("keepaliveSetting").value,
    autoReconnectAttempts: el("autoReconnectAttemptsSetting").value,
    autoReconnectDelaySeconds: el("autoReconnectDelaySetting").value,
    previewWrap: el("previewWrapSetting").checked,
    previewLineNumbers: el("previewLineNumbersSetting").checked,
    previewFontSize: el("previewFontSizeSetting").value,
    defaultDownloadDirectory: el("defaultDownloadDirectorySetting").value.trim(),
    confirmOverwrite: el("confirmOverwriteSetting").checked,
    showHiddenFiles: el("showHiddenFilesSetting").checked,
    persistRemotePath: el("persistRemotePathSetting").checked,
    defaultLogDirectory: el("defaultLogDirectorySetting").value.trim(),
    autoSessionLog: el("autoSessionLogSetting").checked,
    logFileTemplate: el("logFileTemplateSetting").value,
    tailDefaultLines: el("tailDefaultLinesSetting").value,
    tailRefreshMs: el("tailRefreshSetting").value,
  });
  savePreferences();
  applyPerformancePreferences();
  pumpTransferQueue("upload");
  pumpTransferQueue("download");
  updateThemePicker();
}

el("settingsForm").addEventListener("submit", (event) => event.preventDefault());
el("settingsForm").addEventListener("change", (event) => {
  if (!event.target.closest(".settings-content")) return;
  applySettingsFromControls();
});
document.querySelectorAll("[data-app-theme-choice]").forEach((button) => button.addEventListener("click", () => {
  const choice = button.dataset.appThemeChoice;
  el("appThemeSetting").value = choice;
  const current = el("terminalSchemeSetting").value || state.preferences.terminalScheme;
  el("terminalSchemeSetting").value = withSoftwareTerminalDefault(choice, current);
  applySettingsFromControls();
  updateThemePicker();
  updateTerminalSchemePicker();
}));
el("pickDownloadDirectory").addEventListener("click", async () => {
  const path = await open({ directory: true, multiple: false, title: tr("选择默认下载目录", "Choose default download directory") });
  if (!path) return;
  el("defaultDownloadDirectorySetting").value = path;
  applySettingsFromControls();
});
el("pickLogDirectory").addEventListener("click", async () => {
  const path = await open({ directory: true, multiple: false, title: tr("选择默认日志目录", "Choose default log directory") });
  if (!path) return;
  el("defaultLogDirectorySetting").value = path;
  applySettingsFromControls();
});
el("importSessionsSetting").addEventListener("click", () => void importSessions());
el("exportSessionsSetting").addEventListener("click", () => void exportSessions());
el("openGuideSetting").addEventListener("click", () => openHelpModal("guide"));
el("openAboutSetting").addEventListener("click", () => openHelpModal("about"));
el("toggleSessionLogSetting").addEventListener("click", () => void toggleSessionLog());
el("closeEditor").addEventListener("click", () => void closeRemoteEditor());
el("maximizeEditor").addEventListener("click", () => {
  const dialog = document.querySelector(".editor-dialog");
  const maximized = dialog.classList.toggle("maximized");
  el("maximizeEditor").textContent = maximized ? "❐" : "□";
  el("maximizeEditor").title = maximized ? "恢复" : "最大化";
});
el("cancelEditor").addEventListener("click", () => void closeRemoteEditor());
el("editorModal").addEventListener("mousedown", (event) => { if (event.target === el("editorModal")) void closeRemoteEditor(); });
el("toggleEditorMode").addEventListener("click", () => {
  const editor = el("remoteEditor");
  editor.readOnly = !editor.readOnly;
  el("toggleEditorMode").textContent = editor.readOnly ? tr("编辑", "Edit") : tr("只读预览", "Read-only preview");
  el("saveRemoteEditor").disabled = editor.readOnly;
  if (!editor.readOnly) editor.focus();
});
el("remoteEditor").addEventListener("input", () => {
  el("editorSize").textContent = `${el("remoteEditor").value.length.toLocaleString()} ${tr("字符", "characters")}`;
  updateEditorLineNumbers();
});
el("remoteEditor").addEventListener("scroll", () => { el("editorLineNumbers").scrollTop = el("remoteEditor").scrollTop; });
el("toggleLineNumbers").addEventListener("click", () => {
  const hidden = el("editorLineNumbers").classList.toggle("hidden");
  el("remoteEditor").classList.toggle("without-line-numbers", hidden);
});
el("editorFindNext").addEventListener("click", () => findInEditor(false));
el("editorFindPrevious").addEventListener("click", () => findInEditor(true));
el("closeEditorFind").addEventListener("click", () => el("editorFind").classList.add("hidden"));
el("editorFindInput").addEventListener("keydown", (event) => { if (event.key === "Enter") findInEditor(event.shiftKey); });
el("saveRemoteEditor").addEventListener("click", saveRemoteEditor);
el("closeCommandManual").addEventListener("click", () => setActiveDrawer(null));
el("commandSearch").addEventListener("input", renderCommandManual);
el("commandList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-command-index]");
  if (!button) return;
  el("commandList").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  renderCommandDetail(Number(button.dataset.commandIndex));
});
el("commandDetail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-command]");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.copyCommand);
  toast("命令已复制", "success");
});
el("closeFind").addEventListener("click", closeFindBar);
el("findNext").addEventListener("click", () => findInTerminal(false));
el("findPrevious").addEventListener("click", () => findInTerminal(true));
el("findInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); findInTerminal(event.shiftKey); }
  if (event.key === "Escape") closeFindBar();
});
el("pickKey").addEventListener("click", async () => { const path = await open({ multiple: false, directory: false }); if (path) el("privateKey").value = path; });
el("sessionSearch").addEventListener("input", renderSessions);
el("wsList").addEventListener("click", (event) => {
  const close = event.target.closest("[data-close-terminal]");
  if (close) {
    event.preventDefault();
    event.stopPropagation();
    void closeTerminal(close.dataset.closeTerminal);
    return;
  }
  if (state.suppressWsClick) {
    state.suppressWsClick = false;
    return;
  }
  const workspace = event.target.closest(".ws");
  if (workspace) activateTerminal(workspace.dataset.terminalId);
});
el("wsList").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest("[data-close-terminal]")) return;
  const workspace = event.target.closest(".ws");
  if (!workspace) return;
  state.pointerSplitDrag = {
    kind: "terminal",
    id: workspace.dataset.terminalId,
    name: workspace.querySelector("b")?.textContent || "",
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    ghost: null,
  };
});
el("wsList").addEventListener("dragstart", (event) => {
  if (event.target.closest(".ws")) event.preventDefault();
});
document.addEventListener("pointermove", (event) => {
  const drag = state.pointerSplitDrag;
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  const distance = Math.hypot(dx, dy);
  const overTerminal = isOverTerminalPane(event.clientX, event.clientY);
  if (!drag.moved) {
    if (!overTerminal && distance < SPLIT_DRAG_THRESHOLD) return;
    if (!overTerminal && isOverWorkspaceList(event.clientX, event.clientY) && Math.abs(dy) >= Math.abs(dx)) return;
    drag.moved = true;
    state.splitDragging = { kind: drag.kind, id: drag.id };
    document.querySelector(`.ws[data-terminal-id="${drag.id}"]`)?.classList.add("dragging");
  }
  ensureSplitDragGhost(drag.name, event.clientX, event.clientY);
  setSplitDropTarget(overTerminal);
});
document.addEventListener("pointerup", (event) => {
  const drag = state.pointerSplitDrag;
  if (!drag) return;
  const moved = drag.moved;
  const overTerminal = isOverTerminalPane(event.clientX, event.clientY);
  const id = drag.id;
  clearPointerSplitDrag();
  if (!moved) return;
  state.suppressWsClick = true;
  if (overTerminal && id) addToSplit(id);
});
document.addEventListener("pointercancel", () => {
  if (state.pointerSplitDrag) clearPointerSplitDrag();
});
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
}, { capture: true });
el("wsList").addEventListener("contextmenu", (event) => {
  const workspace = event.target.closest(".ws");
  if (!workspace) return;
  event.preventDefault();
  activateTerminal(workspace.dataset.terminalId);
  closeMenus();
  hideTerminalContextMenu();
  state.tabContextId = workspace.dataset.terminalId;
  positionPopup(el("tabContextMenu"), event.clientX, event.clientY);
});
el("sessionList").addEventListener("click", (event) => {
  const heading = event.target.closest("[data-session-group]");
  if (heading) toggleSessionGroup(heading.dataset.sessionGroup);
});
el("sessionList").addEventListener("contextmenu", (event) => {
  const heading = event.target.closest("[data-session-group]");
  const item = event.target.closest(".session-item");
  event.preventDefault();
  closeMenus();
  hideTerminalContextMenu();
  hideTabContextMenu();
  hideGroupMenus();
  if (heading) {
    state.groupContextName = heading.dataset.sessionGroup;
    const del = el("groupContextMenu").querySelector('[data-group-action="delete"]');
    if (del) del.disabled = heading.dataset.sessionGroup === DEFAULT_GROUP;
    positionPopup(el("groupContextMenu"), event.clientX, event.clientY);
    return;
  }
  if (item) {
    state.libContextSessionId = item.dataset.sessionId;
    positionPopup(el("sessionLibContextMenu"), event.clientX, event.clientY);
  }
});
el("sessionList").addEventListener("keydown", (event) => {
  const heading = event.target.closest("[data-session-group]");
  if (heading && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    toggleSessionGroup(heading.dataset.sessionGroup);
  }
});
el("sessionList").addEventListener("dblclick", async (event) => {
  if (event.target.closest("button")) return;
  const item = event.target.closest(".session-item");
  if (item) await connectSavedSession(state.sessions.find((session) => session.id === item.dataset.sessionId));
});
el("sessionList").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const item = event.target.closest(".session-item");
  if (button?.dataset.action && item) {
    const session = state.sessions.find((s) => s.id === item.dataset.sessionId);
    if (button.dataset.action === "edit") openSessionModal(session);
    if (button.dataset.action === "delete" && await appPrompt({ title: "删除会话", message: `确定删除会话“${session.name}”吗？`, input: false, confirmText: "删除" })) {
      await invoke("credential_delete", { sessionId: session.id }).catch(() => {});
      state.sessions = state.sessions.filter((s) => s.id !== session.id); persistSessions(); renderSessions();
    }
    return;
  }
  if (button || !item) return;
  await connectSavedSession(state.sessions.find((session) => session.id === item.dataset.sessionId));
});
el("closeSftp").addEventListener("click", () => toggleSftp(false));
el("openSftpTool").addEventListener("click", () => toggleSftp());
el("openManualTool").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  openCommandManual();
});
el("openTailTool").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  void openTailPanel().catch((error) => toast(String(error), "error"));
});
el("openFindTool").addEventListener("click", showFindBar);
el("addGroup").addEventListener("click", () => void createSessionGroup());
el("newGroupInForm")?.addEventListener("click", async () => {
  const name = await createSessionGroup(el("group").value);
  if (name) {
    fillGroupOptions(name);
    el("group").value = name;
  }
});
el("reconnectTool").addEventListener("click", () => runMenuAction("reconnect"));
el("moreTool").addEventListener("click", (event) => {
  event.stopPropagation();
  if (!state.activeId) return;
  const rect = el("moreTool").getBoundingClientRect();
  el("tabContextMenu").style.left = `${rect.right - 230}px`;
  el("tabContextMenu").style.top = `${rect.bottom + 6}px`;
  el("tabContextMenu").classList.remove("hidden");
  state.tabContextId = state.activeId;
});
el("paletteTrigger").addEventListener("click", openPalette);
el("paletteOverlay").addEventListener("mousedown", (event) => { if (event.target === event.currentTarget) closePalette(); });
el("paletteInput").addEventListener("input", () => { palSel = 0; renderPalette(); });
el("paletteInput").addEventListener("keydown", (event) => {
  const items = [...el("paletteList").querySelectorAll(".p-item")];
  if (event.key === "ArrowDown") { event.preventDefault(); palSel = Math.min(palSel + 1, items.length - 1); renderPalette(); }
  else if (event.key === "ArrowUp") { event.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalette(); }
  else if (event.key === "Enter") { event.preventDefault(); paletteVisible[palSel]?.run(); closePalette(); }
  else if (event.key === "Escape") { event.preventDefault(); closePalette(); }
});
el("paletteList").addEventListener("click", (event) => {
  const item = event.target.closest(".p-item");
  if (!item) return;
  paletteVisible[Number(item.dataset.i)]?.run();
  closePalette();
});
el("paletteList").addEventListener("mousemove", (event) => {
  const item = event.target.closest(".p-item");
  if (!item) return;
  const index = Number(item.dataset.i);
  if (index !== palSel) { palSel = index; renderPalette(); }
});
el("themeToggle").addEventListener("click", toggleAppTheme);
el("sidebarSettings").addEventListener("click", openSettingsModal);
el("sidebarKeys").addEventListener("click", () => toast(tr("密码保存在 Windows 凭据管理器中，不会写入会话配置。", "Passwords stay in Windows Credential Manager and are not saved in session files.")));
el("sidebarFingerprint").addEventListener("click", () => {
  const known = state.sessions.filter((session) => session.fingerprint);
  toast(known.length
    ? tr(`已保存 ${known.length} 个主机指纹。指纹变化时会拒绝连接。`, `${known.length} host key(s) saved. A changed key will block the connection.`)
    : tr("还没有已信任的主机指纹。首次连接后会自动保存。", "No trusted host keys yet. The first connection saves the fingerprint."));
});
el("bellBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  el("notifyPop").classList.toggle("hidden");
  refreshNotifyBadge();
});
el("notifyList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-notify-id]");
  if (!item) return;
  el("notifyPop").classList.add("hidden");
  activateTerminal(item.dataset.notifyId);
});
document.addEventListener("click", () => el("notifyPop")?.classList.add("hidden"));
el("closeTail").addEventListener("click", closeTailPanel);
el("startTail").addEventListener("click", () => {
  const record = activeTerminal();
  if (record) record.tailPaused = false;
  state.tailPaused = false;
  el("pauseTail").textContent = tr("暂停", "Pause");
  refreshTail(true);
});
el("tailMode").addEventListener("change", updateTailModeUi);
el("tailLines").addEventListener("input", updateTailModeUi);
el("tailFollow").addEventListener("change", () => {
  const record = activeTerminal();
  if (record) record.tailFollow = el("tailFollow").checked;
  updateTailModeUi();
  clearTimeout(state.tailTimer);
  state.tailTimer = null;
  if (record?.tailFile && record.tailFollow && !record.tailPaused) refreshTail();
});
el("pauseTail").addEventListener("click", toggleTailPause);
el("tailRefresh").addEventListener("click", openTailPath);
el("tailUp").addEventListener("click", () => {
  const record = activeTerminal();
  const current = record?.tailFile === el("tailPath").value ? parentPath(record.tailFile) : el("tailPath").value;
  refreshTailDirectory(parentPath(current));
});
el("tailPath").addEventListener("focus", () => {
  const record = activeTerminal();
  const directory = record?.tailFile === el("tailPath").value ? parentPath(record.tailFile) : el("tailPath").value;
  refreshTailDirectory(directory, true);
});
el("tailPath").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); openTailPath(); } });
el("tailFiles").addEventListener("dblclick", (event) => {
  const item = event.target.closest("[data-tail-path]");
  if (!item) return;
  if (item.dataset.dir === "true") refreshTailDirectory(item.dataset.tailPath);
  else {
    const record = activeTerminal();
    record.tailFile = item.dataset.tailPath;
    record.tailInitialized = false;
    record.tailOffset = 0;
    record.tailLines = [];
    record.tailLineBase = 0;
    record.tailPaused = false;
    state.tailLines = [];
    state.tailPaused = false;
    el("pauseTail").textContent = tr("暂停", "Pause");
    el("tailPath").value = item.dataset.tailPath;
    el("tailSelectedFile").textContent = item.dataset.tailPath;
    showTailFiles(false);
    refreshTail();
  }
});
el("tailSearch").addEventListener("input", () => updateTailSearch(false));
el("tailSearchNext").addEventListener("click", () => updateTailSearch(true, false));
el("tailSearchPrevious").addEventListener("click", () => updateTailSearch(true, true));
el("tailOutput").addEventListener("scroll", () => {
  if (state.tailRenderFrame) cancelAnimationFrame(state.tailRenderFrame);
  state.tailRenderFrame = requestAnimationFrame(() => {
    state.tailRenderFrame = null;
    renderTailOutput(false);
  });
});
el("remoteRefresh").addEventListener("click", () => refreshRemote());
el("remotePath").addEventListener("keydown", (event) => {
  if (event.key === "Enter") refreshRemote();
  if (event.key === "Escape") { event.currentTarget.value = state.remotePath; event.currentTarget.blur(); }
});
el("remoteFilter").addEventListener("input", (event) => {
  state.remoteFilter = event.currentTarget.value;
  state.remoteRenderLimit = state.preferences.sftpPageSize;
  el("clearRemoteFilter").classList.toggle("hidden", !state.remoteFilter);
  state.selectedRemote = null;
  state.selectedRemotePaths.clear();
  state.remoteSelectionAnchor = null;
  updateActiveRemoteUi({ filter: state.remoteFilter, renderLimit: state.remoteRenderLimit, selected: null, selectionAnchor: null });
  clearTimeout(state.remoteFilterTimer);
  state.remoteFilterTimer = setTimeout(() => {
    renderRemoteEntries(state.remoteEntries);
    updateSftpControls();
  }, state.preferences.sftpFilterDebounceMs);
});
el("clearRemoteFilter").addEventListener("click", () => {
  clearTimeout(state.remoteFilterTimer);
  el("remoteFilter").value = "";
  state.remoteFilter = "";
  state.remoteRenderLimit = state.preferences.sftpPageSize;
  el("clearRemoteFilter").classList.add("hidden");
  updateActiveRemoteUi({ filter: "", renderLimit: state.remoteRenderLimit });
  renderRemoteEntries(state.remoteEntries);
  updateSftpControls();
});
document.querySelectorAll(".file-header [data-sort]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.sort;
  state.remoteSort = { key, direction: state.remoteSort.key === key && state.remoteSort.direction === "asc" ? "desc" : "asc" };
  state.remoteRenderLimit = state.preferences.sftpPageSize;
  updateActiveRemoteUi({ sort: state.remoteSort, renderLimit: state.remoteRenderLimit });
  renderRemoteEntries(state.remoteEntries);
}));
el("remoteUp").addEventListener("click", () => refreshRemote(parentPath(state.remotePath)));
el("remoteBack").addEventListener("click", () => {
  const record = activeTerminal();
  if (!record || record.sftpHistoryIndex <= 0) return;
  record.sftpHistoryIndex -= 1;
  refreshRemote(record.sftpHistory[record.sftpHistoryIndex], false);
});
el("remoteForward").addEventListener("click", () => {
  const record = activeTerminal();
  if (!record || record.sftpHistoryIndex >= record.sftpHistory.length - 1) return;
  record.sftpHistoryIndex += 1;
  refreshRemote(record.sftpHistory[record.sftpHistoryIndex], false);
});
el("copyRemotePath").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.remotePath); toast("远程路径已复制", "success"); }
  catch (error) { toast(`复制路径失败：${String(error)}`, "error"); }
});
el("uploadFile").addEventListener("click", uploadFile);
el("downloadFile").addEventListener("click", downloadFile);
el("newRemote").addEventListener("click", (event) => { event.stopPropagation(); el("newRemoteMenu").classList.toggle("hidden"); });
document.querySelectorAll("[data-new-remote]").forEach((button) => button.addEventListener("click", () => {
  el("newRemoteMenu").classList.add("hidden");
  if (button.dataset.newRemote === "file") createRemoteFile(); else createFolder();
}));
el("cancelTransfer").addEventListener("click", async () => {
  const terminalId = state.activeId;
  const cancellable = [...state.transferMeta.entries()].filter(([, task]) => task.terminalId === terminalId && ["queued", "running"].includes(task.status));
  if (!cancellable.length) return;
  await Promise.all(cancellable.map(([transferId]) => cancelTransferTask(transferId).catch(() => {})));
  if (state.activeId === terminalId) el("transferText").textContent = localizeRuntimeText("传输已取消");
});
el("transferTaskList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-transfer-id]");
  if (!button) return;
  const transferId = button.dataset.cancelTransferId;
  const task = state.transferMeta.get(transferId);
  if (!task || !["queued", "running"].includes(task.status)) return;
  button.disabled = true;
  await cancelTransferTask(transferId).catch((error) => toast(String(error), "error"));
});
el("clearTransferTasks").addEventListener("click", () => {
  [...state.transferMeta.entries()].forEach(([id, task]) => {
    if (task.terminalId === state.activeId && !["queued", "running"].includes(task.status)) {
      state.transferMeta.delete(id);
      state.transferTerminals.delete(id);
    }
  });
  renderTransferTasks();
});
el("remoteFiles").addEventListener("click", (event) => {
  if (event.target.closest("[data-load-more-remote]")) {
    state.remoteRenderLimit += state.preferences.sftpPageSize;
    updateActiveRemoteUi({ renderLimit: state.remoteRenderLimit });
    renderRemoteEntries(state.remoteEntries);
    return;
  }
  selectRemoteRow(event.target.closest(".remote-row"), event);
});
el("remoteFiles").addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".remote-row");
  if (!row) return;
  event.preventDefault();
  if (!state.selectedRemotePaths.has(row.dataset.path)) selectRemoteRow(row);
  const menu = el("sftpContextMenu");
  const selectedFiles = selectedRemoteEntries();
  menu.querySelector('[data-sftp-action="open"]').classList.toggle("hidden", state.selectedRemotePaths.size !== 1);
  menu.querySelector('[data-sftp-action="download"]').classList.toggle("hidden", !selectedFiles.length);
  menu.querySelector('[data-sftp-action="rename"]').classList.toggle("hidden", state.selectedRemotePaths.size !== 1);
  menu.querySelector('[data-sftp-action="properties"]').classList.toggle("hidden", state.selectedRemotePaths.size !== 1);
  positionPopup(menu, event.clientX, event.clientY);
});
document.querySelectorAll("[data-sftp-action]").forEach((button) => button.addEventListener("click", () => runSftpAction(button.dataset.sftpAction)));
el("remoteFiles").addEventListener("dblclick", (event) => {
  const row = event.target.closest(".remote-row");
  if (!row) return;
  if (row.dataset.dir === "true") refreshRemote(row.dataset.path);
  else { selectRemoteRow(row); openRemoteEditor(); }
});
el("remoteFiles").addEventListener("keydown", (event) => {
  const row = event.target.closest(".remote-row");
  if (!row) return;
  const rows = [...el("remoteFiles").querySelectorAll(".remote-row")];
  const index = rows.indexOf(row);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    if (next) selectRemoteRow(next, event.shiftKey ? { shiftKey: true } : {});
  }
  if (event.key === "Enter") { event.preventDefault(); row.dataset.dir === "true" ? refreshRemote(row.dataset.path) : openRemoteEditor(); }
  if (event.key === "F2") { event.preventDefault(); renameRemote(); }
  if (event.key === "Delete") { event.preventDefault(); removeRemote(); }
});
el("sftpResize").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = el("sftpPanel").getBoundingClientRect().width;
  const move = (moveEvent) => setSftpWidth(startWidth + startX - moveEvent.clientX);
  const stop = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    setSftpWidth(el("sftpPanel").getBoundingClientRect().width, true);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
});
document.querySelector(".terminal-stack").addEventListener("click", (event) => {
  const unsplit = event.target.closest("[data-unsplit]");
  if (unsplit) {
    event.preventDefault();
    event.stopPropagation();
    removeFromSplit(unsplit.dataset.unsplit);
    return;
  }
  const host = event.target.closest(".terminal-host");
  if (host?.dataset.terminalId && host.dataset.terminalId !== state.activeId) activateTerminal(host.dataset.terminalId);
});
document.querySelector(".terminal-stack").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const host = event.target.closest(".terminal-host");
  if (host?.dataset.terminalId) activateTerminal(host.dataset.terminalId);
  if (state.preferences.rightClickAction === "paste") {
    void pasteTerminalClipboard();
    return;
  }
  closeMenus();
  showTerminalContextMenu(event.clientX, event.clientY);
});
el("terminalTabs").addEventListener("contextmenu", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  event.preventDefault();
  closeMenus();
  hideTerminalContextMenu();
  state.tabContextId = tab.dataset.terminalId;
  positionPopup(el("tabContextMenu"), event.clientX, event.clientY);
});
document.querySelectorAll("[data-tab-action]").forEach((item) => item.addEventListener("click", async () => {
  const id = state.tabContextId;
  const action = item.dataset.tabAction;
  hideTabContextMenu();
  if (action === "duplicate") await duplicateTerminal(id);
  if (action === "disconnect") await disconnectTerminal(id);
  if (action === "reconnect") await reconnectTerminal(id);
  if (action === "toggle-log") await toggleSessionLog(id);
  if (action === "close" && id) await closeTerminal(id);
}));
document.querySelectorAll("[data-group-action]").forEach((item) => item.addEventListener("click", async () => {
  const group = state.groupContextName;
  const action = item.dataset.groupAction;
  hideGroupMenus();
  if (!group) return;
  if (action === "new-session") {
    state.pendingSessionGroup = group;
    openSessionModal();
  }
  if (action === "rename") await renameSessionGroup(group);
  if (action === "delete") await deleteSessionGroup(group);
}));
document.querySelectorAll("[data-lib-action]").forEach((item) => item.addEventListener("click", async () => {
  const session = state.sessions.find((entry) => entry.id === state.libContextSessionId);
  const action = item.dataset.libAction;
  hideGroupMenus();
  if (!session) return;
  if (action === "connect") await connectSavedSession(session);
  if (action === "open-new") await openAdditionalSavedSession(session);
  if (action === "edit") openSessionModal(session);
  if (action === "move") await moveSessionToGroup(session);
  if (action === "delete" && await appPrompt({ title: tr("删除会话", "Delete session"), message: tr(`确定删除会话“${session.name}”吗？`, `Delete session “${session.name}”?`), input: false, confirmText: tr("删除", "Delete") })) {
    await invoke("credential_delete", { sessionId: session.id }).catch(() => {});
    state.sessions = state.sessions.filter((entry) => entry.id !== session.id);
    persistSessions();
    renderSessions();
  }
}));
document.querySelectorAll("[data-terminal-context-action]").forEach((item) => {
  item.addEventListener("click", () => runTerminalContextAction(item.dataset.terminalContextAction));
});
document.querySelectorAll(".menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const root = trigger.closest(".menu-root");
    const wasOpen = root.classList.contains("open");
    closeMenus();
    root.classList.toggle("open", !wasOpen);
    trigger.setAttribute("aria-expanded", String(!wasOpen));
    if (!wasOpen) {
      updateMenuStates();
      root.querySelector(".menu-popup button:not(:disabled)")?.focus({ preventScroll: true });
    }
  });
  trigger.closest(".menu-root").addEventListener("mouseenter", () => {
    if (document.querySelector(".menu-root.open")) {
      closeMenus();
      trigger.closest(".menu-root").classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      updateMenuStates();
    }
  });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    closeMenus();
    const root = trigger.closest(".menu-root");
    root.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    updateMenuStates();
    root.querySelector(".menu-popup button:not(:disabled)")?.focus();
  });
});
document.querySelectorAll(".menu-popup").forEach((popup) => popup.addEventListener("keydown", (event) => {
  const items = [...popup.querySelectorAll("button:not(:disabled)")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    const trigger = popup.closest(".menu-root").querySelector(".menu-trigger");
    closeMenus();
    trigger.focus();
  }
}));
document.querySelectorAll("[data-menu-action]").forEach((item) => item.addEventListener("click", () => runMenuAction(item.dataset.menuAction)));
document.addEventListener("click", (event) => {
  closeMenus();
  if (!event.target.closest("#terminalContextMenu")) hideTerminalContextMenu();
  if (!event.target.closest("#tabContextMenu")) hideTabContextMenu();
  if (!event.target.closest("#groupContextMenu,#sessionLibContextMenu")) hideGroupMenus();
  if (!event.target.closest("#sftpContextMenu,#newRemoteMenu,#newRemote")) hideSftpMenus();
});
window.addEventListener("blur", () => { hideTerminalContextMenu(); hideTabContextMenu(); hideGroupMenus(); });
window.addEventListener("resize", () => {
  setSftpWidth(state.preferences.sftpWidth);
  setDrawerWidth("tail", state.preferences.tailWidth);
  setDrawerWidth("manual", state.preferences.manualWidth);
  fitVisibleTerminals();
});
window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const inTerminal = Boolean(event.target.closest?.(".xterm"));
  const inFormField = Boolean(event.target.closest?.("input, textarea, select, [contenteditable='true']")) && !inTerminal;
  if (!el("editorModal").classList.contains("hidden") && event.ctrlKey && key === "s") { event.preventDefault(); if (!el("saveRemoteEditor").disabled) saveRemoteEditor(); return; }
  if (!el("editorModal").classList.contains("hidden") && event.ctrlKey && key === "f") { event.preventDefault(); el("editorFind").classList.remove("hidden"); el("editorFindInput").focus(); el("editorFindInput").select(); return; }
  if (!inFormField && event.ctrlKey && event.altKey && event.key === "]") { event.preventDefault(); if (state.activeId) closeTerminal(state.activeId); return; }
  if (!inFormField && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); openSessionModal(); }
  if (!inFormField && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "w") { event.preventDefault(); if (state.activeId) closeTerminal(state.activeId); }
  if (!inFormField && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "g") { event.preventDefault(); showFindBar(); }
  if (!inFormField && event.ctrlKey && event.shiftKey && key === "c") { event.preventDefault(); copyTerminalSelection(); }
  if (!inFormField && event.ctrlKey && event.shiftKey && key === "v") { event.preventDefault(); pasteTerminalClipboard(); }
  if (!inFormField && event.ctrlKey && event.shiftKey && key === "a") { event.preventDefault(); activeTerminal()?.terminal.selectAll(); }
  if (!inFormField && event.ctrlKey && event.shiftKey && key === "f") { event.preventDefault(); toggleSftp(); }
  if (!inFormField && event.ctrlKey && event.key === "PageUp") { event.preventDefault(); activateAdjacentTerminal(-1); }
  if (!inFormField && event.ctrlKey && event.key === "PageDown") { event.preventDefault(); activateAdjacentTerminal(1); }
  if (!inFormField && event.ctrlKey && !event.shiftKey && key === "k") { event.preventDefault(); el("paletteOverlay").classList.contains("open") ? closePalette() : openPalette(); }
  if (!inFormField && event.ctrlKey && !event.shiftKey && key === "e") { event.preventDefault(); toggleSftp(); }
  if (!inFormField && event.ctrlKey && !event.shiftKey && key === "n") { event.preventDefault(); openSessionModal(); }
  if (event.ctrlKey && !event.shiftKey && key === "b" && !event.target.closest("input, textarea, select")) { event.preventDefault(); runMenuAction("toggle-sidebar"); }
  if (event.key === "Escape" && el("paletteOverlay").classList.contains("open")) { event.preventDefault(); closePalette(); return; }
  if (event.key === "F11") { event.preventDefault(); runMenuAction("fullscreen"); }
  if (event.key === "Escape" && !el("settingsModal").classList.contains("hidden")) closeSettingsModal();
  else if (event.key === "Escape" && !el("helpModal").classList.contains("hidden")) closeHelpModal();
  else if (event.key === "Escape" && !el("editorModal").classList.contains("hidden")) void closeRemoteEditor();
  else if (event.key === "Escape" && ["sftp", "tail", "manual"].includes(state.drawerByTerminal.get(state.activeId))) setActiveDrawer(null);
  else if (event.key === "Escape" && !el("sessionModal").classList.contains("hidden")) closeSessionModal();
  else if (event.key === "Escape") { closeMenus(); hideTerminalContextMenu(); hideTabContextMenu(); hideGroupMenus(); hideSftpMenus(); }
  if (event.key === "F5" && !el("sftpPanel").classList.contains("hidden")) { event.preventDefault(); refreshRemote(); }
});

if (isTauri) {
  appWindow.onDragDropEvent(({ payload }) => {
    if (payload.type === "drop") {
      if (el("sftpPanel").classList.contains("hidden")) return toast("请先打开 SFTP 文件管理器", "error");
      void uploadPaths(payload.paths);
    }
  }).catch(() => {});
  appWindow.onCloseRequested((event) => {
    event.preventDefault();
    void requestAppClose();
  }).catch(() => {});
  listen("transfer-progress", ({ payload }) => {
    if (!state.activeTransferIds.has(payload.transferId)) return;
    const meta = state.transferMeta.get(payload.transferId) || { prefix: "", name: "文件", startedAt: performance.now() };
    meta.transferred = payload.transferred;
    meta.total = payload.total || meta.total || 0;
    state.transferMeta.set(payload.transferId, meta);
    state.activeTransferId = payload.transferId;
    meta.status = "running";
    scheduleTransferProgressRender();
  }).catch(() => {});
}

renderSessions();
applyAppAppearance();
updateTerminalSchemePicker();
updateActiveStatus();
setSftpWidth(state.preferences.sftpWidth);
setDrawerWidth("tail", state.preferences.tailWidth);
setDrawerWidth("manual", state.preferences.manualWidth);
document.querySelectorAll("[data-resize-drawer]").forEach(installDrawerResize);
updateSftpControls();
updateTailModeUi();
setSidebarCollapsed(Boolean(state.preferences.sidebarCollapsed));
void revealMainWindow();
void restoreOpenSessions();
