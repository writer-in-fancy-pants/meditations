#!/usr/bin/env bash
# Runs the full Muse pipeline natively (no Docker):
#   1. Ensures a local Python venv exists (created/managed via `uv`)
#   2. Discovers the first OpenMuse BLE device and starts streaming
#   3. Waits until the stream reports it's live
#   4. Starts lsl_bridge.py (websocket server)
#   5. Serves the frontend (html/js) over HTTP
#
# Usage: ./run.sh
set -euo pipefail

RECORD_PREFIX="$1"

# ============================================================================
# Config — ports and paths
# ============================================================================
FRONTEND_PORT="${FRONTEND_PORT:-9001}"
WS_PORT="${WS_PORT:-8765}"

RECORD_PATH="${RECORD_PATH:-$(pwd)/data/${RECORD_PREFIX}}"
PRESET="${PRESET:-p1045}"
STREAM_WAIT_TIMEOUT="${STREAM_WAIT_TIMEOUT:-60}"   # seconds

VENV_DIR="${VENV_DIR:-.venv}"
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/athena"
FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS_FILE="./requirements.txt"

log() { echo "[run.sh] $*"; }

# ============================================================================
# 1. Ensure Python + venv (via uv) are set up
# ============================================================================
create_uv_env() {
    local env_dir="${1:-.venv}"
    local python_version="${2:-}"  # optional, e.g. "3.11"

    # --- Detect platform ---
    local os_name
    os_name="$(uname -s)"
    local arch
    arch="$(uname -m)"

    local platform=""
    case "$os_name" in
        Linux*)
            if grep -qi microsoft /proc/version 2>/dev/null; then
                platform="wsl"
            else
                platform="linux"
            fi
            ;;
        Darwin*)
            platform="macos"
            ;;
        CYGWIN*|MINGW*|MSYS*|Windows_NT)
            platform="windows"
            ;;
        *)
            platform="unknown"
            ;;
    esac

    echo "Detected OS: $os_name"
    echo "Detected arch: $arch"
    echo "Platform: $platform"

    # --- Ensure uv is installed ---
    if ! command -v uv >/dev/null 2>&1; then
        echo "uv not found. Installing..."
        case "$platform" in
            linux|wsl|macos)
                curl -LsSf https://astral.sh/uv/install.sh | sh
                # uv installs to ~/.local/bin or ~/.cargo/bin depending on version
                export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
                ;;
            windows)
                echo "On native Windows, run this in PowerShell instead:"
                echo '  irm https://astral.sh/uv/install.ps1 | iex'
                return 1
                ;;
            *)
                echo "Unsupported platform: $platform"
                return 1
                ;;
        esac
    fi

    if ! command -v uv >/dev/null 2>&1; then
        echo "uv installation failed or not on PATH."
        return 1
    fi

    echo "uv version: $(uv --version)"

    # --- Create the virtual environment ---
    local uv_args=(venv "$env_dir")
    if [[ -n "$python_version" ]]; then
        uv_args+=(--python "$python_version")
    fi

    echo "Creating venv at '$env_dir'${python_version:+ with Python $python_version}..."
    uv "${uv_args[@]}"

    if [[ $? -eq 0 ]]; then
        echo "Done. Activate with:"
        case "$platform" in
            windows) echo "  source $env_dir/Scripts/activate" ;;
            *)       echo "  source $env_dir/bin/activate" ;;
        esac
    else
        echo "Failed to create virtual environment."
        return 1
    fi
}

ensure_python_env() {
    if ! command -v python3 >/dev/null 2>&1; then
        log "python3 not found on PATH."
        log "On macOS: install via 'brew install python' or https://www.python.org/downloads/"
        exit 1
    fi

    if [ -x "$VENV_DIR/bin/python" ]; then
        log "Using existing venv at $VENV_DIR"
    else
        log "Creating venv at $VENV_DIR (via uv)..."
        create_uv_env
    fi

    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"

    if [ -f "$REQUIREMENTS_FILE" ]; then
        log "Syncing dependencies from $REQUIREMENTS_FILE..."
        uv pip install -r "$REQUIREMENTS_FILE"
    else
        log "WARNING: $REQUIREMENTS_FILE not found, skipping dependency install."
    fi

    if ! command -v OpenMuse >/dev/null 2>&1; then
        log "ERROR: 'OpenMuse' CLI not found in venv after install."
        log "Check that the OpenMuse package name/source in requirements.txt is correct."
        exit 1
    fi
}

ensure_python_env
PYTHON_BIN="$VENV_DIR/bin/python"

mkdir -p "$(dirname "$RECORD_PATH")"

# ============================================================================
# Cleanup on exit
# ============================================================================
OPENMUSE_PID=""
LSL_PID=""
HTTP_PID=""

cleanup() {
    log "Shutting down..."
    [ -n "$OPENMUSE_PID" ] && kill "$OPENMUSE_PID" 2>/dev/null || true
    [ -n "$LSL_PID" ] && kill "$LSL_PID" 2>/dev/null || true
    [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ============================================================================
# 2. Discover devices and start the OpenMuse stream
# ============================================================================
log "Discovering OpenMuse devices..."
DISCOVERY_OUTPUT="$(OpenMuse find 2>&1)" || {
    log "ERROR: 'OpenMuse find' failed"
    echo "$DISCOVERY_OUTPUT"
    exit 1
}
echo "$DISCOVERY_OUTPUT"

while IFS= read -r line; do
    # Match: Found device <name>, MAC Address <id>
    if [[ "$line" =~ Found\ device\ ([^,]+),\ MAC\ Address\ ([0-9A-Fa-f\-]+) ]]; then
        device_name="${BASH_REMATCH[1]}"
        DEVICE_ADDRESS="${BASH_REMATCH[2]}"

        echo "Detected device: $device_name  MAC: $DEVICE_ADDRESS"
        found_any=1
        # echo "Launching: $python_bin $bridge_script --mac $mac_id"
        # "$python_bin" "$bridge_script" --mac "$mac_id" &
        # pids+=($!)
    fi
done <<< "$DISCOVERY_OUTPUT"

# # NOTE: adjust this if your OpenMuse CLI's `list` output format differs
# # (e.g. prints device IDs/names instead of MAC addresses).
# DEVICE_ADDRESS="$(echo "$DISCOVERY_OUTPUT" | grep -oE '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}' | head -n 1)"

if [ -z "$DEVICE_ADDRESS" ]; then
    log "ERROR: No OpenMuse devices found. Make sure Bluetooth is on and the"
    log "headband is powered on/discoverable, and (on macOS) that Terminal has"
    log "Bluetooth permission in System Settings > Privacy & Security > Bluetooth."
    exit 1
fi
log "Selected device: $DEVICE_ADDRESS"

STREAM_LOG="$(mktemp)"
OpenMuse stream --address "$DEVICE_ADDRESS" --auto-reconnect --preset "$PRESET" > "$STREAM_LOG" &
OPENMUSE_PID=$!
log "Started OpenMuse stream (pid $OPENMUSE_PID), logging to $STREAM_LOG"

# ============================================================================
# 3. Wait until the stream reports it's live
# ============================================================================
# NOTE: adjust the grep pattern below to match whatever OpenMuse actually
# prints when the stream comes up.
log "Waiting for stream to go live (timeout ${STREAM_WAIT_TIMEOUT}s)..."
elapsed=0
stream_live=false
while [ "$elapsed" -lt "$STREAM_WAIT_TIMEOUT" ]; do
    if ! kill -0 "$OPENMUSE_PID" 2>/dev/null; then
        log "ERROR: OpenMuse process exited unexpectedly"
        cat "$STREAM_LOG"
        exit 1
    fi
    # OPENMUSE_LOG_OUTPUT="$(cat "$STREAM_LOG")"
    # echo $OPENMUSE_LOG_OUTPUT
    if [ "$elapsed" -gt 10 ]; then
        stream_live=true
        break
    fi
    # if grep -qiE 'Stream(ing)?[^a-z]*(is[^a-z]*)?live|connected|data' "$STREAM_LOG"; then
    #     stream_live=true
    #     break
    # fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if [ "$stream_live" != true ]; then
    log "ERROR: timed out waiting for OpenMuse stream to go live"
    cat "$STREAM_LOG"
    exit 1
fi
log "OpenMuse stream is live."

# ============================================================================
# 4. Start lsl_bridge.py (websocket)
# ============================================================================
log "Starting lsl_bridge.py on localhost:${WS_PORT}, recording to ${RECORD_PATH}"
"$PYTHON_BIN" "$BACKEND_DIR/lsl_bridge.py" \
    --host localhost \
    --port "$WS_PORT" \
    --record-path "$RECORD_PATH" &
LSL_PID=$!

sleep 2
if ! kill -0 "$LSL_PID" 2>/dev/null; then
    log "ERROR: lsl_bridge.py failed to start"
    exit 1
fi

# ============================================================================
# 5. Serve the frontend
# ============================================================================
log "Serving frontend from $FRONTEND_DIR on localhost:${FRONTEND_PORT}"
(cd "$FRONTEND_DIR" && "$PYTHON_BIN" -m http.server "$FRONTEND_PORT") &
HTTP_PID=$!

log "Ready: frontend at http://localhost:${FRONTEND_PORT}, websocket at ws://localhost:${WS_PORT}"

# ============================================================================
# Supervise: exit if any child process dies
# ============================================================================
wait "$OPENMUSE_PID" "$LSL_PID" "$HTTP_PID"
EXIT_CODE=$?
log "A process exited (code $EXIT_CODE); shutting down"
exit "$EXIT_CODE"