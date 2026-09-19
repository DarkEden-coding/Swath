mod ask_images;
#[cfg(feature = "desktop")]
mod commands;
mod config;
mod events;
mod files;
mod git;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod menu;
mod migration;
pub mod network;
mod pi_agent;
mod pi_session_store;
#[cfg(feature = "desktop")]
mod platform;
mod preview;
mod remote;
mod runtime;
mod task_store;
mod tasks;
mod terminal;
mod types;
#[cfg(feature = "desktop")]
mod window_state;

use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(feature = "desktop")]
pub struct AppState {
    pub(crate) core: Arc<runtime::Core>,
    pub(crate) remote: Arc<remote::RemoteServerManager>,
}

/// Builds connector options from the standard headless environment variables.
pub fn headless_options(token: String) -> remote::RemoteServerOptions {
    remote::RemoteServerOptions {
        bind: std::env::var("SWATH_CONNECTOR_BIND").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("SWATH_CONNECTOR_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(7878),
        token,
        tailscale_https: std::env::var("SWATH_CONNECTOR_TAILSCALE_HTTPS")
            .is_ok_and(|v| !matches!(v.as_str(), "0" | "false" | "no")),
        allowed_origins: std::env::var("SWATH_CONNECTOR_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_string())
            .collect(),
    }
}

/// Starts a display-free executor runtime and authenticated connector.
pub async fn run_headless(
    data_dir: std::path::PathBuf,
    options: remote::RemoteServerOptions,
) -> anyhow::Result<()> {
    let connector_events = events::ConnectorEvents::new();
    let core = runtime::Core::start(data_dir, connector_events.clone())?;
    let remote = Arc::new(remote::RemoteServerManager::new(
        core.clone(),
        connector_events,
    ));
    remote.start(options).await.map_err(anyhow::Error::msg)?;
    tokio::signal::ctrl_c().await?;
    remote.stop().await;
    core.shutdown();
    Ok(())
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let connector_events = events::ConnectorEvents::new();
            let publishers: Vec<Arc<dyn events::EventPublisher>> = vec![
                events::TauriEvents::new(app.handle().clone()),
                connector_events.clone(),
            ];
            let core = runtime::Core::start(data_dir, events::FanoutPublisher::new(publishers))
                .map_err(|err| err.to_string())?;
            let remote = Arc::new(remote::RemoteServerManager::new(
                core.clone(),
                connector_events,
            ));
            let state = AppState {
                core,
                remote: remote.clone(),
            };
            app.manage(state);
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore(app.handle(), &window).map_err(|err| err.to_string())?;
                window.show().map_err(|err| err.to_string())?;
            }
            #[cfg(target_os = "macos")]
            menu::install_menu(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform,
            commands::config_load,
            commands::config_save,
            commands::local_state_load,
            commands::local_state_save,
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
            commands::task_rpc,
            commands::sync_snapshot,
            commands::sync_changes,
            commands::sync_ack,
            commands::sync_conflicts,
            commands::network_current,
            commands::network_initialize,
            commands::network_discover,
            commands::network_request_join,
            commands::network_join_status,
            commands::network_approve_join,
            commands::network_promote,
            commands::network_membership,
            commands::network_health,
            commands::catalog_snapshot,
            commands::catalog_mutate,
            commands::migration_status,
            commands::migration_preview,
            commands::migration_confirm,
            commands::migration_export,
            commands::migration_conflicts,
            commands::migration_ensure_resolution_job,
            commands::migration_submit_proposal,
            commands::migration_approve_proposal,
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
                        let _ = window_state::save(app, &window);
                    }
                }
            }
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.core.shutdown();
                }
            }
        });
}
