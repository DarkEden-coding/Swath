# Headless connector for historical `main`

`swath-headless` serves the same v1 handshake, WebSocket RPC methods, event channels, and embedded renderer as the desktop connector, without starting a Tauri window or requiring a display at runtime. It is an executor/connector for the pre-restructure `main` model, not the later project/task catalog server.

Build the renderer first, then the Linux binary:

```sh
npm install
npm run build:renderer
cargo build --release --no-default-features --manifest-path src-tauri/Cargo.toml --bin swath-headless
```

The process requires `SWATH_CONNECTOR_TOKEN` (at least 16 characters) and an absolute `SWATH_DATA_DIR`. Optional settings are `SWATH_CONNECTOR_BIND` (default `127.0.0.1`), `SWATH_CONNECTOR_PORT` (default `7878`), and `SWATH_CONNECTOR_TAILSCALE_HTTPS` (`1` to enable Tailscale Serve on port 443). It exits on SIGTERM/SIGINT and releases its data-directory lock. If an existing Tailscale Serve route uses a different HTTPS port, leave automatic Serve disabled and configure that proxy separately.

Do not point this runner at a database from the newer project/task-transfer branch without a separately tested migration. Historical `main` uses the `app_config` v2 document; the newer catalog is not automatically converted. Back up the server database, use a separate data directory for initial testing, and verify the desired workspaces and remote connections before replacing the existing power-server service. Do not run two Swath executors against the same data directory.
