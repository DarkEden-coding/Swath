#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Swath"
PRODUCT_APP="${APP_NAME}.app"
DEST_DIR="/Applications"
DEST_APP="${DEST_DIR}/${PRODUCT_APP}"

cd "$ROOT_DIR"

echo "Building ${APP_NAME} for macOS..."
npm run build
npx electron-builder --mac dir

APP_PATH=""
while IFS= read -r -d '' candidate; do
  APP_PATH="$candidate"
  break
done < <(find "$ROOT_DIR/release" -maxdepth 3 -type d -name "$PRODUCT_APP" -print0)

if [[ -z "$APP_PATH" ]]; then
  echo "Could not find built app at release/**/${PRODUCT_APP}" >&2
  exit 1
fi

echo "Installing ${PRODUCT_APP} to ${DEST_DIR}..."
if [[ -d "$DEST_APP" ]]; then
  rm -rf "$DEST_APP"
fi
cp -R "$APP_PATH" "$DEST_DIR/"

# Clear quarantine if the attribute exists, then ask Launch Services to index it.
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST_APP" 2>/dev/null || true

echo "Installed: ${DEST_APP}"
echo "Raycast/Spotlight should now be able to find '${APP_NAME}'. If it does not appear immediately, restart Raycast or reindex Applications."
