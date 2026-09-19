//! Display-independent executor runtime.

use crate::{config, events::EventPublisher, pi_agent::PiManager, terminal::TerminalManager};
use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{params, OptionalExtension};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
};

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
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(recover_transfers_async(&data_dir))
    })
    .join()
    .map_err(|_| anyhow::anyhow!("transfer recovery thread panicked"))?
}
async fn recover_transfers_async(data_dir: &Path) -> Result<()> {
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
            match reqwest::Client::new()
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
            loop {
                let pending: Vec<(String, String)> = (|| -> Result<Vec<(String, String)>> {
                    let conn = config::connection_at(&config::db_path_in(&data_dir)?)?;
                    let mut q = conn.prepare("SELECT id,payload_json FROM transactional_outbox WHERE topic='pi.history' AND published_at IS NULL ORDER BY created_at LIMIT 64")?;
                    let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
                    Ok(rows)
                })().unwrap_or_default();
                for (id, payload) in pending {
                    let peers: Vec<(String,String,String)> = (|| -> Result<Vec<_>> {
                        let conn=config::connection_at(&config::db_path_in(&data_dir)?)?;
                        let mut q=conn.prepare("SELECT device_id,endpoint,credential FROM device_connectors")?;
                        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
                        Ok(rows)
                    })().unwrap_or_default();
                    for (peer, endpoint, credential) in peers {
                        let delivered = (|| -> Result<bool> { let c=config::connection_at(&config::db_path_in(&data_dir)?)?; Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM pi_history_deliveries WHERE outbox_id=?1 AND peer_id=?2)",params![id,peer],|r|r.get(0))?) })().unwrap_or(false);
                        if delivered { continue; }
                        let response = reqwest::Client::new().post(format!("{}/api/peer/rpc", endpoint.trim_end_matches('/'))).bearer_auth(credential).json(&serde_json::json!({"method":"sync.apply","params":{"networkId":serde_json::from_str::<serde_json::Value>(&payload).ok().and_then(|v|v.get("networkId").cloned()).unwrap_or(serde_json::Value::Null),"records":[serde_json::from_str::<serde_json::Value>(&payload).ok().unwrap_or(serde_json::Value::Null)]},"targetDeviceId":peer,"hop":0})).send().await;
                        if matches!(response, Ok(ref reply) if reply.status().is_success()) {
                            if let Ok(c) = config::db_path_in(&data_dir).and_then(|p| config::connection_at(&p)) { let _=c.execute("INSERT OR IGNORE INTO pi_history_deliveries(outbox_id,peer_id) VALUES(?1,?2)",params![id,peer]); }
                        } else if let Ok(c) = config::db_path_in(&data_dir).and_then(|p| config::connection_at(&p)) { let _=c.execute("UPDATE transactional_outbox SET attempts=attempts+1 WHERE id=?1",[&id]); }
                    }
                    if let Ok(c)=config::connection_at(&config::db_path_in(&data_dir).unwrap()) {
                        let total:i64=c.query_row("SELECT COUNT(*) FROM device_connectors",[],|r|r.get(0)).unwrap_or(0);
                        let done:i64=c.query_row("SELECT COUNT(*) FROM pi_history_deliveries WHERE outbox_id=?1",[&id],|r|r.get(0)).unwrap_or(0);
                        if total > 0 && done >= total { let _=c.execute("UPDATE transactional_outbox SET published_at=strftime('%s','now') WHERE id=?1",[&id]); }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    });
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
}
