#!/usr/bin/env bash
# Builds LightMCP.app (the menu bar controller for this checkout's server) and installs it in
# ~/Applications. The checkout's path and the current `node` are baked into Info.plist as defaults;
# see macos/README.md to override them. Adapted from wing-mcp-server's macos/build-app.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
package="$here/LightMenuBar"
app="$here/build/LightMCP.app"
dest="$HOME/Applications/LightMCP.app"
bundle_id="com.bawaaaaah.light-mcp-menubar"

node_path="$(command -v node || true)"
if [[ -z "$node_path" ]]; then
  echo "node is not on PATH; install it or set nodePath afterwards (see macos/README.md)" >&2
  exit 1
fi
version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"

swift build -c release --package-path "$package"
binary="$(swift build -c release --package-path "$package" --show-bin-path)/LightMenuBar"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/LightMenuBar"

plist="$app/Contents/Info.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>LightMCP</string>
  <key>CFBundleDisplayName</key><string>Light MCP</string>
  <key>CFBundleExecutable</key><string>LightMenuBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Le serveur Light MCP envoie l'Art-Net et le sACN aux nodes DMX du réseau local et les découvre.</string>
</dict>
</plist>
PLIST
plutil -insert LightRepoPath -string "$repo" "$plist"
plutil -insert LightNodePath -string "$node_path" "$plist"

codesign --force --sign - "$app"

# SIGTERM rather than a clean quit: the app does not stop the server that way, and the new copy
# takes the running server back over through data/menubar.pid, so reinstalling does not bounce it.
was_running=false
if pkill -x LightMenuBar; then
  was_running=true
  sleep 1
fi

mkdir -p "$HOME/Applications"
rm -rf "$dest"
cp -R "$app" "$dest"
echo "Installed $dest"

if $was_running; then
  open "$dest"
else
  echo "Start it with: open \"$dest\""
fi
