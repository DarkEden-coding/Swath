#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_ROOT="/home/dark/Swath"
DEPLOY_BRANCH="${SWATH_DEPLOY_BRANCH:-feature/single-server-topology}"
# Direct Tailscale IPs are used below.  Accept a first connection's host key so a newly enrolled
# device can participate in a rollout without requiring an interactive SSH prompt; an already
# known key still cannot change silently.
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
DEPLOY_ALLOW_DIRTY="${SWATH_DEPLOY_ALLOW_DIRTY:-0}"
SERVER_NAME="power-server"
SERVER_HOST="100.107.192.39"
SCYTHE_HOST="100.80.230.33"
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

sync_source() {
  local host="$1"
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude src-tauri/target \
    --exclude DEPLOYMENT.md \
    "$ROOT_DIR/" "dark@${host}:${REMOTE_ROOT}/"
}

build_server() {
  local name="$1"
  local host="$2"
  local output="$TEMP_DIR/${name}.log"
  if ! ssh "${SSH_OPTIONS[@]}" "dark@${host}" \
    "cd '$REMOTE_ROOT' && { source \"\$HOME/.cargo/env\" 2>/dev/null || true; } && cargo build --release --no-default-features --manifest-path src-tauri/Cargo.toml --bin swath-headless" \
    >"$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  tail -n 3 "$output"
}

install_server() {
  local name="$1"
  local host="$2"
  local commit="$3"
  log "Installing and restarting $name"
  ssh "${SSH_OPTIONS[@]}" "dark@${host}" \
    "install -m 0755 '$REMOTE_ROOT/src-tauri/target/release/swath-headless' \"\$HOME/.local/bin/swath-headless\" &&
     systemctl --user restart swath-headless &&
     systemctl --user is-active --quiet swath-headless &&
     printf '%s\n' '$commit' > \"\$HOME/.local/share/swath/deployed-commit\""
}

verify_server() {
  local host="$1"
  local commit="$2"
  ssh "${SSH_OPTIONS[@]}" "dark@${host}" "
    set -e
    systemctl --user is-active --quiet swath-headless
    source \"\$HOME/.config/swath/connector.env\"
    local_health=\"\$(curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-all-errors \"http://127.0.0.1:\${SWATH_CONNECTOR_PORT:-7878}/api/health\")\"
    endpoint=\"\$(SWATH_DATA_DIR_VALUE=\"\${SWATH_DATA_DIR:-\$HOME/.local/share/swath}\" python3 - <<'PY'
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
  ssh "${SSH_OPTIONS[@]}" "dark@${SCYTHE_HOST}" '
    systemctl --user stop swath-desktop 2>/dev/null || true
    for pid in $(pgrep -x swath 2>/dev/null || true); do
      executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
      case "$executable" in
        /home/dark/.local/bin/swath|"/home/dark/.local/bin/swath (deleted)") kill "$pid" 2>/dev/null || true ;;
      esac
    done
    for _ in 1 2 3 4 5; do
      pgrep -x swath >/dev/null 2>&1 || exit 0
      sleep 1
    done
    for pid in $(pgrep -x swath 2>/dev/null || true); do
      executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
      case "$executable" in
        /home/dark/.local/bin/swath|"/home/dark/.local/bin/swath (deleted)") kill -KILL "$pid" 2>/dev/null || true ;;
      esac
    done
  '
}

cd "$ROOT_DIR"
require_command git
require_command npm
require_command cargo
require_command rsync
require_command ssh

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
  commit="repair-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
  log "Deploying the reviewed local repair tree without fetching or resetting Git"
else
  log "Updating $DEPLOY_BRANCH from GitHub"
  git fetch origin "$DEPLOY_BRANCH"
  git pull --ff-only origin "$DEPLOY_BRANCH"
  commit="$(git rev-parse HEAD)"
fi
echo "Deploying $commit"

log "Running local validation"
npm run typecheck
npm run test:unit
cargo check --manifest-path src-tauri/Cargo.toml --all-targets

log "Synchronizing source to the catalog server and desktop executor"
for host in "$SERVER_HOST" "$SCYTHE_HOST"; do
  sync_source "$host"
done

log "Building the catalog server without interrupting its connector"
if ! build_server "$SERVER_NAME" "$SERVER_HOST"; then
  echo "The catalog server build failed; its running service was not restarted." >&2
  exit 1
fi

install_server "$SERVER_NAME" "$SERVER_HOST" "$commit"
verify_server "$SERVER_HOST" "$commit"

log "Building and installing the Mac and Scythe desktop apps"
mac_was_running=0
if pgrep -x swath >/dev/null 2>&1; then
  mac_was_running=1
  osascript -e 'tell application "Swath" to quit' || true
  sleep 2
fi

bash scripts/install-mac.sh >"$TEMP_DIR/mac.log" 2>&1 &
mac_pid="$!"
ssh "${SSH_OPTIONS[@]}" "dark@${SCYTHE_HOST}" \
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
  echo "At least one desktop build failed." >&2
  exit 1
fi

log "Restarting Scythe's GUI-owned connector"
stop_scythe_desktop
ssh "${SSH_OPTIONS[@]}" "dark@${SCYTHE_HOST}" \
  "systemctl --user disable --now swath-headless >/dev/null 2>&1 || true
   systemctl --user reset-failed swath-desktop 2>/dev/null || true
   systemd-run --user --unit=swath-desktop --collect /home/dark/.local/bin/swath-desktop
   sleep 5
   systemctl --user is-active --quiet swath-desktop
   test \"\$(systemctl --user is-enabled swath-headless 2>/dev/null || true)\" = disabled
   printf '%s\n' '$commit' > \"\$HOME/.local/share/swath/deployed-commit\""

log "Final service verification"
verify_server "$SERVER_HOST" "$commit"
echo "$SERVER_NAME: active"
ssh "${SSH_OPTIONS[@]}" "dark@${SCYTHE_HOST}" \
  "systemctl --user is-active --quiet swath-desktop && grep -q '/api/raft/write' '$REMOTE_ROOT/src-tauri/src/remote.rs'"
echo "Scythe-Desktop: active"
echo "Mac app: /Applications/Swath.app"
echo "Deployment complete: $commit"
