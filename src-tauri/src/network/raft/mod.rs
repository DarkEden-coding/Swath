//! Durable OpenRaft catalog core. Transport adapters may mount the three public RPC handlers.
#![allow(clippy::result_large_err)]
use std::{
    collections::{BTreeMap, HashMap},
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
use rusqlite::{params, Connection, OptionalExtension};
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
}
impl RaftSnapshotBuilder<CatalogType> for SqliteStore {
    async fn build_snapshot(&mut self) -> Result<Snapshot<CatalogType>, StorageError<NodeId>> {
        let s = self.state()?;
        let b = serde_json::to_vec(&SnapshotBlob {
            last: s.last,
            membership: s.membership.clone(),
            data: s.data,
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
            snapshot: Box::new(Cursor::new(
                serde_json::to_vec(&SnapshotBlob {
                    last: s.last,
                    membership: s.membership,
                    data: self.state()?.data,
                })
                .map_err(Self::err)?,
            )),
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
    let hash = serde_json::to_string(&(kind, expected, payload)).unwrap_or_default();
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
            if action != "update" || field(payload, "name").is_none() { invalid("invalid_request") }
            else if tx.execute("UPDATE networks SET name=?1,revision=revision+1 WHERE id=?2 AND revision=?3 AND tombstoned_at IS NULL", params![field(payload,"name").unwrap(),id,expected])? == 0 { conflict() }
            else { committed(serde_json::json!({"networkId":id,"revision":expected+1}), expected + 1) }
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
        "tombstone" => tombstone(tx, "projects", "project", id, expected),
        _ => Ok(invalid("invalid_action")),
    }
}
fn tombstone(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    typ: &str,
    id: &str,
    expected: i64,
) -> Result<CatalogResponse, rusqlite::Error> {
    let sql=match table{"projects"=>"UPDATE projects SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL","tasks"=>"UPDATE tasks SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL","task_panes"=>"UPDATE task_panes SET tombstoned_at=strftime('%s','now'),revision=revision+1 WHERE id=?1 AND revision=?2 AND tombstoned_at IS NULL",_=>return Ok(invalid("invalid_request"))};
    if tx.execute(sql, params![id, expected])? == 0 {
        return Ok(conflict());
    };
    tx.execute("INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES(?1,?2,?3,strftime('%s','now'))",params![typ,id,expected+1])?;
    Ok(committed(
        serde_json::json!({"id":id,"revision":expected+1}),
        expected + 1,
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
                    let response = apply_catalog_projection(
                        &tx,
                        kind,
                        &operation_id,
                        expected_revision,
                        &payload,
                    )
                    .map_err(Self::err)?;
                    tx.commit().map_err(Self::err)?;
                    r.push(response);
                }
                EntryPayload::Membership(m) => {
                    s.membership = StoredMembership::new(Some(e.log_id), m);
                    r.push(CatalogResponse::legacy(None))
                }
                EntryPayload::Blank => r.push(CatalogResponse::legacy(None)),
            }
        }
        self.put_state(&s)?;
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CatalogError {
    pub code: String,
    pub message: String,
}
impl CatalogService {
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
        let conn = Connection::open(&db)?;
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
        if let Some(device_id) = local_device {
            conn.execute("INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES(?1,?2,?3,?4) ON CONFLICT(network_id,device_id) DO UPDATE SET node_id=excluded.node_id,endpoint=excluded.endpoint", params![network_id,device_id,node_id as i64,endpoint])?;
        }
        let bootstrap = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL)",
            [&network_id],
            |row| row.get::<_, bool>(0),
        )?;
        drop(conn);
        let raft = Arc::new(CatalogRaft::new(node_id, &db, &network_id, token).await?);
        // Only the device that created the network bootstraps the cluster. Enrolled peers must
        // remain uninitialized until the coordinator adds them as learners and changes membership.
        if bootstrap {
            let _ = raft.initialize(BasicNode::new(endpoint)).await;
        }
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
        let response = self
            .raft
            .client_write(request)
            .await
            .map(|r| r.data)
            .map_err(|e| {
                let text = e.to_string();
                let code = if text.contains("ForwardToLeader") || text.contains("leader") {
                    "not_leader"
                } else if text.contains("quorum") || text.contains("Unreachable") {
                    "quorum_unavailable"
                } else {
                    "catalog_unavailable"
                };
                CatalogError {
                    code: code.into(),
                    message: text,
                }
            })?;
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

pub struct CatalogRaft {
    pub raft: CatalogRaftInner,
    pub store: SqliteStore,
    pub id: NodeId,
}
impl CatalogRaft {
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
        conn.execute_batch("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('joined','n',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('peer','joined','Peer','peer','test','enrollment',1,0);").unwrap();
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
        sleep(Duration::from_millis(300)).await;
        assert!(service
            .raft
            .raft
            .metrics()
            .borrow()
            .current_leader
            .is_none());
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
        node.store.db.lock().unwrap().execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('catalog','before',2,1,0)", []).unwrap();
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
