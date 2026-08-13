# Orbiterm

基于 Tauri 2、Rust、xterm.js 和 libssh2 的 SSH/SFTP 桌面客户端。

最初的单文件 HTML 原型已完整保存在 [`prototype/index-original.html`](prototype/index-original.html)，应用入口使用根目录的 Vite `index.html`。

## 已实现

- 密码、OpenSSH 私钥和 SSH Agent 认证
- 首次连接主机指纹确认，已知主机指纹变更告警
- 真实交互式 PTY、多终端标签、终端自适应尺寸
- SSH keepalive、断线/退出码识别、后台非阻塞 I/O 和兼容 vim 的 bracketed paste
- 多行粘贴安全确认、可选会话日志记录
- 终端内容查找、浅色/深色终端主题和字体大小设置
- 会话分组、搜索、编辑和本地保存（不保存密码）
- 独立 SFTP 连接，不阻塞终端输入输出
- SFTP 悬浮文件面板、可调宽度、会话目录记忆、目录浏览、上传、下载、新建目录、删除文件或空目录
- 上传同名文件覆盖确认，SFTP 请求防串会话，传输期间防止重复操作
- 传输实时进度、速度显示和取消，临时文件完成后原子替换（失败或取消不污染目标文件）
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

会话参数和首次确认的 SSH 主机指纹保存在 WebView 本地存储中。密码和私钥口令只在本次连接中传给 Rust 后端，不会持久化。上传、下载和删除均由用户显式触发。
