mod ask_images;
#[cfg(feature = "desktop")]
mod commands;
mod config;
mod events;
mod files;
mod git;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod menu;
mod pi_agent;
#[cfg(feature = "desktop")]
mod platform;
mod remote;
mod terminal;
mod types;
#[cfg(feature = "desktop")]
mod window_state;

use std::sync::Arc;
#[cfg(feature = "desktop")]
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
#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let terminal = Arc::new(TerminalManager::new(events::EventSink::Desktop(
                app.handle().clone(),
            )));
            let pi = Arc::new(PiManager::new());
            let remote = Arc::new(remote::RemoteServerManager::new(app.handle().clone()));
            let state = AppState {
                terminal,
                pi,
                remote: remote.clone(),
            };
            app.manage(state.clone());
            // Headless/server installations can opt into hosting at launch without UI automation.
            let env_token = std::env::var("SWATH_CONNECTOR_TOKEN").ok();
            let saved = if env_token.is_none() {
                remote.load_startup_options()
            } else {
                Ok(None)
            };
            let saved = match saved {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("failed to load connector settings: {err}");
                    remote.report_startup_error(err);
                    None
                }
            };
            if env_token.is_some() || saved.is_some() {
                let bind =
                    std::env::var("SWATH_CONNECTOR_BIND").unwrap_or_else(|_| "127.0.0.1".into());
                let port = std::env::var("SWATH_CONNECTOR_PORT")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(7878);
                let tailscale_https = std::env::var("SWATH_CONNECTOR_TAILSCALE_HTTPS")
                    .is_ok_and(|value| !matches!(value.as_str(), "0" | "false" | "no"));
                let options = saved.unwrap_or_else(|| remote::RemoteServerOptions {
                    bind,
                    port,
                    token: env_token.unwrap(),
                    tailscale_https,
                    start_on_launch: false,
                });
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = remote.start_from_launch(options, state).await {
                        eprintln!("failed to auto-start remote connector: {err}");
                        remote.report_startup_error(err);
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
            commands::config_snapshot,
            commands::config_commit,
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
            commands::remote_server_auto_start,
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

/// Run the existing v1 connector and execution RPCs without creating a Tauri window.
pub async fn run_headless(
    data_dir: std::path::PathBuf,
    options: remote::RemoteServerOptions,
) -> anyhow::Result<()> {
    use fs2::FileExt;
    use std::fs::{self, File};
    if !data_dir.is_absolute() {
        anyhow::bail!("SWATH_DATA_DIR must be an absolute path");
    }
    fs::create_dir_all(&data_dir)?;
    let lock = File::create(data_dir.join("runtime.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow::anyhow!("another Swath runtime owns {}", data_dir.display()))?;
    let remote = Arc::new(remote::RemoteServerManager::new_headless(data_dir));
    let state = AppState {
        terminal: Arc::new(TerminalManager::new(remote.event_sink())),
        pi: Arc::new(PiManager::new()),
        remote: remote.clone(),
    };
    remote
        .start(options, state.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    remote.shutdown();
    state.terminal.kill_all();
    state.pi.kill_all();
    drop(lock);
    Ok(())
}

pub fn headless_options(token: String) -> remote::RemoteServerOptions {
    remote::RemoteServerOptions {
        bind: std::env::var("SWATH_CONNECTOR_BIND").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("SWATH_CONNECTOR_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(7878),
        token,
        start_on_launch: false,
        tailscale_https: std::env::var("SWATH_CONNECTOR_TAILSCALE_HTTPS")
            .is_ok_and(|v| !matches!(v.as_str(), "0" | "false" | "no")),
    }
}
