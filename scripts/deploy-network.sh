#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${SWATH_DEPLOY_CONFIG:-${ROOT_DIR}/scripts/deploy.env}"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Deployment config not found: $CONFIG_FILE" >&2
  echo "Copy scripts/deploy.env.example to scripts/deploy.env and set the target hosts." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a

DEPLOY_BRANCH="${SWATH_DEPLOY_BRANCH:-$(git -C "$ROOT_DIR" branch --show-current)}"
REMOTE_USER="${SWATH_REMOTE_USER:-${USER}}"
REMOTE_ROOT="${SWATH_REMOTE_ROOT:-/home/${REMOTE_USER}/Swath}"
SERVER_HOST="${SWATH_SERVER_HOST:-}"
SCYTHE_HOST="${SWATH_SCYTHE_HOST:-}"
SERVER_SERVICE="${SWATH_SERVER_SERVICE:-swath-headless}"
DESKTOP_SERVICE="${SWATH_DESKTOP_SERVICE:-swath-desktop}"
# Accept a first connection's host key so a newly enrolled device can participate in a rollout
# without requiring an interactive SSH prompt; an already known key still cannot change silently.
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
DEPLOY_ALLOW_DIRTY="${SWATH_DEPLOY_ALLOW_DIRTY:-0}"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

log() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_value() {
  [[ -n "$2" ]] || {
    echo "${1} must be set in ${CONFIG_FILE} (see scripts/deploy.env.example)." >&2
    exit 1
  }
}

remote_target() {
  printf '%s@%s' "$REMOTE_USER" "$1"
}

sync_source() {
  local host="$1"
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$host")" "mkdir -p '$REMOTE_ROOT'"
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude src-tauri/target \
    --exclude .env \
    --exclude '.env.*' \
    --exclude '*.env' \
    --exclude DEPLOYMENT.md \
    --exclude DEPLOYMENT.local.md \
    --exclude deploy-backups \
    "$ROOT_DIR/" "$(remote_target "$host"):${REMOTE_ROOT}/"
}

build_server() {
  local host="$1"
  local output="$TEMP_DIR/server-build.log"
  if ! ssh "${SSH_OPTIONS[@]}" "$(remote_target "$host")" \
    "cd '$REMOTE_ROOT' && { source \"\$HOME/.cargo/env\" 2>/dev/null || true; } && cargo build --release --no-default-features --manifest-path src-tauri/Cargo.toml --bin swath-headless" \
    >"$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  tail -n 3 "$output"
}

install_server() {
  local host="$1"
  local commit="$2"
  local release_id="$3"
  log "Backing up and installing the catalog server"
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$host")" bash -s -- \
    "$REMOTE_ROOT" "$commit" "$release_id" "$SERVER_SERVICE" <<'REMOTE'
set -Eeuo pipefail
remote_root="$1"
commit="$2"
release_id="$3"
service="$4"
binary="$HOME/.local/bin/swath-headless"
if [[ -f "$HOME/.config/swath/connector.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.config/swath/connector.env"
  set +a
fi
data_dir="${SWATH_DATA_DIR:-$HOME/.local/share/swath}"
case "$data_dir" in
  /*) ;;
  *) echo "SWATH_DATA_DIR must be an absolute path: $data_dir" >&2; exit 1 ;;
esac
backup_dir="$data_dir/deploy-backups"
binary_backup="$backup_dir/swath-headless-${release_id}"
marker="$data_dir/deployed-commit"
marker_backup="$backup_dir/deployed-commit-${release_id}"
db="$data_dir/swath.sqlite3"
staged="$binary.new.$$"

mkdir -p "$HOME/.local/bin" "$backup_dir"
chmod 700 "$backup_dir"
if [[ -f "$db" ]]; then
  db_backup="$backup_dir/swath-${release_id}.sqlite3"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$db_backup'"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$db" "$db_backup" <<'PYDB'
import sqlite3
import sys

source, destination = sys.argv[1:]
with sqlite3.connect(source) as source_connection, sqlite3.connect(destination) as destination_connection:
    source_connection.backup(destination_connection)
PYDB
  else
    echo "Cannot back up $db: sqlite3 or python3 is required" >&2
    exit 1
  fi
  chmod 600 "$db_backup"
fi
if [[ -e "$binary" ]]; then
  cp -p "$binary" "$binary_backup"
  chmod 700 "$binary_backup"
fi
if [[ -f "$marker" ]]; then
  cp -p "$marker" "$marker_backup"
  chmod 600 "$marker_backup"
fi

install -m 0755 "$remote_root/src-tauri/target/release/swath-headless" "$staged"
# Both paths are on the same filesystem, so this replacement is atomic for the service.
mv "$staged" "$binary"

restore_previous() {
  if [[ -f "$binary_backup" ]]; then
    install -m 0755 "$binary_backup" "$binary"
  else
    rm -f "$binary"
  fi
  if [[ -f "$marker_backup" ]]; then
    install -m 0600 "$marker_backup" "$marker"
  else
    rm -f "$marker"
  fi
  systemctl --user restart "$service" >/dev/null 2>&1 || true
}

if ! systemctl --user restart "$service" || ! systemctl --user is-active --quiet "$service"; then
  echo "${service} failed after install; restoring the previous binary" >&2
  restore_previous
  exit 1
fi
mkdir -p "$data_dir"
printf '%s\n' "$commit" > "$data_dir/deployed-commit"
REMOTE
}

rollback_server() {
  local host="$1"
  local release_id="$2"
  log "Rolling the catalog server back to release $release_id"
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$host")" bash -s -- \
    "$release_id" "$SERVER_SERVICE" <<'REMOTE'
set -Eeuo pipefail
release_id="$1"
service="$2"
binary="$HOME/.local/bin/swath-headless"
if [[ -f "$HOME/.config/swath/connector.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.config/swath/connector.env"
  set +a
fi
data_dir="${SWATH_DATA_DIR:-$HOME/.local/share/swath}"
backup="$data_dir/deploy-backups/swath-headless-${release_id}"
marker_backup="$data_dir/deploy-backups/deployed-commit-${release_id}"
marker="$data_dir/deployed-commit"
if [[ ! -f "$backup" ]]; then
  echo "Rollback binary is missing: $backup" >&2
  exit 1
fi
install -m 0755 "$backup" "$binary"
if [[ -f "$marker_backup" ]]; then
  install -m 0600 "$marker_backup" "$marker"
fi
systemctl --user restart "$service"
systemctl --user is-active --quiet "$service"
REMOTE
}

verify_server() {
  local host="$1"
  local commit="$2"
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$host")" "
    set -e
    systemctl --user is-active --quiet '$SERVER_SERVICE'
    source \"\$HOME/.config/swath/connector.env\"
    data_dir=\"\${SWATH_DATA_DIR:-\$HOME/.local/share/swath}\"
    case \"\$data_dir\" in /*) ;; *) echo \"SWATH_DATA_DIR must be absolute\" >&2; exit 1 ;; esac
    local_health=\"\$(curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors \"http://127.0.0.1:\${SWATH_CONNECTOR_PORT:-7878}/api/health\")\"
    endpoint=\"\$(SWATH_DATA_DIR_VALUE=\"\$data_dir\" python3 - <<'PY'
import os, sqlite3
db = os.path.join(os.environ['SWATH_DATA_DIR_VALUE'], 'swath.sqlite3')
conn = sqlite3.connect(db)
row = conn.execute('SELECT endpoint FROM device_connectors WHERE device_id=(SELECT server_device_id FROM networks WHERE server_device_id IS NOT NULL LIMIT 1)').fetchone()
if not row:
    raise SystemExit('catalog server endpoint is missing')
print(row[0])
PY
)\"
    advertised_health=\"\$(curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors \"\${endpoint%/}/api/health\")\"
    HEALTH_LOCAL=\"\$local_health\" HEALTH_ADVERTISED=\"\$advertised_health\" EXPECTED_COMMIT='$commit' python3 - <<'PY'
import json, os
for name in ('HEALTH_LOCAL', 'HEALTH_ADVERTISED'):
    value = json.loads(os.environ[name])
    assert value.get('ok') is True, (name, value)
    assert value.get('catalog', {}).get('available') is True, (name, value)
    assert value.get('catalog', {}).get('ready') is True, (name, value)
    assert value.get('serverDeviceId') == value.get('deviceId'), (name, value)
    assert value.get('deployedCommit') == os.environ['EXPECTED_COMMIT'], (name, value)
PY
  "
}

stop_scythe_desktop() {
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$SCYTHE_HOST")" bash -s -- "$DESKTOP_SERVICE" <<'REMOTE'
    service="$1"
    systemctl --user stop "$service" 2>/dev/null || true
    for pid in $(pgrep -u "$(id -u)" -x swath 2>/dev/null || true); do
      executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
      case "$executable" in
        "$HOME/.local/bin/swath"|"$HOME/.local/bin/swath (deleted)") kill "$pid" 2>/dev/null || true ;;
      esac
    done
    for _ in 1 2 3 4 5; do
      pgrep -u "$(id -u)" -x swath >/dev/null 2>&1 || exit 0
      sleep 1
    done
    for pid in $(pgrep -u "$(id -u)" -x swath 2>/dev/null || true); do
      executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
      case "$executable" in
        "$HOME/.local/bin/swath"|"$HOME/.local/bin/swath (deleted)") kill -KILL "$pid" 2>/dev/null || true ;;
      esac
    done
REMOTE
}

start_scythe_desktop() {
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$SCYTHE_HOST")" bash -s -- "$DESKTOP_SERVICE" <<'REMOTE'
set -Eeuo pipefail
service="$1"
systemctl --user disable --now swath-headless >/dev/null 2>&1 || true
systemctl --user reset-failed "$service" 2>/dev/null || true
systemd-run --user --unit="$service" --collect "$HOME/.local/bin/swath-desktop"
REMOTE
}

verify_desktop() {
  ssh "${SSH_OPTIONS[@]}" "$(remote_target "$SCYTHE_HOST")" bash -s -- "$DESKTOP_SERVICE" <<'REMOTE'
set -Eeuo pipefail
service="$1"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  systemctl --user is-active --quiet "$service" && break
  sleep 1
done
systemctl --user is-active --quiet "$service"
if [[ -f "$HOME/.config/swath/connector.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.config/swath/connector.env"
  set +a
fi
port="${SWATH_CONNECTOR_PORT:-7878}"
health="$(curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors "http://127.0.0.1:${port}/api/health")"
HEALTH="$health" python3 - <<'PY'
import json
import os

value = json.loads(os.environ['HEALTH'])
assert value.get('ok') is True, value
assert value.get('deviceId'), value
PY
REMOTE
}

validate_local() {
  log "Running local validation"
  npm run typecheck
  npm run lint
  npm run format:check
  npm run test:unit
  npm test
  cargo fmt --all -- --check
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features
  cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin swath-headless
}

cd "$ROOT_DIR"
require_command git
require_command npm
require_command cargo
require_command curl
require_command rsync
require_command ssh
require_value SWATH_SERVER_HOST "$SERVER_HOST"
require_value SWATH_SCYTHE_HOST "$SCYTHE_HOST"

if [[ -n "$(git status --porcelain --untracked-files=no)" && "$DEPLOY_ALLOW_DIRTY" != "1" ]]; then
  echo "Tracked files have local changes. Commit or stash them before deploying, or set SWATH_DEPLOY_ALLOW_DIRTY=1 for a reviewed repair rollout." >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$DEPLOY_BRANCH" ]]; then
  echo "Expected branch '$DEPLOY_BRANCH', currently on '$current_branch'." >&2
  echo "Set SWATH_DEPLOY_BRANCH to deploy a different branch intentionally." >&2
  exit 1
fi

if [[ "$DEPLOY_ALLOW_DIRTY" == "1" ]]; then
  validate_local
  commit="repair-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
  log "Deploying the reviewed local repair tree without fetching or resetting Git"
else
  log "Fetching $DEPLOY_BRANCH from GitHub (without changing the checkout)"
  git fetch origin "$DEPLOY_BRANCH"
  validate_local
  log "Fast-forwarding the validated checkout"
  git pull --ff-only origin "$DEPLOY_BRANCH"
  validate_local
  commit="$(git rev-parse HEAD)"
fi
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}"
echo "Deploying $commit (release $release_id)"

log "Synchronizing source to the catalog server and desktop executor"
for host in "$SERVER_HOST" "$SCYTHE_HOST"; do
  sync_source "$host"
done

log "Building the catalog server without interrupting its connector"
if ! build_server "$SERVER_HOST"; then
  echo "The catalog server build failed; its running service was not restarted." >&2
  exit 1
fi

install_server "$SERVER_HOST" "$commit" "$release_id"
if ! verify_server "$SERVER_HOST" "$commit"; then
  echo "Catalog server smoke checks failed; attempting rollback." >&2
  rollback_server "$SERVER_HOST" "$release_id"
  exit 1
fi

log "Building and installing the Mac and Scythe desktop apps"
mac_was_running=0
if pgrep -x swath >/dev/null 2>&1; then
  mac_was_running=1
  osascript -e 'tell application "Swath" to quit' || true
  sleep 2
fi

# Stop the GUI before replacing its installed executable; otherwise the running process can keep
# the old deleted inode alive and make a subsequent restart look successful while serving old code.
stop_scythe_desktop
bash scripts/install-mac.sh >"$TEMP_DIR/mac.log" 2>&1 &
mac_pid="$!"
ssh "${SSH_OPTIONS[@]}" "$(remote_target "$SCYTHE_HOST")" \
  "cd '$REMOTE_ROOT' && bash scripts/install-fedora.sh" >"$TEMP_DIR/scythe.log" 2>&1 &
scythe_pid="$!"

desktop_build_failed=0
if ! wait "$mac_pid"; then
  cat "$TEMP_DIR/mac.log" >&2
  desktop_build_failed=1
else
  tail -n 5 "$TEMP_DIR/mac.log"
fi
if ! wait "$scythe_pid"; then
  cat "$TEMP_DIR/scythe.log" >&2
  desktop_build_failed=1
else
  tail -n 7 "$TEMP_DIR/scythe.log"
fi

if [[ "$mac_was_running" -eq 1 && -d /Applications/Swath.app ]]; then
  open -a /Applications/Swath.app
fi

if [[ "$desktop_build_failed" -ne 0 ]]; then
  echo "At least one desktop build failed; restarting the previous Scythe installation." >&2
  start_scythe_desktop || true
  rollback_server "$SERVER_HOST" "$release_id" || true
  exit 1
fi

log "Starting and smoke-testing Scythe's GUI-owned connector"
if ! start_scythe_desktop || ! verify_desktop; then
  echo "Scythe smoke checks failed; attempting catalog-server rollback." >&2
  rollback_server "$SERVER_HOST" "$release_id"
  exit 1
fi
if [[ ! -d /Applications/Swath.app ]]; then
  echo "Mac app smoke check failed; attempting catalog-server rollback." >&2
  rollback_server "$SERVER_HOST" "$release_id"
  exit 1
fi

log "Final service verification"
if ! verify_server "$SERVER_HOST" "$commit"; then
  echo "Final catalog smoke checks failed; attempting rollback." >&2
  rollback_server "$SERVER_HOST" "$release_id"
  exit 1
fi
echo "Catalog server: active and healthy"
echo "Scythe-Desktop: active and healthy"
echo "Mac app: /Applications/Swath.app"
echo "Deployment complete: $commit"
