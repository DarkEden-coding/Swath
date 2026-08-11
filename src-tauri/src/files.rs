//! Sandboxed file-tree browsing and mutation for the file browser tab.
//!
//! Every path is a `/`-separated location relative to the pane's `cwd`; the
//! resolvers below reject traversal escapes and symlinks so the tree can never
//! read or mutate anything outside the workspace.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const TEXT_MAX_BYTES: u64 = 2 * 1024 * 1024;

type FilesResult = Result<Value, String>;

/// Dispatches a JSON files RPC request.
pub fn rpc(request: Value) -> FilesResult {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match op {
        "list" => list_dir(&request),
        "readText" => read_text(&request),
        "rename" => rename_entry(&request),
        "trash" => trash_entry(&request),
        "" => Err("Invalid files request: missing op".into()),
        other => Err(format!("Unknown files operation: {other}")),
    }
}

fn field<'a>(request: &'a Value, key: &str) -> &'a str {
    request
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
}

/// Returns the canonical workspace root, which every resolved path must live under.
fn canonical_root(cwd: &str) -> Result<PathBuf, String> {
    if cwd.is_empty() {
        return Err("Working directory is required".into());
    }
    let path = Path::new(cwd);
    if !path.is_dir() {
        return Err("Working directory is not a directory".into());
    }
    path.canonicalize()
        .map_err(|err| format!("Unable to resolve working directory: {err}"))
}

/// Rejects relative paths that could escape the root before any filesystem access.
fn checked_components(relative: &str) -> Result<Vec<&str>, String> {
    let mut parts = Vec::new();
    for part in relative.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err("Path escapes the working directory".into()),
            other => parts.push(other),
        }
    }
    Ok(parts)
}

/// Resolves an existing entry under `root`, rejecting symlinks and escapes.
fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = checked_components(relative)?
        .iter()
        .fold(root.to_path_buf(), |acc, part| acc.join(part));
    let meta = fs::symlink_metadata(&joined).map_err(|err| format!("Unable to read path: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("Symlinked entries are not supported".into());
    }
    let canonical = joined
        .canonicalize()
        .map_err(|err| format!("Unable to resolve path: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("Path escapes the working directory".into());
    }
    Ok(canonical)
}

/// Resolves a destination that does not exist yet by canonicalizing its parent.
fn resolve_destination(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let parts = checked_components(relative)?;
    let (leaf, parents) = parts
        .split_last()
        .ok_or_else(|| "Destination path is required".to_string())?;
    let parent_relative = parents.join("/");
    let parent = if parent_relative.is_empty() {
        root.to_path_buf()
    } else {
        resolve_existing(root, &parent_relative)?
    };
    if !parent.is_dir() {
        return Err("Destination parent is not a directory".into());
    }
    Ok(parent.join(leaf))
}

/// Lists one directory level, directories first then files, both alphabetical.
fn list_dir(request: &Value) -> FilesResult {
    let root = canonical_root(field(request, "cwd"))?;
    let relative = field(request, "path");
    let dir = if relative.is_empty() {
        root.clone()
    } else {
        resolve_existing(&root, relative)?
    };
    if !dir.is_dir() {
        return Err("Path is not a directory".into());
    }

    let mut entries: Vec<Value> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| format!("Unable to read directory: {err}"))? {
        let entry = entry.map_err(|err| format!("Unable to read directory entry: {err}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        // Symlinks are unsupported everywhere else here, so do not advertise them.
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(link_meta) = entry.file_type() else {
            continue;
        };
        if link_meta.is_symlink() {
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        entries.push(json!({
            "name": name,
            "path": path,
            "isDir": meta.is_dir(),
        }));
    }
    entries.sort_by(|a, b| {
        let dir_order = b["isDir"].as_bool().cmp(&a["isDir"].as_bool());
        dir_order.then_with(|| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
        })
    });

    Ok(json!({ "ok": true, "path": relative, "entries": entries }))
}

/// Reads a bounded UTF-8 text file under the workspace root.
fn read_text(request: &Value) -> FilesResult {
    let root = canonical_root(field(request, "cwd"))?;
    let path = resolve_existing(&root, field(request, "path"))?;
    let meta = fs::metadata(&path).map_err(|err| format!("Unable to read file metadata: {err}"))?;
    if !meta.is_file() {
        return Err("Path is not a file".into());
    }
    if meta.len() > TEXT_MAX_BYTES {
        return Err("File exceeds 2 MiB preview limit".into());
    }
    let text = fs::read_to_string(path).map_err(|err| format!("Unable to read UTF-8 file: {err}"))?;
    Ok(json!({ "ok": true, "text": text }))
}

/// Renames or moves an entry; both endpoints are containment-checked.
fn rename_entry(request: &Value) -> FilesResult {
    let root = canonical_root(field(request, "cwd"))?;
    let from = resolve_existing(&root, field(request, "from"))?;
    if from == root {
        return Err("Cannot move the workspace root".into());
    }
    let to = resolve_destination(&root, field(request, "to"))?;
    if to.exists() {
        return Err("Destination already exists".into());
    }
    if to.starts_with(&from) {
        return Err("Cannot move a directory into itself".into());
    }
    fs::rename(&from, &to).map_err(|err| format!("Unable to move: {err}"))?;
    Ok(json!({ "ok": true }))
}

/// Sends an entry to the OS trash so deletions stay recoverable.
fn trash_entry(request: &Value) -> FilesResult {
    let root = canonical_root(field(request, "cwd"))?;
    let target = resolve_existing(&root, field(request, "path"))?;
    if target == root {
        return Err("Cannot delete the workspace root".into());
    }
    trash::delete(&target).map_err(|err| format!("Unable to move to trash: {err}"))?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "swath-files-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_directories_before_files() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("a.txt"), b"a").unwrap();

        let response = rpc(json!({ "op": "list", "cwd": dir.to_string_lossy(), "path": "" })).unwrap();
        let entries = response["entries"].as_array().unwrap();
        assert_eq!(entries[0]["name"], "src");
        assert_eq!(entries[0]["isDir"], true);
        assert_eq!(entries[1]["name"], "a.txt");
        assert_eq!(entries[1]["isDir"], false);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_utf8_text_files() {
        let dir = temp_dir("read-text");
        fs::write(dir.join("README.md"), "# Hello").unwrap();
        let response = rpc(json!({
            "op": "readText",
            "cwd": dir.to_string_lossy(),
            "path": "README.md"
        }))
        .unwrap();
        assert_eq!(response["text"], "# Hello");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_traversal_on_list_and_rename() {
        let dir = temp_dir("trav");
        fs::write(dir.join("a.txt"), b"a").unwrap();

        let err = rpc(json!({ "op": "list", "cwd": dir.to_string_lossy(), "path": ".." }))
            .unwrap_err();
        assert!(err.contains("escapes"), "{err}");

        let err = rpc(json!({
            "op": "rename",
            "cwd": dir.to_string_lossy(),
            "from": "a.txt",
            "to": "../escaped.txt",
        }))
        .unwrap_err();
        assert!(err.contains("escapes"), "{err}");
        assert!(dir.join("a.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn renames_and_moves_within_root() {
        let dir = temp_dir("rename");
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.txt"), b"a").unwrap();

        rpc(json!({
            "op": "rename",
            "cwd": dir.to_string_lossy(),
            "from": "a.txt",
            "to": "nested/b.txt",
        }))
        .unwrap();
        assert!(dir.join("nested/b.txt").exists());
        assert!(!dir.join("a.txt").exists());

        let err = rpc(json!({
            "op": "rename",
            "cwd": dir.to_string_lossy(),
            "from": "nested",
            "to": "nested/deeper",
        }))
        .unwrap_err();
        assert!(err.contains("into itself"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_to_overwrite_existing_destination() {
        let dir = temp_dir("clobber");
        fs::write(dir.join("a.txt"), b"a").unwrap();
        fs::write(dir.join("b.txt"), b"b").unwrap();

        let err = rpc(json!({
            "op": "rename",
            "cwd": dir.to_string_lossy(),
            "from": "a.txt",
            "to": "b.txt",
        }))
        .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(dir.join("b.txt")).unwrap(), b"b");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_to_mutate_the_root() {
        let dir = temp_dir("root");
        let err = rpc(json!({ "op": "trash", "cwd": dir.to_string_lossy(), "path": "" }))
            .unwrap_err();
        assert!(err.contains("workspace root"), "{err}");
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn hides_and_rejects_symlinks() {
        let dir = temp_dir("symlink");
        fs::write(dir.join("real.txt"), b"r").unwrap();
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("link.txt")).unwrap();

        let response = rpc(json!({ "op": "list", "cwd": dir.to_string_lossy(), "path": "" })).unwrap();
        let names: Vec<&str> = response["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["real.txt"]);

        let err = rpc(json!({ "op": "trash", "cwd": dir.to_string_lossy(), "path": "link.txt" }))
            .unwrap_err();
        assert!(err.contains("Symlink"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }
}
