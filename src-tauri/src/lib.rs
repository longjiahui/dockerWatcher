pub mod docker;
mod tray;

use docker::{ContainerInfo, DockerState, DockerStatus, LogLine, DEFAULT_LOG_TAIL};
use tauri::WindowEvent;

#[tauri::command]
async fn list_containers() -> Result<Vec<ContainerInfo>, String> {
    let client = docker::connect()?;
    docker::list_containers(&client).await
}

#[tauri::command]
async fn get_logs(
    id: String,
    tail: Option<serde_json::Value>,
    timestamps: Option<bool>,
) -> Result<Vec<LogLine>, String> {
    let tail = resolve_tail(tail)?;
    let client = docker::connect()?;
    docker::fetch_logs(&client, &id, &tail, timestamps.unwrap_or(true)).await
}

/// The frontend walks a ladder of line counts and ends on the literal `"all"`.
fn resolve_tail(tail: Option<serde_json::Value>) -> Result<String, String> {
    match tail {
        None | Some(serde_json::Value::Null) => Ok(DEFAULT_LOG_TAIL.to_string()),
        Some(serde_json::Value::Number(number)) => number
            .as_u64()
            .map(|count| count.to_string())
            .ok_or_else(|| format!("invalid tail: {number}")),
        Some(serde_json::Value::String(text)) if text == "all" => Ok(text),
        Some(serde_json::Value::String(text))
            if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Ok(text)
        }
        Some(other) => Err(format!("invalid tail: {other}")),
    }
}

#[tauri::command]
async fn get_docker_status(state: tauri::State<'_, DockerState>) -> Result<DockerStatus, String> {
    let cached = docker::read_status(&state);
    if cached.connected {
        return Ok(cached);
    }

    // The event loop keeps this up to date, but on demand a disconnected engine is
    // re-probed so the frontend can recover without waiting for the backoff.
    let probed = docker::probe().await;
    docker::write_status(&state, probed.clone());
    Ok(probed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DockerState::default())
        .setup(|app| {
            tray::build(app)?;
            docker::spawn_event_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window only hides it: the tray menu's 退出 item is the
            // only way to end the process.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_containers,
            get_logs,
            get_docker_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
