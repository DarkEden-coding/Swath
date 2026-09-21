# Deployment

Swath deployments use one always-on headless catalog server and one or more desktop
executors. The catalog server is the durable authority for shared catalog changes; desktop
installations are clients/executors and must not be promoted as catalog voters.

## Configure a rollout

The network rollout script reads machine-specific values from `scripts/deploy.env`, which is
ignored by Git. Start with [`scripts/deploy.env.example`](../scripts/deploy.env.example):

```sh
cp scripts/deploy.env.example scripts/deploy.env
$EDITOR scripts/deploy.env
```

Set `SWATH_REMOTE_USER`, `SWATH_REMOTE_ROOT`, `SWATH_SERVER_HOST`, and `SWATH_SCYTHE_HOST` for
the target network. Use SSH keys; connector credentials stay in each device's
`~/.config/swath/connector.env` and are never copied from this repository.

`DEPLOYMENT.md` is reserved for a local operator runbook and is ignored. Do not add hostnames,
tailnet addresses, network IDs, device IDs, tokens, or passwords to tracked documentation.

## Deploy

From a clean checkout on the deployment workstation:

```sh
bash scripts/deploy-network.sh
```

The script validates the current checkout, fast-forwards the configured branch, validates the
result again, synchronizes source without `.git`, build output, environment files, or local
databases, and builds the headless server before restarting it. It then installs desktop builds,
starts the GUI-owned executor, and performs local health/catalog-readiness smoke checks.

The default path refuses tracked changes and requires the configured branch. A reviewed repair
rollout may set `SWATH_DEPLOY_ALLOW_DIRTY=1`; this does not bypass validation.

## Recovery guarantees

Before replacing the catalog binary, the script creates a timestamped backup of the existing
binary and, when present, the SQLite catalog under the configured data directory's
`deploy-backups/` folder. The new binary is staged and atomically moved into place.
If restart or health checks fail, the previous binary is restored and the service is restarted.
Desktop build or smoke-test failures also restore the catalog binary so a partial rollout is not
reported as complete.
Database backups contain connector credentials, so restrict permissions and treat them as secret.

For an operator-directed database repair, stop the service first, take an additional backup, and
use a copy for inspection. Never delete the catalog, Raft state, project repositories, or task
worktrees as the first recovery step.

## Validation commands

The same checks run locally and in CI:

```sh
npm install
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm test
cargo fmt --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin swath-headless
```

Headless services must set an absolute `SWATH_DATA_DIR`, normally
`$HOME/.local/share/swath`. Desktop and headless processes must not share a data directory at
the same time.
