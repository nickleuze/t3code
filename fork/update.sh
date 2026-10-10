#!/usr/bin/env bash
# Fork-only: installs the newest fork release (built by .github/workflows/
# fork-release.yml) as "T3 Code (Alpha).app" on this Mac.
#
# The foreground part downloads and verifies the release, then hands the swap
# to a launchd job so it survives Alpha quitting. That job waits until no
# agent turn is running (so an update started from a T3 thread lets that turn
# finish), quits Alpha, keeps a backup, installs, relaunches, and rolls back
# if the new app does not start.
#
# Usage: fork/update.sh [--check] [--force] [--wait-mins N] [--version V] [--commit SHA]
#   --check       only report whether an update is available
#   --force       swap even if turns are still running after the wait
#   --wait-mins   how long to wait for running turns (default 60)
#   --version     install this fork version instead of the latest
#   --commit      require this exact release commit (requires --version)
set -euo pipefail
# Shell setups can wrap rm (one on the mini routes it to the Trash, which
# frees no space); "command rm" below always means the real one.

REPO="${T3_FORK_REPO:-nickleuze/t3code}"
APP="/Applications/T3 Code (Alpha).app"
DB="$HOME/.t3/userdata/statev2.sqlite"
WORK="$HOME/.t3/fork-update"
BACKUPS="$HOME/.t3/deploy-backups"
LABEL="com.nickleuze.t3-fork-update"
CHECK_ONLY=0
FORCE=0
WAIT_MINS=60
VERSION=""
EXPECTED_COMMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
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
command rm -rf "$stage" && mkdir -p "$stage"
if ! ditto -x -k "$WORK/$zip" "$stage" || [ ! -d "$stage/T3 Code (Alpha).app" ]; then
  command rm -rf "$stage" "$WORK/$zip"
  say "Could not unpack $zip; nothing was changed."
  exit 1
fi
command rm -f "$WORK/$zip"

backup="$BACKUPS/fork-update-$(date +%Y%m%d-%H%M%S)-from-$installed"
installer="$WORK/install-$target.sh"
cat > "$installer" <<INSTALLER
#!/bin/bash
set -u
APP="$APP"
STAGE="$stage"
BACKUP="$backup"
DB="$DB"
TARGET="$target"
FORCE=$FORCE
WAIT_SECS=\$(( $WAIT_MINS * 60 ))
exec >> "$WORK/update.log" 2>&1
# launchctl submit restarts failed jobs; one attempt is all this should get.
trap 'launchctl remove "$LABEL" 2>/dev/null' EXIT
log() { printf '[%s] %s\n' "\$(date '+%F %T')" "\$*"; }
# Fixed-string match: "(Alpha)" in a pgrep pattern is a regex group.
alpha_running() { ps -axo comm= | grep -qxF "\$APP/Contents/MacOS/T3 Code (Alpha)"; }
# The app's main process (launched by launchd); its helper workers share the
# executable but are its children.
alpha_main_pid() {
  ps -axo pid=,ppid=,comm= | while read -r pid ppid comm; do
    [ "\$comm" = "\$APP/Contents/MacOS/T3 Code (Alpha)" ] && [ "\$ppid" = 1 ] && echo "\$pid"
  done
}
descendants() {
  for child in \$(ps -axo pid=,ppid= | awk -v parent="\$1" '\$2 == parent { print \$1 }'); do
    echo "\$child"; descendants "\$child"
  done
}
active_turns() {
  sqlite3 -readonly "\$DB" "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting')" 2>/dev/null || echo 0
}
log "Installing fork \$TARGET"
# Let a reply that started this update finish before checking for work.
sleep 15
waited=0
while [ "\$(active_turns)" != "0" ] && [ "\$waited" -lt "\$WAIT_SECS" ]; do
  [ \$(( waited % 300 )) -eq 0 ] && log "Waiting for \$(active_turns) running turn(s) to finish"
  sleep 20; waited=\$(( waited + 20 ))
done
if [ "\$(active_turns)" != "0" ] && [ "\$FORCE" != 1 ]; then
  log "ABORTED: turns still running after \$(( WAIT_SECS / 60 )) min; nothing was changed. Rerun with --force to interrupt them."
  exit 1
fi
log "Quitting Alpha"
# SIGTERM runs the app's normal shutdown. AppleEvents would need an
# Automation permission prompt that nobody answers on a headless machine.
for pid in \$(alpha_main_pid); do kill -TERM "\$pid" 2>/dev/null || true; done
for i in \$(seq 1 60); do alpha_running || break; sleep 1; done
if alpha_running; then
  # A shutdown that stalls leaves the app ignoring further quit requests. No
  # turn is running at this point, so stopping its processes loses no work.
  log "Shutdown did not finish within 60s; force-quitting Alpha"
  for pid in \$(alpha_main_pid); do
    kill -KILL \$(descendants "\$pid") "\$pid" 2>/dev/null || true
  done
  for i in \$(seq 1 15); do alpha_running || break; sleep 1; done
fi
if alpha_running; then log "FAILED: Alpha is still running; nothing was changed."; exit 1; fi
mkdir -p "\$BACKUP"
mv "\$APP" "\$BACKUP/" || { log "FAILED: could not move the current app"; open "\$APP"; exit 1; }
if ! ditto "\$STAGE/T3 Code (Alpha).app" "\$APP"; then
  log "FAILED: install failed; restoring the previous app"
  command rm -rf "\$APP"; mv "\$BACKUP/T3 Code (Alpha).app" "\$APP"; open "\$APP"; exit 1
fi
xattr -dr com.apple.quarantine "\$APP" 2>/dev/null || true
open "\$APP"
# A freshly installed bundle can take ~40s to start while macOS verifies it.
for i in \$(seq 1 120); do alpha_running && break; sleep 1; done
if alpha_running; then
  log "INSTALLED: fork \$TARGET. Previous app: \$BACKUP"
  command rm -rf "\$STAGE"
  # Keep the three most recent fork-update backups.
  ls -dt "$BACKUPS"/fork-update-* 2>/dev/null | tail -n +4 | while read -r old; do command rm -rf "\$old"; done
else
  log "FAILED: the new app did not start; restoring the previous app"
  command rm -rf "\$APP"; mv "\$BACKUP/T3 Code (Alpha).app" "\$APP"; open "\$APP"
fi
INSTALLER
chmod +x "$installer"

busy="$(sqlite3 -readonly "$DB" "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting')" 2>/dev/null || echo 0)"
launchctl remove "$LABEL" 2>/dev/null || true
launchctl submit -l "$LABEL" -- /bin/bash "$installer"
if [ "$busy" = "0" ]; then
  say "Installing $target now; Alpha restarts in about 15s. Log: $WORK/update.log"
else
  say "Installing $target once $busy running turn(s) finish (waiting up to $WAIT_MINS min). Log: $WORK/update.log"
fi
