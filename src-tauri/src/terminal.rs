pub(crate) mod process;
mod replay;

use crate::{
    config,
    events::{value, EventPublisher},
    types::{
        PtyResizeRequest, TerminalDataEvent, TerminalExitEventPayload,
        TerminalSessionAttachRequest, TerminalSessionStartRequest, TerminalSessionStatus,
        TERMINAL_REPLAY_MAX_BYTES,
    },
};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use process::{has_child_processes, kill_process_tree};
use replay::{ReplayBuffer, Utf8StreamDecoder};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

const DATA_EVENT: &str = "terminal:data";
const EXIT_EVENT: &str = "terminal:exit";

/// Owns and coordinates all PTY-backed terminal sessions.
pub struct TerminalManager {
    events: Arc<dyn EventPublisher>,
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
    /// Creates a terminal manager that emits through the runtime event publisher.
    pub fn new(events: Arc<dyn EventPublisher>) -> Self {
        Self {
            events,
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
                self.events.publish(
                    DATA_EVENT,
                    value(TerminalDataEvent {
                        session_id: session_id.clone(),
                        data: format!("\r\nFailed to start terminal: {err}\r\n"),
                    }),
                );
                self.events.publish(
                    EXIT_EVENT,
                    value(TerminalExitEventPayload {
                        session_id,
                        exit_code: 1,
                        signal: None,
                    }),
                );
                Err(err)
            }
        }
    }

    /// Resolves a terminal's working directory from the assigned executor task record.
    pub fn create_for_task(
        &self,
        data_dir: &Path,
        mut request: TerminalSessionStartRequest,
    ) -> Result<()> {
        let task_id = request
            .task_id
            .clone()
            .ok_or_else(|| anyhow!("taskId is required"))?;
        let generation = request
            .execution_generation
            .ok_or_else(|| anyhow!("executionGeneration is required"))?;
        request.cwd = task_cwd(data_dir, Some(&task_id), Some(generation))?;
        // This mapping is durable because write/resize/kill/replay only carry a session ID.
        let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
        let device_id: String = conn.query_row(
            "SELECT assigned_device_id FROM tasks WHERE id=?1",
            [&task_id],
            |r| r.get(0),
        )?;
        let session_id = request.session_id.clone();

        // Remove the old fence before stopping its process: a replacement must never leave a
        // durable route to a shell which has just been killed.  Commit the new fence before
        // spawning so every process that can emit output has a durable owner.
        conn.execute(
            "DELETE FROM terminal_task_sessions WHERE session_id=?1",
            [&session_id],
        )?;
        self.kill(&session_id)?;
        conn.execute(
            "INSERT INTO terminal_task_sessions(session_id,task_id,device_id,execution_generation,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))",
            params![session_id, task_id, device_id, generation],
        )?;
        if let Err(error) = self.create(request) {
            // Spawn failure (including a partially-created PTY) must not leave a routable fence.
            let _ = conn.execute(
                "DELETE FROM terminal_task_sessions WHERE session_id=?1",
                [&session_id],
            );
            let _ = self.kill(&session_id);
            return Err(error);
        }
        Ok(())
    }

    /// Writes input to a terminal session.
    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let session = self.get(session_id)?;
        session.writer.lock().unwrap().write_all(data.as_bytes())?;
        session.writer.lock().unwrap().flush()?;
        Ok(())
    }

    /// Writes only while the durable task-generation fence still authorizes this shell.
    pub fn write_for_task(&self, data_dir: &Path, session_id: &str, data: &str) -> Result<()> {
        let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
        let task: Option<(String, i64)> = conn.query_row(
            "SELECT task_id,execution_generation FROM terminal_task_sessions WHERE session_id=?1",
            [session_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((task_id, generation)) = task else {
            return Err(anyhow!("{}", r#"{"code":"unknown_executor"}"#));
        };
        // Reuse the create-time resolver: it checks ownership, generation, transfer freeze,
        // and that the executor's worktree remains available.
        task_cwd(data_dir, Some(&task_id), Some(generation))?;
        self.write(session_id, data)
    }

    fn authorize_session(&self, data_dir: &Path, session_id: &str) -> Result<()> {
        let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
        let task: Option<(String, i64)> = conn.query_row("SELECT task_id,execution_generation FROM terminal_task_sessions WHERE session_id=?1", [session_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((task_id, generation)) = task else {
            return Err(anyhow!("{}", r#"{"code":"unknown_executor"}"#));
        };
        task_cwd(data_dir, Some(&task_id), Some(generation)).map(|_| ())
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

    pub fn resize_for_task(&self, data_dir: &Path, request: PtyResizeRequest) -> Result<()> {
        self.authorize_session(data_dir, &request.session_id)?;
        self.resize(request)
    }

    /// Stops and removes a terminal session if it exists.
    pub fn kill(&self, session_id: &str) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(session_id);
        if let Some(session) = session {
            session.running.store(false, Ordering::SeqCst);
            if let Some(pid) = session.pid {
                kill_process_tree(pid);
            }
            let _ = session.child.lock().unwrap().kill();
            self.events.publish(
                EXIT_EVENT,
                value(TerminalExitEventPayload {
                    session_id: session_id.to_string(),
                    exit_code: -1,
                    signal: None,
                }),
            );
        }
        Ok(())
    }

    pub fn kill_for_task(&self, data_dir: &Path, session_id: &str) -> Result<()> {
        self.authorize_session(data_dir, session_id)?;
        self.kill(session_id)
    }

    /// Attaches to an existing session only. Historical/exited sessions are inspectable but never
    /// restarted by attachment; restart is explicit.
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
        Err(anyhow!(
            "terminal session not found: {}",
            request.session_id
        ))
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

    pub fn attach_for_task(
        &self,
        data_dir: &Path,
        request: TerminalSessionAttachRequest,
    ) -> Result<TerminalSessionStatus> {
        self.authorize_session(data_dir, &request.session_id)?;
        self.attach(request)
    }

    pub fn restart_for_task(
        &self,
        data_dir: &Path,
        session_id: &str,
    ) -> Result<TerminalSessionStatus> {
        self.authorize_session(data_dir, session_id)?;
        self.restart(session_id)
    }

    /// Returns replay to the requesting connector; replay is never broadcast globally.
    pub fn replay_for_task(
        &self,
        data_dir: &Path,
        session_id: &str,
    ) -> Result<(TerminalSessionStatus, String)> {
        self.authorize_session(data_dir, session_id)?;
        let running = self.get(session_id)?.running.load(Ordering::SeqCst);
        Ok((
            TerminalSessionStatus {
                session_id: session_id.to_string(),
                running,
            },
            self.replay_bytes(session_id)?,
        ))
    }

    /// Kept for IPC compatibility. Streaming is viewer-scoped, so hiding one viewer never
    /// changes the process-wide stream or replay retention.
    pub fn set_streaming(&self, session_id: &str, _enabled: bool) -> Result<()> {
        self.get(session_id)?;
        Ok(())
    }

    pub fn set_streaming_for_task(
        &self,
        data_dir: &Path,
        session_id: &str,
        enabled: bool,
    ) -> Result<()> {
        self.authorize_session(data_dir, session_id)?;
        self.set_streaming(session_id, enabled)
    }

    /// Reports whether a running shell has spawned a child process.
    pub fn is_busy(&self, session_id: &str) -> Result<bool> {
        let session = self.get(session_id)?;
        if !session.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        Ok(session.pid.is_some_and(has_child_processes))
    }

    pub fn is_busy_for_task(&self, data_dir: &Path, session_id: &str) -> Result<bool> {
        self.authorize_session(data_dir, session_id)?;
        self.is_busy(session_id)
    }

    /// Returns the actual PTY children currently owned by a task.
    pub fn task_processes(&self, data_dir: &Path, task_id: &str) -> Result<Vec<(String, u32)>> {
        let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
        let mut statement =
            conn.prepare("SELECT session_id FROM terminal_task_sessions WHERE task_id=?1")?;
        let ids = statement
            .query_map([task_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let sessions = self.sessions.lock().unwrap();
        Ok(ids
            .into_iter()
            .filter_map(|id| sessions.get(&id).and_then(|s| s.pid).map(|pid| (id, pid)))
            .collect())
    }

    /// Quiesces only task-owned PTYs. The caller must have recorded explicit confirmation first.
    pub fn quiesce_task(&self, data_dir: &Path, task_id: &str) -> Result<Vec<(String, u32)>> {
        let processes = self.task_processes(data_dir, task_id)?;
        for (session, _) in &processes {
            self.kill(session)?;
        }
        Ok(processes)
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
            running: AtomicBool::new(true),
        });

        self.start_reader(session.clone(), &mut reader);
        self.start_watcher(session.clone());
        Ok(session)
    }

    fn start_reader(&self, session: Arc<TerminalSession>, reader: &mut Box<dyn Read + Send>) {
        let events = self.events.clone();
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
                            events.publish(
                                DATA_EVENT,
                                value(TerminalDataEvent {
                                    session_id: session.id.clone(),
                                    data,
                                }),
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Some(data) = decoder.finish() {
                append_replay(&session, &data);
                events.publish(
                    DATA_EVENT,
                    value(TerminalDataEvent {
                        session_id: session.id.clone(),
                        data,
                    }),
                );
            }
        });
    }

    fn start_watcher(&self, session: Arc<TerminalSession>) {
        let events = self.events.clone();
        thread::spawn(move || {
            while session.running.load(Ordering::SeqCst) {
                if let Ok(Some(status)) = session.child.lock().unwrap().try_wait() {
                    session.running.store(false, Ordering::SeqCst);
                    let code = status.exit_code() as i32;
                    events.publish(
                        EXIT_EVENT,
                        value(TerminalExitEventPayload {
                            session_id: session.id.clone(),
                            exit_code: code,
                            signal: None,
                        }),
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
            self.events.publish(
                DATA_EVENT,
                value(TerminalDataEvent {
                    session_id: session_id.to_string(),
                    data,
                }),
            );
        }
        Ok(())
    }

    fn replay_bytes(&self, session_id: &str) -> Result<String> {
        let session = self.get(session_id)?;
        let text = session.replay.lock().unwrap().text();
        Ok(text)
    }
}

fn task_cwd(data_dir: &Path, task_id: Option<&str>, generation: Option<i64>) -> Result<String> {
    let task_id = task_id.filter(|id| !id.is_empty()).ok_or_else(|| {
        anyhow!(
            "{}",
            r#"{"code":"invalid_request","message":"taskId is required"}"#
        )
    })?;
    let generation = generation.ok_or_else(|| {
        anyhow!(
            "{}",
            r#"{"code":"invalid_request","message":"executionGeneration is required"}"#
        )
    })?;
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
    // A transfer freeze is catalog state, not a UI hint; this check survives a restart and
    // prevents a new shell from racing the snapshot before ownership commits.
    let frozen: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM task_operations WHERE task_id=?1 AND kind='transfer' AND phase IN ('source frozen','destination staged','verified'))", params![task_id], |r| r.get(0))?;
    if frozen {
        return Err(anyhow!("{}", r#"{"code":"task_frozen"}"#));
    }
    let row: Option<(i64, String)> = conn.query_row("SELECT t.execution_generation,p.path FROM tasks t JOIN device_task_paths p ON p.task_id=t.id AND p.device_id=t.assigned_device_id WHERE t.id=?1 AND t.tombstoned_at IS NULL", params![task_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((current, cwd)) = row else {
        return Err(anyhow!(format!(
            r#"{{"code":"unknown_executor","taskId":"{task_id}"}}"#
        )));
    };
    if current != generation {
        return Err(anyhow!(format!(
            r#"{{"code":"stale_generation","expected":{current}}}"#
        )));
    }
    if !Path::new(&cwd).is_dir() {
        return Err(anyhow!("{}", r#"{"code":"executor_unreachable"}"#));
    }
    Ok(cwd)
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
    // Applied after user/profile env so image-capable terminal identity is guaranteed.
    cmd.env("TERM_PROGRAM", "swath");
    cmd.env(
        "ITERM_SESSION_ID",
        synthetic_iterm_session_id(&request.session_id),
    );
    cmd
}

/// Builds a synthetic iTerm session id from the Swath terminal session id.
fn synthetic_iterm_session_id(session_id: &str) -> String {
    format!("swath:{session_id}")
}

#[cfg(test)]
mod tests {
    use super::synthetic_iterm_session_id;

    #[test]
    fn iterm_session_id_includes_session_id() {
        assert_eq!(synthetic_iterm_session_id("abc-123"), "swath:abc-123");
    }

    #[test]
    fn attachment_does_not_create_or_toggle_a_session() {
        let source = include_str!("terminal.rs");
        let attach = source
            .split("pub fn attach(")
            .nth(1)
            .and_then(|body| body.split("pub fn restart(").next())
            .unwrap();
        assert!(!attach.contains("self.create("));
        assert!(!attach.contains("set_streaming"));
    }
}
