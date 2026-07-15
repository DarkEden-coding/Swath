mod process;
mod replay;

use crate::types::{
    PtyResizeRequest, TerminalDataEvent, TerminalExitEventPayload, TerminalSessionAttachRequest,
    TerminalSessionStartRequest, TerminalSessionStatus, TERMINAL_REPLAY_DETACHED_MAX_BYTES,
    TERMINAL_REPLAY_MAX_BYTES,
};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use process::has_child_processes;
use replay::{ReplayBuffer, Utf8StreamDecoder};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

const DATA_EVENT: &str = "terminal:data";
const EXIT_EVENT: &str = "terminal:exit";

/// Owns and coordinates all PTY-backed terminal sessions.
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
    stream_to_ui: AtomicBool,
    running: AtomicBool,
}

impl TerminalManager {
    /// Creates a terminal manager that emits session events through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces any existing session with the same ID and starts a new PTY.
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

    /// Writes input to a terminal session.
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let session = self.get(session_id)?;
        session.writer.lock().unwrap().write_all(data.as_bytes())?;
        session.writer.lock().unwrap().flush()?;
        Ok(())
    }

    /// Resizes a terminal session PTY.
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

    /// Stops and removes a terminal session if it exists.
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

    /// Attaches to an existing session, optionally replaying output, or creates it.
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

    /// Restarts a session using its original start request.
    pub fn restart(&self, session_id: &str) -> Result<TerminalSessionStatus> {
        let request = self.get(session_id)?.request.clone();
        self.kill(session_id).ok();
        self.create(request)?;
        Ok(TerminalSessionStatus {
            session_id: session_id.to_string(),
            running: true,
        })
    }

    /// Emits buffered output for a session to one window.
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

    /// Enables live UI events and adjusts replay capacity for attachment state.
    pub fn set_streaming(&self, session_id: &str, enabled: bool) -> Result<()> {
        let session = self.get(session_id)?;
        session.stream_to_ui.store(enabled, Ordering::Relaxed);
        let mut replay = session.replay.lock().unwrap();
        if enabled {
            replay.set_limit(TERMINAL_REPLAY_MAX_BYTES);
        } else {
            replay.set_limit(TERMINAL_REPLAY_DETACHED_MAX_BYTES);
        }
        Ok(())
    }

    /// Reports whether a running shell has spawned a child process.
    pub fn is_busy(&self, session_id: &str) -> Result<bool> {
        let session = self.get(session_id)?;
        if !session.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        Ok(session.pid.is_some_and(has_child_processes))
    }

    /// Stops and removes every terminal session.
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
            replay: Mutex::new(ReplayBuffer::new(TERMINAL_REPLAY_MAX_BYTES)),
            stream_to_ui: AtomicBool::new(true),
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
                            if session.stream_to_ui.load(Ordering::Relaxed) {
                                let _ = app.emit(
                                    DATA_EVENT,
                                    TerminalDataEvent {
                                        session_id: session.id.clone(),
                                        data,
                                    },
                                );
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Some(data) = decoder.finish() {
                append_replay(&session, &data);
                if session.stream_to_ui.load(Ordering::Relaxed) {
                    let _ = app.emit(
                        DATA_EVENT,
                        TerminalDataEvent {
                            session_id: session.id.clone(),
                            data,
                        },
                    );
                }
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
