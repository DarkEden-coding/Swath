//! Durable OpenRaft catalog core. Transport adapters may mount the three public RPC handlers.
#![allow(clippy::result_large_err)]
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Cursor, Read},
    ops::{Bound, RangeBounds},
    sync::{Arc, Mutex, OnceLock},
};

use openraft::error::{RPCError, ReplicationClosed, Unreachable};
use openraft::network::{RPCOption, RaftNetwork, RaftNetworkFactory};
use openraft::raft::{
    AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest, SnapshotResponse,
    VoteRequest, VoteResponse,
};
use openraft::storage::{LogFlushed, RaftLogReader, RaftLogStorage, RaftStateMachine};
use openraft::{
    BasicNode, Config, Entry, EntryPayload, LogId, LogState, Raft, RaftSnapshotBuilder, Snapshot,
    SnapshotMeta, StorageError, StorageIOError, StoredMembership, TokioRuntime, Vote,
};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};

pub type NodeId = u64;
openraft::declare_raft_types!(
    pub CatalogType:
        D = CatalogRequest,
        R = CatalogResponse,
        NodeId = NodeId,
        Node = BasicNode,
        Entry = Entry<CatalogType>,
        SnapshotData = Cursor<Vec<u8>>,
        AsyncRuntime = TokioRuntime,
);
pub type CatalogRaftInner = Raft<CatalogType>;

/// Every catalog change is an idempotent, revision-fenced Raft entry.  The named variants
/// make the ownership boundary explicit; `payload` is deliberately JSON because the catalog is
/// versioned independently from the desktop UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CatalogRequest {
    // Kept solely for old log/snapshot compatibility.
    Put {
        key: String,
        value: String,
    },
    Delete {
        key: String,
    },
    Network {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Device {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Membership {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Project {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Task {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Pane {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Ownership {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    CleanupAuthorization {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
    Migration {
        operation_id: String,
        expected_revision: i64,
        payload: serde_json::Value,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatalogResponse {
    pub value: Option<String>,
    #[serde(default)]
    pub revision: Option<i64>,
    #[serde(default)]
    pub status: String,
}
impl CatalogResponse {
    fn legacy(value: Option<String>) -> Self {
        Self {
            value,
            revision: None,
            status: "committed".into(),
        }
    }
    fn result(value: serde_json::Value, revision: Option<i64>) -> Self {
        Self {
            value: Some(value.to_string()),
            revision,
            status: "committed".into(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    last: Option<LogId<NodeId>>,
    membership: StoredMembership<NodeId, BasicNode>,
    data: BTreeMap<String, String>,
}

/// SQLite-backed storage; each Raft group gets its own `network_id` namespace.
#[derive(Clone)]
pub struct SqliteStore {
    db: Arc<Mutex<Connection>>,
    network_id: String,
    applied: Arc<tokio::sync::Notify>,
}
impl SqliteStore {
    pub fn open(path: &str, network_id: impl Into<String>) -> anyhow::Result<Self> {
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(10))?;
        crate::network::migrate(&c)?;
        crate::task_store::migrate(&c)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS raft_catalog_state (network_id TEXT PRIMARY KEY, payload BLOB NOT NULL)")?;
        Ok(Self {
            db: Arc::new(Mutex::new(c)),
            network_id: network_id.into(),
            applied: Arc::new(tokio::sync::Notify::new()),
        })
    }
    fn err<E: std::error::Error + 'static>(e: E) -> StorageError<NodeId> {
        StorageIOError::read_state_machine(&e).into()
    }
    fn state(&self) -> Result<State, StorageError<NodeId>> {
        let c = self.db.lock().unwrap();
        let p: Option<Vec<u8>> = c
            .query_row(
                "SELECT payload FROM raft_catalog_state WHERE network_id=?1",
                params![self.network_id],
                |r| Ok(r.get_ref(0)?.as_bytes()?.to_vec()),
            )
            .optional()
            .map_err(Self::err)?;
        p.map(|x| serde_json::from_slice(&x).map_err(Self::err))
            .transpose()
            .map(|x| x.unwrap_or_default())
    }
    fn put_state(&self, s: &State) -> Result<(), StorageError<NodeId>> {
        let b = serde_json::to_vec(s).map_err(Self::err)?;
        self.db.lock().unwrap().execute("INSERT INTO raft_catalog_state(network_id,payload) VALUES(?1,?2) ON CONFLICT(network_id) DO UPDATE SET payload=excluded.payload",params![self.network_id,b]).map_err(Self::err)?;
        Ok(())
    }
    pub fn get(&self, key: &str) -> Option<String> {
        self.state().ok()?.data.get(key).cloned()
    }
}
impl RaftLogReader<CatalogType> for SqliteStore {
    async fn try_get_log_entries<
        R: RangeBounds<u64> + Clone + std::fmt::Debug + openraft::OptionalSend,
    >(
        &mut self,
        range: R,
    ) -> Result<Vec<Entry<CatalogType>>, StorageError<NodeId>> {
        let lo = match range.start_bound() {
            Bound::Included(x) => *x,
            Bound::Excluded(x) => x + 1,
            Bound::Unbounded => 0,
        };
        let hi = match range.end_bound() {
            Bound::Included(x) => x + 1,
            Bound::Excluded(x) => *x,
            Bound::Unbounded => u64::MAX,
        };
        let c = self.db.lock().unwrap();
        let mut q=c.prepare("SELECT payload FROM raft_log WHERE network_id=?1 AND log_index>=?2 AND log_index<?3 ORDER BY log_index").map_err(Self::err)?;
        let rows = q
            .query_map(params![self.network_id, lo as i64, hi as i64], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .map_err(Self::err)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(serde_json::from_slice(&row.map_err(Self::err)?).map_err(Self::err)?);
        }
        Ok(entries)
    }
}
impl RaftLogStorage<CatalogType> for SqliteStore {
    type LogReader = Self;
    async fn get_log_state(&mut self) -> Result<LogState<CatalogType>, StorageError<NodeId>> {
        let c = self.db.lock().unwrap();
        let last: Option<Vec<u8>> = c
            .query_row(
                "SELECT payload FROM raft_log WHERE network_id=?1 ORDER BY log_index DESC LIMIT 1",
                params![self.network_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Self::err)?;
        let purged: Option<Vec<u8>> = c
            .query_row(
                "SELECT payload FROM raft_snapshots WHERE network_id=?1",
                params![self.network_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Self::err)?;
        let last = last
            .map(|b| serde_json::from_slice::<Entry<CatalogType>>(&b).map(|e| e.log_id))
            .transpose()
            .map_err(Self::err)?;
        let purged = purged
            .and_then(|b| serde_json::from_slice::<SnapshotBlob>(&b).ok())
            .and_then(|s| s.last);
        Ok(LogState {
            last_purged_log_id: purged,
            last_log_id: last.or(purged),
        })
    }
    async fn get_log_reader(&mut self) -> Self {
        self.clone()
    }
    async fn save_vote(&mut self, v: &Vote<NodeId>) -> Result<(), StorageError<NodeId>> {
        let b = serde_json::to_vec(v).map_err(Self::err)?;
        self.db.lock().unwrap().execute("INSERT INTO raft_hard_state(network_id,vote) VALUES(?1,?2) ON CONFLICT(network_id) DO UPDATE SET vote=excluded.vote",params![self.network_id,b]).map_err(Self::err)?;
        Ok(())
    }
    async fn read_vote(&mut self) -> Result<Option<Vote<NodeId>>, StorageError<NodeId>> {
        let c = self.db.lock().unwrap();
        let b: Option<Vec<u8>> = c
            .query_row(
                "SELECT vote FROM raft_hard_state WHERE network_id=?1",
                params![self.network_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Self::err)?
            .flatten();
        b.map(|x| serde_json::from_slice(&x).map_err(Self::err))
            .transpose()
    }
    async fn append<I>(
        &mut self,
        es: I,
        cb: LogFlushed<CatalogType>,
    ) -> Result<(), StorageError<NodeId>>
    where
        I: IntoIterator<Item = Entry<CatalogType>> + openraft::OptionalSend,
        I::IntoIter: openraft::OptionalSend,
    {
        let mut c = self.db.lock().unwrap();
        let tx = c.transaction().map_err(Self::err)?;
        for e in es {
            let b = serde_json::to_vec(&e).map_err(Self::err)?;
            tx.execute("INSERT OR REPLACE INTO raft_log(network_id,log_index,term,payload) VALUES(?1,?2,?3,?4)",params![self.network_id,e.log_id.index as i64,e.log_id.leader_id.term as i64,b]).map_err(Self::err)?;
        }
        tx.commit().map_err(Self::err)?;
        drop(c);
        cb.log_io_completed(Ok(()));
        Ok(())
    }
    async fn truncate(&mut self, id: LogId<NodeId>) -> Result<(), StorageError<NodeId>> {
        self.db
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM raft_log WHERE network_id=?1 AND log_index>=?2",
                params![self.network_id, id.index as i64],
            )
            .map_err(Self::err)?;
        Ok(())
    }
    async fn purge(&mut self, id: LogId<NodeId>) -> Result<(), StorageError<NodeId>> {
        self.db
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM raft_log WHERE network_id=?1 AND log_index<=?2",
                params![self.network_id, id.index as i64],
            )
            .map_err(Self::err)?;
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
struct SnapshotBlob {
    last: Option<LogId<NodeId>>,
    membership: StoredMembership<NodeId, BasicNode>,
    data: BTreeMap<String, String>,
    #[serde(default)]
    catalog: Vec<SnapshotTable>,
}

#[derive(Serialize, Deserialize)]
struct SnapshotTable {
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<SnapshotCell>>,
}

#[derive(Serialize, Deserialize)]
enum SnapshotCell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

// Consensus-owned projections only. Credentials, device-local transport state, runtime state,
// event delivery progress and preferences deliberately never cross a snapshot boundary.
const SNAPSHOT_TABLES: &[&str] = &[
    "networks",
    "devices",
    "coordinator_members",
    "git_replicas",
    "raft_node_members",
    "projects",
    "tasks",
    "task_panes",
    // These tables are written by the state machine and must travel with the task rows.
    "task_provisioning",
    "device_task_paths",
    "task_cleanup_receipts",
    "pi_session_metadata",
    "sessions",
    "operation_dedup",
    "tombstones",
    "legacy_import_records",
    "migration_conflict_resolutions",
];

fn snapshot_catalog(
    conn: &Connection,
    network_id: &str,
) -> Result<Vec<SnapshotTable>, rusqlite::Error> {
    let mut result = Vec::new();
    for &name in SNAPSHOT_TABLES {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [name],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let scoped_query = match name {
            "networks" => Some(format!("SELECT * FROM {name} WHERE id=?1")),
            "devices"
            | "coordinator_members"
            | "git_replicas"
            | "raft_node_members"
            | "projects"
            | "migration_conflict_resolutions" => {
                Some(format!("SELECT * FROM {name} WHERE network_id=?1"))
            }
            "tasks" => Some(format!(
                "SELECT * FROM {name} WHERE project_id IN (SELECT id FROM projects WHERE network_id=?1)"
            )),
            "task_panes" | "sessions" => Some(format!(
                "SELECT * FROM {name} WHERE task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)"
            )),
            "task_provisioning" | "device_task_paths" | "task_cleanup_receipts" => {
                Some(format!(
                    "SELECT * FROM {name} WHERE task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)"
                ))
            }
            "pi_session_metadata" => Some(format!(
                "SELECT * FROM {name} WHERE pane_id IN (SELECT pane.id FROM task_panes pane JOIN tasks t ON t.id=pane.task_id JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)"
            )),
            // These legacy/global tables predate a network_id column. Operation IDs and
            // tombstone record IDs are globally unique in the catalog, so retain them as-is.
            _ => None,
        };
        let fallback_query = format!("SELECT * FROM {name}");
        let query = scoped_query.as_deref().unwrap_or(&fallback_query);
        let mut statement = conn.prepare(query)?;
        let columns = statement
            .column_names()
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let bind_params = if scoped_query.is_some() {
            vec![network_id]
        } else {
            Vec::new()
        };
        let rows = statement
            .query_map(rusqlite::params_from_iter(bind_params), |row| {
                (0..columns.len())
                    .map(|index| {
                        use rusqlite::types::ValueRef;
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => SnapshotCell::Null,
                            ValueRef::Integer(value) => SnapshotCell::Integer(value),
                            ValueRef::Real(value) => SnapshotCell::Real(value),
                            ValueRef::Text(value) => {
                                SnapshotCell::Text(String::from_utf8_lossy(value).into_owned())
                            }
                            ValueRef::Blob(value) => SnapshotCell::Blob(value.to_vec()),
                        })
                    })
                    .collect::<Result<Vec<_>, rusqlite::Error>>()
            })?
            .collect::<Result<Vec<_>, _>>()?;
        result.push(SnapshotTable {
            name: name.to_owned(),
            columns,
            rows,
        });
    }
    Ok(result)
}

fn restore_catalog(
    conn: &mut Connection,
    network_id: &str,
    catalog: &[SnapshotTable],
) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    // pi_session_metadata and the migration tables are created lazily by their projections.
    // A fresh learner can therefore receive them before it has applied the entry that creates
    // the table. Create the known lazy schemas before replaying snapshot rows.
    for table in catalog {
        match table.name.as_str() {
            "pi_session_metadata" => tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS pi_session_metadata (
                   pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                   metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
                 )",
            )?,
            "legacy_import_records" => tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS legacy_import_records (
                   operation_id TEXT NOT NULL, stable_key TEXT NOT NULL,
                   kind TEXT NOT NULL, original_json TEXT NOT NULL,
                   imported_id TEXT, PRIMARY KEY(operation_id, stable_key)
                 )",
            )?,
            "migration_conflict_resolutions" => tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS migration_conflict_resolutions (
                   conflict_id TEXT PRIMARY KEY, revision_hash TEXT NOT NULL,
                   source_record_ids_json TEXT NOT NULL, action TEXT NOT NULL,
                   mapping_json TEXT NOT NULL, diff_json TEXT NOT NULL,
                   network_id TEXT NOT NULL, resolved_at INTEGER NOT NULL
                 )",
            )?,
            _ => {}
        }
    }
    for table in catalog.iter().rev() {
        if SNAPSHOT_TABLES.contains(&table.name.as_str()) {
            let delete = match table.name.as_str() {
                "networks" => format!("DELETE FROM {} WHERE id=?1", table.name),
                "devices"
                | "coordinator_members"
                | "git_replicas"
                | "raft_node_members"
                | "projects"
                | "migration_conflict_resolutions" => {
                    format!("DELETE FROM {} WHERE network_id=?1", table.name)
                }
                "tasks" => format!(
                    "DELETE FROM {} WHERE project_id IN (SELECT id FROM projects WHERE network_id=?1)",
                    table.name
                ),
                "task_panes" | "sessions" => format!(
                    "DELETE FROM {} WHERE task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)",
                    table.name
                ),
                "task_provisioning" | "device_task_paths" | "task_cleanup_receipts" => format!(
                    "DELETE FROM {} WHERE task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)",
                    table.name
                ),
                "pi_session_metadata" => format!(
                    "DELETE FROM {} WHERE pane_id IN (SELECT pane.id FROM task_panes pane JOIN tasks t ON t.id=pane.task_id JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1)",
                    table.name
                ),
                _ => format!("DELETE FROM {}", table.name),
            };
            if delete.contains("?1") {
                tx.execute(&delete, params![network_id])?;
            } else {
                tx.execute(&delete, [])?;
            }
        }
    }
    for table in catalog {
        if !SNAPSHOT_TABLES.contains(&table.name.as_str()) || table.columns.is_empty() {
            continue;
        }
        let placeholders = (1..=table.columns.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table.name,
            table.columns.join(","),
            placeholders
        );
        for row in &table.rows {
            let values = row
                .iter()
                .map(|cell| match cell {
                    SnapshotCell::Null => rusqlite::types::Value::Null,
                    SnapshotCell::Integer(value) => rusqlite::types::Value::Integer(*value),
                    SnapshotCell::Real(value) => rusqlite::types::Value::Real(*value),
                    SnapshotCell::Text(value) => rusqlite::types::Value::Text(value.clone()),
                    SnapshotCell::Blob(value) => rusqlite::types::Value::Blob(value.clone()),
                })
                .collect::<Vec<_>>();
            tx.execute(&sql, rusqlite::params_from_iter(values))?;
        }
    }
    tx.commit()
}
impl RaftSnapshotBuilder<CatalogType> for SqliteStore {
    async fn build_snapshot(&mut self) -> Result<Snapshot<CatalogType>, StorageError<NodeId>> {
        let s = self.state()?;
        let catalog =
            snapshot_catalog(&self.db.lock().unwrap(), &self.network_id).map_err(Self::err)?;
        let b = serde_json::to_vec(&SnapshotBlob {
            last: s.last,
            membership: s.membership.clone(),
            data: s.data.clone(),
            catalog,
        })
        .map_err(Self::err)?;
        let meta = SnapshotMeta {
            last_log_id: s.last,
            last_membership: s.membership.clone(),
            snapshot_id: format!("catalog-{}", s.last.map(|x| x.index).unwrap_or(0)),
        };
        self.db.lock().unwrap().execute("INSERT INTO raft_snapshots(network_id,last_log_index,last_log_term,payload,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(network_id) DO UPDATE SET payload=excluded.payload",params![self.network_id,meta.last_log_id.map(|x|x.index as i64).unwrap_or(0),meta.last_log_id.map(|x|x.leader_id.term as i64).unwrap_or(0),b]).map_err(Self::err)?;
        Ok(Snapshot {
            meta,
            snapshot: Box::new(Cursor::new(b)),
        })
    }
}
fn invalid(status: &str) -> CatalogResponse {
    CatalogResponse {
        value: None,
        revision: None,
        status: status.into(),
    }
}
fn field<'a>(payload: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    payload
        .get(name)
        .and_then(serde_json::Value::as_str)
        .filter(|v| !v.is_empty())
}
fn ids(payload: &serde_json::Value, name: &str) -> Option<String> {
    let values = payload.get(name)?.as_array()?;
    let mut seen = std::collections::BTreeSet::new();
    for value in values {
        seen.insert(value.as_str()?.to_owned());
    }
    (seen.len() == values.len()).then(|| serde_json::to_string(values).unwrap())
}
fn conflict() -> CatalogResponse {
    invalid("revision_conflict")
}
fn committed(value: serde_json::Value, revision: i64) -> CatalogResponse {
    CatalogResponse::result(value, Some(revision))
}

fn is_catalog_constraint(error: &rusqlite::Error) -> bool {
    error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)
}

fn apply_catalog_projection(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    operation_id: &str,
    expected: i64,
    payload: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    if operation_id.is_empty() {
        return Ok(invalid("invalid_request"));
    }
    // An operation identifies semantic intent. Preconditions are execution-attempt metadata and
    // may legitimately change when a follower catches up and retries the same intent.
    let hash = serde_json::to_string(&(kind, payload)).unwrap_or_default();
    if let Some((old_hash, result)) = tx
        .query_row(
            "SELECT request_hash,result_json FROM operation_dedup WHERE operation_id=?1",
            params![operation_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        return Ok(if old_hash == hash {
            serde_json::from_str(&result).unwrap_or_else(|_| CatalogResponse::legacy(None))
        } else {
            invalid("operation_id_conflict")
        });
    }
    let action = payload
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("update");
    let response = match kind {
        "network" => {
            let Some(id) = field(payload, "networkId").or_else(|| field(payload, "id")) else {
                return record_catalog_result(
                    tx,
                    kind,
                    operation_id,
                    &hash,
                    payload,
                    invalid("invalid_request"),
                );
            };
            if action == "set_server" {
                let Some(server) = field(payload, "serverDeviceId") else {
                    return record_catalog_result(
                        tx,
                        kind,
                        operation_id,
                        &hash,
                        payload,
                        invalid("invalid_request"),
                    );
                };
                let valid: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?1 AND network_id=?2 AND tombstoned_at IS NULL)",
                    params![server, id],
                    |row| row.get(0),
                )?;
                if !valid {
                    invalid("device_network_mismatch")
                } else if tx.execute("UPDATE networks SET server_device_id=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL", params![server,id,expected])? == 0 {
                    conflict()
                } else {
                    tx.execute(
                        "UPDATE coordinator_members SET voter=CASE WHEN device_id=?2 THEN 1 ELSE 0 END,healthy=CASE WHEN device_id=?2 THEN 1 ELSE 0 END WHERE network_id=?1",
                        params![id, server],
                    )?;
                    committed(serde_json::json!({"networkId":id,"serverDeviceId":server,"revision":expected+1}), expected + 1)
                }
            } else if action != "update" || field(payload, "name").is_none() {
                invalid("invalid_request")
            } else if tx.execute("UPDATE networks SET name=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL", params![field(payload,"name").unwrap(),id,expected])? == 0 {
                conflict()
            } else {
                committed(serde_json::json!({"networkId":id,"revision":expected+1}), expected + 1)
            }
        }
        "device" if action == "join_request" => {
            let (Some(network), Some(enrollment), Some(secret)) = (
                field(payload, "networkId"),
                field(payload, "enrollmentId"),
                field(payload, "secret"),
            ) else {
                return record_catalog_result(
                    tx,
                    kind,
                    operation_id,
                    &hash,
                    payload,
                    invalid("invalid_enrollment"),
                );
            };
            let node_id = payload.get("nodeId").and_then(serde_json::Value::as_i64);
            let endpoint = field(payload, "connectorEndpoint");
            if secret.len() < 16 || node_id.is_none() || node_id == Some(0) || endpoint.is_none() {
                invalid("invalid_enrollment")
            } else {
                let mut metadata = payload
                    .get("metadata")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if let Some(object) = metadata.as_object_mut() {
                    object.insert("nodeId".into(), serde_json::json!(node_id));
                    object.insert("connectorEndpoint".into(), serde_json::json!(endpoint));
                } else {
                    return Ok(invalid("invalid_enrollment"));
                }
                tx.execute("INSERT INTO enrollment_credentials(enrollment_id,network_id,secret,challenge_secret,metadata_json,created_at) VALUES(?1,?2,?3,?3,?4,strftime('%s','now'))", params![enrollment,network,secret,metadata.to_string()])?;
                CatalogResponse::result(
                    serde_json::json!({"enrollmentId": enrollment, "state":"pending"}),
                    None,
                )
            }
        }
        "device" if action == "approve_join" => {
            let (Some(network), Some(enrollment)) =
                (field(payload, "networkId"), field(payload, "enrollmentId"))
            else {
                return record_catalog_result(
                    tx,
                    kind,
                    operation_id,
                    &hash,
                    payload,
                    invalid("invalid_request"),
                );
            };
            let pending: Option<String> = tx.query_row("SELECT metadata_json FROM enrollment_credentials WHERE enrollment_id=?1 AND network_id=?2 AND approved_at IS NULL",params![enrollment,network],|r|r.get(0)).optional()?;
            if pending.is_none() {
                invalid("join_request_not_found")
            } else {
                let device: String =
                    tx.query_row("SELECT 'dev_' || lower(hex(randomblob(16)))", [], |r| {
                        r.get(0)
                    })?;
                let credential: String =
                    tx.query_row("SELECT lower(hex(randomblob(32)))", [], |r| r.get(0))?;
                let metadata: serde_json::Value = serde_json::from_str(pending.as_deref().unwrap())
                    .unwrap_or_else(|_| serde_json::json!({}));
                let name = metadata
                    .get("displayName")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Swath device");
                let host = metadata
                    .get("hostname")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(name);
                let platform = metadata
                    .get("platform")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                tx.execute("INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,1,strftime('%s','now'))",params![device,network,name,host,platform,enrollment])?;
                tx.execute("UPDATE enrollment_credentials SET device_id=?1,credential=?2,approved_at=strftime('%s','now') WHERE enrollment_id=?3",params![device,credential,enrollment])?;
                let node_id = metadata
                    .get("nodeId")
                    .and_then(serde_json::Value::as_i64)
                    .ok_or(rusqlite::Error::InvalidQuery)?;
                let endpoint = metadata
                    .get("connectorEndpoint")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(rusqlite::Error::InvalidQuery)?;
                tx.execute("INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES(?1,?2,?3,?4)",params![network,device,node_id,endpoint])?;
                // Credentials are destination capabilities: every sender uses this value only when dialing this device.
                tx.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,credential=excluded.credential,updated_at=strftime('%s','now')",params![device,endpoint,credential])?;
                tx.execute("INSERT INTO coordinator_members(network_id,device_id,voter,healthy,promoted_at) VALUES(?1,?2,0,1,strftime('%s','now'))",params![network,device])?;
                CatalogResponse::result(
                    serde_json::json!({"enrollmentId":enrollment,"deviceId":device,"nodeId":node_id,"endpoint":endpoint,"credential":credential,"state":"approved"}),
                    None,
                )
            }
        }
        "project" => project_mutation(tx, action, expected, payload)?,
        "task" => task_mutation(tx, action, expected, payload)?,
        "pane" => pane_mutation(tx, action, expected, payload)?,
        "ownership" => ownership_mutation(tx, expected, payload)?,
        "membership" => membership_mutation(tx, expected, payload)?,
        "cleanup_authorization" => cleanup_mutation(tx, action, expected, payload)?,
        "migration" => migration_mutation(tx, expected, payload)?,
        _ => invalid("invalid_request"),
    };
    record_catalog_result(tx, kind, operation_id, &hash, payload, response)
}
fn record_catalog_result(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    operation_id: &str,
    hash: &str,
    payload: &serde_json::Value,
    response: CatalogResponse,
) -> Result<CatalogResponse, rusqlite::Error> {
    // A rejected optimistic attempt is not a completed semantic operation. Let the caller reload
    // and retry the same operation ID with an authoritative precondition.
    if response.status == "revision_conflict" {
        return Ok(response);
    }
    tx.execute("INSERT INTO operation_dedup(operation_id,operation_kind,request_hash,result_json,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))",params![operation_id,kind,hash,serde_json::to_string(&response).unwrap()])?;
    tx.execute("INSERT INTO transactional_outbox(id,topic,payload_json,created_at) VALUES(?1,?2,?3,strftime('%s','now'))",params![format!("catalog:{operation_id}"),format!("catalog.{kind}"),payload.to_string()])?;
    Ok(response)
}
fn project_mutation(
    tx: &rusqlite::Transaction<'_>,
    action: &str,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let Some(id) = field(p, "projectId").or_else(|| field(p, "id")) else {
        return Ok(invalid("invalid_request"));
    };
    match action {
        "create" => {
            let (Some(network), Some(name), Some(branch)) = (
                field(p, "networkId"),
                field(p, "name"),
                field(p, "defaultBranch"),
            ) else {
                return Ok(invalid("invalid_request"));
            };
            if expected != 0 {
                return Ok(conflict());
            };
            let network_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM networks WHERE id=?1 AND tombstoned_at IS NULL)",
                params![network],
                |row| row.get(0),
            )?;
            if !network_exists {
                return Ok(invalid("network_not_found"));
            }
            let source = p
                .get("repositorySource")
                .and_then(serde_json::Value::as_str);
            let n=tx.execute("INSERT INTO projects(id,network_id,name,repository_source,default_branch,task_order,revision,created_at) VALUES(?1,?2,?3,?4,?5,'[]',1,strftime('%s','now')) ON CONFLICT(id) DO NOTHING",params![id,network,name,source,branch])?;
            if n == 0 {
                Ok(conflict())
            } else {
                if let (Some(device), Some(source)) = (field(p, "replicaDeviceId"), source) {
                    tx.execute("INSERT INTO git_replicas(network_id,device_id,repository_source) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING", params![network,device,source])?;
                }
                Ok(committed(
                    serde_json::json!({"projectId":id,"revision":1}),
                    1,
                ))
            }
        }
        "update" => {
            let Some(name) = field(p, "name") else {
                return Ok(invalid("invalid_request"));
            };
            let n=tx.execute("UPDATE projects SET name=?1,repository_source=?2,default_branch=COALESCE(?3,default_branch),revision=revision+1 WHERE id=?4 AND revision=?5 AND tombstoned_at IS NULL",params![name,p.get("repositorySource").and_then(serde_json::Value::as_str),p.get("defaultBranch").and_then(serde_json::Value::as_str),id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"projectId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "reorder" | "reorder_tasks" => {
            let Some(order) = ids(p, "taskIds") else {
                return Ok(invalid("invalid_request"));
            };
            let valid: bool = tx.query_row("SELECT (SELECT count(*) FROM tasks WHERE project_id=?1 AND tombstoned_at IS NULL) = (SELECT count(*) FROM tasks WHERE project_id=?1 AND tombstoned_at IS NULL AND id IN (SELECT value FROM json_each(?2)))", params![id, order], |r| r.get(0))?;
            if !valid {
                return Ok(invalid("invalid_order"));
            }
            let n=tx.execute("UPDATE projects SET task_order=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![order,id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"projectId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        // Reconciles legacy per-device project imports into one shared project without touching
        // task worktrees or durable Pi records.  The entire operation is one Raft projection so
        // peers never observe a task moved to a project that has already been tombstoned.
        "merge" => {
            let Some(raw_duplicates) = p
                .get("duplicateProjectIds")
                .and_then(serde_json::Value::as_array)
            else {
                return Ok(invalid("invalid_request"));
            };
            let duplicates: Vec<&str> = raw_duplicates
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect();
            if duplicates.is_empty()
                || duplicates.len() != raw_duplicates.len()
                || duplicates.contains(&id)
                || duplicates
                    .iter()
                    .enumerate()
                    .any(|(index, duplicate)| duplicates[..index].contains(duplicate))
            {
                return Ok(invalid("invalid_request"));
            }

            let canonical_network: Option<String> = tx
                .query_row(
                    "SELECT network_id FROM projects WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",
                    params![id, expected],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(canonical_network) = canonical_network else {
                return Ok(conflict());
            };
            for duplicate in &duplicates {
                let valid: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND network_id=?2 AND tombstoned_at IS NULL)",
                    params![duplicate, canonical_network],
                    |row| row.get(0),
                )?;
                if !valid {
                    return Ok(invalid("duplicate_project_not_found"));
                }
            }

            let mut project_ids = vec![id];
            project_ids.extend(duplicates.iter().copied());
            let mut task_ids = Vec::new();
            for project_id in &project_ids {
                let mut statement = tx.prepare(
                    "SELECT id FROM tasks WHERE project_id=?1 AND tombstoned_at IS NULL ORDER BY created_at,id",
                )?;
                let rows = statement
                    .query_map([project_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                task_ids.extend(rows);
            }
            let order =
                serde_json::to_string(&task_ids).map_err(|_| rusqlite::Error::InvalidQuery)?;

            // Keep only Pi panes.  Pi history uses the existing task/pane IDs, so no transcript
            // rows need rewriting and the original working directories remain untouched.
            let mut removed_panes = 0usize;
            for task_id in &task_ids {
                let mut pi_statement = tx.prepare(
                    "SELECT id FROM task_panes WHERE task_id=?1 AND kind='piAgent' AND tombstoned_at IS NULL ORDER BY created_at,id",
                )?;
                let pi_panes = pi_statement
                    .query_map([task_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut stale_statement = tx.prepare(
                    "SELECT id,revision FROM task_panes WHERE task_id=?1 AND kind!='piAgent' AND tombstoned_at IS NULL",
                )?;
                let stale = stale_statement
                    .query_map([task_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                for (pane_id, pane_revision) in stale {
                    tx.execute(
                        "UPDATE task_panes SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",
                        params![pane_id, pane_revision],
                    )?;
                    tx.execute(
                        "INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES('pane',?1,?2,strftime('%s','now'))",
                        params![pane_id, pane_revision + 1],
                    )?;
                    removed_panes += 1;
                }
                let pane_order =
                    serde_json::to_string(&pi_panes).map_err(|_| rusqlite::Error::InvalidQuery)?;
                tx.execute(
                    "UPDATE tasks SET pane_order=?1,revision=revision+1 WHERE id=?2 AND tombstoned_at IS NULL",
                    params![pane_order, task_id],
                )?;
            }

            for duplicate in &duplicates {
                tx.execute(
                    "UPDATE tasks SET project_id=?1,revision=revision+1 WHERE project_id=?2 AND tombstoned_at IS NULL",
                    params![id, duplicate],
                )?;
            }
            let source = p
                .get("repositorySource")
                .and_then(serde_json::Value::as_str);
            if tx.execute(
                "UPDATE projects SET task_order=?1,repository_source=COALESCE(?2,repository_source),revision=revision+1 WHERE id=?3 AND revision=?4 AND tombstoned_at IS NULL",
                params![order, source, id, expected],
            )? == 0 {
                return Ok(conflict());
            }
            for duplicate in &duplicates {
                let revision: i64 = tx.query_row(
                    "SELECT revision FROM projects WHERE id=?1 AND tombstoned_at IS NULL",
                    [duplicate],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "UPDATE projects SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",
                    params![duplicate, revision],
                )?;
                tx.execute(
                    "INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES('project',?1,?2,strftime('%s','now'))",
                    params![duplicate, revision + 1],
                )?;
            }
            Ok(committed(
                serde_json::json!({"projectId":id,"revision":expected+1,"mergedProjectIds":duplicates,"taskIds":task_ids,"removedNonPiPanes":removed_panes}),
                expected + 1,
            ))
        }
        "tombstone" => tombstone(tx, "projects", "project", id, expected),
        _ => Ok(invalid("invalid_action")),
    }
}
fn tombstone(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    typ: &str,
    id: &str,
    _expected: i64,
) -> Result<CatalogResponse, rusqlite::Error> {
    let select = match table {
        "projects" => "SELECT revision,tombstoned_at FROM projects WHERE id=?1",
        "tasks" => "SELECT revision,tombstoned_at FROM tasks WHERE id=?1",
        "task_panes" => "SELECT revision,tombstoned_at FROM task_panes WHERE id=?1",
        _ => return Ok(invalid("invalid_request")),
    };
    let record: Option<(i64, Option<i64>)> = tx
        .query_row(select, [id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((current, tombstoned_at)) = record else {
        return Ok(conflict());
    };
    // Removal is a monotonic intent. Learner projections can be either behind or ahead of the
    // current leader after reconnecting from an older snapshot, so tombstone the authoritative
    // active row regardless of the caller's cached revision. Repeated removal is also successful.
    // Edits and reorders continue to require exact revision fences.
    if tombstoned_at.is_some() {
        return Ok(committed(
            serde_json::json!({"id":id,"revision":current}),
            current,
        ));
    }
    let sql=match table{"projects"=>"UPDATE projects SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL","tasks"=>"UPDATE tasks SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL","task_panes"=>"UPDATE task_panes SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",_=>unreachable!()};
    if tx.execute(sql, params![id, current])? == 0 {
        return Ok(conflict());
    }
    let tombstone_revision = current + 1;
    tx.execute("INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES(?1,?2,?3,strftime('%s','now'))",params![typ,id,tombstone_revision])?;
    Ok(committed(
        serde_json::json!({"id":id,"revision":tombstone_revision}),
        tombstone_revision,
    ))
}

fn task_mutation(
    tx: &rusqlite::Transaction<'_>,
    action: &str,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let Some(id) = field(p, "taskId").or_else(|| field(p, "id")) else {
        return Ok(invalid("invalid_request"));
    };
    match action {
        "create" => {
            let (Some(project), Some(title), Some(device), Some(base), Some(path)) = (
                field(p, "projectId"),
                field(p, "title"),
                field(p, "assignedDeviceId").or_else(|| field(p, "deviceId")),
                field(p, "baseCommit"),
                field(p, "worktreePath"),
            ) else {
                return Ok(invalid("invalid_request"));
            };
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
                params![id],
                |r| r.get(0),
            )?;
            if exists {
                return Ok(conflict());
            }
            let same_network: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects p JOIN devices d ON d.network_id=p.network_id WHERE p.id=?1 AND d.id=?2 AND p.tombstoned_at IS NULL AND d.tombstoned_at IS NULL)",
                params![project, device],
                |row| row.get(0),
            )?;
            if !same_network {
                return Ok(invalid("device_network_mismatch"));
            }
            if tx.execute("UPDATE projects SET task_order=json_insert(task_order,'$[#]',?1),revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![id,project,expected])?==0{return Ok(conflict())};
            if tx.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,pane_order,revision,created_at) VALUES(?1,?2,?3,?4,'active','[]',1,strftime('%s','now'))",params![id,project,title,device])?==0{return Ok(conflict())};
            tx.execute("INSERT INTO task_provisioning(task_id,base_commit,worktree_path,state,created_at) VALUES(?1,?2,?3,'pending',strftime('%s','now'))",params![id,base,path])?;
            Ok(committed(
                serde_json::json!({"taskId":id,"revision":1,"projectRevision":expected+1}),
                1,
            ))
        }
        "update" => {
            let Some(title) = field(p, "title") else {
                return Ok(invalid("invalid_request"));
            };
            let n=tx.execute("UPDATE tasks SET title=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![title,id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"taskId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "reorder_panes" => {
            let Some(order) = ids(p, "paneIds") else {
                return Ok(invalid("invalid_request"));
            };
            let valid: bool = tx.query_row("SELECT (SELECT count(*) FROM task_panes WHERE task_id=?1 AND tombstoned_at IS NULL) = (SELECT count(*) FROM task_panes WHERE task_id=?1 AND tombstoned_at IS NULL AND id IN (SELECT value FROM json_each(?2)))", params![id, order], |r| r.get(0))?;
            if !valid {
                return Ok(invalid("invalid_order"));
            }
            let n=tx.execute("UPDATE tasks SET pane_order=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![order,id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"taskId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "lifecycle" => {
            let Some(state) = field(p, "lifecycle") else {
                return Ok(invalid("invalid_request"));
            };
            if !matches!(state, "active" | "completed") {
                return Ok(invalid("invalid_request"));
            };
            let current: Option<(String, i64)> = tx
                .query_row(
                    "SELECT lifecycle,revision FROM tasks WHERE id=?1 AND tombstoned_at IS NULL",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((current_state, current_revision)) = current {
                if current_state == state {
                    return Ok(committed(
                        serde_json::json!({"taskId":id,"revision":current_revision,"lifecycle":state}),
                        current_revision,
                    ));
                }
            }
            let n=tx.execute("UPDATE tasks SET lifecycle=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![state,id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"taskId":id,"revision":expected+1,"lifecycle":state}),
                    expected + 1,
                )
            })
        }
        "provision_ready" => {
            let Some(pane) = field(p, "paneId") else {
                return Ok(invalid("invalid_request"));
            };
            if tx.execute("UPDATE task_provisioning SET state='ready',last_error=NULL,ready_at=strftime('%s','now') WHERE task_id=?1 AND state IN ('pending','failed')",params![id])?==0{return Ok(conflict())};
            tx.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision) SELECT t.id,t.assigned_device_id,q.worktree_path,1 FROM tasks t JOIN task_provisioning q ON q.task_id=t.id WHERE t.id=?1 ON CONFLICT(task_id,device_id) DO UPDATE SET path=excluded.path,revision=device_task_paths.revision+1", params![id])?;
            if tx.execute("INSERT INTO task_panes(id,task_id,kind,title,revision,created_at) VALUES(?1,?2,'piAgent','Pi',1,strftime('%s','now'))",params![pane,id])?==0{return Ok(conflict())};
            let n=tx.execute("UPDATE tasks SET pane_order=json_array(?1),revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![pane,id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"taskId":id,"paneId":pane,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "provision_failed" => {
            let Some(reason) = field(p, "reason") else {
                return Ok(invalid("invalid_request"));
            };
            if tx.execute("UPDATE task_provisioning SET state='failed',last_error=?2 WHERE task_id=?1 AND state!='ready'",params![id,reason])?==0{return Ok(conflict())};
            let n=tx.execute("UPDATE tasks SET revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",params![id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"taskId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "tombstone" => tombstone(tx, "tasks", "task", id, expected),
        _ => Ok(invalid("invalid_action")),
    }
}
fn pane_mutation(
    tx: &rusqlite::Transaction<'_>,
    action: &str,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let Some(id) = field(p, "paneId").or_else(|| field(p, "id")) else {
        return Ok(invalid("invalid_request"));
    };
    match action {
        "create" => {
            let (Some(task), Some(kind)) = (field(p, "taskId"), field(p, "kind")) else {
                return Ok(invalid("invalid_request"));
            };
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM task_panes WHERE id=?1)",
                params![id],
                |r| r.get(0),
            )?;
            if exists {
                return Ok(conflict());
            }
            if tx.execute("UPDATE tasks SET pane_order=json_insert(pane_order,'$[#]',?1),revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL",params![id,task,expected])?==0{return Ok(conflict())};
            tx.execute("INSERT INTO task_panes(id,task_id,kind,title,session_id,revision,created_at) VALUES(?1,?2,?3,?4,?5,1,strftime('%s','now'))",params![id,task,kind,p.get("title").and_then(serde_json::Value::as_str),p.get("sessionId").and_then(serde_json::Value::as_str)])?;
            if let Some(metadata) = p.get("metadata") {
                tx.execute_batch("CREATE TABLE IF NOT EXISTS pi_session_metadata (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL)")?;
                tx.execute("INSERT INTO pi_session_metadata(pane_id,session_id,metadata_json,created_at) VALUES(?1,?2,?3,strftime('%s','now'))", params![id, p.get("sessionId").and_then(serde_json::Value::as_str).unwrap_or(id), metadata.to_string()])?;
            }
            Ok(committed(serde_json::json!({"paneId":id,"revision":1}), 1))
        }
        "update" => {
            let n=tx.execute("UPDATE task_panes SET title=COALESCE(?1,title),session_id=COALESCE(?2,session_id),revision=revision+1 WHERE id=?3 AND revision=?4 AND tombstoned_at IS NULL",params![p.get("title").and_then(serde_json::Value::as_str),p.get("sessionId").and_then(serde_json::Value::as_str),id,expected])?;
            Ok(if n == 0 {
                conflict()
            } else {
                committed(
                    serde_json::json!({"paneId":id,"revision":expected+1}),
                    expected + 1,
                )
            })
        }
        "tombstone" => tombstone(tx, "task_panes", "pane", id, expected),
        _ => Ok(invalid("invalid_action")),
    }
}
fn ownership_mutation(
    tx: &rusqlite::Transaction<'_>,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let (Some(task), Some(device)) = (
        field(p, "taskId").or_else(|| field(p, "id")),
        field(p, "deviceId"),
    ) else {
        return Ok(invalid("invalid_request"));
    };
    let generation = p
        .get("generation")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(expected);
    let n=tx.execute("UPDATE tasks SET assigned_device_id=?1,execution_generation=execution_generation+1,revision=revision+1 WHERE id=?2 AND revision=?3 AND execution_generation=?4 AND tombstoned_at IS NULL",params![device,task,expected,generation])?;
    Ok(if n == 0 {
        conflict()
    } else {
        committed(
            serde_json::json!({"taskId":task,"generation":generation+1,"revision":expected+1}),
            expected + 1,
        )
    })
}
fn membership_mutation(
    tx: &rusqlite::Transaction<'_>,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let (Some(network), Some(device)) = (field(p, "networkId"), field(p, "deviceId")) else {
        return Ok(invalid("invalid_request"));
    };
    let voter = p.get("voter").and_then(serde_json::Value::as_bool);
    let healthy = p.get("healthy").and_then(serde_json::Value::as_bool);
    if voter.is_none() && healthy.is_none() {
        return Ok(invalid("invalid_request"));
    };
    if tx.execute("UPDATE networks SET revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",params![network,expected])?==0{return Ok(conflict())};
    let old: (i64, i64) = tx
        .query_row(
            "SELECT voter,healthy FROM coordinator_members WHERE network_id=?1 AND device_id=?2",
            params![network, device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, 1));
    tx.execute("INSERT INTO coordinator_members(network_id,device_id,voter,healthy,promoted_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(network_id,device_id) DO UPDATE SET voter=excluded.voter,healthy=excluded.healthy",params![network,device,voter.unwrap_or(old.0!=0)as i64,healthy.unwrap_or(old.1!=0)as i64])?;
    Ok(committed(
        serde_json::json!({"networkId":network,"deviceId":device,"revision":expected+1}),
        expected + 1,
    ))
}

fn cleanup_mutation(
    tx: &rusqlite::Transaction<'_>,
    action: &str,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    if !matches!(action, "complete" | "cleanup" | "authorize") {
        return Ok(invalid("invalid_action"));
    };
    let Some(task) = field(p, "taskId").or_else(|| field(p, "id")) else {
        return Ok(invalid("invalid_request"));
    };
    let n=tx.execute("UPDATE tasks SET lifecycle='completed',revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",params![task,expected])?;
    if n == 0 {
        return Ok(conflict());
    };
    let losses = p
        .get("knownLosses")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let result = p
        .get("result")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    tx.execute("INSERT INTO task_cleanup_receipts(task_id,retained_commit,known_losses_json,result_json,cleaned_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(task_id) DO UPDATE SET retained_commit=excluded.retained_commit,known_losses_json=excluded.known_losses_json,result_json=excluded.result_json,cleaned_at=excluded.cleaned_at",params![task,p.get("retainedCommit").and_then(serde_json::Value::as_str),losses.to_string(),result.to_string()])?;
    Ok(committed(
        serde_json::json!({"taskId":task,"revision":expected+1,"lifecycle":"completed"}),
        expected + 1,
    ))
}
fn migration_mutation(
    tx: &rusqlite::Transaction<'_>,
    expected: i64,
    p: &serde_json::Value,
) -> Result<CatalogResponse, rusqlite::Error> {
    let Some(network) = field(p, "networkId") else {
        return Ok(invalid("invalid_request"));
    };
    if tx.execute("UPDATE networks SET revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",params![network,expected])? == 0 { return Ok(conflict()); }
    if p.get("action").and_then(serde_json::Value::as_str) == Some("resolve_conflict") {
        let (
            Some(conflict_id),
            Some(revision_hash),
            Some(source_record_ids),
            Some(resolution_action),
            Some(mapping),
            Some(diff),
        ) = (
            field(p, "conflictId"),
            field(p, "revisionHash"),
            p.get("sourceRecordIds"),
            field(p, "resolutionAction"),
            p.get("mapping"),
            p.get("diff"),
        )
        else {
            return Ok(invalid("invalid_request"));
        };
        if !source_record_ids.is_array() || !mapping.is_object() {
            return Ok(invalid("invalid_request"));
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS migration_conflict_resolutions (conflict_id TEXT PRIMARY KEY, revision_hash TEXT NOT NULL, source_record_ids_json TEXT NOT NULL, action TEXT NOT NULL, mapping_json TEXT NOT NULL, diff_json TEXT NOT NULL, network_id TEXT NOT NULL, resolved_at INTEGER NOT NULL)")?;
        tx.execute("INSERT INTO migration_conflict_resolutions(conflict_id,revision_hash,source_record_ids_json,action,mapping_json,diff_json,network_id,resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,strftime('%s','now')) ON CONFLICT(conflict_id) DO NOTHING", params![conflict_id,revision_hash,source_record_ids.to_string(),resolution_action,mapping.to_string(),diff.to_string(),network])?;
        return Ok(committed(
            serde_json::json!({"conflictId":conflict_id,"revision":expected+1}),
            expected + 1,
        ));
    }
    let Some(records) = p
        .get("records")
        .or_else(|| p.get("batch"))
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(invalid("invalid_request"));
    };
    tx.execute_batch("CREATE TABLE IF NOT EXISTS legacy_import_records(operation_id TEXT NOT NULL,stable_key TEXT NOT NULL,kind TEXT NOT NULL,original_json TEXT NOT NULL,imported_id TEXT,PRIMARY KEY(operation_id,stable_key))")?;
    let batch = field(p, "batchId").unwrap_or("migration");
    for record in records {
        let (Some(key), Some(kind)) = (field(record, "stableKey"), field(record, "kind")) else {
            return Ok(invalid("invalid_request"));
        };
        tx.execute("INSERT INTO legacy_import_records(operation_id,stable_key,kind,original_json,imported_id) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(operation_id,stable_key) DO NOTHING",params![batch,key,kind,record.to_string(),record.get("importedId").and_then(serde_json::Value::as_str)])?;
    }
    Ok(committed(
        serde_json::json!({"networkId":network,"inserted":records.len(),"revision":expected+1}),
        expected + 1,
    ))
}

impl RaftStateMachine<CatalogType> for SqliteStore {
    type SnapshotBuilder = Self;
    async fn applied_state(
        &mut self,
    ) -> Result<(Option<LogId<NodeId>>, StoredMembership<NodeId, BasicNode>), StorageError<NodeId>>
    {
        let s = self.state()?;
        Ok((s.last, s.membership))
    }
    async fn apply<I>(&mut self, es: I) -> Result<Vec<CatalogResponse>, StorageError<NodeId>>
    where
        I: IntoIterator<Item = Entry<CatalogType>> + openraft::OptionalSend,
        I::IntoIter: openraft::OptionalSend,
    {
        let mut s = self.state()?;
        let mut r = vec![];
        for e in es {
            s.last = Some(e.log_id);
            match e.payload {
                EntryPayload::Normal(CatalogRequest::Put { key, value }) => {
                    s.data.insert(key, value.clone());
                    r.push(CatalogResponse::legacy(Some(value)))
                }
                EntryPayload::Normal(CatalogRequest::Delete { key }) => {
                    r.push(CatalogResponse::legacy(s.data.remove(&key)))
                }
                EntryPayload::Normal(request) => {
                    let (kind, operation_id, expected_revision, payload) = match request {
                        CatalogRequest::Network {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("network", operation_id, expected_revision, payload),
                        CatalogRequest::Device {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("device", operation_id, expected_revision, payload),
                        CatalogRequest::Membership {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("membership", operation_id, expected_revision, payload),
                        CatalogRequest::Project {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("project", operation_id, expected_revision, payload),
                        CatalogRequest::Task {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("task", operation_id, expected_revision, payload),
                        CatalogRequest::Pane {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("pane", operation_id, expected_revision, payload),
                        CatalogRequest::Ownership {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("ownership", operation_id, expected_revision, payload),
                        CatalogRequest::CleanupAuthorization {
                            operation_id,
                            expected_revision,
                            payload,
                        } => (
                            "cleanup_authorization",
                            operation_id,
                            expected_revision,
                            payload,
                        ),
                        CatalogRequest::Migration {
                            operation_id,
                            expected_revision,
                            payload,
                        } => ("migration", operation_id, expected_revision, payload),
                        CatalogRequest::Put { .. } | CatalogRequest::Delete { .. } => {
                            unreachable!()
                        }
                    };
                    let mut c = self.db.lock().unwrap();
                    let tx = c.transaction().map_err(Self::err)?;
                    // Projection branches intentionally perform several writes before their
                    // final optimistic fence. Isolate each entry so a conflict, validation
                    // response, or input constraint cannot leave those earlier writes visible.
                    tx.execute_batch("SAVEPOINT catalog_apply")
                        .map_err(Self::err)?;
                    let response = match apply_catalog_projection(
                        &tx,
                        kind,
                        &operation_id,
                        expected_revision,
                        &payload,
                    ) {
                        Ok(response) => response,
                        Err(error) if is_catalog_constraint(&error) => {
                            // Duplicate IDs, malformed references, and other constraints are
                            // request errors. They must not poison Raft apply and be replayed as
                            // a fatal storage error on every restart.
                            invalid("invalid_request")
                        }
                        Err(error) => {
                            let _ = tx
                                .execute_batch("ROLLBACK TO catalog_apply; RELEASE catalog_apply");
                            return Err(Self::err(error));
                        }
                    };
                    if response.status == "committed" {
                        tx.execute_batch("RELEASE catalog_apply")
                            .map_err(Self::err)?;
                    } else {
                        tx.execute_batch("ROLLBACK TO catalog_apply; RELEASE catalog_apply")
                            .map_err(Self::err)?;
                    }
                    tx.commit().map_err(Self::err)?;
                    r.push(response);
                }
                EntryPayload::Membership(m) => {
                    // Raft membership is authoritative for node addresses. Mirror committed
                    // address changes into the relational routing projection on every peer so
                    // forwarded client writes do not keep dialing a stale connector URL.
                    let c = self.db.lock().unwrap();
                    for (node_id, node) in m.nodes() {
                        c.execute(
                            "UPDATE raft_node_members SET endpoint=?1 WHERE network_id=?2 AND node_id=?3",
                            params![node.addr, self.network_id, *node_id as i64],
                        )
                        .map_err(Self::err)?;
                        c.execute(
                            "UPDATE device_connectors SET endpoint=?1,updated_at=strftime('%s','now') WHERE device_id=(SELECT device_id FROM raft_node_members WHERE network_id=?2 AND node_id=?3)",
                            params![node.addr, self.network_id, *node_id as i64],
                        )
                        .map_err(Self::err)?;
                    }
                    drop(c);
                    s.membership = StoredMembership::new(Some(e.log_id), m);
                    r.push(CatalogResponse::legacy(None))
                }
                EntryPayload::Blank => r.push(CatalogResponse::legacy(None)),
            }
        }
        self.put_state(&s)?;
        self.applied.notify_waiters();
        Ok(r)
    }
    async fn get_snapshot_builder(&mut self) -> Self {
        self.clone()
    }
    async fn begin_receiving_snapshot(
        &mut self,
    ) -> Result<Box<Cursor<Vec<u8>>>, StorageError<NodeId>> {
        Ok(Box::new(Cursor::new(vec![])))
    }
    async fn install_snapshot(
        &mut self,
        m: &SnapshotMeta<NodeId, BasicNode>,
        x: Box<Cursor<Vec<u8>>>,
    ) -> Result<(), StorageError<NodeId>> {
        let payload = x.into_inner();
        let b: SnapshotBlob = serde_json::from_slice(&payload).map_err(Self::err)?;
        if !b.catalog.is_empty() {
            restore_catalog(&mut self.db.lock().unwrap(), &self.network_id, &b.catalog)
                .map_err(Self::err)?;
        }
        self.put_state(&State {
            last: m.last_log_id,
            membership: m.last_membership.clone(),
            data: b.data,
        })?;
        self.db.lock().unwrap().execute(
            "INSERT INTO raft_snapshots(network_id,last_log_index,last_log_term,payload,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(network_id) DO UPDATE SET last_log_index=excluded.last_log_index,last_log_term=excluded.last_log_term,payload=excluded.payload,created_at=excluded.created_at",
            params![self.network_id,m.last_log_id.map(|x|x.index as i64).unwrap_or(0),m.last_log_id.map(|x|x.leader_id.term as i64).unwrap_or(0),payload],
        ).map_err(Self::err)?;
        Ok(())
    }
    async fn get_current_snapshot(
        &mut self,
    ) -> Result<Option<Snapshot<CatalogType>>, StorageError<NodeId>> {
        // A restarted node must advertise its durable snapshot; returning None here makes a
        // follower replay an already-compacted log after every restart.
        let c = self.db.lock().unwrap();
        let blob: Option<Vec<u8>> = c
            .query_row(
                "SELECT payload FROM raft_snapshots WHERE network_id=?1",
                params![self.network_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Self::err)?;
        drop(c);
        let Some(blob) = blob else { return Ok(None) };
        let state: SnapshotBlob = serde_json::from_slice(&blob).map_err(Self::err)?;
        Ok(Some(Snapshot {
            meta: SnapshotMeta {
                last_log_id: state.last,
                last_membership: state.membership,
                snapshot_id: format!("catalog-{}", state.last.map(|x| x.index).unwrap_or(0)),
            },
            snapshot: Box::new(Cursor::new(blob)),
        }))
    }
}

static REGISTRY: OnceLock<Mutex<HashMap<NodeId, CatalogRaftInner>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<NodeId, CatalogRaftInner>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
pub struct InProcessNetwork;
pub struct InProcessClient {
    target: NodeId,
}
fn unreachable<E: std::error::Error>() -> RPCError<NodeId, BasicNode, E> {
    RPCError::Unreachable(Unreachable::new(&std::io::Error::new(
        std::io::ErrorKind::ConnectionRefused,
        "raft peer offline",
    )))
}
impl RaftNetworkFactory<CatalogType> for InProcessNetwork {
    type Network = InProcessClient;
    async fn new_client(&mut self, target: NodeId, _: &BasicNode) -> Self::Network {
        InProcessClient { target }
    }
}
impl RaftNetwork<CatalogType> for InProcessClient {
    async fn append_entries(
        &mut self,
        r: AppendEntriesRequest<CatalogType>,
        _: RPCOption,
    ) -> Result<
        AppendEntriesResponse<NodeId>,
        RPCError<NodeId, BasicNode, openraft::error::RaftError<NodeId>>,
    > {
        let target = { registry().lock().unwrap().get(&self.target).cloned() };
        match target {
            Some(x) => x
                .append_entries(r)
                .await
                .map_err(|e| RPCError::Network(openraft::error::NetworkError::new(&e))),
            None => Err(unreachable()),
        }
    }
    async fn vote(
        &mut self,
        r: VoteRequest<NodeId>,
        _: RPCOption,
    ) -> Result<VoteResponse<NodeId>, RPCError<NodeId, BasicNode, openraft::error::RaftError<NodeId>>>
    {
        let target = { registry().lock().unwrap().get(&self.target).cloned() };
        match target {
            Some(x) => x
                .vote(r)
                .await
                .map_err(|e| RPCError::Network(openraft::error::NetworkError::new(&e))),
            None => Err(unreachable()),
        }
    }
    async fn full_snapshot(
        &mut self,
        vote: Vote<NodeId>,
        snapshot: Snapshot<CatalogType>,
        _cancel: impl std::future::Future<Output = ReplicationClosed> + openraft::OptionalSend + 'static,
        _: RPCOption,
    ) -> Result<
        SnapshotResponse<NodeId>,
        openraft::error::StreamingError<CatalogType, openraft::error::Fatal<NodeId>>,
    > {
        let target = { registry().lock().unwrap().get(&self.target).cloned() };
        match target {
            Some(x) => x.install_full_snapshot(vote, snapshot).await.map_err(|e| {
                openraft::error::StreamingError::Network(openraft::error::NetworkError::new(&e))
            }),
            None => Err(openraft::error::StreamingError::Unreachable(
                Unreachable::new(&std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "raft peer offline",
                )),
            )),
        }
    }
}

/// Production Raft transport. `BasicNode.addr` is the authenticated connector base URL.
/// The test-only in-process transport below remains available through `new_in_process`.
#[derive(Clone)]
pub struct HttpNetwork {
    db: String,
    network_id: String,
    client: reqwest::Client,
}
pub struct HttpClient {
    url: String,
    token: String,
    client: reqwest::Client,
}
fn http_error<E: std::error::Error + 'static>(
    e: E,
) -> RPCError<NodeId, BasicNode, openraft::error::RaftError<NodeId>> {
    RPCError::Network(openraft::error::NetworkError::new(&e))
}
impl RaftNetworkFactory<CatalogType> for HttpNetwork {
    type Network = HttpClient;
    async fn new_client(&mut self, id: NodeId, node: &BasicNode) -> Self::Network {
        // Do not reuse the connector's UI token: a Raft RPC is authorized by the target's
        // durable enrollment credential.
        let token = Connection::open(&self.db).ok().and_then(|c| c.query_row(
            "SELECT c.credential FROM raft_node_members r JOIN device_connectors c ON c.device_id=r.device_id WHERE r.network_id=?1 AND r.node_id=?2",
            params![self.network_id, id as i64], |row| row.get(0)).optional().ok().flatten()
        ).unwrap_or_default();
        HttpClient {
            url: node.addr.trim_end_matches('/').to_string(),
            token,
            client: self.client.clone(),
        }
    }
}
impl HttpClient {
    async fn post<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        request: &T,
    ) -> Result<R, reqwest::Error> {
        self.client
            .post(format!("{}/api/raft/{path}", self.url))
            .bearer_auth(&self.token)
            .json(request)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }
}
impl RaftNetwork<CatalogType> for HttpClient {
    async fn append_entries(
        &mut self,
        r: AppendEntriesRequest<CatalogType>,
        _: RPCOption,
    ) -> Result<
        AppendEntriesResponse<NodeId>,
        RPCError<NodeId, BasicNode, openraft::error::RaftError<NodeId>>,
    > {
        self.post("append", &r).await.map_err(http_error)
    }
    async fn vote(
        &mut self,
        r: VoteRequest<NodeId>,
        _: RPCOption,
    ) -> Result<VoteResponse<NodeId>, RPCError<NodeId, BasicNode, openraft::error::RaftError<NodeId>>>
    {
        self.post("vote", &r).await.map_err(http_error)
    }
    async fn full_snapshot(
        &mut self,
        vote: Vote<NodeId>,
        mut snapshot: Snapshot<CatalogType>,
        _cancel: impl std::future::Future<Output = ReplicationClosed> + openraft::OptionalSend + 'static,
        _: RPCOption,
    ) -> Result<
        SnapshotResponse<NodeId>,
        openraft::error::StreamingError<CatalogType, openraft::error::Fatal<NodeId>>,
    > {
        let mut data = Vec::new();
        snapshot.snapshot.read_to_end(&mut data).map_err(|e| {
            openraft::error::StreamingError::Network(openraft::error::NetworkError::new(&e))
        })?;
        let request: InstallSnapshotRequest<CatalogType> = InstallSnapshotRequest {
            vote,
            meta: snapshot.meta,
            offset: 0,
            data,
            done: true,
        };
        let response = self.post("snapshot", &request).await.map_err(|e| {
            openraft::error::StreamingError::Network(openraft::error::NetworkError::new(&e))
        })?;
        Ok(response)
    }
}

/// Production catalog facade.  It owns the Raft client and exposes only committed writes;
/// SQLite is a projection for reads, never a second write authority.
pub struct CatalogService {
    raft: Arc<CatalogRaft>,
    db: String,
    network_id: String,
}
type CatalogInstanceKey = (String, String, NodeId);
static CATALOG_INSTANCES: OnceLock<
    tokio::sync::Mutex<HashMap<CatalogInstanceKey, std::sync::Weak<CatalogRaft>>>,
> = OnceLock::new();
fn catalog_instances(
) -> &'static tokio::sync::Mutex<HashMap<CatalogInstanceKey, std::sync::Weak<CatalogRaft>>> {
    CATALOG_INSTANCES.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}
fn refresh_catalog_endpoint(
    db: &str,
    network_id: &str,
    node_id: NodeId,
    endpoint: &str,
) -> anyhow::Result<()> {
    // Command-only callers use this sentinel because they do not own a listener. Never let one
    // replace the routable address published by the connector that owns the cached Raft engine.
    if endpoint == "http://127.0.0.1:0" {
        return Ok(());
    }
    let conn = Connection::open(db)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute(
        "UPDATE catalog_nodes SET endpoint=?1,updated_at=strftime('%s','now') WHERE network_id=?2 AND node_id=?3",
        params![endpoint, network_id, node_id as i64],
    )?;
    conn.execute(
        "UPDATE raft_node_members SET endpoint=?1 WHERE network_id=?2 AND node_id=?3",
        params![endpoint, network_id, node_id as i64],
    )?;
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CatalogError {
    pub code: String,
    pub message: String,
}
impl CatalogService {
    /// Waits until this process has projected a committed operation. Unlike polling, the state
    /// machine wakes all waiters after an apply batch and the database is checked only at event
    /// boundaries. A timeout means "committed but this local projection is delayed".
    pub async fn wait_for_operation(
        &self,
        operation_id: &str,
        timeout: std::time::Duration,
    ) -> Result<bool, CatalogError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Register before checking the receipt so an apply between the query and await cannot
            // be missed. Notify is only a wake-up edge; the durable receipt remains authoritative.
            let notified = self.raft.store.applied.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let applied = Connection::open(&self.db)
                .and_then(|conn| {
                    conn.busy_timeout(std::time::Duration::from_secs(10))?;
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM operation_dedup WHERE operation_id=?1)",
                        [operation_id],
                        |row| row.get::<_, bool>(0),
                    )
                })
                .map_err(|error| CatalogError {
                    code: "catalog_unavailable".into(),
                    message: error.to_string(),
                })?;
            if applied {
                return Ok(true);
            }
            match tokio::time::timeout_at(deadline, notified).await {
                Ok(_) => {}
                Err(_) => return Ok(false),
            }
        }
    }

    pub async fn open(
        db: impl Into<String>,
        network_id: impl Into<String>,
        node_id: NodeId,
        token: impl Into<String>,
        endpoint: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let db = db.into();
        let network_id = network_id.into();
        let endpoint = endpoint.into();
        // A process must own exactly one Raft engine for a given local catalog. Commands used to
        // reopen a complete engine for every mutation, so its state-machine transaction raced the
        // server-owned engine over the same SQLite file and surfaced as `database is locked`.
        // Serialize discovery/creation as well as caching: two concurrent first callers must not
        // both get past a weak-cache miss.
        let key = (db.clone(), network_id.clone(), node_id);
        let mut instances = catalog_instances().lock().await;
        if let Some(raft) = instances.get(&key).and_then(std::sync::Weak::upgrade) {
            refresh_catalog_endpoint(&db, &network_id, node_id, &endpoint)?;
            return Ok(Self {
                raft,
                db,
                network_id,
            });
        }
        let conn = Connection::open(&db)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        crate::network::migrate(&conn)?;
        conn.execute("INSERT INTO catalog_nodes(network_id,node_id,endpoint,updated_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(network_id) DO UPDATE SET endpoint=excluded.endpoint,updated_at=excluded.updated_at", params![network_id, node_id as i64, endpoint])?;
        let bound_device: Option<String> = conn
            .query_row(
                "SELECT device_id FROM raft_node_members WHERE network_id=?1 AND node_id=?2",
                params![network_id, node_id as i64],
                |r| r.get(0),
            )
            .optional()?;
        let local_device = match bound_device {
            Some(device_id) => Some(device_id),
            None => conn.query_row("SELECT id FROM devices WHERE network_id=?1 AND enrollment_id IN ('local-device', 'joined-device') AND tombstoned_at IS NULL ORDER BY created_at LIMIT 1", [&network_id], |r| r.get::<_, String>(0)).optional()?,
        };
        if let Some(device_id) = local_device.as_deref() {
            conn.execute("INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES(?1,?2,?3,?4) ON CONFLICT(network_id,device_id) DO UPDATE SET node_id=excluded.node_id,endpoint=excluded.endpoint", params![network_id,device_id,node_id as i64,endpoint])?;
        }
        let fixed_server: Option<String> = conn.query_row(
            "SELECT server_device_id FROM networks WHERE id=?1",
            [&network_id],
            |row| row.get(0),
        )?;
        let bootstrap = if let Some(server) = fixed_server {
            local_device.as_deref() == Some(server.as_str())
        } else if let Some(device) = local_device.as_deref() {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM devices WHERE id=?1 AND network_id=?2 AND enrollment_id='local-device' AND tombstoned_at IS NULL)",
                params![device, network_id],
                |row| row.get::<_, bool>(0),
            )?
        } else {
            false
        };
        drop(conn);
        let raft = Arc::new(CatalogRaft::new(node_id, &db, &network_id, token).await?);
        // Only the device that created the network bootstraps the cluster. Enrolled peers must
        // remain uninitialized until the coordinator adds them as learners and changes membership.
        if bootstrap {
            let _ = raft.initialize(BasicNode::new(endpoint)).await;
        }
        instances.insert(key, Arc::downgrade(&raft));
        Ok(Self {
            raft,
            db,
            network_id,
        })
    }
    /// Reopens the sole local catalog using durable network/device/node identity.
    pub async fn open_discovered(
        db: impl Into<String>,
        token: impl Into<String>,
        endpoint: impl Into<String>,
    ) -> anyhow::Result<Option<Self>> {
        let db = db.into();
        // The connector owns the process's catalog lifetime. Command handlers reuse it without
        // reopening SQLite, rediscovering identity, or publishing their placeholder endpoint.
        {
            let instances = catalog_instances().lock().await;
            if let Some((network_id, raft)) =
                instances.iter().find_map(|((path, network_id, _), value)| {
                    (path == &db)
                        .then(|| value.upgrade().map(|raft| (network_id.clone(), raft)))
                        .flatten()
                })
            {
                return Ok(Some(Self {
                    raft,
                    db,
                    network_id,
                }));
            }
        }
        let conn = Connection::open(&db)?;
        crate::network::migrate(&conn)?;
        let network_id: Option<String> = conn.query_row("SELECT id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1", [], |r| r.get(0)).optional()?;
        let Some(network_id) = network_id else {
            return Ok(None);
        };
        let stored: Option<(i64, String)> = conn
            .query_row(
                "SELECT node_id,endpoint FROM catalog_nodes WHERE network_id=?1",
                [&network_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let node_id = stored.as_ref().map(|(id, _)| *id as u64).unwrap_or_else(|| conn.query_row("SELECT id FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL", [&network_id], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|id| u64::from_str_radix(id.rsplit('_').next().unwrap_or("0").get(..16).unwrap_or("0"), 16).ok()).unwrap_or(1));
        let endpoint = stored
            .map(|(_, endpoint)| endpoint)
            .unwrap_or_else(|| endpoint.into());
        drop(conn);
        Self::open(db, network_id, node_id, token, endpoint)
            .await
            .map(Some)
    }
    pub fn raft(&self) -> &Arc<CatalogRaft> {
        &self.raft
    }
    pub async fn client_write(
        &self,
        request: CatalogRequest,
    ) -> Result<CatalogResponse, CatalogError> {
        let response = match self.raft.client_write(request.clone()).await {
            Ok(response) => response.data,
            Err(local_error) => {
                // Learners and followers forward the original idempotent request to the elected
                // leader using the durable peer credential used by Raft replication. Prefer the
                // leader attached to this specific error: metrics can lag an election and used to
                // send writes to a stale leader, whose redirect was surfaced as a 502.
                let mut leader = local_error
                    .forward_to_leader()
                    .and_then(|forward| forward.leader_id)
                    .or_else(|| self.raft.current_leader())
                    .ok_or_else(|| catalog_error(&local_error))?;
                let client = reqwest::Client::new();
                let mut visited = HashSet::new();
                loop {
                    if !visited.insert(leader) || visited.len() > 4 {
                        return Err(CatalogError {
                            code: "catalog_unavailable".into(),
                            message: "catalog leader redirect loop".into(),
                        });
                    }
                    let peer: Option<(String, String)> = Connection::open(&self.db)
                        .ok()
                        .and_then(|conn| conn.query_row(
                            "SELECT r.endpoint,c.credential FROM raft_node_members r JOIN device_connectors c ON c.device_id=r.device_id WHERE r.network_id=?1 AND r.node_id=?2",
                            params![self.network_id, leader as i64],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        ).optional().ok().flatten());
                    let Some((endpoint, credential)) = peer else {
                        return Err(CatalogError {
                            code: "catalog_unavailable".into(),
                            message: format!("catalog leader {leader} is not a registered peer"),
                        });
                    };
                    let remote = client
                        .post(format!("{}/api/raft/write", endpoint.trim_end_matches('/')))
                        .bearer_auth(credential)
                        .json(&request)
                        .send()
                        .await
                        .map_err(|error| CatalogError {
                            code: "catalog_unavailable".into(),
                            message: error.to_string(),
                        })?;
                    let status = remote.status();
                    let body = remote.bytes().await.map_err(|error| CatalogError {
                        code: "catalog_unavailable".into(),
                        message: error.to_string(),
                    })?;
                    if status.is_success() {
                        break serde_json::from_slice::<CatalogResponse>(&body).map_err(
                            |error| CatalogError {
                                code: "catalog_unavailable".into(),
                                message: error.to_string(),
                            },
                        )?;
                    }
                    let error: serde_json::Value =
                        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                    if error.get("code").and_then(serde_json::Value::as_str) == Some("not_leader") {
                        if let Some(next) =
                            error.get("leaderId").and_then(serde_json::Value::as_u64)
                        {
                            leader = next;
                            continue;
                        }
                    }
                    return Err(CatalogError {
                        code: error
                            .get("code")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("catalog_unavailable")
                            .into(),
                        message: error
                            .get("error")
                            .or_else(|| error.get("message"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("HTTP status {status}")),
                    });
                }
            }
        };
        if response.status == "revision_conflict" || response.status == "operation_id_conflict" {
            return Err(CatalogError {
                code: response.status.clone(),
                message: response.status,
            });
        }
        Ok(response)
    }
    /// Reads the local committed projection. The returned index/status prevents callers from
    /// mistaking a follower's stale view for a linearizable response.
    pub fn snapshot(&self) -> Result<serde_json::Value, CatalogError> {
        Connection::open(&self.db).map_err(|e| CatalogError {
            code: "catalog_unavailable".into(),
            message: e.to_string(),
        })?;
        let revision = self
            .raft
            .store
            .state()
            .ok()
            .and_then(|s| s.last.map(|x| x.index as i64));
        Ok(
            serde_json::json!({"networkId":self.network_id,"status":"committed_local","revision":revision}),
        )
    }
}

fn catalog_error(error: impl ToString) -> CatalogError {
    let message = error.to_string();
    let code = if message.contains("ForwardToLeader") || message.contains("leader") {
        "not_leader"
    } else if message.contains("quorum") || message.contains("Unreachable") {
        "quorum_unavailable"
    } else {
        "catalog_unavailable"
    };
    CatalogError {
        code: code.into(),
        message,
    }
}

pub struct CatalogRaft {
    pub raft: CatalogRaftInner,
    pub store: SqliteStore,
    pub id: NodeId,
}
impl CatalogRaft {
    pub fn current_leader(&self) -> Option<NodeId> {
        self.raft.metrics().borrow().current_leader
    }

    /// Starts the production catalog using connector URLs stored in `BasicNode`.
    pub async fn new(
        id: NodeId,
        path: &str,
        network_id: &str,
        _token: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let store = SqliteStore::open(path, network_id)?;
        let cfg = Arc::new(
            Config {
                // Production peers communicate across the device mesh. Sub-second election
                // windows make a newly promoted remote voter pre-empt the healthy leader before
                // the joint-consensus entry can commit.
                election_timeout_min: 3_000,
                election_timeout_max: 5_000,
                heartbeat_interval: 500,
                ..Config::default()
            }
            .validate()?,
        );
        let raft = Raft::new(
            id,
            cfg,
            HttpNetwork {
                db: path.into(),
                network_id: network_id.into(),
                client: reqwest::Client::new(),
            },
            store.clone(),
            store.clone(),
        )
        .await?;
        Ok(Self { raft, store, id })
    }
    /// Test harness only: production callers must use connector addresses via `new`.
    #[cfg(test)]
    pub async fn new_in_process(id: NodeId, path: &str, network_id: &str) -> anyhow::Result<Self> {
        let store = SqliteStore::open(path, network_id)?;
        let cfg = Arc::new(
            Config {
                election_timeout_min: 100,
                election_timeout_max: 200,
                heartbeat_interval: 50,
                ..Config::default()
            }
            .validate()?,
        );
        let raft = Raft::new(id, cfg, InProcessNetwork, store.clone(), store.clone()).await?;
        registry().lock().unwrap().insert(id, raft.clone());
        Ok(Self { raft, store, id })
    }
    pub async fn initialize(
        &self,
        node: BasicNode,
    ) -> Result<
        (),
        openraft::error::RaftError<NodeId, openraft::error::InitializeError<NodeId, BasicNode>>,
    > {
        self.raft
            .initialize(BTreeMap::from([(self.id, node)]))
            .await
    }
    pub async fn client_write(
        &self,
        r: CatalogRequest,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CatalogType>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, BasicNode>>,
    > {
        self.raft.client_write(r).await
    }
    pub async fn add_learner(
        &self,
        id: NodeId,
        node: BasicNode,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CatalogType>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, BasicNode>>,
    > {
        self.raft.add_learner(id, node, true).await
    }
    pub async fn update_node(
        &self,
        id: NodeId,
        node: BasicNode,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CatalogType>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, BasicNode>>,
    > {
        self.raft
            .change_membership(
                openraft::ChangeMembers::SetNodes(BTreeMap::from([(id, node)])),
                true,
            )
            .await
    }
    pub async fn change_membership(
        &self,
        m: impl IntoIterator<Item = NodeId>,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CatalogType>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, BasicNode>>,
    > {
        self.raft.change_membership(m, true).await
    }
    pub async fn remove_learners(
        &self,
        ids: impl IntoIterator<Item = NodeId>,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CatalogType>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, BasicNode>>,
    > {
        self.raft
            .change_membership(
                openraft::ChangeMembers::RemoveNodes(ids.into_iter().collect()),
                true,
            )
            .await
    }
    pub fn metrics(
        &self,
    ) -> tokio::sync::watch::Receiver<openraft::RaftMetrics<NodeId, BasicNode>> {
        self.raft.metrics()
    }
    pub async fn trigger_snapshot(&self) -> Result<(), openraft::error::Fatal<NodeId>> {
        self.raft.trigger().snapshot().await
    }
    pub async fn append(
        &self,
        r: AppendEntriesRequest<CatalogType>,
    ) -> Result<AppendEntriesResponse<NodeId>, openraft::error::RaftError<NodeId>> {
        self.raft.append_entries(r).await
    }
    pub async fn vote(
        &self,
        r: VoteRequest<NodeId>,
    ) -> Result<VoteResponse<NodeId>, openraft::error::RaftError<NodeId>> {
        self.raft.vote(r).await
    }
    pub async fn shutdown(&self) {
        registry().lock().unwrap().remove(&self.id);
        let _ = self.raft.shutdown().await;
    }
}

/// Serializable envelope suitable for a remote transport to dispatch to `append`, `vote` and `full_snapshot`.
#[derive(Serialize, Deserialize)]
pub enum RpcRequest {
    Append(AppendEntriesRequest<CatalogType>),
    Vote(VoteRequest<NodeId>),
    Snapshot(InstallSnapshotRequest<CatalogType>),
}

#[cfg(test)]
mod raft_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::time::{sleep, Duration};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn path(id: u64) -> String {
        std::env::temp_dir()
            .join(format!("swath-raft-{}-{}", std::process::id(), id))
            .display()
            .to_string()
    }
    async fn write_until_leader(nodes: &[&CatalogRaft], key: &str) {
        for _ in 0..40 {
            for node in nodes {
                if node
                    .client_write(CatalogRequest::Put {
                        key: key.into(),
                        value: "ok".into(),
                    })
                    .await
                    .is_ok()
                {
                    return;
                }
            }
            sleep(Duration::from_millis(100)).await;
        }
        panic!("no leader accepted write");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enrolled_peer_does_not_bootstrap_a_separate_cluster() {
        let database = path(NEXT.fetch_add(1, Ordering::Relaxed) + 40_000);
        let conn = Connection::open(&database).unwrap();
        crate::network::migrate(&conn).unwrap();
        conn.execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('joined','n',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('server','joined','Server','server','test','local-device',1,0),('peer','joined','Peer','peer','test','joined-device',1,0); UPDATE networks SET server_device_id='server' WHERE id='joined'; INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES('joined','peer',42,'http://127.0.0.1:1');").unwrap();
        drop(conn);
        let service = CatalogService::open(
            &database,
            "joined",
            42,
            "0123456789abcdef",
            "http://127.0.0.1:1",
        )
        .await
        .unwrap();
        let reopened = CatalogService::open(
            &database,
            "joined",
            42,
            "local-task-rpc",
            "http://127.0.0.1:0",
        )
        .await
        .unwrap();
        assert!(Arc::ptr_eq(service.raft(), reopened.raft()));
        assert_eq!(
            Connection::open(&database)
                .unwrap()
                .query_row(
                    "SELECT endpoint FROM catalog_nodes WHERE network_id='joined' AND node_id=42",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "http://127.0.0.1:1"
        );
        let republished = CatalogService::open(
            &database,
            "joined",
            42,
            "local-task-rpc",
            "https://peer.example:9443/",
        )
        .await
        .unwrap();
        assert!(Arc::ptr_eq(service.raft(), republished.raft()));
        assert_eq!(
            Connection::open(&database)
                .unwrap()
                .query_row(
                    "SELECT endpoint FROM catalog_nodes WHERE network_id='joined' AND node_id=42",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "https://peer.example:9443/"
        );
        sleep(Duration::from_millis(300)).await;
        assert!(service
            .raft
            .raft
            .metrics()
            .borrow()
            .current_leader
            .is_none());
        drop(reopened);
        drop(republished);
        service.raft.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn three_nodes_fail_over_and_commit() {
        let base = NEXT.fetch_add(3, Ordering::Relaxed) + 1;
        let n1 = CatalogRaft::new_in_process(1, &path(base), "cluster")
            .await
            .unwrap();
        let n2 = CatalogRaft::new_in_process(2, &path(base + 1), "cluster")
            .await
            .unwrap();
        let n3 = CatalogRaft::new_in_process(3, &path(base + 2), "cluster")
            .await
            .unwrap();
        n1.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        n1.add_learner(2, BasicNode::new("n2")).await.unwrap();
        n1.add_learner(3, BasicNode::new("n3")).await.unwrap();
        n1.change_membership([1, 2, 3]).await.unwrap();
        write_until_leader(&[&n1], "before").await;
        n1.shutdown().await;
        write_until_leader(&[&n2, &n3], "after").await;
        assert!(n2.store.get("after").is_some() || n3.store.get("after").is_some());
        n2.shutdown().await;
        n3.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn catalog_projection_is_revision_fenced_and_deduplicated() {
        let base = NEXT.fetch_add(1, Ordering::Relaxed) + 9_000;
        let node = CatalogRaft::new_in_process(81, &path(base), "catalog")
            .await
            .unwrap();
        node.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        node.store.db.lock().unwrap().execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('catalog','before',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('server','catalog','Server','server','test','local-device',1,0); INSERT INTO coordinator_members(network_id,device_id,voter,healthy,promoted_at) VALUES('catalog','server',1,1,0);").unwrap();
        let request = CatalogRequest::Network {
            operation_id: "rename-1".into(),
            expected_revision: 1,
            payload: serde_json::json!({"networkId":"catalog","name":"after"}),
        };
        let response = node.client_write(request.clone()).await.unwrap().data;
        assert_eq!(response.revision, Some(2));
        assert_eq!(
            node.client_write(request).await.unwrap().data.revision,
            Some(2)
        );
        let stale = node
            .client_write(CatalogRequest::Network {
                operation_id: "rename-2".into(),
                expected_revision: 1,
                payload: serde_json::json!({"networkId":"catalog","name":"stale"}),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(stale.status, "revision_conflict");
        let topology = node
            .client_write(CatalogRequest::Network {
                operation_id: "single-server".into(),
                expected_revision: 2,
                payload: serde_json::json!({"action":"set_server","networkId":"catalog","serverDeviceId":"server"}),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(topology.revision, Some(3));
        let server: String = node
            .store
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT server_device_id FROM networks WHERE id='catalog'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(server, "server");
        node.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn catalog_project_task_mutations_are_fenced_and_idempotent() {
        let base = NEXT.fetch_add(1, Ordering::Relaxed) + 30_000;
        let node = CatalogRaft::new_in_process(111, &path(base), "catalog-mutations")
            .await
            .unwrap();
        node.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        node.store.db.lock().unwrap().execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','Network',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('d','n','Device','device','test','local-device',1,0);").unwrap();
        let create = CatalogRequest::Project {
            operation_id: "project:create".into(),
            expected_revision: 0,
            payload: serde_json::json!({"action":"create","projectId":"p","networkId":"n","name":"Project","defaultBranch":"main"}),
        };
        assert_eq!(
            node.client_write(create.clone())
                .await
                .unwrap()
                .data
                .revision,
            Some(1)
        );
        assert_eq!(
            node.client_write(create).await.unwrap().data.revision,
            Some(1)
        );
        assert_eq!(node.client_write(CatalogRequest::Project { operation_id: "project:create".into(), expected_revision: 0, payload: serde_json::json!({"action":"create","projectId":"p2","networkId":"n","name":"Other","defaultBranch":"main"}) }).await.unwrap().data.status, "operation_id_conflict");
        assert_eq!(
            node.client_write(CatalogRequest::Project {
                operation_id: "project:stale".into(),
                expected_revision: 0,
                payload: serde_json::json!({"action":"update","projectId":"p","name":"stale"})
            })
            .await
            .unwrap()
            .data
            .status,
            "revision_conflict"
        );
        assert_eq!(node.client_write(CatalogRequest::Task { operation_id: "task:create".into(), expected_revision: 1, payload: serde_json::json!({"action":"create","taskId":"t","projectId":"p","title":"Task","deviceId":"d","baseCommit":"abc","worktreePath":"/tmp/t"}) }).await.unwrap().data.revision, Some(1));
        let stale_provision = node
            .client_write(CatalogRequest::Task {
                operation_id: "task:provision-stale".into(),
                expected_revision: 99,
                payload: serde_json::json!({
                    "action":"provision_ready",
                    "taskId":"t",
                    "paneId":"stale-pane"
                }),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(stale_provision.status, "revision_conflict");
        {
            let conn = node.store.db.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT state FROM task_provisioning WHERE task_id='t'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                "pending"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM task_panes WHERE id='stale-pane'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
        assert_eq!(
            node.client_write(CatalogRequest::Task {
                operation_id: "task:order".into(),
                expected_revision: 1,
                payload: serde_json::json!({"action":"reorder_panes","taskId":"t","paneIds":[]})
            })
            .await
            .unwrap()
            .data
            .revision,
            Some(2)
        );
        assert_eq!(node.client_write(CatalogRequest::Task { operation_id: "task:lifecycle".into(), expected_revision: 2, payload: serde_json::json!({"action":"lifecycle","taskId":"t","lifecycle":"completed"}) }).await.unwrap().data.revision, Some(3));
        // A delete observed on a lagging learner remains valid after the record changed on the
        // leader. Removal is monotonic, unlike edits and reorders, which remain exactly fenced.
        let removed = node
            .client_write(CatalogRequest::Project {
                operation_id: "project:remove-stale".into(),
                expected_revision: 1,
                payload: serde_json::json!({"action":"tombstone","projectId":"p"}),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(removed.revision, Some(3));
        assert_eq!(
            node.store
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT revision FROM projects WHERE id='p' AND tombstoned_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3,
        );
        let removed_again = node
            .client_write(CatalogRequest::Project {
                operation_id: "project:remove-again".into(),
                expected_revision: 99,
                payload: serde_json::json!({"action":"tombstone","projectId":"p"}),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(removed_again.status, "committed");
        assert_eq!(removed_again.revision, Some(3));
        node.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enrollment_is_pending_then_issues_one_durable_credential() {
        let base = NEXT.fetch_add(1, Ordering::Relaxed) + 20_000;
        let node = CatalogRaft::new_in_process(101, &path(base), "enroll")
            .await
            .unwrap();
        node.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        node.store.db.lock().unwrap().execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('enroll','n',2,1,0)", []).unwrap();
        let request = CatalogRequest::Device {
            operation_id: "join:one".into(),
            expected_revision: 0,
            payload: serde_json::json!({"action":"join_request","networkId":"enroll","enrollmentId":"one","secret":"0123456789abcdef","nodeId":102,"connectorEndpoint":"http://127.0.0.1:9999"}),
        };
        assert_eq!(
            node.client_write(request.clone())
                .await
                .unwrap()
                .data
                .status,
            "committed"
        );
        assert_eq!(
            node.client_write(request).await.unwrap().data.status,
            "committed"
        );
        let duplicate = node
            .client_write(CatalogRequest::Device {
                operation_id: "join:duplicate".into(),
                expected_revision: 0,
                payload: serde_json::json!({
                    "action":"join_request",
                    "networkId":"enroll",
                    "enrollmentId":"one",
                    "secret":"0123456789abcdef",
                    "nodeId":103,
                    "connectorEndpoint":"http://127.0.0.1:9998"
                }),
            })
            .await
            .unwrap()
            .data;
        assert_eq!(duplicate.status, "invalid_request");
        assert_eq!(
            node.store
                .db
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM operation_dedup WHERE operation_id='join:duplicate'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let approve = CatalogRequest::Device {
            operation_id: "approve:one".into(),
            expected_revision: 0,
            payload: serde_json::json!({"action":"approve_join","networkId":"enroll","enrollmentId":"one"}),
        };
        let first = node.client_write(approve.clone()).await.unwrap().data;
        let second = node.client_write(approve).await.unwrap().data;
        assert_eq!(first, second);
        let issued: serde_json::Value =
            serde_json::from_str(first.value.as_deref().unwrap()).unwrap();
        assert_eq!(issued["state"], "approved");
        assert!(issued["credential"].as_str().is_some_and(|v| v.len() == 64));
        let stored: (String, Option<String>) = node.store.db.lock().unwrap().query_row("SELECT challenge_secret,credential FROM enrollment_credentials WHERE enrollment_id='one'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(stored.0, "0123456789abcdef");
        assert_eq!(stored.1.as_deref(), issued["credential"].as_str());
        node.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restart_recovers_committed_snapshot() {
        let base = NEXT.fetch_add(1, Ordering::Relaxed) + 10_000;
        let file = path(base);
        let first = CatalogRaft::new_in_process(91, &file, "restart")
            .await
            .unwrap();
        first.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        write_until_leader(&[&first], "survives").await;
        // Force creation of the durable snapshot that a restarted follower advertises.
        first.raft.trigger().snapshot().await.unwrap();
        first.shutdown().await;
        let restarted = CatalogRaft::new_in_process(91, &file, "restart")
            .await
            .unwrap();
        assert_eq!(restarted.store.get("survives").as_deref(), Some("ok"));
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn snapshot_restores_relational_catalog_and_receipts() {
        let base = NEXT.fetch_add(2, Ordering::Relaxed) + 20_000;
        let mut source = SqliteStore::open(&path(base), "snapshot-catalog").unwrap();
        {
            let conn = source.db.lock().unwrap();
            conn.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('snapshot-catalog','Snapshot',2,1,1)", []).unwrap();
            conn.execute("INSERT INTO projects(id,network_id,name,default_branch,revision,created_at) VALUES('project','snapshot-catalog','Project','main',3,1)", []).unwrap();
            conn.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,lifecycle,pane_order,revision,created_at) VALUES('task','project','Task','device','active','[]',2,1)", []).unwrap();
            conn.execute("INSERT INTO task_panes(id,task_id,kind,title,revision,created_at) VALUES('pane','task','piAgent','Pi',1,1)", []).unwrap();
            conn.execute("INSERT INTO task_provisioning(task_id,base_commit,worktree_path,state,created_at) VALUES('task','abc','/tmp/task','ready',1)", []).unwrap();
            conn.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision) VALUES('task','device','/tmp/task',1)", []).unwrap();
            conn.execute("INSERT INTO task_cleanup_receipts(task_id,retained_commit,known_losses_json,result_json,cleaned_at) VALUES('task','def','[]','{}',1)", []).unwrap();
            conn.execute_batch("CREATE TABLE pi_session_metadata (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO pi_session_metadata(pane_id,session_id,metadata_json,created_at) VALUES('pane','session','{}',1);") .unwrap();
            conn.execute("INSERT INTO enrollment_credentials(enrollment_id,network_id,secret,created_at) VALUES('secret-enrollment','snapshot-catalog','do-not-replicate',1)", []).unwrap();
            conn.execute("INSERT INTO operation_dedup(operation_id,operation_kind,request_hash,result_json,created_at) VALUES('operation','project','hash','{}',1)", []).unwrap();
            conn.execute("INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES('pane','old-pane',2,1)", []).unwrap();
        }
        let snapshot = source.build_snapshot().await.unwrap();
        let meta = snapshot.meta.clone();
        let mut target = SqliteStore::open(&path(base + 1), "snapshot-catalog").unwrap();
        {
            let conn = target.db.lock().unwrap();
            conn.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('other','Other',2,1,1)", []).unwrap();
            conn.execute("INSERT INTO projects(id,network_id,name,default_branch,revision,created_at) VALUES('other-project','other','Other Project','main',1,1)", []).unwrap();
        }
        target
            .install_snapshot(&meta, snapshot.snapshot)
            .await
            .unwrap();
        let conn = target.db.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT revision FROM projects WHERE id='project'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE id='other-project' AND network_id='other'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM operation_dedup WHERE operation_id='operation'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM tombstones WHERE record_id='old-pane'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM task_provisioning WHERE task_id='task'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "ready"
        );
        assert_eq!(
            conn.query_row(
                "SELECT path FROM device_task_paths WHERE task_id='task'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "/tmp/task"
        );
        assert_eq!(
            conn.query_row(
                "SELECT retained_commit FROM task_cleanup_receipts WHERE task_id='task'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "def"
        );
        assert_eq!(
            conn.query_row(
                "SELECT metadata_json FROM pi_session_metadata WHERE pane_id='pane'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "{}"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM enrollment_credentials", [], |row| row
                .get::<_, i64>(0),)
                .unwrap(),
            0
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_voters_reject_write_when_one_is_down() {
        let base = NEXT.fetch_add(2, Ordering::Relaxed) + 100;
        let n1 = CatalogRaft::new_in_process(11, &path(base), "two")
            .await
            .unwrap();
        let n2 = CatalogRaft::new_in_process(12, &path(base + 1), "two")
            .await
            .unwrap();
        n1.initialize(BasicNode::new("n1")).await.unwrap();
        sleep(Duration::from_millis(300)).await;
        n1.add_learner(12, BasicNode::new("n2")).await.unwrap();
        n1.change_membership([11, 12]).await.unwrap();
        n2.shutdown().await;
        let write = tokio::time::timeout(
            Duration::from_secs(1),
            n1.client_write(CatalogRequest::Put {
                key: "blocked".into(),
                value: "x".into(),
            }),
        )
        .await;
        assert!(write.is_err() || write.is_ok_and(|result| result.is_err()));
        n1.shutdown().await;
    }
}
