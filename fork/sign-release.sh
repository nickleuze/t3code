#!/usr/bin/env bash
# Fork-only: re-signs the app inside a release zip with the fork's own
# self-signed certificate, in place.
#
# Ad-hoc signed builds look like a different app to macOS after every update,
# so the Keychain asks again before the app may read its "Safe Storage" key,
# and that prompt blocks the app's main process until someone answers it. One
# certificate across builds keeps the app's identity stable: after a single
# "Always Allow" per machine, later builds read the key without a prompt.
#
# Usage: FORK_SIGNING_P12=<path> FORK_SIGNING_P12_PASSWORD=<password> \
#          fork/sign-release.sh <release zip>
set -euo pipefail

[ $# -eq 1 ] || { echo "Usage: $0 <release zip>" >&2; exit 64; }
: "${FORK_SIGNING_P12:?FORK_SIGNING_P12 must point at the signing .p12}"
: "${FORK_SIGNING_P12_PASSWORD:?FORK_SIGNING_P12_PASSWORD must be set}"
zip="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
app_name="T3 Code (Alpha).app"
work="$(mktemp -d)"
keychain="$work/fork-signing.keychain-db"
keychain_password="$(uuidgen)"

# codesign only finds identities in the search list, so the temporary keychain
# joins it for the duration and the original list is put back afterwards.
original_keychains=()
while read -r entry; do
  entry="${entry#\"}"
  original_keychains+=("${entry%\"}")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" || true
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$FORK_SIGNING_P12" -k "$keychain" -P "$FORK_SIGNING_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
# Lets codesign use the key without a Keychain prompt.
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"

# The certificate is self-signed, so it is never "valid" to macOS; codesign
# takes it by hash regardless.
identity="$(security find-identity -p codesigning "$keychain" | awk '$1 ~ /^[0-9]+\)$/ { print $2; exit }')"
[ -n "$identity" ] || { echo "No signing identity in $FORK_SIGNING_P12" >&2; exit 1; }

ditto -x -k "$zip" "$work/unpacked"
app="$work/unpacked/$app_name"
[ -d "$app" ] || { echo "$zip has no $app_name" >&2; exit 1; }
# --deep signs the helper apps and frameworks inside out. No hardened runtime,
# matching the ad-hoc builds, so the bundled native modules keep loading.
codesign --force --deep --timestamp=none --keychain "$keychain" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"
requirement="$(codesign -d -r- "$app" 2>&1)"
if ! grep -qiE "certificate (leaf|root) = H\"$identity\"" <<<"$requirement"; then
  echo "Signed app does not require the fork certificate:" >&2
  echo "$requirement" >&2
  exit 1
fi

rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
echo "Signed $app_name in $(basename "$zip") with certificate $identity"
