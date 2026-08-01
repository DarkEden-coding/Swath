//! Secure local image loading for pi-only terminal image previews.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Maximum image payload accepted by `image_rpc` load.
pub const IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;

type ImageResult = Result<Value, String>;

/// Dispatches a JSON image RPC request.
pub fn rpc(request: Value) -> ImageResult {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match op {
        "load" => load_image(&request),
        "" => Err("Invalid image request: missing op".into()),
        other => Err(format!("Unknown image operation: {other}")),
    }
}

/// Loads a PNG/JPEG/GIF/WebP file under `cwd` and returns base64 image data.
fn load_image(request: &Value) -> ImageResult {
    let path = request
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let cwd = request
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if path.is_empty() {
        return Err("Image path is required".into());
    }
    if cwd.is_empty() {
        return Err("Image cwd is required".into());
    }

    let resolved = resolve_image_path(cwd, path)?;
    let meta = fs::symlink_metadata(&resolved)
        .map_err(|err| format!("Unable to read image metadata: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("Symlinked images are not allowed".into());
    }
    if !meta.is_file() {
        return Err("Image path is not a regular file".into());
    }
    let byte_length = meta.len();
    if byte_length > IMAGE_MAX_BYTES {
        return Err(format!(
            "Image exceeds {} MiB limit",
            IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let mut file =
        fs::File::open(&resolved).map_err(|err| format!("Unable to open image: {err}"))?;
    let mut header = [0u8; 16];
    let header_len = file
        .read(&mut header)
        .map_err(|err| format!("Unable to read image: {err}"))?;
    let mime_type = detect_image_mime(&header[..header_len])
        .ok_or_else(|| "Unsupported image type (allowed: PNG, JPEG, GIF, WebP)".to_string())?;

    let mut data = Vec::with_capacity(byte_length as usize);
    data.extend_from_slice(&header[..header_len]);
    file.read_to_end(&mut data)
        .map_err(|err| format!("Unable to read image: {err}"))?;
    if data.len() as u64 > IMAGE_MAX_BYTES {
        return Err(format!(
            "Image exceeds {} MiB limit",
            IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let title = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();
    let path_text = resolved.to_string_lossy().into_owned();

    Ok(json!({
        "ok": true,
        "path": path_text,
        "title": title,
        "mimeType": mime_type,
        "dataBase64": BASE64.encode(&data),
        "byteLength": data.len() as u64,
    }))
}

/// Resolves `path` under canonical `cwd`, rejecting traversal escapes.
fn resolve_image_path(cwd: &str, path: &str) -> Result<PathBuf, String> {
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

    // Reject the leaf when it is a symlink before following links for containment.
    if let Ok(meta) = fs::symlink_metadata(&joined) {
        if meta.file_type().is_symlink() {
            return Err("Symlinked images are not allowed".into());
        }
    }

    let canonical = joined
        .canonicalize()
        .map_err(|err| format!("Unable to resolve image path: {err}"))?;
    if !canonical.starts_with(&canonical_cwd) {
        return Err("Image path escapes the working directory".into());
    }
    Ok(canonical)
}

/// Returns a MIME type when `header` matches an allowed raster image format.
fn detect_image_mime(header: &[u8]) -> Option<&'static str> {
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
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "swath-image-{}-{}-{}",
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

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn loads_png_under_cwd_as_base64() {
        let dir = temp_dir("png");
        let png = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, b'd', b'a', b't', b'a',
        ];
        let file = dir.join("pic.png");
        write_file(&file, &png);

        let response = rpc(json!({
            "op": "load",
            "path": "pic.png",
            "cwd": dir.to_string_lossy(),
        }))
        .unwrap();

        assert_eq!(response["ok"], true);
        assert_eq!(response["mimeType"], "image/png");
        assert_eq!(response["title"], "pic.png");
        assert_eq!(response["byteLength"], png.len() as u64);
        assert_eq!(
            BASE64
                .decode(response["dataBase64"].as_str().unwrap())
                .unwrap(),
            png
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_svg_and_unknown_magic() {
        let dir = temp_dir("svg");
        write_file(
            dir.join("x.svg").as_path(),
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        );
        let err = rpc(json!({
            "op": "load",
            "path": "x.svg",
            "cwd": dir.to_string_lossy(),
        }))
        .unwrap_err();
        assert!(err.contains("Unsupported image type"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = temp_dir("trav");
        let outside = temp_dir("outside");
        let secret = outside.join("secret.png");
        write_file(
            &secret,
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3],
        );
        let relative = format!(
            "../{}/secret.png",
            outside.file_name().unwrap().to_string_lossy()
        );
        let err = rpc(json!({
            "op": "load",
            "path": relative,
            "cwd": dir.to_string_lossy(),
        }))
        .unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("Unable to resolve"),
            "{err}"
        );
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn rejects_symlink_file() {
        let dir = temp_dir("sym");
        let target = dir.join("real.png");
        write_file(
            &target,
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 9],
        );
        let link = dir.join("link.png");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let err = rpc(json!({
                "op": "load",
                "path": "link.png",
                "cwd": dir.to_string_lossy(),
            }))
            .unwrap_err();
            assert!(err.contains("Symlink"), "{err}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_file() {
        let dir = temp_dir("big");
        let file = dir.join("big.png");
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.resize((IMAGE_MAX_BYTES as usize) + 8, 0x41);
        write_file(&file, &bytes);
        let err = rpc(json!({
            "op": "load",
            "path": "big.png",
            "cwd": dir.to_string_lossy(),
        }))
        .unwrap_err();
        assert!(err.contains("MiB"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_jpeg_gif_webp_magic() {
        assert_eq!(
            detect_image_mime(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(detect_image_mime(b"GIF89a...."), Some("image/gif"));
        let mut webp = b"RIFF1234WEBP".to_vec();
        assert_eq!(detect_image_mime(&webp), Some("image/webp"));
        webp[8] = b'X';
        assert_eq!(detect_image_mime(&webp), None);
    }
}
