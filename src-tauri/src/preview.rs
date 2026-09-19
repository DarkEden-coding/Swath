//! Narrow task-preview policy.  This is deliberately not a general HTTP proxy.

use crate::config;
use rusqlite::params;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
};

pub fn approve(data_dir: &Path, task_id: &str, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("preview port is invalid".into());
    }
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let ready: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks t JOIN task_provisioning p ON p.task_id=t.id WHERE t.id=?1 AND t.tombstoned_at IS NULL AND p.state='ready')",
        params![task_id], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !ready {
        return Err("preview task is not a ready local task".into());
    }
    conn.execute("CREATE TABLE IF NOT EXISTS task_preview_ports (task_id TEXT NOT NULL REFERENCES tasks(id), port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), PRIMARY KEY(task_id,port))", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO task_preview_ports(task_id,port) VALUES(?1,?2)",
        params![task_id, port],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolves only a durable, explicitly approved task port to executor loopback.
pub fn target(data_dir: &Path, task_id: &str, port: u16) -> Result<SocketAddr, String> {
    if port == 0 {
        return Err("preview port is invalid".into());
    }
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let allowed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_preview_ports a JOIN tasks t ON t.id=a.task_id JOIN task_provisioning p ON p.task_id=t.id WHERE a.task_id=?1 AND a.port=?2 AND t.tombstoned_at IS NULL AND p.state='ready')",
        params![task_id, port], |row| row.get(0),
    ).unwrap_or(false);
    if !allowed {
        return Err("preview destination is not approved for this task".into());
    }
    Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
}

pub fn safe_query(query: Option<&str>) -> bool {
    query.is_none()
}

pub fn safe_path(path: &str) -> bool {
    path.is_empty()
        || (!path.starts_with('/')
            && path.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.contains(['\\', '?', '#', '%'])
            }))
}

#[cfg(test)]
mod tests {
    use super::{safe_path, safe_query};
    #[test]
    fn rejects_proxy_escape_paths() {
        assert!(safe_path("assets/app.js"));
        assert!(!safe_path("../admin"));
        assert!(!safe_path("a/../admin"));
        assert!(!safe_path("a\\b"));
        assert!(!safe_path("a?host=internal"));
        assert!(!safe_path("%2e%2e/admin"));
        assert!(safe_query(None));
        assert!(!safe_query(Some("redirect=http://127.0.0.1")));
    }
}
