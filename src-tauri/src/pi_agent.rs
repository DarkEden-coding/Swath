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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter};

/// Event channel carrying `{ paneId, line }` stdout records and `{ paneId, exit }` notices.
const PI_EVENT: &str = "pi:event";

/// Upper bound on retained stderr text per pane, for crash diagnostics.
const STDERR_MAX_BYTES: usize = 64 * 1024;

/// Swath-owned Pi extension that authenticates sudo through the RPC dialog protocol.
const PI_SUDO_EXTENSION: &str = include_str!("pi_sudo.ts");

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

        let sudo_extension = std::env::temp_dir().join("swath-pi-sudo.ts");
        fs::write(&sudo_extension, PI_SUDO_EXTENSION)
            .map_err(|err| format!("Unable to prepare Pi sudo integration: {err}"))?;

        let mut command = pi_command();
        command
            .arg("--mode")
            .arg("rpc")
            .arg("--extension")
            .arg(sudo_extension)
            .args(extra_args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.env("SWATH_PI_AGENT", "1");
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

/// Builds the platform-appropriate command for the npm-installed pi executable.
fn pi_command() -> Command {
    // Windows' CreateProcess does not search PATHEXT, so it cannot resolve npm's extensionless
    // `pi` shim. Rust handles the explicit batch-file path through cmd.exe.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("pi.cmd");
        command.creation_flags(CREATE_NO_WINDOW);
        return command;
    }

    #[cfg(not(target_os = "windows"))]
    Command::new("pi")
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

/// Lines inspected per session file when building the `/resume` list.
///
/// ponytail: a bounded prefix scan, not pi's full-file `buildSessionInfo`. It is enough for the
/// header, the display name and the opening user message; a session renamed after line 400 shows
/// its old label. Scan the whole file if that ever matters.
const SESSION_SCAN_LINES: usize = 400;

/// Sessions offered by `/resume`, newest first.
const SESSION_LIST_LIMIT: usize = 100;

/// Summarises one pi session JSONL file for the resume picker.
fn read_session_info(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut lines = BufReader::new(file).lines();
    let header: Value = serde_json::from_str(&lines.next()?.ok()?).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }

    let mut name: Option<String> = None;
    let mut preview = String::new();
    let mut messages = 0usize;
    for line in lines.take(SESSION_SCAN_LINES).map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty());
            }
            Some("message") => {
                messages += 1;
                let message = entry.get("message");
                if !preview.is_empty()
                    || message.and_then(|m| m.get("role")).and_then(Value::as_str) != Some("user")
                {
                    continue;
                }
                preview = match message.and_then(|m| m.get("content")) {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(blocks)) => blocks
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                };
                preview = preview.trim().replace('\n', " ");
                preview.truncate(200);
            }
            _ => {}
        }
    }

    let modified = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);

    Some(json!({
        "path": path.to_string_lossy(),
        "id": header.get("id").and_then(Value::as_str).unwrap_or_default(),
        "name": name,
        "preview": preview,
        "messages": messages,
        "modified": modified,
    }))
}

/// Lists pi sessions stored in `dir`, newest first.
fn list_sessions(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions: Vec<Value> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| read_session_info(&path))
        .collect();
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(session.get("modified").and_then(Value::as_u64).unwrap_or(0))
    });
    sessions.truncate(SESSION_LIST_LIMIT);
    sessions
}

/// Walks every root of a project group, collecting the candidates `@` completion offers.
///
/// The pane's own working directory yields repository-relative paths, as a single-folder project
/// always has. The other folders of a group yield absolute paths: pi resolves an `@` mention
/// against its working directory, so only an absolute path reaches a sibling folder. The budget is
/// split evenly so one huge repository cannot crowd its siblings out of the list.
fn walk_group_files(cwd: &Path, extra_roots: &[&Path]) -> Vec<String> {
    let roots = 1 + extra_roots.len();
    let budget = (FILE_LIST_LIMIT / roots).max(1);
    let mut found = walk_files(cwd, budget);
    for root in extra_roots {
        let prefix = root.to_string_lossy().replace('\\', "/");
        let prefix = prefix.trim_end_matches('/');
        found.extend(
            walk_files(root, budget)
                .into_iter()
                .map(|relative| format!("{prefix}/{relative}")),
        );
    }
    found
}

/// Walks `root` breadth-first, collecting relative file paths.
///
/// Bounded rather than exhaustive: `@` completion only needs enough candidates to filter,
/// and an unbounded walk on a large repo would block the UI.
fn walk_files(root: &Path, limit: usize) -> Vec<String> {
    let mut found = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);

    while let Some(dir) = queue.pop_front() {
        if found.len() >= limit {
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
                    if found.len() >= limit {
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
            // The other folders of a project group, so `@` reaches across the whole project.
            let extra: Vec<&str> = request
                .get("paths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|path| !path.is_empty() && *path != cwd)
                        .collect()
                })
                .unwrap_or_default();
            let extra_roots: Vec<&Path> = extra.iter().map(Path::new).collect();
            Ok(json!({ "files": walk_group_files(Path::new(cwd), &extra_roots) }))
        }
        "sessions" => {
            let dir = request
                .get("dir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if dir.is_empty() {
                return Err("pi sessions requires dir".into());
            }
            Ok(json!({ "sessions": list_sessions(Path::new(dir)) }))
        }
        "" => Err("Invalid pi request: missing op".into()),
        other => Err(format!("Unknown pi operation: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/resume` is only useful if a session file yields a label a human recognises: its name
    /// when one was set, otherwise the opening user message.
    #[test]
    fn session_info_reads_name_and_first_user_message() {
        let dir = std::env::temp_dir().join("swath-pi-session-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.jsonl");
        fs::write(
            &path,
            concat!(
                r#"{"type":"session","id":"s1","cwd":"/tmp"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"fix the parser"}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"assistant","content":[]}}"#,
                "\n",
                r#"{"type":"session_info","name":"parser work"}"#,
                "\n",
            ),
        )
        .unwrap();

        let info = read_session_info(&path).expect("a valid session file");
        assert_eq!(info["id"], "s1");
        assert_eq!(info["name"], "parser work");
        assert_eq!(info["preview"], "fix the parser");
        assert_eq!(info["messages"], 2);
        assert_eq!(list_sessions(&dir).len(), 1);

        // A file that is not a pi session is skipped rather than listed with junk.
        fs::write(dir.join("b.jsonl"), "not json\n").unwrap();
        assert_eq!(list_sessions(&dir).len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// `@` completion on a group's shared agent has to reach the group's other folders, and a
    /// mention only resolves there when it is absolute.
    #[test]
    fn group_file_walk_lists_siblings_by_absolute_path() {
        let root = std::env::temp_dir().join("swath-pi-group-files-test");
        let _ = fs::remove_dir_all(&root);
        let (api, web) = (root.join("api"), root.join("web"));
        fs::create_dir_all(api.join("src")).unwrap();
        fs::create_dir_all(&web).unwrap();
        fs::write(api.join("src").join("main.rs"), "").unwrap();
        fs::write(web.join("index.ts"), "").unwrap();

        let files = walk_group_files(&api, &[web.as_path()]);
        assert!(files.contains(&"src/main.rs".to_string()), "got {files:?}");
        let sibling = format!("{}/index.ts", web.to_string_lossy().replace('\\', "/"));
        assert!(files.contains(&sibling), "got {files:?}");

        // The pane's own folder is the working directory; listing it twice would duplicate it.
        assert_eq!(walk_group_files(&api, &[]), vec!["src/main.rs".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows must target npm's `.cmd` shim explicitly; CreateProcess does not use PATHEXT.
    #[test]
    #[cfg(target_os = "windows")]
    fn pi_command_uses_the_windows_npm_shim() {
        assert_eq!(pi_command().get_program(), "pi.cmd");
    }

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
