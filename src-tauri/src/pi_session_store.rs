//! Durable, append-only Pi transcript storage.
//!
//! Streaming updates intentionally never enter this store: only completed records are useful
//! after reconnect and a half-written JSONL line must not erase the completed prefix.

use crate::config;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::Path};

/// Creates the local transcript and conflict tables.
pub fn migrate(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS pi_session_records (
      network_id TEXT NOT NULL, task_id TEXT NOT NULL, pane_id TEXT NOT NULL,
      execution_generation INTEGER NOT NULL, session_id TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', source_sequence INTEGER NOT NULL,
      stable_id TEXT NOT NULL, parent_id TEXT, tool_call_id TEXT, record_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY(network_id, stable_id), UNIQUE(task_id,pane_id,execution_generation,session_id,source_id,source_sequence)
    );
    CREATE TABLE IF NOT EXISTS pi_session_attachments (
      network_id TEXT NOT NULL, stable_id TEXT NOT NULL, attachment_id TEXT NOT NULL, reference_json TEXT NOT NULL,
      PRIMARY KEY(network_id, stable_id, attachment_id)
    );
    CREATE TABLE IF NOT EXISTS pi_session_conflicts (
      id INTEGER PRIMARY KEY, network_id TEXT NOT NULL, stable_id TEXT NOT NULL,
      original_json TEXT NOT NULL, divergent_json TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS pi_history_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, network_id TEXT NOT NULL, stable_id TEXT NOT NULL,
      source_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS pi_history_deliveries (
      outbox_id TEXT NOT NULL, peer_id TEXT NOT NULL, acknowledged_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY(outbox_id, peer_id)
    );
    CREATE INDEX IF NOT EXISTS pi_session_records_scope_idx
      ON pi_session_records(network_id, task_id, pane_id, execution_generation, session_id, source_id, source_sequence);
    CREATE INDEX IF NOT EXISTS pi_history_cursors_network_idx
      ON pi_history_cursors(network_id, id);")?;
    // Existing local databases predate source identity; SQLite has no conditional ADD COLUMN.
    let _ = conn.execute(
        "ALTER TABLE pi_session_records ADD COLUMN source_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    Ok(())
}

fn network_id(conn: &rusqlite::Connection, task_id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT p.network_id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1",
        params![task_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .or_else(|| {
        conn.query_row(
            "SELECT network_id FROM pi_session_records WHERE task_id=?1 LIMIT 1",
            [task_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    })
    .ok_or_else(|| format!("unknown history task: {task_id}"))
}

fn completed(event: &Value) -> bool {
    // Pi's JSONL contains `session`/`session_info` alongside messages. They are durable context,
    // not stream deltas, so retain them too. Everything else is either a live update or unknown.
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("session" | "session_info" | "message" | "message_end" | "tool_execution_end")
    )
}

fn relationship(event: &Value) -> (Option<String>, Option<String>) {
    let message = event.get("message");
    let parent = event
        .get("parentId")
        .or_else(|| message.and_then(|v| v.get("parentId")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool = event
        .get("toolCallId")
        .or_else(|| message.and_then(|v| v.get("toolCallId")))
        .and_then(Value::as_str)
        .map(str::to_string);
    (parent, tool)
}

fn attachments(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                attachments(item, out)
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("image") {
                // Keep the original reference (including data/mime type); it is required to render offline.
                out.push(Value::Object(object.clone()));
            }
            for child in object.values() {
                attachments(child, out)
            }
        }
        _ => {}
    }
}

/// Appends one completed executor event, deduplicating its stable id and preserving divergence.
/// `session_id` is the one authoritative identity for this record: it is the Pi session file
/// supplied to the process (or the explicit `default` identity for a new unsaved session).
pub fn record(
    data_dir: &Path,
    task_id: &str,
    pane_id: &str,
    generation: i64,
    session_id: &str,
    event: &Value,
) -> Result<(), String> {
    record_at_sequence(
        data_dir, task_id, pane_id, generation, session_id, None, event,
    )
}

fn record_at_sequence(
    data_dir: &Path,
    task_id: &str,
    pane_id: &str,
    generation: i64,
    session_id: &str,
    requested_sequence: Option<i64>,
    event: &Value,
) -> Result<(), String> {
    if !completed(event) {
        return Ok(());
    }
    if session_id.trim().is_empty() {
        return Err("pi history requires a session identity".to_string());
    }
    let mut conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let network_id = network_id(&conn, task_id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let source_id: String = tx
        .query_row(
            "SELECT assigned_device_id FROM tasks WHERE id=?1",
            params![task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let encoded = event.to_string();
    let sequence: i64 = match requested_sequence {
        Some(sequence) => sequence,
        None => tx
            .query_row("SELECT COALESCE(MAX(source_sequence),0)+1 FROM pi_session_records WHERE network_id=?1 AND task_id=?2 AND pane_id=?3 AND execution_generation=?4 AND session_id=?5 AND source_id=?6", params![network_id,task_id,pane_id,generation,session_id,source_id], |r| r.get(0))
            .map_err(|e| e.to_string())?,
    };
    let explicit = event
        .pointer("/message/id")
        .or_else(|| event.get("toolCallId"))
        .and_then(Value::as_str);
    // Pi IDs are only source-local. Prefixing them keeps partitioned executors' records
    // inspectable rather than treating distinct branches as a last-writer-wins collision.
    let stable_id = explicit
        .map(|id| format!("{source_id}:{session_id}:{id}"))
        .unwrap_or_else(|| {
            format!("{source_id}:{task_id}:{pane_id}:{generation}:{session_id}:{sequence}")
        });
    let existing: Option<String> = tx
        .query_row(
            "SELECT record_json FROM pi_session_records WHERE network_id=?1 AND stable_id=?2",
            params![network_id, stable_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(original) = existing {
        if original != encoded {
            tx.execute("INSERT INTO pi_session_conflicts(network_id,stable_id,original_json,divergent_json) VALUES(?1,?2,?3,?4)", params![network_id,stable_id,original,encoded]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let (parent, tool) = relationship(event);
    tx.execute("INSERT INTO pi_session_records(network_id,task_id,pane_id,execution_generation,session_id,source_id,source_sequence,stable_id,parent_id,tool_call_id,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![network_id,task_id,pane_id,generation,session_id,source_id,sequence,stable_id,parent,tool,encoded]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO pi_history_cursors(network_id,stable_id,source_id,source_sequence) VALUES(?1,?2,?3,?4)", params![network_id,stable_id,source_id,sequence]).map_err(|e| e.to_string())?;
    let mut refs = Vec::new();
    attachments(event, &mut refs);
    for (index, reference) in refs.into_iter().enumerate() {
        tx.execute("INSERT INTO pi_session_attachments(network_id,stable_id,attachment_id,reference_json) VALUES(?1,?2,?3,?4)", params![network_id,stable_id,format!("{stable_id}:image:{index}"),reference.to_string()]).map_err(|e| e.to_string())?;
    }
    // The row and publication intent commit together. A connector retry can safely deduplicate
    // this by stable ID; it must never replace a JSONL/session file wholesale.
    tx.execute(
        "INSERT INTO transactional_outbox(id,topic,payload_json,created_at) VALUES(?1,'pi.history',?2,strftime('%s','now')) ON CONFLICT(id) DO NOTHING",
            params![format!("pi-history:{network_id}:{stable_id}"), json!({"networkId":network_id,"taskId":task_id,"paneId":pane_id,"executionGeneration":generation,"sessionId":session_id,"sourceId":source_id,"sequence":sequence,"stableId":stable_id,"event":event}).to_string()],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Imports every complete JSONL record. Only an unterminated malformed final line can be an
/// in-progress writer tail; malformed complete lines are reported instead of silently losing data.
pub fn import_jsonl(
    data_dir: &Path,
    task_id: &str,
    pane_id: &str,
    generation: i64,
    path: &Path,
) -> Result<(), String> {
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    for (index, fragment) in contents.split_inclusive('\n').enumerate() {
        let line = fragment
            .strip_suffix('\n')
            .unwrap_or(fragment)
            .trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let is_unterminated_tail =
            !fragment.ends_with('\n') && index + 1 == contents.split_inclusive('\n').count();
        match serde_json::from_str::<Value>(line) {
            Ok(value) => record_at_sequence(
                data_dir,
                task_id,
                pane_id,
                generation,
                &path.to_string_lossy(),
                Some((index + 1) as i64),
                &value,
            )?,
            Err(_) if is_unterminated_tail => break,
            Err(error) => return Err(format!("invalid complete JSONL record: {error}")),
        }
    }
    Ok(())
}

/// Returns a snapshot followed by records after `cursor`; callers must resnapshot on cursor expiry.
#[allow(dead_code)] // Compatibility entrypoint; connector paths use the session-scoped variant.
pub fn history(
    data_dir: &Path,
    task_id: &str,
    pane_id: &str,
    generation: i64,
    cursor: Option<i64>,
) -> Result<Value, String> {
    history_for_session(data_dir, task_id, pane_id, generation, None, cursor)
}

/// Returns history for one session identity. Keeping the filter in the store prevents a peer or
/// connector from receiving another session's records and relying on a renderer-side filter.
pub fn history_for_session(
    data_dir: &Path,
    task_id: &str,
    pane_id: &str,
    generation: i64,
    session_id: Option<&str>,
    cursor: Option<i64>,
) -> Result<Value, String> {
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let network = network_id(&conn, task_id)?;
    let max: i64 = conn.query_row("SELECT COALESCE(MAX(source_sequence),0) FROM pi_session_records WHERE network_id=?1 AND task_id=?2 AND pane_id=?3 AND execution_generation=?4 AND (?5 IS NULL OR session_id=?5)", params![network,task_id,pane_id,generation,session_id], |r| r.get(0)).map_err(|e|e.to_string())?;
    let after = cursor.unwrap_or(0);
    if after > max {
        return Ok(
            json!({"status":"cursor_expired","networkId":network,"cursor":max,"records":[]}),
        );
    }
    let mut statement = conn.prepare("SELECT stable_id,source_id,source_sequence,session_id,record_json FROM pi_session_records WHERE network_id=?1 AND task_id=?2 AND pane_id=?3 AND execution_generation=?4 AND source_sequence>?5 AND (?6 IS NULL OR session_id=?6) ORDER BY source_sequence, stable_id").map_err(|e|e.to_string())?;
    let records = statement.query_map(params![network,task_id,pane_id,generation,after,session_id], |row| Ok(json!({"id":row.get::<_,String>(0)?,"sourceId":row.get::<_,String>(1)?,"sequence":row.get::<_,i64>(2)?,"sessionId":row.get::<_,String>(3)?,"event":serde_json::from_str::<Value>(&row.get::<_,String>(4)?).unwrap_or(Value::Null)}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"status":"synced","networkId":network,"cursor":max,"records":records}))
}

/// Local-cache connector protocol. Cursors are opaque database positions, not source sequences:
/// source streams can be interleaved without making one source's gap hide another's records.
fn cursor(value: i64) -> String {
    format!("pi-history-v1:{value}")
}
fn parse_cursor(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_str)
        .and_then(|v| v.strip_prefix("pi-history-v1:"))
        .and_then(|v| v.parse().ok())
}

pub fn sync_snapshot(data_dir: &Path, network: &str) -> Result<Value, String> {
    sync_changes(data_dir, network, None)
}

/// Session-scoped snapshot for callers that already know the canonical Pi session identity.
#[allow(dead_code)] // Kept for clients that request an explicit session snapshot.
pub fn sync_snapshot_for_session(
    data_dir: &Path,
    network: &str,
    session_id: &str,
) -> Result<Value, String> {
    sync_changes_for_session(data_dir, network, None, Some(session_id))
}

pub fn sync_changes(
    data_dir: &Path,
    network: &str,
    opaque: Option<&Value>,
) -> Result<Value, String> {
    sync_changes_for_session(data_dir, network, opaque, None)
}

/// Returns replicated records, optionally restricted to one canonical session identity.
pub fn sync_changes_for_session(
    data_dir: &Path,
    network: &str,
    opaque: Option<&Value>,
    session_id: Option<&str>,
) -> Result<Value, String> {
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let after = match opaque {
        None | Some(Value::Null) => 0,
        Some(_) => {
            parse_cursor(opaque).ok_or_else(|| json!({"code":"cursor_expired"}).to_string())?
        }
    };
    let max: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(c.id),0) FROM pi_history_cursors c JOIN pi_session_records r ON r.network_id=c.network_id AND r.stable_id=c.stable_id WHERE c.network_id=?1 AND (?2 IS NULL OR r.session_id=?2)",
            params![network, session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // A retained cursor whose row disappeared means vacuum/retention or a rebuilt source cache.
    if after > 0
        && !conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pi_history_cursors c JOIN pi_session_records r ON r.network_id=c.network_id AND r.stable_id=c.stable_id WHERE c.network_id=?1 AND c.id=?2 AND (?3 IS NULL OR r.session_id=?3))",
                params![network, after, session_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
    {
        return Ok(json!({"code":"cursor_expired","cursor":cursor(max),"records":[]}));
    }
    let mut statement = conn.prepare("SELECT c.id,r.task_id,r.pane_id,r.execution_generation,r.session_id,r.source_id,r.source_sequence,r.stable_id,r.record_json FROM pi_history_cursors c JOIN pi_session_records r ON r.network_id=c.network_id AND r.stable_id=c.stable_id WHERE c.network_id=?1 AND c.id>?2 AND (?3 IS NULL OR r.session_id=?3) ORDER BY c.id").map_err(|e| e.to_string())?;
    let records = statement.query_map(params![network, after, session_id], |r| Ok(json!({"taskId":r.get::<_,String>(1)?,"paneId":r.get::<_,String>(2)?,"executionGeneration":r.get::<_,i64>(3)?,"sessionId":r.get::<_,String>(4)?,"sourceId":r.get::<_,String>(5)?,"sequence":r.get::<_,i64>(6)?,"stableId":r.get::<_,String>(7)?,"event":serde_json::from_str::<Value>(&r.get::<_,String>(8)?).unwrap_or(Value::Null)}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    Ok(json!({"status":"synced","networkId":network,"cursor":cursor(max),"records":records}))
}

/// Applies independently replayable records. Existing IDs are immutable; a different body is a
/// durable conflict rather than a remote overwrite.
pub fn sync_apply(data_dir: &Path, network: &str, records: &[Value]) -> Result<Value, String> {
    let mut conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut applied = 0;
    for record in records {
        let stable = record
            .get("stableId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing stableId".to_string())?;
        let task = record
            .get("taskId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing taskId".to_string())?;
        let pane = record
            .get("paneId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing paneId".to_string())?;
        let generation = record
            .get("executionGeneration")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing executionGeneration".to_string())?;
        let authorized: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id JOIN task_panes q ON q.task_id=t.id WHERE p.network_id=?1 AND t.id=?2 AND q.id=?3)",
                params![network, task, pane],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !authorized {
            return Err("history_scope_mismatch".to_string());
        }
        let event = record
            .get("event")
            .cloned()
            .ok_or_else(|| "missing event".to_string())?;
        let encoded = event.to_string();
        let old: Option<String> = tx
            .query_row(
                "SELECT record_json FROM pi_session_records WHERE network_id=?1 AND stable_id=?2",
                params![network, stable],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            if old != encoded {
                tx.execute("INSERT INTO pi_session_conflicts(network_id,stable_id,original_json,divergent_json) VALUES(?1,?2,?3,?4)",params![network,stable,old,encoded]).map_err(|e|e.to_string())?;
            }
            continue;
        }
        let session = record
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "missing sessionId".to_string())?;
        let source = record
            .get("sourceId")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing sourceId".to_string())?;
        let sequence = record
            .get("sequence")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing sequence".to_string())?;
        let (parent, tool) = relationship(&event);
        tx.execute("INSERT INTO pi_session_records(network_id,task_id,pane_id,execution_generation,session_id,source_id,source_sequence,stable_id,parent_id,tool_call_id,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![network,task,pane,generation,session,source,sequence,stable,parent,tool,encoded]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO pi_history_cursors(network_id,stable_id,source_id,source_sequence) VALUES(?1,?2,?3,?4)",params![network,stable,source,sequence]).map_err(|e|e.to_string())?;
        applied += 1;
    }
    let latest: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(id),0) FROM pi_history_cursors WHERE network_id=?1",
            [network],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"ok":true,"applied":applied,"cursor":cursor(latest)}))
}

pub fn sync_conflicts(data_dir: &Path, network: &str) -> Result<Value, String> {
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut q = conn.prepare("SELECT stable_id,original_json,divergent_json FROM pi_session_conflicts WHERE network_id=?1 ORDER BY id").map_err(|e|e.to_string())?;
    let conflicts = q.query_map([network], |r| Ok(json!({"stableId":r.get::<_,String>(0)?,"original":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(Value::Null),"divergent":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null)}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"conflicts":conflicts}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_tail_keeps_prefix() {
        let d = std::env::temp_dir().join("swath-pi-history-tail");
        let _ = fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let db = config::db_path_in(&d).unwrap();
        let c = config::connection_at(&db).unwrap();
        c.execute("INSERT INTO projects(id,network_id,name,default_branch,task_order,revision,created_at) VALUES('p','n','p','main','[]',1,0)",[]).unwrap();
        c.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,pane_order,revision,created_at) VALUES('t','p','t','d','active','[]',1,0)",[]).unwrap();
        let f = d.join("x.jsonl");
        fs::write(
            &f,
            "{\"type\":\"message_end\",\"message\":{\"role\":\"user\",\"content\":\"ok\"}}\n{bad",
        )
        .unwrap();
        import_jsonl(&d, "t", "pane", 1, &f).unwrap();
        assert_eq!(
            history(&d, "t", "pane", 1, None).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::write(&f, "{bad}\n").unwrap();
        assert!(import_jsonl(&d, "t", "pane", 1, &f).is_err());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn identity_filters_history_and_identical_events_do_not_collapse() {
        let d = std::env::temp_dir().join(format!("swath-pi-identity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let db = config::db_path_in(&d).unwrap();
        let connection = config::connection_at(&db).unwrap();
        connection
            .execute_batch(
                "INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','n',2,1,0);
                 INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('d','n','d','d','test','local-device',1,0);
                 INSERT INTO projects(id,network_id,name,default_branch,task_order,revision,created_at) VALUES('project','n','project','main','[]',1,0);
                 INSERT INTO tasks(id,project_id,title,assigned_device_id,execution_generation,lifecycle,pane_order,revision,created_at) VALUES('t','project','task','d',1,'active','[\"p\"]',1,0);
                 INSERT INTO task_panes(id,task_id,kind,title,revision,created_at) VALUES('p','t','piAgent','Pi',1,0);",
            )
            .unwrap();
        let event = json!({"type":"message_end","message":{"role":"user","content":"same"}});
        record(&d, "t", "p", 1, "session-a", &event).unwrap();
        record(&d, "t", "p", 1, "session-a", &event).unwrap();
        record(&d, "t", "p", 1, "session-b", &event).unwrap();
        let a = history_for_session(&d, "t", "p", 1, Some("session-a"), None).unwrap();
        assert_eq!(a["records"].as_array().unwrap().len(), 2);
        assert!(a["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["sessionId"] == "session-a"));
        let b = sync_changes_for_session(&d, "n", None, Some("session-b")).unwrap();
        assert_eq!(b["records"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn imported_line_numbers_make_retries_idempotent_without_body_dedupe() {
        let d = std::env::temp_dir().join(format!("swath-pi-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let db = config::db_path_in(&d).unwrap();
        let connection = config::connection_at(&db).unwrap();
        connection
            .execute("INSERT INTO projects(id,network_id,name,default_branch,task_order,revision,created_at) VALUES('p','n','p','main','[]',1,0)", [])
            .unwrap();
        connection
            .execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,pane_order,revision,created_at) VALUES('t','p','t','d','active','[]',1,0)", [])
            .unwrap();
        let path = d.join("same.jsonl");
        fs::write(&path, "{\"type\":\"message_end\",\"message\":{\"content\":\"same\"}}\n{\"type\":\"message_end\",\"message\":{\"content\":\"same\"}}\n").unwrap();
        import_jsonl(&d, "t", "pane", 1, &path).unwrap();
        import_jsonl(&d, "t", "pane", 1, &path).unwrap();
        assert_eq!(
            history(&d, "t", "pane", 1, None).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn apply_is_idempotent_and_retains_divergence() {
        let d = std::env::temp_dir().join(format!("swath-pi-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let db = config::db_path_in(&d).unwrap();
        let connection = config::connection_at(&db).unwrap();
        connection.execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','n',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('d','n','d','d','test','local-device',1,0); INSERT INTO projects(id,network_id,name,default_branch,task_order,revision,created_at) VALUES('project','n','project','main','[]',1,0); INSERT INTO tasks(id,project_id,title,assigned_device_id,execution_generation,lifecycle,pane_order,revision,created_at) VALUES('t','project','task','d',1,'active','[\"p\"]',1,0); INSERT INTO task_panes(id,task_id,kind,title,revision,created_at) VALUES('p','t','piAgent','Pi',1,0);").unwrap();
        let record = json!({"taskId":"t","paneId":"p","executionGeneration":1,"sessionId":"s","sourceId":"a","sequence":1,"stableId":"a:one","event":{"type":"message_end","message":{"content":"one"}}});
        assert_eq!(
            sync_apply(&d, "n", std::slice::from_ref(&record)).unwrap()["applied"],
            1
        );
        assert_eq!(
            sync_apply(&d, "n", std::slice::from_ref(&record)).unwrap()["applied"],
            0
        );
        let changed = json!({"taskId":"t","paneId":"p","executionGeneration":1,"sessionId":"s","sourceId":"a","sequence":1,"stableId":"a:one","event":{"type":"message_end","message":{"content":"two"}}});
        sync_apply(&d, "n", &[changed]).unwrap();
        assert_eq!(
            sync_conflicts(&d, "n").unwrap()["conflicts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let snapshot = sync_snapshot(&d, "n").unwrap();
        assert_eq!(snapshot["records"].as_array().unwrap().len(), 1);
        assert_eq!(
            sync_changes(&d, "n", snapshot.get("cursor")).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let _ = fs::remove_dir_all(d);
    }
}
