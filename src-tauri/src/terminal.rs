use crate::types::{
    PtyResizeRequest, TerminalDataEvent, TerminalExitEventPayload, TerminalSessionAttachRequest,
    TerminalSessionStartRequest, TerminalSessionStatus, TERMINAL_REPLAY_MAX_BYTES,
};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::str;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

const DATA_EVENT: &str = "terminal:data";
const EXIT_EVENT: &str = "terminal:exit";

pub struct TerminalManager {
    app: AppHandle,
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

struct TerminalSession {
    id: String,
    request: TerminalSessionStartRequest,
    pid: Option<u32>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    replay: Mutex<ReplayBuffer>,
    running: AtomicBool,
}

impl TerminalManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(&self, request: TerminalSessionStartRequest) -> Result<()> {
        let session_id = request.session_id.clone();
        self.kill(&session_id).ok();
        match self.spawn_session(request) {
            Ok(session) => {
                self.sessions.lock().unwrap().insert(session_id, session);
                Ok(())
            }
            Err(err) => {
                // Make startup failures visible in the terminal pane, matching Electron behavior.
                let _ = self.app.emit(
                    DATA_EVENT,
                    TerminalDataEvent {
                        session_id: session_id.clone(),
                        data: format!("\r\nFailed to start terminal: {err}\r\n"),
                    },
                );
                let _ = self.app.emit(
                    EXIT_EVENT,
                    TerminalExitEventPayload {
                        session_id,
                        exit_code: 1,
                        signal: None,
                    },
                );
                Err(err)
            }
        }
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let session = self.get(session_id)?;
        session.writer.lock().unwrap().write_all(data.as_bytes())?;
        session.writer.lock().unwrap().flush()?;
        Ok(())
    }

    pub fn resize(&self, request: PtyResizeRequest) -> Result<()> {
        let session = self.get(&request.session_id)?;
        session.master.lock().unwrap().resize(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(session_id);
        if let Some(session) = session {
            session.running.store(false, Ordering::SeqCst);
            let _ = session.child.lock().unwrap().kill();
            let _ = self.app.emit(
                EXIT_EVENT,
                TerminalExitEventPayload {
                    session_id: session_id.to_string(),
                    exit_code: -1,
                    signal: None,
                },
            );
        }
        Ok(())
    }

    pub fn attach(&self, request: TerminalSessionAttachRequest) -> Result<TerminalSessionStatus> {
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap()
            .get(&request.session_id)
            .cloned()
        {
            let running = session.running.load(Ordering::SeqCst);
            if request.replay.unwrap_or(true) {
                self.replay_to_app(&request.session_id)?;
            }
            return Ok(TerminalSessionStatus {
                session_id: request.session_id,
                running,
            });
        }
        let session_id = request.session_id.clone();
        self.create(request.into())?;
        Ok(TerminalSessionStatus {
            session_id,
            running: true,
        })
    }

    pub fn restart(&self, session_id: &str) -> Result<TerminalSessionStatus> {
        let request = self.get(session_id)?.request.clone();
        self.kill(session_id).ok();
        self.create(request)?;
        Ok(TerminalSessionStatus {
            session_id: session_id.to_string(),
            running: true,
        })
    }

    pub fn replay_to_window(
        &self,
        window: &Window,
        session_id: &str,
    ) -> Result<TerminalSessionStatus> {
        let running = self.get(session_id)?.running.load(Ordering::SeqCst);
        let data = self.replay_bytes(session_id)?;
        if !data.is_empty() {
            window.emit(
                DATA_EVENT,
                TerminalDataEvent {
                    session_id: session_id.to_string(),
                    data,
                },
            )?;
        }
        Ok(TerminalSessionStatus {
            session_id: session_id.to_string(),
            running,
        })
    }

    pub fn is_busy(&self, session_id: &str) -> Result<bool> {
        let session = self.get(session_id)?;
        if !session.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        Ok(session.pid.is_some_and(has_child_processes))
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    fn get(&self, session_id: &str) -> Result<Arc<TerminalSession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("terminal session not found: {session_id}"))
    }

    fn spawn_session(&self, request: TerminalSessionStartRequest) -> Result<Arc<TerminalSession>> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let cmd = build_command(&request);
        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();
        drop(pair.slave);

        let session = Arc::new(TerminalSession {
            id: request.session_id.clone(),
            request,
            pid,
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            replay: Mutex::new(ReplayBuffer::default()),
            running: AtomicBool::new(true),
        });

        self.start_reader(session.clone(), &mut reader);
        self.start_watcher(session.clone());
        Ok(session)
    }

    fn start_reader(&self, session: Arc<TerminalSession>, reader: &mut Box<dyn Read + Send>) {
        let app = self.app.clone();
        let mut reader = std::mem::replace(reader, Box::new(std::io::empty()));
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut decoder = Utf8StreamDecoder::default();
            while session.running.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        for data in decoder.push(&buf[..n]) {
                            append_replay(&session, &data);
                            let _ = app.emit(
                                DATA_EVENT,
                                TerminalDataEvent {
                                    session_id: session.id.clone(),
                                    data,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Some(data) = decoder.finish() {
                append_replay(&session, &data);
                let _ = app.emit(
                    DATA_EVENT,
                    TerminalDataEvent {
                        session_id: session.id.clone(),
                        data,
                    },
                );
            }
        });
    }

    fn start_watcher(&self, session: Arc<TerminalSession>) {
        let app = self.app.clone();
        thread::spawn(move || {
            while session.running.load(Ordering::SeqCst) {
                if let Ok(Some(status)) = session.child.lock().unwrap().try_wait() {
                    session.running.store(false, Ordering::SeqCst);
                    let code = status.exit_code() as i32;
                    let _ = app.emit(
                        EXIT_EVENT,
                        TerminalExitEventPayload {
                            session_id: session.id.clone(),
                            exit_code: code,
                            signal: None,
                        },
                    );
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
        });
    }

    fn replay_to_app(&self, session_id: &str) -> Result<()> {
        let data = self.replay_bytes(session_id)?;
        if !data.is_empty() {
            self.app.emit(
                DATA_EVENT,
                TerminalDataEvent {
                    session_id: session_id.to_string(),
                    data,
                },
            )?;
        }
        Ok(())
    }

    fn replay_bytes(&self, session_id: &str) -> Result<String> {
        let session = self.get(session_id)?;
        let text = session.replay.lock().unwrap().text();
        Ok(text)
    }
}

fn has_child_processes(pid: u32) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let pid_text = pid.to_string();
        if let Ok(output) = std::process::Command::new("pgrep")
            .args(["-P", &pid_text])
            .output()
        {
            if output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
            {
                return true;
            }
        }
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-A", "-o", "ppid="])
            .output()
        {
            return String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim() == pid_text);
        }
        false
    }
    #[cfg(target_os = "windows")]
    {
        let query = format!("Get-CimInstance Win32_Process | Where-Object {{$_.ParentProcessId -eq {pid}}} | Select-Object -First 1 -ExpandProperty ProcessId");
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &query])
            .output()
            .map(|output| {
                output.status.success()
                    && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
            })
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

#[derive(Default)]
struct ReplayBuffer {
    chunks: VecDeque<String>,
    bytes: usize,
}

impl ReplayBuffer {
    fn push(&mut self, data: &str) {
        if data.contains("\x1bc") || data.contains("\x1b[2J") || data.contains("\x1b[3J") {
            self.clear();
        }
        self.bytes += data.len();
        self.chunks.push_back(data.to_string());
        while self.bytes > TERMINAL_REPLAY_MAX_BYTES {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.len());
        }
    }

    fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }

    fn text(&self) -> String {
        self.chunks.iter().map(String::as_str).collect()
    }
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();

        loop {
            match str::from_utf8(&self.pending) {
                Ok(valid) => {
                    if !valid.is_empty() {
                        out.push(valid.to_string());
                    }
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        let valid =
                            String::from_utf8_lossy(&self.pending[..valid_up_to]).to_string();
                        out.push(valid);
                        self.pending.drain(..valid_up_to);
                        continue;
                    }

                    if let Some(error_len) = err.error_len() {
                        out.push(String::from_utf8_lossy(&self.pending[..error_len]).to_string());
                        self.pending.drain(..error_len);
                        continue;
                    }

                    break;
                }
            }
        }

        out
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            let data = String::from_utf8_lossy(&self.pending).to_string();
            self.pending.clear();
            Some(data)
        }
    }
}

fn append_replay(session: &TerminalSession, data: &str) {
    session.replay.lock().unwrap().push(data);
}

fn build_command(request: &TerminalSessionStartRequest) -> CommandBuilder {
    let (program, args): (String, Vec<String>) = if let Some(profile) = &request.shell_profile {
        (profile.command.clone(), profile.args.clone())
    } else if cfg!(windows) {
        (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            Vec::new(),
        )
    } else {
        (
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            Vec::new(),
        )
    };

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }

    let cwd = PathBuf::from(&request.cwd);
    if cwd.is_dir() {
        cmd.cwd(cwd);
    } else if let Ok(current) = std::env::current_dir() {
        cmd.cwd(current);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "swath");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if std::env::var_os("LC_CTYPE").is_none() {
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }

    if let Some(profile) = &request.shell_profile {
        if let Some(env) = &profile.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
    }
    if let Some(env) = &request.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd
}
