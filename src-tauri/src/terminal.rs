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
    /// The durable route is executor-local and must be removed when this PTY exits.  Plain
    /// sessions (created by the legacy/local API) do not have a route to clean up.
    route: Option<TerminalRoute>,
    replay: Mutex<ReplayBuffer>,
    running: AtomicBool,
}

#[derive(Clone)]
#[allow(dead_code)] // Stored with a PTY so explicit restart/route cleanup can retain its fence.
struct TerminalRoute {
    db_path: PathBuf,
    task_id: String,
    device_id: String,
    generation: i64,
}

impl TerminalManager {
    /// Creates a terminal manager that emits through the runtime event publisher.
    pub fn new(events: Arc<dyn EventPublisher>) -> Self {
        Self {
            events,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Ensures that a session with this ID exists.
    ///
    /// Session IDs are stable pane identities, so creating the same ID again must not kill the
    /// process currently attached to that pane.  Call [`Self::restart`] for the explicit,
    /// destructive replacement operation.
    #[allow(dead_code)]
    pub fn create(&self, request: TerminalSessionStartRequest) -> Result<()> {
        self.create_with_route(request, None)
    }

    fn create_with_route(
        &self,
        request: TerminalSessionStartRequest,
        route: Option<TerminalRoute>,
    ) -> Result<()> {
        let session_id = request.session_id.clone();
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&session_id) {
            return Ok(());
        }
        match self.spawn_session(request, route) {
            Ok(session) => {
                sessions.insert(session_id, session);
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

        // A create is an ensure operation.  Do not replace a live PTY or retarget its durable
        // route underneath it.  Reusing the same ID is allowed only for the same executor task
        // and generation; a different owner must allocate a new session ID.
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT task_id,execution_generation FROM terminal_task_sessions WHERE session_id=?1",
                [&session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((existing_task, existing_generation)) = existing {
            if existing_task != task_id || existing_generation != generation {
                return Err(anyhow!(
                    "terminal session already belongs to another task or generation"
                ));
            }
            if let Some(session) = self.sessions.lock().unwrap().get(&session_id) {
                if session.route.is_some() {
                    return Ok(());
                }
                return Err(anyhow!(
                    "terminal session already exists without a task route"
                ));
            }
        }

        // A local/unscoped session with the same stable ID cannot be safely retargeted to a task.
        // Keep the live process intact and ask the caller to choose a fresh ID.
        if self.sessions.lock().unwrap().contains_key(&session_id) {
            return Err(anyhow!(
                "terminal session already exists without a task route"
            ));
        }

        // Commit the fence before spawning so every process that can emit output has a durable
        // owner.  An old row with the same task/generation is a recoverable route after a process
        // restart, so INSERT OR IGNORE gives create its ensure semantics without retargeting it.
        conn.execute(
            "INSERT OR IGNORE INTO terminal_task_sessions(session_id,task_id,device_id,execution_generation,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))",
            params![session_id, task_id, device_id, generation],
        )?;
        let db_path = config::db_path_in(data_dir).map_err(|e| anyhow!(e))?;
        if let Err(error) = self.create_with_route(
            request,
            Some(TerminalRoute {
                db_path,
                task_id,
                device_id,
                generation,
            }),
        ) {
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
            cleanup_route(session.route.as_ref(), session_id);
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
        self.kill(session_id)?;
        // The process may already have exited while the manager was restarting, leaving only
        // the durable route behind.  Explicit task-scoped kill is also the cleanup operation for
        // that stale route.
        let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| anyhow!(e))?)?;
        conn.execute(
            "DELETE FROM terminal_task_sessions WHERE session_id=?1",
            [session_id],
        )?;
        Ok(())
    }

    /// Attaches to an existing session only. Historical/exited sessions are inspectable but never
    /// restarted by attachment; restart is explicit.
    #[allow(dead_code)]
    pub fn attach(&self, request: TerminalSessionAttachRequest) -> Result<TerminalSessionStatus> {
        self.attach_with_replay(request).map(|(status, _)| status)
    }

    /// Attaches to an existing session and returns its bounded replay to the requesting caller.
    /// Replay is deliberately not emitted through [`EventPublisher`]: that bus is shared by all
    /// viewers, so publishing a replay would make one viewer's attach redraw every other viewer.
    pub fn attach_with_replay(
        &self,
        request: TerminalSessionAttachRequest,
    ) -> Result<(TerminalSessionStatus, String)> {
        // End the map guard before reading the replay buffer.  `replay_bytes` performs its own
        // lookup, and keeping this temporary guard alive across the if-body would self-deadlock.
        let session = {
            self.sessions
                .lock()
                .unwrap()
                .get(&request.session_id)
                .cloned()
        };
        if let Some(session) = session {
            let running = session.running.load(Ordering::SeqCst);
            let replay = if request.replay.unwrap_or(true) {
                self.replay_bytes(&request.session_id)?
            } else {
                String::new()
            };
            return Ok((
                TerminalSessionStatus {
                    session_id: request.session_id,
                    running,
                },
                replay,
            ));
        }
        Err(anyhow!(
            "terminal session not found: {}",
            request.session_id
        ))
    }

    /// Restarts a session using its original start request.
    #[allow(dead_code)]
    pub fn restart(&self, session_id: &str) -> Result<TerminalSessionStatus> {
        let session = self.get(session_id)?;
        let request = session.request.clone();
        let route = session.route.clone();
        self.kill(session_id).ok();
        if let Some(route) = &route {
            let conn = config::connection_at(&route.db_path)?;
            conn.execute(
                "INSERT OR IGNORE INTO terminal_task_sessions(session_id,task_id,device_id,execution_generation,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))",
                params![session_id, route.task_id, route.device_id, route.generation],
            )?;
        }
        if let Err(error) = self.create_with_route(request, route.clone()) {
            cleanup_route(route.as_ref(), session_id);
            return Err(error);
        }
        Ok(TerminalSessionStatus {
            session_id: session_id.to_string(),
            running: true,
        })
    }

    #[allow(dead_code)]
    pub fn attach_for_task(
        &self,
        data_dir: &Path,
        request: TerminalSessionAttachRequest,
    ) -> Result<TerminalSessionStatus> {
        self.attach_for_task_with_replay(data_dir, request)
            .map(|(status, _)| status)
    }

    /// Task-authorized variant of [`Self::attach_with_replay`].
    pub fn attach_for_task_with_replay(
        &self,
        data_dir: &Path,
        request: TerminalSessionAttachRequest,
    ) -> Result<(TerminalSessionStatus, String)> {
        self.authorize_session(data_dir, &request.session_id)?;
        self.attach_with_replay(request)
    }

    pub fn restart_for_task(
        &self,
        data_dir: &Path,
        session_id: &str,
    ) -> Result<TerminalSessionStatus> {
        self.authorize_session(data_dir, session_id)?;
        let request = self.get(session_id)?.request.clone();
        self.kill(session_id)?;
        self.create_for_task(data_dir, request)?;
        Ok(TerminalSessionStatus {
            session_id: session_id.to_string(),
            running: true,
        })
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

    fn spawn_session(
        &self,
        request: TerminalSessionStartRequest,
        route: Option<TerminalRoute>,
    ) -> Result<Arc<TerminalSession>> {
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
            route,
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
                    // `kill` marks the session stopped before signalling the child.  Only the
                    // watcher which observes a natural exit owns route cleanup and exit delivery;
                    // this prevents an old watcher from deleting a row belonging to a restarted
                    // session with the same stable ID.
                    if session
                        .running
                        .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                        .is_err()
                    {
                        break;
                    }
                    cleanup_route(session.route.as_ref(), &session.id);
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
    let frozen: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM task_operations WHERE task_id=?1 AND ((kind='transfer' AND phase IN ('source frozen','destination staged','verified')) OR (kind='cleanup' AND phase='cleanup frozen')))", params![task_id], |r| r.get(0))?;
    if frozen {
        return Err(anyhow!("{}", r#"{"code":"task_frozen"}"#));
    }
    let row: Option<(i64, String)> = conn.query_row("SELECT t.execution_generation,p.path FROM tasks t JOIN device_task_paths p ON p.task_id=t.id AND p.device_id=t.assigned_device_id WHERE t.id=?1 AND t.lifecycle='active' AND t.tombstoned_at IS NULL", params![task_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
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

/// Removes the executor-local route after a session exits.  Route cleanup is best-effort because
/// process shutdown must not be held hostage by a database that is unavailable or being closed.
fn cleanup_route(route: Option<&TerminalRoute>, session_id: &str) {
    let Some(route) = route else {
        return;
    };
    if let Ok(conn) = config::connection_at(&route.db_path) {
        let _ = conn.execute(
            "DELETE FROM terminal_task_sessions WHERE session_id=?1",
            [session_id],
        );
    }
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
    use super::{synthetic_iterm_session_id, TerminalManager};
    use crate::events::EventPublisher;
    use crate::types::{ShellProfile, TerminalSessionAttachRequest, TerminalSessionStartRequest};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct RecordingEvents(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventPublisher for RecordingEvents {
        fn publish(&self, channel: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((channel.to_string(), payload));
        }
    }

    fn request(session_id: &str, command: &str) -> TerminalSessionStartRequest {
        TerminalSessionStartRequest {
            session_id: session_id.to_string(),
            task_id: None,
            pane_id: None,
            execution_generation: None,
            cwd: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
            shell_profile: Some(ShellProfile {
                id: "test".into(),
                name: "test".into(),
                command: "/bin/sh".into(),
                args: vec!["-c".into(), command.into()],
                env: None,
            }),
            env: None,
            metadata: None,
        }
    }

    fn attach_request(session_id: &str, replay: bool) -> TerminalSessionAttachRequest {
        TerminalSessionAttachRequest {
            session_id: session_id.to_string(),
            task_id: None,
            pane_id: None,
            execution_generation: None,
            viewer_id: Some("second-viewer".into()),
            cwd: std::env::current_dir().unwrap().display().to_string(),
            cols: 80,
            rows: 24,
            shell_profile: None,
            env: None,
            metadata: None,
            replay: Some(replay),
        }
    }

    #[test]
    fn iterm_session_id_includes_session_id() {
        assert_eq!(synthetic_iterm_session_id("abc-123"), "swath:abc-123");
    }

    #[cfg(unix)]
    #[test]
    fn create_is_idempotent_for_a_live_session() {
        let events = Arc::new(RecordingEvents::default());
        let manager = TerminalManager::new(events);
        let first = request("ensure-test", "sleep 10");
        manager.create(first.clone()).unwrap();
        let first_pid = manager.get("ensure-test").unwrap().pid;
        manager.create(first).unwrap();
        assert_eq!(manager.get("ensure-test").unwrap().pid, first_pid);
        manager.kill("ensure-test").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn attach_returns_replay_without_publishing_it() {
        let events = Arc::new(RecordingEvents::default());
        let manager = TerminalManager::new(events.clone());
        manager
            .create(request("attach-test", "printf replay-marker; sleep 10"))
            .unwrap();

        let replay = (0..40).find_map(|_| {
            let replay = manager.replay_bytes("attach-test").unwrap();
            if replay.contains("replay-marker") {
                Some(replay)
            } else {
                thread::sleep(Duration::from_millis(25));
                None
            }
        });
        assert!(replay.is_some(), "shell output did not reach replay buffer");
        let before = events.0.lock().unwrap().len();
        let (_, attached_replay) = manager
            .attach_with_replay(attach_request("attach-test", true))
            .unwrap();
        assert!(attached_replay.contains("replay-marker"));
        assert_eq!(events.0.lock().unwrap().len(), before);
        manager.kill("attach-test").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn task_route_is_removed_when_process_exits() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("swath-terminal-test-{suffix}"));
        std::fs::create_dir_all(&data_dir).unwrap();
        crate::config::initialize(&data_dir).unwrap();
        let db_path = crate::config::db_path_in(&data_dir).unwrap();
        let conn = crate::config::connection_at(&db_path).unwrap();
        conn.execute("INSERT INTO projects(id,network_id,name,default_branch,task_order,revision,created_at) VALUES('p','n','p','main','[]',1,0)", []).unwrap();
        conn.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,execution_generation,lifecycle,pane_order,revision,created_at) VALUES('t','p','t','device',1,'active','[]',1,0)", []).unwrap();
        conn.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision) VALUES('t','device',?1,1)", [data_dir.to_string_lossy().as_ref()]).unwrap();
        drop(conn);

        let manager = TerminalManager::new(Arc::new(RecordingEvents::default()));
        let mut start = request("route-test", "exit 0");
        start.task_id = Some("t".into());
        start.execution_generation = Some(1);
        manager.create_for_task(&data_dir, start).unwrap();
        for _ in 0..80 {
            let conn = crate::config::connection_at(&db_path).unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM terminal_task_sessions WHERE session_id='route-test'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if count == 0 {
                let _ = std::fs::remove_dir_all(&data_dir);
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        manager.kill("route-test").unwrap();
        let _ = std::fs::remove_dir_all(&data_dir);
        panic!("terminal task route was not removed after process exit");
    }
}
