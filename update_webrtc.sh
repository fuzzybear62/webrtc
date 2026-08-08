#!/usr/bin/env bash
#
# update_webrtc.sh — update the webrtc integration on Home Assistant
# from the public GitHub repo.
#
# Run this in the Home Assistant terminal (SSH/Terminal add-on).
# Place it at /root/config/update_webrtc.sh and run:  bash update_webrtc.sh
#
# Options:
#   --no-restart   Deploy the files but do not restart HA Core.
#   --no-backup    Skip the timestamped backup of the current install.
#   --rollback     Restore the most recent backup instead of updating.
#
set -euo pipefail

REPO_URL="https://github.com/fuzzybear62/webrtc.git"
CONFIG_DIR="/root/config"
DEST="${CONFIG_DIR}/custom_components/webrtc"
SRC="${CONFIG_DIR}/.webrtc_src"          # persistent clone, reused across updates
SUBPATH="custom_components/webrtc"        # integration path inside the repo
BAK_GLOB="${CONFIG_DIR}/webrtc.bak.*"

DO_RESTART=1
DO_BACKUP=1
DO_ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) DO_RESTART=0 ;;
    --no-backup)  DO_BACKUP=0 ;;
    --rollback)   DO_ROLLBACK=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[update_webrtc] $*"; }

restart_ha() {
  if [ "${DO_RESTART}" -eq 1 ]; then
    if command -v ha >/dev/null 2>&1; then
      log "Restarting Home Assistant Core..."
      ha core restart
    else
      log "'ha' CLI not available — restart Home Assistant manually to load the change."
    fi
  else
    log "Skipping restart (--no-restart). Restart HA manually to load the change."
  fi
}

# --rollback: restore the most recent backup and exit.
if [ "${DO_ROLLBACK}" -eq 1 ]; then
  # shellcheck disable=SC2086
  LATEST_BAK="$(ls -1d ${BAK_GLOB} 2>/dev/null | sort | tail -n 1 || true)"
  if [ -z "${LATEST_BAK}" ] || [ ! -d "${LATEST_BAK}" ]; then
    log "ERROR: no backup found matching ${BAK_GLOB} — nothing to roll back to." >&2
    exit 1
  fi
  if [ ! -f "${LATEST_BAK}/manifest.json" ]; then
    log "ERROR: ${LATEST_BAK} does not look like a valid install (no manifest.json) — aborting." >&2
    exit 1
  fi
  log "Rolling back ${DEST} from ${LATEST_BAK}"
  rm -rf "${DEST}"
  mkdir -p "$(dirname "${DEST}")"
  cp -r "${LATEST_BAK}" "${DEST}"
  find "${DEST}" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
  log "Rollback complete."
  restart_ha
  exit 0
fi

# 0. Ensure git is available (Alpine-based add-on).
if ! command -v git >/dev/null 2>&1; then
  log "git not found, installing..."
  apk add --no-cache git >/dev/null
fi

# 1. Fetch latest sources into a persistent side clone.
if [ -d "${SRC}/.git" ]; then
  log "Updating existing clone at ${SRC}"
  git -C "${SRC}" fetch --depth 1 origin main
  git -C "${SRC}" reset --hard origin/main
else
  log "Cloning ${REPO_URL} into ${SRC}"
  rm -rf "${SRC}"
  git clone --depth 1 "${REPO_URL}" "${SRC}"
fi

NEW_SRC="${SRC}/${SUBPATH}"
if [ ! -f "${NEW_SRC}/manifest.json" ]; then
  log "ERROR: ${NEW_SRC}/manifest.json missing — aborting, nothing changed." >&2
  exit 1
fi
COMMIT="$(git -C "${SRC}" rev-parse --short HEAD)"

# 2. Backup the current install.
if [ "${DO_BACKUP}" -eq 1 ] && [ -d "${DEST}" ]; then
  BAK="${CONFIG_DIR}/webrtc.bak.$(date +%Y%m%d-%H%M%S)"
  log "Backing up current install to ${BAK}"
  cp -r "${DEST}" "${BAK}"
fi

# 3. Replace the integration with the fresh copy.
log "Deploying ${SUBPATH}@${COMMIT} to ${DEST}"
rm -rf "${DEST}"
mkdir -p "$(dirname "${DEST}")"
cp -r "${NEW_SRC}" "${DEST}"

# 4. Remove stale bytecode.
find "${DEST}" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true

log "Deployed webrtc @ ${COMMIT}"
log "Note: the frontend card is cache-busted by the manifest version (?v=), so"
log "      a browser refresh picks up the new webrtc-camera.js automatically."

# 5. Restart HA Core.
restart_ha
