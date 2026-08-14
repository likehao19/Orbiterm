# Orbiterm

基于 Tauri 2、Rust、xterm.js 和 libssh2 的跨平台 SSH/SFTP 桌面客户端，支持 Windows、macOS 和 Linux。

最初的单文件 HTML 原型已完整保存在 [`prototype/index-original.html`](prototype/index-original.html)，应用入口使用根目录的 Vite `index.html`。

## 已实现

- 密码、OpenSSH 私钥和 SSH Agent 认证
- 首次连接主机指纹确认，已知主机指纹变更告警
- 真实交互式 PTY、多终端标签、终端自适应尺寸
- SSH keepalive、断线/退出码识别、后台非阻塞 I/O 和兼容 vim 的 bracketed paste
- 多行粘贴安全确认、可选会话日志记录
- 终端内容查找、浅色/深色终端主题和字体大小设置
- 会话分组、搜索、编辑和本地保存（不保存密码）
- 会话配置与凭据分离：配置可导入导出，密码保存在系统安全凭据库
- 本地终端：Windows 使用 PowerShell，macOS/Linux 使用用户默认 Shell
- 独立 SFTP 连接，不阻塞终端输入输出
- SFTP 悬浮文件面板、可调宽度、会话目录记忆、目录浏览、上传、下载、新建目录、删除文件或空目录
- 上传同名文件覆盖确认，SFTP 请求防串会话，传输期间防止重复操作
- 多任务传输列表，逐文件显示进度、速度和状态，支持单项取消与全部取消；临时文件完成后原子替换（失败或取消不污染目标文件）
- 复制、粘贴、清屏、重连和常用快捷键

## 开发与构建

```powershell
npm install
npm run tauri dev
```

仅构建可执行文件：

```powershell
npm run tauri -- build --debug --no-bundle
```

构建安装包：

```powershell
npm run tauri build
```

## 安全说明

会话参数和 SSH 主机指纹保存在 WebView 本地存储中。勾选“记住密码”后，密码分别保存到 Windows Credential Manager、macOS Keychain 或 Linux Secret Service；私钥口令只保留在当前应用进程内。导出的会话文件不包含密码，导入导出路径由系统文件选择器确定。上传、下载和删除均由用户显式触发。

目录下载会先写入目标目录旁的临时目录，全部完成后再整体替换；失败或取消会清理临时内容，不会留下半成品目标目录。

## 测试

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```
