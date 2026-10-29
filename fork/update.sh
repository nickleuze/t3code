#!/usr/bin/env bash
# Fork-only: installs the newest fork release (built by .github/workflows/
# fork-release.yml) as "T3 Code (Alpha).app" on this Mac.
#
# The foreground part downloads and verifies the release, then hands the swap
# to a launchd job so it survives Alpha quitting. That job waits until no
# agent turn is running (so an update started from a T3 thread lets that turn
# finish), quits Alpha normally, keeps a backup, installs, relaunches, and rolls
# back if the new app does not start. Removals go to the Trash and every backup
# is kept, so each step can be undone by hand.
#
# Usage: fork/update.sh [--check] [--stage-only] [--force] [--wait-mins N] [--version V] [--commit SHA]
#   --check       only report whether an update is available
#   --stage-only  download, verify and unpack, then print the install command
#                 (so the staged app can be checked before it is installed)
#   --force       swap even if turns are still running after the wait
#   --wait-mins   how long to wait for running turns (default 60)
#   --version     install this fork version instead of the latest
#   --commit      require this exact release commit (requires --version)
set -euo pipefail

REPO="${T3_FORK_REPO:-nickleuze/t3code}"
APP="/Applications/T3 Code (Alpha).app"
DB="$HOME/.t3/userdata/statev2.sqlite"
WORK="$HOME/.t3/fork-update"
BACKUPS="$HOME/.t3/deploy-backups"
LABEL="com.nickleuze.t3-fork-update"
CHECK_ONLY=0
STAGE_ONLY=0
FORCE=0
WAIT_MINS=60
VERSION=""
EXPECTED_COMMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --stage-only) STAGE_ONLY=1 ;;
    --force) FORCE=1 ;;
    --wait-mins) WAIT_MINS="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --commit) EXPECTED_COMMIT="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

if [ -n "$EXPECTED_COMMIT" ] && [ -z "$VERSION" ]; then
  echo "--commit requires --version" >&2
  exit 64
fi

host="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
say() { printf '[%s] %s\n' "$host" "$*"; }
json_field() { plutil -extract "$2" raw -o - "$1"; }
active_turns() {
  local count
  count="$(sqlite3 -readonly "$DB" "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting')" 2>/dev/null)" || return 1
  case "$count" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$count"
}

mkdir -p "$WORK"
if [ -n "$VERSION" ]; then
  release_url="https://github.com/$REPO/releases/download/fork-v$VERSION"
else
  release_url="https://github.com/$REPO/releases/latest/download"
fi
curl -fsSL --connect-timeout 20 "$release_url/fork-release.json" -o "$WORK/fork-release.json" \
  || { say "No fork release found at $release_url"; exit 1; }
target="$(json_field "$WORK/fork-release.json" version)"
commit="$(json_field "$WORK/fork-release.json" commit)"
if { [ -n "$VERSION" ] && [ "$target" != "$VERSION" ]; } || \
   { [ -n "$EXPECTED_COMMIT" ] && [ "$commit" != "$EXPECTED_COMMIT" ]; }; then
  say "Release identity mismatch; nothing was changed."
  exit 1
fi
zip="$(json_field "$WORK/fork-release.json" zip)"
sha256="$(json_field "$WORK/fork-release.json" sha256)"
installed="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>/dev/null || echo none)"

if [ "$installed" = "$target" ]; then
  say "Up to date: $installed (${commit:0:10})"
  exit 0
fi
say "Update available: $installed -> $target (${commit:0:10})"
[ "$CHECK_ONLY" = 1 ] && exit 0

busy="$(active_turns)" || { say "Cannot verify active turns; nothing was changed."; exit 1; }
# /usr/bin/trash ships with macOS 15.
command -v trash >/dev/null || { say "The trash command is unavailable; nothing was changed."; exit 1; }

# The zip and its unpacked copy take about 600 MB until the swap.
free_kb="$(df -k "$HOME" | awk 'NR == 2 { print $4 }')"
if [ "${free_kb:-0}" -lt $(( 1536 * 1024 )) ]; then
  say "Only $(( ${free_kb:-0} / 1024 )) MB free; an update needs about 1.5 GB. Nothing was changed."
  exit 1
fi

say "Downloading $zip"
progress=-sS
[ -t 1 ] && progress=--progress-bar
curl -fL --connect-timeout 20 "$progress" "https://github.com/$REPO/releases/download/fork-v$target/$zip" -o "$WORK/$zip"
actual="$(shasum -a 256 "$WORK/$zip" | cut -d' ' -f1)"
if [ "$actual" != "$sha256" ]; then
  say "Checksum mismatch for $zip; nothing was changed."
  exit 1
fi
stage="$WORK/staged-$target"
if [ -e "$stage" ] && ! trash "$stage"; then
  say "Could not move the previous $stage to the Trash; nothing was changed."
  exit 1
fi
mkdir -p "$stage"
# The release bundle is named after the product, which upstream renames; it is
# installed at $APP, where the built-in updater also keeps it.
ditto -x -k "$WORK/$zip" "$stage" && staged_apps=("$stage"/*.app) || staged_apps=()
if [ "${#staged_apps[@]}" -ne 1 ] || [ ! -d "${staged_apps[0]}" ]; then
  trash "$stage" "$WORK/$zip" || true
  say "Could not unpack $zip; nothing was changed."
  exit 1
fi
trash "$WORK/$zip" || say "Could not move $WORK/$zip to the Trash"

installer="$WORK/install-$target.sh"
cat > "$installer" <<INSTALLER
#!/bin/bash
set -u
APP="$APP"
STAGE="$stage"
STAGED_APP="${staged_apps[0]}"
BACKUPS="$BACKUPS"
DB="$DB"
TARGET="$target"
# The version this update was staged against; anything else aborts the install.
FROM="$installed"
FORCE=$FORCE
WAIT_SECS=\$(( $WAIT_MINS * 60 ))
exec >> "$WORK/update.log" 2>&1
# launchctl submit restarts failed jobs; one attempt is all this should get.
trap 'launchctl remove "$LABEL" 2>/dev/null' EXIT
log() { printf '[%s] %s\n' "\$(date '+%F %T')" "\$*"; }
plist_field() { plutil -extract "\$2" raw -o - "\$1/Contents/Info.plist" 2>/dev/null; }
# Any executable in Contents/MacOS, since upstream renames change its name.
alpha_running() { ps -axo comm= | awk -v p="\$APP/Contents/MacOS/" 'index(\$0, p) == 1 { f = 1 } END { exit !f }'; }
# Moves a failed new app to the Trash and puts the previous one back.
restore() {
  log "FAILED: \$1; restoring the previous app"
  if [ -e "\$APP" ] && ! trash "\$APP"; then
    log "FAILED: could not move the new app to the Trash; previous app kept at \$BACKUP"
  elif mv "\$BACKUP/\$(basename "\$APP")" "\$APP"; then
    open "\$APP"
  else
    log "FAILED: could not restore the previous app; it is kept at \$BACKUP"
  fi
  exit 1
}
$(declare -f active_turns)
log "Installing fork \$TARGET"
# Let a reply that started this update finish before checking for work.
sleep 15
waited=0
busy="\$(active_turns)" || { log "ABORTED: cannot verify active turns; nothing was changed."; exit 1; }
while [ "\$busy" != "0" ] && [ "\$waited" -lt "\$WAIT_SECS" ]; do
  [ \$(( waited % 300 )) -eq 0 ] && log "Waiting for \$busy running turn(s) to finish"
  sleep 20; waited=\$(( waited + 20 ))
  busy="\$(active_turns)" || { log "ABORTED: cannot verify active turns; nothing was changed."; exit 1; }
done
if [ "\$busy" != "0" ] && [ "\$FORCE" != 1 ]; then
  log "ABORTED: turns still running after \$(( WAIT_SECS / 60 )) min; nothing was changed. Rerun with --force to interrupt them."
  exit 1
fi
# Everything that can stop the install is checked before Alpha quits.
current="\$(plist_field "\$APP" CFBundleShortVersionString || echo none)"
if [ "\$current" != "\$FROM" ]; then
  log "ABORTED: installed app is \$current, but this update was staged against \$FROM; nothing was changed."
  exit 1
fi
staged="\$(plist_field "\$STAGED_APP" CFBundleShortVersionString || echo unreadable)"
if [ "\$staged" != "\$TARGET" ]; then
  log "ABORTED: staged app is \$staged, expected \$TARGET; nothing was changed."
  exit 1
fi
bundle_id="\$(plist_field "\$APP" CFBundleIdentifier)" || { log "ABORTED: cannot read the app's bundle identifier; nothing was changed."; exit 1; }
command -v trash >/dev/null || { log "ABORTED: the trash command is unavailable; nothing was changed."; exit 1; }
log "Quitting Alpha"
# A normal Quit runs the app's own shutdown. If it fails (no Automation
# permission on a headless Mac, or a shutdown that stalls), the update stops
# rather than killing processes; forcing it would not fix the stall. An app
# that does not answer Apple events at all fails after 30s instead of 2 min.
quit_ok=1
if alpha_running; then
  if osascript -e 'with timeout of 30 seconds' -e "tell application id \"\$bundle_id\" to quit" -e 'end timeout'; then
    for i in \$(seq 1 60); do alpha_running || break; sleep 1; done
  else
    quit_ok=0
  fi
fi
if [ "\$quit_ok" != 1 ] || alpha_running; then
  alpha_running || open "\$APP"
  # A Keychain prompt that nobody sees blocks Alpha's main process, so it
  # cannot quit until someone answers it on the Mac's screen.
  if pgrep -x SecurityAgent >/dev/null; then
    log "A macOS security prompt is waiting on this Mac's screen (SecurityAgent), likely Keychain access for Alpha. Answer it (Always Allow), then rerun the update."
  fi
  log "ABORTED: Alpha did not quit normally; nothing was changed."
  exit 1
fi
# Name the backup after the app that is actually moved.
if [ "\$(plist_field "\$APP" CFBundleShortVersionString)" != "\$FROM" ]; then
  open "\$APP"
  log "ABORTED: the installed app changed while Alpha quit; nothing was changed."
  exit 1
fi
BACKUP="\$BACKUPS/fork-update-\$(date +%Y%m%d-%H%M%S)-from-\$FROM"
mkdir -p "\$BACKUP"
mv "\$APP" "\$BACKUP/" || { log "FAILED: could not move the current app; nothing was changed."; open "\$APP"; exit 1; }
ditto "\$STAGED_APP" "\$APP" || restore "install failed"
xattr -dr com.apple.quarantine "\$APP" 2>/dev/null || true
open "\$APP"
# A freshly installed bundle can take ~40s to start while macOS verifies it.
for i in \$(seq 1 120); do alpha_running && break; sleep 1; done
alpha_running || restore "the new app did not start"
log "INSTALLED: fork \$TARGET. Previous app: \$BACKUP"
trash "\$STAGE" || log "Could not move \$STAGE to the Trash"
INSTALLER
chmod +x "$installer"

if [ "$STAGE_ONLY" = 1 ]; then
  say "Staged $target at $stage; nothing was installed."
  say "Install with: launchctl submit -l $LABEL -- /bin/bash \"$installer\""
  exit 0
fi
launchctl remove "$LABEL" 2>/dev/null || true
launchctl submit -l "$LABEL" -- /bin/bash "$installer"
if [ "$busy" = "0" ]; then
  say "Installing $target now; Alpha restarts in about 15s. Log: $WORK/update.log"
else
  say "Installing $target once $busy running turn(s) finish (waiting up to $WAIT_MINS min). Log: $WORK/update.log"
fi
