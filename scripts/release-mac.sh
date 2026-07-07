#!/usr/bin/env bash
#
# release-mac.sh - build, sign and notarize the macOS build (DMG + update ZIP),
# then upload it to the GitHub Release for the current version.
#
# Clean multi-platform flow (shared with scripts/release-win.ps1):
#   electron-builder only BUILDS (--publish never); this script then uploads the
#   artifacts to a single release identified by its ID. The release is resolved
#   from the /releases LIST (which matches DRAFT releases too), not the by-tag
#   endpoint (which 404s on drafts). That is what previously made electron-builder
#   create a second draft when it couldn't find the existing one by tag. Uploading
#   by ID means mac + Windows land on the SAME release with no duplicates.
#
# Required env: MAC_CERT_P12, MAC_CERT_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID,
#   APPLE_API_ISSUER.
# Optional: UPLOAD_RELEASE=1 (+ GH_TOKEN with repo scope) to upload to the release.
#
# Release flow (see README):
#   1. bump version, tag vX.Y.Z, push
#   2. UPLOAD_RELEASE=1 GH_TOKEN=... <apple env> npm run release:mac
#   3. run scripts/release-win.ps1 on a Windows host (e.g. ts1-core-dev04)
#   4. review, then: gh release edit vX.Y.Z --draft=false --latest
#   (Steps 2 and 3 may run in any order, even in parallel, IF the release was
#    pre-created: gh release create vX.Y.Z --draft ... )
set -euo pipefail

REPO="Alexandr-Kravchuk/github-pr-manager"
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
TAG="v$VERSION"
log "Releasing macOS build for $TAG"

# -- throwaway keychain -------------------------------------------------------
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/release.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
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

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk '/Developer ID Application/ {print $2; exit}')"
[[ -n "$IDENTITY" ]] || die "No 'Developer ID Application' identity found in $MAC_CERT_P12"
log "Signing identity: $IDENTITY"

# -- clean stale output -------------------------------------------------------
log "Cleaning previous build artifacts"
rm -rf dist/mac-universal dist/mac-universal-*-temp
rm -f dist/*.dmg dist/*.dmg.blockmap dist/*.zip dist/*.zip.blockmap dist/latest-mac.yml

# -- build + sign + notarize (NO publish) -------------------------------------
# @electron/notarize (notarytool) reads APPLE_API_KEY / APPLE_API_KEY_ID /
# APPLE_API_ISSUER from the environment. --publish never still emits
# latest-mac.yml (the update feed); we upload it ourselves below.
log "Building, signing and notarizing (electron-builder, no publish)"
export CSC_KEYCHAIN="$KEYCHAIN"
npm run build
npx --no-install electron-builder --mac \
  --publish never \
  --config.mac.identity="$IDENTITY" \
  --config.mac.notarize=true

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
log "Signed + notarized + stapled: $DMG"

# -- upload to the GitHub release (by ID, draft-aware) ------------------------
if [[ "${UPLOAD_RELEASE:-}" == "1" ]]; then
  : "${GH_TOKEN:?Set GH_TOKEN (repo scope) to upload to the release}"
  command -v gh >/dev/null || die "gh CLI not found - install it or upload manually."

  # Resolve the release by tag from the LIST (matches drafts, unlike the by-tag
  # endpoint); retry a few times to ride out the brief lag before a freshly
  # created draft shows up in the list. Create a draft only if truly absent.
  RELID=""
  for _ in 1 2 3 4 5; do
    RELID="$(gh api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name==\"$TAG\") | .id" | head -1)"
    [[ -n "$RELID" ]] && break
    sleep 3
  done
  if [[ -z "$RELID" ]]; then
    log "No release for $TAG yet - creating a draft with auto-generated notes"
    RELID="$(gh api --method POST "repos/$REPO/releases" -f tag_name="$TAG" -f name="$VERSION" -F draft=true -F generate_release_notes=true --jq '.id')"
  fi
  log "Uploading macOS assets to release $TAG (id $RELID)"

  upload_asset() {
    local file="$1" name ct existing
    name="$(basename "$file" | tr ' ' '-')"   # GitHub asset names have no spaces; matches latest-mac.yml urls
    ct="application/octet-stream"; [[ "$name" == *.yml ]] && ct="text/yaml"
    existing="$(gh api "repos/$REPO/releases/$RELID/assets" --jq ".[] | select(.name==\"$name\") | .id")"
    [[ -n "$existing" ]] && gh api --method DELETE "repos/$REPO/releases/assets/$existing" >/dev/null 2>&1 || true
    curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: $ct" \
      --data-binary @"$file" \
      "https://uploads.github.com/repos/$REPO/releases/$RELID/assets?name=$name" \
      -o /dev/null -w "  $name: HTTP %{http_code}\n"
  }

  shopt -s nullglob
  for f in dist/*.dmg dist/*.dmg.blockmap dist/*.zip dist/*.zip.blockmap dist/latest-mac.yml; do
    upload_asset "$f"
  done
  shopt -u nullglob

  log "macOS assets uploaded to $TAG. After Windows is uploaded too, publish with:"
  log "  gh release edit $TAG --draft=false --latest"
fi
