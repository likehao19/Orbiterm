use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const SESSION_BUNDLE_FORMAT: &str = "orbiterm-session-bundle";
const MAX_SESSION_BUNDLE_SIZE: u64 = 4 * 1024 * 1024;

pub(crate) fn validate_session_bundle(content: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("会话配置不是有效 JSON：{error}"))?;
    if value.get("format").and_then(serde_json::Value::as_str) != Some(SESSION_BUNDLE_FORMAT)
        || !value
            .get("sessions")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("不是有效的 Orbiterm 会话配置文件".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn import_session_bundle(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("Orbiterm session bundle", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("无法访问所选配置文件：{error}"))?;
        let size = std::fs::metadata(&path)
            .map_err(|error| format!("无法读取配置文件：{error}"))?
            .len();
        if size > MAX_SESSION_BUNDLE_SIZE {
            return Err("会话配置文件不能超过 4 MB".to_string());
        }
        let content =
            std::fs::read_to_string(path).map_err(|error| format!("无法读取配置文件：{error}"))?;
        validate_session_bundle(&content)?;
        Ok(Some(content))
    })
    .await
    .map_err(|error| format!("后台任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn export_session_bundle(app: AppHandle, content: String) -> Result<bool, String> {
    if content.len() as u64 > MAX_SESSION_BUNDLE_SIZE {
        return Err("会话配置文件不能超过 4 MB".to_string());
    }
    validate_session_bundle(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("Orbiterm session bundle", &["json"])
            .set_file_name("orbiterm-sessions.json")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("无法访问所选保存位置：{error}"))?;
        std::fs::write(path, content).map_err(|error| format!("无法保存配置文件：{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("后台任务失败：{error}"))?
}
