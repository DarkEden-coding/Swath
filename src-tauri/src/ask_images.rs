//! Batch loader for images attached to `ask_user_questions` prompts.
//!
//! The renderer sends every path for a question set in one call and gets back data URLs.
//! Per-image failures are reported inline rather than failing the whole batch, so one bad
//! path cannot block the user from answering.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Maximum size of a single attached image.
pub const ASK_IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Maximum number of images loaded in one batch.
pub const ASK_IMAGE_MAX_COUNT: usize = 32;

type AskImagesResult = Result<Value, String>;

/// Loads every requested path, returning one entry per input in the same order.
pub fn load(request: Value) -> AskImagesResult {
    let cwd = request
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if cwd.is_empty() {
        return Err("Image cwd is required".into());
    }

    // The other folders of a project group are equally part of the project, so an image the agent
    // points at inside one of them is as legitimate as one under `cwd`.
    let mut roots = vec![cwd.clone()];
    roots.extend(
        request
            .get("roots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty() && *root != cwd),
    );

    let paths = request
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "Image paths are required".to_string())?;
    if paths.len() > ASK_IMAGE_MAX_COUNT {
        return Err(format!(
            "Too many images requested (max {ASK_IMAGE_MAX_COUNT})"
        ));
    }

    let images: Vec<Value> = paths
        .iter()
        .map(|entry| {
            let requested = entry.as_str().unwrap_or("").trim();
            match load_one(&cwd, &roots, requested) {
                Ok(image) => image,
                Err(message) => json!({ "path": requested, "error": message }),
            }
        })
        .collect();

    Ok(json!({ "images": images }))
}

/// Loads a single raster image and encodes it as a `data:` URL.
fn load_one(cwd: &str, roots: &[String], path: &str) -> Result<Value, String> {
    if path.is_empty() {
        return Err("Image path is empty".into());
    }

    let resolved = resolve_path(cwd, roots, path)?;
    let meta = fs::symlink_metadata(&resolved)
        .map_err(|err| format!("Unable to read image metadata: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("Symlinked images are not allowed".into());
    }
    if !meta.is_file() {
        return Err("Image path is not a regular file".into());
    }
    if meta.len() > ASK_IMAGE_MAX_BYTES {
        return Err(format!(
            "Image exceeds {} MiB limit",
            ASK_IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let mut file =
        fs::File::open(&resolved).map_err(|err| format!("Unable to open image: {err}"))?;
    let mut header = [0u8; 16];
    let header_len = file
        .read(&mut header)
        .map_err(|err| format!("Unable to read image: {err}"))?;
    let mime_type = detect_mime(&header[..header_len])
        .ok_or_else(|| "Unsupported image type (allowed: PNG, JPEG, GIF, WebP)".to_string())?;

    let mut data = Vec::with_capacity(meta.len() as usize);
    data.extend_from_slice(&header[..header_len]);
    file.read_to_end(&mut data)
        .map_err(|err| format!("Unable to read image: {err}"))?;
    if data.len() as u64 > ASK_IMAGE_MAX_BYTES {
        return Err(format!(
            "Image exceeds {} MiB limit",
            ASK_IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let title = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(json!({
        "path": resolved.to_string_lossy(),
        "title": title,
        "dataUrl": format!("data:{mime_type};base64,{}", BASE64.encode(&data)),
        "byteLength": data.len() as u64,
    }))
}

/// Resolves `path` and confirms it sits under one of the project's folders or the system temp dir.
///
/// Temp is allowed because agents routinely attach freshly captured screenshots that were
/// never written into the project tree.
fn resolve_path(cwd: &str, roots: &[String], path: &str) -> Result<PathBuf, String> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_dir() {
        return Err("Image cwd is not a directory".into());
    }
    let canonical_cwd = cwd_path
        .canonicalize()
        .map_err(|err| format!("Unable to resolve image cwd: {err}"))?;

    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canonical_cwd.join(requested)
    };

    // Reject a symlinked leaf before canonicalize() follows it out of the allowed roots.
    if let Ok(meta) = fs::symlink_metadata(&joined) {
        if meta.file_type().is_symlink() {
            return Err("Symlinked images are not allowed".into());
        }
    }

    let canonical = joined
        .canonicalize()
        .map_err(|err| format!("Unable to resolve image path: {err}"))?;
    if canonical.starts_with(&canonical_cwd) {
        return Ok(canonical);
    }
    for root in roots {
        if let Ok(canonical_root) = Path::new(root).canonicalize() {
            if canonical.starts_with(&canonical_root) {
                return Ok(canonical);
            }
        }
    }
    if let Ok(temp) = std::env::temp_dir().canonicalize() {
        if canonical.starts_with(&temp) {
            return Ok(canonical);
        }
    }
    Err("Image path is outside the workspace and temp directories".into())
}

/// Returns a MIME type when `header` matches an allowed raster image format.
fn detect_mime(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if header.len() >= 3 && header.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, b'd', b'a'];

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "swath-ask-images-{}-{}-{}",
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
    fn loads_batch_in_request_order() {
        let dir = temp_dir("batch");
        fs::write(dir.join("a.png"), PNG).unwrap();
        fs::write(dir.join("b.png"), PNG).unwrap();

        let response = load(json!({
            "cwd": dir.to_string_lossy(),
            "paths": ["a.png", "b.png"],
        }))
        .unwrap();

        let images = response["images"].as_array().unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0]["title"], "a.png");
        assert_eq!(images[1]["title"], "b.png");
        assert!(images[0]["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reports_per_image_errors_without_failing_batch() {
        let dir = temp_dir("partial");
        fs::write(dir.join("good.png"), PNG).unwrap();
        fs::write(dir.join("bad.svg"), b"<svg></svg>").unwrap();

        let response = load(json!({
            "cwd": dir.to_string_lossy(),
            "paths": ["good.png", "bad.svg", "missing.png"],
        }))
        .unwrap();

        let images = response["images"].as_array().unwrap();
        assert_eq!(images.len(), 3);
        assert!(images[0]["dataUrl"].is_string());
        assert!(images[1]["error"]
            .as_str()
            .unwrap()
            .contains("Unsupported image type"));
        assert!(images[2]["error"].is_string());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_paths_outside_cwd_and_temp() {
        let dir = temp_dir("escape");
        // The workspace root itself is inside temp, so probe a path guaranteed to be outside both.
        let outside = if cfg!(windows) {
            "C:/Windows/System32/drivers/etc/hosts"
        } else {
            "/etc/hosts"
        };
        let response = load(json!({
            "cwd": dir.to_string_lossy(),
            "paths": [outside],
        }))
        .unwrap();
        assert!(response["images"][0]["error"].is_string());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_batch() {
        let dir = temp_dir("count");
        let paths: Vec<String> = (0..=ASK_IMAGE_MAX_COUNT)
            .map(|i| format!("{i}.png"))
            .collect();
        let err = load(json!({ "cwd": dir.to_string_lossy(), "paths": paths })).unwrap_err();
        assert!(err.contains("Too many images"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_supported_magic_numbers() {
        assert_eq!(detect_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(detect_mime(b"GIF89a...."), Some("image/gif"));
        let mut webp = b"RIFF1234WEBP".to_vec();
        assert_eq!(detect_mime(&webp), Some("image/webp"));
        webp[8] = b'X';
        assert_eq!(detect_mime(&webp), None);
    }
}
