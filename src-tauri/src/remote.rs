//! Authenticated, low-overhead Swath connector for Tailscale/LAN access.
//!
//! One WebSocket multiplexes RPC responses and live terminal/Git/Pi events. This avoids polling,
//! duplicates no pane logic, and lets the exact same renderer run in a browser.

use crate::{ask_images, config, files, git, pi_agent, AppState};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::IpAddr,
    path::Path,
    process::{Command, Output},
    sync::Mutex,
};
use tauri::{AppHandle, Listener};
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
};
use tower_http::cors::CorsLayer;

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
}

pub struct RemoteServerManager {
    app: AppHandle,
    machine_id: String,
    running: Mutex<Option<RunningServer>>,
    events: broadcast::Sender<String>,
}

#[derive(Clone)]
struct ServerContext {
    app: AppHandle,
    swath: AppState,
    token: String,
    machine_id: String,
    events: broadcast::Sender<String>,
}

impl RemoteServerManager {
    pub fn new(app: AppHandle) -> Self {
        let hostname = hostname::get()
            .ok()
            .and_then(|v| v.into_string().ok())
            .unwrap_or_else(|| "swath-device".into());
        let machine_id = hostname
            .to_lowercase()
            .replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "-");
        let (events, _) = broadcast::channel(1024);
        for channel in ["terminal:data", "terminal:exit", "git:data", "pi:event"] {
            let tx = events.clone();
            app.listen(channel, move |event| {
                let payload = serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);
                let _ = tx.send(
                    json!({ "type": "event", "channel": channel, "payload": payload }).to_string(),
                );
            });
        }
        Self {
            app,
            machine_id,
            running: Mutex::new(None),
            events,
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
        swath: AppState,
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
        let context = ServerContext {
            app: self.app.clone(),
            swath,
            token: options.token.clone(),
            machine_id: self.machine_id.clone(),
            events: self.events.clone(),
        };
        let router = Router::new()
            .route("/api/handshake", get(handshake))
            .route("/api/socket", get(socket))
            .route("/{*path}", get(asset))
            .route("/", get(asset_root))
            .layer(CorsLayer::permissive())
            .with_state(context);
        let (stop_tx, stop_rx) = oneshot::channel();
        let https_url = if options.tailscale_https {
            configure_tailscale_serve(options.port)?
        } else {
            None
        };
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
        });
        Ok(self.status())
    }

    pub async fn stop(&self) {
        if let Some(server) = self.running.lock().unwrap().take() {
            let _ = server.stop.send(());
            if server.options.tailscale_https {
                let _ = run_tailscale(&["serve", "--https=443", "off"]);
            }
        }
    }
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

fn configure_tailscale_serve(port: u16) -> Result<Option<String>, String> {
    let target = format!("http://127.0.0.1:{port}");
    let output = run_tailscale(&["serve", "--bg", "--yes", "--https=443", target.as_str()])?;
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

async fn handshake(State(ctx): State<ServerContext>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &ctx.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        );
    }
    match config::load(&ctx.app) {
        Ok(mut cfg) => {
            cfg.remote_connections = None;
            (
                StatusCode::OK,
                Json(json!({
                    "protocol": 1, "machineId": ctx.machine_id, "name": hostname::get().unwrap_or_default().to_string_lossy(),
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
    if !authorized(&headers, &ctx.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.protocols(["swath-v1"])
        .on_upgrade(move |socket| serve_socket(socket, ctx))
}

async fn serve_socket(socket: WebSocket, ctx: ServerContext) {
    let (mut output, mut input) = socket.split();
    let mut events = ctx.events.subscribe();
    loop {
        tokio::select! {
            event = events.recv() => if let Ok(event) = event { if output.send(Message::Text(event.into())).await.is_err() { break; } },
            incoming = input.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { break };
                let response = handle_request(&ctx, &text).await;
                if output.send(Message::Text(response.into())).await.is_err() { break; }
            }
        }
    }
}

async fn handle_request(ctx: &ServerContext, raw: &str) -> String {
    let request: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return json!({"type":"response","id":0,"error":e.to_string()}).to_string(),
    };
    let id = request.get("id").and_then(Value::as_u64).unwrap_or(0);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let result: Result<Value, String> = dispatch(ctx, method, params).await;
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

async fn dispatch(ctx: &ServerContext, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "config.load" => {
            let mut value = config::load(&ctx.app).map_err(|e| e.to_string())?;
            value.remote_connections = None;
            serde_json::to_value(value).map_err(|e| e.to_string())
        }
        "config.save" => {
            let mut value: crate::types::AppConfig = field(&params, "config")?;
            value.remote_connections = config::load(&ctx.app)
                .ok()
                .and_then(|saved| saved.remote_connections);
            config::save(&ctx.app, &value).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.create" => {
            let request = serde_json::from_value(params).map_err(|e| e.to_string())?;
            ctx.swath
                .terminal
                .create(request)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.write" => {
            ctx.swath
                .terminal
                .write(
                    &field::<String>(&params, "sessionId")?,
                    &field::<String>(&params, "data")?,
                )
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.resize" => {
            ctx.swath
                .terminal
                .resize(serde_json::from_value(params).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.kill" => {
            ctx.swath
                .terminal
                .kill(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.attach" => serde_json::to_value(
            ctx.swath
                .terminal
                .attach(serde_json::from_value(params).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.restart" => serde_json::to_value(
            ctx.swath
                .terminal
                .restart(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.replay" => serde_json::to_value(
            ctx.swath
                .terminal
                .replay_to_connector(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.setStreaming" => {
            ctx.swath
                .terminal
                .set_streaming(
                    &field::<String>(&params, "sessionId")?,
                    field(&params, "enabled")?,
                )
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal.isBusy" => Ok(Value::Bool(
            ctx.swath
                .terminal
                .is_busy(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )),
        "git.rpc" => git::rpc(&ctx.app, params).map_err(|e| e.to_string()),
        "files.rpc" => files::rpc(params),
        "askImages.load" => ask_images::load(params),
        "pi.rpc" => pi_agent::rpc(&ctx.app, &ctx.swath.pi, params),
        "directories.list" => list_directories(params),
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
                    format!("swath_token={encoded}; HttpOnly; SameSite=Strict; Path=/"),
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
    use super::{list_directories, tailscale_https_url};
    use serde_json::json;
    use std::fs;

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
}
