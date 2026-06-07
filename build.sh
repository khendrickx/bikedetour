#!/usr/bin/env bash
# build.sh — Packages the extension for Chrome and Firefox.
#
# Output:
#   dist/chrome/              unpacked Chrome extension (load as unpacked in Chrome)
#   dist/firefox/             unpacked Firefox extension (load as temporary add-on)
#   dist/bikedetour-chrome.zip   submit to Chrome Web Store
#   dist/bikedetour-firefox.zip  submit to Firefox Add-on Hub (AMO)
#
# Usage:
#   ./build.sh
#   ./build.sh clean   — remove dist/ before building

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/extension"
FIREFOX_MANIFEST="$ROOT/extension-firefox/manifest.json"
DIST="$ROOT/dist"

if [[ "${1:-}" == "clean" ]]; then
  echo "Cleaning dist/..."
  rm -rf "$DIST"
fi

mkdir -p "$DIST/chrome" "$DIST/firefox"

# ── Chrome ────────────────────────────────────────────────────────────────────
echo "Building Chrome extension..."
cp -r "$SRC"/. "$DIST/chrome/"

# ── Firefox ───────────────────────────────────────────────────────────────────
echo "Building Firefox extension..."
cp -r "$SRC"/. "$DIST/firefox/"
# Replace manifest with Firefox-specific version
cp "$FIREFOX_MANIFEST" "$DIST/firefox/manifest.json"

# ── Zip archives ──────────────────────────────────────────────────────────────
echo "Zipping..."
(cd "$DIST/chrome"   && zip -qr "../bikedetour-chrome.zip"   . --exclude "*/.DS_Store" --exclude ".DS_Store")
(cd "$DIST/firefox"  && zip -qr "../bikedetour-firefox.zip"  . --exclude "*/.DS_Store" --exclude ".DS_Store")

echo ""
echo "Done."
echo "  dist/chrome/                    — load as unpacked extension in Chrome"
echo "  dist/firefox/                   — load as temporary add-on in Firefox"
echo "  dist/bikedetour-chrome.zip  — Chrome Web Store submission"
echo "  dist/bikedetour-firefox.zip — AMO (addons.mozilla.org) submission"
