use crate::types::{
    ConfirmDialogRequest, FolderSelectResult, TerminalClipboardPayload,
    TerminalPastePermissionStatus,
};
use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub fn platform_string() -> String {
    if cfg!(target_os = "macos") {
        "darwin".to_string()
    } else if cfg!(target_os = "windows") {
        "win32".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

pub async fn select_folder(app: AppHandle) -> Result<FolderSelectResult> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(file_path) = selected else {
        return Ok(FolderSelectResult {
            canceled: true,
            path: None,
            name: None,
        });
    };

    let path = file_path
        .into_path()
        .map_err(|err| anyhow!("selected folder is not a local path: {err}"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string());

    Ok(FolderSelectResult {
        canceled: false,
        path: Some(path.to_string_lossy().to_string()),
        name,
    })
}

pub async fn confirm(app: AppHandle, request: ConfirmDialogRequest) -> Result<bool> {
    let confirm_label = request.confirm_label.unwrap_or_else(|| "OK".to_string());
    let cancel_label = request.cancel_label.unwrap_or_else(|| "Cancel".to_string());
    let message = match request.detail {
        Some(detail) if !detail.trim().is_empty() => format!("{}\n\n{}", request.message, detail),
        _ => request.message,
    };

    Ok(app
        .dialog()
        .message(message)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label,
            cancel_label,
        ))
        .blocking_show())
}

pub fn read_clipboard_for_terminal(app: AppHandle) -> Result<TerminalClipboardPayload> {
    let text = app.clipboard().read_text()?;
    Ok(TerminalClipboardPayload {
        text,
        image_path: None,
    })
}

pub fn write_clipboard_text(app: AppHandle, text: String) -> Result<()> {
    app.clipboard().write_text(text)?;
    Ok(())
}

pub fn ensure_terminal_paste() -> TerminalPastePermissionStatus {
    TerminalPastePermissionStatus {
        accessibility: "granted".to_string(),
    }
}

pub fn open_external(url: String) -> Result<()> {
    tauri_plugin_opener::open_url(url, None::<&str>)?;
    Ok(())
}
