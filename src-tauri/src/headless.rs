//! Display-free connector for the historical `main` remote execution protocol.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let token = std::env::var("SWATH_CONNECTOR_TOKEN")
        .map_err(|_| anyhow::anyhow!("SWATH_CONNECTOR_TOKEN is required"))?;
    let data_dir = std::env::var_os("SWATH_DATA_DIR")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("SWATH_DATA_DIR is required"))?;
    swath_lib::run_headless(data_dir, swath_lib::headless_options(token)).await
}
