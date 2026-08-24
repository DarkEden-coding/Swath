mod ask_images;
mod commands;
mod config;
mod files;
mod git;
#[cfg(target_os = "macos")]
mod menu;
mod pi_agent;
mod platform;
mod terminal;
mod types;
mod window_state;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, RunEvent, WindowEvent};

use pi_agent::PiManager;
use terminal::TerminalManager;

#[derive(Clone)]
pub struct AppState {
    terminal: Arc<TerminalManager>,
    pi: Arc<PiManager>,
    placement_persistence_ready: Arc<AtomicBool>,
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
            let placement_persistence_ready = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                terminal,
                pi,
                placement_persistence_ready: placement_persistence_ready.clone(),
            });
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore(app.handle(), &window)
                    .map_err(|err| format!("failed to restore window placement: {err}"))?;
            }
            // Restoring a Tauri window generates move/resize events while the compositor applies the
            // requested geometry. Do not overwrite the saved placement with those transient sizes.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                placement_persistence_ready.store(true, Ordering::Release);
            });
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Swath")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
                ..
            } = &event
            {
                if label == "main"
                    && app
                        .try_state::<AppState>()
                        .is_some_and(|state| state.placement_persistence_ready.load(Ordering::Acquire))
                {
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
