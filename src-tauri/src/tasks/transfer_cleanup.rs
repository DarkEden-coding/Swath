//! Durable local executor transfer and safe cleanup operations.
//!
//! The catalog records every phase before filesystem work.  Retrying an operation ID resumes the
//! next safe phase; after ownership changes the old worktree is never made writable again.
use super::{catalog_connection, catalog_write, error, field, id, revision};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const TRANSFER_DONE: &str = "complete";
const CHUNK_BYTES: usize = 1024 * 1024;

/// Small dependency-free SHA-256 implementation. Transfer receipts are security boundaries, so
/// `DefaultHasher` (which is randomized and non-cryptographic) is never used here.
fn sha256(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let bit_len = (bytes.len() as u64) * 8;
    let mut input = bytes.to_vec();
    input.push(0x80);
    while !(input.len() + 8).is_multiple_of(64) {
        input.push(0);
    }
    input.extend_from_slice(&bit_len.to_be_bytes());
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for block in input.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, word) in w[..16].iter_mut().enumerate() {
            *word = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            w[i] = w[i - 16]
                .wrapping_add(
                    w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3),
                )
                .wrapping_add(w[i - 7])
                .wrapping_add(
                    w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10),
                );
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(s0).wrapping_add(maj);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}
fn hash(value: &str) -> String {
    sha256(value.as_bytes())
}

fn git(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
fn task_row(
    conn: &rusqlite::Connection,
    task: &str,
) -> Result<(String, i64, String, String), String> {
    conn.query_row("SELECT assigned_device_id,execution_generation,project_id,worktree_path FROM tasks t JOIN task_provisioning p ON p.task_id=t.id WHERE t.id=?1 AND t.tombstoned_at IS NULL", params![task], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_| "task_not_found".into())
}
fn manifest(path: &Path, root: &Path, entries: &mut Vec<Value>) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let file = entry.path();
        let meta = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        let relative = file
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::MetadataExt;
            meta.mode()
        };
        #[cfg(not(unix))]
        let mode = 0;
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&file).map_err(|e| e.to_string())?;
            entries.push(json!({"path":relative,"kind":"symlink","target":target.to_string_lossy(),"mode":mode}));
        } else if meta.is_dir() {
            entries.push(json!({"path":relative,"kind":"dir","mode":mode}));
            manifest(&file, root, entries)?;
        } else if meta.is_file() {
            entries.push(json!({"path":relative,"kind":"file","size":meta.len(),"sha256":sha256(&fs::read(&file).map_err(|e| e.to_string())?),"mode":mode}));
        }
    }
    Ok(())
}
fn excluded(path: &str, exclusions: &[String]) -> bool {
    exclusions.iter().any(|rule| {
        path == rule
            || path
                .strip_prefix(rule)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn validated_exclusions(request: &Value) -> Result<Vec<String>, String> {
    request
        .get("exclusions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| {
            let path = v
                .as_str()
                .ok_or("invalid_exclusion")?
                .trim()
                .trim_matches('/')
                .to_string();
            if path.is_empty() || !safe_relative(Path::new(&path)) {
                Err("invalid_exclusion".into())
            } else {
                Ok(path)
            }
        })
        .collect()
}

fn snapshot_with_exclusions(path: &Path, exclusions: &[String]) -> Result<Value, String> {
    let status = git(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
        ],
    )?;
    let refs = git(path, &["show-ref", "--head"])?;
    let head = git(path, &["rev-parse", "HEAD"])?;
    let mut entries = Vec::new();
    manifest(path, path, &mut entries)?;
    entries.retain(|entry| !excluded(entry["path"].as_str().unwrap_or_default(), exclusions));
    entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let index = git(path, &["diff", "--cached", "--binary"])?;
    let manifest_hash = hash(&serde_json::to_string(&entries).map_err(|e| e.to_string())?);
    Ok(
        json!({"head":head.trim(),"status":status,"refs":refs,"manifest":entries,"worktreeSnapshot":manifest_hash,"indexSnapshot":hash(&index)}),
    )
}
fn snapshot(path: &Path) -> Result<Value, String> {
    snapshot_with_exclusions(path, &[])
}
fn safe_relative(path: &Path) -> bool {
    !path.is_absolute()
        && !path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}
/// A relative link may use `..`, but only to navigate within its transfer root.
fn safe_symlink_target(root: &Path, link: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let Ok(relative_parent) = link.parent().unwrap_or(root).strip_prefix(root) else {
        return false;
    };
    let mut depth = 0usize;
    for component in relative_parent.components().chain(target.components()) {
        match component {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                if depth == 0 {
                    return false;
                } else {
                    depth -= 1
                }
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}
fn safe_symlink_relative(link: &str, target: &str) -> bool {
    safe_symlink_target(
        Path::new("/transfer-root"),
        &Path::new("/transfer-root").join(link),
        Path::new(target),
    )
}
fn clear_worktree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            fs::remove_dir_all(p)
        } else {
            fs::remove_file(p)
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// Copies file content in fixed-size pieces. The offset is durable at the filesystem boundary:
/// retries append only after validating the already-written prefix.
fn stream_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    let offset = fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
    let source_len = input.metadata().map_err(|e| e.to_string())?.len();
    if offset > source_len {
        return Err("resume_offset_invalid".into());
    }
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    let mut chunk = [0u8; CHUNK_BYTES];
    loop {
        let n = input.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        output.write_all(&chunk[..n]).map_err(|e| e.to_string())?;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    if sha256(&fs::read(source).map_err(|e| e.to_string())?)
        != sha256(&fs::read(destination).map_err(|e| e.to_string())?)
    {
        return Err("chunk_checksum_mismatch".into());
    }
    Ok(())
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    copy_tree_from(source, destination, source)
}
fn copy_tree_from(source: &Path, destination: &Path, root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        if !safe_relative(Path::new(&name)) {
            return Err("unsafe_transfer_path".into());
        }
        let from = entry.path();
        let to = destination.join(&name);
        let meta = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&from).map_err(|e| e.to_string())?;
            if !safe_symlink_target(root, &from, &target) {
                return Err(format!("symlink_escape: {}", from.display()));
            };
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, to).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            {
                return Err("symlink_unsupported_on_destination".into());
            }
        } else if meta.is_dir() {
            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            copy_tree_from(&from, &to, root)?;
        } else if meta.is_file() {
            if to.exists() {
                return Err(format!("destination_overwrite: {}", to.display()));
            }
            stream_file(&from, &to)?;
        }
    }
    Ok(())
}
type StoredOperation = (String, String, i64, String, String, String);

fn op(conn: &rusqlite::Connection, operation_id: &str) -> Result<Option<StoredOperation>, String> {
    conn.query_row("SELECT task_id,phase,generation,source_path,destination_path,snapshot_json FROM task_operations WHERE operation_id=?1",params![operation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e|e.to_string())
}
/// Checks tools, managed source, disk capacity and Git portability before any source is frozen.
pub async fn transfer_preflight(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let dest = field(request, "destinationDeviceId")?;
    let operation_id = request
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .map(str::to_string);
    let conn = catalog_connection(data_dir)?;
    let (source_device, generation, project, source) = task_row(&conn, task)?;
    if source_device == dest {
        return Ok(error(
            "destination_not_ready",
            "Destination already owns this task",
        ));
    };
    let source = PathBuf::from(source);
    let exclusions = validated_exclusions(request)?;
    if !source.is_dir() {
        return Ok(error(
            "source_unavailable",
            "Managed source worktree is unavailable",
        ));
    };
    if Command::new("git").arg("--version").output().is_err() {
        return Ok(error("destination_not_ready", "Git is unavailable"));
    };
    let snap = snapshot_with_exclusions(&source, &exclusions)?;
    let secrets: Vec<_> = snap["manifest"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str))
        .filter(|path| {
            let name = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            name == ".env"
                || name.starts_with(".env.")
                || name.contains("credential")
                || name.contains("secret")
                || name.ends_with(".pem")
                || name.ends_with(".key")
        })
        .collect();
    if !secrets.is_empty() && request.get("secretApproval").and_then(Value::as_bool) != Some(true) {
        return Ok(error(
            "secret_approval_required",
            format!(
                "Explicit approval is required to transfer: {}",
                secrets.join(", ")
            ),
        ));
    }
    // This reaches the selected connector before freeze; never infer destination capability from
    // the source host or a shared data directory.
    let capability = destination_stage(data_dir, dest, json!({"action":"preflight","taskId":task,"sourceDeviceId":source_device,"snapshot":snap,"requiredBytes":tree_size(&source)})).await?;
    if capability.get("ok") != Some(&Value::Bool(true)) {
        return Ok(capability);
    }
    let oid = operation_id.unwrap_or(id(&conn, "transfer")?);
    // The destination path is selected by its connector, never by this source filesystem.
    let destination = PathBuf::from(format!("transfer://{dest}/{oid}"));
    let report = json!({"git":true,"spaceBytes":tree_size(&source),"portability":"git preflight required","exclusions":exclusions,"secrets":"not copied outside the worktree; re-enter destination secrets"});
    conn.execute("INSERT INTO task_operations(operation_id,task_id,kind,phase,source_device_id,destination_device_id,generation,source_path,destination_path,snapshot_json,report_json,created_at,updated_at) VALUES(?1,?2,'transfer','preflight',?3,?4,?5,?6,?7,?8,?9,strftime('%s','now'),strftime('%s','now')) ON CONFLICT(operation_id) DO NOTHING",params![oid,task,source_device,dest,generation,source.to_string_lossy(),destination.to_string_lossy(),snap.to_string(),report.to_string()]).map_err(|e|e.to_string())?;
    Ok(
        json!({"ok":true,"taskId":task,"operationId":oid,"phase":"preflight","generation":generation,"snapshot":snap,"report":report,"projectId":project}),
    )
}
/// Runs the durable transfer state machine. Confirmation is explicit because it fences live agents.
async fn destination_stage(data_dir: &Path, device: &str, body: Value) -> Result<Value, String> {
    let conn = catalog_connection(data_dir)?;
    let (endpoint, credential): (String, String) = conn
        .query_row(
            "SELECT endpoint,credential FROM device_connectors WHERE device_id=?1",
            params![device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "destination_connector_unavailable".to_string())?;
    let response = reqwest::Client::new()
        .post(format!("{}/api/peer/rpc", endpoint.trim_end_matches('/')))
        .bearer_auth(credential)
        .json(&json!({"method":"transfer.stage","targetDeviceId":device,"hop":1,"params":body}))
        .send()
        .await
        .map_err(|e| format!("destination_unreachable: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value.get("error").cloned().unwrap_or(value).to_string());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "invalid_destination_response".into())
}

async fn send_file(
    data_dir: &Path,
    device: &str,
    oid: &str,
    kind: &str,
    path: &str,
    file: &Path,
) -> Result<(), String> {
    use std::io::Read;
    let mut input = fs::File::open(file).map_err(|e| e.to_string())?;
    let mut offset = 0u64;
    let mut chunk = vec![0; CHUNK_BYTES];
    loop {
        let n = input.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        destination_stage(data_dir, device, json!({"action":"chunk","operationId":oid,"kind":kind,"path":path,"offset":offset,"data":BASE64.encode(&chunk[..n])})).await?;
        offset += n as u64;
    }
    Ok(())
}

fn send_tree_files<'a>(
    root: &'a Path,
    path: &'a Path,
    exclusions: &[String],
    files: &mut Vec<(String, PathBuf)>,
    links: &mut Vec<(String, String, u32)>,
) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let p = entry.path();
        let meta = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        let rel = p
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if !safe_relative(Path::new(&rel)) {
            return Err("unsafe_transfer_path".into());
        }
        if excluded(&rel, exclusions) {
            continue;
        }
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&p).map_err(|e| e.to_string())?;
            if !safe_symlink_target(root, &p, &target) {
                return Err("symlink_escape".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                links.push((rel, target.to_string_lossy().into_owned(), meta.mode()));
            }
            #[cfg(not(unix))]
            {
                links.push((rel, target.to_string_lossy().into_owned(), 0));
            }
        } else if meta.is_dir() {
            send_tree_files(root, &p, exclusions, files, links)?;
        } else if meta.is_file() {
            files.push((rel, p));
        }
    }
    Ok(())
}

/// Runs a source-to-destination transfer through authenticated connector APIs.  No destination
/// path is ever interpreted on the source machine; the destination owns its staging directory.
pub async fn transfer_confirm(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let oid = field(request, "operationId")?;
    if request.get("agentsStopped").and_then(Value::as_bool) != Some(true)
        || request.get("serverConfirmed").and_then(Value::as_bool) != Some(true)
    {
        return Ok(error(
            "agents_not_stopped",
            "Stop all task agents and confirm the executor before transfer",
        ));
    }
    let conn = catalog_connection(data_dir)?;
    let Some((task, phase, generation, source, _old_destination, snap)) = op(&conn, oid)? else {
        return Ok(error("operation_not_found", "Transfer does not exist"));
    };
    if phase == TRANSFER_DONE {
        return Ok(json!({"ok":true,"operationId":oid,"phase":TRANSFER_DONE,"replayed":true}));
    }
    if phase == "cancelled" {
        return Ok(error(
            "operation_cancelled",
            "Transfer was cancelled before commit",
        ));
    }
    let (owner, current_gen, project, _) = task_row(&conn, &task)?;
    if current_gen != generation {
        return Ok(error("stale_generation", "Task generation changed"));
    }
    let source = PathBuf::from(source);
    if !source.is_dir() {
        return Ok(error("source_unavailable", "Frozen source is unavailable"));
    }
    let destination_device: String = conn
        .query_row(
            "SELECT destination_device_id FROM task_operations WHERE operation_id=?1",
            params![oid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if phase == "preflight" {
        conn.execute("UPDATE task_operations SET phase='source frozen',updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    }
    let snapshot: Value = serde_json::from_str(&snap).map_err(|_| "invalid_snapshot")?;
    let report: Value = conn
        .query_row(
            "SELECT report_json FROM task_operations WHERE operation_id=?1",
            [oid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|v: String| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let exclusions: Vec<String> = report
        .get("exclusions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    // The freeze is durable. Recompute only after it is recorded; a changed tree is never
    // silently transferred from a preflight snapshot.
    let frozen_snapshot = snapshot_with_exclusions(&source, &exclusions)?;
    if frozen_snapshot.get("worktreeSnapshot") != snapshot.get("worktreeSnapshot")
        || frozen_snapshot.get("indexSnapshot") != snapshot.get("indexSnapshot")
        || frozen_snapshot.get("refs") != snapshot.get("refs")
    {
        return Ok(error(
            "preflight_drift",
            "Source changed between preflight and freeze",
        ));
    }
    let head = snapshot
        .get("head")
        .and_then(Value::as_str)
        .ok_or("invalid_snapshot")?;
    destination_stage(data_dir, &destination_device, json!({"action":"init","operationId":oid,"taskId":task,"projectId":project,"sourceDeviceId":owner,"destinationDeviceId":destination_device,"generation":generation,"head":head,"snapshot":snapshot,"exclusions":exclusions})).await?;
    let bundle = data_dir.join("transfers").join(format!("{oid}.bundle"));
    if !bundle.exists() {
        fs::create_dir_all(bundle.parent().unwrap()).map_err(|e| e.to_string())?;
        let out = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args([
                "bundle",
                "create",
                bundle.to_string_lossy().as_ref(),
                "--all",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Ok(error(
                "bundle_create_failed",
                String::from_utf8_lossy(&out.stderr),
            ));
        }
    }
    send_file(
        data_dir,
        &destination_device,
        oid,
        "bundle",
        "bundle",
        &bundle,
    )
    .await?;
    destination_stage(
        data_dir,
        &destination_device,
        json!({"action":"unpack","operationId":oid}),
    )
    .await?;
    let gitdir = git(&source, &["rev-parse", "--git-dir"])?;
    let gitdir = PathBuf::from(gitdir.trim());
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        source.join(gitdir)
    };
    if gitdir.join("index").exists() {
        send_file(
            data_dir,
            &destination_device,
            oid,
            "index",
            "index",
            &gitdir.join("index"),
        )
        .await?;
    }
    let mut files = Vec::new();
    let mut links = Vec::new();
    send_tree_files(&source, &source, &exclusions, &mut files, &mut links)?;
    for (rel, file) in files {
        send_file(data_dir, &destination_device, oid, "file", &rel, &file).await?;
    }
    for (path, target, mode) in links {
        destination_stage(
            data_dir,
            &destination_device,
            json!({"action":"symlink","operationId":oid,"path":path,"target":target,"mode":mode}),
        )
        .await?;
    }
    let verified = destination_stage(
        data_dir,
        &destination_device,
        json!({"action":"verify","operationId":oid}),
    )
    .await?;
    if verified.get("ok") != Some(&Value::Bool(true)) {
        return Ok(error(
            "verification_failed",
            "Destination rejected transfer manifest",
        ));
    }
    conn.execute("UPDATE task_operations SET phase='destination staged',updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    conn.execute("UPDATE task_operations SET phase='verified',updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    catalog_write(
        data_dir,
        request,
        "ownership",
        revision(&conn, "tasks", &task)?,
        json!({"taskId":task,"deviceId":destination_device,"generation":generation}),
    )
    .await?;
    conn.execute("UPDATE task_operations SET phase='ownership committed',updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    conn.execute("UPDATE task_operations SET phase='source retired',updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    conn.execute("UPDATE task_operations SET phase='complete',completed_at=strftime('%s','now'),updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    Ok(
        json!({"ok":true,"operationId":oid,"phase":"complete","generation":generation+1,"sourceRetired":true,"freezePersists":true}),
    )
}

fn portable_name(name: &str) -> bool {
    if name.is_empty() || name.contains('\0') || name.contains('/') || name.contains('\\') {
        return false;
    }
    if cfg!(target_os = "windows") {
        if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
            return false;
        }
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        ) {
            return false;
        }
    }
    !(cfg!(target_os = "macos") && name.contains(':'))
}
fn portable_manifest(entries: &[Value]) -> bool {
    let mut folded = std::collections::HashSet::new();
    entries.iter().all(|entry| {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            return false;
        };
        safe_relative(Path::new(path))
            && path.split('/').all(portable_name)
            && folded.insert(path.to_lowercase())
            && (entry.get("kind").and_then(Value::as_str) != Some("symlink")
                || entry
                    .get("target")
                    .and_then(Value::as_str)
                    .is_some_and(|target| safe_symlink_relative(path, target)))
    })
}

/// Destination-side connector protocol. Every payload is authenticated by the connector and
/// constrained to an operation-specific staging root; callers cannot select destination paths.
pub async fn transfer_stage(data_dir: &Path, request: &Value) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let action = field(request, "action")?;
    let oid = field(request, "operationId")?;
    let root = data_dir.join("task-transfer-staging").join(oid);
    match action {
        "preflight" => {
            let task = field(request, "taskId")?;
            let source = field(request, "sourceDeviceId")?;
            let conn = catalog_connection(data_dir)?;
            let owner: String = conn
                .query_row(
                    "SELECT assigned_device_id FROM tasks WHERE id=?1",
                    params![task],
                    |r| r.get(0),
                )
                .map_err(|_| "task_not_found")?;
            if owner != source
                || Command::new("git")
                    .arg("--version")
                    .output()
                    .map(|o| !o.status.success())
                    .unwrap_or(true)
            {
                return Ok(error(
                    "destination_not_ready",
                    "Destination cannot stage this task",
                ));
            }
            // Path validation is intentionally performed before source freeze; unsupported names
            // and symlink escapes are rejected by the same validator used for chunks.
            let entries = request
                .pointer("/snapshot/manifest")
                .and_then(Value::as_array)
                .ok_or("invalid_snapshot")?;
            if !portable_manifest(entries) {
                return Ok(error(
                    "destination_not_ready",
                    "Destination path portability check failed",
                ));
            }
            let required = request
                .get("requiredBytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let free = fs2::available_space(data_dir).map_err(|e| e.to_string())?;
            if free < required {
                return Ok(error(
                    "destination_not_ready",
                    format!("Destination has {free} free bytes; {required} required"),
                ));
            }
            Ok(
                json!({"ok":true,"git":true,"tools":true,"diskCheckedBytes":free,"requiredBytes":required,"portability":"ok"}),
            )
        }
        "init" => {
            let task = field(request, "taskId")?;
            let source = field(request, "sourceDeviceId")?;
            let conn = catalog_connection(data_dir)?;
            let owner: String = conn
                .query_row(
                    "SELECT assigned_device_id FROM tasks WHERE id=?1",
                    params![task],
                    |r| r.get(0),
                )
                .map_err(|_| "task_not_found")?;
            if owner != source {
                return Ok(error(
                    "transfer_source_not_owner",
                    "Source is not the current owner",
                ));
            }
            if root.exists() {
                return Ok(json!({"ok":true,"resumed":true}));
            }
            fs::create_dir_all(root.join("files")).map_err(|e| e.to_string())?;
            fs::write(
                root.join("request.json"),
                serde_json::to_vec(request).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"ok":true,"phase":"preflight"}))
        }
        "chunk" => {
            let kind = field(request, "kind")?;
            let rel = field(request, "path")?;
            if !safe_relative(Path::new(rel)) || !rel.split('/').all(portable_name) {
                return Ok(error(
                    "unsafe_transfer_path",
                    "Absolute, traversal, or non-portable paths are rejected",
                ));
            }
            let target = match kind {
                "bundle" => root.join("bundle"),
                "index" => root.join("index"),
                "file" => root.join("files").join(rel),
                _ => return Ok(error("invalid_transfer_chunk", "Unknown chunk kind")),
            };
            let bytes = BASE64
                .decode(field(request, "data")?)
                .map_err(|_| "invalid_transfer_chunk")?;
            let offset = request
                .get("offset")
                .and_then(Value::as_u64)
                .ok_or("offset is required")?;
            fs::create_dir_all(target.parent().ok_or("invalid_transfer_path")?)
                .map_err(|e| e.to_string())?;
            let existing = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            if offset > existing {
                return Ok(error("resume_offset_invalid", "Chunk has a gap"));
            }
            if offset < existing {
                let mut f = fs::File::open(&target).map_err(|e| e.to_string())?;
                f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
                let mut old = vec![0; bytes.len().min((existing - offset) as usize)];
                f.read_exact(&mut old).map_err(|e| e.to_string())?;
                if old != bytes[..old.len()] {
                    return Ok(error("chunk_conflict", "Existing chunk differs"));
                }
            }
            if offset + bytes.len() as u64 > existing {
                let mut f = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&target)
                    .map_err(|e| e.to_string())?;
                let skip = existing.saturating_sub(offset) as usize;
                f.write_all(&bytes[skip..]).map_err(|e| e.to_string())?;
                f.sync_all().map_err(|e| e.to_string())?;
            }
            Ok(json!({"ok":true,"offset":offset+bytes.len() as u64}))
        }
        "unpack" => {
            let saved: Value = serde_json::from_slice(
                &fs::read(root.join("request.json")).map_err(|_| "transfer_not_initialized")?,
            )
            .map_err(|_| "invalid_transfer")?;
            let project = field(&saved, "projectId")?;
            let task = field(&saved, "taskId")?;
            let head = field(&saved, "head")?;
            let replica = data_dir
                .join("project-repos")
                .join(format!("{project}.git"));
            if !replica.exists() {
                let out = Command::new("git")
                    .args(["init", "--bare", replica.to_string_lossy().as_ref()])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Ok(error(
                        "destination_stage_failed",
                        String::from_utf8_lossy(&out.stderr),
                    ));
                }
            }
            let out = Command::new("git")
                .arg("-C")
                .arg(&replica)
                .args([
                    "fetch",
                    root.join("bundle").to_string_lossy().as_ref(),
                    "+refs/*:refs/*",
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Ok(error(
                    "bundle_fetch_failed",
                    String::from_utf8_lossy(&out.stderr),
                ));
            }
            let destination = data_dir
                .join("task-worktrees")
                .join(format!("{task}-{}", field(&saved, "destinationDeviceId")?));
            if destination.exists() {
                // A crash after `worktree add` but before the receipt is written resumes the
                // operation-specific managed directory; never create a second worktree.
                if root.join("destination").exists() {
                    return Ok(json!({"ok":true,"phase":"destination staged","resumed":true}));
                }
                return Ok(error(
                    "destination_overwrite",
                    "Managed destination already exists",
                ));
            }
            let out = Command::new("git")
                .arg("-C")
                .arg(&replica)
                .args([
                    "worktree",
                    "add",
                    "--detach",
                    destination.to_string_lossy().as_ref(),
                    head,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Ok(error(
                    "destination_stage_failed",
                    String::from_utf8_lossy(&out.stderr),
                ));
            }
            clear_worktree(&destination)?;
            fs::write(
                root.join("destination"),
                destination.to_string_lossy().as_bytes(),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"ok":true,"phase":"destination staged"}))
        }
        "symlink" => {
            let dest = PathBuf::from(
                String::from_utf8(
                    fs::read(root.join("destination")).map_err(|_| "transfer_not_unpacked")?,
                )
                .map_err(|_| "invalid_destination")?,
            );
            let rel = field(request, "path")?;
            let target = field(request, "target")?;
            if !safe_relative(Path::new(rel))
                || !safe_symlink_target(&dest, &dest.join(rel), Path::new(target))
            {
                return Ok(error("symlink_escape", "Unsafe symlink"));
            }
            let out = dest.join(rel);
            if out.exists() {
                return Ok(error("destination_overwrite", "Destination file exists"));
            }
            fs::create_dir_all(out.parent().ok_or("unsafe_transfer_path")?)
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, out).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            return Ok(error(
                "symlink_unsupported_on_destination",
                "Destination does not support symlinks",
            ));
            Ok(json!({"ok":true}))
        }
        "receipt" => {
            let task = field(request, "taskId")?;
            let project = field(request, "projectId")?;
            let commit = field(request, "retainedCommit")?;
            let conn = catalog_connection(data_dir)?;
            let source: String = conn
                .query_row(
                    "SELECT repository_source FROM projects WHERE id=?1",
                    [project],
                    |r| r.get::<_, Option<String>>(0),
                )
                .map_err(|_| "project_not_found")?
                .unwrap_or_default();
            let configured: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM git_replicas WHERE network_id=(SELECT network_id FROM projects WHERE id=?1) AND device_id=?2 AND repository_source=?3)", params![project, field(request, "deviceId")?, source], |r| r.get(0)).unwrap_or(false);
            // The RPC router supplies targetDeviceId; direct callers may use this local replica only when configured.
            if !configured {
                return Ok(error(
                    "replica_not_configured",
                    "Device is not a configured Git replica",
                ));
            }
            let replica = data_dir
                .join("project-repos")
                .join(format!("{project}.git"));
            if git(
                &replica,
                &["cat-file", "-e", &format!("{commit}^{{commit}}")],
            )
            .is_err()
                || git(
                    &replica,
                    &["for-each-ref", "--contains", commit, "--format=%(refname)"],
                )
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                return Ok(error(
                    "retained_commit_unverified",
                    "Replica does not retain the commit through a ref",
                ));
            }
            conn.execute("INSERT INTO task_replica_receipts(task_id,device_id,retained_commit,verified_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(task_id,device_id,retained_commit) DO UPDATE SET verified_at=excluded.verified_at", params![task, field(request, "deviceId")?, commit]).map_err(|e|e.to_string())?;
            Ok(json!({"ok":true,"retainedCommit":commit}))
        }
        "status" => {
            let saved: Value = serde_json::from_slice(
                &fs::read(root.join("request.json")).map_err(|_| "transfer_not_initialized")?,
            )
            .map_err(|_| "invalid_transfer")?;
            let dest = PathBuf::from(
                String::from_utf8(
                    fs::read(root.join("destination")).map_err(|_| "transfer_not_unpacked")?,
                )
                .map_err(|_| "invalid_destination")?,
            );
            let exclusions: Vec<String> = saved
                .get("exclusions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let actual = snapshot_with_exclusions(&dest, &exclusions)?;
            let verified = actual.get("worktreeSnapshot")
                == saved.pointer("/snapshot/worktreeSnapshot")
                && actual.get("indexSnapshot") == saved.pointer("/snapshot/indexSnapshot");
            Ok(json!({"ok":verified,"phase":if verified {"verified"} else {"incomplete"}}))
        }
        "cancel" => {
            if let Ok(bytes) = fs::read(root.join("destination")) {
                if let Ok(path) = String::from_utf8(bytes) {
                    let path = PathBuf::from(path);
                    if managed(data_dir, &path) {
                        let _ = git(
                            &path,
                            &[
                                "worktree",
                                "remove",
                                "--force",
                                path.to_string_lossy().as_ref(),
                            ],
                        );
                        let _ = fs::remove_dir_all(path);
                    }
                }
            }
            let _ = fs::remove_dir_all(&root);
            Ok(json!({"ok":true,"phase":"cancelled"}))
        }
        "verify" => {
            let dest = PathBuf::from(
                String::from_utf8(
                    fs::read(root.join("destination")).map_err(|_| "transfer_not_unpacked")?,
                )
                .map_err(|_| "invalid_destination")?,
            );
            let saved: Value = serde_json::from_slice(
                &fs::read(root.join("request.json")).map_err(|_| "transfer_not_initialized")?,
            )
            .map_err(|_| "invalid_transfer")?;
            let gitdir = git(&dest, &["rev-parse", "--git-dir"])?;
            let gitdir = PathBuf::from(gitdir.trim());
            let gitdir = if gitdir.is_absolute() {
                gitdir
            } else {
                dest.join(gitdir)
            };
            if root.join("index").exists() {
                fs::copy(root.join("index"), gitdir.join("index")).map_err(|e| e.to_string())?;
            }
            // Recreate empty directories and supported Unix modes from the signed manifest; file
            // bytes are streamed separately so staged/unstaged state remains in the copied index.
            if let Some(entries) = saved
                .pointer("/snapshot/manifest")
                .and_then(Value::as_array)
            {
                for entry in entries {
                    let Some(rel) = entry.get("path").and_then(Value::as_str) else {
                        return Ok(error("verification_failed", "Malformed manifest"));
                    };
                    if !safe_relative(Path::new(rel)) {
                        return Ok(error("unsafe_transfer_path", "Unsafe manifest path"));
                    }
                    let out = dest.join(rel);
                    if entry.get("kind").and_then(Value::as_str) == Some("dir") {
                        fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                    }
                    #[cfg(unix)]
                    if let Some(mode) = entry.get("mode").and_then(Value::as_u64) {
                        use std::os::unix::fs::PermissionsExt;
                        if fs::symlink_metadata(&out)
                            .map(|m| !m.file_type().is_symlink())
                            .unwrap_or(false)
                        {
                            fs::set_permissions(&out, fs::Permissions::from_mode(mode as u32))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
            copy_tree(&root.join("files"), &dest)?;
            #[cfg(unix)]
            if let Some(entries) = saved
                .pointer("/snapshot/manifest")
                .and_then(Value::as_array)
            {
                use std::os::unix::fs::PermissionsExt;
                for entry in entries {
                    if let (Some(rel), Some(mode)) = (
                        entry.get("path").and_then(Value::as_str),
                        entry.get("mode").and_then(Value::as_u64),
                    ) {
                        let out = dest.join(rel);
                        if fs::symlink_metadata(&out)
                            .map(|m| !m.file_type().is_symlink())
                            .unwrap_or(false)
                        {
                            fs::set_permissions(out, fs::Permissions::from_mode(mode as u32))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
            let expected = saved.pointer("/snapshot/worktreeSnapshot");
            let exclusions: Vec<String> = saved
                .get("exclusions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let actual = snapshot_with_exclusions(&dest, &exclusions)?;
            if actual.get("worktreeSnapshot") != expected
                || actual.get("indexSnapshot") != saved.pointer("/snapshot/indexSnapshot")
            {
                return Ok(error(
                    "verification_failed",
                    "Manifest or index checksum differs",
                ));
            }
            let task = field(&saved, "taskId")?;
            let project = field(&saved, "projectId")?;
            let device = field(&saved, "destinationDeviceId")?;
            let commit = saved
                .pointer("/snapshot/head")
                .and_then(Value::as_str)
                .ok_or("invalid_snapshot")?;
            let conn = catalog_connection(data_dir)?;
            conn.execute("INSERT INTO device_task_paths(task_id,device_id,path,revision) SELECT ?1,?2,?3,1 WHERE NOT EXISTS(SELECT 1 FROM device_task_paths WHERE task_id=?1 AND device_id=?2)",params![task,device,dest.to_string_lossy()]).ok();
            let source: String = conn
                .query_row(
                    "SELECT repository_source FROM projects WHERE id=?1",
                    [project],
                    |r| r.get::<_, Option<String>>(0),
                )
                .unwrap_or_default()
                .unwrap_or_default();
            let configured: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM git_replicas WHERE network_id=(SELECT network_id FROM projects WHERE id=?1) AND device_id=?2 AND repository_source=?3)", params![project, device, source], |r|r.get(0)).unwrap_or(false);
            let replica = data_dir
                .join("project-repos")
                .join(format!("{project}.git"));
            if configured
                && git(
                    &replica,
                    &["cat-file", "-e", &format!("{commit}^{{commit}}")],
                )
                .is_ok()
                && git(
                    &replica,
                    &["for-each-ref", "--contains", commit, "--format=%(refname)"],
                )
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
            {
                conn.execute("INSERT INTO task_replica_receipts(task_id,device_id,retained_commit,verified_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(task_id,device_id,retained_commit) DO UPDATE SET verified_at=excluded.verified_at", params![task,device,commit]).map_err(|e|e.to_string())?;
            }
            Ok(json!({"ok":true,"phase":"verified"}))
        }
        _ => Ok(error("invalid_transfer_stage", "Unknown stage action")),
    }
}

pub async fn transfer_cancel(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let oid = field(request, "operationId")?;
    let (dest, device) = {
        let conn = catalog_connection(data_dir)?;
        let Some((_, phase, _, _, dest, _)) = op(&conn, oid)? else {
            return Ok(error("operation_not_found", "Transfer does not exist"));
        };
        if matches!(
            phase.as_str(),
            "ownership committed" | "source retired" | "complete"
        ) {
            return Ok(error(
                "cannot_cancel_committed",
                "Committed transfer must recover forward",
            ));
        }
        let device = conn
            .query_row(
                "SELECT destination_device_id FROM task_operations WHERE operation_id=?1",
                params![oid],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        (dest, device)
    };
    if let Some(device) = device {
        // Best effort only: cancellation remains durable even while a disconnected destination
        // later resumes and observes the cancelled source operation.
        let _ = destination_stage(
            data_dir,
            &device,
            json!({"action":"cancel","operationId":oid}),
        )
        .await;
    }
    let conn = catalog_connection(data_dir)?;
    // Source records a remote URI; never recursively delete a path supplied by another device.
    if Path::new(&dest).starts_with(data_dir.join("task-worktrees")) {
        let _ = fs::remove_dir_all(dest);
    }
    conn.execute("UPDATE task_operations SET phase='cancelled',cancel_requested=1,updated_at=strftime('%s','now') WHERE operation_id=?1",params![oid]).map_err(|e|e.to_string())?;
    Ok(json!({"ok":true,"phase":"cancelled"}))
}
fn managed(data_dir: &Path, path: &Path) -> bool {
    path.parent() == Some(&data_dir.join("task-worktrees")) && path.file_name().is_some()
}
fn tree_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| {
            let p = entry.path();
            fs::symlink_metadata(&p)
                .map(|m| if m.is_dir() { tree_size(&p) } else { m.len() })
                .unwrap_or(0)
        })
        .sum()
}
/// lsof reports processes that really hold a managed root; an unavailable inspector is unsafe,
/// not evidence that no process exists.
fn live_processes(path: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("lsof")
        .args(["-Fn", "--", path.to_string_lossy().as_ref()])
        .output()
        .map_err(|_| "process_inspection_unavailable".to_string())?;
    if !out.status.success() && !out.stdout.is_empty() {
        return Err("process_inspection_failed".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p').map(str::to_string))
        .collect())
}
fn remote_evidence(path: &Path) -> (bool, String) {
    // A successful `fetch` without a remote or upstream is not evidence of retention.
    if git(path, &["remote", "get-url", "origin"]).is_err()
        || git(
            path,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .is_err()
        || git(path, &["fetch", "--prune"]).is_err()
    {
        return (false, String::new());
    }
    match git(path, &["log", "--format=%H%x00%s", "@{upstream}..HEAD"]) {
        Ok(unpushed) => (true, unpushed),
        Err(_) => (false, String::new()),
    }
}
fn known_losses(path: &Path) -> Result<Vec<Value>, String> {
    let status = git(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
        ],
    )?;
    let mut losses = Vec::new();
    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let path = line[3..].to_string();
        let kind = match code {
            "??" => "untracked",
            "!!" => "ignored",
            _ => "tracked",
        };
        losses.push(json!({"kind":kind,"path":path,"status":code}));
    }
    let unpushed =
        git(path, &["log", "--format=%H%x00%s", "@{upstream}..HEAD"]).unwrap_or_default();
    for line in unpushed.lines() {
        let (commit, subject) = line.split_once('\0').unwrap_or((line, ""));
        losses.push(json!({"kind":"unpushed","commit":commit,"subject":subject}));
    }
    Ok(losses)
}
async fn replica_receipts(
    data_dir: &Path,
    task: &str,
    project: &str,
    commit: &str,
    operation_id: &str,
) -> Result<(i64, i64), String> {
    let conn = catalog_connection(data_dir)?;
    let source: String = conn
        .query_row(
            "SELECT repository_source FROM projects WHERE id=?1",
            [project],
            |r| r.get::<_, Option<String>>(0),
        )
        .map_err(|_| "project_not_found")?
        .unwrap_or_default();
    let replicas: Vec<String> = conn.prepare("SELECT device_id FROM git_replicas WHERE network_id=(SELECT network_id FROM projects WHERE id=?1) AND repository_source=?2 ORDER BY device_id").map_err(|e|e.to_string())?
        .query_map(params![project, source], |r| r.get(0)).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    let required = if replicas.is_empty() {
        0
    } else {
        replicas.len() as i64 / 2 + 1
    };
    let mut received = 0;
    for device in replicas {
        if let Ok(reply) = destination_stage(data_dir, &device, json!({"action":"receipt","operationId":operation_id,"taskId":task,"projectId":project,"retainedCommit":commit,"deviceId":device})).await {
            if reply.get("ok") == Some(&Value::Bool(true)) { received += 1; }
        }
    }
    Ok((required, received))
}
/// Produces a generation/ref/worktree-bound cleanup preview; confirmation must use this exact hash.
pub async fn cleanup_preview(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let conn = catalog_connection(data_dir)?;
    let (_, gen, project, path) = task_row(&conn, task)?;
    let path = PathBuf::from(path);
    if !managed(data_dir, &path) {
        return Ok(error(
            "managed_path_required",
            "Only a managed task worktree can be cleaned",
        ));
    };
    let (remote_fresh, unpushed) = remote_evidence(&path);
    let snap = snapshot(&path)?;
    let ignored = git(
        &path,
        &[
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
        ],
    )?;
    let unmerged = git(
        &path,
        &["log", "--format=%H%x00%s", "--all", "--not", "HEAD"],
    )
    .unwrap_or_default();
    let processes = live_processes(&path).unwrap_or_else(|reason| vec![reason]);
    let losses = known_losses(&path)?;
    let commit = snap["head"].as_str().unwrap_or("");
    let (required, received) = replica_receipts(
        data_dir,
        task,
        &project,
        commit,
        &format!("cleanup-receipt-{task}"),
    )
    .await?;
    let preview = json!({"generation":gen,"refs":snap["refs"],"worktreeSnapshot":snap["worktreeSnapshot"],"tracked":snap["status"],"untrackedAndIgnored":ignored,"unpushed":unpushed,"unmerged":unmerged,"remoteFresh":remote_fresh,"replicaReceipts":{"required":required,"received":received},"knownLosses":losses,"sizeBytes":tree_size(&path),"processes":processes,"retainedCommit":snap["head"]});
    let token = hash(&preview.to_string());
    conn.execute("INSERT INTO task_operations(operation_id,task_id,kind,phase,generation,source_path,snapshot_json,report_json,created_at,updated_at) VALUES(?1,?2,'cleanup','preview',?3,?4,?5,?6,strftime('%s','now'),strftime('%s','now'))",params![format!("cleanup-{token}"),task,gen,path.to_string_lossy(),snap.to_string(),json!({"preview":preview,"token":token}).to_string()]).map_err(|e|e.to_string())?;
    Ok(json!({"ok":true,"preview":preview,"previewToken":token}))
}
pub async fn cleanup_confirm(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let token = field(request, "previewToken")?;
    if request.get("agentsStopped").and_then(Value::as_bool) != Some(true)
        || request.get("serverConfirmed").and_then(Value::as_bool) != Some(true)
    {
        return Ok(error(
            "agents_not_stopped",
            "Stop all agents and explicitly confirm cleanup",
        ));
    };
    let conn = catalog_connection(data_dir)?;
    let (_, gen, project, path) = task_row(&conn, task)?;
    let path = PathBuf::from(path);
    let row: Option<String> = conn
        .query_row(
            "SELECT report_json FROM task_operations WHERE operation_id=?1 AND kind='cleanup'",
            params![format!("cleanup-{token}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(report) = row else {
        return Ok(error(
            "cleanup_preview_stale",
            "Preview is missing or stale",
        ));
    };
    let old: Value = serde_json::from_str(&report).map_err(|e| e.to_string())?;
    let (fresh_now, unpushed_now) = remote_evidence(&path);
    let now = snapshot(&path)?;
    if old.pointer("/preview/generation").and_then(Value::as_i64) != Some(gen)
        || old.pointer("/preview/worktreeSnapshot") != now.get("worktreeSnapshot")
        || old.pointer("/preview/refs") != now.get("refs")
    {
        return Ok(error(
            "cleanup_preview_stale",
            "Worktree, refs, or generation changed",
        ));
    };
    if !managed(data_dir, &path) {
        return Ok(error(
            "managed_path_required",
            "Only managed paths may be removed",
        ));
    };
    let preview = old.pointer("/preview").cloned().unwrap_or_default();
    let losses = known_losses(&path)?;
    let retained_now = now["head"].as_str().unwrap_or("");
    let (required_receipts, received_receipts) = replica_receipts(
        data_dir,
        task,
        &project,
        retained_now,
        &format!("cleanup-receipt-{task}"),
    )
    .await?;
    let discard = request.get("discardApproval").and_then(Value::as_bool) == Some(true);
    let unmerged_now = git(
        &path,
        &["log", "--format=%H%x00%s", "--all", "--not", "HEAD"],
    )
    .unwrap_or_default();
    if !live_processes(&path)
        .unwrap_or_else(|reason| vec![reason])
        .is_empty()
        || !fresh_now
        || (!discard && !losses.is_empty())
        || (!discard && !unpushed_now.is_empty())
        || !unmerged_now.is_empty()
        || !preview["processes"]
            .as_array()
            .is_some_and(|v| v.is_empty())
        || preview["remoteFresh"] != Value::Bool(true)
        || (!discard && !preview["unpushed"].as_str().unwrap_or_default().is_empty())
        || !preview["unmerged"].as_str().unwrap_or_default().is_empty()
        || received_receipts < required_receipts
    {
        return Ok(error("cleanup_safety_checks_failed", "Live processes, fresh remote evidence, merged refs, and majority replica receipts are required"));
    }
    conn.execute("UPDATE task_operations SET phase='cleanup frozen',updated_at=strftime('%s','now') WHERE operation_id=?1", params![format!("cleanup-{token}")]).map_err(|e| e.to_string())?;
    let retained = now["head"].as_str().unwrap_or("");
    // Create the restore receipt while data still exists. A removal failure retains both data
    // and a recovery receipt instead of committing an irreversible state.
    conn.execute("INSERT INTO task_cleanup_receipts(task_id,retained_commit,known_losses_json,result_json,cleaned_at) VALUES(?1,?2,?3,?4,strftime('%s','now')) ON CONFLICT(task_id) DO UPDATE SET retained_commit=excluded.retained_commit,known_losses_json=excluded.known_losses_json,result_json=excluded.result_json,cleaned_at=excluded.cleaned_at",params![task,retained,serde_json::to_string(&losses).map_err(|e|e.to_string())?,old.to_string()]).map_err(|e|e.to_string())?;
    git(
        &path,
        &[
            "worktree",
            "remove",
            "--force",
            path.to_string_lossy().as_ref(),
        ],
    )
    .map_err(|reason| format!("cleanup_remove_failed: {reason}"))?;
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    if let Err(reason) = catalog_write(data_dir, request, "cleanup", revision(&conn, "tasks", task)?, json!({"action":"complete","taskId":task,"retainedCommit":retained,"knownLosses":losses,"result":old})).await {
        let replica = data_dir.join("project-repos").join(format!("{project}.git"));
        let _ = Command::new("git").arg("-C").arg(replica).args(["worktree", "add", "--detach", path.to_string_lossy().as_ref(), retained]).output();
        return Err(reason);
    }
    Ok(json!({"ok":true,"retainedCommit":retained,"knownLosses":losses}))
}
pub async fn restore_task(data_dir: &Path, request: &Value) -> Result<Value, String> {
    let task = field(request, "taskId")?;
    let conn = catalog_connection(data_dir)?;
    let (_, _, project, path) = task_row(&conn, task)?;
    let commit: Option<String> = conn
        .query_row(
            "SELECT COALESCE(retained_commit,'') FROM task_cleanup_receipts WHERE task_id=?1",
            params![task],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(commit) = commit.filter(|v| !v.is_empty()) else {
        return Ok(error(
            "restore_unavailable",
            "No retained commit exists; restore from a Git replica or remote",
        ));
    };
    let replica = data_dir
        .join("project-repos")
        .join(format!("{project}.git"));
    let worktree = PathBuf::from(path);
    if !replica.exists() {
        return Ok(error(
            "restore_unavailable",
            "Retained Git objects are unavailable; reconnect a replica",
        ));
    };
    let out = Command::new("git")
        .arg("-C")
        .arg(&replica)
        .args([
            "worktree",
            "add",
            "--detach",
            worktree.to_string_lossy().as_ref(),
            &commit,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(error(
            "restore_unavailable",
            String::from_utf8_lossy(&out.stderr),
        ));
    };
    if let Err(reason) = catalog_write(
        data_dir,
        request,
        "task",
        revision(&conn, "tasks", task)?,
        json!({"action":"lifecycle","taskId":task,"lifecycle":"active"}),
    )
    .await
    {
        let _ = git(
            &worktree,
            &[
                "worktree",
                "remove",
                "--force",
                worktree.to_string_lossy().as_ref(),
            ],
        );
        if worktree.exists() {
            let _ = fs::remove_dir_all(&worktree);
        }
        return Err(reason);
    }
    let losses: Value = conn
        .query_row(
            "SELECT known_losses_json FROM task_cleanup_receipts WHERE task_id=?1",
            [task],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!([]));
    Ok(json!({"ok":true,"retainedCommit":commit,"knownLosses":losses}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_receipts_are_standard_and_not_process_randomized() {
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn relative_symlinks_may_climb_inside_but_not_escape() {
        assert!(safe_symlink_relative("nested/link", "../target"));
        assert!(safe_symlink_relative("nested/link", "../other/../target"));
        assert!(!safe_symlink_relative("link", "../outside"));
        assert!(!safe_symlink_relative("nested/link", "../../outside"));
    }

    #[test]
    fn losses_include_tracked_untracked_and_ignored() {
        let root = std::env::temp_dir().join(format!("swath-losses-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]).unwrap();
        git(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(&root, &["config", "user.name", "Test"]).unwrap();
        fs::write(root.join("tracked"), "base").unwrap();
        git(&root, &["add", "tracked"]).unwrap();
        git(&root, &["commit", "-m", "base"]).unwrap();
        fs::write(root.join("tracked"), "changed").unwrap();
        fs::write(root.join("untracked"), "u").unwrap();
        fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        fs::write(root.join("ignored"), "i").unwrap();
        let losses = known_losses(&root).unwrap();
        assert!(losses
            .iter()
            .any(|v| v["kind"] == "tracked" && v["path"] == "tracked"));
        assert!(losses
            .iter()
            .any(|v| v["kind"] == "untracked" && v["path"] == "untracked"));
        assert!(losses
            .iter()
            .any(|v| v["kind"] == "ignored" && v["path"] == "ignored"));
        let _ = fs::remove_dir_all(root);
    }
}
