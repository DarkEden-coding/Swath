# Swath deployment runbook

This file is intentionally untracked. It documents the current Swath network and the commands
needed to build, install, operate, and recover it. Do not commit this file or place bearer tokens,
connector credentials, or passwords in it.

## Repository

- Local checkout: `/Users/dark/Custom-Apps/Swath`
- Git remote: `https://github.com/DarkEden-coding/Swath.git`
- Deployment branch: `main`
- Deployment topology: one catalog server on `power-server`; PiTwo and server-two no longer run
  Swath and are not deployment targets.
- Build prerequisites: Node/npm, Rust/Cargo, and the platform's Tauri/WebKit dependencies.
- Linux headless build: `cargo build --release --no-default-features --manifest-path src-tauri/Cargo.toml --bin swath-headless`
- Linux desktop build/install: `bash scripts/install-fedora.sh`
- macOS app build/install: `bash scripts/install-mac.sh`
- Checks: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`, `npm run typecheck`,
  `npm run test:unit`, and `npm test -- --run`

## Network

- Network name: `Swath-Network`
- Network ID: `net_e88ed7c5d2b1ae8f488d3cf02d72186e`
- Catalog server/voter: `power-server` only.
- `power-server` is the sole Raft member and the durable authority for shared catalog changes.
- The Mac and Scythe are connected client/execution devices; browser viewers use the
  power-server web connector. They are not coordinators and must not be promoted.
- This intentionally has no coordinator failover. If power-server is unavailable, shared writes
  and the hosted web UI are unavailable until it recovers.

## Device inventory

All machines use the `dark` Unix account. Direct SSH uses the IPs below when Tailscale DNS is not
available. Prefer SSH keys. If key authentication is unavailable, retrieve the operator-provided
password from the approved secure channel/password manager; do not put it in this file, shell
history, Git, or a service unit.

| Device | Direct address | Tailscale connector endpoint | Role | Headless service |
| --- | --- | --- | --- | --- |
| Darks-MacBook-Air-2.local | local Mac | `https://darks-macbook-air.tail14d560.ts.net/` | connected GUI client/executor | no |
| power-server | `100.107.192.39` | `https://power-server.tail14d560.ts.net:9443/` | sole catalog server and web host | active |
| Scythe-Desktop | `100.80.230.33` | `https://scythe-desktop-1.tail14d560.ts.net/` | connected GUI executor | disabled |

Device IDs in the catalog:

- Mac: `dev_18dce34fd7f86231ff4af4610f1bdcfb`
- power-server: `dev_c39502c1ffb19da0bc5057b469c08ec2`
- Scythe-Desktop: `dev_92a8660f25c0884904a3e13d11026af9`

PiTwo and server-two were retired from the catalog and their Swath installations/data were
removed. Do not reinstall or reconnect them without intentionally redesigning the topology.

## Install locations and data

### macOS

- Application: `/Applications/Swath.app`
- Catalog/config database: `~/Library/Application Support/dev.generated.swath/swath.sqlite3`
- Installer: `scripts/install-mac.sh`
- The Mac app owns its connector lifetime. Keep the Mac out of the always-on headless service set.

### Fedora desktop (Scythe-Desktop)

- Installed executable: `/home/dark/.local/bin/swath`
- GUI launcher wrapper: `/home/dark/.local/bin/swath-desktop`
- Desktop entry: `/home/dark/.local/share/applications/swath.desktop`
- Shared network database: `/home/dark/.local/share/swath/swath.sqlite3`
- Connector environment: `/home/dark/.config/swath/connector.env`
- `SWATH_DATA_DIR` must remain `/home/dark/.local/share/swath`.
- The GUI launcher sources `connector.env`, sets `SWATH_CONNECTOR_AUTOSTART=1`, and starts the
  connector inside the desktop process. Closing the GUI stops execution access.
- `swath-headless.service` is intentionally disabled on this machine:
  `systemctl --user is-enabled swath-headless` should report `disabled`.

### Always-on catalog server (power-server only)

- Executable: `/home/dark/.local/bin/swath-headless`
- Source checkout: `/home/dark/Swath`
- Data directory: `/home/dark/.local/share/swath`
- Service unit: `/home/dark/.config/systemd/user/swath-headless.service`
- Environment file: `/home/dark/.config/swath/connector.env`
- Service checks:

```sh
systemctl --user status swath-headless
systemctl --user is-active swath-headless
systemctl --user is-enabled swath-headless
```

## SSH and service operations

```sh
ssh dark@100.107.192.39   # power-server
ssh dark@100.80.230.33   # Scythe-Desktop
```

On power-server, restart the Swath connector with:

```sh
systemctl --user restart swath-headless
systemctl --user is-active swath-headless
journalctl --user -u swath-headless -n 100 --no-pager
```

On Scythe, do not start the headless unit for normal operation. Launch the GUI through the desktop
entry or:

```sh
/home/dark/.local/bin/swath-desktop
```

For a controlled GUI test from an active KDE user session:

```sh
systemd-run --user --unit=swath-desktop --collect /home/dark/.local/bin/swath-desktop
```

## Updating a deployment

From the Mac checkout, use the network deployment script as the normal update path:

```sh
cd /Users/dark/Custom-Apps/Swath
bash scripts/deploy-network.sh
```

The script:

1. Refuses to deploy with uncommitted tracked changes or from an unexpected branch.
2. Fetches and fast-forward pulls `main` from GitHub. Set
   `SWATH_DEPLOY_BRANCH` only when intentionally deploying another checked-out branch.
3. Runs the TypeScript, unit-test, and Rust checks locally.
4. Syncs source only to power-server and Scythe-Desktop, without copying `.git`, `node_modules`,
   build output, this untracked runbook, or any device database.
5. Builds and restarts power-server's one catalog-server binary.
6. Builds and installs both desktop apps, preserves whether the Mac app was running, disables the
   Scythe headless unit, and cleanly relaunches Scythe's GUI-owned connector.
7. Records the deployed commit in `~/.local/share/swath/deployed-commit` on power-server and
   verifies final service state.

The script requires key-based SSH access to power-server and Scythe-Desktop and the build
prerequisites listed above. Push the intended commit before running it; the fast-forward pull makes
GitHub the source of truth. A failed power-server build stops before its service is restarted.

Use manual commands only for targeted recovery. To rebuild and restart power-server:

```sh
ssh dark@100.107.192.39
cd /home/dark/Swath
cargo build --release --no-default-features --manifest-path src-tauri/Cargo.toml --bin swath-headless
install -m 0755 src-tauri/target/release/swath-headless ~/.local/bin/swath-headless
systemctl --user restart swath-headless
systemctl --user is-active swath-headless
```

## Catalog and migration safety

- Back up power-server's database before any repair or direct reconciliation. Use a timestamped
  copy beside the database, never overwrite the only copy.
- The authoritative catalog is power-server's single-node Raft catalog. A Mac or Scythe GUI
  database can be stale even when its sidebar still displays old projects.
- Do not add a coordinator, alter Raft membership, or use the single-server reseed command during
  routine deployment. The reseed command is an explicit disaster-recovery operation: it retains
  the catalog projection but discards the previous Raft log and snapshots.
- If a connected executor returns `unknown_executor`, verify power-server's catalog and that
  executor's local device identity. Repair the executor connection; do not promote it as a voter.
- If a desktop shows the legacy import screen after catalog reconciliation, inspect
  `legacy_import_operations`. A stale `importing` operation can be finalized only after verifying
  the projects/tasks are already present and taking a backup.
- Never delete the database, `project-repos`, task worktrees, or Raft state as a first recovery step.

## Credential rules

- Connector bearer credentials live in each device's `device_connectors` and
  `enrollment_credentials` tables and in the device-local `connector.env`; they are not documented
  here.
- If connector and enrollment credentials differ during rotation, deploy the current build, which
  accepts both catalog-issued capabilities for the local device while the rotation settles.
- Do not paste tokens/passwords into issue reports, commits, screenshots, shell history, or this
  runbook. Rotate a credential if it is accidentally exposed.
