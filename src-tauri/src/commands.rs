use crate::types::*;
use crate::{ask_images, config, files, git, migration, network, platform, AppState};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Manager, State, Window};

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
pub fn local_state_load(
    state: State<'_, AppState>,
    interface_id: String,
) -> CommandResult<Option<LocalInterfaceState>> {
    config::load_local_interface_state(state.core.data_dir(), &interface_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn local_state_save(
    state: State<'_, AppState>,
    local_state: LocalInterfaceState,
    expected_revision: i64,
) -> CommandResult<()> {
    config::save_local_interface_state(state.core.data_dir(), &local_state, expected_revision)
        .map_err(|err| err.to_string())
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
pub async fn clipboard_read_for_terminal(
    app: AppHandle,
) -> CommandResult<TerminalClipboardPayload> {
    tauri::async_runtime::spawn_blocking(move || platform::read_clipboard_for_terminal(app))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
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
pub async fn terminal_create(
    state: State<'_, AppState>,
    request: TerminalSessionStartRequest,
) -> CommandResult<()> {
    state
        .remote
        .dispatch(
            "terminal.create",
            serde_json::to_value(request).map_err(|e| e.to_string())?,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> CommandResult<()> {
    state
        .remote
        .dispatch(
            "terminal.write",
            serde_json::json!({"sessionId":session_id,"data":data}),
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    request: PtyResizeRequest,
) -> CommandResult<()> {
    state
        .remote
        .dispatch(
            "terminal.resize",
            serde_json::to_value(request).map_err(|e| e.to_string())?,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn terminal_kill(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    state
        .remote
        .dispatch("terminal.kill", serde_json::json!({"sessionId":session_id}))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn terminal_attach(
    state: State<'_, AppState>,
    request: TerminalSessionAttachRequest,
) -> CommandResult<TerminalSessionStatus> {
    serde_json::from_value(
        state
            .remote
            .dispatch(
                "terminal.attach",
                serde_json::to_value(request).map_err(|e| e.to_string())?,
            )
            .await?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_restart(
    state: State<'_, AppState>,
    session_id: String,
) -> CommandResult<TerminalSessionStatus> {
    serde_json::from_value(
        state
            .remote
            .dispatch(
                "terminal.restart",
                serde_json::json!({"sessionId":session_id}),
            )
            .await?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_replay(
    state: State<'_, AppState>,
    _window: Window,
    session_id: String,
) -> CommandResult<TerminalSessionStatus> {
    serde_json::from_value(
        state
            .remote
            .dispatch(
                "terminal.replay",
                serde_json::json!({"sessionId":session_id}),
            )
            .await?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_set_streaming(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> CommandResult<()> {
    state
        .remote
        .dispatch(
            "terminal.setStreaming",
            serde_json::json!({"sessionId":session_id,"enabled":enabled}),
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn terminal_is_busy(
    state: State<'_, AppState>,
    session_id: String,
) -> CommandResult<bool> {
    serde_json::from_value(
        state
            .remote
            .dispatch(
                "terminal.isBusy",
                serde_json::json!({"sessionId":session_id}),
            )
            .await?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_rpc(
    app: AppHandle,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    let state = app.state::<AppState>();
    if request.get("taskId").is_some()
        || request.get("paneId").is_some()
        || request.get("sessionId").is_some()
    {
        return state.remote.dispatch("git.rpc", request).await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        git::rpc(&app, request).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ask_images_load(request: serde_json::Value) -> CommandResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || ask_images::load(request))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn files_rpc(
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    if request.get("taskId").is_some()
        || request.get("paneId").is_some()
        || request.get("sessionId").is_some()
    {
        return state.remote.dispatch("files.rpc", request).await;
    }
    tauri::async_runtime::spawn_blocking(move || files::rpc(request))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn pi_rpc(
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    state.remote.dispatch("pi.rpc", request).await
}

#[tauri::command]
pub async fn task_rpc(
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    state.remote.dispatch("task.rpc", request).await
}

#[tauri::command]
pub async fn sync_snapshot(
    state: State<'_, AppState>,
    network_id: String,
) -> CommandResult<serde_json::Value> {
    state
        .remote
        .dispatch(
            "sync.snapshot",
            serde_json::json!({"networkId": network_id}),
        )
        .await
}

#[tauri::command]
pub async fn sync_changes(
    state: State<'_, AppState>,
    network_id: String,
    cursor: Option<serde_json::Value>,
) -> CommandResult<serde_json::Value> {
    state
        .remote
        .dispatch(
            "sync.changes",
            serde_json::json!({"networkId": network_id, "cursor": cursor}),
        )
        .await
}

#[tauri::command]
pub async fn sync_ack(
    state: State<'_, AppState>,
    network_id: String,
    cursor: Option<serde_json::Value>,
) -> CommandResult<serde_json::Value> {
    state
        .remote
        .dispatch(
            "sync.ack",
            serde_json::json!({"networkId": network_id, "cursor": cursor}),
        )
        .await
}

#[tauri::command]
pub async fn sync_conflicts(
    state: State<'_, AppState>,
    network_id: String,
) -> CommandResult<serde_json::Value> {
    state
        .remote
        .dispatch(
            "sync.conflicts",
            serde_json::json!({"networkId": network_id}),
        )
        .await
}

fn network_connection(state: &AppState) -> CommandResult<rusqlite::Connection> {
    config::connection_at(&config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub(crate) fn catalog_snapshot_at(
    conn: &rusqlite::Connection,
    network_id: &str,
) -> CommandResult<serde_json::Value> {
    network::catalog_snapshot(conn, network_id)
}

/// Reads the local catalog selection. This must never initialize a network: startup
/// is gated on an explicit user decision.
#[tauri::command]
pub fn network_current(state: State<'_, AppState>) -> CommandResult<Option<serde_json::Value>> {
    let conn = network_connection(&state)?;
    let id = conn
        .query_row(
            "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(id) = id else { return Ok(None) };
    let mut snapshot = catalog_snapshot_at(&conn, &id)?;
    let status = migration::status(&conn).map_err(|e| e.to_string())?;
    if status.needs_migration {
        let operation_id = status
            .operation_id
            .unwrap_or_else(|| "legacy-v2-import".into());
        let preview = migration::preview(&conn, &operation_id).map_err(|e| e.to_string())?;
        snapshot["legacyMigration"] = serde_json::to_value(preview).map_err(|e| e.to_string())?;
    }
    Ok(Some(snapshot))
}

#[tauri::command]
pub fn network_initialize(
    state: State<'_, AppState>,
    name: String,
) -> CommandResult<serde_json::Value> {
    let conn = network_connection(&state)?;
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return catalog_snapshot_at(&conn, &id);
    }
    let id = network::random_id(&conn, "net").map_err(|e| e.to_string())?;
    let host = hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .unwrap_or_else(|| "swath-device".into());
    conn.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES(?1,?2,2,1,strftime('%s','now'))", params![id, name.trim()]).map_err(|e| e.to_string())?;
    let device = network::ensure_local_device(&conn, &id, &host, std::env::consts::OS)
        .map_err(|e| e.to_string())?;
    network::set_coordinator_health(&conn, &id, &device, true, true).map_err(|e| e.to_string())?;
    catalog_snapshot_at(&conn, &id)
}

#[tauri::command]
pub fn network_discover() -> Vec<serde_json::Value> {
    let output = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output();
    let Ok(output) = output else { return vec![] };
    let Ok(status) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return vec![];
    };
    status.get("Peer").and_then(|v| v.as_object()).into_iter().flat_map(|peers| peers.values()).filter_map(|peer| {
        let host = peer.get("DNSName")?.as_str()?.trim_end_matches('.');
        Some(serde_json::json!({"name":host,"url":format!("https://{host}"),"online":peer.get("Online").and_then(|v|v.as_bool()).unwrap_or(false)}))
    }).collect()
}

async fn catalog_write(
    state: &AppState,
    request: network::raft::CatalogRequest,
) -> CommandResult<network::raft::CatalogResponse> {
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let service = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    service
        .client_write(request)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap_or(e.message))
}

#[tauri::command]
pub async fn network_request_join(
    state: State<'_, AppState>,
    network_id: String,
    endpoint: String,
    enrollment_secret: String,
) -> CommandResult<serde_json::Value> {
    if enrollment_secret.len() < 16 {
        return Err("enrollment secret must be at least 16 characters".into());
    }
    let conn = network_connection(&state)?;
    let endpoint = endpoint.trim_end_matches('/');
    if let Some(enrollment_id) = conn
        .query_row(
            "SELECT enrollment_id FROM pending_enrollments WHERE network_id=?1 AND endpoint=?2 AND secret=?3 ORDER BY created_at DESC LIMIT 1",
            params![network_id, endpoint, enrollment_secret],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(serde_json::json!({"enrollmentId":enrollment_id,"state":"pending"}));
    }
    let enrollment_id = network::random_id(&conn, "enroll").map_err(|e| e.to_string())?;
    let coordinator =
        reqwest::Url::parse(endpoint).map_err(|_| "invalid coordinator endpoint".to_string())?;
    if coordinator.scheme() != "https"
        && !matches!(
            coordinator.host_str(),
            Some("127.0.0.1" | "localhost" | "::1")
        )
    {
        return Err("coordinator must use HTTPS (HTTP is only allowed for loopback tests)".into());
    }
    let connector = state.remote.status();
    if !connector.running {
        return Err("connector must be running before requesting enrollment".into());
    }
    let connector_endpoint = connector.https_url.unwrap_or_else(|| {
        format!(
            "http://{}:{}",
            connector.bind.unwrap_or_default(),
            connector.port.unwrap_or(0)
        )
    });
    let joining = reqwest::Url::parse(&connector_endpoint)
        .map_err(|_| "invalid local connector endpoint".to_string())?;
    if joining.scheme() != "https"
        && !matches!(joining.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
    {
        return Err("joining connector must be reachable via Tailscale HTTPS (HTTP is only allowed for loopback tests)".into());
    }
    let node_id: i64 = conn
        .query_row("SELECT abs(random())", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let hostname = hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .unwrap_or_else(|| "swath-device".into());
    let metadata = serde_json::json!({"displayName":hostname,"hostname":hostname,"platform":std::env::consts::OS});
    let response = reqwest::Client::new().post(format!("{endpoint}/api/enrollment/request"))
        .json(&serde_json::json!({"networkId":network_id,"enrollmentId":enrollment_id,"secret":enrollment_secret,"nodeId":node_id,"connectorEndpoint":connector_endpoint,"metadata":metadata}))
        .send().await.map_err(|e| format!("coordinator_unreachable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "join_request_rejected: {}",
            response.text().await.unwrap_or_default()
        ));
    }
    // This is a device-local pending credential, not catalog state. It survives restart so the
    // client can poll the supplied coordinator without submitting a second join request.
    conn.execute("INSERT INTO pending_enrollments(enrollment_id,network_id,endpoint,secret,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))", params![enrollment_id, network_id, endpoint, enrollment_secret]).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"enrollmentId": enrollment_id, "state":"pending"}))
}

#[tauri::command]
pub async fn network_join_status(
    state: State<'_, AppState>,
    enrollment_id: String,
) -> CommandResult<serde_json::Value> {
    network::join_status(network_connection(&state)?, enrollment_id).await
}

#[tauri::command]
pub async fn network_approve_join(
    state: State<'_, AppState>,
    network_id: String,
    enrollment_id: String,
) -> CommandResult<serde_json::Value> {
    let response = catalog_write(&state, network::raft::CatalogRequest::Device {
        operation_id: format!("approve-enrollment:{enrollment_id}"), expected_revision: 0,
        payload: serde_json::json!({"action":"approve_join","networkId":network_id,"enrollmentId":enrollment_id}),
    }).await?;
    let approved: serde_json::Value =
        serde_json::from_str(response.value.as_deref().unwrap_or("{}"))
            .map_err(|e| e.to_string())?;
    let node_id = approved
        .get("nodeId")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "invalid approval".to_string())?;
    let endpoint = approved
        .get("endpoint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "invalid approval".to_string())?;
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let service = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    service
        .raft()
        .add_learner(node_id, openraft::BasicNode::new(endpoint))
        .await
        .map_err(|e| e.to_string())?;
    Ok(approved)
}

#[tauri::command]
pub async fn network_promote(
    state: State<'_, AppState>,
    network_id: String,
    device_id: String,
) -> CommandResult<()> {
    let conn = network_connection(&state)?;
    let revision: i64 = conn
        .query_row(
            "SELECT revision FROM networks WHERE id=?1 AND tombstoned_at IS NULL",
            [&network_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut ids: Vec<u64> = conn.prepare("SELECT r.node_id FROM raft_node_members r JOIN coordinator_members m ON m.network_id=r.network_id AND m.device_id=r.device_id WHERE r.network_id=?1 AND (m.voter=1 OR r.device_id=?2)").map_err(|e| e.to_string())?.query_map(params![network_id,device_id], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?.into_iter().map(|id| id as u64).collect();
    ids.sort_unstable();
    ids.dedup();
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let service = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    // add_learner waits for catch-up; commit the SQL voter projection only after Raft agrees.
    service
        .raft()
        .change_membership(ids)
        .await
        .map_err(|e| e.to_string())?;
    drop(conn);
    let response = catalog_write(
        &state,
        network::raft::CatalogRequest::Membership {
            operation_id: format!("promote:{network_id}:{device_id}:{revision}"),
            expected_revision: revision,
            payload: serde_json::json!({
                "networkId": network_id,
                "deviceId": device_id,
                "voter": true,
                "healthy": false
            }),
        },
    )
    .await?;
    if response.status == "committed" {
        Ok(())
    } else {
        Err(response.status)
    }
}

#[tauri::command]
pub fn network_membership(
    state: State<'_, AppState>,
    network_id: String,
) -> CommandResult<Vec<network::Member>> {
    network::membership(&network_connection(&state)?, &network_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn network_health(
    state: State<'_, AppState>,
    network_id: String,
) -> CommandResult<network::Health> {
    network::health(&network_connection(&state)?, &network_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn catalog_snapshot(
    state: State<'_, AppState>,
    network_id: String,
) -> CommandResult<serde_json::Value> {
    catalog_snapshot_at(&network_connection(&state)?, &network_id)
}

#[tauri::command]
pub fn migration_status(state: State<'_, AppState>) -> CommandResult<serde_json::Value> {
    let status = migration::status(&network_connection(&state)?).map_err(|e| e.to_string())?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn migration_export(state: State<'_, AppState>) -> CommandResult<serde_json::Value> {
    serde_json::to_value(
        migration::export(&network_connection(&state)?).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn migration_conflicts(state: State<'_, AppState>) -> CommandResult<serde_json::Value> {
    serde_json::to_value(
        migration::conflicts(&network_connection(&state)?).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn migration_ensure_resolution_job(
    state: State<'_, AppState>,
    conflict_id: String,
) -> CommandResult<serde_json::Value> {
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let catalog = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    let data_dir = state.core.data_dir().to_path_buf();
    let runtime = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = config::connection_at(&config::db_path_in(&data_dir)?)?;
        runtime.block_on(migration::ensure_resolution_job(
            &connection,
            &catalog,
            &conflict_id,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn migration_submit_proposal(
    state: State<'_, AppState>,
    proposal: migration::Proposal,
) -> CommandResult<serde_json::Value> {
    migration::submit_proposal(&network_connection(&state)?, proposal).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn migration_approve_proposal(
    state: State<'_, AppState>,
    approval: migration::Approval,
) -> CommandResult<serde_json::Value> {
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let catalog = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    let data_dir = state.core.data_dir().to_path_buf();
    let runtime = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = config::connection_at(&config::db_path_in(&data_dir)?)?;
        runtime.block_on(migration::approve_proposal(
            &mut connection,
            &catalog,
            approval,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn migration_preview(
    state: State<'_, AppState>,
    operation_id: String,
) -> CommandResult<serde_json::Value> {
    let conn = network_connection(&state)?;
    let preview = migration::preview(&conn, &operation_id).map_err(|e| e.to_string())?;
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn migration_confirm(
    state: State<'_, AppState>,
    request: migration::ImportRequest,
) -> CommandResult<serde_json::Value> {
    let db = config::db_path_in(state.core.data_dir()).map_err(|e| e.to_string())?;
    let catalog = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-catalog-command",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "network_not_found".to_string())?;
    let mut conn = network_connection(&state)?;
    migration::confirm(state.core.data_dir(), &mut conn, &catalog, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn catalog_mutate(
    state: State<'_, AppState>,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    let network_id = request
        .get("networkId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "invalid_request".to_string())?;
    let operation_id = request
        .get("operationId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "operationId is required".to_string())?;
    let expected = request
        .get("expectedRevision")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "expectedRevision is required".to_string())?;
    let name = request
        .pointer("/mutation/name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "invalid mutation".to_string())?;
    let response = catalog_write(
        &state,
        network::raft::CatalogRequest::Network {
            operation_id: operation_id.into(),
            expected_revision: expected,
            payload: serde_json::json!({"networkId":network_id,"name":name}),
        },
    )
    .await?;
    serde_json::from_str(response.value.as_deref().unwrap_or("{}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_server_start(
    state: State<'_, AppState>,
    options: crate::remote::RemoteServerOptions,
) -> CommandResult<crate::remote::RemoteServerStatus> {
    state.remote.start(options).await
}

#[tauri::command]
pub async fn remote_server_stop(state: State<'_, AppState>) -> CommandResult<()> {
    state.remote.stop().await;
    Ok(())
}

#[tauri::command]
pub fn remote_server_status(state: State<'_, AppState>) -> crate::remote::RemoteServerStatus {
    state.remote.status()
}
