use crate::types::*;
use crate::{config, git, platform, AppState};
use tauri::{AppHandle, State, Window};

pub type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn platform() -> String {
    platform::platform_string()
}

#[tauri::command]
pub fn config_load(app: AppHandle) -> CommandResult<AppConfig> {
    config::load(&app).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn config_save(app: AppHandle, config: AppConfig) -> CommandResult<()> {
    config::save(&app, &config).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn dialog_select_folder(app: AppHandle) -> CommandResult<FolderSelectResult> {
    platform::select_folder(app)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn dialog_confirm(app: AppHandle, request: ConfirmDialogRequest) -> CommandResult<bool> {
    platform::confirm(app, request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn clipboard_read_for_terminal(app: AppHandle) -> CommandResult<TerminalClipboardPayload> {
    platform::read_clipboard_for_terminal(app).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn clipboard_write_text(app: AppHandle, text: String) -> CommandResult<()> {
    platform::write_clipboard_text(app, text).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn permissions_ensure_terminal_paste() -> TerminalPastePermissionStatus {
    platform::ensure_terminal_paste()
}

#[tauri::command]
pub fn browser_open_external(url: String) -> CommandResult<()> {
    platform::open_external(url).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_create(
    state: State<'_, AppState>,
    request: TerminalSessionStartRequest,
) -> CommandResult<()> {
    state
        .terminal
        .create(request)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> CommandResult<()> {
    state
        .terminal
        .write(&session_id, &data)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, request: PtyResizeRequest) -> CommandResult<()> {
    state
        .terminal
        .resize(request)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    state
        .terminal
        .kill(&session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_attach(
    state: State<'_, AppState>,
    request: TerminalSessionAttachRequest,
) -> CommandResult<TerminalSessionStatus> {
    state
        .terminal
        .attach(request)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_restart(
    state: State<'_, AppState>,
    session_id: String,
) -> CommandResult<TerminalSessionStatus> {
    state
        .terminal
        .restart(&session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_replay(
    state: State<'_, AppState>,
    window: Window,
    session_id: String,
) -> CommandResult<TerminalSessionStatus> {
    state
        .terminal
        .replay_to_window(&window, &session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_set_streaming(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> CommandResult<()> {
    state
        .terminal
        .set_streaming(&session_id, enabled)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_is_busy(state: State<'_, AppState>, session_id: String) -> CommandResult<bool> {
    state
        .terminal
        .is_busy(&session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn git_rpc(request: serde_json::Value) -> CommandResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || git::rpc(request).map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
}
