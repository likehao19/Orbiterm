use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::{Channel, FileStat, RenameFlags, Session, Sftp};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

mod session_files;
use session_files::{export_session_bundle, import_session_bundle};

type SharedConnection = Arc<Mutex<SshConnection>>;
type SharedSftp = Arc<Mutex<Sftp>>;

#[derive(Default)]
struct AppState {
    connections: Mutex<HashMap<String, SharedConnection>>,
    local_terminals: Mutex<HashMap<String, Arc<Mutex<LocalTerminal>>>>,
    sftp_connections: Mutex<HashMap<String, SharedSftp>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    logs: Mutex<HashMap<String, File>>,
}

struct LocalTerminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: Receiver<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    eof: bool,
}

struct SshConnection {
    session: Session,
    channel: Channel,
    auth: AuthConfig,
    next_keepalive: Instant,
}

const REMOTE_EDITOR_MAX_BYTES: u64 = 16 * 1024 * 1024;
const REMOTE_COMMAND_MAX_BYTES: u64 = 4 * 1024 * 1024;
const TAIL_READ_CHUNK_BYTES: u64 = 512 * 1024;
const MAX_DOWNLOAD_TREE_DEPTH: usize = 128;

struct CancelNetworkGuard {
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for CancelNetworkGuard {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().ok();
        }
    }
}

#[derive(Clone)]
struct AuthConfig {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    expected_fingerprint: String,
    timeout_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    host: String,
    port: u16,
    timeout_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectRequest {
    id: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    expected_fingerprint: String,
    terminal_type: Option<String>,
    shell_command: Option<String>,
    cols: u32,
    rows: u32,
    timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeInfo {
    fingerprint: String,
    key_type: String,
    latency_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
    permissions: u32,
    owner: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePathInfo {
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProperties {
    size: u64,
    files: u64,
    directories: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TailAppend {
    content: String,
    offset: u64,
    reset: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileContent {
    encoding: String,
    content: String,
    size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRead {
    data: Vec<u8>,
    eof: bool,
    exit_status: Option<i32>,
    log_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    transferred: u64,
    total: u64,
}

fn join_blocking<T>(result: Result<Result<T, String>, tauri::Error>) -> Result<T, String> {
    result.map_err(|error| format!("后台任务失败：{error}"))?
}

fn open_session_with_cancel(
    host: &str,
    port: u16,
    timeout_seconds: u64,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(Session, u128, Option<CancelNetworkGuard>), String> {
    let addresses = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机：{error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("主机没有可用地址".to_string());
    }
    let timeout = Duration::from_secs(timeout_seconds.clamp(1, 300));
    let started = Instant::now();
    let mut last_error = None;
    let mut tcp = None;
    if let Some(cancel) = cancel.as_ref() {
        let deadline = Instant::now() + timeout;
        let mut pending = addresses.clone();
        while tcp.is_none() && !pending.is_empty() && Instant::now() < deadline {
            let mut timed_out = Vec::new();
            for address in pending {
                if cancel.load(Ordering::Relaxed) {
                    return Err("传输已取消".to_string());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let attempt_timeout = remaining.min(Duration::from_millis(500));
                match TcpStream::connect_timeout(&address, attempt_timeout) {
                    Ok(stream) => {
                        tcp = Some(stream);
                        break;
                    }
                    Err(error) => {
                        if error.kind() == std::io::ErrorKind::TimedOut {
                            timed_out.push(address);
                        }
                        last_error = Some(error);
                    }
                }
            }
            pending = timed_out;
        }
    } else {
        let deadline = Instant::now() + timeout;
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match TcpStream::connect_timeout(&address, remaining) {
                Ok(stream) => {
                    tcp = Some(stream);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
    }
    let tcp = tcp.ok_or_else(|| {
        format!(
            "无法连接 {host}:{port}：{}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "未知网络错误".to_string())
        )
    })?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("无法启用 SSH 低延迟模式：{error}"))?;

    let cancel_guard = if let Some(cancel) = cancel {
        let interrupt = tcp
            .try_clone()
            .map_err(|error| format!("无法创建传输取消句柄：{error}"))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let worker = thread::spawn(move || {
            while !worker_stopped.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    interrupt.shutdown(Shutdown::Both).ok();
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        });
        Some(CancelNetworkGuard {
            stopped,
            worker: Some(worker),
        })
    } else {
        None
    };

    let mut session = Session::new().map_err(|error| format!("SSH 初始化失败：{error}"))?;
    session.set_timeout(timeout.as_millis().min(u32::MAX as u128) as u32);
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;
    Ok((session, started.elapsed().as_millis(), cancel_guard))
}

fn open_session(host: &str, port: u16, timeout_seconds: u64) -> Result<(Session, u128), String> {
    let (session, latency_ms, _) = open_session_with_cancel(host, port, timeout_seconds, None)?;
    Ok((session, latency_ms))
}

#[tauri::command]
fn local_terminal_open(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法创建本地终端：{error}"))?;

    let shell = default_local_shell();
    let mut command = CommandBuilder::new(&shell);
    #[cfg(windows)]
    command.arg("-NoLogo");
    #[cfg(unix)]
    command.arg("-l");
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        command.cwd(home);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("无法启动 {}：{error}", shell.display()))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取本地终端：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("无法写入本地终端：{error}"))?;
    let (output_tx, output_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if output_tx.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    state
        .local_terminals
        .lock()
        .map_err(|_| "本地终端管理器已损坏".to_string())?
        .insert(
            id,
            Arc::new(Mutex::new(LocalTerminal {
                master: pair.master,
                writer,
                output: output_rx,
                child,
                eof: false,
            })),
        );
    Ok(shell
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Shell")
        .to_string())
}

#[cfg(windows)]
fn default_local_shell() -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join("pwsh.exe"))
                .find(|path| path.is_file())
        })
        .or_else(|| {
            std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .map(|path| path.join("PowerShell").join("7").join("pwsh.exe"))
                .filter(|path| path.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

#[cfg(unix)]
fn default_local_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .filter(|shell| shell.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

fn get_local_terminal(
    id: &str,
    state: &State<'_, AppState>,
) -> Result<Arc<Mutex<LocalTerminal>>, String> {
    state
        .local_terminals
        .lock()
        .map_err(|_| "本地终端管理器已损坏".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "本地终端不存在或已关闭".to_string())
}

#[tauri::command]
fn local_terminal_read(id: String, state: State<'_, AppState>) -> Result<TerminalRead, String> {
    let terminal = get_local_terminal(&id, &state)?;
    let mut terminal = terminal.lock().map_err(|_| "本地终端已损坏".to_string())?;
    let mut output = Vec::new();
    loop {
        match terminal.output.try_recv() {
            Ok(chunk) => {
                output.extend(chunk);
                if output.len() >= 128 * 1024 {
                    break;
                }
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                terminal.eof = true;
                break;
            }
        }
    }
    let exit_status = terminal
        .child
        .try_wait()
        .ok()
        .flatten()
        .map(|status| status.exit_code() as i32);
    if exit_status.is_some() {
        terminal.eof = true;
    }
    Ok(TerminalRead {
        data: output,
        eof: terminal.eof,
        exit_status,
        log_error: None,
    })
}

#[tauri::command]
fn local_terminal_write(
    id: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminal = get_local_terminal(&id, &state)?;
    let mut terminal = terminal.lock().map_err(|_| "本地终端已损坏".to_string())?;
    terminal
        .writer
        .write_all(&data)
        .and_then(|_| terminal.writer.flush())
        .map_err(|error| format!("写入本地终端失败：{error}"))
}

#[tauri::command]
fn local_terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminal = get_local_terminal(&id, &state)?;
    let result = terminal
        .lock()
        .map_err(|_| "本地终端已损坏".to_string())?
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整本地终端尺寸失败：{error}"));
    result
}

#[tauri::command]
fn local_terminal_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(terminal) = state
        .local_terminals
        .lock()
        .map_err(|_| "本地终端管理器已损坏".to_string())?
        .remove(&id)
    {
        if let Ok(mut terminal) = terminal.lock() {
            terminal.child.kill().ok();
        }
    }
    Ok(())
}

fn credential_entry(session_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Orbiterm SSH", session_id)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

#[tauri::command]
fn credential_get(session_id: String) -> Result<Option<String>, String> {
    match credential_entry(&session_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取已保存密码：{error}")),
    }
}

#[tauri::command]
fn credential_set(session_id: String, password: String) -> Result<(), String> {
    credential_entry(&session_id)?
        .set_password(&password)
        .map_err(|error| format!("无法保存密码：{error}"))
}

#[tauri::command]
fn credential_delete(session_id: String) -> Result<(), String> {
    match credential_entry(&session_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除已保存密码：{error}")),
    }
}

fn fingerprint(session: &Session) -> Result<String, String> {
    let (key, _) = session
        .host_key()
        .ok_or_else(|| "服务器未提供主机密钥".to_string())?;
    let digest = Sha256::digest(key);
    Ok(format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)))
}

fn authenticate(session: &Session, auth: &AuthConfig) -> Result<(), String> {
    match auth.auth_type.as_str() {
        "password" => session
            .userauth_password(&auth.username, auth.password.as_deref().unwrap_or_default())
            .map_err(|error| format!("密码认证失败：{error}"))?,
        "publickey" => {
            let key = auth
                .private_key
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "请选择私钥文件".to_string())?;
            session
                .userauth_pubkey_file(
                    &auth.username,
                    None,
                    Path::new(key),
                    auth.passphrase.as_deref().filter(|value| !value.is_empty()),
                )
                .map_err(|error| format!("私钥认证失败：{error}"))?;
        }
        "agent" => {
            let mut agent = session
                .agent()
                .map_err(|error| format!("无法连接 SSH Agent：{error}"))?;
            agent
                .connect()
                .map_err(|error| format!("SSH Agent 连接失败：{error}"))?;
            agent
                .list_identities()
                .map_err(|error| format!("无法读取 SSH Agent 密钥：{error}"))?;
            let mut authenticated = false;
            for identity in agent.identities().map_err(|error| error.to_string())? {
                if agent.userauth(&auth.username, &identity).is_ok() {
                    authenticated = true;
                    break;
                }
            }
            if !authenticated {
                return Err("SSH Agent 中没有可用的认证密钥".to_string());
            }
        }
        _ => return Err("不支持的认证方式".to_string()),
    }
    if !session.authenticated() {
        return Err("服务器拒绝了认证".to_string());
    }
    Ok(())
}

fn open_authenticated_session(auth: &AuthConfig) -> Result<(Session, u128), String> {
    let (session, latency_ms) = open_session(&auth.host, auth.port, auth.timeout_seconds)?;
    let actual_fingerprint = fingerprint(&session)?;
    if auth.expected_fingerprint != actual_fingerprint {
        return Err(format!(
            "主机指纹不匹配。预期 {}，实际 {}",
            auth.expected_fingerprint, actual_fingerprint
        ));
    }
    authenticate(&session, auth)?;
    session.set_keepalive(true, 15);
    Ok((session, latency_ms))
}

fn open_authenticated_session_with_cancel(
    auth: &AuthConfig,
    cancel: Arc<AtomicBool>,
) -> Result<(Session, u128), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("传输已取消".to_string());
    }
    let opened = open_session_with_cancel(
        &auth.host,
        auth.port,
        auth.timeout_seconds,
        Some(cancel.clone()),
    );
    let (session, latency_ms, guard) = match opened {
        Ok(opened) => opened,
        Err(_) if cancel.load(Ordering::Relaxed) => return Err("传输已取消".to_string()),
        Err(error) => return Err(error),
    };
    let result = (|| {
        let actual_fingerprint = fingerprint(&session)?;
        if auth.expected_fingerprint != actual_fingerprint {
            return Err(format!(
                "主机指纹不匹配。预期 {}，实际 {}",
                auth.expected_fingerprint, actual_fingerprint
            ));
        }
        authenticate(&session, auth)?;
        session.set_keepalive(true, 15);
        Ok((session, latency_ms))
    })();
    drop(guard);
    if cancel.load(Ordering::Relaxed) {
        Err("传输已取消".to_string())
    } else {
        result
    }
}

#[tauri::command]
async fn probe_host(request: ProbeRequest) -> Result<ProbeInfo, String> {
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let (session, latency_ms) = open_session(
                request.host.trim(),
                request.port,
                request.timeout_seconds.unwrap_or(15),
            )?;
            let key_type = session
                .host_key()
                .map(|(_, kind)| format!("{kind:?}"))
                .unwrap_or_else(|| "Unknown".to_string());
            Ok(ProbeInfo {
                fingerprint: fingerprint(&session)?,
                key_type,
                latency_ms,
            })
        })
        .await,
    )
}

#[tauri::command]
async fn ssh_connect(
    request: ConnectRequest,
    state: State<'_, AppState>,
) -> Result<ProbeInfo, String> {
    let (id, info, connection) = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let auth = AuthConfig {
                host: request.host.trim().to_string(),
                port: request.port,
                username: request.username.clone(),
                auth_type: request.auth_type.clone(),
                password: request.password.clone(),
                private_key: request.private_key.clone(),
                passphrase: request.passphrase.clone(),
                expected_fingerprint: request.expected_fingerprint.clone(),
                timeout_seconds: request.timeout_seconds.unwrap_or(20),
            };
            let (session, latency_ms) = open_authenticated_session(&auth)?;
            let actual_fingerprint = fingerprint(&session)?;
            let mut channel = session
                .channel_session()
                .map_err(|error| format!("无法创建终端通道：{error}"))?;
            let terminal = request.terminal_type.as_deref().unwrap_or("xterm-256color");
            channel
                .request_pty(terminal, None, Some((request.cols, request.rows, 0, 0)))
                .map_err(|error| format!("无法申请 PTY：{error}"))?;
            if let Some(command) = request
                .shell_command
                .as_deref()
                .map(str::trim)
                .filter(|command| !command.is_empty())
            {
                channel
                    .exec(command)
                    .map_err(|error| format!("无法启动指定 Shell：{error}"))?;
            } else {
                channel
                    .shell()
                    .map_err(|error| format!("无法启动 Shell：{error}"))?;
            }
            session.set_timeout(0);
            session.set_blocking(false);
            let key_type = session
                .host_key()
                .map(|(_, kind)| format!("{kind:?}"))
                .unwrap_or_else(|| "Unknown".to_string());
            let connection = Arc::new(Mutex::new(SshConnection {
                session,
                channel,
                auth,
                next_keepalive: Instant::now() + Duration::from_secs(15),
            }));
            Ok((
                request.id,
                ProbeInfo {
                    fingerprint: actual_fingerprint,
                    key_type,
                    latency_ms,
                },
                connection,
            ))
        })
        .await,
    )?;
    state
        .connections
        .lock()
        .map_err(|_| "连接管理器已损坏".to_string())?
        .insert(id, connection);
    Ok(info)
}

fn get_connection(id: &str, state: &State<'_, AppState>) -> Result<SharedConnection, String> {
    state
        .connections
        .lock()
        .map_err(|_| "连接管理器已损坏".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "连接不存在或已关闭".to_string())
}

#[tauri::command]
async fn ssh_read(id: String, state: State<'_, AppState>) -> Result<TerminalRead, String> {
    let connection = get_connection(&id, &state)?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let mut connection = connection.lock().map_err(|_| "连接已损坏".to_string())?;
            let mut output = Vec::new();
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match connection.channel.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        output.extend_from_slice(&buffer[..count]);
                        if output.len() >= 128 * 1024 {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(format!("读取终端失败：{error}")),
                }
            }
            if Instant::now() >= connection.next_keepalive {
                match connection.session.keepalive_send() {
                    Ok(seconds) => {
                        connection.next_keepalive =
                            Instant::now() + Duration::from_secs(seconds.max(1) as u64)
                    }
                    Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                        connection.next_keepalive = Instant::now() + Duration::from_secs(1)
                    }
                    Err(error) => return Err(format!("SSH keepalive 失败：{error}")),
                }
            }
            let eof = connection.channel.eof();
            let exit_status = if eof {
                connection.channel.exit_status().ok()
            } else {
                None
            };
            Ok(TerminalRead {
                data: output,
                eof,
                exit_status,
                log_error: None,
            })
        })
        .await,
    )?;
    let mut result = result;
    if !result.data.is_empty() {
        let mut logs = state
            .logs
            .lock()
            .map_err(|_| "日志管理器已损坏".to_string())?;
        let write_error = logs
            .get_mut(&id)
            .and_then(|log| log.write_all(&result.data).and_then(|_| log.flush()).err());
        if let Some(error) = write_error {
            logs.remove(&id);
            result.log_error = Some(format!("会话日志已停止：{error}"));
        }
    }
    Ok(result)
}

#[tauri::command]
async fn ssh_write(id: String, data: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    let connection = get_connection(&id, &state)?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let mut connection = connection.lock().map_err(|_| "连接已损坏".to_string())?;
            let mut offset = 0;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut transport_retries = 0;
            while offset < data.len() {
                match connection.channel.write(&data[offset..]) {
                    Ok(0) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
                    Ok(0) => return Err("终端写入超时".to_string()),
                    Ok(count) => {
                        offset += count;
                        transport_retries = 0;
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        return Err("终端写入缓冲区超时".to_string());
                    }
                    Err(error)
                        if retryable_terminal_transport_error(&error)
                            && transport_retries < 4
                            && Instant::now() < deadline =>
                    {
                        transport_retries += 1;
                        thread::sleep(Duration::from_millis(10 * transport_retries));
                    }
                    Err(error) => return Err(format!("写入终端失败：{error}")),
                }
            }
            let mut flush_retries = 0;
            loop {
                match connection.channel.flush() {
                    Ok(()) => break,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        return Err("刷新终端输出超时".to_string());
                    }
                    Err(error)
                        if retryable_terminal_transport_error(&error)
                            && flush_retries < 4
                            && Instant::now() < deadline =>
                    {
                        flush_retries += 1;
                        thread::sleep(Duration::from_millis(10 * flush_retries));
                    }
                    Err(error) => return Err(format!("刷新终端输出失败：{error}")),
                }
            }
            Ok(())
        })
        .await,
    )
}

fn retryable_terminal_transport_error(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Interrupted {
        return true;
    }
    let message = error.to_string().to_ascii_lowercase();
    message.contains("failure while draining incoming flow")
}

#[tauri::command]
fn ssh_resize(id: String, cols: u32, rows: u32, state: State<'_, AppState>) -> Result<(), String> {
    let connection = get_connection(&id, &state)?;
    let result = connection
        .lock()
        .map_err(|_| "连接已损坏".to_string())?
        .channel
        .request_pty_size(cols, rows, None, None)
        .map_err(|error| format!("调整终端尺寸失败：{error}"));
    result
}

#[tauri::command]
fn ssh_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .logs
        .lock()
        .map_err(|_| "日志管理器已损坏".to_string())?
        .remove(&id);
    state
        .sftp_connections
        .lock()
        .map_err(|_| "SFTP 连接管理器已损坏".to_string())?
        .remove(&id);
    if let Some(connection) = state
        .connections
        .lock()
        .map_err(|_| "连接管理器已损坏".to_string())?
        .remove(&id)
    {
        if let Ok(mut connection) = connection.lock() {
            connection.channel.close().ok();
        }
    }
    Ok(())
}

#[tauri::command]
fn session_log_start(id: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    get_connection(&id, &state)?;
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("无法打开日志文件：{error}"))?;
    writeln!(
        log,
        "\r\n===== Orbiterm session log started {:?} =====\r",
        std::time::SystemTime::now()
    )
    .map_err(|error| format!("无法写入日志文件：{error}"))?;
    state
        .logs
        .lock()
        .map_err(|_| "日志管理器已损坏".to_string())?
        .insert(id, log);
    Ok(())
}

#[tauri::command]
fn session_log_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(mut log) = state
        .logs
        .lock()
        .map_err(|_| "日志管理器已损坏".to_string())?
        .remove(&id)
    {
        writeln!(
            log,
            "\r\n===== Orbiterm session log stopped {:?} =====\r",
            std::time::SystemTime::now()
        )
        .ok();
        log.flush().ok();
    }
    Ok(())
}

fn remote_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn remote_transfer_path(path: &str, transfer_id: &str) -> String {
    format!("{path}.orbiterm-part-{transfer_id}")
}

#[tauri::command]
async fn sftp_read_text(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<RemoteFileContent, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            let mut file = sftp
                .open(Path::new(&path))
                .map_err(|error| format!("无法打开远程文件：{error}"))?;
            if let Some(size) = file.stat().ok().and_then(|stat| stat.size) {
                if size > REMOTE_EDITOR_MAX_BYTES {
                    return Err(format!(
                        "远程文件过大，编辑器最多打开 {} MB",
                        REMOTE_EDITOR_MAX_BYTES / 1024 / 1024
                    ));
                }
            }
            let mut bytes = Vec::new();
            std::io::Read::take(&mut file, REMOTE_EDITOR_MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("读取远程文件失败：{error}"))?;
            if bytes.len() as u64 > REMOTE_EDITOR_MAX_BYTES {
                return Err(format!(
                    "远程文件过大，编辑器最多打开 {} MB",
                    REMOTE_EDITOR_MAX_BYTES / 1024 / 1024
                ));
            }
            let size = bytes.len();
            match String::from_utf8(bytes) {
                Ok(content) => Ok(RemoteFileContent {
                    encoding: "utf8".to_string(),
                    content,
                    size,
                }),
                Err(error) => Ok(RemoteFileContent {
                    encoding: "binary".to_string(),
                    content: STANDARD_NO_PAD.encode(error.into_bytes()),
                    size,
                }),
            }
        })
        .await,
    )
}

#[tauri::command]
async fn sftp_write_text(
    id: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            let temp_path = remote_transfer_path(&path, "editor");
            let backup_path = format!("{path}.orbiterm-backup-editor");
            let original_permissions = sftp.stat(Path::new(&path)).ok().and_then(|stat| stat.perm);
            let result = (|| {
                let mut target = sftp
                    .create(Path::new(&temp_path))
                    .map_err(|error| format!("无法创建远程临时文件：{error}"))?;
                target
                    .write_all(content.as_bytes())
                    .map_err(|error| format!("保存远程文件失败：{error}"))?;
                target
                    .flush()
                    .map_err(|error| format!("刷新远程文件失败：{error}"))?;
                drop(target);
                if let Some(permissions) = original_permissions {
                    sftp.setstat(
                        Path::new(&temp_path),
                        FileStat {
                            size: None,
                            uid: None,
                            gid: None,
                            perm: Some(permissions),
                            atime: None,
                            mtime: None,
                        },
                    )
                    .map_err(|error| format!("保留远程文件权限失败：{error}"))?;
                }
                if sftp
                    .rename(
                        Path::new(&temp_path),
                        Path::new(&path),
                        Some(RenameFlags::OVERWRITE | RenameFlags::ATOMIC),
                    )
                    .or_else(|_| {
                        sftp.rename(
                            Path::new(&temp_path),
                            Path::new(&path),
                            Some(RenameFlags::OVERWRITE),
                        )
                    })
                    .is_ok()
                {
                    return Ok(());
                }

                sftp.unlink(Path::new(&backup_path)).ok();
                sftp.rename(Path::new(&path), Path::new(&backup_path), None)
                    .map_err(|error| format!("备份远程原文件失败：{error}"))?;
                if let Err(error) = sftp.rename(Path::new(&temp_path), Path::new(&path), None) {
                    sftp.rename(Path::new(&backup_path), Path::new(&path), None)
                        .ok();
                    return Err(format!("提交远程文件失败：{error}"));
                }
                sftp.unlink(Path::new(&backup_path)).ok();
                Ok(())
            })();
            if result.is_err() {
                sftp.unlink(Path::new(&temp_path)).ok();
            }
            result
        })
        .await,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn run_remote_command(auth: &AuthConfig, command: &str) -> Result<String, String> {
    let (session, _) = open_authenticated_session(auth)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建命令通道：{error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("无法执行远程命令：{error}"))?;
    let mut output = String::new();
    std::io::Read::take(&mut channel, REMOTE_COMMAND_MAX_BYTES + 1)
        .read_to_string(&mut output)
        .map_err(|error| format!("读取远程命令输出失败：{error}"))?;
    if output.len() as u64 > REMOTE_COMMAND_MAX_BYTES {
        return Err(format!(
            "远程命令输出超过 {} MB，已停止读取",
            REMOTE_COMMAND_MAX_BYTES / 1024 / 1024
        ));
    }
    channel.wait_close().ok();
    Ok(output)
}

#[tauri::command]
async fn ssh_monitor(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let auth = get_connection(&id, &state)?
        .lock()
        .map_err(|_| "连接已损坏".to_string())?
        .auth
        .clone();
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            run_remote_command(
                &auth,
                "printf 'LOAD='; cut -d' ' -f1-3 /proc/loadavg 2>/dev/null; printf 'MEM='; free -m 2>/dev/null | awk '/Mem:/{printf \"%s/%s MB\\n\",$3,$2}'; printf 'DISK='; df -hP / 2>/dev/null | awk 'NR==2{printf \"%s/%s (%s)\\n\",$3,$2,$5}'; printf 'PROC='; ps -e --no-headers 2>/dev/null | wc -l",
            )
        })
        .await,
    )
}

#[tauri::command]
async fn ssh_tail(
    id: String,
    path: String,
    lines: Option<u32>,
    from_start: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let auth = get_connection(&id, &state)?
        .lock()
        .map_err(|_| "连接已损坏".to_string())?
        .auth
        .clone();
    let command = if let Some(lines) = lines {
        let count = lines.clamp(1, 100_000);
        if from_start {
            format!("head -n {count} -- {}", shell_quote(&path))
        } else {
            format!("tail -n {count} -- {}", shell_quote(&path))
        }
    } else {
        format!("tail -- {}", shell_quote(&path))
    };
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || run_remote_command(&auth, &command)).await,
    )
}

fn suffixed_local_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn replace_local_file(temp: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    if target.exists() {
        if !target.is_file() {
            return Err("目标路径不是普通文件".to_string());
        }
        std::fs::rename(target, backup).map_err(|error| format!("无法备份原文件：{error}"))?;
        if let Err(error) = std::fs::rename(temp, target) {
            if let Err(restore_error) = std::fs::rename(backup, target) {
                return Err(format!(
                    "无法替换下载文件：{error}；恢复原文件也失败：{restore_error}（备份位于 {}）",
                    backup.display()
                ));
            }
            return Err(format!("无法替换下载文件：{error}"));
        }
        std::fs::remove_file(backup).map_err(|error| {
            format!(
                "下载文件已保存，但无法删除备份 {}：{error}",
                backup.display()
            )
        })?;
    } else {
        std::fs::rename(temp, target).map_err(|error| format!("无法保存下载文件：{error}"))?;
    }
    Ok(())
}

fn replace_local_directory(temp: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    if !temp.is_dir() {
        return Err("下载的临时目录不存在".to_string());
    }
    if target.exists() {
        if !target.is_dir() {
            return Err("目标路径不是目录".to_string());
        }
        std::fs::rename(target, backup).map_err(|error| format!("无法备份原目录：{error}"))?;
        if let Err(error) = std::fs::rename(temp, target) {
            if let Err(restore_error) = std::fs::rename(backup, target) {
                return Err(format!(
                    "无法替换下载目录：{error}；恢复原目录也失败：{restore_error}（备份位于 {}）",
                    backup.display()
                ));
            }
            return Err(format!("无法替换下载目录：{error}"));
        }
        std::fs::remove_dir_all(backup).map_err(|error| {
            format!(
                "下载目录已保存，但无法删除备份 {}：{error}",
                backup.display()
            )
        })?;
    } else {
        std::fs::rename(temp, target).map_err(|error| format!("无法保存下载目录：{error}"))?;
    }
    Ok(())
}

fn connection_auth(id: &str, state: &State<'_, AppState>) -> Result<AuthConfig, String> {
    let connection = get_connection(id, state)?;
    let auth = connection
        .lock()
        .map_err(|_| "连接已损坏".to_string())?
        .auth
        .clone();
    Ok(auth)
}

async fn get_or_open_sftp(id: &str, state: &State<'_, AppState>) -> Result<SharedSftp, String> {
    if let Some(sftp) = state
        .sftp_connections
        .lock()
        .map_err(|_| "SFTP 连接管理器已损坏".to_string())?
        .get(id)
        .cloned()
    {
        return Ok(sftp);
    }

    let auth = connection_auth(id, state)?;
    let opened = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let (session, _) = open_authenticated_session(&auth)?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("SFTP 初始化失败：{error}"))?;
            Ok(Arc::new(Mutex::new(sftp)))
        })
        .await,
    )?;
    let mut connections = state
        .sftp_connections
        .lock()
        .map_err(|_| "SFTP 连接管理器已损坏".to_string())?;
    Ok(connections
        .entry(id.to_string())
        .or_insert_with(|| opened.clone())
        .clone())
}

fn remove_sftp_connection(id: &str, state: &State<'_, AppState>) -> Result<(), String> {
    state
        .sftp_connections
        .lock()
        .map_err(|_| "SFTP 连接管理器已损坏".to_string())?
        .remove(id);
    Ok(())
}

#[tauri::command]
fn sftp_reconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    get_connection(&id, &state)?;
    remove_sftp_connection(&id, &state)
}

#[tauri::command]
async fn sftp_list(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteEntry>, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            let mut entries = sftp
                .readdir(Path::new(&path))
                .map_err(|error| format!("无法读取远程目录：{error}"))?
                .into_iter()
                .filter_map(|(item_path, stat)| {
                    let name = remote_name(&item_path);
                    if name == "." || name == ".." {
                        return None;
                    }
                    Some(RemoteEntry {
                        name,
                        path: item_path.to_string_lossy().replace('\\', "/"),
                        is_dir: stat.is_dir(),
                        size: stat.size.unwrap_or(0),
                        modified: stat.mtime.unwrap_or(0),
                        permissions: stat.perm.unwrap_or(0),
                        owner: stat.uid.map(|uid| uid.to_string()).unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| {
                right
                    .is_dir
                    .cmp(&left.is_dir)
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            Ok(entries)
        })
        .await,
    );
    if result.is_err() {
        remove_sftp_connection(&id, &state)?;
    }
    result
}

#[tauri::command]
async fn sftp_path_info(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<RemotePathInfo, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            let stat = sftp
                .stat(Path::new(&path))
                .map_err(|error| format!("远程路径不存在或无权访问：{error}"))?;
            Ok(RemotePathInfo {
                path,
                is_dir: stat.is_dir(),
            })
        })
        .await,
    )
}

#[tauri::command]
async fn sftp_file_size(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            sftp.lock()
                .map_err(|_| "SFTP 连接已损坏".to_string())?
                .stat(Path::new(&path))
                .map_err(|error| format!("无法读取日志文件状态：{error}"))?
                .size
                .ok_or_else(|| "远程服务器没有返回日志文件大小".to_string())
        })
        .await,
    )
}

#[tauri::command]
async fn sftp_properties(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<RemoteProperties, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            fn measure(sftp: &Sftp, path: &Path) -> Result<RemoteProperties, String> {
                let stat = sftp
                    .stat(path)
                    .map_err(|error| format!("无法读取属性：{error}"))?;
                if !stat.is_dir() {
                    return Ok(RemoteProperties {
                        size: stat.size.unwrap_or(0),
                        files: 1,
                        directories: 0,
                    });
                }
                let mut result = RemoteProperties {
                    size: 0,
                    files: 0,
                    directories: 1,
                };
                for (child, _) in sftp
                    .readdir(path)
                    .map_err(|error| format!("无法统计目录：{error}"))?
                {
                    let name = remote_name(&child);
                    if name == "." || name == ".." {
                        continue;
                    }
                    let value = measure(sftp, &child)?;
                    result.size += value.size;
                    result.files += value.files;
                    result.directories += value.directories;
                }
                Ok(result)
            }
            measure(&sftp, Path::new(&path))
        })
        .await,
    )
}

#[tauri::command]
async fn sftp_read_append(
    id: String,
    path: String,
    offset: u64,
    state: State<'_, AppState>,
) -> Result<TailAppend, String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            let size = sftp
                .stat(Path::new(&path))
                .map_err(|error| format!("无法读取日志文件状态：{error}"))?
                .size
                .unwrap_or(0);
            if size < offset {
                return Ok(TailAppend {
                    content: String::new(),
                    offset: size,
                    reset: true,
                });
            }
            if size == offset {
                return Ok(TailAppend {
                    content: String::new(),
                    offset,
                    reset: false,
                });
            }
            let mut file = sftp
                .open(Path::new(&path))
                .map_err(|error| format!("无法打开日志文件：{error}"))?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| format!("无法定位日志读取位置：{error}"))?;
            let mut bytes = Vec::with_capacity((size - offset).min(TAIL_READ_CHUNK_BYTES) as usize);
            file.take(TAIL_READ_CHUNK_BYTES)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("读取新增日志失败：{error}"))?;
            Ok(TailAppend {
                offset: offset + bytes.len() as u64,
                content: String::from_utf8_lossy(&bytes).into_owned(),
                reset: false,
            })
        })
        .await,
    )
}

#[tauri::command]
async fn sftp_upload(
    id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let auth = connection_auth(&id, &state)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .insert(transfer_id.clone(), cancel.clone());
    let transfer_key = transfer_id.clone();
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let (session, _) = open_authenticated_session_with_cancel(&auth, cancel.clone())?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("SFTP 初始化失败：{error}"))?;
            let mut source =
                File::open(&local_path).map_err(|error| format!("无法打开本地文件：{error}"))?;
            let total = source
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let temp_path = remote_transfer_path(&remote_path, &transfer_id);
            let result = (|| {
                let mut target = sftp
                    .create(Path::new(&temp_path))
                    .map_err(|error| format!("无法创建远程临时文件：{error}"))?;
                let mut buffer = vec![0u8; 256 * 1024];
                let mut transferred = 0u64;
                let mut last_emit = Instant::now();
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("传输已取消".to_string());
                    }
                    let count = source
                        .read(&mut buffer)
                        .map_err(|error| format!("读取本地文件失败：{error}"))?;
                    if count == 0 {
                        break;
                    }
                    target
                        .write_all(&buffer[..count])
                        .map_err(|error| format!("上传失败：{error}"))?;
                    transferred += count as u64;
                    if last_emit.elapsed() >= Duration::from_millis(100) || transferred == total {
                        app.emit(
                            "transfer-progress",
                            TransferProgress {
                                transfer_id: transfer_id.clone(),
                                transferred,
                                total,
                            },
                        )
                        .ok();
                        last_emit = Instant::now();
                    }
                }
                target
                    .flush()
                    .map_err(|error| format!("刷新远程文件失败：{error}"))?;
                drop(target);
                sftp.rename(
                    Path::new(&temp_path),
                    Path::new(&remote_path),
                    Some(RenameFlags::OVERWRITE | RenameFlags::ATOMIC),
                )
                .or_else(|_| {
                    sftp.rename(
                        Path::new(&temp_path),
                        Path::new(&remote_path),
                        Some(RenameFlags::OVERWRITE),
                    )
                })
                .map_err(|error| format!("提交远程文件失败：{error}"))?;
                Ok(transferred)
            })();
            if result.is_err() {
                sftp.unlink(Path::new(&temp_path)).ok();
            }
            result
        })
        .await,
    );
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .remove(&transfer_key);
    result
}

#[tauri::command]
async fn sftp_download(
    id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let auth = connection_auth(&id, &state)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .insert(transfer_id.clone(), cancel.clone());
    let transfer_key = transfer_id.clone();
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let (session, _) = open_authenticated_session_with_cancel(&auth, cancel.clone())?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("SFTP 初始化失败：{error}"))?;
            let total = sftp
                .stat(Path::new(&remote_path))
                .ok()
                .and_then(|stat| stat.size)
                .unwrap_or(0);
            let mut source = sftp
                .open(Path::new(&remote_path))
                .map_err(|error| format!("无法打开远程文件：{error}"))?;
            let local = PathBuf::from(&local_path);
            let temp = suffixed_local_path(&local, &format!(".orbiterm-part-{transfer_id}"));
            let backup = suffixed_local_path(&local, &format!(".orbiterm-backup-{transfer_id}"));
            let result = (|| {
                let mut target = File::create(&temp)
                    .map_err(|error| format!("无法创建本地临时文件：{error}"))?;
                let mut buffer = vec![0u8; 256 * 1024];
                let mut transferred = 0u64;
                let mut last_emit = Instant::now();
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("传输已取消".to_string());
                    }
                    let count = source
                        .read(&mut buffer)
                        .map_err(|error| format!("下载失败：{error}"))?;
                    if count == 0 {
                        break;
                    }
                    target
                        .write_all(&buffer[..count])
                        .map_err(|error| format!("写入本地文件失败：{error}"))?;
                    transferred += count as u64;
                    if last_emit.elapsed() >= Duration::from_millis(100) || transferred == total {
                        app.emit(
                            "transfer-progress",
                            TransferProgress {
                                transfer_id: transfer_id.clone(),
                                transferred,
                                total,
                            },
                        )
                        .ok();
                        last_emit = Instant::now();
                    }
                }
                target
                    .flush()
                    .map_err(|error| format!("刷新本地文件失败：{error}"))?;
                drop(target);
                replace_local_file(&temp, &local, &backup)?;
                Ok(transferred)
            })();
            if result.is_err() {
                std::fs::remove_file(&temp).ok();
            }
            result
        })
        .await,
    );
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .remove(&transfer_key);
    result
}

#[tauri::command]
async fn sftp_download_tree(
    id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let auth = connection_auth(&id, &state)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .insert(transfer_id.clone(), cancel.clone());
    let transfer_key = transfer_id.clone();
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let (session, _) = open_authenticated_session_with_cancel(&auth, cancel.clone())?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("SFTP 初始化失败：{error}"))?;
            let local = PathBuf::from(&local_path);
            let temp = suffixed_local_path(&local, &format!(".orbiterm-part-{transfer_id}"));
            let backup = suffixed_local_path(&local, &format!(".orbiterm-backup-{transfer_id}"));
            struct DownloadTree<'a> {
                sftp: &'a Sftp,
                transfer_id: &'a str,
                cancel: &'a AtomicBool,
                app: &'a AppHandle,
            }

            impl DownloadTree<'_> {
                fn download(
                    &self,
                    remote: &Path,
                    local: &Path,
                    stat: FileStat,
                    depth: usize,
                    transferred: &mut u64,
                ) -> Result<(), String> {
                    if self.cancel.load(Ordering::Relaxed) {
                        return Err("传输已取消".to_string());
                    }
                    if depth > MAX_DOWNLOAD_TREE_DEPTH {
                        return Err(format!(
                            "远程目录层级超过 {MAX_DOWNLOAD_TREE_DEPTH} 层，已停止下载"
                        ));
                    }
                    if stat.file_type().is_symlink() {
                        return Err(format!(
                            "目录中包含符号链接 {}，为避免循环递归已停止下载",
                            remote.display()
                        ));
                    }
                    if stat.is_dir() {
                        std::fs::create_dir_all(local)
                            .map_err(|error| format!("无法创建本地目录：{error}"))?;
                        for (child, child_stat) in self
                            .sftp
                            .readdir(remote)
                            .map_err(|error| format!("无法读取远程目录：{error}"))?
                        {
                            let name = remote_name(&child);
                            if name == "." || name == ".." {
                                continue;
                            }
                            let child_local = local.join(&name);
                            self.download(
                                &child,
                                &child_local,
                                child_stat,
                                depth + 1,
                                transferred,
                            )?;
                        }
                        return Ok(());
                    }
                    let mut source = self
                        .sftp
                        .open(remote)
                        .map_err(|error| format!("无法打开远程文件：{error}"))?;
                    if let Some(parent) = local.parent() {
                        std::fs::create_dir_all(parent)
                            .map_err(|error| format!("无法创建本地目录：{error}"))?;
                    }
                    let mut target = File::create(local)
                        .map_err(|error| format!("无法创建本地文件：{error}"))?;
                    let mut buffer = vec![0u8; 256 * 1024];
                    let mut last_emit = Instant::now();
                    loop {
                        if self.cancel.load(Ordering::Relaxed) {
                            return Err("传输已取消".to_string());
                        }
                        let count = source
                            .read(&mut buffer)
                            .map_err(|error| format!("下载失败：{error}"))?;
                        if count == 0 {
                            break;
                        }
                        target
                            .write_all(&buffer[..count])
                            .map_err(|error| format!("写入本地文件失败：{error}"))?;
                        *transferred += count as u64;
                        if last_emit.elapsed() >= Duration::from_millis(100) {
                            self.app
                                .emit(
                                    "transfer-progress",
                                    TransferProgress {
                                        transfer_id: self.transfer_id.to_string(),
                                        transferred: *transferred,
                                        total: 0,
                                    },
                                )
                                .ok();
                            last_emit = Instant::now();
                        }
                    }
                    self.app
                        .emit(
                            "transfer-progress",
                            TransferProgress {
                                transfer_id: self.transfer_id.to_string(),
                                transferred: *transferred,
                                total: 0,
                            },
                        )
                        .ok();
                    Ok(())
                }
            }
            let mut transferred = 0;
            let root_stat = sftp
                .lstat(Path::new(&remote_path))
                .map_err(|error| format!("无法读取远程项目：{error}"));
            let result = root_stat
                .and_then(|stat| {
                    DownloadTree {
                        sftp: &sftp,
                        transfer_id: &transfer_id,
                        cancel: &cancel,
                        app: &app,
                    }
                    .download(
                        Path::new(&remote_path),
                        &temp,
                        stat,
                        0,
                        &mut transferred,
                    )
                })
                .and_then(|_| replace_local_directory(&temp, &local, &backup));
            if result.is_err() {
                std::fs::remove_dir_all(&temp).ok();
            }
            result.map(|_| transferred)
        })
        .await,
    );
    state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .remove(&transfer_key);
    result
}

#[tauri::command]
async fn sftp_mkdir(id: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            sftp.lock()
                .map_err(|_| "SFTP 连接已损坏".to_string())?
                .mkdir(Path::new(&path), 0o755)
                .map_err(|error| format!("新建目录失败：{error}"))
        })
        .await,
    );
    if result.is_err() {
        remove_sftp_connection(&id, &state)?;
    }
    result
}

#[tauri::command]
async fn sftp_remove(
    id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            fn remove_tree(sftp: &Sftp, path: &Path, is_dir: bool) -> Result<(), String> {
                if !is_dir {
                    return sftp
                        .unlink(path)
                        .map_err(|error| format!("删除失败：{error}"));
                }
                for (child, stat) in sftp
                    .readdir(path)
                    .map_err(|error| format!("无法读取待删除目录：{error}"))?
                {
                    let name = remote_name(&child);
                    if name != "." && name != ".." {
                        remove_tree(sftp, &child, stat.is_dir())?;
                    }
                }
                sftp.rmdir(path)
                    .map_err(|error| format!("删除目录失败：{error}"))
            }
            remove_tree(&sftp, Path::new(&path), is_dir)
        })
        .await,
    );
    if result.is_err() {
        remove_sftp_connection(&id, &state)?;
    }
    result
}

#[tauri::command]
async fn sftp_rename(
    id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = get_or_open_sftp(&id, &state).await?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = sftp.lock().map_err(|_| "SFTP 连接已损坏".to_string())?;
            if sftp.stat(Path::new(&new_path)).is_ok() {
                return Err("目标名称已存在".to_string());
            }
            sftp.rename(Path::new(&old_path), Path::new(&new_path), None)
                .map_err(|error| format!("重命名失败：{error}"))
        })
        .await,
    );
    if result.is_err() {
        remove_sftp_connection(&id, &state)?;
    }
    result
}

#[tauri::command]
async fn sftp_chmod(
    id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if permissions > 0o7777 {
        return Err("权限值无效".to_string());
    }
    let sftp = get_or_open_sftp(&id, &state).await?;
    let result = join_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            sftp.lock()
                .map_err(|_| "SFTP 连接已损坏".to_string())?
                .setstat(
                    Path::new(&path),
                    FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(permissions),
                        atime: None,
                        mtime: None,
                    },
                )
                .map_err(|error| format!("修改权限失败：{error}"))
        })
        .await,
    );
    if result.is_err() {
        remove_sftp_connection(&id, &state)?;
    }
    result
}

#[tauri::command]
fn cancel_transfer(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state
        .transfers
        .lock()
        .map_err(|_| "传输管理器已损坏".to_string())?
        .get(&transfer_id)
    {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            local_terminal_open,
            local_terminal_read,
            local_terminal_write,
            local_terminal_resize,
            local_terminal_close,
            import_session_bundle,
            export_session_bundle,
            credential_get,
            credential_set,
            credential_delete,
            probe_host,
            ssh_connect,
            ssh_read,
            ssh_write,
            ssh_resize,
            ssh_monitor,
            ssh_tail,
            ssh_disconnect,
            session_log_start,
            session_log_stop,
            sftp_list,
            sftp_path_info,
            sftp_file_size,
            sftp_properties,
            sftp_read_append,
            sftp_reconnect,
            sftp_read_text,
            sftp_write_text,
            sftp_upload,
            sftp_download,
            sftp_download_tree,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_chmod,
            cancel_transfer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbiterm");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "orbiterm-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be valid")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("test directory should be created");
        path
    }

    #[test]
    fn transfer_paths_do_not_replace_destination_early() {
        assert_eq!(
            remote_transfer_path("/srv/app.tar", "abc"),
            "/srv/app.tar.orbiterm-part-abc"
        );
        assert_eq!(
            suffixed_local_path(Path::new("report.log"), ".part"),
            PathBuf::from("report.log.part")
        );
    }

    #[test]
    fn replace_local_file_preserves_then_replaces_existing_file() {
        let directory = test_directory("replace");
        let target = directory.join("target.txt");
        let temp = directory.join("target.txt.part");
        let backup = directory.join("target.txt.backup");
        std::fs::write(&target, b"old").expect("old file should be written");
        std::fs::write(&temp, b"new").expect("new file should be written");

        replace_local_file(&temp, &target, &backup).expect("replacement should succeed");

        assert_eq!(std::fs::read(&target).expect("target should exist"), b"new");
        assert!(!temp.exists());
        assert!(!backup.exists());
        std::fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn replace_local_directory_preserves_then_replaces_existing_tree() {
        let directory = test_directory("replace-directory");
        let target = directory.join("target");
        let temp = directory.join("target.part");
        let backup = directory.join("target.backup");
        std::fs::create_dir_all(&target).expect("old directory should be created");
        std::fs::write(target.join("old.txt"), b"old").expect("old file should be written");
        std::fs::create_dir_all(&temp).expect("temporary directory should be created");
        std::fs::write(temp.join("new.txt"), b"new").expect("new file should be written");

        replace_local_directory(&temp, &target, &backup).expect("replacement should succeed");

        assert_eq!(
            std::fs::read(target.join("new.txt")).expect("new file should exist"),
            b"new"
        );
        assert!(!target.join("old.txt").exists());
        assert!(!temp.exists());
        assert!(!backup.exists());
        std::fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn session_bundle_validation_rejects_unrelated_json() {
        assert!(session_files::validate_session_bundle(
            r#"{"format":"orbiterm-session-bundle","version":1,"sessions":[]}"#
        )
        .is_ok());
        assert!(session_files::validate_session_bundle(r#"{"private":"data"}"#).is_err());
        assert!(session_files::validate_session_bundle("not json").is_err());
    }

    #[test]
    fn terminal_write_retries_only_transient_transport_reads() {
        assert!(retryable_terminal_transport_error(&std::io::Error::other(
            "Failure while draining incoming flow"
        )));
        assert!(retryable_terminal_transport_error(&std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "interrupted"
        )));
        assert!(!retryable_terminal_transport_error(&std::io::Error::other(
            "Unable to send channel data"
        )));
        assert!(!retryable_terminal_transport_error(&std::io::Error::other(
            "transport read"
        )));
    }
}
