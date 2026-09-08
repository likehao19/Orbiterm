use serde::{Deserialize, Serialize};
use tauri::{webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder}, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, Url, Webview, WebviewUrl};

pub const LABEL: &str = "browser-content";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_forward: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn allowed_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() || ["tauri.localhost", "ipc.localhost", "asset.localhost"].iter()
        .any(|reserved| host == *reserved || host.ends_with(&format!(".{reserved}"))) {
        return false;
    }
    if let Some(dev) = dev_url {
        let loopback = matches!(host, "localhost" | "[::1]" | "::1")
            || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback());
        if url.origin() == dev.origin() || (loopback && url.port_or_known_default() == dev.port_or_known_default()) {
            return false;
        }
    }
    true
}

fn parse_address(address: &str, dev_url: Option<&Url>) -> Result<Url, String> {
    let address = address.trim();
    if address.is_empty() || address.len() > 8192 || address.chars().any(char::is_whitespace) {
        return Err("请输入有效的网页地址 / Enter a valid web address".into());
    }
    let lowercase = address.to_ascii_lowercase();
    let explicit = lowercase.starts_with("http://") || lowercase.starts_with("https://");
    if address.contains("://") && !explicit {
        return Err("仅支持 HTTP/HTTPS / Only HTTP/HTTPS is supported".into());
    }
    let candidate = if explicit { address.to_string() } else { format!("https://{address}") };
    let mut url = Url::parse(&candidate).map_err(|_| "网页地址无效 / Invalid web address")?;
    if !explicit {
        let host = url.host_str().unwrap_or("");
        let local = host == "localhost" || !host.contains('.') || url.port().is_some()
            || host.parse::<std::net::IpAddr>().is_ok();
        if local { url.set_scheme("http").ok(); }
    }
    if !allowed_url(&url, dev_url) {
        return Err("仅支持普通 HTTP/HTTPS 网页，禁止访问应用内部地址 / Only external HTTP/HTTPS pages are allowed".into());
    }
    Ok(url)
}

fn publish(webview: &Webview, update: BrowserUpdate) {
    let app = webview.app_handle().clone();
    #[cfg(windows)]
    {
        let _ = webview.with_webview(move |native| {
            let mut update = update;
            unsafe {
                if let Ok(core) = native.controller().CoreWebView2() {
                    let mut back = Default::default();
                    let mut forward = Default::default();
                    if core.CanGoBack(&mut back).is_ok() { update.can_go_back = Some(back.as_bool()); }
                    if core.CanGoForward(&mut forward).is_ok() { update.can_go_forward = Some(forward.as_bool()); }
                }
            }
            let _ = app.emit_to("main", "orbiterm-browser-state", update);
        });
    }
    #[cfg(not(windows))]
    let _ = app.emit_to("main", "orbiterm-browser-state", update);
}

fn layout(webview: &Webview, bounds: BrowserBounds) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale].iter().any(|v| !v.is_finite())
        || !(0.5..=5.0).contains(&bounds.scale) {
        return Err("浏览器区域尺寸无效 / Invalid browser bounds".into());
    }
    let window_size = webview.window().inner_size().map_err(|e| e.to_string())?;
    let x = (bounds.x * bounds.scale).round().clamp(0.0, window_size.width as f64);
    let y = (bounds.y * bounds.scale).round().clamp(0.0, window_size.height as f64);
    let width = (bounds.width * bounds.scale).round().clamp(0.0, window_size.width as f64 - x);
    let height = (bounds.height * bounds.scale).round().clamp(0.0, window_size.height as f64 - y);
    if width < 2.0 || height < 2.0 { return webview.hide().map_err(|e| e.to_string()); }
    webview.set_bounds(Rect { position: PhysicalPosition::new(x as i32, y as i32).into(),
        size: PhysicalSize::new(width as u32, height as u32).into() }).map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())
}

// Only the trusted main UI can operate this WebView. Remote pages have no app IPC privileges.
#[tauri::command]
pub async fn browser_command(caller: Webview, app: AppHandle, action: String, address: Option<String>,
    bounds: Option<BrowserBounds>, zoom: Option<f64>) -> Result<(), String> {
    if caller.label() != "main" { return Err("浏览器控制仅限主窗口 / Main window only".into()); }
    if action == "close" {
        if let Some(view) = app.get_webview(LABEL) { view.close().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    if action == "navigate" {
        let dev_url = app.config().build.dev_url.clone();
        let url = parse_address(address.as_deref().unwrap_or(""), dev_url.as_ref())?;
        if let Some(view) = app.get_webview(LABEL) {
            return view.navigate(url).map_err(|e| e.to_string());
        }
        let navigation_app = app.clone();
        let popup_app = app.clone();
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
            .incognito(true)
            .data_directory(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("browser-profile"))
            .disable_drag_drop_handler()
            .on_navigation(move |url| {
                let allowed = allowed_url(url, dev_url.as_ref());
                if !allowed { let _ = navigation_app.emit_to("main", "orbiterm-browser-state", BrowserUpdate {
                    error: Some("已拦截不支持的地址 / Unsupported address blocked".into()), loading: Some(false), ..Default::default() }); }
                allowed
            })
            .on_page_load(|view, payload| publish(&view, BrowserUpdate { url: Some(payload.url().to_string()),
                loading: Some(matches!(payload.event(), PageLoadEvent::Started)), ..Default::default() }))
            .on_document_title_changed(|view, title| publish(&view, BrowserUpdate { title: Some(title), ..Default::default() }))
            .on_new_window(move |url, _| {
                let _ = popup_app.emit_to("main", "orbiterm-browser-open-url", url.to_string());
                NewWindowResponse::Deny
            })
            .on_download(|view, _| {
                publish(&view, BrowserUpdate { error: Some("基础浏览器暂不提供下载，请使用外部浏览器 / Downloads require an external browser".into()), ..Default::default() });
                false
            });
        let window = app.get_window("main").ok_or("找不到主窗口 / Main window unavailable")?;
        let view = window.add_child(builder, PhysicalPosition::new(0, 0), PhysicalSize::new(1, 1))
            .map_err(|e| format!("无法打开内置浏览器 / Cannot open browser: {e}"))?;
        view.hide().map_err(|e| e.to_string())?;
        if let Some(bounds) = bounds { layout(&view, bounds)?; }
        return Ok(());
    }
    let Some(view) = app.get_webview(LABEL) else { return Ok(()); };
    match action.as_str() {
        "layout" => layout(&view, bounds.ok_or("缺少浏览器尺寸 / Missing browser bounds")?),
        "hide" => view.hide().map_err(|e| e.to_string()),
        "reload" => view.reload().map_err(|e| e.to_string()),
        "zoom" => {
            let zoom = zoom.filter(|v| v.is_finite() && (0.5..=2.0).contains(v)).ok_or("缩放范围为 50–200% / Zoom range: 50–200%")?;
            view.set_zoom(zoom).map_err(|e| e.to_string())
        }
        "back" | "forward" => {
            #[cfg(windows)]
            {
                let app = app.clone();
                view.with_webview(move |native| {
                    let result = unsafe { native.controller().CoreWebView2().and_then(|core|
                        if action == "back" { core.GoBack() } else { core.GoForward() }) };
                    if let Err(error) = result { let _ = app.emit_to("main", "orbiterm-browser-state", BrowserUpdate {
                        error: Some(error.to_string()), ..Default::default() }); }
                }).map_err(|e| e.to_string())
            }
            #[cfg(not(windows))]
            view.eval(if action == "back" { "history.back()" } else { "history.forward()" }).map_err(|e| e.to_string())
        }
        _ => Err("未知浏览器操作 / Unknown browser action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_web_and_internal_network_addresses() {
        assert_eq!(parse_address("example.com", None).unwrap().as_str(), "https://example.com/");
        assert_eq!(parse_address("localhost:8080", None).unwrap().as_str(), "http://localhost:8080/");
        assert_eq!(parse_address("10.10.93.52:9000/console", None).unwrap().scheme(), "http");
        assert_eq!(parse_address("https://example.com/path?q=1", None).unwrap().scheme(), "https");
    }
    #[test]
    fn blocks_application_origins_credentials_and_non_web_protocols() {
        let dev = Url::parse("http://127.0.0.1:1420").unwrap();
        for url in ["", "javascript:alert(1)", "data:text/html,test", "file:///C:/private", "tauri://localhost", "https://tauri.localhost", "http://ipc.localhost", "http://localhost:1420", "http://127.0.0.1:1420", "http://[::1]:1420", "https://user:secret@example.com"] {
            assert!(parse_address(url, Some(&dev)).is_err(), "must block {url}");
        }
    }
}
