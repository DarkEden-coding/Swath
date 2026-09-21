use anyhow::{anyhow, Result};
#[cfg(test)]
use rusqlite::params;
use rusqlite::{Connection, OptionalExtension};

const TASK_STORE_SCHEMA_VERSION: i64 = 2;

/// Creates and migrates the project/task catalog, tombstone, dedupe, and outbox tables.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY, network_id TEXT NOT NULL, name TEXT NOT NULL,
           repository_source TEXT, default_branch TEXT NOT NULL, task_order TEXT NOT NULL DEFAULT '[]',
           revision INTEGER NOT NULL, created_at INTEGER NOT NULL, tombstoned_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS tasks (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
           assigned_device_id TEXT NOT NULL, execution_generation INTEGER NOT NULL DEFAULT 1,
           lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'completed')), pane_order TEXT NOT NULL DEFAULT '[]',
           revision INTEGER NOT NULL, created_at INTEGER NOT NULL, tombstoned_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS task_panes (
           id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
           title TEXT, session_id TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
           tombstoned_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), pane_id TEXT NOT NULL REFERENCES task_panes(id),
           executor_generation INTEGER NOT NULL, source_ref TEXT, revision INTEGER NOT NULL,
           created_at INTEGER NOT NULL, tombstoned_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS device_task_paths (
           task_id TEXT NOT NULL REFERENCES tasks(id), device_id TEXT NOT NULL,
           path TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id, device_id)
         );
         CREATE TABLE IF NOT EXISTS operation_dedup (
           operation_id TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, request_hash TEXT NOT NULL,
           result_json TEXT NOT NULL, created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS tombstones (
           record_type TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
           deleted_at INTEGER NOT NULL, PRIMARY KEY(record_type, record_id)
         );
         CREATE TABLE IF NOT EXISTS transactional_outbox (
           id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL,
           created_at INTEGER NOT NULL, published_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS task_provisioning (
           task_id TEXT PRIMARY KEY REFERENCES tasks(id), base_commit TEXT NOT NULL,
           worktree_path TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','failed')),
           last_error TEXT, created_at INTEGER NOT NULL, ready_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS pi_prompt_operations (
           operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
           pane_id TEXT NOT NULL, execution_generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('accepted','dispatched','completed','uncertain')),
           result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
         );
         -- Session IDs are capability-free routing keys.  Persist their owner so a
         -- reconnecting viewer never guesses that its local runtime owns a shell.
         CREATE TABLE IF NOT EXISTS terminal_task_sessions (
           session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
           device_id TEXT NOT NULL, execution_generation INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_activity (
           task_id TEXT PRIMARY KEY REFERENCES tasks(id), sequence INTEGER NOT NULL DEFAULT 0,
           kind TEXT NOT NULL, occurred_at INTEGER NOT NULL
         );
         -- Keep completion, activity, and workspace availability independent. The legacy
         -- tasks.lifecycle column remains a compatibility projection for older clients.
         CREATE TABLE IF NOT EXISTS task_lifecycle (
           task_id TEXT PRIMARY KEY REFERENCES tasks(id),
           activity_state TEXT NOT NULL DEFAULT 'active' CHECK(activity_state IN ('active','inactive','hidden')),
           completion_state TEXT NOT NULL DEFAULT 'open' CHECK(completion_state IN ('open','completed')),
           workspace_state TEXT NOT NULL DEFAULT 'present' CHECK(workspace_state IN ('present','frozen','cleaned','restoring')),
           last_activity_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, cleaned_at INTEGER,
           revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TRIGGER IF NOT EXISTS task_lifecycle_after_insert
           AFTER INSERT ON tasks BEGIN
             INSERT OR IGNORE INTO task_lifecycle(task_id,activity_state,completion_state,last_activity_at,completed_at,revision,updated_at)
             VALUES(NEW.id,CASE WHEN NEW.lifecycle='active' THEN 'active' ELSE 'inactive' END,
               CASE WHEN NEW.lifecycle='completed' THEN 'completed' ELSE 'open' END,NEW.created_at,
               CASE WHEN NEW.lifecycle='completed' THEN NEW.created_at ELSE NULL END,NEW.revision,NEW.created_at);
           END;
         CREATE TRIGGER IF NOT EXISTS task_lifecycle_after_update
           AFTER UPDATE OF lifecycle,revision ON tasks BEGIN
             UPDATE task_lifecycle SET
               activity_state=CASE WHEN NEW.lifecycle='active' THEN 'active' ELSE 'inactive' END,
               completion_state=CASE WHEN NEW.lifecycle='completed' THEN 'completed' ELSE 'open' END,
               completed_at=CASE WHEN NEW.lifecycle='completed' THEN COALESCE(completed_at,strftime('%s','now')) ELSE NULL END,
               revision=NEW.revision,updated_at=strftime('%s','now')
             WHERE task_id=NEW.id;
           END;
         CREATE TABLE IF NOT EXISTS task_operations (
           operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
           phase TEXT NOT NULL, source_device_id TEXT, destination_device_id TEXT, generation INTEGER NOT NULL,
           source_path TEXT, destination_path TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}',
           report_json TEXT NOT NULL DEFAULT '{}', last_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS task_cleanup_receipts (
           task_id TEXT PRIMARY KEY REFERENCES tasks(id), retained_commit TEXT, known_losses_json TEXT NOT NULL DEFAULT '[]',
           result_json TEXT NOT NULL DEFAULT '{}', cleaned_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS task_replica_receipts (
           task_id TEXT NOT NULL REFERENCES tasks(id), device_id TEXT NOT NULL,
           retained_commit TEXT NOT NULL, verified_at INTEGER NOT NULL,
           PRIMARY KEY(task_id, device_id, retained_commit)
         );
         -- Preview targets are capability grants, never arbitrary URLs.
         CREATE TABLE IF NOT EXISTS task_preview_ports (
           task_id TEXT NOT NULL REFERENCES tasks(id), port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
           PRIMARY KEY(task_id, port)
         );
         -- Browser reconnect cursors address this append-only event log.  Live terminal bytes are
         -- intentionally excluded: terminal replay has its own bounded PTY buffer.
         CREATE TABLE IF NOT EXISTS browser_event_log (
           sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
           channel TEXT NOT NULL, payload_json TEXT NOT NULL,
           created_at INTEGER NOT NULL DEFAULT(strftime('%s','now'))
         );
         CREATE INDEX IF NOT EXISTS browser_event_log_task_sequence ON browser_event_log(task_id, sequence);
         CREATE TABLE IF NOT EXISTS browser_event_acks (
           client_id TEXT NOT NULL, cursor INTEGER NOT NULL,
           acknowledged_at INTEGER NOT NULL DEFAULT(strftime('%s','now')),
           PRIMARY KEY(client_id)
         );
         CREATE TABLE IF NOT EXISTS task_store_schema (
           singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL
         );",
    )?;
    migrate_columns(conn)?;
    migrate_lifecycle_rows(conn)?;
    migrate_local_paths(conn)?;
    create_indexes(conn)?;
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM task_store_schema WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(version) = version {
        if version > TASK_STORE_SCHEMA_VERSION {
            return Err(anyhow!("unsupported task-store schema version {version}; install a compatible Swath version or restore a backup"));
        }
    }
    conn.execute("INSERT INTO task_store_schema(singleton,version) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version", [TASK_STORE_SCHEMA_VERSION])?;
    Ok(())
}

fn migrate_columns(conn: &Connection) -> Result<()> {
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(device_task_paths)")?
        .query_map([], |row| row.get(1))?
        .collect::<std::result::Result<_, _>>()?;
    if !columns.iter().any(|column| column == "generation") {
        conn.execute(
            "ALTER TABLE device_task_paths ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "updated_at") {
        conn.execute(
            "ALTER TABLE device_task_paths ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn migrate_lifecycle_rows(conn: &Connection) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO task_lifecycle(task_id,activity_state,completion_state,workspace_state,last_activity_at,completed_at,revision,updated_at) SELECT id,CASE WHEN lifecycle='active' THEN 'active' ELSE 'inactive' END,CASE WHEN lifecycle='completed' THEN 'completed' ELSE 'open' END,'present',created_at,CASE WHEN lifecycle='completed' THEN created_at ELSE NULL END,revision,created_at FROM tasks", [])?;
    Ok(())
}

/// Provisioning paths are local executor state. Only repair a path for this database's stable
/// local identity; remote task paths must never be inferred from shared rows.
fn migrate_local_paths(conn: &Connection) -> Result<()> {
    let has_identity: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_device_identity')", [], |row| row.get(0))?;
    if !has_identity {
        return Ok(());
    }
    conn.execute("DELETE FROM device_task_paths WHERE device_id != (SELECT id FROM local_device_identity WHERE singleton=1)", [])?;
    conn.execute("INSERT OR IGNORE INTO device_task_paths(task_id,device_id,path,revision,generation,updated_at) SELECT t.id,t.assigned_device_id,q.worktree_path,1,t.execution_generation,COALESCE(q.ready_at,q.created_at) FROM tasks t JOIN task_provisioning q ON q.task_id=t.id JOIN local_device_identity local ON local.singleton=1 AND local.id=t.assigned_device_id WHERE q.worktree_path IS NOT NULL AND q.worktree_path != ''", [])?;
    Ok(())
}

fn create_indexes(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE INDEX IF NOT EXISTS tasks_project_lifecycle ON tasks(project_id,lifecycle,tombstoned_at,created_at); CREATE INDEX IF NOT EXISTS task_panes_task_live ON task_panes(task_id,tombstoned_at,created_at); CREATE INDEX IF NOT EXISTS sessions_task_generation ON sessions(task_id,executor_generation,tombstoned_at); CREATE INDEX IF NOT EXISTS device_task_paths_device_task ON device_task_paths(device_id,task_id); CREATE INDEX IF NOT EXISTS operation_dedup_created ON operation_dedup(created_at); CREATE INDEX IF NOT EXISTS transactional_outbox_pending ON transactional_outbox(published_at,created_at); CREATE INDEX IF NOT EXISTS task_provisioning_state ON task_provisioning(state,created_at); CREATE INDEX IF NOT EXISTS task_lifecycle_activity ON task_lifecycle(activity_state,last_activity_at); CREATE INDEX IF NOT EXISTS task_operations_task_phase ON task_operations(task_id,phase,updated_at); CREATE INDEX IF NOT EXISTS task_replica_receipts_commit ON task_replica_receipts(task_id,retained_commit,verified_at);")?;
    Ok(())
}

/// Read the immutable local identity, without hostname or assigned-task heuristics.
#[allow(dead_code)]
pub fn local_device_id(conn: &Connection) -> Result<Option<String>> {
    let has_identity: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_device_identity')", [], |row| row.get(0))?;
    if !has_identity {
        return Ok(None);
    }
    conn.query_row(
        "SELECT id FROM local_device_identity WHERE singleton=1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

#[allow(dead_code)]
pub fn local_task_path(conn: &Connection, task_id: &str) -> Result<Option<String>> {
    let Some(device_id) = local_device_id(conn)? else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT path FROM device_task_paths WHERE task_id=?1 AND device_id=?2",
        rusqlite::params![task_id, device_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

#[allow(dead_code)]
pub fn upsert_local_task_path(
    conn: &Connection,
    task_id: &str,
    path: &str,
    revision: i64,
    generation: i64,
    updated_at: i64,
) -> Result<()> {
    let device_id = local_device_id(conn)?
        .ok_or_else(|| anyhow!("local device identity is not initialized"))?;
    if path.trim().is_empty() {
        return Err(anyhow!("task path must not be empty"));
    }
    conn.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision,generation,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(task_id,device_id) DO UPDATE SET path=excluded.path,revision=excluded.revision,generation=excluded.generation,updated_at=excluded.updated_at", rusqlite::params![task_id,device_id,path,revision,generation,updated_at])?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    fn seed_task(conn: &Connection, task: &str, device: &str, lifecycle: &str) {
        conn.execute("INSERT OR IGNORE INTO projects(id,network_id,name,default_branch,revision,created_at) VALUES('project','network','Project','main',1,10)", []).unwrap();
        conn.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,revision,created_at) VALUES(?1,'project','Task',?2,?3,1,20)", rusqlite::params![task,device,lifecycle]).unwrap();
    }

    #[test]
    fn migration_is_idempotent_and_records_version() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT version FROM task_store_schema WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            TASK_STORE_SCHEMA_VERSION
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='device_task_paths_device_task'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    }

    #[test]
    fn lifecycle_dimensions_allow_completed_but_cleaned_workspace() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        seed_task(&conn, "task", "device", "completed");
        migrate(&conn).unwrap();
        conn.execute("UPDATE task_lifecycle SET activity_state='inactive',completion_state='completed',workspace_state='cleaned',completed_at=30,cleaned_at=40 WHERE task_id='task'", []).unwrap();
        let state: (String,String,String) = conn.query_row("SELECT activity_state,completion_state,workspace_state FROM task_lifecycle WHERE task_id='task'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(
            state,
            ("inactive".into(), "completed".into(), "cleaned".into())
        );
        assert!(conn
            .execute(
                "UPDATE task_lifecycle SET workspace_state='invalid' WHERE task_id='task'",
                []
            )
            .is_err());
    }

    #[test]
    fn path_repair_is_scoped_to_local_device() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute("CREATE TABLE local_device_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL UNIQUE)", []).unwrap();
        conn.execute(
            "INSERT INTO local_device_identity(singleton,id) VALUES(1,'local')",
            [],
        )
        .unwrap();
        seed_task(&conn, "local-task", "local", "active");
        seed_task(&conn, "remote-task", "remote", "active");
        for task in ["local-task", "remote-task"] {
            conn.execute("INSERT INTO task_provisioning(task_id,base_commit,worktree_path,state,created_at) VALUES(?1,'base',?2,'ready',25)", rusqlite::params![task,format!("/work/{task}")]).unwrap();
        }
        migrate(&conn).unwrap();
        assert_eq!(local_device_id(&conn).unwrap().as_deref(), Some("local"));
        assert_eq!(
            local_task_path(&conn, "local-task").unwrap().as_deref(),
            Some("/work/local-task")
        );
        assert_eq!(local_task_path(&conn, "remote-task").unwrap(), None);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM device_task_paths", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        upsert_local_task_path(&conn, "local-task", "/work/new", 2, 3, 50).unwrap();
        assert_eq!(
            local_task_path(&conn, "local-task").unwrap().as_deref(),
            Some("/work/new")
        );
        assert!(upsert_local_task_path(&conn, "local-task", "", 3, 4, 60).is_err());
    }

    #[test]
    fn legacy_path_table_gets_generation_and_updated_at_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY,network_id TEXT NOT NULL,name TEXT NOT NULL,default_branch TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
             CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,assigned_device_id TEXT NOT NULL,lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','completed')),revision INTEGER NOT NULL,created_at INTEGER NOT NULL,tombstoned_at INTEGER);
             CREATE TABLE device_task_paths(task_id TEXT NOT NULL,device_id TEXT NOT NULL,path TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(task_id,device_id));
             INSERT INTO projects VALUES('p','n','P','main',1,1);
             INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,revision,created_at) VALUES('t','p','T','d','active',1,1);
             INSERT INTO device_task_paths VALUES('t','d','/tmp/t',1);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(device_task_paths)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "generation"));
        assert!(columns.iter().any(|column| column == "updated_at"));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM task_lifecycle", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

/// Test helper for verifying durable operation-ID conflict detection.
#[cfg(test)]
pub fn record_operation(
    conn: &Connection,
    operation_id: &str,
    kind: &str,
    request_hash: &str,
    result_json: &str,
) -> Result<()> {
    let changed = conn.execute(
        "INSERT INTO operation_dedup (operation_id, operation_kind, request_hash, result_json, created_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s','now')) ON CONFLICT(operation_id) DO NOTHING",
        params![operation_id, kind, request_hash, result_json],
    )?;
    if changed == 0 {
        let stored: (String, String) = conn.query_row(
            "SELECT operation_kind, request_hash FROM operation_dedup WHERE operation_id = ?1",
            params![operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if stored.0 != kind || stored.1 != request_hash {
            return Err(anyhow!(
                "operation ID {operation_id} was already used for a different request"
            ));
        }
    }
    Ok(())
}
