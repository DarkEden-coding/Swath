//! Display-independent executor runtime.

use crate::{config, events::EventPublisher, pi_agent::PiManager, terminal::TerminalManager};
use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{params, OptionalExtension};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const HISTORY_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const RECOVERY_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const HISTORY_MAX_ATTEMPTS: i64 = 8;
const HISTORY_BATCH_SIZE: i64 = 64;

/// The process-owning Swath runtime. It can run with or without Tauri.
pub struct Core {
    data_dir: PathBuf,
    _lock: File,
    pub(crate) events: Arc<dyn EventPublisher>,
    pub(crate) terminal: Arc<TerminalManager>,
    pub(crate) pi: Arc<PiManager>,
}

impl Core {
    /// Opens storage and exclusively owns `data_dir` until this runtime is dropped.
    pub fn start(data_dir: PathBuf, events: Arc<dyn EventPublisher>) -> Result<Arc<Self>> {
        fs::create_dir_all(&data_dir)
            .with_context(|| format!("failed to create {}", data_dir.display()))?;
        let lock_path = data_dir.join("runtime.lock");
        let lock = File::create(&lock_path)
            .with_context(|| format!("failed to open {}", lock_path.display()))?;
        lock.try_lock_exclusive().map_err(|_| {
            anyhow::anyhow!(
                "Swath runtime already owns {}; attach to its connector or stop that service first",
                data_dir.display()
            )
        })?;
        config::initialize(&data_dir)?;
        recover_transfers(&data_dir)?;
        let terminal = Arc::new(TerminalManager::new(events.clone()));
        let pi = Arc::new(PiManager::new(events.clone(), data_dir.clone()));
        start_history_outbox(data_dir.clone());
        Ok(Arc::new(Self {
            data_dir,
            _lock: lock,
            events,
            terminal,
            pi,
        }))
    }

    /// Returns the injected, process-owned application data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Stops all executor children before releasing the runtime lock.
    pub fn shutdown(&self) {
        self.terminal.kill_all();
        self.pi.kill_all();
        if let Err(err) = config::record_runtime_interruption(&self.data_dir) {
            eprintln!("failed to record runtime interruption: {err}");
        }
    }
}

/// A restart never treats an ownership-write receipt as a completed transfer. The destination
/// must still attest to the staged bytes, and the catalog must still name it as the next owner.
fn recover_transfers(data_dir: &Path) -> Result<()> {
    let data_dir = data_dir.to_owned();
    std::thread::Builder::new()
        .name("swath-transfer-recovery".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let client = reqwest::Client::builder()
                    .timeout(RECOVERY_HTTP_TIMEOUT)
                    .build()?;
                runtime.block_on(recover_transfers_async(&data_dir, &client))
            })();
            if let Err(error) = result {
                eprintln!("transfer recovery failed: {error:#}");
            }
        })
        .context("failed to start transfer recovery")?;
    // Recovery is best-effort and must not hold up Tauri setup or a headless connector.
    Ok(())
}
async fn recover_transfers_async(data_dir: &Path, client: &reqwest::Client) -> Result<()> {
    let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
    let operations: Vec<(String, String, String, i64)> = conn.prepare("SELECT operation_id,task_id,destination_device_id,generation FROM task_operations WHERE kind='transfer' AND phase IN ('ownership committed','source retired')")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<std::result::Result<_, _>>()?;
    for (operation, task, destination, generation) in operations {
        let owned: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND assigned_device_id=?2 AND execution_generation=?3)", params![task, destination, generation + 1], |r| r.get(0))?;
        let connector: Option<(String, String)> = conn
            .query_row(
                "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
                [&destination],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let verified = if let Some((endpoint, credential)) = connector.filter(|_| owned) {
            match client
                .post(format!("{}/api/peer/rpc", endpoint.trim_end_matches('/')))
                .bearer_auth(credential)
                .json(&serde_json::json!({"method":"transfer.stage","targetDeviceId":destination,"hop":1,"params":{"action":"status","operationId":operation}}))
                .send()
                .await
            {
                Ok(response) => response
                    .json::<serde_json::Value>().await.ok()
                    .and_then(|v| v.pointer("/result/ok").and_then(serde_json::Value::as_bool))
                    .unwrap_or(false),
                Err(_) => false,
            }
        } else {
            false
        };
        if verified {
            conn.execute("UPDATE task_operations SET phase='complete',completed_at=COALESCE(completed_at,strftime('%s','now')),updated_at=strftime('%s','now') WHERE operation_id=?1", [operation])?;
        }
    }
    Ok(())
}

/// Best-effort durable history replication. The outbox remains the source of truth: a failed
/// connector call only increments attempts and is retried after the next reconnect/poll.
fn start_history_outbox(data_dir: PathBuf) {
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(v) => v,
            Err(_) => return,
        };
        runtime.block_on(async move {
            let client = match reqwest::Client::builder()
                .timeout(HISTORY_HTTP_TIMEOUT)
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("history outbox client setup failed: {error}");
                    return;
                }
            };
            loop {
                let peers = load_history_peers(&data_dir).unwrap_or_default();
                let local_device = local_device_id(&data_dir).ok().flatten();
                // A local-only installation has no remote acknowledgement to await. Marking
                // these rows complete is important: otherwise every pass scans them forever.
                let _ = finalize_history_outbox(&data_dir, local_device.as_deref());
                if !peers.is_empty() {
                    let pending = load_pending_history(&data_dir, local_device.as_deref())
                        .unwrap_or_default();
                    for pending in pending {
                        deliver_history_record(&data_dir, &client, &peers, pending).await;
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryPeer {
    id: String,
    endpoint: String,
    credential: String,
}

#[derive(Debug, Clone)]
struct PendingHistory {
    id: String,
    payload: String,
}

fn local_device_id(data_dir: &Path) -> Result<Option<String>> {
    let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
    local_device_id_from_connection(&conn)
}

fn load_history_peers(data_dir: &Path) -> Result<Vec<HistoryPeer>> {
    let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
    let local = local_device_id_from_connection(&conn)?;
    let mut query = conn.prepare(
        "SELECT device_id,endpoint,credential FROM device_connectors
         WHERE (?1 IS NULL OR device_id != ?1) ORDER BY device_id",
    )?;
    let rows = query
        .query_map(params![local], |row| {
            Ok(HistoryPeer {
                id: row.get(0)?,
                endpoint: row.get(1)?,
                credential: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>();
    rows.map_err(Into::into)
}

fn local_device_id_from_connection(conn: &rusqlite::Connection) -> Result<Option<String>> {
    let identity = conn
        .query_row(
            "SELECT id FROM local_device_identity WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if identity.is_some() {
        return Ok(identity);
    }
    conn.query_row(
        "SELECT r.device_id FROM catalog_nodes c
         JOIN raft_node_members r ON r.network_id=c.network_id AND r.node_id=c.node_id
         ORDER BY c.network_id LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
    .and_then(|catalog| {
        if catalog.is_some() {
            return Ok(catalog);
        }
        conn.query_row(
            "SELECT id FROM devices WHERE enrollment_id='local-device'
             AND tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    })
}

fn finalize_history_outbox(data_dir: &Path, local_device: Option<&str>) -> Result<usize> {
    let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
    Ok(conn.execute(
        "UPDATE transactional_outbox AS o SET published_at=strftime('%s','now')
         WHERE o.topic='pi.history' AND o.published_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM device_connectors d
             WHERE (?1 IS NULL OR d.device_id != ?1)
               AND NOT EXISTS (
                 SELECT 1 FROM pi_history_deliveries h
                 WHERE h.outbox_id=o.id AND h.peer_id=d.device_id
               )
           )",
        params![local_device],
    )?)
}

fn load_pending_history(
    data_dir: &Path,
    local_device: Option<&str>,
) -> Result<Vec<PendingHistory>> {
    let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
    // The retry schedule is derived from the durable attempts counter and created_at, so no
    // migration is needed. The CASE also lets newer records pass a backoff-delayed poison row.
    // Rows at the cap remain durable for operator inspection but are no longer retried.
    let mut query = conn.prepare(
        "SELECT o.id,o.payload_json FROM transactional_outbox o
         WHERE o.topic='pi.history' AND o.published_at IS NULL
           AND o.attempts < ?1
           AND o.created_at + CASE o.attempts
             WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 4
             WHEN 4 THEN 8 WHEN 5 THEN 16 WHEN 6 THEN 32 WHEN 7 THEN 60
             ELSE 60 END <= CAST(strftime('%s','now') AS INTEGER)
           AND EXISTS (
             SELECT 1 FROM device_connectors d
             WHERE (?2 IS NULL OR d.device_id != ?2)
               AND NOT EXISTS (
                 SELECT 1 FROM pi_history_deliveries h
                 WHERE h.outbox_id=o.id AND h.peer_id=d.device_id
               )
           )
         ORDER BY o.attempts,o.created_at LIMIT ?3",
    )?;
    let rows = query
        .query_map(
            params![HISTORY_MAX_ATTEMPTS, local_device, HISTORY_BATCH_SIZE],
            |row| {
                Ok(PendingHistory {
                    id: row.get(0)?,
                    payload: row.get(1)?,
                })
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>();
    rows.map_err(Into::into)
}

async fn deliver_history_record(
    data_dir: &Path,
    client: &reqwest::Client,
    peers: &[HistoryPeer],
    pending: PendingHistory,
) {
    let payload = serde_json::from_str::<serde_json::Value>(&pending.payload)
        .unwrap_or(serde_json::Value::Null);
    let network_id = payload
        .get("networkId")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    for peer in peers {
        let delivered = (|| -> Result<bool> {
            let conn = config::connection_at(&config::db_path_in(data_dir)?)?;
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM pi_history_deliveries WHERE outbox_id=?1 AND peer_id=?2)",
                params![pending.id, peer.id],
                |row| row.get(0),
            )?)
        })()
        .unwrap_or(false);
        if delivered {
            continue;
        }
        let response = client
            .post(format!(
                "{}/api/peer/rpc",
                peer.endpoint.trim_end_matches('/')
            ))
            .bearer_auth(&peer.credential)
            .json(&serde_json::json!({
                "method": "sync.apply",
                "params": {"networkId": network_id.clone(), "records": [payload.clone()]},
                "targetDeviceId": peer.id,
                "hop": 0
            }))
            .send()
            .await;
        if matches!(response, Ok(ref reply) if reply.status().is_success()) {
            if let Ok(conn) = config::db_path_in(data_dir).and_then(|p| config::connection_at(&p)) {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO pi_history_deliveries(outbox_id,peer_id) VALUES(?1,?2)",
                    params![pending.id, peer.id],
                );
            }
        } else if let Ok(conn) =
            config::db_path_in(data_dir).and_then(|p| config::connection_at(&p))
        {
            let _ = conn.execute(
                "UPDATE transactional_outbox SET attempts=attempts+1 WHERE id=?1 AND attempts < ?2",
                params![pending.id, HISTORY_MAX_ATTEMPTS],
            );
        }
    }
    let _ = finalize_history_outbox(
        data_dir,
        local_device_id(data_dir).ok().flatten().as_deref(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ConnectorEvents;

    #[test]
    fn data_directory_cannot_start_two_runtimes() {
        let dir = std::env::temp_dir().join(format!("swath-runtime-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = Core::start(dir.clone(), ConnectorEvents::new()).unwrap();
        assert!(Core::start(dir.clone(), ConnectorEvents::new()).is_err());
        drop(first);
        Core::start(dir.clone(), ConnectorEvents::new()).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_outbox_excludes_local_connector_and_completes_without_peers() {
        let dir = std::env::temp_dir().join(format!(
            "swath-runtime-history-no-peer-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        config::initialize(&dir).unwrap();
        let db = config::db_path_in(&dir).unwrap();
        let conn = config::connection_at(&db).unwrap();
        conn.execute(
            "INSERT INTO local_device_identity(singleton,id) VALUES(1,'local')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO networks(id,name,schema_version,revision,created_at)
                 VALUES('network','Network',4,1,0);
             INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at)
                 VALUES('local','network','Local','local','test','local-device',1,0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('local','http://127.0.0.1:1','test')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transactional_outbox(id,topic,payload_json,created_at) VALUES('history-no-peer','pi.history','{}',strftime('%s','now'))",
            [],
        )
        .unwrap();
        drop(conn);

        assert!(load_history_peers(&dir).unwrap().is_empty());
        assert_eq!(finalize_history_outbox(&dir, Some("local")).unwrap(), 1);
        let conn = config::connection_at(&db).unwrap();
        let published: Option<i64> = conn
            .query_row(
                "SELECT published_at FROM transactional_outbox WHERE id='history-no-peer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(published.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_outbox_backoff_and_max_attempts_use_existing_columns() {
        let dir = std::env::temp_dir().join(format!(
            "swath-runtime-history-retry-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        config::initialize(&dir).unwrap();
        let db = config::db_path_in(&dir).unwrap();
        let conn = config::connection_at(&db).unwrap();
        conn.execute(
            "INSERT INTO local_device_identity(singleton,id) VALUES(1,'local')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO networks(id,name,schema_version,revision,created_at)
                 VALUES('network','Network',4,1,0);
             INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at)
                 VALUES('local','network','Local','local','test','local-device',1,0),
                       ('peer','network','Peer','peer','test','peer-device',1,0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO device_connectors(device_id,endpoint,credential) VALUES('peer','http://127.0.0.1:1','test')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO transactional_outbox(id,topic,payload_json,created_at,attempts) VALUES
             ('history-ready','pi.history','{}',strftime('%s','now')-2,0),
             ('history-backoff','pi.history','{}',4102444800,1),
             ('history-dead','pi.history','{}',strftime('%s','now')-100,8);",
        )
        .unwrap();
        drop(conn);

        let pending = load_pending_history(&dir, Some("local")).unwrap();
        assert_eq!(
            pending
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["history-ready"]
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
