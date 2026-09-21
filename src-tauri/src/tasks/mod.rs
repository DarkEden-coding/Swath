//! Project-local Git replicas and task worktree provisioning.
mod transfer_cleanup;
pub(crate) use transfer_cleanup::{
    cleanup_confirm, cleanup_preview, restore_task, transfer_cancel, transfer_confirm,
    transfer_preflight, transfer_stage,
};

use crate::{config, git, network, preview};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

fn field<'a>(request: &'a Value, name: &str) -> Result<&'a str, String> {
    request
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn id(conn: &rusqlite::Connection, prefix: &str) -> Result<String, String> {
    network::random_id(conn, prefix).map_err(|e| e.to_string())
}

fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "code": code, "error": message.into()})
}

async fn fixed_server_record(data_dir: &Path, request: Value) -> Result<Value, String> {
    let conn = catalog_connection(data_dir)?;
    let local = network::stable_device_id(&conn).map_err(|e| e.to_string())?;
    let server: String = conn.query_row("SELECT server_device_id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if server == local {
        return match request.get("op").and_then(Value::as_str) {
            Some("getProjectCatalogRecord") => project_catalog_record(data_dir, &request),
            Some("getTaskCatalogRecord") => task_catalog_record(data_dir, &request),
            _ => Err("invalid_catalog_read".into()),
        };
    }
    let (endpoint, credential): (String, String) = conn
        .query_row(
            "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
            [&server],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    drop(conn);
    let response = reqwest::Client::new()
        .post(format!("{}/api/peer/rpc", endpoint.trim_end_matches('/')))
        .bearer_auth(credential)
        .json(&json!({"method":"task.rpc","params":request,"targetDeviceId":server,"hop":0}))
        .send()
        .await
        .map_err(|e| format!("catalog_server_unavailable: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body.get("error").cloned().unwrap_or(body).to_string());
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| "invalid_catalog_response".into())
}

async fn sync_task_record(data_dir: &Path, task_id: &str) -> Result<(), String> {
    let record = fixed_server_record(
        data_dir,
        json!({"op":"getTaskCatalogRecord","taskId":task_id}),
    )
    .await?;
    apply_task_record(data_dir, task_id, &record)
}

fn apply_task_record(data_dir: &Path, task_id: &str, record: &Value) -> Result<(), String> {
    let task = &record["task"];
    let project = &record["project"];
    let local = catalog_connection(data_dir)?;
    if task["assignedDeviceId"].as_str()
        != Some(
            network::stable_device_id(&local)
                .map_err(|e| e.to_string())?
                .as_str(),
        )
    {
        return Err("task_not_owned_by_this_device".into());
    }
    let mut conn = local;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE projects SET task_order=?1,revision=?2 WHERE id=?3",
        params![
            project["taskOrder"].to_string(),
            project["revision"]
                .as_i64()
                .ok_or("invalid_project_revision")?,
            project["id"].as_str().ok_or("invalid_project_id")?
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO tasks(id,project_id,title,assigned_device_id,execution_generation,lifecycle,pane_order,revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET title=excluded.title,assigned_device_id=excluded.assigned_device_id,execution_generation=excluded.execution_generation,lifecycle=excluded.lifecycle,pane_order=excluded.pane_order,revision=excluded.revision",params![task["id"].as_str(),task["projectId"].as_str(),task["title"].as_str(),task["assignedDeviceId"].as_str(),task["executionGeneration"].as_i64(),task["lifecycle"].as_str(),task["paneOrder"].to_string(),task["revision"].as_i64(),task["createdAt"].as_i64()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO task_provisioning(task_id,base_commit,worktree_path,state,last_error,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,last_error=excluded.last_error",params![task["id"].as_str(),task["baseCommit"].as_str(),task["worktreePath"].as_str(),task["provisioningState"].as_str(),task["lastError"].as_str(),task["createdAt"].as_i64()]).map_err(|e|e.to_string())?;
    if let Some(panes) = record["panes"].as_array() {
        for pane in panes {
            tx.execute("INSERT INTO task_panes(id,task_id,kind,title,session_id,revision,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,session_id=excluded.session_id,revision=excluded.revision",params![pane["id"].as_str(),task_id,pane["kind"].as_str(),pane["title"].as_str(),pane["sessionId"].as_str(),pane["revision"].as_i64(),pane["createdAt"].as_i64()]).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Operations that mutate or read only the replicated catalog. They must be handled by the
/// catalog control plane, never routed to the task's executor merely because they carry a taskId.
pub(crate) fn is_catalog_operation(request: &Value) -> bool {
    matches!(
        request.get("op").and_then(Value::as_str),
        Some(
            "listCatalog"
                | "renameProject"
                | "removeProject"
                | "renameTask"
                | "reorderTasks"
                | "completeTask"
                | "reactivateTask"
                | "reorderPanes"
                | "createPane"
                | "updatePane"
                | "removePane"
                | "getProjectCatalogRecord"
                | "getTaskCatalogRecord"
        )
    )
}

/// Ensures this executor has a private project replica, fetching a bundle from a configured peer
/// when the original project path is local to another device.
async fn ensure_local_replica(
    data_dir: &Path,
    project_id: &str,
    source: &str,
) -> Result<std::path::PathBuf, String> {
    let replica = data_dir
        .join("project-repos")
        .join(format!("{project_id}.git"));
    if replica.exists() {
        // A private replica is a cache, not the authority for a newly-created task. Refresh it
        // whenever the configured source is locally available so a short branch name cannot
        // silently resolve to the branch tip from the original clone.
        if Path::new(source).exists() {
            git::ensure_project_replica(source, &replica)?;
        }
        return Ok(replica);
    }
    if Path::new(source).exists() {
        git::ensure_project_replica(source, &replica)?;
        return Ok(replica);
    }
    let conn = catalog_connection(data_dir)?;
    let peer: (String, String) = conn.query_row(
        "SELECT c.endpoint,c.credential FROM projects p JOIN git_replicas r ON r.network_id=p.network_id AND r.repository_source=p.repository_source JOIN device_connectors c ON c.device_id=r.device_id WHERE p.id=?1 ORDER BY r.device_id LIMIT 1",
        [project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| "project_replica_unavailable".to_string())?;
    drop(conn);
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/project/{project_id}/bundle",
            peer.0.trim_end_matches('/')
        ))
        .bearer_auth(peer.1)
        .send()
        .await
        .map_err(|e| format!("project_replica_unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "project_replica_unavailable: {}",
            response.text().await.unwrap_or_default()
        ));
    }
    let bundle = data_dir
        .join("project-repos")
        .join(format!("{project_id}.bundle"));
    if let Some(parent) = bundle.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&bundle, response.bytes().await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    git::ensure_project_replica(&bundle.to_string_lossy(), &replica)?;
    Ok(replica)
}

pub(super) async fn catalog_write(
    data_dir: &Path,
    request: &Value,
    kind: &str,
    expected_revision: i64,
    payload: Value,
) -> Result<network::raft::CatalogResponse, String> {
    let conn = catalog_connection(data_dir)?;
    let operation_id = format!(
        "{}:{}",
        request
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .unwrap_or(id(&conn, "operation")?),
        payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or(kind)
    );
    let db = config::db_path_in(data_dir).map_err(|e| e.to_string())?;
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let service = network::raft::CatalogService::open_discovered(
        db.to_string_lossy(),
        "local-task-rpc",
        "http://127.0.0.1:0",
    )
    .await
    .map_err(|e| e.to_string())?
    .ok_or("network_not_found")?;
    let catalog_operation_id = operation_id.clone();
    let request = match kind {
        "project" => network::raft::CatalogRequest::Project {
            operation_id,
            expected_revision,
            payload,
        },
        "task" => network::raft::CatalogRequest::Task {
            operation_id,
            expected_revision,
            payload,
        },
        "pane" => network::raft::CatalogRequest::Pane {
            operation_id,
            expected_revision,
            payload,
        },
        "ownership" => network::raft::CatalogRequest::Ownership {
            operation_id,
            expected_revision,
            payload,
        },
        "cleanup" => network::raft::CatalogRequest::CleanupAuthorization {
            operation_id,
            expected_revision,
            payload,
        },
        _ => return Err("invalid_catalog_action".into()),
    };
    let response = service
        .client_write(request)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap_or(e.message))?;
    if response.status != "committed" {
        return Err(response.status);
    }
    // In the fixed-server topology desktop executors are not Raft learners. A write can be
    // committed by the server without ever applying to this executor's old local projection.
    // Callers that need a local task record reconcile it explicitly from the server below.
    let conn = catalog_connection(data_dir)?;
    let remote_server: bool = conn.query_row("SELECT server_device_id FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1", [], |row| row.get::<_,Option<String>>(0)).optional().map_err(|e|e.to_string())?.flatten().is_some_and(|server| network::stable_device_id(&conn).ok().is_some_and(|local| local != server));
    if remote_server
        && kind == "task"
        && matches!(
            action.as_str(),
            "create" | "provision_ready" | "provision_failed"
        )
    {
        return Ok(response);
    }
    if service
        .wait_for_operation(&catalog_operation_id, std::time::Duration::from_secs(15))
        .await
        .map_err(|error| serde_json::to_string(&error).unwrap_or(error.message))?
    {
        return Ok(response);
    }
    Err(serde_json::json!({
        "code":"catalog_projection_delayed",
        "message":"The operation committed, but this device has not projected it yet",
        "operationId":catalog_operation_id,
        "retryable":true
    })
    .to_string())
}
pub(super) fn revision(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT revision FROM {table} WHERE id=?1 AND tombstoned_at IS NULL"),
        [id],
        |r| r.get(0),
    )
    .map_err(|_| "not_found".into())
}

/// Dispatches project/task mutations. Provisioning is deliberately synchronous: a task becomes
/// ready only after its private worktree and its initial Pi pane have both been recorded.
pub async fn rpc(data_dir: &Path, request: Value) -> Result<Value, String> {
    let operation = request.get("op").and_then(Value::as_str).unwrap_or("");
    // The catalog fence is the single mutation gate. It survives executor restarts and keeps
    // pane/task mutations from racing a frozen transfer snapshot.
    if !matches!(
        operation,
        "getTask"
            | "listCatalog"
            | "transferConfirm"
            | "transferCancel"
            | "cleanupPreview"
            | "cleanupConfirm"
            | "restoreTask"
    ) {
        if let Some(task_id) = request.get("taskId").and_then(Value::as_str) {
            let conn = catalog_connection(data_dir)?;
            let frozen: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM task_operations WHERE task_id=?1 AND ((kind='transfer' AND phase IN ('source frozen','destination staged','verified')) OR (kind='cleanup' AND phase='cleanup frozen')))", [task_id], |row| row.get(0)).map_err(|e| e.to_string())?;
            if frozen {
                return Ok(error(
                    "task_frozen",
                    "Task mutations are blocked while transfer is frozen",
                ));
            }
        }
    }
    match operation {
        "createProject" | "importProject" => create_project(data_dir, &request).await,
        "createTask" => create_task(data_dir, &request).await,
        "listCatalog" => list_catalog(data_dir, &request),
        "getProjectCatalogRecord" => project_catalog_record(data_dir, &request),
        "getTaskCatalogRecord" => task_catalog_record(data_dir, &request),
        "renameProject" => rename_project(data_dir, &request).await,
        "removeProject" => remove_project(data_dir, &request).await,
        "renameTask" => rename_task(data_dir, &request).await,
        "reorderTasks" => reorder_tasks(data_dir, &request).await,
        "completeTask" => complete_task(data_dir, &request).await,
        "reactivateTask" => reactivate_task(data_dir, &request).await,
        "reorderPanes" => reorder_panes(data_dir, &request).await,
        "createPane" => create_pane(data_dir, &request).await,
        "updatePane" => update_pane(data_dir, &request).await,
        "removePane" => remove_pane(data_dir, &request).await,
        "retryProvision" => retry_provision(data_dir, &request).await,
        "getTask" => get_task(data_dir, &request),
        "transferPreflight" => transfer_preflight(data_dir, &request).await,
        "transferConfirm" => transfer_confirm(data_dir, &request).await,
        "transferCancel" => transfer_cancel(data_dir, &request).await,
        "cleanupPreview" => cleanup_preview(data_dir, &request).await,
        "cleanupConfirm" => cleanup_confirm(data_dir, &request).await,
        "restoreTask" => restore_task(data_dir, &request).await,
        "approvePreview" => approve_preview(data_dir, &request),
        _ => Ok(error("invalid_request", "Unknown task operation")),
    }
}

fn approve_preview(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task_id = field(request, "taskId")?;
    let port = request
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or_else(|| "port must be 1 through 65535".to_string())? as u16;
    preview::approve(data_dir, task_id, port)?;
    Ok(json!({"ok": true, "taskId": task_id, "port": port}))
}

/// Imports a source directory once, storing the immutable Git common-directory identity.
async fn create_project(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let source = field(request, "sourcePath")?;
    let name = field(request, "name")?;
    let network_id = field(request, "networkId")?;
    let conn = catalog_connection(data_dir)?;
    let source = git::prepare_project_source(source)
        .map_err(|e| serde_json::to_string(&error("git_preflight", e)).unwrap())?;
    let project_id = id(&conn, "project")?;
    let replica = data_dir
        .join("project-repos")
        .join(format!("{project_id}.git"));
    git::ensure_project_replica(&source, &replica)
        .map_err(|e| serde_json::to_string(&error("replica_failed", e)).unwrap())?;
    let branch = git::default_branch(&source)
        .map_err(|e| serde_json::to_string(&error("git_preflight", e)).unwrap())?;
    let replica_device_id: String = conn
        .query_row(
            "SELECT device_id FROM (SELECT r.device_id,0 AS priority FROM catalog_nodes c JOIN raft_node_members r ON r.network_id=c.network_id AND r.node_id=c.node_id WHERE c.network_id=?1 UNION ALL SELECT id,1 FROM devices WHERE network_id=?1 AND enrollment_id='local-device' AND tombstoned_at IS NULL) ORDER BY priority LIMIT 1",
            [network_id],
            |row| row.get(0),
        )
        .map_err(|_| "local_device_not_enrolled".to_string())?;
    catalog_write(data_dir, request, "project", 0, json!({"action":"create","projectId":project_id,"networkId":network_id,"name":name,"repositorySource":source,"defaultBranch":branch,"replicaDeviceId":replica_device_id})).await?;
    Ok(json!({"ok":true,"projectId":project_id,"repositorySource":source,"replicaPath":replica}))
}

/// Creates a pending task, provisions an isolated worktree at the exact selected commit, then
/// atomically exposes it as ready. Failures remain retryable in `task_provisioning`.
async fn create_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let project_id = field(request, "projectId")?;
    let title = field(request, "title")?;
    let device_id = field(request, "deviceId")?;
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let authoritative = fixed_server_record(
        data_dir,
        json!({"op":"getProjectCatalogRecord","projectId":project_id}),
    )
    .await?;
    let branch = authoritative["defaultBranch"]
        .as_str()
        .ok_or("invalid_project_branch")?
        .to_owned();
    let mut source = authoritative["repositorySource"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // Early legacy imports stored a fingerprint (for example `git:.git`) instead of a usable
    // source path. Their imported task still owns the original path, so recover it here.
    if source.is_empty() || source.starts_with("git:") || source.starts_with("path:") {
        if let Some(path) = conn.query_row("SELECT q.worktree_path FROM tasks t JOIN task_provisioning q ON q.task_id=t.id WHERE t.project_id=?1 AND q.worktree_path IS NOT NULL ORDER BY t.created_at LIMIT 1", [project_id], |row| row.get::<_, String>(0)).optional().map_err(|e| e.to_string())? {
            if Path::new(&path).is_dir() { source = path; }
        }
    }
    if source.is_empty() || source.starts_with("git:") || source.starts_with("path:") {
        return Ok(error(
            "project_source_missing",
            "Project has no available Git source on this device",
        ));
    }
    let known = conn
        .query_row(
            "SELECT 1 FROM devices WHERE id=?1 AND tombstoned_at IS NULL",
            params![device_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !known {
        return Ok(error("device_not_found", "Select an enrolled device"));
    }
    let online = device_id == network::stable_device_id(&conn).map_err(|e| e.to_string())?
        || conn
            .query_row(
                "SELECT healthy FROM coordinator_members WHERE device_id=?1",
                params![device_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0)
            != 0;
    if !online {
        return Ok(error(
            "device_offline",
            "Selected device is offline; choose an online device",
        ));
    }
    let replica = ensure_local_replica(data_dir, project_id, &source).await?;
    let execution_source = replica.to_string_lossy().into_owned();
    let requested_ref = request
        .get("baseCommit")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&branch);
    let selected_ref = if requested_ref == branch && branch != "HEAD" {
        format!("refs/swath/source/heads/{branch}")
    } else {
        requested_ref.to_owned()
    };
    let base = match git::resolve_ref(&execution_source, &selected_ref) {
        Ok(base) => base,
        Err(reason) => return Ok(error("base_commit_unavailable", reason)),
    };
    let task_id = id(&conn, "task")?;
    let worktree = data_dir.join("task-worktrees").join(&task_id);
    let project_revision = authoritative["revision"]
        .as_i64()
        .ok_or("invalid_project_revision")?;
    catalog_write(data_dir, request, "task", project_revision, json!({"action":"create","taskId":task_id,"projectId":project_id,"title":title,"deviceId":device_id,"baseCommit":base,"worktreePath":worktree})).await?;
    sync_task_record(data_dir, &task_id)
        .await
        .map_err(|error| {
            format!(
                "Task {task_id} was created on the server but could not be prepared here: {error}"
            )
        })?;
    provision(
        data_dir,
        &task_id,
        &execution_source,
        &base,
        &worktree,
        request,
    )
    .await
}

/// Retries a previously failed/pending provisioning attempt without changing its receipt commit.
async fn retry_provision(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task_id = field(request, "taskId")?;
    sync_task_record(data_dir, task_id).await?;
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let row: Option<(String,String,String)> = conn.query_row("SELECT p.repository_source, q.base_commit, q.worktree_path FROM task_provisioning q JOIN tasks t ON t.id=q.task_id JOIN projects p ON p.id=t.project_id WHERE q.task_id=?1 AND q.state IN ('pending','failed')", params![task_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e| e.to_string())?;
    let Some((source, base, path)) = row else {
        return Ok(error("not_retryable", "Task is not pending or failed"));
    };
    let project_id = project_for(data_dir, task_id)?;
    let replica = ensure_local_replica(data_dir, &project_id, &source).await?;
    provision(
        data_dir,
        task_id,
        &replica.to_string_lossy(),
        &base,
        Path::new(&path),
        request,
    )
    .await
}

async fn provision(
    data_dir: &Path,
    task_id: &str,
    source: &str,
    base: &str,
    worktree: &Path,
    request: &Value,
) -> Result<Value, String> {
    let replica = data_dir
        .join("project-repos")
        .join(format!("{}.git", project_for(data_dir, task_id)?));
    let result = git::provision_worktree(source, &replica, worktree, base);
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    match result {
        Ok(()) => {
            let pane = id(&conn, "pane")?;
            let expected = revision(&conn, "tasks", task_id)?;
            catalog_write(
                data_dir,
                request,
                "task",
                expected,
                json!({"action":"provision_ready","taskId":task_id,"paneId":pane}),
            )
            .await?;
            sync_task_record(data_dir, task_id).await?;
            Ok(
                json!({"ok":true,"taskId":task_id,"state":"ready","worktreePath":worktree,"baseCommit":base,"piPaneId":pane}),
            )
        }
        Err(reason) => {
            catalog_write(
                data_dir,
                request,
                "task",
                revision(&conn, "tasks", task_id)?,
                json!({"action":"provision_failed","taskId":task_id,"reason":reason}),
            )
            .await?;
            sync_task_record(data_dir, task_id).await?;
            Ok(error("provision_failed", reason))
        }
    }
}
fn project_for(data_dir: &Path, task_id: &str) -> Result<String, String> {
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT project_id FROM tasks WHERE id=?1",
        params![task_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn catalog_connection(data_dir: &Path) -> Result<rusqlite::Connection, String> {
    config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn list_catalog(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let network_id = field(request, "networkId")?;
    let conn = catalog_connection(data_dir)?;
    let network_snapshot = network::catalog_snapshot(&conn, network_id)?;
    let mut projects = conn.prepare("SELECT id,name,repository_source,default_branch,task_order,revision,created_at,tombstoned_at FROM projects WHERE network_id=?1 AND tombstoned_at IS NULL ORDER BY created_at").map_err(|e| e.to_string())?;
    let projects: Vec<Value> = projects.query_map(params![network_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"repositorySource":r.get::<_,Option<String>>(2)?,"defaultBranch":r.get::<_,String>(3)?,"taskOrder":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!([])),"revision":r.get::<_,i64>(5)?,"createdAt":r.get::<_,i64>(6)? * 1000,"tombstonedAt":r.get::<_,Option<i64>>(7)?.map(|v|v * 1000)}))).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?;
    let mut tasks = conn.prepare("SELECT t.id,t.project_id,t.title,t.assigned_device_id,t.execution_generation,t.lifecycle,t.pane_order,t.revision,t.created_at,t.tombstoned_at FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1 AND p.tombstoned_at IS NULL AND t.tombstoned_at IS NULL ORDER BY t.created_at").map_err(|e| e.to_string())?;
    let tasks: Vec<Value> = tasks.query_map(params![network_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"assignedDeviceId":r.get::<_,String>(3)?,"executionGeneration":r.get::<_,i64>(4)?,"lifecycle":r.get::<_,String>(5)?,"paneOrder":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or(json!([])),"revision":r.get::<_,i64>(7)?,"createdAt":r.get::<_,i64>(8)? * 1000,"tombstonedAt":r.get::<_,Option<i64>>(9)?.map(|v|v * 1000)}))).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?;
    let mut panes = conn.prepare("SELECT q.id,q.task_id,q.kind,q.title,q.session_id,q.revision,q.tombstoned_at FROM task_panes q JOIN tasks t ON t.id=q.task_id JOIN projects p ON p.id=t.project_id WHERE p.network_id=?1 AND p.tombstoned_at IS NULL AND t.tombstoned_at IS NULL AND q.tombstoned_at IS NULL ORDER BY q.created_at").map_err(|e| e.to_string())?;
    let panes: Vec<Value> = panes.query_map(params![network_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"taskId":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"title":r.get::<_,Option<String>>(3)?,"sessionId":r.get::<_,Option<String>>(4)?,"revision":r.get::<_,i64>(5)?,"tombstonedAt":r.get::<_,Option<i64>>(6)?.map(|v|v * 1000)}))).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?;
    Ok(
        json!({"ok":true,"projects":projects,"tasks":tasks,"panes":panes,"devices":network_snapshot["devices"],"members":network_snapshot["members"]}),
    )
}

fn project_catalog_record(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let project_id = field(request, "projectId")?;
    let conn = catalog_connection(data_dir)?;
    conn.query_row(
        "SELECT id,network_id,name,repository_source,default_branch,task_order,revision,created_at FROM projects WHERE id=?1 AND tombstoned_at IS NULL",
        [project_id],
        |row| Ok(json!({"id":row.get::<_,String>(0)?,"networkId":row.get::<_,String>(1)?,"name":row.get::<_,String>(2)?,"repositorySource":row.get::<_,Option<String>>(3)?,"defaultBranch":row.get::<_,String>(4)?,"taskOrder":serde_json::from_str::<Value>(&row.get::<_,String>(5)?).unwrap_or(json!([])),"revision":row.get::<_,i64>(6)?,"createdAt":row.get::<_,i64>(7)?})),
    ).map_err(|_| "project_not_found".to_string())
}

fn task_catalog_record(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task_id = field(request, "taskId")?;
    let conn = catalog_connection(data_dir)?;
    let task = conn.query_row(
        "SELECT t.id,t.project_id,t.title,t.assigned_device_id,t.execution_generation,t.lifecycle,t.pane_order,t.revision,t.created_at,q.base_commit,q.worktree_path,q.state,q.last_error FROM tasks t JOIN task_provisioning q ON q.task_id=t.id WHERE t.id=?1 AND t.tombstoned_at IS NULL",
        [task_id],
        |row| Ok(json!({"id":row.get::<_,String>(0)?,"projectId":row.get::<_,String>(1)?,"title":row.get::<_,String>(2)?,"assignedDeviceId":row.get::<_,String>(3)?,"executionGeneration":row.get::<_,i64>(4)?,"lifecycle":row.get::<_,String>(5)?,"paneOrder":serde_json::from_str::<Value>(&row.get::<_,String>(6)?).unwrap_or(json!([])),"revision":row.get::<_,i64>(7)?,"createdAt":row.get::<_,i64>(8)?,"baseCommit":row.get::<_,String>(9)?,"worktreePath":row.get::<_,String>(10)?,"provisioningState":row.get::<_,String>(11)?,"lastError":row.get::<_,Option<String>>(12)?})),
    ).map_err(|_| "task_not_found".to_string())?;
    let project = project_catalog_record(data_dir, &json!({"projectId":task["projectId"]}))?;
    let mut panes = conn.prepare("SELECT id,kind,title,session_id,revision,created_at FROM task_panes WHERE task_id=?1 AND tombstoned_at IS NULL").map_err(|e|e.to_string())?;
    let panes: Vec<Value> = panes.query_map([task_id], |row| Ok(json!({"id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,"title":row.get::<_,Option<String>>(2)?,"sessionId":row.get::<_,Option<String>>(3)?,"revision":row.get::<_,i64>(4)?,"createdAt":row.get::<_,i64>(5)?}))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"task":task,"project":project,"panes":panes}))
}

async fn rename_project(data_dir: &Path, request: &Value) -> Result<Value, String> {
    mutate_name(data_dir, "projects", "project", "projectId", request).await
}
async fn remove_project(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let project = field(request, "projectId")?;
    let conn = catalog_connection(data_dir)?;
    let response = catalog_write(
        data_dir,
        request,
        "project",
        revision(&conn, "projects", project)?,
        json!({"action":"tombstone","projectId":project}),
    )
    .await?;
    apply_confirmed_tombstone(&conn, "projects", "project", project, &response)?;
    Ok(json!({"ok":true}))
}

fn apply_confirmed_tombstone(
    conn: &rusqlite::Connection,
    table: &str,
    record_type: &str,
    record_id: &str,
    response: &network::raft::CatalogResponse,
) -> Result<(), String> {
    let revision = response
        .revision
        .ok_or_else(|| "committed tombstone did not include a revision".to_string())?;
    let sql = match table {
        "projects" => "UPDATE projects SET tombstoned_at=COALESCE(tombstoned_at,strftime('%s','now')),revision=MAX(revision,?2) WHERE id=?1",
        "tasks" => "UPDATE tasks SET tombstoned_at=COALESCE(tombstoned_at,strftime('%s','now')),revision=MAX(revision,?2) WHERE id=?1",
        "task_panes" => "UPDATE task_panes SET tombstoned_at=COALESCE(tombstoned_at,strftime('%s','now')),revision=MAX(revision,?2) WHERE id=?1",
        _ => return Err("invalid catalog table".into()),
    };
    if conn
        .execute(sql, params![record_id, revision])
        .map_err(|error| error.to_string())?
        == 0
    {
        return Err("not_found".into());
    }
    conn.execute(
        "INSERT INTO tombstones(record_type,record_id,revision,deleted_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(record_type,record_id) DO UPDATE SET revision=MAX(revision,excluded.revision)",
        params![record_type, record_id, revision],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
async fn rename_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    mutate_name(data_dir, "tasks", "task", "taskId", request).await
}
async fn mutate_name(
    data_dir: &Path,
    table: &str,
    kind: &str,
    id_key: &str,
    request: &Value,
) -> Result<Value, String> {
    let record = field(request, id_key)?;
    let value = field(request, if table == "projects" { "name" } else { "title" })?;
    let conn = catalog_connection(data_dir)?;
    let expected = match revision(&conn, table, record) {
        Ok(v) => v,
        Err(_) => return Ok(error("not_found", "Catalog record does not exist")),
    };
    let key = if table == "projects" {
        "projectId"
    } else {
        "taskId"
    };
    catalog_write(
        data_dir,
        request,
        kind,
        expected,
        json!({"action":"update",key:record,if table == "projects" {"name"} else {"title"}:value}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
fn ids(request: &Value, key: &str) -> Result<Vec<String>, String> {
    request
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} is required"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("{key} must contain IDs"))
        })
        .collect()
}
async fn reorder_tasks(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let project = field(request, "projectId")?;
    let order = ids(request, "taskIds")?;
    let conn = catalog_connection(data_dir)?;
    let valid: Vec<String> = conn
        .prepare("SELECT id FROM tasks WHERE project_id=?1 AND tombstoned_at IS NULL")
        .map_err(|e| e.to_string())?
        .query_map([project], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if order.len() != valid.len() || order.iter().any(|x| !valid.contains(x)) {
        return Ok(error(
            "invalid_order",
            "Order must contain every active task once",
        ));
    }
    catalog_write(
        data_dir,
        request,
        "project",
        revision(&conn, "projects", project)?,
        json!({"action":"reorder_tasks","projectId":project,"taskIds":order}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
async fn complete_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let conn = catalog_connection(data_dir)?;
    catalog_write(
        data_dir,
        request,
        "task",
        revision(&conn, "tasks", task)?,
        json!({"action":"lifecycle","taskId":task,"lifecycle":"completed"}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
async fn reactivate_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let conn = catalog_connection(data_dir)?;
    catalog_write(
        data_dir,
        request,
        "task",
        revision(&conn, "tasks", task)?,
        json!({"action":"lifecycle","taskId":task,"lifecycle":"active"}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
async fn reorder_panes(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let order = ids(request, "paneIds")?;
    let conn = catalog_connection(data_dir)?;
    catalog_write(
        data_dir,
        request,
        "task",
        revision(&conn, "tasks", task)?,
        json!({"action":"reorder_panes","taskId":task,"paneIds":order}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
async fn create_pane(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let kind = field(request, "kind")?;
    let conn = catalog_connection(data_dir)?;
    let pane = id(&conn, "pane")?;
    catalog_write(data_dir,request,"pane",revision(&conn,"tasks",task)?,json!({"action":"create","paneId":pane,"taskId":task,"kind":kind,"title":request.get("title").and_then(Value::as_str)})).await?;
    Ok(json!({"ok":true,"paneId":pane}))
}
async fn update_pane(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let pane = field(request, "paneId")?;
    let session = field(request, "sessionId")?;
    let conn = catalog_connection(data_dir)?;
    catalog_write(
        data_dir,
        request,
        "pane",
        revision(&conn, "task_panes", pane)?,
        json!({"action":"update","paneId":pane,"taskId":task,"sessionId":session}),
    )
    .await?;
    Ok(json!({"ok":true}))
}
async fn remove_pane(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let pane = field(request, "paneId")?;
    let conn = catalog_connection(data_dir)?;
    let response = catalog_write(
        data_dir,
        request,
        "pane",
        revision(&conn, "task_panes", pane)?,
        json!({"action":"tombstone","paneId":pane,"taskId":task}),
    )
    .await?;
    apply_confirmed_tombstone(&conn, "task_panes", "pane", pane, &response)?;
    Ok(json!({"ok":true}))
}

fn get_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let conn = config::connection_at(&config::db_path_in(data_dir).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    type TaskRow = (String, String, String, Option<String>, Option<String>);
    let row: Option<TaskRow> = conn.query_row("SELECT t.id,q.state,q.base_commit,q.last_error,q.worktree_path FROM tasks t LEFT JOIN task_provisioning q ON q.task_id=t.id WHERE t.id=?1",params![task],|r|Ok((r.get(0)?,r.get::<_,Option<String>>(1)?.unwrap_or_else(||"unknown".into()),r.get::<_,Option<String>>(2)?.unwrap_or_default(),r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
    Ok(row.map(|(id,state,base,last_error,worktree_path)|json!({"ok":true,"taskId":id,"state":state,"baseCommit":base,"lastError":last_error,"worktreePath":worktree_path})).unwrap_or_else(||error("task_not_found","Task does not exist")))
}

#[cfg(test)]
mod tests;
