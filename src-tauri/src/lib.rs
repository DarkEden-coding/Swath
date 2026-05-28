mod commands;
mod config;
mod git;
mod menu;
mod platform;
mod terminal;
mod types;

use std::sync::Arc;
use tauri::{Manager, RunEvent};

use terminal::TerminalManager;

#[derive(Clone)]
pub struct AppState {
    terminal: Arc<TerminalManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let terminal = Arc::new(TerminalManager::new(app.handle().clone()));
            app.manage(AppState { terminal });
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Swath")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.terminal.kill_all();
                }
            }
        });
}
