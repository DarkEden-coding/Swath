//! Supervises `pi --mode rpc` child processes, one per `piAgent` pane.
//!
//! Deliberately protocol-agnostic: stdout lines are forwarded to the renderer verbatim and
//! commands are written to stdin verbatim. Nothing here parses the RPC schema, so new pi
//! commands and events need no Rust change.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Event channel carrying `{ paneId, line }` stdout records and `{ paneId, exit }` notices.
const PI_EVENT: &str = "pi:event";

/// Upper bound on retained stderr text per pane, for crash diagnostics.
const STDERR_MAX_BYTES: usize = 64 * 1024;

type PiResult = Result<Value, String>;

struct PiProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<String>>,
}

/// Owns every live pi child process, keyed by pane id.
#[derive(Default)]
pub struct PiManager {
    procs: Mutex<HashMap<String, PiProcess>>,
}

impl PiManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Terminates every pi child. Called on app exit.
    pub fn kill_all(&self) {
        let mut procs = match self.procs.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (_, mut proc) in procs.drain() {
            drop(proc.stdin.take());
            let _ = proc.child.kill();
        }
    }

    fn spawn(&self, app: &AppHandle, pane_id: &str, cwd: &str, extra_args: &[String]) -> PiResult {
        self.kill(pane_id)?;

        let mut command = Command::new("pi");
        command
            .arg("--mode")
            .arg("rpc")
            .args(extra_args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = LOGIN_PATH.as_ref() {
            command.env("PATH", path);
        }

        let mut child = command.spawn().map_err(|err| {
            format!("Unable to start pi (is it installed and on your shell PATH?): {err}")
        })?;

        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "pi stdout was not captured".to_string())?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| "pi stderr was not captured".to_string())?;
        let stderr = Arc::new(Mutex::new(String::new()));

        // stdout: one JSON record per line. `BufRead::lines()` splits on `\n` only, which is
        // what the RPC framing rules require (U+2028/U+2029 are legal inside JSON strings).
        {
            let app = app.clone();
            let pane_id = pane_id.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.is_empty() {
                        continue;
                    }
                    let _ = app.emit(PI_EVENT, json!({ "paneId": &pane_id, "line": line }));
                }
                let _ = app.emit(PI_EVENT, json!({ "paneId": &pane_id, "exit": true }));
            });
        }

        // stderr: retained for crash reporting, never forwarded as protocol data.
        {
            let stderr = Arc::clone(&stderr);
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr_pipe);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Ok(mut buf) = stderr.lock() else { break };
                    if buf.len() < STDERR_MAX_BYTES {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                }
            });
        }

        let mut procs = self.procs.lock().map_err(|_| "pi state poisoned")?;
        procs.insert(
            pane_id.to_string(),
            PiProcess {
                child,
                stdin,
                stderr,
            },
        );
        Ok(json!({ "ok": true }))
    }

    /// Writes one newline-terminated JSON command to a pane's pi stdin.
    fn send(&self, pane_id: &str, line: &str) -> PiResult {
        let mut procs = self.procs.lock().map_err(|_| "pi state poisoned")?;
        let proc = procs
            .get_mut(pane_id)
            .ok_or_else(|| format!("No pi process for pane {pane_id}"))?;
        let stdin = proc
            .stdin
            .as_mut()
            .ok_or_else(|| "pi stdin is closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("Unable to write to pi: {err}"))?;
        Ok(json!({ "ok": true }))
    }

    fn kill(&self, pane_id: &str) -> PiResult {
        let mut procs = self.procs.lock().map_err(|_| "pi state poisoned")?;
        if let Some(mut proc) = procs.remove(pane_id) {
            drop(proc.stdin.take());
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        }
        Ok(json!({ "ok": true }))
    }

    fn stderr(&self, pane_id: &str) -> PiResult {
        let procs = self.procs.lock().map_err(|_| "pi state poisoned")?;
        let text = procs
            .get(pane_id)
            .and_then(|proc| proc.stderr.lock().ok().map(|buf| buf.clone()))
            .unwrap_or_default();
        Ok(json!({ "stderr": text }))
    }
}

/// The user's real `PATH`, as a login shell reports it.
///
/// A GUI app launched from Finder or Dock inherits a minimal `PATH` that excludes Homebrew,
/// nvm, volta and friends, so `pi` is not findable. Terminal panes dodge this because a PTY
/// runs a login shell; this pipe has to ask for the same environment explicitly. Passing it
/// through also fixes pi's own bash tools, which would otherwise inherit the stunted `PATH`.
#[cfg(not(target_os = "windows"))]
static LOGIN_PATH: once_cell::sync::Lazy<Option<String>> = once_cell::sync::Lazy::new(|| {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!path.is_empty()).then_some(path)
});

/// Windows GUI processes inherit the user `PATH`, so there is nothing to repair.
#[cfg(target_os = "windows")]
static LOGIN_PATH: once_cell::sync::Lazy<Option<String>> = once_cell::sync::Lazy::new(|| None);

/// Directories never worth walking for `@file` completion.
const SKIP_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

/// Upper bound on files returned to the composer's `@` completion.
const FILE_LIST_LIMIT: usize = 2000;

/// Walks `root` breadth-first, collecting relative file paths.
///
/// Bounded rather than exhaustive: `@` completion only needs enough candidates to filter,
/// and an unbounded walk on a large repo would block the UI.
fn walk_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);

    while let Some(dir) = queue.pop_front() {
        if found.len() >= FILE_LIST_LIMIT {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            if file_type.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back(path);
                }
            } else if file_type.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    found.push(relative.to_string_lossy().replace('\\', "/"));
                    if found.len() >= FILE_LIST_LIMIT {
                        break;
                    }
                }
            }
        }
    }

    found.sort();
    found
}

/// Dispatches a JSON pi RPC request from the renderer.
pub fn rpc(app: &AppHandle, manager: &PiManager, request: Value) -> PiResult {
    let op = request.get("op").and_then(Value::as_str).unwrap_or("").trim();
    let pane_id = request
        .get("paneId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if pane_id.is_empty() {
        return Err("pi request requires paneId".into());
    }

    match op {
        "spawn" => {
            let cwd = request
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if cwd.is_empty() {
                return Err("pi spawn requires cwd".into());
            }
            let args: Vec<String> = request
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            manager.spawn(app, pane_id, cwd, &args)
        }
        "send" => {
            let line = request
                .get("line")
                .and_then(Value::as_str)
                .ok_or_else(|| "pi send requires line".to_string())?;
            manager.send(pane_id, line)
        }
        "kill" => manager.kill(pane_id),
        "stderr" => manager.stderr(pane_id),
        "files" => {
            let cwd = request
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if cwd.is_empty() {
                return Err("pi files requires cwd".into());
            }
            Ok(json!({ "files": walk_files(Path::new(cwd)) }))
        }
        "" => Err("Invalid pi request: missing op".into()),
        other => Err(format!("Unknown pi operation: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GUI `PATH` repair has to produce a usable `PATH` on a real machine — a GUI app
    /// inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, which does not contain Homebrew.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn login_path_resolves_a_usable_path() {
        let path = LOGIN_PATH
            .as_ref()
            .expect("login shell should report a PATH");
        assert!(path.contains('/'), "expected directories, got {path:?}");
        assert!(!path.contains('\n'), "expected one line, got {path:?}");
    }
}
