#!/usr/bin/env bash
#
# release-mac.sh - build, sign and notarize the macOS build (DMG + update ZIP).
#
# Produces a Developer ID-signed, Apple-notarized universal build that opens
# without Gatekeeper warnings on any Mac. Designed to run on any macOS machine
# with Xcode Command Line Tools and Node installed - it is NOT tied to a
# particular developer's login keychain: the certificate is imported into a
# throwaway keychain that is removed when the script exits.
#
# electron-builder does the signing, notarization (notarytool) and stapling, and
# emits both the .dmg (manual download) and the .zip + latest-mac.yml that
# electron-updater needs for auto-update.
#
# Required environment variables:
#   MAC_CERT_P12        Path to the "Developer ID Application" certificate (.p12)
#   MAC_CERT_PASSWORD   Password for the .p12
#   APPLE_API_KEY       Path to the App Store Connect API key (.p8)
#   APPLE_API_KEY_ID    Key ID (the LAQQ... part of the AuthKey_<KeyID>.p8 filename)
#   APPLE_API_ISSUER    Issuer ID (UUID from App Store Connect -> Users and Access -> Integrations)
#
# Optional:
#   UPLOAD_RELEASE=1    Publish the artifacts (dmg + zip + latest-mac.yml) to the
#                       matching GitHub release via electron-builder. Requires
#                       GH_TOKEN with repo scope. The release is created as a
#                       draft if it does not exist yet.
#
# Usage:
#   MAC_CERT_P12=~/secrets/devid.p12 MAC_CERT_PASSWORD=... \
#   APPLE_API_KEY=~/secrets/AuthKey_LAQQ7Y8W5T.p8 \
#   APPLE_API_KEY_ID=LAQQ7Y8W5T APPLE_API_ISSUER=... \
#   npm run release:mac
#
set -euo pipefail

log() { printf '\n\033[1;34m> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$*" >&2; exit 1; }

# -- preflight ----------------------------------------------------------------
[[ "$(uname)" == "Darwin" ]] || die "This script must run on macOS."
command -v xcrun    >/dev/null || die "xcrun not found - install Xcode Command Line Tools: xcode-select --install"
command -v security >/dev/null || die "security tool not found (expected on macOS)."
command -v codesign >/dev/null || die "codesign not found - install Xcode Command Line Tools."
command -v node     >/dev/null || die "node not found - install Node.js."

: "${MAC_CERT_P12:?Set MAC_CERT_P12 to the path of the Developer ID Application .p12 certificate}"
: "${MAC_CERT_PASSWORD:?Set MAC_CERT_PASSWORD to the .p12 password}"
: "${APPLE_API_KEY:?Set APPLE_API_KEY to the path of the App Store Connect .p8 key}"
: "${APPLE_API_KEY_ID:?Set APPLE_API_KEY_ID to the API Key ID}"
: "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER to the API Issuer ID}"

[[ -f "$MAC_CERT_P12" ]]  || die "Certificate not found: $MAC_CERT_P12"
[[ -f "$APPLE_API_KEY" ]] || die "API key not found: $APPLE_API_KEY"

cd "$(dirname "$0")/.."
[[ -d node_modules ]] || die "Dependencies not installed - run 'npm ci' first."
VERSION="$(node -p "require('./package.json').version")"
log "Releasing macOS build for v$VERSION"

# -- throwaway keychain -------------------------------------------------------
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/release.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
# Capture the current user keychain search list, preserving paths with spaces.
ORIG_KEYCHAINS=()
while IFS= read -r _kc; do
  _kc="${_kc#"${_kc%%[![:space:]]*}"}"   # ltrim leading whitespace
  _kc="${_kc#\"}"; _kc="${_kc%\"}"        # strip surrounding quotes
  [[ -n "$_kc" ]] && ORIG_KEYCHAINS+=("$_kc")
done < <(security list-keychains -d user)

cleanup() {
  set +e
  [[ ${#ORIG_KEYCHAINS[@]} -gt 0 ]] && security list-keychains -d user -s "${ORIG_KEYCHAINS[@]}" >/dev/null 2>&1
  [[ -f "$KEYCHAIN" ]] && security delete-keychain "$KEYCHAIN" >/dev/null 2>&1
  rm -rf "$KEYCHAIN_DIR" >/dev/null 2>&1
}
trap cleanup EXIT

log "Creating a temporary signing keychain"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"   # keep unlocked for the long notarization wait
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$MAC_CERT_P12" -k "$KEYCHAIN" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S "apple-tool:,apple:,codesign:" -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" "${ORIG_KEYCHAINS[@]}"

# Resolve the identity as its 40-char SHA-1 hash: unambiguous and prefix-proof.
IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk '/Developer ID Application/ {print $2; exit}')"
[[ -n "$IDENTITY" ]] || die "No 'Developer ID Application' identity found in $MAC_CERT_P12"
log "Signing identity: $IDENTITY"

# -- clean stale output -------------------------------------------------------
log "Cleaning previous build artifacts"
rm -rf dist/mac-universal dist/mac-universal-*-temp
rm -f dist/*.dmg dist/*.dmg.blockmap dist/*.zip dist/*.zip.blockmap dist/latest-mac.yml

# -- build + sign + notarize + (optional) publish -----------------------------
PUBLISH_FLAG="never"
if [[ "${UPLOAD_RELEASE:-}" == "1" || "${PUBLISH:-}" == "always" ]]; then
  : "${GH_TOKEN:?Set GH_TOKEN (repo scope) to publish to GitHub Releases}"
  PUBLISH_FLAG="always"
  log "Publishing to GitHub Releases is ENABLED"
fi

log "Building, signing and notarizing (electron-builder)"
export CSC_KEYCHAIN="$KEYCHAIN"
# @electron/notarize (notarytool) reads APPLE_API_KEY / APPLE_API_KEY_ID /
# APPLE_API_ISSUER from the environment - already exported above.
npm run build
# --no-install: use the repo-pinned binary; never silently download a different one.
npx --no-install electron-builder --mac \
  --publish "$PUBLISH_FLAG" \
  --config.mac.identity="$IDENTITY" \
  --config.mac.notarize=true

# Select the DMG deterministically: expect exactly one (dist/ was cleaned above).
shopt -s nullglob
DMG_FILES=(dist/*.dmg)
shopt -u nullglob
[[ ${#DMG_FILES[@]} -eq 1 ]] || die "Expected exactly one DMG in dist/, found ${#DMG_FILES[@]}: ${DMG_FILES[*]:-none}"
DMG="${DMG_FILES[0]}"
log "Built: $DMG"

# -- verify -------------------------------------------------------------------
log "Verifying the signed app"
APP_PATH="$(find dist -maxdepth 2 -name '*.app' -type d | head -1)"
[[ -n "$APP_PATH" ]] || die "No .app found in dist/ to verify."
codesign --verify --deep --strict --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl -a -vvv -t execute "$APP_PATH"

log "Done: $DMG (signed + notarized + stapled)"
if [[ "$PUBLISH_FLAG" == "always" ]]; then
  log "Artifacts (dmg + zip + latest-mac.yml) uploaded to the v$VERSION GitHub release."
fi
