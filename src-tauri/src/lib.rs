mod ask_images;
mod commands;
mod config;
mod files;
mod git;
#[cfg(target_os = "macos")]
mod menu;
mod pi_agent;
mod platform;
mod remote;
mod terminal;
mod types;
mod window_state;

use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};

use pi_agent::PiManager;
use terminal::TerminalManager;

#[derive(Clone)]
pub struct AppState {
    pub(crate) terminal: Arc<TerminalManager>,
    pub(crate) pi: Arc<PiManager>,
    pub(crate) remote: Arc<remote::RemoteServerManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let terminal = Arc::new(TerminalManager::new(app.handle().clone()));
            let pi = Arc::new(PiManager::new());
            let remote = Arc::new(remote::RemoteServerManager::new(app.handle().clone()));
            let state = AppState {
                terminal,
                pi,
                remote: remote.clone(),
            };
            app.manage(state.clone());
            // Headless/server installations can opt into hosting at launch without UI automation.
            if let Ok(token) = std::env::var("SWATH_CONNECTOR_TOKEN") {
                let bind =
                    std::env::var("SWATH_CONNECTOR_BIND").unwrap_or_else(|_| "127.0.0.1".into());
                let port = std::env::var("SWATH_CONNECTOR_PORT")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(7878);
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = remote
                        .start(remote::RemoteServerOptions { bind, port, token }, state)
                        .await
                    {
                        eprintln!("failed to auto-start remote connector: {err}");
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore(app.handle(), &window)
                    .map_err(|err| format!("failed to restore window placement: {err}"))?;
                window
                    .show()
                    .map_err(|err| format!("failed to show main window: {err}"))?;
            }
            #[cfg(target_os = "macos")]
            menu::install_menu(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform,
            commands::config_load,
            commands::config_save,
            commands::dialog_select_folder,
            commands::dialog_confirm,
            commands::clipboard_read_for_terminal,
            commands::clipboard_write_text,
            commands::permissions_ensure_terminal_paste,
            commands::browser_open_external,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_attach,
            commands::terminal_restart,
            commands::terminal_replay,
            commands::terminal_set_streaming,
            commands::terminal_is_busy,
            commands::git_rpc,
            commands::ask_images_load,
            commands::files_rpc,
            commands::pi_rpc,
            commands::remote_server_start,
            commands::remote_server_stop,
            commands::remote_server_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Swath")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { .. },
                ..
            } = &event
            {
                if label == "main" {
                    if let Some(window) = app.get_webview_window(label) {
                        if let Err(err) = window_state::save(app, &window) {
                            eprintln!("failed to save window placement: {err}");
                        }
                    }
                }
            }
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.terminal.kill_all();
                    state.pi.kill_all();
                }
            }
        });
}
