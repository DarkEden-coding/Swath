pub mod raft;

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const SHARED_SCHEMA_VERSION: i64 = 4;

/// A structured result returned when a catalog mutation cannot reach its voter quorum.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct QuorumUnavailable {
    pub code: String,
    pub voters: usize,
    pub healthy_voters: usize,
    pub required: usize,
}

/// Creates and validates durable catalog, coordinator, enrollment, Raft-log and snapshot storage.
/// Coordinator voters intentionally have no relationship to Git replica locations.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS networks (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, schema_version INTEGER NOT NULL,
           revision INTEGER NOT NULL, created_at INTEGER NOT NULL, tombstoned_at INTEGER,
           -- A non-null value makes this a deliberately single-server catalog. The referenced
           -- device is the only Raft voter; other enrolled devices are clients/executors.
           server_device_id TEXT REFERENCES devices(id)
         );
         CREATE TABLE IF NOT EXISTS local_device_identity (
           singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL UNIQUE
         );
         CREATE TABLE IF NOT EXISTS devices (
           id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id),
           display_name TEXT NOT NULL, hostname TEXT NOT NULL, platform TEXT NOT NULL,
           enrollment_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
           tombstoned_at INTEGER, UNIQUE(network_id, enrollment_id)
         );
         CREATE INDEX IF NOT EXISTS devices_network_hostname ON devices(network_id, hostname);
         CREATE TABLE IF NOT EXISTS coordinator_members (
           network_id TEXT NOT NULL REFERENCES networks(id), device_id TEXT NOT NULL REFERENCES devices(id),
           voter INTEGER NOT NULL CHECK(voter IN (0,1)), healthy INTEGER NOT NULL DEFAULT 1 CHECK(healthy IN (0,1)),
           promoted_at INTEGER NOT NULL, PRIMARY KEY(network_id, device_id)
         );
         CREATE TABLE IF NOT EXISTS git_replicas (
           network_id TEXT NOT NULL REFERENCES networks(id), device_id TEXT NOT NULL REFERENCES devices(id),
           repository_source TEXT NOT NULL, PRIMARY KEY(network_id, device_id, repository_source)
         );
         CREATE TABLE IF NOT EXISTS enrollment_credentials (
           enrollment_id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id), device_id TEXT,
           secret TEXT NOT NULL, approved_at INTEGER, created_at INTEGER NOT NULL
         );
         -- Join secrets and coordinator URLs are local to a joining device until approval.
         CREATE TABLE IF NOT EXISTS pending_enrollments (
           enrollment_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, endpoint TEXT NOT NULL,
           secret TEXT NOT NULL, created_at INTEGER NOT NULL
         );
         -- Connector addresses and credentials are local transport state, keyed by immutable device ID.
         CREATE TABLE IF NOT EXISTS device_connectors (
           device_id TEXT PRIMARY KEY REFERENCES devices(id), endpoint TEXT NOT NULL,
           credential TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS raft_log (
           network_id TEXT NOT NULL, log_index INTEGER NOT NULL, term INTEGER NOT NULL, payload BLOB NOT NULL,
           PRIMARY KEY(network_id, log_index)
         );
         CREATE TABLE IF NOT EXISTS raft_snapshots (
           network_id TEXT PRIMARY KEY, last_log_index INTEGER NOT NULL, last_log_term INTEGER NOT NULL,
           payload BLOB NOT NULL, created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS raft_hard_state (
           network_id TEXT PRIMARY KEY, vote BLOB, committed_log_index INTEGER, last_applied_log_index INTEGER
         );
         -- All Raft peers, unlike catalog_nodes which is this installation's identity.
         CREATE TABLE IF NOT EXISTS raft_node_members (
           network_id TEXT NOT NULL REFERENCES networks(id), device_id TEXT NOT NULL REFERENCES devices(id),
           node_id INTEGER NOT NULL, endpoint TEXT NOT NULL,
           PRIMARY KEY(network_id, device_id), UNIQUE(network_id, node_id)
         );
         -- Stable Raft identity; device names/hostnames are intentionally not consensus IDs.
         CREATE TABLE IF NOT EXISTS catalog_nodes (
           network_id TEXT PRIMARY KEY REFERENCES networks(id), node_id INTEGER NOT NULL, endpoint TEXT NOT NULL,
           updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         COMMIT;",
    )?;
    // Older installations used `secret` for both the challenge and issued credential.
    // Keep the challenge immutable so status polling cannot be authenticated with a credential
    // (or any arbitrary replacement string).
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(enrollment_credentials)")?
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<_, _>>()?;
    if !columns.iter().any(|c| c == "challenge_secret") {
        conn.execute(
            "ALTER TABLE enrollment_credentials ADD COLUMN challenge_secret TEXT",
            [],
        )?;
        conn.execute("UPDATE enrollment_credentials SET challenge_secret=secret WHERE challenge_secret IS NULL", [])?;
    }
    if !columns.iter().any(|c| c == "credential") {
        conn.execute(
            "ALTER TABLE enrollment_credentials ADD COLUMN credential TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "metadata_json") {
        conn.execute("ALTER TABLE enrollment_credentials ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'", [])?;
    }
    let network_columns: Vec<String> = conn
        .prepare("PRAGMA table_info(networks)")?
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<_, _>>()?;
    if !network_columns.iter().any(|c| c == "server_device_id") {
        conn.execute(
            "ALTER TABLE networks ADD COLUMN server_device_id TEXT REFERENCES devices(id)",
            [],
        )?;
    }
    let mut known = conn.prepare("SELECT name, version FROM schema_migrations")?;
    for row in known.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (name, version) = row?;
        if name != "shared_catalog" && name != "legacy_v2_import" {
            return Err(anyhow!("unsupported migration record {name} version {version}; install a compatible Swath version or restore a backup"));
        }
    }
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE name = 'shared_catalog'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match version {
        Some(v) if v > SHARED_SCHEMA_VERSION => return Err(anyhow!("unsupported shared catalog schema version {v}; install a compatible Swath version or restore a backup")),
        Some(v) if v < SHARED_SCHEMA_VERSION => { conn.execute("UPDATE schema_migrations SET version = ?1 WHERE name = 'shared_catalog'", params![SHARED_SCHEMA_VERSION])?; }
        None => { conn.execute("INSERT INTO schema_migrations (name, version) VALUES ('shared_catalog', ?1)", params![SHARED_SCHEMA_VERSION])?; }
        _ => {}
    }
    Ok(())
}

/// Returns the permanently selected catalog server, if this network has been simplified to one.
pub fn single_server_device(conn: &Connection, network_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT server_device_id FROM networks WHERE id=?1 AND tombstoned_at IS NULL",
        [network_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(Into::into)
}

/// A single-server network has no coordinator role changes: its server is intentionally fixed.
pub fn is_single_server(conn: &Connection, network_id: &str) -> Result<bool> {
    Ok(single_server_device(conn, network_id)?.is_some())
}

/// Returns whether a catalog mutation can commit. One voter needs itself; two voters require both; three require two.
pub fn require_quorum(
    conn: &Connection,
    network_id: &str,
) -> std::result::Result<(), QuorumUnavailable> {
    let voters: usize = conn
        .query_row(
            "SELECT count(*) FROM coordinator_members WHERE network_id=?1 AND voter=1",
            params![network_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let healthy: usize = conn.query_row("SELECT count(*) FROM coordinator_members WHERE network_id=?1 AND voter=1 AND healthy=1", params![network_id], |r| r.get(0)).unwrap_or(0);
    let required = voters / 2 + 1;
    if voters > 0 && healthy >= required {
        Ok(())
    } else {
        Err(QuorumUnavailable {
            code: "quorum_unavailable".into(),
            voters,
            healthy_voters: healthy,
            required,
        })
    }
}

/// Adds or updates a coordinator member. Callers must first satisfy the current quorum; Git replicas are separate.
pub fn set_coordinator_health(
    conn: &Connection,
    network_id: &str,
    device_id: &str,
    voter: bool,
    healthy: bool,
) -> Result<()> {
    conn.execute("INSERT INTO coordinator_members(network_id,device_id,voter,healthy,promoted_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(network_id,device_id) DO UPDATE SET voter=excluded.voter,healthy=excluded.healthy", params![network_id, device_id, voter as i64, healthy as i64])?;
    Ok(())
}

/// Generates an opaque random ID using SQLite's system-independent random source.
pub fn random_id(conn: &Connection, prefix: &str) -> Result<String> {
    let value: String = conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    Ok(format!("{prefix}_{value}"))
}

/// Returns this installation's immutable identity, creating it once from random bytes.
pub fn stable_device_id(conn: &Connection) -> Result<String> {
    conn.execute(
        "INSERT OR IGNORE INTO local_device_identity(singleton,id) VALUES(1,'dev_' || lower(hex(randomblob(16))))",
        [],
    )?;
    conn.query_row(
        "SELECT id FROM local_device_identity WHERE singleton=1",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// Returns the local device ID, creating one once without using its hostname as identity.
pub fn ensure_local_device(
    conn: &Connection,
    network_id: &str,
    hostname: &str,
    platform: &str,
) -> Result<String> {
    let existing: Option<String> = conn.query_row("SELECT id FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL", params![network_id], |r| r.get(0)).optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = stable_device_id(conn)?;
    conn.execute("INSERT INTO devices (id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES(?1,?2,?3,?3,?4,'local-device',1,strftime('%s','now'))",params![id,network_id,hostname,platform])?;
    Ok(id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub device_id: String,
    pub voter: bool,
    pub healthy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub network_id: String,
    pub voters: usize,
    pub healthy_voters: usize,
    pub required: usize,
    pub quorum: bool,
}

pub fn membership(conn: &Connection, network_id: &str) -> Result<Vec<Member>> {
    let mut statement = conn.prepare("SELECT device_id,voter,healthy FROM coordinator_members WHERE network_id=?1 ORDER BY device_id")?;
    let members = statement
        .query_map(params![network_id], |row| {
            Ok(Member {
                device_id: row.get(0)?,
                voter: row.get::<_, i64>(1)? != 0,
                healthy: row.get::<_, i64>(2)? != 0,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(members)
}

pub fn health(conn: &Connection, network_id: &str) -> Result<Health> {
    let members = membership(conn, network_id)?;
    let voters = members.iter().filter(|m| m.voter).count();
    let healthy_voters = members.iter().filter(|m| m.voter && m.healthy).count();
    let required = voters / 2 + 1;
    Ok(Health {
        network_id: network_id.into(),
        voters,
        healthy_voters,
        required,
        quorum: voters > 0 && healthy_voters >= required,
    })
}

/// Reads one committed network projection for native and browser interfaces.
pub fn catalog_snapshot(conn: &Connection, network_id: &str) -> Result<serde_json::Value, String> {
    let network: serde_json::Value = conn.query_row(
        "SELECT json_object('id',id,'name',name,'schemaVersion',schema_version,'revision',revision,'createdAt',created_at) FROM networks WHERE id=?1 AND tombstoned_at IS NULL",
        params![network_id], |row| row.get::<_, String>(0),
    ).optional().map_err(|e| e.to_string())?.ok_or_else(|| "network_not_found".to_string())?
        .parse().map_err(|e: serde_json::Error| e.to_string())?;
    let devices = {
        let mut statement = conn.prepare("SELECT json_object('id',id,'networkId',network_id,'displayName',display_name,'hostname',hostname,'platform',platform,'enrollmentId',enrollment_id,'revision',revision) FROM devices WHERE network_id=?1 AND tombstoned_at IS NULL").map_err(|e| e.to_string())?;
        let devices = statement
            .query_map(params![network_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(std::result::Result::ok)
            .filter_map(|value| serde_json::from_str(&value).ok())
            .collect::<Vec<serde_json::Value>>();
        devices
    };
    let members = membership(conn, network_id).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"network":network,"devices":devices,"members":members}))
}

/// Polls a durable enrollment and installs the coordinator-approved initial projection.
pub async fn join_status(
    conn: Connection,
    enrollment_id: String,
) -> Result<serde_json::Value, String> {
    let pending: Option<(String, String, String)> = conn
        .query_row(
            "SELECT network_id,endpoint,secret FROM pending_enrollments WHERE enrollment_id=?1",
            [&enrollment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((network_id, endpoint, secret)) = pending else {
        return Err("join_request_not_found".into());
    };
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/enrollment/{}",
            endpoint.trim_end_matches('/'),
            enrollment_id
        ))
        .query(&[("secret", secret.as_str())])
        .send()
        .await
        .map_err(|e| format!("coordinator_unreachable: {e}"))?;
    let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if value.get("state").and_then(serde_json::Value::as_str) != Some("approved") {
        return Ok(value);
    }
    let device_id = value
        .get("deviceId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let credential = value
        .get("credential")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let network_meta = value
        .get("network")
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let device_meta = value
        .get("device")
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let name = network_meta
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let schema_version = network_meta
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(2);
    let display_name = device_meta
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let hostname = device_meta
        .get("hostname")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(display_name);
    let platform = device_meta
        .get("platform")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES(?1,?2,?3,1,strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name,schema_version=excluded.schema_version",params![network_id,name,schema_version]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO enrollment_credentials(enrollment_id,network_id,device_id,secret,challenge_secret,credential,approved_at,metadata_json,created_at) VALUES(?1,?2,?3,?4,?4,?5,strftime('%s','now'),'{}',strftime('%s','now')) ON CONFLICT(enrollment_id) DO UPDATE SET device_id=excluded.device_id,credential=excluded.credential,approved_at=excluded.approved_at", params![enrollment_id,network_id,device_id,secret,credential]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,1,strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,hostname=excluded.hostname,platform=excluded.platform",params![device_id,network_id,display_name,hostname,platform,enrollment_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,credential=excluded.credential,updated_at=strftime('%s','now')",params![device_id,endpoint,credential]).map_err(|e|e.to_string())?;
    let node_id = value
        .get("nodeId")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    let local_endpoint = value
        .get("endpoint")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "invalid enrollment response".to_string())?;
    tx.execute("INSERT INTO catalog_nodes(network_id,node_id,endpoint) VALUES(?1,?2,?3) ON CONFLICT(network_id) DO UPDATE SET node_id=excluded.node_id,endpoint=excluded.endpoint,updated_at=strftime('%s','now')",params![network_id,node_id,local_endpoint]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES(?1,?2,?3,?4) ON CONFLICT(network_id,device_id) DO UPDATE SET node_id=excluded.node_id,endpoint=excluded.endpoint",params![network_id,device_id,node_id,local_endpoint]).map_err(|e|e.to_string())?;
    if let Some(peer) = value.get("coordinator") {
        let peer_id = peer
            .get("deviceId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "invalid coordinator".to_string())?;
        let peer_node = peer
            .get("nodeId")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "invalid coordinator".to_string())?;
        let peer_endpoint = peer
            .get("endpoint")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "invalid coordinator".to_string())?;
        let peer_credential = peer
            .get("credential")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "invalid coordinator".to_string())?;
        tx.execute("INSERT OR IGNORE INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES(?1,?2,'Coordinator','coordinator','unknown','peer',1,strftime('%s','now'))",params![peer_id,network_id]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO raft_node_members(network_id,device_id,node_id,endpoint) VALUES(?1,?2,?3,?4) ON CONFLICT(network_id,device_id) DO UPDATE SET node_id=excluded.node_id,endpoint=excluded.endpoint",params![network_id,peer_id,peer_node,peer_endpoint]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO device_connectors(device_id,endpoint,credential) VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,credential=excluded.credential",params![peer_id,peer_endpoint,peer_credential]).map_err(|e|e.to_string())?;
    }
    tx.execute(
        "DELETE FROM pending_enrollments WHERE enrollment_id=?1",
        [&enrollment_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"state":"approved","networkId":network_id,"deviceId":device_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_device_identity_is_random_and_durable() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        let first = stable_device_id(&c).unwrap();
        assert!(first.starts_with("dev_"));
        assert_eq!(stable_device_id(&c).unwrap(), first);
    }

    #[test]
    fn voter_quorum_is_explicit() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute(
            "INSERT INTO networks(id,name,schema_version,revision,created_at,tombstoned_at) VALUES('n','n',2,1,0,NULL)",
            [],
        )
            .unwrap();
        c.execute(
            "INSERT INTO devices VALUES('d','n','d','d','x','e',1,0,NULL)",
            [],
        )
        .unwrap();
        set_coordinator_health(&c, "n", "d", true, true).unwrap();
        assert!(require_quorum(&c, "n").is_ok());
        c.execute(
            "INSERT INTO devices VALUES('e','n','e','e','x','e2',1,0,NULL)",
            [],
        )
        .unwrap();
        set_coordinator_health(&c, "n", "e", true, false).unwrap();
        assert_eq!(
            require_quorum(&c, "n").unwrap_err().code,
            "quorum_unavailable"
        );
        c.execute(
            "INSERT INTO devices VALUES('f','n','f','f','x','e3',1,0,NULL)",
            [],
        )
        .unwrap();
        set_coordinator_health(&c, "n", "f", true, true).unwrap();
        assert!(require_quorum(&c, "n").is_ok());
    }
}
