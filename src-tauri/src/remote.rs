//! Authenticated, low-overhead Swath connector for Tailscale/LAN access.
//!
//! One WebSocket multiplexes RPC responses and live terminal/Git/Pi events. This avoids polling,
//! duplicates no pane logic, and lets the exact same renderer run in a browser.

use crate::{ask_images, config, events::EventSink, files, git, pi_agent, AppState};
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
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::Mutex,
};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Listener};
#[cfg(not(feature = "desktop"))]
type AppHandle = ();
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
};
use tower_http::cors::CorsLayer;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct WebAssets;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerOptions {
    pub bind: String,
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub tailscale_https: bool,
    #[serde(default)]
    pub start_on_launch: bool,
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
    pub start_on_launch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_error: Option<String>,
}

struct RunningServer {
    options: RemoteServerOptions,
    https_url: Option<String>,
    stop: oneshot::Sender<()>,
}

pub struct RemoteServerManager {
    app: Option<AppHandle>,
    data_dir: Option<PathBuf>,
    machine_id: String,
    running: Mutex<Option<RunningServer>>,
    events: broadcast::Sender<String>,
    startup_error: Mutex<Option<String>>,
}

#[derive(Clone)]
struct ServerContext {
    app: Option<AppHandle>,
    data_dir: Option<PathBuf>,
    events_sink: EventSink,
    swath: AppState,
    token: String,
    machine_id: String,
    events: broadcast::Sender<String>,
}

impl RemoteServerManager {
    #[cfg(feature = "desktop")]
    pub fn new(app: AppHandle) -> Self {
        let hostname = hostname::get()
            .ok()
            .and_then(|v| v.into_string().ok())
            .unwrap_or_else(|| "swath-device".into());
        let machine_id = hostname
            .to_lowercase()
            .replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "-");
        let (events, _) = broadcast::channel(1024);
        for channel in [
            "terminal:data",
            "terminal:exit",
            "git:data",
            "pi:event",
            "config:changed",
        ] {
            let tx = events.clone();
            app.listen(channel, move |event| {
                let payload = serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);
                let _ = tx.send(
                    json!({ "type": "event", "channel": channel, "payload": payload }).to_string(),
                );
            });
        }
        Self {
            app: Some(app),
            data_dir: None,
            machine_id,
            running: Mutex::new(None),
            events,
            startup_error: Mutex::new(None),
        }
    }

    pub fn new_headless(data_dir: PathBuf) -> Self {
        let hostname = hostname::get()
            .ok()
            .and_then(|v| v.into_string().ok())
            .unwrap_or_else(|| "swath-device".into());
        let machine_id = hostname
            .to_lowercase()
            .replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "-");
        let (events, _) = broadcast::channel(1024);
        Self {
            app: None,
            data_dir: Some(data_dir),
            machine_id,
            running: Mutex::new(None),
            events,
            startup_error: Mutex::new(None),
        }
    }

    pub fn event_sink(&self) -> EventSink {
        match &self.app {
            #[cfg(feature = "desktop")]
            Some(app) => EventSink::Desktop(app.clone()),
            None => EventSink::Headless(self.events.clone()),
            #[cfg(not(feature = "desktop"))]
            Some(_) => EventSink::Headless(self.events.clone()),
        }
    }

    pub fn status(&self) -> RemoteServerStatus {
        let running = self.running.lock().unwrap();
        let saved = if running.is_none() {
            self.load_startup_options().ok().flatten()
        } else {
            None
        };
        let options = running.as_ref().map(|v| &v.options).or(saved.as_ref());
        RemoteServerStatus {
            running: running.is_some(),
            bind: options.map(|v| v.bind.clone()),
            port: options.map(|v| v.port),
            tailscale_https: options.map(|v| v.tailscale_https),
            https_url: running.as_ref().and_then(|v| v.https_url.clone()),
            machine_id: self.machine_id.clone(),
            platform: std::env::consts::OS.into(),
            start_on_launch: options.is_some_and(|v| v.start_on_launch),
            token: options.map(|v| v.token.clone()),
            startup_error: self.startup_error.lock().unwrap().clone(),
        }
    }

    pub fn set_auto_start(&self, enabled: bool) -> Result<RemoteServerStatus, String> {
        let mut running = self.running.lock().unwrap();
        let Some(server) = running.as_mut() else {
            if enabled {
                return Err("Start the connector before enabling auto-start".into());
            }
            self.save_startup_options(None)?;
            drop(running);
            return Ok(self.status());
        };
        let mut options = server.options.clone();
        options.start_on_launch = enabled;
        self.save_startup_options(enabled.then_some(&options))?;
        server.options.start_on_launch = enabled;
        drop(running);
        Ok(self.status())
    }

    pub async fn start(
        &self,
        options: RemoteServerOptions,
        swath: AppState,
    ) -> Result<RemoteServerStatus, String> {
        self.start_inner(options, swath, true).await
    }

    pub async fn start_from_launch(
        &self,
        options: RemoteServerOptions,
        swath: AppState,
    ) -> Result<RemoteServerStatus, String> {
        self.start_inner(options, swath, false).await
    }

    async fn start_inner(
        &self,
        mut options: RemoteServerOptions,
        swath: AppState,
        persist: bool,
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
        let previous_https = self
            .running
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|v| v.options.tailscale_https);
        self.stop_server(!previous_https || !options.tailscale_https);
        let listener = TcpListener::bind((ip, options.port))
            .await
            .map_err(|e| format!("Unable to bind connector: {e}"))?;
        let context = ServerContext {
            app: self.app.clone(),
            data_dir: self.data_dir.clone(),
            events_sink: self.event_sink(),
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
        if let Err(err) = if persist {
            self.save_startup_options(options.start_on_launch.then_some(&options))
        } else {
            Ok(())
        } {
            let _ = stop_tx.send(());
            if options.tailscale_https && !previous_https {
                let _ = run_tailscale(&["serve", "--https=443", "off"]);
            }
            return Err(format!(
                "Connector started but could not save launch settings: {err}"
            ));
        }
        *self.startup_error.lock().unwrap() = None;
        *self.running.lock().unwrap() = Some(RunningServer {
            options,
            https_url,
            stop: stop_tx,
        });
        Ok(self.status())
    }

    fn startup_path(&self) -> Result<PathBuf, String> {
        #[cfg(feature = "desktop")]
        if let Some(app) = &self.app {
            use tauri::Manager;
            return app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("connector-startup.json"))
                .map_err(|e| format!("Unable to locate connector settings: {e}"));
        }
        self.data_dir
            .as_ref()
            .map(|dir| dir.join("connector-startup.json"))
            .ok_or_else(|| "Connector settings directory unavailable".into())
    }

    pub fn load_startup_options(&self) -> Result<Option<RemoteServerOptions>, String> {
        let path = self.startup_path()?;
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Unable to read connector settings: {e}")),
        };
        let options: RemoteServerOptions = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid connector settings: {e}"))?;
        Ok(options.start_on_launch.then_some(options))
    }

    fn save_startup_options(&self, options: Option<&RemoteServerOptions>) -> Result<(), String> {
        let path = self.startup_path()?;
        if options.is_none() {
            return match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Unable to disable connector auto-start: {e}")),
            };
        }
        let parent = path.parent().ok_or("Invalid connector settings path")?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create connector settings directory: {e}"))?;
        let temp = parent.join(format!(".connector-startup-{}.tmp", std::process::id()));
        let result = (|| -> std::io::Result<()> {
            let mut builder = std::fs::OpenOptions::new();
            builder.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                builder.mode(0o600);
            }
            let mut file = builder.open(&temp)?;
            use std::io::Write;
            file.write_all(&serde_json::to_vec(options.unwrap()).map_err(std::io::Error::other)?)?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(|e| format!("Unable to save connector settings: {e}"))
    }

    pub fn report_startup_error(&self, error: String) {
        *self.startup_error.lock().unwrap() = Some(error);
    }

    fn stop_server(&self, disable_serve: bool) {
        if let Some(server) = self.running.lock().unwrap().take() {
            let _ = server.stop.send(());
            if disable_serve && server.options.tailscale_https {
                let _ = run_tailscale(&["serve", "--https=443", "off"]);
            }
        }
    }

    pub fn shutdown(&self) {
        self.stop_server(true);
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.save_startup_options(None)?;
        self.stop_server(true);
        Ok(())
    }
}

impl ServerContext {
    fn load_config(&self) -> anyhow::Result<crate::types::AppConfig> {
        match (&self.app, &self.data_dir) {
            #[cfg(feature = "desktop")]
            (Some(app), _) => config::load(app),
            (_, Some(dir)) => config::load_in(dir),
            _ => anyhow::bail!("remote server has no config storage"),
        }
    }

    fn snapshot_config(&self) -> anyhow::Result<Value> {
        let snapshot = match (&self.app, &self.data_dir) {
            #[cfg(feature = "desktop")]
            (Some(app), _) => config::snapshot(app)?,
            (_, Some(dir)) => config::snapshot_in(dir)?,
            _ => anyhow::bail!("remote server has no config storage"),
        };
        let mut snapshot = serde_json::to_value(snapshot)?;
        snapshot["config"]["remoteConnections"] = Value::Null;
        Ok(snapshot)
    }

    fn commit_config(
        &self,
        value: &crate::types::AppConfig,
        revision: u64,
    ) -> anyhow::Result<Value> {
        let mut value = value.clone();
        value.remote_connections = None; // Backend preserves credentials transactionally.
        let result = match (&self.app, &self.data_dir) {
            #[cfg(feature = "desktop")]
            (Some(app), _) => config::commit(app, &value, revision)?,
            (_, Some(dir)) => config::commit_in(dir, &value, revision)?,
            _ => anyhow::bail!("remote server has no config storage"),
        };
        let mut result = serde_json::to_value(result)?;
        result["config"]["remoteConnections"] = Value::Null;
        self.events_sink
            .emit("config:changed", json!({"revision": result["revision"]}));
        Ok(result)
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
    match ctx.load_config() {
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
        "config.snapshot" => ctx.snapshot_config().map_err(|e| e.to_string()),
        "config.commit" => {
            let value: crate::types::AppConfig = field(&params, "config")?;
            let revision: u64 = field(&params, "revision")?;
            ctx.commit_config(&value, revision)
                .map_err(|e| e.to_string())
        }
        "config.load" => {
            let mut value = ctx.load_config().map_err(|e| e.to_string())?;
            value.remote_connections = None;
            serde_json::to_value(value).map_err(|e| e.to_string())
        }
        "config.save" => Err("config.save is obsolete; use revision-checked config.commit".into()),
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
        "terminal.attach" => {
            let mut request: crate::types::TerminalSessionAttachRequest =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            request.replay = Some(false);
            serde_json::to_value(
                ctx.swath
                    .terminal
                    .attach(request)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        }
        "terminal.restart" => serde_json::to_value(
            ctx.swath
                .terminal
                .restart(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        "terminal.replay" => {
            let (status, data) = ctx
                .swath
                .terminal
                .replay_to_connector(&field::<String>(&params, "sessionId")?)
                .map_err(|e| e.to_string())?;
            let mut result = serde_json::to_value(status).map_err(|e| e.to_string())?;
            result["data"] = serde_json::Value::String(data);
            Ok(result)
        }
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
        "git.rpc" => git::rpc(&ctx.events_sink, params).map_err(|e| e.to_string()),
        "files.rpc" => files::rpc(params),
        "askImages.load" => ask_images::load(params),
        "pi.rpc" => pi_agent::rpc(&ctx.events_sink, &ctx.swath.pi, params),
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
    use super::{
        dispatch, list_directories, tailscale_https_url, RemoteServerManager, ServerContext,
    };
    use crate::{pi_agent::PiManager, terminal::TerminalManager, AppState};
    use serde_json::json;
    use std::fs;
    use std::sync::Arc;

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

    #[cfg(unix)]
    #[tokio::test]
    async fn headless_uses_main_rpc_and_event_protocol() {
        let dir = std::env::temp_dir().join(format!(
            "swath-headless-rpc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let remote = Arc::new(RemoteServerManager::new_headless(dir.clone()));
        let state = AppState {
            terminal: Arc::new(TerminalManager::new(remote.event_sink())),
            pi: Arc::new(PiManager::new()),
            remote: remote.clone(),
        };
        let context = ServerContext {
            app: None,
            data_dir: Some(dir.clone()),
            events_sink: remote.event_sink(),
            swath: state.clone(),
            token: "test-token".into(),
            machine_id: "test-machine".into(),
            events: remote.events.clone(),
        };
        let config = dispatch(&context, "config.load", json!({})).await.unwrap();
        assert_eq!(config["version"], 2);
        assert!(dispatch(&context, "config.save", json!({"config":config}))
            .await
            .is_err());
        assert_eq!(
            dispatch(&context, "config.load", json!({})).await.unwrap()["version"],
            2
        );
        let snapshot = dispatch(&context, "config.snapshot", json!({}))
            .await
            .unwrap();
        assert!(snapshot["revision"].is_number());
        assert!(snapshot["config"]["remoteConnections"].is_null());
        let mut changed = remote.events.subscribe();
        let committed = dispatch(
            &context,
            "config.commit",
            json!({
                "config": snapshot["config"], "revision": snapshot["revision"]
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            committed["revision"],
            snapshot["revision"].as_u64().unwrap() + 1
        );
        let event: serde_json::Value = serde_json::from_str(&changed.try_recv().unwrap()).unwrap();
        assert_eq!(event["channel"], "config:changed");
        assert_eq!(event["payload"]["revision"], committed["revision"]);
        assert!(dispatch(
            &context,
            "config.commit",
            json!({
                "config": snapshot["config"], "revision": snapshot["revision"]
            })
        )
        .await
        .is_err());
        let git = dispatch(&context, "git.rpc", json!({"op":"getStatus","cwd":dir}))
            .await
            .unwrap();
        assert!(git.is_object());

        let mut events = remote.events.subscribe();
        dispatch(
            &context,
            "terminal.create",
            json!({
                "sessionId":"headless-test", "cwd":dir, "cols":80, "rows":24,
                "shellProfile":{"id":"test","name":"test","command":"/bin/sh",
                    "args":["-c","printf headless-event-ok"]}
            }),
        )
        .await
        .unwrap();
        let observed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Ok(message) = events.recv().await {
                let value: serde_json::Value = serde_json::from_str(&message).unwrap();
                if value["channel"] == "terminal:data"
                    && value["payload"]["data"]
                        .as_str()
                        .is_some_and(|text| text.contains("headless-event-ok"))
                {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap();
        assert!(observed);
        state.terminal.kill_all();
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod startup_settings_tests {
    use super::*;

    #[test]
    fn roundtrip_permissions_disable_and_restart() {
        let dir = std::env::temp_dir().join(format!(
            "swath-connector-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let manager = RemoteServerManager::new_headless(dir.clone());
        let options = RemoteServerOptions {
            bind: "127.0.0.1".into(),
            port: 7878,
            token: "private-test-token-123".into(),
            tailscale_https: false,
            start_on_launch: true,
        };
        manager.save_startup_options(Some(&options)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(manager.startup_path().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let restarted = RemoteServerManager::new_headless(dir.clone());
        let loaded = restarted.load_startup_options().unwrap().unwrap();
        assert_eq!(loaded.token, options.token);
        assert!(loaded.start_on_launch);
        restarted.save_startup_options(None).unwrap();
        assert!(manager.load_startup_options().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
