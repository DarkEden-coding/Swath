//! Explicit, resumable legacy import. Source JSON is never mutated.
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub operation_id: String,
    pub network_id: String,
    pub source_fingerprint: String,
    pub mappings: Vec<Mapping>,
    #[serde(default)]
    pub target_device_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub workspace_id: String,
    pub project_key: String,
    pub task_key: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub operation_id: String,
    pub source_fingerprint: String,
    pub backup_path: String,
    pub suggested_mappings: Vec<Mapping>,
    pub workspaces: Vec<PreviewWorkspace>,
    pub groups: BTreeMap<String, Vec<String>>,
    pub unsupported: Vec<Value>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub needs_migration: bool,
    pub state: String,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub conflict_id: String,
    pub original: Value,
    pub incoming: Value,
    pub revision_hash: String,
    pub state: String,
    pub resolution_task_id: Option<String>,
    pub proposal: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub conflict_id: String,
    pub revision_hash: String,
    pub source_record_ids: Vec<String>,
    pub action: ProposalAction,
    pub mapping: BTreeMap<String, String>,
    pub diff: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalAction {
    KeepOriginal,
    UseIncoming,
    Merge,
    Manual,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub conflict_id: String,
    pub revision_hash: String,
    pub source_record_ids: Vec<String>,
    pub approve: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repository_identity: String,
    pub git: String,
    pub panes: usize,
    pub pi_sessions: Vec<String>,
}

pub fn migrate(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS migration_resolution_jobs(conflict_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,pane_id TEXT NOT NULL,model TEXT,state TEXT NOT NULL,prompt TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(strftime('%s','now')));CREATE TABLE IF NOT EXISTS app_config_backups(id INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(strftime('%s','now')));CREATE TABLE IF NOT EXISTS legacy_import_operations(operation_id TEXT PRIMARY KEY,network_id TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL DEFAULT(strftime('%s','now')),updated_at INTEGER NOT NULL DEFAULT(strftime('%s','now')));CREATE TABLE IF NOT EXISTS legacy_import_records(operation_id TEXT NOT NULL,stable_key TEXT NOT NULL,kind TEXT NOT NULL,original_json TEXT NOT NULL,imported_id TEXT,PRIMARY KEY(operation_id,stable_key));CREATE TABLE IF NOT EXISTS legacy_import_unsupported(operation_id TEXT NOT NULL,stable_key TEXT NOT NULL,original_json TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(operation_id,stable_key));CREATE TABLE IF NOT EXISTS legacy_import_conflicts(stable_key TEXT PRIMARY KEY,original_json TEXT NOT NULL,incoming_json TEXT NOT NULL,revision_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'unresolved',resolution_task_id TEXT,proposal_json TEXT,audited_at INTEGER);CREATE TABLE IF NOT EXISTS migration_audit(operation_id TEXT NOT NULL,action TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(strftime('%s','now')));")?;
    Ok(())
}
pub fn status(c: &Connection) -> Result<Status> {
    let raw = source(c)?;
    if raw
        .get("workspaces")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return Ok(Status {
            needs_migration: false,
            state: "complete".into(),
            operation_id: None,
        });
    }
    if let Some((operation_id, state)) = c.query_row("SELECT operation_id,state FROM legacy_import_operations ORDER BY updated_at DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()? {
        if state == "complete" { return Ok(Status { needs_migration: false, state, operation_id: Some(operation_id) }); }
        return Ok(Status { needs_migration: true, state, operation_id: Some(operation_id) });
    }
    let exported: Option<i64> = c
        .query_row(
            "SELECT 1 FROM migration_audit WHERE action='backup_exported' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Status {
        needs_migration: true,
        state: if exported.is_some() {
            "exported"
        } else {
            "pending"
        }
        .into(),
        operation_id: Some("legacy-v2-import".into()),
    })
}

pub fn export(c: &Connection) -> Result<Value> {
    let raw = source(c)?;
    c.execute("INSERT INTO migration_audit(operation_id,action,detail_json) VALUES('legacy-v2-import','backup_exported',?1)", params![json!({"sourceFingerprint": fingerprint(&raw)}).to_string()])?;
    Ok(json!({"filename":"swath-legacy-backup.json","content":serde_json::to_string_pretty(&raw)?}))
}

const CONFLICT_MAX_BYTES: usize = 64 * 1024;

pub fn conflicts(c: &Connection) -> Result<Vec<Conflict>> {
    let mut q = c.prepare("SELECT stable_key,original_json,incoming_json,revision_hash,state,resolution_task_id,proposal_json FROM legacy_import_conflicts ORDER BY stable_key")?;
    let rows = q.query_map([], |r| {
        Ok(Conflict {
            conflict_id: r.get(0)?,
            original: serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(Value::Null),
            incoming: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
            revision_hash: r.get(3)?,
            state: r.get(4)?,
            resolution_task_id: r.get(5)?,
            proposal: r
                .get::<_, Option<String>>(6)?
                .and_then(|v| serde_json::from_str(&v).ok()),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn bounded(value: &Value) -> Result<String> {
    let text = value.to_string();
    if text.len() > CONFLICT_MAX_BYTES {
        return Err(anyhow!("conflict content exceeds limit"));
    }
    Ok(text)
}

fn validate_proposal(c: &Connection, p: &Proposal) -> Result<()> {
    if p.conflict_id.is_empty()
        || p.source_record_ids.is_empty()
        || p.source_record_ids.len() > 2
        || p.source_record_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != p.source_record_ids.len()
        || p.source_record_ids.iter().any(|id| id != &p.conflict_id)
    {
        return Err(anyhow!("sourceRecordIds are not part of this conflict"));
    }
    if p.mapping.len() > 64
        || p.mapping
            .iter()
            .any(|(k, v)| k.len() > 1024 || v.len() > 4096)
    {
        return Err(anyhow!("proposal mapping exceeds limit"));
    }
    bounded(&p.diff)?;
    let revision: String = c
        .query_row(
            "SELECT revision_hash FROM legacy_import_conflicts WHERE stable_key=?1",
            [&p.conflict_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("conflict not found"))?;
    if revision != p.revision_hash {
        return Err(anyhow!("stale conflict revision"));
    }
    Ok(())
}
pub fn submit_proposal(c: &Connection, proposal: Proposal) -> Result<Value> {
    migrate(c)?;
    validate_proposal(c, &proposal)?;
    c.execute(
        "UPDATE legacy_import_conflicts SET proposal_json=?2,state='proposed' WHERE stable_key=?1",
        params![proposal.conflict_id, serde_json::to_string(&proposal)?],
    )?;
    Ok(json!({"conflictId":proposal.conflict_id,"state":"proposed"}))
}
pub async fn approve_proposal(
    c: &mut Connection,
    catalog: &crate::network::raft::CatalogService,
    approval: Approval,
) -> Result<Value> {
    approve_proposal_with(c, approval, |request| catalog.client_write(request)).await
}

async fn approve_proposal_with<F, Fut>(
    c: &mut Connection,
    approval: Approval,
    mut write: F,
) -> Result<Value>
where
    F: FnMut(crate::network::raft::CatalogRequest) -> Fut,
    Fut: std::future::Future<
        Output = Result<crate::network::raft::CatalogResponse, crate::network::raft::CatalogError>,
    >,
{
    migrate(c)?;
    if !approval.approve {
        return Err(anyhow!("explicit approval is required"));
    }
    let raw: String = c
        .query_row(
            "SELECT proposal_json FROM legacy_import_conflicts WHERE stable_key=?1",
            [&approval.conflict_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| anyhow!("no proposed resolution"))?;
    let proposal: Proposal = serde_json::from_str(&raw)?;
    if proposal.revision_hash != approval.revision_hash
        || proposal.source_record_ids != approval.source_record_ids
    {
        return Err(anyhow!("stale or mismatched approval"));
    }
    validate_proposal(c, &proposal)?;
    let (network, revision): (String, i64) = c.query_row("SELECT id,revision FROM networks WHERE tombstoned_at IS NULL ORDER BY created_at,id LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(|| anyhow!("initialize or join a network before approving a resolution"))?;
    let response = write(crate::network::raft::CatalogRequest::Migration {
        operation_id: format!("migration-conflict:{}:resolve:{}", proposal.conflict_id, proposal.revision_hash),
        expected_revision: revision,
        payload: json!({"action":"resolve_conflict","networkId":network,"conflictId":proposal.conflict_id,"revisionHash":proposal.revision_hash,"sourceRecordIds":proposal.source_record_ids,"resolutionAction":proposal.action,"mapping":proposal.mapping,"diff":proposal.diff}),
    }).await.map_err(|e| anyhow!(e.message))?;
    if response.status != "committed" {
        return Err(anyhow!(
            "catalog rejected conflict resolution: {}",
            response.status
        ));
    }
    let tx = c.transaction()?;
    tx.execute("UPDATE legacy_import_conflicts SET state='resolved',audited_at=strftime('%s','now') WHERE stable_key=?1",[&approval.conflict_id])?;
    tx.execute("INSERT INTO migration_audit(operation_id,action,detail_json) VALUES(?1,'conflict_approved',?2)",params![&approval.conflict_id,raw])?;
    tx.commit()?;
    Ok(json!({"conflictId":approval.conflict_id,"state":"resolved"}))
}

fn source(c: &Connection) -> Result<Value> {
    let s: Option<String> = c
        .query_row("SELECT json FROM app_config WHERE id=1", [], |r| r.get(0))
        .optional()?;
    Ok(s.map(|x| serde_json::from_str(&x))
        .transpose()?
        .unwrap_or_else(|| json!({"workspaces":[]})))
}
fn fingerprint(v: &Value) -> String {
    let mut h = 1469598103934665603u64;
    for b in serde_json::to_vec(v).unwrap_or_default() {
        h = (h ^ (b as u64)).wrapping_mul(1099511628211)
    }
    format!("{h:016x}")
}
fn git(path: &str) -> (String, String) {
    let p = Path::new(path);
    if !p.is_dir() {
        return (format!("path:{path}"), "unavailable".into());
    }
    let o = std::process::Command::new("git")
        .args(["-C", path, "rev-parse", "--git-common-dir"])
        .output();
    match o {
        Ok(o) if o.status.success() => (
            format!("git:{}", String::from_utf8_lossy(&o.stdout).trim()),
            "git".into(),
        ),
        _ => (
            format!(
                "path:{}",
                fs::canonicalize(p)
                    .unwrap_or_else(|_| p.to_path_buf())
                    .display()
            ),
            "non-git".into(),
        ),
    }
}
fn collect(v: &Value, s: &mut Vec<String>, u: &mut Vec<Value>) -> usize {
    match v.get("type").and_then(Value::as_str) {
        Some("pane") => {
            let k = v.get("kind").and_then(Value::as_str).unwrap_or("");
            if k == "piAgent" {
                if let Some(x) = v
                    .pointer("/metadata/piSessionFile")
                    .or_else(|| v.pointer("/metadata/sessionId"))
                    .and_then(Value::as_str)
                {
                    s.push(x.into())
                }
            }
            if !matches!(k, "terminal" | "piAgent" | "gitManager" | "fileBrowser") {
                u.push(v.clone())
            };
            1
        }
        Some("split") => {
            collect(v.get("first").unwrap_or(&Value::Null), s, u)
                + collect(v.get("second").unwrap_or(&Value::Null), s, u)
        }
        _ => 0,
    }
}

fn pane_leaves<'a>(value: &'a Value, panes: &mut Vec<&'a Value>) {
    match value.get("type").and_then(Value::as_str) {
        Some("pane") => panes.push(value),
        Some("split") => {
            pane_leaves(value.get("first").unwrap_or(&Value::Null), panes);
            pane_leaves(value.get("second").unwrap_or(&Value::Null), panes);
        }
        _ => {}
    }
}

fn workspace_panes(workspace: &Value) -> Vec<&Value> {
    let mut panes = Vec::new();
    for view in workspace
        .get("views")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        pane_leaves(view.get("layout").unwrap_or(&Value::Null), &mut panes);
    }
    panes
}
pub fn preview(c: &Connection, id: &str) -> Result<Preview> {
    let raw = source(c)?;
    let source_fingerprint = fingerprint(&raw);
    // Preserve an immutable local copy before the user can confirm anything.
    c.execute(
        "INSERT OR IGNORE INTO app_config_backups(json,reason) VALUES(?1,?2)",
        params![
            raw.to_string(),
            format!("migration-preview:{id}:{source_fingerprint}")
        ],
    )?;
    let mut groups = BTreeMap::new();
    let mut unsupported = vec![];
    let mut workspaces = vec![];
    for w in raw
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let wid = w
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let path = w
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (identity, git_state) = git(&path);
        let (mut sessions, mut panes) = (vec![], 0);
        for view in w
            .get("views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            panes += collect(
                view.get("layout").unwrap_or(&Value::Null),
                &mut sessions,
                &mut unsupported,
            )
        }
        if let Some(g) = w.get("groupId").and_then(Value::as_str) {
            groups
                .entry(g.into())
                .or_insert_with(Vec::new)
                .push(wid.clone())
        }
        workspaces.push(PreviewWorkspace {
            id: wid,
            name: w
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled")
                .into(),
            path,
            repository_identity: identity,
            git: git_state,
            panes,
            pi_sessions: sessions,
        })
    }
    let mut seen_project_keys = HashMap::<String, usize>::new();
    let suggested_mappings = workspaces
        .iter()
        .map(|w| {
            let occurrence = seen_project_keys
                .entry(w.repository_identity.clone())
                .and_modify(|count| *count += 1)
                .or_insert(1);
            Mapping {
                workspace_id: w.id.clone(),
                project_key: if *occurrence == 1 {
                    w.repository_identity.clone()
                } else {
                    format!("{}#{}", w.repository_identity, w.id)
                },
                task_key: w.id.clone(),
            }
        })
        .collect();
    Ok(Preview {
        operation_id: id.into(),
        source_fingerprint,
        backup_path: format!("app_config_backups/migration-preview:{id}"),
        suggested_mappings,
        workspaces,
        groups,
        unsupported,
    })
}
/// A confirmed mapping is the user's consent to initialize a non-Git source; no source is deleted or pushed.
pub async fn confirm(
    data_dir: &Path,
    c: &mut Connection,
    catalog: &crate::network::raft::CatalogService,
    r: ImportRequest,
) -> Result<Value> {
    confirm_with(
        c,
        r,
        |request| catalog.client_write(request),
        |task, pane, generation, path| {
            if !path.is_file() {
                return Ok(false);
            }
            crate::pi_session_store::import_jsonl(data_dir, task, pane, generation, path)
                .map_err(anyhow::Error::msg)?;
            Ok(true)
        },
    )
    .await
}

pub(crate) async fn confirm_with<F, Fut, I>(
    c: &mut Connection,
    r: ImportRequest,
    mut write: F,
    mut import_session: I,
) -> Result<Value>
where
    F: FnMut(crate::network::raft::CatalogRequest) -> Fut,
    Fut: std::future::Future<
        Output = Result<crate::network::raft::CatalogResponse, crate::network::raft::CatalogError>,
    >,
    I: FnMut(&str, &str, i64, &Path) -> Result<bool>,
{
    fn dedup_revision(c: &Connection, operation_id: &str, fallback: i64) -> Result<i64> {
        Ok(c.query_row(
            "SELECT CAST(json_extract(request_hash,'$[1]') AS INTEGER) FROM operation_dedup WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(fallback))
    }

    if r.operation_id.trim().is_empty() {
        return Err(anyhow!("operationId is required"));
    }
    migrate(c)?;
    let raw = source(c)?;
    let hash = fingerprint(&raw);
    if r.source_fingerprint != hash {
        return Err(anyhow!(
            "legacy source changed; preview and approve the current fingerprint"
        ));
    }
    if let Some((old, result)) = c
        .query_row(
            "SELECT source_hash,result_json FROM legacy_import_operations WHERE operation_id=?1",
            params![r.operation_id],
            |x| Ok((x.get::<_, String>(0)?, x.get::<_, Option<String>>(1)?)),
        )
        .optional()?
    {
        if old != hash {
            return Err(anyhow!("operationId was reused for different legacy data"));
        }
        if let Some(v) = result {
            return Ok(serde_json::from_str(&v)?);
        }
    }
    let p = preview(c, &r.operation_id)?;
    let maps: HashMap<_, _> = r
        .mappings
        .iter()
        .map(|x| (x.workspace_id.as_str(), x))
        .collect();
    let device: String = if let Some(device) = r.target_device_id.as_deref() {
        c.query_row(
            "SELECT id FROM devices WHERE id=?1 AND network_id=?2 AND tombstoned_at IS NULL",
            params![device, r.network_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("target device is not enrolled in this network"))?
    } else {
        c.query_row(
            "SELECT d.id FROM devices d LEFT JOIN raft_node_members r ON r.network_id=d.network_id AND r.device_id=d.id LEFT JOIN catalog_nodes c ON c.network_id=d.network_id AND c.node_id=r.node_id WHERE d.network_id=?1 AND d.tombstoned_at IS NULL AND (d.enrollment_id='local-device' OR c.node_id IS NOT NULL) ORDER BY CASE WHEN d.enrollment_id='local-device' THEN 0 ELSE 1 END LIMIT 1",
            params![r.network_id],
            |x| x.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("initialize or join a network before importing"))?
    };
    let revision: i64 = c.query_row(
        "SELECT revision FROM networks WHERE id=?1 AND tombstoned_at IS NULL",
        params![r.network_id],
        |x| x.get(0),
    )?;
    let fence_operation = format!("migration:{}", r.operation_id);
    let fence_revision = dedup_revision(c, &fence_operation, revision)?;
    c.execute("INSERT INTO legacy_import_operations(operation_id,network_id,source_hash,state) VALUES(?1,?2,?3,'importing') ON CONFLICT(operation_id) DO UPDATE SET state='importing',updated_at=strftime('%s','now')", params![r.operation_id,r.network_id,hash])?;

    let mut records: Vec<Value> = raw.get("workspaces").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|w| {
            let id = w.get("id").and_then(Value::as_str)?;
            maps.contains_key(id).then(|| json!({"stableKey":format!("workspace:{id}"),"kind":"workspace","importedId":format!("legacy-project:{}:{}", r.operation_id, maps[id].project_key),"original":w}))
        }).collect();
    records.extend(p.unsupported.iter().enumerate().map(|(i, item)| json!({"stableKey":format!("pane:{i}"),"kind":"unsupported_pane","original":item})));
    // Stable keys are global across import attempts. Identical originals are deduped; divergent
    // originals are retained on both sides and cannot be imported until explicitly resolved.
    records.retain(|record| {
        let key = record["stableKey"].as_str().unwrap_or("");
        let incoming = record["original"].to_string();
        let prior: Option<String> = c.query_row("SELECT original_json FROM legacy_import_records WHERE stable_key=?1 ORDER BY operation_id LIMIT 1", [key], |row| row.get(0)).optional().unwrap_or(None);
        let Some(prior) = prior else { return true };
        let prior_original = serde_json::from_str::<Value>(&prior).ok().and_then(|v| v.get("original").cloned()).map(|v| v.to_string()).unwrap_or(prior);
        // Keep identical records in the consensus request so a retry produces the exact same
        // operation hash. The catalog projection itself already inserts them idempotently.
        if prior_original == incoming { return true; }
        let conflict_id = format!("legacy:{}", key);
        let revision_hash = fingerprint(&json!({"original":prior_original,"incoming":incoming}));
        let _ = c.execute("INSERT OR IGNORE INTO legacy_import_conflicts(stable_key,original_json,incoming_json,revision_hash) VALUES(?1,?2,?3,?4)", params![conflict_id,prior_original,incoming,revision_hash]);
        false
    });
    // This is the migration's consensus fence: no catalog projection is changed before it commits.
    write(crate::network::raft::CatalogRequest::Migration {
        operation_id: fence_operation,
        expected_revision: fence_revision,
        payload: json!({"networkId":r.network_id,"batchId":r.operation_id,"records":records}),
    })
    .await
    .map_err(|e| anyhow!("migration catalog fence failed: {}", e.message))?;

    let mut n = 0;
    let mut pane_count = 0;
    let mut session_count = 0;
    for w in raw
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = w.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(m) = maps.get(id) else { continue };
        let path = w.get("path").and_then(Value::as_str).unwrap_or("");
        let (_identity, state) = git(path);
        let existing_project = m.project_key.strip_prefix("existing:");
        let project = existing_project
            .map(str::to_owned)
            .unwrap_or_else(|| format!("legacy-project:{}:{}", r.operation_id, m.project_key));
        let task = format!("legacy-task:{}:{}", r.operation_id, m.task_key);
        let name = w.get("name").and_then(Value::as_str).unwrap_or("Untitled");
        if let Some(existing_project) = existing_project {
            let belongs_to_network: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND network_id=?2 AND tombstoned_at IS NULL)",
                params![existing_project, r.network_id],
                |row| row.get(0),
            )?;
            if !belongs_to_network {
                return Err(anyhow!(
                    "mapped project does not exist in this network: {existing_project}"
                ));
            }
        } else {
            let project_operation =
                format!("migration:{}:project:{}", r.operation_id, m.project_key);
            let response = write(crate::network::raft::CatalogRequest::Project {
                expected_revision: dedup_revision(c, &project_operation, 0)?,
                operation_id: project_operation,
                payload: json!({"action":"create","projectId":project,"networkId":r.network_id,"name":name,"repositorySource":path,"defaultBranch":"main"}),
            }).await.map_err(|e| anyhow!("project import failed for {name}: {}", e.message))?;
            if response.status != "committed" {
                return Err(anyhow!(
                    "project import failed for {name}: {}",
                    response.status
                ));
            }
        }
        let project_revision: i64 = c
            .query_row(
                "SELECT revision FROM projects WHERE id=?1 AND tombstoned_at IS NULL",
                [&project],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(1);
        let task_operation = format!("migration:{}:task:{}", r.operation_id, m.task_key);
        let response = write(crate::network::raft::CatalogRequest::Task {
            expected_revision: dedup_revision(c, &task_operation, project_revision)?,
            operation_id: task_operation,
            payload: json!({"action":"create","taskId":task,"projectId":project,"title":name,"deviceId":device,"baseCommit":"legacy","worktreePath":path}),
        }).await.map_err(|e| anyhow!("task import failed for {name}: {}", e.message))?;
        if response.status != "committed" {
            return Err(anyhow!(
                "task import failed for {name}: {}",
                response.status
            ));
        }
        for (pane_index, legacy_pane) in workspace_panes(w).into_iter().enumerate() {
            let kind = legacy_pane
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !matches!(kind, "terminal" | "piAgent" | "gitManager" | "fileBrowser") {
                continue;
            }
            let source_pane = legacy_pane
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{id}:{pane_index}"));
            let pane = format!("legacy-pane:{}:{}", r.operation_id, source_pane);
            let pane_operation = format!("migration:{}:pane:{}", r.operation_id, source_pane);
            let task_revision: i64 = c
                .query_row(
                    "SELECT revision FROM tasks WHERE id=?1 AND tombstoned_at IS NULL",
                    [&task],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(pane_index as i64 + 1);
            let metadata = legacy_pane
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let session_file = metadata
                .get("piSessionFile")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(str::to_owned);
            let session_id = metadata
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(&source_pane)
                .to_owned();
            let response = write(crate::network::raft::CatalogRequest::Pane {
                expected_revision: dedup_revision(c, &pane_operation, task_revision)?,
                operation_id: pane_operation,
                payload: json!({
                    "action":"create",
                    "paneId":pane,
                    "taskId":task,
                    "kind":kind,
                    "title":legacy_pane.get("title").and_then(Value::as_str),
                    "sessionId":(kind == "piAgent").then_some(session_id),
                    "metadata":metadata,
                }),
            })
            .await
            .map_err(|e| anyhow!("pane import failed for {name}/{source_pane}: {}", e.message))?;
            if response.status != "committed" {
                return Err(anyhow!(
                    "pane import failed for {name}/{source_pane}: {}",
                    response.status
                ));
            }
            pane_count += 1;
            if let Some(path) = session_file {
                let session_key = format!("pi-session:{path}");
                let already_imported: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM legacy_import_records WHERE operation_id=?1 AND stable_key=?2 AND kind='pi_session_import')",
                    params![r.operation_id, session_key],
                    |row| row.get(0),
                )?;
                if already_imported {
                    session_count += 1;
                } else if import_session(&task, &pane, 1, Path::new(&path))? {
                    c.execute(
                        "INSERT OR IGNORE INTO legacy_import_records(operation_id,stable_key,kind,original_json,imported_id) VALUES(?1,?2,'pi_session_import',?3,?4)",
                        params![r.operation_id, session_key, json!({"path":path}).to_string(), pane],
                    )?;
                    session_count += 1;
                }
            }
        }
        if state == "non-git" {
            crate::git::prepare_project_source(path).map_err(|e| anyhow!(e))?;
        }
        n += 1;
    }
    for (i, item) in p.unsupported.iter().enumerate() {
        c.execute("INSERT OR IGNORE INTO legacy_import_unsupported(operation_id,stable_key,original_json,reason) VALUES(?1,?2,?3,'unsupported pane retained')",params![r.operation_id,format!("pane:{i}"),item.to_string()])?;
    }
    // A crashed import may have committed a prefix of its catalog mutations before its local
    // operation record could be completed. Once a retry succeeds, hide those superseded tasks
    // and projects through consensus so every device sees one canonical import.
    let superseded: Vec<String> = {
        let mut statement = c.prepare("SELECT operation_id FROM legacy_import_operations WHERE source_hash=?1 AND operation_id<>?2 AND state<>'complete'")?;
        let rows = statement
            .query_map(params![hash, r.operation_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for old_operation in superseded {
        let task_prefix = format!("legacy-task:{old_operation}:%");
        let old_tasks: Vec<(String, i64)> = {
            let mut statement = c.prepare(
                "SELECT id,revision FROM tasks WHERE id LIKE ?1 AND tombstoned_at IS NULL",
            )?;
            let rows = statement
                .query_map([&task_prefix], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (task_id, task_revision) in old_tasks {
            let operation_id = format!(
                "migration:{}:cleanup:{}:task:{}",
                r.operation_id, old_operation, task_id
            );
            let response = write(crate::network::raft::CatalogRequest::Task {
                expected_revision: dedup_revision(c, &operation_id, task_revision)?,
                operation_id,
                payload: json!({"action":"tombstone","taskId":task_id}),
            })
            .await
            .map_err(|e| anyhow!("failed to clean up superseded task: {}", e.message))?;
            if response.status != "committed" {
                return Err(anyhow!(
                    "failed to clean up superseded task: {}",
                    response.status
                ));
            }
        }
        let project_prefix = format!("legacy-project:{old_operation}:%");
        let old_projects: Vec<(String, i64)> = {
            let mut statement = c.prepare(
                "SELECT id,revision FROM projects WHERE id LIKE ?1 AND tombstoned_at IS NULL",
            )?;
            let rows = statement
                .query_map([&project_prefix], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (project_id, project_revision) in old_projects {
            let operation_id = format!(
                "migration:{}:cleanup:{}:project:{}",
                r.operation_id, old_operation, project_id
            );
            let response = write(crate::network::raft::CatalogRequest::Project {
                expected_revision: dedup_revision(c, &operation_id, project_revision)?,
                operation_id,
                payload: json!({"action":"tombstone","projectId":project_id}),
            })
            .await
            .map_err(|e| anyhow!("failed to clean up superseded project: {}", e.message))?;
            if response.status != "committed" {
                return Err(anyhow!(
                    "failed to clean up superseded project: {}",
                    response.status
                ));
            }
        }
        c.execute(
            "UPDATE legacy_import_operations SET state='complete',result_json=?2,updated_at=strftime('%s','now') WHERE operation_id=?1",
            params![old_operation, json!({"state":"superseded","supersededBy":r.operation_id}).to_string()],
        )?;
    }
    let result = json!({"operationId":r.operation_id,"state":"complete","imported":n,"panes":pane_count,"piSessions":session_count,"unsupported":p.unsupported.len()});
    let tx = c.transaction()?;
    tx.execute("UPDATE legacy_import_operations SET state='complete',result_json=?2,updated_at=strftime('%s','now') WHERE operation_id=?1",params![r.operation_id,result.to_string()])?;
    tx.execute("INSERT INTO migration_audit(operation_id,action,detail_json)VALUES(?1,'import_confirmed',?2)",params![r.operation_id,result.to_string()])?;
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::network::migrate(&c).unwrap();
        crate::task_store::migrate(&c).unwrap();
        migrate(&c).unwrap();
        c.execute_batch("CREATE TABLE app_config(id INTEGER PRIMARY KEY,json TEXT NOT NULL); INSERT INTO networks(id,name,schema_version,revision,created_at) VALUES('n','N',2,1,0); INSERT INTO devices(id,network_id,display_name,hostname,platform,enrollment_id,revision,created_at) VALUES('d','n','D','d','test','local-device',1,0); INSERT INTO app_config(id,json) VALUES(1,'{\"workspaces\":[{\"id\":\"w\",\"name\":\"W\",\"path\":\"/missing\",\"views\":[]}]}');").unwrap();
        c
    }
    fn request() -> ImportRequest {
        ImportRequest {
            operation_id: "op".into(),
            network_id: "n".into(),
            source_fingerprint: fingerprint(&source(&database()).unwrap()),
            mappings: vec![Mapping {
                workspace_id: "w".into(),
                project_key: "p".into(),
                task_key: "t".into(),
            }],
            target_device_id: None,
        }
    }

    fn conflict(c: &Connection) {
        migrate(c).unwrap();
        c.execute("INSERT INTO legacy_import_conflicts(stable_key,original_json,incoming_json,revision_hash) VALUES('c','{\"a\":1}','{\"a\":2}','r')", []).unwrap();
    }

    #[test]
    fn exporting_backup_does_not_skip_required_import() {
        let c = database();
        export(&c).unwrap();
        let migration = status(&c).unwrap();
        assert!(migration.needs_migration);
        assert_eq!(migration.state, "exported");
    }

    #[test]
    fn preview_disambiguates_repeated_repository_identities() {
        let c = database();
        c.execute(
            "UPDATE app_config SET json=?1 WHERE id=1",
            [json!({"workspaces":[
                {"id":"first","name":"First","path":"/missing","views":[]},
                {"id":"second","name":"Second","path":"/missing","views":[]}
            ]})
            .to_string()],
        )
        .unwrap();

        let migration = preview(&c, "op").unwrap();
        assert_eq!(migration.suggested_mappings[0].project_key, "path:/missing");
        assert_eq!(
            migration.suggested_mappings[1].project_key,
            "path:/missing#second"
        );
    }
    fn proposal() -> Proposal {
        Proposal {
            conflict_id: "c".into(),
            revision_hash: "r".into(),
            source_record_ids: vec!["c".into()],
            action: ProposalAction::Merge,
            mapping: BTreeMap::new(),
            diff: json!({"a":2}),
        }
    }
    fn committed() -> crate::network::raft::CatalogResponse {
        crate::network::raft::CatalogResponse {
            value: None,
            revision: Some(2),
            status: "committed".into(),
        }
    }

    #[tokio::test]
    async fn invalid_approvals_write_nothing_and_valid_approval_fences_before_local_resolution() {
        let mut c = database();
        conflict(&c);
        let mut malformed = proposal();
        malformed.source_record_ids = vec!["other".into()];
        c.execute(
            "UPDATE legacy_import_conflicts SET proposal_json=?1 WHERE stable_key='c'",
            [serde_json::to_string(&malformed).unwrap()],
        )
        .unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        assert!(approve_proposal_with(
            &mut c,
            Approval {
                conflict_id: "c".into(),
                revision_hash: "r".into(),
                source_record_ids: vec!["other".into()],
                approve: true
            },
            {
                let writes = writes.clone();
                move |r| {
                    let writes = writes.clone();
                    async move {
                        writes.lock().unwrap().push(r);
                        Ok(committed())
                    }
                }
            }
        )
        .await
        .is_err());
        assert!(writes.lock().unwrap().is_empty());
        for approval in [
            Approval {
                conflict_id: "c".into(),
                revision_hash: "r".into(),
                source_record_ids: vec!["c".into()],
                approve: false,
            },
            Approval {
                conflict_id: "c".into(),
                revision_hash: "stale".into(),
                source_record_ids: vec!["c".into()],
                approve: true,
            },
        ] {
            let mut c = database();
            conflict(&c);
            submit_proposal(&c, proposal()).unwrap();
            let writes = Arc::new(Mutex::new(Vec::new()));
            assert!(approve_proposal_with(&mut c, approval, {
                let writes = writes.clone();
                move |r| {
                    let writes = writes.clone();
                    async move {
                        writes.lock().unwrap().push(r);
                        Ok(committed())
                    }
                }
            })
            .await
            .is_err());
            assert!(writes.lock().unwrap().is_empty());
        }
        let mut c = database();
        conflict(&c);
        submit_proposal(&c, proposal()).unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        approve_proposal_with(
            &mut c,
            Approval {
                conflict_id: "c".into(),
                revision_hash: "r".into(),
                source_record_ids: vec!["c".into()],
                approve: true,
            },
            {
                let writes = writes.clone();
                move |r| {
                    let writes = writes.clone();
                    async move {
                        writes.lock().unwrap().push(r);
                        Ok(committed())
                    }
                }
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(&writes.lock().unwrap()[0], crate::network::raft::CatalogRequest::Migration { payload, .. } if payload["action"] == "resolve_conflict")
        );
        assert_eq!(writes.lock().unwrap().len(), 1);
        assert_eq!(
            c.query_row(
                "SELECT state FROM legacy_import_conflicts WHERE stable_key='c'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "resolved"
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn import_preserves_supported_panes_and_pi_session_files() {
        let mut c = database();
        let legacy = json!({"workspaces":[{
            "id":"w","name":"W","path":"/missing","views":[{"layout":{
                "type":"split","first":{"type":"pane","id":"terminal","kind":"terminal","metadata":{"cwd":"/missing"}},
                "second":{"type":"pane","id":"agent","kind":"piAgent","title":"Chat","metadata":{"piSessionFile":"/tmp/chat.jsonl"}}
            }}]
        }]});
        c.execute(
            "UPDATE app_config SET json=?1 WHERE id=1",
            [legacy.to_string()],
        )
        .unwrap();
        let mut import_request = request();
        import_request.source_fingerprint = fingerprint(&source(&c).unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let writer = {
            let calls = calls.clone();
            move |request| {
                let calls = calls.clone();
                async move {
                    calls.lock().unwrap().push(request);
                    Ok(committed())
                }
            }
        };
        let imports = Arc::new(Mutex::new(Vec::new()));
        let importer = {
            let imports = imports.clone();
            move |task: &str, pane: &str, generation, path: &Path| {
                imports.lock().unwrap().push((
                    task.to_owned(),
                    pane.to_owned(),
                    generation,
                    path.to_owned(),
                ));
                Ok(true)
            }
        };

        let result = confirm_with(&mut c, import_request, writer, importer)
            .await
            .unwrap();
        let recorded = calls.lock().unwrap();
        let pane_kinds: Vec<_> = recorded
            .iter()
            .filter_map(|request| match request {
                crate::network::raft::CatalogRequest::Pane { payload, .. } => {
                    payload.get("kind").and_then(Value::as_str)
                }
                _ => None,
            })
            .collect();
        assert_eq!(pane_kinds, vec!["terminal", "piAgent"]);
        assert_eq!(imports.lock().unwrap().len(), 1);
        assert_eq!(result["panes"], 2);
        assert_eq!(result["piSessions"], 1);
    }

    #[tokio::test]
    async fn import_can_add_legacy_tasks_to_an_existing_project() {
        let mut c = database();
        c.execute("INSERT INTO projects(id,network_id,name,repository_source,default_branch,revision,created_at) VALUES('existing-project','n','W','/existing','main',1,0)", []).unwrap();
        let source = source(&c).unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let result = confirm_with(
            &mut c,
            ImportRequest {
                operation_id: "merge-existing".into(),
                network_id: "n".into(),
                source_fingerprint: fingerprint(&source),
                mappings: vec![Mapping {
                    workspace_id: "w".into(),
                    project_key: "existing:existing-project".into(),
                    task_key: "w".into(),
                }],
                target_device_id: Some("d".into()),
            },
            {
                let writes = writes.clone();
                move |request| {
                    let writes = writes.clone();
                    async move {
                        writes.lock().unwrap().push(request);
                        Ok(committed())
                    }
                }
            },
            |_, _, _, _| Ok(false),
        )
        .await
        .unwrap();
        assert_eq!(result["imported"], 1);
        let writes = writes.lock().unwrap();
        assert!(!writes.iter().any(|request| matches!(
            request,
            crate::network::raft::CatalogRequest::Project { .. }
        )));
        assert!(writes.iter().any(|request| matches!(request, crate::network::raft::CatalogRequest::Task { payload, .. } if payload["projectId"] == "existing-project")));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn replay_uses_stable_operation_ids() {
        let mut c = database();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let writer = |r: crate::network::raft::CatalogRequest| {
            let calls = calls.clone();
            async move {
                calls.lock().unwrap().push(r);
                Ok(crate::network::raft::CatalogResponse {
                    value: None,
                    revision: Some(1),
                    status: "committed".into(),
                })
            }
        };
        confirm_with(&mut c, request(), writer, |_, _, _, _| Ok(false))
            .await
            .unwrap();
        let recorded = calls.lock().unwrap();
        assert!(
            matches!(&recorded[0], crate::network::raft::CatalogRequest::Migration { operation_id, .. } if operation_id == "migration:op")
        );
        assert!(
            matches!(&recorded[1], crate::network::raft::CatalogRequest::Project { operation_id, .. } if operation_id == "migration:op:project:p")
        );
        assert!(
            matches!(&recorded[2], crate::network::raft::CatalogRequest::Task { operation_id, .. } if operation_id == "migration:op:task:t")
        );
        let calls_after_first = recorded.len();
        drop(recorded);
        let writer =
            |r: crate::network::raft::CatalogRequest| async move { panic!("replay wrote {r:?}") };
        confirm_with(&mut c, request(), writer, |_, _, _, _| Ok(false))
            .await
            .unwrap();
        assert_eq!(calls_after_first, 3);
    }

    #[tokio::test]
    async fn quorum_rejection_leaves_import_retryable() {
        let mut c = database();
        let err = crate::network::raft::CatalogError {
            code: "quorum_unavailable".into(),
            message: "quorum".into(),
        };
        assert!(confirm_with(
            &mut c,
            request(),
            |_| {
                let err = err.clone();
                async move { Err(err) }
            },
            |_, _, _, _| Ok(false)
        )
        .await
        .is_err());
        assert_eq!(
            c.query_row(
                "SELECT state FROM legacy_import_operations WHERE operation_id='op'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "importing"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM projects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
