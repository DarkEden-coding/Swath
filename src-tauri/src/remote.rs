//! Authenticated, low-overhead Swath connector for Tailscale/LAN access.
//!
//! One WebSocket multiplexes RPC responses and live terminal/Git/Pi events. This avoids polling,
//! duplicates no pane logic, and lets the exact same renderer run in a browser.

use crate::{
    ask_images, config,
    events::{ConnectorEvents, EventPublisher},
    files, git, migration, network, pi_agent, preview,
    runtime::Core,
    tasks,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, Response, StatusCode},
    response::IntoResponse,
    routing::{any, get, post},
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, OptionalExtension};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    path::Path,
    process::{Command, Output},
    str,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    sync::oneshot,
    time::{sleep, Duration},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct WebAssets;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerOptions {
    pub bind: String,
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub tailscale_https: bool,
    /// Tailscale Serve HTTPS listener reserved for this connector. Keeping this configurable
    /// prevents Swath from replacing an existing service on the tailnet's default port 443.
    #[serde(default = "default_tailscale_https_port")]
    pub tailscale_https_port: u16,
    /// Exact browser origins permitted to use this connector.
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

fn default_tailscale_https_port() -> u16 {
    443
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailscale_https: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https_url: Option<String>,
    pub machine_id: String,
    pub platform: String,
}

struct RunningServer {
    options: RemoteServerOptions,
    https_url: Option<String>,
    stop: oneshot::Sender<()>,
    raft: Option<Arc<network::raft::CatalogRaft>>,
    context: ServerContext,
}

pub struct RemoteServerManager {
    core: Arc<Core>,
    machine_id: String,
    running: Mutex<Option<RunningServer>>,
    events: Arc<ConnectorEvents>,
}

#[derive(Clone)]
struct ServerContext {
    core: Arc<Core>,
    token: String,
    connector_endpoint: String,
    machine_id: String,
    // This is the catalog identity, never the mutable hostname advertised to browsers.
    device_id: Option<String>,
    session_tasks: Arc<Mutex<HashMap<String, String>>>,
    events: Arc<ConnectorEvents>,
    peer_relays: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
    allowed_origins: Vec<String>,
    raft: Option<Arc<network::raft::CatalogRaft>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    network_id: String,
    enrollment_id: String,
    secret: String,
    node_id: i64,
    connector_endpoint: String,
    #[serde(default)]
    metadata: serde_json::Value,
}

/// Enrollment is intentionally outside the bearer-authenticated UI RPC: the one-time secret is
/// the join capability. The resulting connector credential is only returned after approval.
async fn enrollment_request(
    State(ctx): State<ServerContext>,
    Json(request): Json<EnrollmentRequest>,
) -> impl IntoResponse {
    if request.network_id.trim().is_empty()
        || request.enrollment_id.trim().is_empty()
        || request.secret.len() < 16
        || request.node_id <= 0
        || !safe_raft_endpoint(&request.connector_endpoint)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"code":"invalid_enrollment"})),
        )
            .into_response();
    }
    let raft = match open_catalog_raft(&ctx.core, &ctx.token, &ctx.connector_endpoint).await {
        Ok(Some(raft)) => raft,
        _ => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"quorum_unavailable"})),
            )
                .into_response()
        }
    };
    match raft.client_write(network::raft::CatalogRequest::Device {
        operation_id: format!("enrollment:{}", request.enrollment_id),
        expected_revision: 0,
        payload: json!({"action":"join_request","networkId":request.network_id,"enrollmentId":request.enrollment_id,"secret":request.secret,"nodeId":request.node_id,"connectorEndpoint":request.connector_endpoint,"metadata":request.metadata}),
    }).await {
        Ok(response) => (StatusCode::ACCEPTED, Json(response.data)).into_response(),
        Err(error) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":"quorum_unavailable","error":error.to_string()}))).into_response(),
    }
}

async fn enrollment_status(
    State(ctx): State<ServerContext>,
    axum::extract::Path(enrollment_id): axum::extract::Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let Some(secret) = query.get("secret") else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":"unauthorized"})),
        )
            .into_response();
    };
    let path = match config::db_path_in(ctx.core.data_dir()) {
        Ok(path) => path,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"catalog_unavailable"})),
            )
                .into_response()
        }
    };
    let db = match config::connection_at(&path) {
        Ok(db) => db,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"catalog_unavailable"})),
            )
                .into_response()
        }
    };
    type EnrollmentState = (String, Option<String>, Option<String>, Option<i64>, String);
    let result: Option<EnrollmentState> = db.query_row(
        "SELECT network_id,device_id,credential,approved_at,challenge_secret FROM enrollment_credentials WHERE enrollment_id=?1",
        [&enrollment_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().ok().flatten();
    match result {
        // The submitted challenge is the capability. Never accept the issued credential (or
        // any other string) as a substitute when polling approval.
        Some((_, _, _, _, challenge)) if challenge != *secret => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":"unauthorized"})),
        )
            .into_response(),
        Some((network_id, Some(device_id), Some(credential), Some(_), _)) => {
            let network: Option<(String, i64, i64)> = db.query_row("SELECT name,schema_version,revision FROM networks WHERE id=?1 AND tombstoned_at IS NULL", [&network_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().ok().flatten();
            let device: Option<(String, String, String)> = db
                .query_row(
                    "SELECT display_name,hostname,platform FROM devices WHERE id=?1",
                    [&device_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .ok()
                .flatten();
            {
                let node: Option<(i64,String)> = db.query_row("SELECT node_id,endpoint FROM raft_node_members WHERE network_id=?1 AND device_id=?2", params![network_id,device_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().ok().flatten();
                let coordinator: Option<(String, i64, String, String)> = db.query_row("SELECT r.device_id,r.node_id,r.endpoint,c.credential FROM raft_node_members r JOIN device_connectors c ON c.device_id=r.device_id WHERE r.network_id=?1 AND r.device_id!=?2 ORDER BY r.node_id LIMIT 1", params![network_id,device_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().ok().flatten();
                (StatusCode::OK, Json(json!({"state":"approved","networkId":network_id,"deviceId":device_id,"credential":credential,"nodeId":node.as_ref().map(|v|v.0),"endpoint":node.as_ref().map(|v|&v.1),"coordinator":coordinator.as_ref().map(|(device_id,node_id,endpoint,credential)|json!({"deviceId":device_id,"nodeId":node_id,"endpoint":endpoint,"credential":credential})),"network":network.map(|(name,schema_version,revision)|json!({"name":name,"schemaVersion":schema_version,"revision":revision})),"device":device.map(|(display_name,hostname,platform)|json!({"displayName":display_name,"hostname":hostname,"platform":platform}))}))).into_response()
            }
        }
        Some(_) => (StatusCode::OK, Json(json!({"state":"pending"}))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"code":"join_request_not_found"})),
        )
            .into_response(),
    }
}

async fn open_catalog_raft(
    core: &Core,
    token: &str,
    address: &str,
) -> Result<Option<Arc<network::raft::CatalogRaft>>, String> {
    let db = config::db_path_in(core.data_dir()).map_err(|e| e.to_string())?;
    Ok(
        network::raft::CatalogService::open_discovered(db.to_string_lossy(), token, address)
            .await
            .map_err(|e| e.to_string())?
            .map(|service| service.raft().clone()),
    )
}

impl RemoteServerManager {
    /// Creates a connector manager attached to an already-owned runtime.
    pub fn new(core: Arc<Core>, events: Arc<ConnectorEvents>) -> Self {
        let machine_id = config::db_path_in(core.data_dir())
            .and_then(|path| config::connection_at(&path))
            .and_then(|conn| network::stable_device_id(&conn))
            .unwrap_or_else(|_| "dev_unavailable".into());
        Self {
            machine_id,
            running: Mutex::new(None),
            events,
            core,
        }
    }

    pub fn status(&self) -> RemoteServerStatus {
        let running = self.running.lock().unwrap();
        RemoteServerStatus {
            running: running.is_some(),
            bind: running.as_ref().map(|v| v.options.bind.clone()),
            port: running.as_ref().map(|v| v.options.port),
            tailscale_https: running.as_ref().map(|v| v.options.tailscale_https),
            https_url: running.as_ref().and_then(|v| v.https_url.clone()),
            machine_id: self.machine_id.clone(),
            platform: std::env::consts::OS.into(),
        }
    }

    pub async fn start(
        &self,
        mut options: RemoteServerOptions,
    ) -> Result<RemoteServerStatus, String> {
        if options.token.trim().len() < 16 {
            return Err("Connector token must be at least 16 characters".into());
        }
        if options.port == 0 {
            options.port = 7878;
        }
        let ip: IpAddr = options.bind.parse().map_err(|_| {
            "Bind address must be an IP address (use 127.0.0.1 with Tailscale Serve)".to_string()
        })?;
        if options.tailscale_https && !ip.is_loopback() {
            return Err(
                "Tailscale Serve requires a loopback backend; use bind address 127.0.0.1".into(),
            );
        }
        self.stop().await;
        let listener = TcpListener::bind((ip, options.port))
            .await
            .map_err(|e| format!("Unable to bind connector: {e}"))?;
        let device_id = local_device_id(&self.core);
        let db_path = config::db_path_in(self.core.data_dir()).map_err(|e| e.to_string())?;
        // The founding node also gets an issued durable credential; subsequent restarts do not
        // trust whatever UI token happened to be configured.
        if let Ok(conn) = config::connection_at(&db_path) {
            if let Some(id) = device_id.as_deref() {
                let _ = conn.execute("INSERT INTO enrollment_credentials(enrollment_id,network_id,device_id,secret,challenge_secret,credential,approved_at,created_at) SELECT 'local:' || ?1,network_id,?1,'local','local',?2,strftime('%s','now'),strftime('%s','now') FROM devices WHERE id=?1 ON CONFLICT(enrollment_id) DO NOTHING", params![id, options.token]);
            }
        }
        let https_url = if options.tailscale_https {
            configure_tailscale_serve(options.port, options.tailscale_https_port)?
        } else {
            None
        };
        let raft_address = https_url
            .clone()
            .unwrap_or_else(|| format!("http://{}:{}", options.bind, options.port));
        if let (Ok(conn), Some(id)) = (config::connection_at(&db_path), device_id.as_deref()) {
            let _ = conn.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,updated_at=strftime('%s','now')", params![id, raft_address, options.token]);
        }
        let context = ServerContext {
            core: self.core.clone(),
            token: options.token.clone(),
            connector_endpoint: raft_address.clone(),
            machine_id: self.machine_id.clone(),
            device_id,
            session_tasks: Arc::new(Mutex::new(HashMap::new())),
            events: self.events.clone(),
            peer_relays: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: options.allowed_origins.clone(),
            raft: open_catalog_raft(&self.core, &options.token, &raft_address).await?,
        };
        let raft = context.raft.clone();
        spawn_durable_event_writer(context.clone());
        let router = Router::new()
            .route("/api/handshake", get(handshake))
            .route("/api/socket", get(socket))
            .route("/api/peer/rpc", post(peer_rpc))
            .route("/api/project/{project_id}/bundle", get(project_bundle))
            .route("/api/enrollment/request", post(enrollment_request))
            .route("/api/enrollment/{enrollment_id}", get(enrollment_status))
            .route("/api/raft/append", post(raft_append))
            .route("/api/raft/vote", post(raft_vote))
            .route("/api/raft/snapshot", post(raft_snapshot))
            .route(
                "/api/preview/{task_id}/{port}/ws/{*path}",
                get(preview_websocket),
            )
            .route("/api/preview/{task_id}/{port}/{*path}", any(preview_proxy))
            .route("/api/preview/{task_id}/{port}", any(preview_proxy_root))
            .route("/{*path}", get(asset))
            .route("/", get(asset_root))
            .with_state(context.clone());
        let (stop_tx, stop_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await;
        });
        *self.running.lock().unwrap() = Some(RunningServer {
            options,
            https_url,
            stop: stop_tx,
            raft,
            context,
        });
        Ok(self.status())
    }

    /// Uses the same ownership fence as connector RPCs for native Tauri calls.
    /// A connector need not be listening: the catalog remains the routing authority.
    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        let context = self
            .running
            .lock()
            .unwrap()
            .as_ref()
            .map(|server| server.context.clone())
            .unwrap_or_else(|| ServerContext {
                core: self.core.clone(),
                token: String::new(),
                connector_endpoint: "http://127.0.0.1:0".into(),
                machine_id: self.machine_id.clone(),
                device_id: local_device_id(&self.core),
                session_tasks: Arc::new(Mutex::new(HashMap::new())),
                events: self.events.clone(),
                peer_relays: Arc::new(Mutex::new(HashMap::new())),
                allowed_origins: vec![],
                raft: None,
            });
        dispatch_to_owner(&context, method, params, 0, None).await
    }

    pub async fn stop(&self) {
        let server = { self.running.lock().unwrap().take() };
        if let Some(server) = server {
            let _ = server.stop.send(());
            if let Some(raft) = server.raft {
                raft.shutdown().await;
            }
            if server.options.tailscale_https {
                let serve_port = format!("--https={}", server.options.tailscale_https_port);
                let _ = run_tailscale(&["serve", serve_port.as_str(), "off"]);
            }
        }
    }
}

fn local_device_id(core: &Core) -> Option<String> {
    config::connection_at(&config::db_path_in(core.data_dir()).ok()?).ok()?.query_row(
        "SELECT d.id FROM devices d JOIN networks n ON n.id=d.network_id LEFT JOIN catalog_nodes c ON c.network_id=d.network_id LEFT JOIN raft_node_members r ON r.network_id=d.network_id AND r.device_id=d.id WHERE (d.enrollment_id='local-device' OR r.node_id=c.node_id) AND d.tombstoned_at IS NULL AND n.tombstoned_at IS NULL ORDER BY n.created_at,d.id LIMIT 1", [], |row| row.get(0)).optional().ok().flatten()
}

fn run_tailscale(args: &[&str]) -> Result<Output, String> {
    let configured = std::env::var("SWATH_TAILSCALE_BIN").ok();
    let mut candidates: Vec<&str> = configured.iter().map(String::as_str).collect();
    candidates.push("tailscale");
    if cfg!(target_os = "macos") {
        candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    }
    let mut last_error = None;
    for candidate in candidates {
        if candidate.contains('/') && !Path::new(candidate).is_file() {
            continue;
        }
        match Command::new(candidate).args(args).output() {
            Ok(output) => return Ok(output),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "Unable to run Tailscale CLI{}",
        last_error
            .map(|error| format!(": {error}"))
            .unwrap_or_default()
    ))
}

fn configure_tailscale_serve(port: u16, https_port: u16) -> Result<Option<String>, String> {
    let target = format!("http://127.0.0.1:{port}");
    let serve_port = format!("--https={https_port}");
    let output = run_tailscale(&[
        "serve",
        "--bg",
        "--yes",
        serve_port.as_str(),
        target.as_str(),
    ])?;
    let message = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(format!(
            "Unable to enable Tailscale Serve: {}",
            message.trim()
        ));
    }
    Ok(tailscale_https_url(&message).or_else(tailscale_dns_url))
}

fn tailscale_https_url(message: &str) -> Option<String> {
    message.lines().find_map(|line| {
        let start = line.find("https://")?;
        let url = &line[start..];
        let end = url
            .find(|character: char| character.is_whitespace() || character == '\u{1b}')
            .unwrap_or(url.len());
        Some(url[..end].to_string())
    })
}

fn tailscale_dns_url() -> Option<String> {
    let output = run_tailscale(&["status", "--json"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let status: Value = serde_json::from_slice(&output.stdout).ok()?;
    let dns_name = status.get("Self")?.get("DNSName")?.as_str()?;
    Some(format!("https://{}/", dns_name.trim_end_matches('.')))
}

fn safe_raft_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() == "https" {
        return url.host_str().is_some();
    }
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let encoded = headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("swath_token=").map(str::to_string))?;
    String::from_utf8(Base64UrlUnpadded::decode_vec(&encoded).ok()?).ok()
}

fn protocol_token(headers: &HeaderMap) -> Option<String> {
    let protocols = headers.get(header::SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    protocols.split(',').map(str::trim).find_map(|item| {
        let encoded = item.strip_prefix("auth.")?;
        String::from_utf8(Base64UrlUnpadded::decode_vec(encoded).ok()?).ok()
    })
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    bearer(headers).is_some_and(|v| v == expected)
        || cookie_token(headers).is_some_and(|v| v == expected)
        || protocol_token(headers).is_some_and(|v| v == expected)
}

/// Returns every catalog-issued capability that currently identifies this device.
///
/// `enrollment_credentials` is the source of truth, while `device_connectors` is the
/// destination capability distributed to peers. During credential repair/rotation those two
/// replicated rows can briefly differ, so accepting either prevents an otherwise healthy peer
/// from being locked out while still requiring a capability stored for this exact device.
fn local_peer_credentials(ctx: &ServerContext) -> Vec<String> {
    let Some(device_id) = ctx.device_id.clone().or_else(|| local_device_id(&ctx.core)) else {
        return Vec::new();
    };
    let Ok(path) = config::db_path_in(ctx.core.data_dir()) else {
        return Vec::new();
    };
    let Ok(conn) = config::connection_at(&path) else {
        return Vec::new();
    };
    let mut credentials = Vec::new();
    if let Ok(Some(value)) = conn
        .query_row(
            "SELECT credential FROM enrollment_credentials WHERE device_id=?1 AND credential IS NOT NULL ORDER BY approved_at DESC LIMIT 1",
            [&device_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        credentials.push(value);
    }
    if let Ok(Some(value)) = conn
        .query_row(
            "SELECT credential FROM device_connectors WHERE device_id=?1",
            [&device_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        if !credentials.contains(&value) {
            credentials.push(value);
        }
    }
    credentials
}

fn peer_authorized(ctx: &ServerContext, headers: &HeaderMap) -> bool {
    let credentials = local_peer_credentials(ctx);
    credentials
        .iter()
        .any(|credential| authorized(headers, credential))
        || (credentials.is_empty() && authorized(headers, &ctx.token))
}

async fn raft_context(
    ctx: &ServerContext,
    headers: &HeaderMap,
) -> Result<Arc<network::raft::CatalogRaft>, (StatusCode, Json<Value>)> {
    // Raft is intentionally not authenticated by the arbitrary browser connector token.
    // Only the credential issued for this local enrolled device is accepted.
    let credential = bearer(headers);
    let accepted = local_peer_credentials(ctx);
    if !credential.is_some_and(|value| accepted.iter().any(|item| item == value)) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        ));
    }
    if let Some(raft) = ctx.raft.clone() {
        return Ok(raft);
    }
    open_catalog_raft(&ctx.core, &ctx.token, &ctx.connector_endpoint)
        .await
        .map_err(|message| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":"executor_unreachable","message":message}))))?
        .ok_or_else(|| (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":"executor_unreachable","message":"catalog raft is not initialized"}))))
}

async fn raft_append(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(request): Json<openraft::raft::AppendEntriesRequest<network::raft::CatalogType>>,
) -> Result<
    Json<openraft::raft::AppendEntriesResponse<network::raft::NodeId>>,
    (StatusCode, Json<Value>),
> {
    let raft = raft_context(&ctx, &headers).await?;
    raft.append(request).await.map(Json).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":e.to_string()})),
        )
    })
}

async fn raft_vote(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(request): Json<openraft::raft::VoteRequest<network::raft::NodeId>>,
) -> Result<Json<openraft::raft::VoteResponse<network::raft::NodeId>>, (StatusCode, Json<Value>)> {
    let raft = raft_context(&ctx, &headers).await?;
    raft.vote(request).await.map(Json).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":e.to_string()})),
        )
    })
}

async fn raft_snapshot(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(request): Json<openraft::raft::InstallSnapshotRequest<network::raft::CatalogType>>,
) -> Result<Json<openraft::raft::SnapshotResponse<network::raft::NodeId>>, (StatusCode, Json<Value>)>
{
    if request.offset != 0 || !request.done {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"chunked snapshots are not supported"})),
        ));
    }
    let raft = raft_context(&ctx, &headers).await?;
    let snapshot = openraft::Snapshot {
        meta: request.meta,
        snapshot: Box::new(std::io::Cursor::new(request.data)),
    };
    raft.raft
        .install_full_snapshot(request.vote, snapshot)
        .await
        .map(Json)
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":e.to_string()})),
            )
        })
}

/// Rejects cross-origin browser requests; native clients have no Origin and use bearer/subprotocol tokens.
fn origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    match headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        None => true,
        Some(origin) => allowed.iter().any(|configured| configured == origin),
    }
}

async fn handshake(State(ctx): State<ServerContext>, headers: HeaderMap) -> impl IntoResponse {
    if !origin_allowed(&headers, &ctx.allowed_origins) || !authorized(&headers, &ctx.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        );
    }
    match config::load_at(ctx.core.data_dir()) {
        Ok(mut cfg) => {
            cfg.remote_connections = None;
            (
                StatusCode::OK,
                Json(json!({
                    "protocol": 2, "machineId": ctx.machine_id, "name": hostname::get().unwrap_or_default().to_string_lossy(),
                    "platform": std::env::consts::OS, "config": cfg
                })),
            )
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":err.to_string()})),
        ),
    }
}

async fn socket(
    ws: WebSocketUpgrade,
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !origin_allowed(&headers, &ctx.allowed_origins) || !authorized(&headers, &ctx.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').map(str::trim).any(|p| p == "swath-v2"))
    {
        return (StatusCode::UPGRADE_REQUIRED, "Swath protocol v2 required").into_response();
    }
    ws.protocols(["swath-v2"])
        .on_upgrade(move |socket| serve_socket(socket, ctx))
}

static NEXT_VIEWER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ViewerSubscriptions {
    id: String,
    tasks: HashSet<String>,
    sessions: HashSet<String>,
    panes: HashSet<String>,
    runs: HashSet<String>,
}

impl ViewerSubscriptions {
    fn new() -> Self {
        Self {
            id: format!("viewer-{}", NEXT_VIEWER_ID.fetch_add(1, Ordering::Relaxed)),
            ..Self::default()
        }
    }

    fn subscribe(&mut self, ctx: &ServerContext, params: &Value) {
        if let Some(attachments) = params.get("attachments").and_then(Value::as_array) {
            for attachment in attachments {
                self.subscribe(ctx, attachment);
            }
        }
        for (field, set) in [
            ("taskId", &mut self.tasks),
            ("sessionId", &mut self.sessions),
            ("paneId", &mut self.panes),
            ("runId", &mut self.runs),
        ] {
            if let Some(value) = params
                .get(field)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            {
                set.insert(value.to_owned());
            }
        }
        // Session and pane events carry only their local ID, so retain their task ownership too.
        if let Ok(conn) =
            config::connection_at(&config::db_path_in(ctx.core.data_dir()).unwrap_or_default())
        {
            for session in &self.sessions {
                if let Ok(task) = conn.query_row(
                    "SELECT task_id FROM terminal_task_sessions WHERE session_id=?1",
                    [session],
                    |r| r.get::<_, String>(0),
                ) {
                    self.tasks.insert(task);
                }
            }
            for pane in &self.panes {
                if let Ok(task) = conn.query_row(
                    "SELECT task_id FROM task_panes WHERE id=?1 AND tombstoned_at IS NULL",
                    [pane],
                    |r| r.get::<_, String>(0),
                ) {
                    self.tasks.insert(task);
                }
            }
        }
    }

    fn accepts(&self, ctx: &ServerContext, event: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(event) else {
            return false;
        };
        let Some(channel) = value.get("channel").and_then(Value::as_str) else {
            return false;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match channel {
            "terminal:data" | "terminal:exit" => {
                payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.sessions.contains(id))
                    || event_task(
                        ctx,
                        "terminal_task_sessions",
                        "session_id",
                        payload.get("sessionId").and_then(Value::as_str),
                    )
                    .is_some_and(|task| self.tasks.contains(&task))
            }
            "pi:event" => {
                payload
                    .get("paneId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.panes.contains(id))
                    || event_task(
                        ctx,
                        "task_panes",
                        "id",
                        payload.get("paneId").and_then(Value::as_str),
                    )
                    .is_some_and(|task| self.tasks.contains(&task))
            }
            "git:data" => payload
                .get("runId")
                .and_then(Value::as_str)
                .is_some_and(|id| self.runs.contains(id)),
            _ => false,
        }
    }
}

fn event_task(ctx: &ServerContext, table: &str, column: &str, id: Option<&str>) -> Option<String> {
    let id = id?;
    let conn = config::connection_at(&config::db_path_in(ctx.core.data_dir()).ok()?).ok()?;
    conn.query_row(
        &format!("SELECT task_id FROM {table} WHERE {column}=?1"),
        [id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Keep browser reconnect state independent from the broadcast ring.  Conversation history is
/// already durable elsewhere; this log only contains task-scoped UI events which are safe to replay.
fn spawn_durable_event_writer(ctx: ServerContext) {
    tokio::spawn(async move {
        let mut events = ctx.events.subscribe();
        while let Ok(event) = events.recv().await {
            let Ok(value) = serde_json::from_str::<Value>(&event) else {
                continue;
            };
            let Some(channel) = value.get("channel").and_then(Value::as_str) else {
                continue;
            };
            // PTY bytes are intentionally replayed only by terminal.replay; retaining them here
            // would make an unbounded, duplicate-prone second terminal transcript.
            if !matches!(channel, "pi:event" | "terminal:exit") {
                continue;
            }
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let task_id = payload
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| match channel {
                    "pi:event" => event_task(
                        &ctx,
                        "task_panes",
                        "id",
                        payload.get("paneId").and_then(Value::as_str),
                    ),
                    "terminal:exit" => event_task(
                        &ctx,
                        "terminal_task_sessions",
                        "session_id",
                        payload.get("sessionId").and_then(Value::as_str),
                    ),
                    _ => None,
                });
            let Ok(path) = config::db_path_in(ctx.core.data_dir()) else {
                continue;
            };
            if let Ok(conn) = config::connection_at(&path) {
                let _ = conn.execute(
                    "INSERT INTO browser_event_log(task_id,channel,payload_json) VALUES(?1,?2,?3)",
                    params![task_id, channel, payload.to_string()],
                );
                // Bounded retention makes expiry explicit rather than silently dropping a slow browser.
                let _ = conn.execute("DELETE FROM browser_event_log WHERE sequence <= (SELECT MAX(sequence)-10000 FROM browser_event_log)", []);
            }
        }
    });
}

fn durable_events(ctx: &ServerContext, cursor: Option<i64>) -> Result<Value, String> {
    let conn =
        config::connection_at(&config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let oldest: Option<i64> = conn
        .query_row("SELECT MIN(sequence) FROM browser_event_log", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    if cursor.is_some_and(|cursor| oldest.is_some_and(|first| cursor < first - 1)) {
        let mut panes = conn.prepare("SELECT p.id,p.task_id,p.kind,p.session_id,t.execution_generation FROM task_panes p JOIN tasks t ON t.id=p.task_id WHERE p.tombstoned_at IS NULL AND t.tombstoned_at IS NULL ORDER BY p.created_at").map_err(|e| e.to_string())?;
        let attachments = panes.query_map([], |r| Ok(json!({"paneId":r.get::<_,String>(0)?,"taskId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"sessionId":r.get::<_,Option<String>>(3)?,"executionGeneration":r.get::<_,i64>(4)?}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        return Ok(
            json!({"status":"cursor_expired","cursor":null,"events":[],"attachments":attachments}),
        );
    }
    let after = cursor.unwrap_or(0);
    let mut statement = conn.prepare("SELECT sequence,channel,payload_json FROM browser_event_log WHERE sequence>?1 ORDER BY sequence LIMIT 10000").map_err(|e| e.to_string())?;
    let events = statement.query_map([after], |r| Ok(json!({"cursor":r.get::<_,i64>(0)?,"channel":r.get::<_,String>(1)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null)}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let next = events
        .last()
        .and_then(|event| event.get("cursor"))
        .cloned()
        .unwrap_or_else(|| json!(after));
    Ok(json!({"status":"replayed","cursor":next,"events":events}))
}

async fn serve_socket(socket: WebSocket, ctx: ServerContext) {
    let (mut output, mut input) = socket.split();
    let mut events = ctx.events.subscribe();
    let mut viewer = ViewerSubscriptions::new();
    loop {
        tokio::select! {
            event = events.recv() => if let Ok(event) = event { if viewer.accepts(&ctx, &event) && output.send(Message::Text(event.into())).await.is_err() { break; } },
            incoming = input.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { break };
                let method = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("method").and_then(Value::as_str).map(str::to_owned));
                let response = handle_request(&ctx, &text, &mut viewer).await;
                if output.send(Message::Text(response.clone().into())).await.is_err() { break; }
                if method.as_deref() == Some("event.subscribe") {
                    if let Some(events) = serde_json::from_str::<Value>(&response).ok().and_then(|value| value.pointer("/result/events").and_then(Value::as_array).cloned()) {
                        for event in events {
                            let replay = json!({"type":"event","channel":event["channel"],"payload":event["payload"],"cursor":event.get("cursor").cloned().unwrap_or(Value::Null)});
                            if viewer.accepts(&ctx, &replay.to_string())
                                && output.send(Message::Text(replay.to_string().into())).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                }
                // Replay is a point-to-point response, never a ConnectorEvents broadcast.
                if method.as_deref() == Some("terminal.replay") {
                    if let Some(data) = serde_json::from_str::<Value>(&response).ok().and_then(|v| v.pointer("/result/replay").and_then(Value::as_str).map(str::to_owned)).filter(|v| !v.is_empty()) {
                        let session_id = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.pointer("/params/sessionId").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
                        if output.send(Message::Text(json!({"type":"event","channel":"terminal:data","payload":{"sessionId":session_id,"data":data}}).to_string().into())).await.is_err() { break; }
                    }
                }
            }
        }
    }
}

async fn handle_request(
    ctx: &ServerContext,
    raw: &str,
    viewer: &mut ViewerSubscriptions,
) -> String {
    let request: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return json!({"type":"response","id":0,"error":e.to_string()}).to_string(),
    };
    let id = request
        .get("id")
        .cloned()
        .unwrap_or_else(|| Value::String("invalid".into()));
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    viewer.subscribe(ctx, &params);
    let result: Result<Value, String> = if method == "event.subscribe" {
        let cursor = params.get("cursor").and_then(Value::as_i64);
        durable_events(ctx, cursor).map(|mut replay| {
            replay["viewerId"] = json!(viewer.id);
            replay
        })
    } else if method == "event.ack" {
        (|| {
            let client_id = field::<String>(&params, "clientId")?;
            let cursor = field::<i64>(&params, "cursor")?;
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            conn.execute("INSERT INTO browser_event_acks(client_id,cursor) VALUES(?1,?2) ON CONFLICT(client_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),acknowledged_at=strftime('%s','now')", params![client_id,cursor]).map_err(|e| e.to_string())?;
            Ok(json!({"ok":true,"cursor":cursor}))
        })()
    } else {
        dispatch(ctx, method, params).await
    };
    match result {
        Ok(value) => json!({"type":"response","id":id,"result":value}).to_string(),
        Err(error) => json!({"type":"response","id":id,"error":error}).to_string(),
    }
}

fn field<T: serde::de::DeserializeOwned>(params: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(
        params
            .get(name)
            .cloned()
            .ok_or_else(|| format!("missing {name}"))?,
    )
    .map_err(|e| e.to_string())
}

/// Peer envelope is deliberately HTTP/JSON: it is authenticated with the destination device's
/// durable credential and preserves the browser operation ID in `params` unchanged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerRequest {
    method: String,
    #[serde(default)]
    params: Value,
    target_device_id: String,
    #[serde(default)]
    hop: u8,
}

fn task_device(
    ctx: &ServerContext,
    method: &str,
    params: &Value,
) -> Result<Option<String>, String> {
    let conn =
        config::connection_at(&config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            let session = params.get("sessionId").and_then(Value::as_str)?;
            conn.query_row(
                "SELECT task_id FROM terminal_task_sessions WHERE session_id=?1",
                [session],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .or_else(|| ctx.session_tasks.lock().unwrap().get(session).cloned())
        })
        .or_else(|| {
            params
                .get("paneId")
                .and_then(Value::as_str)
                .and_then(|pane| {
                    conn.query_row(
                        "SELECT task_id FROM task_panes WHERE id=?1 AND tombstoned_at IS NULL",
                        [pane],
                        |r| r.get(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                })
        })
        .or_else(|| {
            params
                .get("operationId")
                .and_then(Value::as_str)
                .and_then(|op| {
                    conn.query_row(
                        "SELECT task_id FROM task_operations WHERE operation_id=?1",
                        [op],
                        |r| r.get(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                })
        });
    if let Some(task_id) = task_id {
        return conn
            .query_row(
                "SELECT assigned_device_id FROM tasks WHERE id=?1 AND tombstoned_at IS NULL",
                [&task_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string());
    }
    // Provisioning is an execution request even though the task does not exist yet.
    if method == "task.rpc" && params.get("op").and_then(Value::as_str) == Some("createTask") {
        return Ok(params
            .get("deviceId")
            .and_then(Value::as_str)
            .map(str::to_owned));
    }
    Ok(None)
}

fn task_addressed(method: &str, params: &Value) -> bool {
    params.get("taskId").is_some()
        || params.get("sessionId").is_some()
        || params.get("paneId").is_some()
        || (method == "task.rpc" && params.get("operationId").is_some())
        || (method == "task.rpc" && params.get("op").and_then(Value::as_str) == Some("createTask"))
}

fn ensure_peer_relay(ctx: &ServerContext, target: &str, params: &Value) {
    let (sender, receiver) = {
        let mut relays = ctx.peer_relays.lock().unwrap();
        if let Some(sender) = relays.get(target) {
            (sender.clone(), None)
        } else {
            let (sender, receiver) = mpsc::unbounded_channel();
            relays.insert(target.to_owned(), sender.clone());
            (sender, Some(receiver))
        }
    };
    let _ = sender.send(json!({"method":"event.subscribe","params":params}));
    let Some(mut receiver) = receiver else { return };
    let ctx = ctx.clone();
    let target = target.to_owned();
    tokio::spawn(async move {
        let mut subscriptions: Vec<Value> = Vec::new();
        loop {
            let peer = config::connection_at(&match config::db_path_in(ctx.core.data_dir()) {
                Ok(path) => path,
                Err(_) => break,
            })
            .ok()
            .and_then(|conn| {
                conn.query_row(
                    "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
                    [&target],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
                .ok()
                .flatten()
            });
            let Some((endpoint, credential)) = peer else {
                break;
            };
            let url = format!("{}/api/socket", endpoint.trim_end_matches('/'))
                .replacen("http://", "ws://", 1)
                .replacen("https://", "wss://", 1);
            let mut request = match url.into_client_request() {
                Ok(request) => request,
                Err(_) => {
                    sleep(Duration::from_millis(250)).await;
                    continue;
                }
            };
            let protocol = format!(
                "swath-v2, auth.{}",
                Base64UrlUnpadded::encode_string(credential.as_bytes())
            );
            if let Ok(value) = protocol.parse() {
                request
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, value);
            }
            let Ok((socket, _)) = tokio_tungstenite::connect_async(request).await else {
                sleep(Duration::from_millis(250)).await;
                continue;
            };
            let (mut output, mut input) = socket.split();
            for update in &subscriptions {
                if output
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"id":"relay","method":update["method"],"params":update["params"]})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            loop {
                tokio::select! {
                    update = receiver.recv() => match update {
                        Some(update) => {
                            subscriptions.push(update.clone());
                            if output.send(tokio_tungstenite::tungstenite::Message::Text(json!({"id":"relay","method":update["method"],"params":update["params"]}).to_string().into())).await.is_err() { break }
                        },
                        None => return,
                    },
                    incoming = input.next() => match incoming {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(event))) => {
                            if let Ok(value) = serde_json::from_str::<Value>(&event) {
                                if let (Some(channel), Some(payload)) = (value.get("channel").and_then(Value::as_str), value.get("payload")) {
                                    if matches!(channel, "terminal:data" | "terminal:exit" | "pi:event" | "git:data") { ctx.events.publish(channel, payload.clone()); }
                                }
                            }
                        }
                        Some(Ok(_)) => {},
                        _ => break,
                    },
                }
            }
            sleep(Duration::from_millis(250)).await;
        }
    });
}

async fn peer_call(
    ctx: &ServerContext,
    target: &str,
    method: &str,
    params: Value,
    hop: u8,
) -> Result<Value, String> {
    if hop >= 3 {
        return Err(json!({"code":"forwarding_loop","targetDeviceId":target}).to_string());
    }
    let conn =
        config::connection_at(&config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let peer: Option<(String, String)> = conn
        .query_row(
            "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
            [target],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((endpoint, credential)) = peer else {
        return Err(json!({"code":"executor_unreachable","targetDeviceId":target}).to_string());
    };
    let url = format!("{}/api/peer/rpc", endpoint.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(credential)
        .json(&json!({
            "method": method, "params": params, "targetDeviceId": target, "hop": hop + 1
        }))
        .send()
        .await
        .map_err(|e| {
            json!({"code":"executor_unreachable","targetDeviceId":target,"message":e.to_string()})
                .to_string()
        })?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value.to_string());
    }
    value.get("result").cloned().ok_or_else(|| {
        value
            .get("error")
            .cloned()
            .unwrap_or(json!({"code":"executor_unreachable"}))
            .to_string()
    })
}

async fn project_bundle(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    axum::extract::Path(project_id): axum::extract::Path<String>,
) -> Response<Body> {
    if !peer_authorized(&ctx, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    let result = (|| -> Result<Vec<u8>, String> {
        let conn = config::connection_at(
            &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let device_id =
            local_device_id(&ctx.core).ok_or_else(|| "device_not_enrolled".to_string())?;
        let source: String = conn.query_row("SELECT p.repository_source FROM projects p JOIN git_replicas r ON r.network_id=p.network_id AND r.repository_source=p.repository_source WHERE p.id=?1 AND r.device_id=?2", params![project_id,device_id], |row|row.get(0)).map_err(|_|"replica_not_found".to_string())?;
        let bundle = ctx
            .core
            .data_dir()
            .join(format!("project-{project_id}.bundle.tmp"));
        git::create_bundle(&source, &bundle)?;
        let bytes = std::fs::read(&bundle).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(bundle);
        bytes
    })();
    match result {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-git-bundle")
            .body(Body::from(bytes))
            .unwrap(),
        Err(error) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from(error))
            .unwrap(),
    }
}

async fn peer_rpc(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    Json(request): Json<PeerRequest>,
) -> impl IntoResponse {
    if !peer_authorized(&ctx, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":{"code":"unauthorized"}})),
        );
    }
    if request.hop > 3 {
        return (
            StatusCode::LOOP_DETECTED,
            Json(json!({"error":{"code":"forwarding_loop"}})),
        );
    }
    match dispatch_to_owner(
        &ctx,
        &request.method,
        request.params,
        request.hop,
        Some(&request.target_device_id),
    )
    .await
    {
        Ok(result) => (StatusCode::OK, Json(json!({"result":result}))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({"error":serde_json::from_str::<Value>(&error).unwrap_or(json!({"code":"executor_unreachable","message":error}))}),
            ),
        ),
    }
}

async fn dispatch_to_owner(
    ctx: &ServerContext,
    method: &str,
    params: Value,
    hop: u8,
    requested_target: Option<&str>,
) -> Result<Value, String> {
    // Transcript cache reads and replication are explicitly local. They must work while the
    // executor is offline and must never create a Pi process as a side effect.
    if matches!(
        method,
        "sync.snapshot" | "sync.changes" | "sync.ack" | "sync.conflicts" | "sync.apply"
    ) || (method == "pi.rpc" && params.get("op").and_then(Value::as_str) == Some("history"))
    {
        return dispatch_local(ctx, method, params).await;
    }
    // Transfer staging is an authenticated, destination-local storage operation. It is not an
    // executor request and therefore must not be routed back to the current source owner.
    if method == "transfer.stage" {
        return dispatch_local(ctx, method, params).await;
    }
    // Completing a task changes replicated catalog lifecycle only. Routing it to the executor
    // made the action unnecessarily depend on that machine being reachable and authenticated.
    if method == "task.rpc" && params.get("op").and_then(Value::as_str) == Some("completeTask") {
        return dispatch_local(ctx, method, params).await;
    }
    let owner = task_device(ctx, method, &params)?;
    if task_addressed(method, &params) && owner.is_none() {
        return Err(json!({"code":"unknown_executor"}).to_string());
    }
    let Some(owner) = owner else {
        return dispatch_local(ctx, method, params).await;
    };
    if let Some(target) = requested_target {
        if target != owner {
            return Err(json!({"code":"forwarding_loop","targetDeviceId":target}).to_string());
        }
    }
    if method == "terminal.create" || method == "terminal.attach" {
        if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
            ctx.session_tasks
                .lock()
                .unwrap()
                .insert(session.to_owned(), owner.clone());
            // The executor persists create ownership in the same transaction as PTY spawn.
            // Do not pre-write it here: a failed spawn must leave no routable stale session.
        }
    }
    if ctx.device_id.as_deref() == Some(owner.as_str()) {
        return dispatch_local(ctx, method, params).await;
    }
    ensure_peer_relay(ctx, &owner, &params);
    peer_call(ctx, &owner, method, params, hop).await
}

async fn dispatch(ctx: &ServerContext, method: &str, params: Value) -> Result<Value, String> {
    dispatch_to_owner(ctx, method, params, 0, None).await
}

/// Re-resolve executor-local paths at the trust boundary. Client cwd values are display hints,
/// never authority to access another directory.
fn task_root(ctx: &ServerContext, params: &Value) -> Result<String, String> {
    let task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| json!({"code":"unknown_executor"}).to_string())?;
    let generation = params
        .get("executionGeneration")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            json!({"code":"stale_generation","message":"executionGeneration is required"})
                .to_string()
        })?;
    let conn =
        config::connection_at(&config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let row: Option<(String, i64, String)> = conn.query_row(
        "SELECT t.assigned_device_id,t.execution_generation,p.path FROM tasks t JOIN device_task_paths p ON p.task_id=t.id AND p.device_id=t.assigned_device_id WHERE t.id=?1 AND t.tombstoned_at IS NULL",
        [task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|e| e.to_string())?;
    let Some((device, current, root)) = row else {
        return Err(json!({"code":"unknown_executor","taskId":task_id}).to_string());
    };
    if ctx.device_id.as_deref() != Some(device.as_str()) || current != generation {
        return Err(
            json!({"code":"stale_generation","taskId":task_id,"expected":current}).to_string(),
        );
    }
    if !Path::new(&root).is_dir() {
        return Err(json!({"code":"executor_unreachable","taskId":task_id}).to_string());
    }
    Ok(root)
}

async fn dispatch_local(
    ctx: &ServerContext,
    method: &str,
    mut params: Value,
) -> Result<Value, String> {
    match method {
        "config.load" => {
            let mut value = config::load_at(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            value.remote_connections = None;
            serde_json::to_value(value).map_err(|e| e.to_string())
        }
        // v1 replicated a whole UI config, including paths and process-facing state. Catalog changes
        // must now be operation-id based Raft entries, never whole-config writes.
        "config.save" => {
            Err("legacy whole-config writes are not supported after catalog migration".into())
        }
        "terminal.create" => {
            let request = serde_json::from_value(params).map_err(|e| e.to_string())?;
            ctx.core
                .terminal
                .create_for_task(ctx.core.data_dir(), request)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.write" => {
            ctx.core
                .terminal
                .write_for_task(
                    ctx.core.data_dir(),
                    &field::<String>(&params, "sessionId")?,
                    &field::<String>(&params, "data")?,
                )
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.resize" => {
            ctx.core
                .terminal
                .resize_for_task(
                    ctx.core.data_dir(),
                    serde_json::from_value(params).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.kill" => {
            ctx.core
                .terminal
                .kill_for_task(ctx.core.data_dir(), &field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.attach" => serde_json::to_value(
            ctx.core
                .terminal
                .attach_for_task(
                    ctx.core.data_dir(),
                    serde_json::from_value(params).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.restart" => serde_json::to_value(
            ctx.core
                .terminal
                .restart_for_task(ctx.core.data_dir(), &field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.replay" => {
            let (status, replay) = ctx
                .core
                .terminal
                .replay_for_task(ctx.core.data_dir(), &field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?;
            Ok(json!({"sessionId":status.session_id,"running":status.running,"replay":replay}))
        }
        "terminal.setStreaming" => {
            ctx.core
                .terminal
                .set_streaming_for_task(
                    ctx.core.data_dir(),
                    &field::<String>(&params, "sessionId")?,
                    field(&params, "enabled")?,
                )
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.isBusy" => Ok(Value::Bool(
            ctx.core
                .terminal
                .is_busy_for_task(ctx.core.data_dir(), &field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )),
        "git.rpc" | "files.rpc" => {
            let root = task_root(ctx, &params)?;
            params["cwd"] = Value::String(root);
            if method == "git.rpc" {
                git::rpc_headless(&ctx.core.events, params).map_err(|e| e.to_string())
            } else {
                files::rpc(params)
            }
        }
        "askImages.load" => ask_images::load(params),
        "pi.rpc" => pi_agent::rpc_at(ctx.core.data_dir(), &ctx.core.pi, params),
        "sync.snapshot" => crate::pi_session_store::sync_snapshot(
            ctx.core.data_dir(),
            &field::<String>(&params, "networkId")?,
        ),
        "sync.changes" => crate::pi_session_store::sync_changes(
            ctx.core.data_dir(),
            &field::<String>(&params, "networkId")?,
            params.get("cursor"),
        ),
        "sync.ack" => {
            Ok(json!({"ok":true,"cursor":params.get("cursor").cloned().unwrap_or(Value::Null)}))
        }
        "sync.conflicts" => crate::pi_session_store::sync_conflicts(
            ctx.core.data_dir(),
            &field::<String>(&params, "networkId")?,
        ),
        "sync.apply" => {
            let network = field::<String>(&params, "networkId")?;
            let records = params
                .get("records")
                .and_then(Value::as_array)
                .ok_or_else(|| "missing records".to_string())?;
            let result =
                crate::pi_session_store::sync_apply(ctx.core.data_dir(), &network, records)?;
            ctx.core.events.publish("pi:history", json!({"networkId":network,"cursor":result.get("cursor"),"applied":result["applied"]}));
            Ok(result)
        }
        "task.rpc" => {
            let op = params
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            // Confirmation is a server action, not a claim made by the UI: derive the task's
            // live PTY/Pi children from durable ownership and stop exactly those children first.
            if matches!(op.as_str(), "transferConfirm" | "cleanupConfirm")
                && params.get("agentsStopped").and_then(Value::as_bool) == Some(true)
                && params.get("serverConfirmed").and_then(Value::as_bool) == Some(true)
            {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        params
                            .get("operationId")
                            .and_then(Value::as_str)
                            .and_then(|operation| {
                                config::connection_at(
                                    &config::db_path_in(ctx.core.data_dir()).ok()?,
                                )
                                .ok()?
                                .query_row(
                                    "SELECT task_id FROM task_operations WHERE operation_id=?1",
                                    [operation],
                                    |row| row.get(0),
                                )
                                .optional()
                                .ok()
                                .flatten()
                            })
                    })
                    .ok_or_else(|| "operation_not_found".to_string())?;
                ctx.core
                    .terminal
                    .quiesce_task(ctx.core.data_dir(), &task_id)
                    .map_err(|e| e.to_string())?;
                ctx.core.pi.quiesce_task(&task_id)?;
            }
            let mut result = tasks::rpc(ctx.core.data_dir(), params).await?;
            if op == "transferPreflight" || op == "cleanupPreview" {
                if let Some(task_id) = result
                    .get("taskId")
                    .and_then(Value::as_str)
                    .or_else(|| result.pointer("/preview/taskId").and_then(Value::as_str))
                {
                    let terminals = ctx
                        .core
                        .terminal
                        .task_processes(ctx.core.data_dir(), task_id)
                        .map_err(|e| e.to_string())?;
                    let pi = ctx.core.pi.task_processes(task_id)?;
                    result["processes"] = json!({"terminals":terminals.into_iter().map(|(session_id,pid)| json!({"sessionId":session_id,"pid":pid})).collect::<Vec<_>>(),"pi":pi["processes"].clone()});
                }
            }
            Ok(result)
        }
        "transfer.stage" => tasks::transfer_stage(ctx.core.data_dir(), &params).await,
        "directories.list" => list_directories(params),
        "network.current" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let id = conn
                .query_row(
                    "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            id.map(|id| network::catalog_snapshot(&conn, &id))
                .transpose()
                .map(|snapshot| snapshot.unwrap_or(Value::Null))
        }
        "network.initialize" => {
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let conn = config::connection_at(&db).map_err(|e| e.to_string())?;
            let existing = conn
                .query_row(
                    "SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let network_id = if let Some(id) = existing {
                id
            } else {
                let name = field::<String>(&params, "name")?;
                let id = network::random_id(&conn, "net").map_err(|e| e.to_string())?;
                conn.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES(?1,?2,2,1,strftime('%s','now'))", params![id,name.trim()]).map_err(|e|e.to_string())?;
                let host = hostname::get()
                    .ok()
                    .and_then(|v| v.into_string().ok())
                    .unwrap_or_else(|| "swath-device".into());
                let device = network::ensure_local_device(&conn, &id, &host, std::env::consts::OS)
                    .map_err(|e| e.to_string())?;
                network::set_coordinator_health(&conn, &id, &device, true, true)
                    .map_err(|e| e.to_string())?;
                id
            };
            drop(conn);
            network::raft::CatalogService::open_discovered(
                db.to_string_lossy(),
                ctx.token.clone(),
                ctx.connector_endpoint.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "network_not_found".to_string())?;
            let conn = config::connection_at(&db).map_err(|e| e.to_string())?;
            network::catalog_snapshot(&conn, &network_id)
        }
        "catalog.snapshot" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            network::catalog_snapshot(&conn, &field::<String>(&params, "networkId")?)
        }
        "catalog.mutate" => {
            let network_id = field::<String>(&params, "networkId")?;
            let operation_id = field::<String>(&params, "operationId")?;
            let expected_revision = field::<i64>(&params, "expectedRevision")?;
            let name = params
                .pointer("/mutation/name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(|| "invalid mutation".to_string())?;
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let catalog = network::raft::CatalogService::open_discovered(
                db.to_string_lossy(),
                ctx.token.clone(),
                ctx.connector_endpoint.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "network_not_found".to_string())?;
            let response = catalog
                .client_write(network::raft::CatalogRequest::Network {
                    operation_id,
                    expected_revision,
                    payload: json!({"networkId":network_id,"name":name}),
                })
                .await
                .map_err(|e| serde_json::to_string(&e).unwrap_or(e.message))?;
            serde_json::from_str(response.value.as_deref().unwrap_or("{}"))
                .map_err(|e| e.to_string())
        }
        "network.membership" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(
                network::membership(&conn, &field::<String>(&params, "networkId")?)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "network.health" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(
                network::health(&conn, &field::<String>(&params, "networkId")?)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "network.discover" => Ok(Value::Array(vec![])),
        "network.requestJoin" => {
            let network_id = field::<String>(&params, "networkId")?;
            let endpoint = field::<String>(&params, "endpoint")?;
            let secret = field::<String>(&params, "enrollmentSecret")?;
            if secret.len() < 16 {
                return Err("enrollment secret must be at least 16 characters".into());
            }
            let coordinator = reqwest::Url::parse(endpoint.trim_end_matches('/'))
                .map_err(|_| "invalid coordinator endpoint".to_string())?;
            if coordinator.scheme() != "https"
                && !matches!(
                    coordinator.host_str(),
                    Some("127.0.0.1" | "localhost" | "::1")
                )
            {
                return Err(
                    "coordinator must use HTTPS (HTTP is only allowed for loopback tests)".into(),
                );
            }
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let conn = config::connection_at(&db).map_err(|e| e.to_string())?;
            if let Some(enrollment_id) = conn.query_row("SELECT enrollment_id FROM pending_enrollments WHERE network_id=?1 AND endpoint=?2 AND secret=?3 ORDER BY created_at DESC LIMIT 1", params![network_id,endpoint,secret], |row|row.get::<_,String>(0)).optional().map_err(|e|e.to_string())? {
                return Ok(json!({"enrollmentId":enrollment_id,"state":"pending"}));
            }
            let enrollment_id = network::random_id(&conn, "enroll").map_err(|e| e.to_string())?;
            let node_id: i64 = conn
                .query_row("SELECT abs(random())", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            let host = hostname::get()
                .ok()
                .and_then(|v| v.into_string().ok())
                .unwrap_or_else(|| "swath-device".into());
            let response = reqwest::Client::new().post(format!("{}/api/enrollment/request", endpoint.trim_end_matches('/'))).json(&json!({"networkId":network_id,"enrollmentId":enrollment_id,"secret":secret,"nodeId":node_id,"connectorEndpoint":ctx.connector_endpoint,"metadata":{"displayName":host,"hostname":host,"platform":std::env::consts::OS}})).send().await.map_err(|e|format!("coordinator_unreachable: {e}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "join_request_rejected: {}",
                    response.text().await.unwrap_or_default()
                ));
            }
            conn.execute("INSERT INTO pending_enrollments(enrollment_id,network_id,endpoint,secret,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))", params![enrollment_id,network_id,endpoint,secret]).map_err(|e|e.to_string())?;
            Ok(json!({"enrollmentId":enrollment_id,"state":"pending"}))
        }
        "network.joinStatus" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            network::join_status(conn, field::<String>(&params, "enrollmentId")?).await
        }
        "network.approveJoin" => {
            let network_id = field::<String>(&params, "networkId")?;
            let enrollment_id = field::<String>(&params, "enrollmentId")?;
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let catalog = network::raft::CatalogService::open_discovered(
                db.to_string_lossy(),
                ctx.token.clone(),
                ctx.connector_endpoint.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "network_not_found".to_string())?;
            let response = catalog.client_write(network::raft::CatalogRequest::Device {
                operation_id: format!("approve-enrollment:{enrollment_id}"),
                expected_revision: 0,
                payload: json!({"action":"approve_join","networkId":network_id,"enrollmentId":enrollment_id}),
            }).await.map_err(|e|serde_json::to_string(&e).unwrap_or(e.message))?;
            let approved: Value = serde_json::from_str(response.value.as_deref().unwrap_or("{}"))
                .map_err(|e| e.to_string())?;
            let node_id = approved
                .get("nodeId")
                .and_then(Value::as_u64)
                .ok_or_else(|| "invalid approval".to_string())?;
            let endpoint = approved
                .get("endpoint")
                .and_then(Value::as_str)
                .ok_or_else(|| "invalid approval".to_string())?;
            catalog
                .raft()
                .add_learner(node_id, openraft::BasicNode::new(endpoint))
                .await
                .map_err(|e| e.to_string())?;
            Ok(approved)
        }
        "network.promote" => {
            let network_id = field::<String>(&params, "networkId")?;
            let device_id = field::<String>(&params, "deviceId")?;
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let (revision, ids, target_node, target_endpoint) = {
                let conn = config::connection_at(&db).map_err(|e| e.to_string())?;
                let revision: i64 = conn
                    .query_row(
                        "SELECT revision FROM networks WHERE id=?1 AND tombstoned_at IS NULL",
                        [&network_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let mut statement = conn.prepare("SELECT r.node_id FROM raft_node_members r JOIN coordinator_members m ON m.network_id=r.network_id AND m.device_id=r.device_id WHERE r.network_id=?1 AND (m.voter=1 OR r.device_id=?2)").map_err(|e|e.to_string())?;
                let mut ids: Vec<u64> = statement
                    .query_map(params![network_id, device_id], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|id| id as u64)
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                let (target_node, target_endpoint): (i64, String) = conn.query_row(
                    "SELECT node_id,endpoint FROM raft_node_members WHERE network_id=?1 AND device_id=?2",
                    params![network_id, device_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                ).map_err(|e| e.to_string())?;
                (revision, ids, target_node as u64, target_endpoint)
            };
            let catalog = network::raft::CatalogService::open_discovered(
                db.to_string_lossy(),
                ctx.token.clone(),
                ctx.connector_endpoint.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "network_not_found".to_string())?;
            catalog
                .raft()
                .trigger_snapshot()
                .await
                .map_err(|e| e.to_string())?;
            catalog
                .raft()
                .add_learner(target_node, openraft::BasicNode::new(target_endpoint))
                .await
                .map_err(|e| e.to_string())?;
            catalog
                .raft()
                .change_membership(ids)
                .await
                .map_err(|e| e.to_string())?;
            let response = catalog.client_write(network::raft::CatalogRequest::Membership {
                operation_id: format!("promote:{network_id}:{device_id}:{revision}"),
                expected_revision: revision,
                payload: json!({"networkId":network_id,"deviceId":device_id,"voter":true,"healthy":true}),
            }).await.map_err(|e|serde_json::to_string(&e).unwrap_or(e.message))?;
            if response.status == "committed" {
                Ok(Value::Null)
            } else {
                Err(response.status)
            }
        }
        "migration.status" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(migration::status(&conn).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        }
        "migration.preview" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(
                migration::preview(&conn, &field::<String>(&params, "operationId")?)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "migration.export" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            migration::export(&conn).map_err(|e| e.to_string())
        }
        "migration.conflicts" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(migration::conflicts(&conn).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        }
        "migration.submitProposal" => {
            let conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            migration::submit_proposal(
                &conn,
                serde_json::from_value(
                    params
                        .get("proposal")
                        .cloned()
                        .ok_or_else(|| "proposal is required".to_string())?,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "migration.approveProposal" => {
            let db = config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?;
            let mut conn = config::connection_at(&db).map_err(|e| e.to_string())?;
            let catalog = network::raft::CatalogService::open_discovered(
                db.to_string_lossy(),
                "local-migration-rpc",
                "http://127.0.0.1:0",
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "network_not_found".to_string())?;
            let approval = serde_json::from_value(
                params
                    .get("approval")
                    .cloned()
                    .ok_or_else(|| "approval is required".to_string())?,
            )
            .map_err(|e| e.to_string())?;
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(migration::approve_proposal(&mut conn, &catalog, approval))
            })
            .map_err(|e| e.to_string())
        }
        "migration.confirm" => {
            let raft = ctx
                .raft
                .clone()
                .ok_or_else(|| "quorum_unavailable".to_string())?;
            let data_dir = ctx.core.data_dir().to_owned();
            let mut conn = config::connection_at(
                &config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let request = serde_json::from_value(
                params
                    .get("request")
                    .cloned()
                    .ok_or_else(|| "request is required".to_string())?,
            )
            .map_err(|e| e.to_string())?;
            migration::confirm_with(
                &mut conn,
                request,
                move |request| {
                    let raft = raft.clone();
                    async move {
                        raft.client_write(request)
                            .await
                            .map(|response| response.data)
                            .map_err(|error| crate::network::raft::CatalogError {
                                code: "catalog_unavailable".into(),
                                message: error.to_string(),
                            })
                    }
                },
                move |task, pane, generation, path| {
                    if !path.is_file() {
                        return Ok(false);
                    }
                    crate::pi_session_store::import_jsonl(&data_dir, task, pane, generation, path)
                        .map_err(anyhow::Error::msg)?;
                    Ok(true)
                },
            )
            .await
            .map_err(|e| e.to_string())
        }
        _ => Err(format!("unsupported remote method: {method}")),
    }
}

fn list_directories(params: Value) -> Result<Value, String> {
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty());
    let fallback = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(std::path::PathBuf::from)
    .ok_or_else(|| "Unable to resolve the remote home folder".to_string())?;
    let path = requested.map(std::path::PathBuf::from).unwrap_or(fallback);
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Unable to open folder: {err}"))?;
    if !canonical.is_dir() {
        return Err("The selected path is not a folder".into());
    }
    let mut folders = std::fs::read_dir(&canonical)
        .map_err(|err| format!("Unable to read folder: {err}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            if !kind.is_dir() || kind.is_symlink() { return None; }
            Some(json!({ "name": entry.file_name().to_string_lossy(), "path": entry.path().to_string_lossy() }))
        })
        .collect::<Vec<_>>();
    folders.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "parent": canonical.parent().map(|parent| parent.to_string_lossy()),
        "folders": folders
    }))
}

/// Returns the owning connector when this serving node does not own the task. The browser never
/// supplies this destination; the owner must authorize task/port again on its loopback proxy.
fn preview_owner_connector(
    ctx: &ServerContext,
    task_id: &str,
) -> Result<Option<(String, String)>, String> {
    let conn =
        config::connection_at(&config::db_path_in(ctx.core.data_dir()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let owner: String = conn
        .query_row(
            "SELECT assigned_device_id FROM tasks WHERE id=?1 AND tombstoned_at IS NULL",
            [task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "preview task not found".to_string())?;
    if ctx.device_id.as_deref() == Some(owner.as_str()) {
        return Ok(None);
    }
    conn.query_row(
        "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
        [owner],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(Some)
    .ok_or_else(|| "preview owner is unreachable".to_string())
}

/// Bridges an approved preview WebSocket without exposing a browser-controlled destination.
async fn preview_websocket(
    ws: WebSocketUpgrade,
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    axum::extract::Path((task_id, port, path)): axum::extract::Path<(String, u16, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if !origin_allowed(&headers, &ctx.allowed_origins) || !authorized(&headers, &ctx.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !preview::safe_path(&path) {
        return preview_error(StatusCode::BAD_REQUEST, "invalid preview path");
    }
    let owner = match preview_owner_connector(&ctx, &task_id) {
        Ok(owner) => owner,
        Err(_) => return StatusCode::FORBIDDEN.into_response(),
    };
    // Query forwarding would turn this capability URL into an unbounded request builder.
    if !query.is_empty() {
        return preview_error(
            StatusCode::BAD_REQUEST,
            "preview WebSocket query is not allowed",
        );
    }
    let (url, credential) = match owner {
        Some((endpoint, credential)) => (
            format!(
                "{}/api/preview/{task_id}/{port}/ws/{path}",
                endpoint.trim_end_matches('/')
            )
            .replacen("http://", "ws://", 1)
            .replacen("https://", "wss://", 1),
            Some(credential),
        ),
        None => match preview::target(ctx.core.data_dir(), &task_id, port) {
            Ok(target) => (format!("ws://{target}/{path}"), None),
            Err(_) => return StatusCode::FORBIDDEN.into_response(),
        },
    };
    ws.on_upgrade(move |client| async move {
        let mut upstream_request = match url.into_client_request() { Ok(request) => request, Err(_) => return };
        if let Some(credential) = credential {
            if let Ok(protocol) = format!("swath-v2, auth.{}", Base64UrlUnpadded::encode_string(credential.as_bytes())).parse() {
                upstream_request.headers_mut().insert(header::SEC_WEBSOCKET_PROTOCOL, protocol);
            }
        }
        let Ok((upstream, _)) = tokio_tungstenite::connect_async(upstream_request).await else { return };
        let (mut client_out, mut client_in) = client.split();
        let (mut upstream_out, mut upstream_in) = upstream.split();
        loop {
            tokio::select! {
                incoming = client_in.next() => match incoming {
                    Some(Ok(Message::Text(value))) => if upstream_out.send(tokio_tungstenite::tungstenite::Message::Text(value.to_string().into())).await.is_err() { break },
                    Some(Ok(Message::Binary(value))) => if upstream_out.send(tokio_tungstenite::tungstenite::Message::Binary(value)).await.is_err() { break },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                incoming = upstream_in.next() => match incoming {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(value))) => if client_out.send(Message::Text(value.to_string().into())).await.is_err() { break },
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(value))) => if client_out.send(Message::Binary(value)).await.is_err() { break },
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
    }).into_response()
}

/// Streams an approved executor-loopback preview through the authenticated connector.  It never
/// accepts a host, scheme, or destination address from the browser.
async fn preview_proxy_root(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    axum::extract::Path((task_id, port)): axum::extract::Path<(String, u16)>,
    request: axum::extract::Request,
) -> Response<Body> {
    preview_proxy_inner(ctx, headers, task_id, port, String::new(), request).await
}

async fn preview_proxy(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    axum::extract::Path((task_id, port, path)): axum::extract::Path<(String, u16, String)>,
    request: axum::extract::Request,
) -> Response<Body> {
    preview_proxy_inner(ctx, headers, task_id, port, path, request).await
}

fn preview_error(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message.to_string()))
        .unwrap()
}

async fn preview_proxy_inner(
    ctx: ServerContext,
    auth_headers: HeaderMap,
    task_id: String,
    port: u16,
    path: String,
    request: axum::extract::Request,
) -> Response<Body> {
    if !origin_allowed(&auth_headers, &ctx.allowed_origins)
        || !authorized(&auth_headers, &ctx.token)
    {
        return preview_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if !preview::safe_path(&path) {
        return preview_error(StatusCode::BAD_REQUEST, "invalid preview path");
    }
    let method = request.method().as_str().to_string();
    if !matches!(method.as_str(), "GET" | "HEAD" | "POST") {
        return preview_error(StatusCode::METHOD_NOT_ALLOWED, "preview method not allowed");
    }
    if request.headers().contains_key(header::UPGRADE) {
        return preview_error(
            StatusCode::UPGRADE_REQUIRED,
            "use the task preview WebSocket route",
        );
    }
    let owner = match preview_owner_connector(&ctx, &task_id) {
        Ok(owner) => owner,
        Err(error) => return preview_error(StatusCode::FORBIDDEN, &error),
    };
    let (parts, body) = request.into_parts();
    let body = match axum::body::to_bytes(body, 2 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => {
            return preview_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "preview request exceeds 2 MiB",
            )
        }
    };
    // A task preview grant is a port/path capability, not a generic request forwarder.
    // In particular, do not let a browser smuggle backend routing or credentials in a query.
    if !preview::safe_query(parts.uri.query()) {
        return preview_error(StatusCode::BAD_REQUEST, "preview query is not allowed");
    }
    let target_path = if path.is_empty() {
        "/".to_string()
    } else {
        format!("/{path}")
    };
    if let Some((endpoint, credential)) = owner {
        let url = if path.is_empty() {
            format!(
                "{}/api/preview/{task_id}/{port}",
                endpoint.trim_end_matches('/')
            )
        } else {
            format!(
                "{}/api/preview/{task_id}/{port}/{path}",
                endpoint.trim_end_matches('/')
            )
        };
        let client = reqwest::Client::new();
        let mut outbound = client
            .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
            .bearer_auth(credential);
        for name in [
            header::ACCEPT,
            header::ACCEPT_LANGUAGE,
            header::CONTENT_TYPE,
        ] {
            if let Some(value) = parts.headers.get(&name) {
                outbound = outbound.header(name, value);
            }
        }
        let response = match outbound.body(body).send().await {
            Ok(response) => response,
            Err(_) => {
                return preview_error(StatusCode::BAD_GATEWAY, "preview owner is unreachable")
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => {
                return preview_error(StatusCode::BAD_GATEWAY, "preview owner response failed")
            }
        };
        let mut result = Response::builder()
            .status(status)
            .header(
                header::CONTENT_SECURITY_POLICY,
                "sandbox allow-scripts allow-forms allow-modals allow-popups",
            )
            .header("X-Content-Type-Options", "nosniff");
        for name in [
            header::CONTENT_TYPE,
            header::CACHE_CONTROL,
            header::ETAG,
            header::LAST_MODIFIED,
        ] {
            if let Some(value) = headers.get(&name) {
                result = result.header(name, value);
            }
        }
        return result.body(Body::from(bytes)).unwrap();
    }
    let target = match preview::target(ctx.core.data_dir(), &task_id, port) {
        Ok(target) => target,
        Err(error) => return preview_error(StatusCode::FORBIDDEN, &error),
    };
    let mut upstream = match TcpStream::connect(target).await {
        Ok(stream) => stream,
        Err(_) => {
            return preview_error(StatusCode::BAD_GATEWAY, "preview executor is not listening")
        }
    };
    let mut wire = format!(
        "{method} {target_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n"
    );
    for name in [
        header::ACCEPT,
        header::ACCEPT_LANGUAGE,
        header::CONTENT_TYPE,
    ] {
        if let Some(value) = parts
            .headers
            .get(&name)
            .and_then(|value| value.to_str().ok())
        {
            wire.push_str(name.as_str());
            wire.push_str(": ");
            wire.push_str(value);
            wire.push_str("\r\n");
        }
    }
    if !body.is_empty() {
        wire.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    wire.push_str("\r\n");
    if upstream.write_all(wire.as_bytes()).await.is_err()
        || (!body.is_empty() && upstream.write_all(&body).await.is_err())
    {
        return preview_error(StatusCode::BAD_GATEWAY, "preview executor disconnected");
    }
    let mut raw = Vec::new();
    if upstream.read_to_end(&mut raw).await.is_err() {
        return preview_error(StatusCode::BAD_GATEWAY, "preview executor response failed");
    }
    let Some(split) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return preview_error(StatusCode::BAD_GATEWAY, "invalid preview response");
    };
    let head = match str::from_utf8(&raw[..split]) {
        Ok(head) => head,
        Err(_) => return preview_error(StatusCode::BAD_GATEWAY, "invalid preview response"),
    };
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .and_then(|value| StatusCode::from_u16(value).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder()
        .status(status)
        // An opaque sandboxed origin cannot use the connector's cookie or control APIs.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox allow-scripts allow-forms allow-modals allow-popups",
        )
        .header("X-Content-Type-Options", "nosniff");
    for line in head.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "content-type" | "cache-control" | "etag" | "last-modified"
            ) {
                response = response.header(name, value.trim());
            }
        }
    }
    response.body(Body::from(raw.split_off(split + 4))).unwrap()
}

async fn asset_root(
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    query: Query<HashMap<String, String>>,
) -> Response<Body> {
    asset_impl("index.html", ctx, headers, query.0)
}
async fn asset(
    axum::extract::Path(path): axum::extract::Path<String>,
    State(ctx): State<ServerContext>,
    headers: HeaderMap,
    query: Query<HashMap<String, String>>,
) -> Response<Body> {
    asset_impl(&path, ctx, headers, query.0)
}

fn asset_impl(
    path: &str,
    ctx: ServerContext,
    headers: HeaderMap,
    query: HashMap<String, String>,
) -> Response<Body> {
    if let Some(token) = query.get("token") {
        if token == &ctx.token {
            let encoded = Base64UrlUnpadded::encode_string(token.as_bytes());
            return Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "/")
                .header(
                    header::SET_COOKIE,
                    format!("swath_token={encoded}; HttpOnly; Secure; SameSite=Strict; Path=/"),
                )
                .body(Body::empty())
                .unwrap();
        }
    }
    if !authorized(&headers, &ctx.token) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Body::from(
                "Swath connector authentication required. Open /?token=YOUR_TOKEN once to sign in.",
            ))
            .unwrap();
    }
    let requested = if path.is_empty() { "index.html" } else { path };
    let asset = WebAssets::get(requested).or_else(|| WebAssets::get("index.html"));
    match asset {
        Some(file) => Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                mime_guess::from_path(requested)
                    .first_or_octet_stream()
                    .as_ref(),
            )
            .header(
                header::CACHE_CONTROL,
                if requested == "index.html" {
                    "no-cache"
                } else {
                    "public, max-age=31536000, immutable"
                },
            )
            .body(Body::from(file.data.into_owned()))
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config, events::ConnectorEvents, runtime::Core};
    use axum::{routing::post, Router};
    use rusqlite::params;
    use serde_json::json;
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    fn context(core: Arc<Core>, device_id: &str) -> ServerContext {
        ServerContext {
            core,
            token: "connector-test-token".into(),
            connector_endpoint: "http://127.0.0.1:0".into(),
            machine_id: device_id.into(),
            device_id: Some(device_id.into()),
            session_tasks: Arc::new(Mutex::new(HashMap::new())),
            events: ConnectorEvents::new(),
            peer_relays: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: vec![],
            raft: None,
        }
    }

    fn catalog(core: &Core, local: &str) {
        let conn = config::connection_at(&config::db_path_in(core.data_dir()).unwrap()).unwrap();
        conn.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','n',2,1,0)", []).unwrap();
        for id in ["a", "b"] {
            conn.execute("INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES(?1,'n',?1,?1,'test',?2,1,0)", params![id, if id == local { "local-device" } else { "peer" }]).unwrap();
        }
        conn.execute("INSERT INTO projects(id,network_id,name,default_branch,revision,created_at) VALUES('p','n','p','main',1,0)", []).unwrap();
        conn.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,revision,created_at) VALUES('t','p','before','b','active',1,0)", []).unwrap();
    }

    #[test]
    fn peer_auth_accepts_the_distributed_destination_credential_during_rotation() {
        let root = std::env::temp_dir().join(format!("swath-peer-auth-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let core = Core::start(root.clone(), ConnectorEvents::new()).unwrap();
        catalog(&core, "a");
        let conn = config::connection_at(&config::db_path_in(core.data_dir()).unwrap()).unwrap();
        conn.execute("INSERT INTO enrollment_credentials(enrollment_id,network_id,device_id,secret,challenge_secret,credential,approved_at,created_at) VALUES('local:a','n','a','s','s','new-credential',1,0)", []).unwrap();
        conn.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('a','http://a','distributed-credential')", []).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer distributed-credential".parse().unwrap(),
        );
        assert!(peer_authorized(&context(core, "a"), &headers));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn browser_connector_forwards_task_to_assigned_device_and_reuses_it() {
        let root = std::env::temp_dir().join(format!("swath-peer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let a = Core::start(root.join("a"), ConnectorEvents::new()).unwrap();
        let b = Core::start(root.join("b"), ConnectorEvents::new()).unwrap();
        catalog(&a, "a");
        catalog(&b, "b");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let b_context = context(b.clone(), "b");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/api/peer/rpc", post(peer_rpc))
                    .with_state(b_context),
            )
            .await;
        });
        let conn = config::connection_at(&config::db_path_in(a.data_dir()).unwrap()).unwrap();
        conn.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('b',?1,'connector-test-token')", [endpoint]).unwrap();
        let a_context = context(a.clone(), "a");
        for title in ["created on b", "reconnected without spawn"] {
            dispatch_to_owner(
                &a_context,
                "task.rpc",
                json!({"op":"renameTask","taskId":"t","title":title}),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let a_title: String = conn
            .query_row("SELECT title FROM tasks WHERE id='t'", [], |r| r.get(0))
            .unwrap();
        let b_conn = config::connection_at(&config::db_path_in(b.data_dir()).unwrap()).unwrap();
        let b_title: String = b_conn
            .query_row("SELECT title FROM tasks WHERE id='t'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a_title, "before");
        assert_eq!(b_title, "reconnected without spawn");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preview_on_a_is_forwarded_to_owner_b_without_browser_headers() {
        let root = std::env::temp_dir().join(format!("swath-preview-relay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let a = Core::start(root.join("a"), ConnectorEvents::new()).unwrap();
        let b = Core::start(root.join("b"), ConnectorEvents::new()).unwrap();
        catalog(&a, "a");
        catalog(&b, "b");
        let preview_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = preview_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = preview_listener.accept().await.unwrap();
            let mut request = vec![0; 2048];
            let _ = socket.read(&mut request).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: never-forward\r\n\r\nowned-by-b").await.unwrap();
        });
        let b_conn = config::connection_at(&config::db_path_in(b.data_dir()).unwrap()).unwrap();
        b_conn.execute("INSERT INTO task_provisioning(task_id,base_commit,worktree_path,state,created_at) VALUES('t','x','/tmp','ready',0)", []).unwrap();
        preview::approve(b.data_dir(), "t", port).unwrap();
        let connector = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", connector.local_addr().unwrap());
        let b_context = context(b.clone(), "b");
        tokio::spawn(async move {
            let _ = axum::serve(
                connector,
                Router::new()
                    .route("/api/preview/{task_id}/{port}", any(preview_proxy_root))
                    .route("/api/preview/{task_id}/{port}/{*path}", any(preview_proxy))
                    .with_state(b_context),
            )
            .await;
        });
        let a_conn = config::connection_at(&config::db_path_in(a.data_dir()).unwrap()).unwrap();
        a_conn.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('b',?1,'connector-test-token')", [&endpoint]).unwrap();
        let request = axum::extract::Request::builder()
            .method("GET")
            .uri("/api/preview/t/1/")
            .header(header::AUTHORIZATION, "Bearer connector-test-token")
            .header(header::COOKIE, "browser-cookie")
            .body(Body::empty())
            .unwrap();
        let response = preview_proxy_inner(
            context(a, "a"),
            request.headers().clone(),
            "t".into(),
            port,
            String::new(),
            request,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap(),
            "owned-by-b"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_id_routing_survives_connector_memory_loss() {
        let root =
            std::env::temp_dir().join(format!("swath-terminal-route-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let core = Core::start(root.clone(), ConnectorEvents::new()).unwrap();
        catalog(&core, "a");
        let conn = config::connection_at(&config::db_path_in(core.data_dir()).unwrap()).unwrap();
        conn.execute("INSERT INTO terminal_task_sessions(session_id,task_id,device_id,execution_generation,created_at) VALUES('shell','t','b',1,0)", []).unwrap();
        let ctx = context(core, "a");
        assert_eq!(
            task_device(&ctx, "terminal.write", &json!({"sessionId":"shell"}))
                .unwrap()
                .as_deref(),
            Some("b")
        );
        // The durable table, not the ephemeral connection map, is authoritative.
        assert!(ctx.session_tasks.lock().unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn unknown_task_ownership_never_executes_locally() {
        let root = std::env::temp_dir().join(format!("swath-peer-unknown-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let core = Core::start(root.clone(), ConnectorEvents::new()).unwrap();
        catalog(&core, "a");
        let result = dispatch_to_owner(
            &context(core.clone(), "a"),
            "task.rpc",
            json!({"op":"renameTask","taskId":"missing","title":"wrong"}),
            0,
            None,
        )
        .await;
        assert!(result.unwrap_err().contains("unknown_executor"));
        assert_eq!(
            config::connection_at(&config::db_path_in(core.data_dir()).unwrap())
                .unwrap()
                .query_row("SELECT count(*) FROM tasks WHERE title='wrong'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn directory_browser_returns_folders_only() {
        let root =
            std::env::temp_dir().join(format!("swath-remote-folders-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("beta")).unwrap();
        fs::create_dir_all(root.join("Alpha")).unwrap();
        fs::write(root.join("notes.txt"), "not a folder").unwrap();

        let result = list_directories(json!({ "path": root })).unwrap();
        let names = result["folders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["Alpha", "beta"]);
        assert!(result["parent"].is_string());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_colored_tailscale_serve_url() {
        let output =
            "Available within your tailnet:\n\u{1b}[1mhttps://swath.example.ts.net/\u{1b}[0m\n";
        assert_eq!(
            tailscale_https_url(output).as_deref(),
            Some("https://swath.example.ts.net/")
        );
    }

    #[test]
    fn viewer_subscriptions_isolate_terminal_events() {
        let root = std::env::temp_dir().join(format!("swath-viewer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let core = Core::start(root.clone(), ConnectorEvents::new()).unwrap();
        catalog(&core, "a");
        let conn = config::connection_at(&config::db_path_in(core.data_dir()).unwrap()).unwrap();
        conn.execute("INSERT INTO terminal_task_sessions(session_id,task_id,device_id,execution_generation,created_at) VALUES('shell','t','b',1,0)", []).unwrap();
        let ctx = context(core, "a");
        let mut subscribed = ViewerSubscriptions::new();
        let other = ViewerSubscriptions::new();
        subscribed.subscribe(&ctx, &json!({"taskId":"t","sessionId":"shell"}));
        let event = json!({"type":"event","channel":"terminal:data","payload":{"sessionId":"shell","data":"secret"}}).to_string();
        assert!(subscribed.accepts(&ctx, &event));
        assert!(!other.accepts(&ctx, &event));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn browser_reads_the_serving_nodes_network_catalog() {
        let root = std::env::temp_dir().join(format!(
            "swath-browser-network-catalog-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let core = Core::start(root.clone(), ConnectorEvents::new()).unwrap();
        catalog(&core, "a");
        let snapshot = dispatch_local(&context(core, "a"), "network.current", Value::Null)
            .await
            .unwrap();
        assert_eq!(snapshot["network"]["id"], "n");
        assert_eq!(snapshot["devices"].as_array().unwrap().len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn connector_routes_terminal_files_git_and_pi_to_the_task_executor() {
        let root =
            std::env::temp_dir().join(format!("swath-executor-route-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let a = Core::start(root.join("a"), ConnectorEvents::new()).unwrap();
        let b_events = ConnectorEvents::new();
        let b = Core::start(root.join("b"), b_events).unwrap();
        catalog(&a, "a");
        catalog(&b, "b");
        let worktree = root.join("b-worktree");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join("owned.txt"), "owned by b").unwrap();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&worktree)
            .status()
            .unwrap();
        fs::write(worktree.join("untracked.txt"), "b").unwrap();
        let b_conn = config::connection_at(&config::db_path_in(b.data_dir()).unwrap()).unwrap();
        b_conn.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision) VALUES('t','b',?1,1)", [&worktree.to_string_lossy()]).unwrap();
        b_conn.execute("INSERT INTO task_panes(id,task_id,kind,title,revision,created_at) VALUES('pane','t','piAgent','Pi',1,0)", []).unwrap();
        b.pi.enable_test_hook();
        assert_eq!(
            b_conn
                .query_row(
                    "SELECT path FROM device_task_paths WHERE task_id='t' AND device_id='b'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            worktree.to_string_lossy()
        );
        assert_eq!(
            b_conn
                .query_row(
                    "SELECT execution_generation FROM tasks WHERE id='t'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let b_context = context(b.clone(), "b");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/api/peer/rpc", post(peer_rpc))
                    .with_state(b_context),
            )
            .await;
        });
        let a_conn = config::connection_at(&config::db_path_in(a.data_dir()).unwrap()).unwrap();
        a_conn.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('b',?1,'connector-test-token')", [&endpoint]).unwrap();
        let a_context = context(a.clone(), "a");
        let request = json!({"sessionId":"shell","taskId":"t","executionGeneration":1,"cwd":"/not-the-worktree","cols":80,"rows":24});
        dispatch_to_owner(&a_context, "terminal.create", request, 0, None)
            .await
            .unwrap();
        assert_eq!(
            b_conn
                .query_row(
                    "SELECT task_id FROM terminal_task_sessions WHERE session_id='shell'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "t"
        );
        // The browser's connector retains the session route; the executor remains authoritative.
        a_context
            .session_tasks
            .lock()
            .unwrap()
            .insert("shell".into(), "b".into());
        dispatch_to_owner(
            &a_context,
            "terminal.write",
            json!({"sessionId":"shell","taskId":"t","data":"echo routed\\n"}),
            0,
            None,
        )
        .await
        .unwrap();
        let replay = dispatch_to_owner(
            &a_context,
            "terminal.replay",
            json!({"sessionId":"shell","taskId":"t"}),
            0,
            None,
        )
        .await
        .unwrap();
        assert_eq!(replay["sessionId"], "shell");
        let files = dispatch_to_owner(&a_context, "files.rpc", json!({"op":"readText","taskId":"t","executionGeneration":1,"cwd":"/not-the-worktree","path":"owned.txt"}), 0, None).await.unwrap();
        assert_eq!(files["text"], "owned by b");
        let status = dispatch_to_owner(&a_context, "git.rpc", json!({"op":"getStatus","taskId":"t","executionGeneration":1,"cwd":"/not-the-worktree"}), 0, None).await.unwrap();
        assert_eq!(status["ok"], true);
        assert!(status.to_string().contains("untracked.txt"));
        dispatch_to_owner(&a_context, "pi.rpc", json!({"op":"ensure","taskId":"t","paneId":"pane","executionGeneration":1,"cwd":"/not-the-worktree"}), 0, None).await.unwrap();
        assert_eq!(b.pi.test_calls().len(), 1);
        dispatch_to_owner(
            &a_context,
            "terminal.kill",
            json!({"sessionId":"shell","taskId":"t"}),
            0,
            None,
        )
        .await
        .unwrap();

        // Stored session generations fence every follow-up terminal operation at B.
        b_conn
            .execute("UPDATE tasks SET execution_generation=2 WHERE id='t'", [])
            .unwrap();
        for (method, params) in [
            (
                "terminal.write",
                json!({"sessionId":"shell","taskId":"t","data":"nope"}),
            ),
            ("terminal.replay", json!({"sessionId":"shell","taskId":"t"})),
            ("terminal.kill", json!({"sessionId":"shell","taskId":"t"})),
        ] {
            let error = dispatch_to_owner(&a_context, method, params, 0, None)
                .await
                .unwrap_err();
            assert!(error.contains("stale_generation"));
        }
        let create_error = dispatch_to_owner(&a_context, "terminal.create", json!({"sessionId":"stale","taskId":"t","executionGeneration":1,"cwd":"/not-the-worktree","cols":80,"rows":24}), 0, None).await.unwrap_err();
        assert!(create_error.contains("stale_generation"));

        b_conn
            .execute("UPDATE tasks SET execution_generation=1 WHERE id='t'", [])
            .unwrap();
        let a_conn = config::connection_at(&config::db_path_in(a.data_dir()).unwrap()).unwrap();
        a_conn
            .execute("DELETE FROM device_connectors WHERE device_id='b'", [])
            .unwrap();
        for (method, params) in [
            (
                "terminal.create",
                json!({"sessionId":"gone","taskId":"t","executionGeneration":1,"cwd":"/not-the-worktree","cols":80,"rows":24}),
            ),
            (
                "terminal.write",
                json!({"sessionId":"shell","taskId":"t","data":"nope"}),
            ),
            ("terminal.replay", json!({"sessionId":"shell","taskId":"t"})),
            ("terminal.kill", json!({"sessionId":"shell","taskId":"t"})),
        ] {
            let error = dispatch_to_owner(&a_context, method, params, 0, None)
                .await
                .unwrap_err();
            assert_eq!(
                serde_json::from_str::<Value>(&error).unwrap()["code"],
                "executor_unreachable"
            );
        }
        let _ = fs::remove_dir_all(root);
    }
}
