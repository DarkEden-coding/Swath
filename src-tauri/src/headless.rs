//! `swath-headless`: display-free Swath executor and connector.

use swath_lib::run_headless;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let token = std::env::var("SWATH_CONNECTOR_TOKEN")
        .map_err(|_| anyhow::anyhow!("SWATH_CONNECTOR_TOKEN is required"))?;
    let data_dir = std::env::var_os("SWATH_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("./swath-data"));
    run_headless(data_dir, swath_lib::headless_options(token)).await
}
