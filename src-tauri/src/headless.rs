//! `swath-headless`: display-free Swath executor and connector.

use swath_lib::run_headless;

fn required_data_dir(value: Option<std::ffi::OsString>) -> anyhow::Result<std::path::PathBuf> {
    let value = value.ok_or_else(|| anyhow::anyhow!("SWATH_DATA_DIR is required"))?;
    let path = std::path::PathBuf::from(value);
    if path.as_os_str().is_empty() {
        return Err(anyhow::anyhow!("SWATH_DATA_DIR must not be empty"));
    }
    if !path.is_absolute() {
        return Err(anyhow::anyhow!("SWATH_DATA_DIR must be an absolute path"));
    }
    Ok(path)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let token = std::env::var("SWATH_CONNECTOR_TOKEN")
        .map_err(|_| anyhow::anyhow!("SWATH_CONNECTOR_TOKEN is required"))?;
    let data_dir = required_data_dir(std::env::var_os("SWATH_DATA_DIR"))?;
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--migrate-to-single-server")
    {
        return swath_lib::migrate_to_single_server(data_dir, token).await;
    }
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--reseed-single-server")
    {
        return swath_lib::reseed_single_server(data_dir);
    }
    run_headless(data_dir, swath_lib::headless_options(token)).await
}

#[cfg(test)]
mod tests {
    use super::required_data_dir;
    use std::ffi::OsString;

    #[test]
    fn data_dir_is_required_and_must_be_absolute() {
        assert!(required_data_dir(None).is_err());
        assert!(required_data_dir(Some(OsString::from("./swath-data"))).is_err());
        assert_eq!(
            required_data_dir(Some(OsString::from("/var/lib/swath")))
                .unwrap()
                .to_string_lossy(),
            "/var/lib/swath"
        );
    }
}
