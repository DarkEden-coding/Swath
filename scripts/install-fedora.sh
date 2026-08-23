#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Swath"
BIN_NAME="swath"
EXPECTED_BIN_PATH="${ROOT_DIR}/src-tauri/target/release/${BIN_NAME}"
INSTALL_PREFIX="${HOME}/.local"
BIN_DIR="${INSTALL_PREFIX}/bin"
DESKTOP_DIR="${INSTALL_PREFIX}/share/applications"
ICON_DIR="${INSTALL_PREFIX}/share/icons/hicolor/256x256/apps"
INSTALLED_BIN_PATH="${BIN_DIR}/${BIN_NAME}"
DESKTOP_PATH="${DESKTOP_DIR}/${BIN_NAME}.desktop"
SYSTEM_DESKTOP_PATH="/usr/share/applications/${BIN_NAME}.desktop"
ICON_SOURCE="${ROOT_DIR}/src-tauri/icons/icon.png"
INSTALLED_ICON_PATH="${ICON_DIR}/${BIN_NAME}.png"
OS_RELEASE_PATH="/etc/os-release"
CARGO_ENV="${HOME}/.cargo/env"
TAURI_PACKAGES=(
  webkit2gtk4.1-devel
  openssl-devel
  curl
  wget2
  file
  libappindicator-gtk3-devel
  librsvg2-devel
  libxdo-devel
  gcc
  gcc-c++
  make
)

cd "$ROOT_DIR"

assert_fedora() {
  if [[ ! -f "$OS_RELEASE_PATH" ]]; then
    echo "Could not detect Linux distribution: ${OS_RELEASE_PATH} is missing." >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  source "$OS_RELEASE_PATH"
  if [[ "${ID:-}" != "fedora" ]]; then
    echo "This installer targets Fedora Linux. Detected: ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi
}

assert_fedora_native_build_prerequisites() {
  local missing_packages=()
  local package_name

  for package_name in "${TAURI_PACKAGES[@]}"; do
    if ! rpm -q "$package_name" >/dev/null 2>&1; then
      missing_packages+=("$package_name")
    fi
  done

  if [[ ${#missing_packages[@]} -gt 0 ]]; then
    echo "Fedora native build packages were not found: ${missing_packages[*]}" >&2
    echo "Install them with: sudo dnf install ${missing_packages[*]}" >&2
    exit 1
  fi

  if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    echo "Rust was not found. Install rustup from https://rustup.rs/ and ensure cargo is on PATH." >&2
    exit 1
  fi
}

if [[ -f "$CARGO_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$CARGO_ENV"
fi

assert_fedora
assert_fedora_native_build_prerequisites

if [[ ! -x "${ROOT_DIR}/node_modules/.bin/tauri" ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building ${APP_NAME} Tauri bundle for Fedora Linux..."
# The install uses the release executable directly, so generating RPM/AppImage packages is wasted work.
npm run tauri:build -- --no-bundle

if [[ ! -x "$EXPECTED_BIN_PATH" ]]; then
  echo "Could not find built executable at ${EXPECTED_BIN_PATH}" >&2
  exit 1
fi

HASH="$(sha256sum "$EXPECTED_BIN_PATH" | awk '{print $1}')"
echo "Built executable: ${EXPECTED_BIN_PATH}"
echo "Modified: $(date -u -d "@$(stat -c %Y "$EXPECTED_BIN_PATH")" '+%Y-%m-%d %H:%M:%S UTC')"
echo "SHA256: ${HASH}"

echo "Installing ${APP_NAME} launcher..."
mkdir -p "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
install -m 0755 "$EXPECTED_BIN_PATH" "$INSTALLED_BIN_PATH"
install -m 0644 "$ICON_SOURCE" "$INSTALLED_ICON_PATH"

cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=${APP_NAME} (${HASH})
Exec=${INSTALLED_BIN_PATH}
Icon=${BIN_NAME}
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF

if [[ ! -x "$INSTALLED_BIN_PATH" ]]; then
  echo "Installed binary is missing or not executable: ${INSTALLED_BIN_PATH}" >&2
  exit 1
fi

if ! grep -q "^Exec=${INSTALLED_BIN_PATH}$" "$DESKTOP_PATH"; then
  echo "Desktop entry Exec mismatch. Expected '${INSTALLED_BIN_PATH}'." >&2
  exit 1
fi

if [[ -f "$SYSTEM_DESKTOP_PATH" ]]; then
  echo "A machine-wide desktop entry exists at '${SYSTEM_DESKTOP_PATH}'." >&2
  echo "Launchers may prefer that stale entry. Remove it or update the system package." >&2
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${INSTALL_PREFIX}/share/icons/hicolor" >/dev/null 2>&1 || true
fi

if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 >/dev/null 2>&1 || true
fi

echo "Installed binary: ${INSTALLED_BIN_PATH}"
echo "Installed shortcut: ${DESKTOP_PATH} -> ${INSTALLED_BIN_PATH}"
echo "Launchers that index desktop entries, such as KRunner or GNOME Search, should now be able to find '${APP_NAME}'."
