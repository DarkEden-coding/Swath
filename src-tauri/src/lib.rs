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
        tailscale_https_port: std::env::var("SWATH_CONNECTOR_TAILSCALE_HTTPS_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(443),
        allowed_origins: std::env::var("SWATH_CONNECTOR_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_string())
            .collect(),
    }
}

/// Converts an existing healthy Raft deployment to one durable catalog server.
///
/// This is intentionally a local, operator-run migration rather than a UI action. It first
/// commits Raft membership containing only the local device, then records that fixed server in
/// the catalog projection. Call it on the current leader while all existing voters are online.
pub async fn migrate_to_single_server(
    data_dir: std::path::PathBuf,
    token: String,
) -> anyhow::Result<()> {
    config::initialize(&data_dir)?;
    let db = config::db_path_in(&data_dir)?;
    let conn = config::connection_at(&db)?;
    let network_id: String = conn.query_row(
        "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    if network::is_single_server(&conn, &network_id)? {
        return Ok(());
    }
    // A replicated projection can carry another device's `local-device` marker. The catalog
    // node is this physical server's durable identity, so prefer its Raft-node binding.
    let local_device: String = conn
        .query_row(
            "SELECT r.device_id FROM catalog_nodes c JOIN raft_node_members r ON r.network_id=c.network_id AND r.node_id=c.node_id WHERE c.network_id=?1",
            [&network_id],
            |row| row.get(0),
        )
        .or_else(|_| {
            conn.query_row(
                "SELECT id FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL",
                [&network_id],
                |row| row.get(0),
            )
        })?;
    let local_node: i64 = conn.query_row(
        "SELECT node_id FROM raft_node_members WHERE network_id=?1 AND device_id=?2",
        rusqlite::params![network_id, local_device],
        |row| row.get(0),
    )?;
    let network_revision: i64 = conn.query_row(
        "SELECT revision FROM networks WHERE id=?1",
        [&network_id],
        |row| row.get(0),
    )?;
    let endpoint: String = conn.query_row(
        "SELECT endpoint FROM catalog_nodes WHERE network_id=?1",
        [&network_id],
        |row| row.get(0),
    )?;
    drop(conn);

    let catalog = network::raft::CatalogService::open(
        db.to_string_lossy(),
        network_id.clone(),
        local_node as network::raft::NodeId,
        token,
        endpoint,
    )
    .await?;
    // OpenRaft only accepts this from the current leader. A just-started server can know the
    // previous leader before its local Raft worker is ready to accept writes, so wait briefly
    // rather than treating that transient state as a failed migration. Any persistent failure
    // leaves the existing configuration intact.
    let mut last_error = None;
    for _ in 0..40 {
        match catalog
            .raft()
            .change_membership(vec![local_node as network::raft::NodeId])
            .await
        {
            Ok(_) => {
                last_error = None;
                break;
            }
            Err(error) => {
                last_error = Some(error.to_string());
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
    }
    if let Some(error) = last_error {
        return Err(anyhow::anyhow!(
            "power-server did not become the Raft leader: {error}"
        ));
    }

    // Commit the topology marker through the state machine so every retained learner routes
    // catalog operations to the same fixed server. A direct SQLite update here would be local-only
    // and could later be overwritten by snapshot replay.
    let topology_operation = format!("single-server:{network_id}:{local_device}");
    let topology = catalog
        .client_write(network::raft::CatalogRequest::Network {
            operation_id: topology_operation.clone(),
            expected_revision: network_revision,
            payload: serde_json::json!({
                "action":"set_server",
                "networkId":network_id,
                "serverDeviceId":local_device
            }),
        })
        .await
        .map_err(|error| {
            anyhow::anyhow!("failed to commit fixed catalog server: {}", error.message)
        })?;
    if topology.status != "committed" {
        return Err(anyhow::anyhow!(
            "failed to commit fixed catalog server: {}",
            topology.status
        ));
    }
    if !catalog
        .wait_for_operation(&topology_operation, std::time::Duration::from_secs(15))
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?
    {
        return Err(anyhow::anyhow!(
            "fixed catalog server committed but was not projected locally"
        ));
    }
    catalog.raft().trigger_snapshot().await?;
    Ok(())
}

/// Destructively reseeds a broken multi-voter catalog as one server while retaining its catalog
/// projection. This is an operator recovery command: it removes only the other *voter* devices,
/// refuses to proceed if one owns an active task, and discards the old Raft consensus state.
pub fn reseed_single_server(data_dir: std::path::PathBuf) -> anyhow::Result<()> {
    config::initialize(&data_dir)?;
    let db = config::db_path_in(&data_dir)?;
    let mut conn = config::connection_at(&db)?;
    let network_id: String = conn.query_row(
        "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    let local_device: String = conn
        .query_row(
            "SELECT r.device_id FROM catalog_nodes c JOIN raft_node_members r ON r.network_id=c.network_id AND r.node_id=c.node_id WHERE c.network_id=?1",
            [&network_id],
            |row| row.get(0),
        )
        .or_else(|_| {
            conn.query_row(
                "SELECT id FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL",
                [&network_id],
                |row| row.get(0),
            )
        })?;
    let retired_voters: Vec<String> = conn
        .prepare(
            "SELECT device_id FROM coordinator_members WHERE network_id=?1 AND voter=1 AND device_id!=?2",
        )?
        .query_map(rusqlite::params![network_id, local_device], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let active_on_retired: i64 = conn.query_row(
        "SELECT count(*) FROM tasks WHERE lifecycle='active' AND assigned_device_id IN (SELECT device_id FROM coordinator_members WHERE network_id=?1 AND voter=1 AND device_id!=?2)",
        rusqlite::params![network_id, local_device],
        |row| row.get(0),
    )?;
    if active_on_retired != 0 {
        return Err(anyhow::anyhow!(
            "refusing to retire coordinators with {active_on_retired} active task(s)"
        ));
    }
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS raft_catalog_state (network_id TEXT PRIMARY KEY, payload BLOB NOT NULL)",
    )?;
    tx.execute(
        "UPDATE networks SET server_device_id=?1 WHERE id=?2",
        rusqlite::params![local_device, network_id],
    )?;
    tx.execute(
        "UPDATE coordinator_members SET voter=1,healthy=1 WHERE network_id=?1 AND device_id=?2",
        rusqlite::params![network_id, local_device],
    )?;
    for device_id in retired_voters {
        tx.execute(
            "DELETE FROM coordinator_members WHERE network_id=?1 AND device_id=?2",
            rusqlite::params![network_id, device_id],
        )?;
        tx.execute(
            "DELETE FROM raft_node_members WHERE network_id=?1 AND device_id=?2",
            rusqlite::params![network_id, device_id],
        )?;
        tx.execute(
            "DELETE FROM device_connectors WHERE device_id=?1",
            [device_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM git_replicas WHERE network_id=?1 AND device_id=?2",
            rusqlite::params![network_id, device_id],
        )?;
        tx.execute(
            "UPDATE devices SET tombstoned_at=strftime('%s','now') WHERE id=?1",
            [device_id.as_str()],
        )?;
    }
    tx.execute("DELETE FROM raft_log WHERE network_id=?1", [&network_id])?;
    tx.execute(
        "DELETE FROM raft_snapshots WHERE network_id=?1",
        [&network_id],
    )?;
    tx.execute(
        "DELETE FROM raft_hard_state WHERE network_id=?1",
        [&network_id],
    )?;
    // The state-machine record includes the last applied log ID and membership. Keeping it while
    // deleting the log/snapshot strands the new single voter behind the old multi-voter quorum.
    // Catalog projections (networks, devices, tasks, etc.) remain intact.
    tx.execute(
        "DELETE FROM raft_catalog_state WHERE network_id=?1",
        [&network_id],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod single_server_recovery_tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reseed_discards_stale_membership_but_preserves_catalog_projection() {
        let dir =
            std::env::temp_dir().join(format!("swath-single-server-reseed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        config::initialize(&dir).unwrap();
        let db = config::db_path_in(&dir).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS raft_catalog_state (network_id TEXT PRIMARY KEY, payload BLOB NOT NULL);
             INSERT INTO networks(id,name,schema_version,revision,created_at)
                 VALUES('network','Network',2,1,0);
             INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at)
                 VALUES('server','network','Server','server','test','local-device',1,0),
                       ('client','network','Client','client','test','joined-device',1,0);
             INSERT INTO coordinator_members(network_id,device_id,voter,healthy,promoted_at)
                 VALUES('network','server',1,1,0);
             INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint)
                 VALUES('network','server',42,'http://127.0.0.1:1');
             INSERT INTO catalog_nodes(network_id,node_id,endpoint,updated_at)
                 VALUES('network',42,'http://127.0.0.1:1',0);
             INSERT INTO raft_catalog_state(network_id,payload)
                 VALUES('network','{"last":{"index":123},"membership":{"configs":[[1,2,42]]},"data":{}}');
             INSERT INTO raft_log(network_id,log_index,term,payload)
                 VALUES('network',123,1,x'01');"#,
        )
        .unwrap();
        drop(conn);

        reseed_single_server(dir.clone()).unwrap();
        let conn = Connection::open(&db).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM raft_catalog_state WHERE network_id='network'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = conn
            .query_row("SELECT count(*) FROM raft_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let fixed: String = conn
            .query_row(
                "SELECT server_device_id FROM networks WHERE id='network'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fixed, "server");
        let client_active: i64 = conn
            .query_row(
                "SELECT count(*) FROM devices WHERE id='client' AND tombstoned_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(client_active, 1);
        drop(conn);
        let service = network::raft::CatalogService::open(
            db.to_string_lossy(),
            "network",
            42,
            "0123456789abcdef",
            "http://127.0.0.1:1",
        )
        .await
        .unwrap();
        let ready = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if service.raft().raft.metrics().borrow().current_leader == Some(42) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(ready.is_ok(), "reseeded single server must elect itself");
        service.raft().shutdown().await;
        let _ = fs::remove_dir_all(dir);
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
            // Managed desktop executors (for example Fedora launchers replacing a headless
            // service) must open the same durable network catalog as the headless runtime.
            let data_dir = std::env::var_os("SWATH_DATA_DIR")
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
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
            if std::env::var("SWATH_CONNECTOR_AUTOSTART")
                .is_ok_and(|value| !matches!(value.as_str(), "0" | "false" | "no"))
            {
                if let Ok(token) = std::env::var("SWATH_CONNECTOR_TOKEN") {
                    let options = headless_options(token);
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = remote.start(options).await {
                            eprintln!("Unable to auto-start Swath connector: {error}");
                        }
                    });
                }
            }
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
            commands::network_demote,
            commands::network_membership,
            commands::network_health,
            commands::catalog_snapshot,
            commands::catalog_mutate,
            commands::migration_status,
            commands::migration_preview,
            commands::migration_confirm,
            commands::migration_export,
            commands::migration_conflicts,
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
