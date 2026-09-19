#[cfg(test)]
use anyhow::anyhow;
use anyhow::Result;
#[cfg(test)]
use rusqlite::params;
use rusqlite::Connection;

/// Creates the version-one project/task catalog, tombstone, dedupe, and outbox tables.
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
           path TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(task_id, device_id)
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
         );",
    )?;
    // Repair catalogs created before provisioning projected executor-local paths. Imported tasks
    // and already-ready tasks both retain the authoritative path in task_provisioning.
    conn.execute_batch("INSERT OR IGNORE INTO device_task_paths(task_id,device_id,path,revision) SELECT t.id,t.assigned_device_id,q.worktree_path,1 FROM tasks t JOIN task_provisioning q ON q.task_id=t.id WHERE q.worktree_path IS NOT NULL AND q.worktree_path != '';")?;
    Ok(())
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
