#!/bin/bash
set -e

LOGDIR=/opt/weflow/data/logs
mkdir -p "$LOGDIR" /opt/weflow/data /root/.config /root/.fluxbox

log() {
  local level=$1; shift
  echo "[$(date '+%m-%d %H:%M:%S')] [$level] [FlowBOT] $*"
}

# Redirect all output to log files for WebUI access
# Add timestamp to lines without one, normalize Logger ISO timestamps
exec > >(while IFS= read -r line; do
  if echo "$line" | grep -qE '^\[[0-9]{2}-[0-9]{2} '; then
    echo "$line" | sed 's/^\[20[0-9][0-9]-\([0-9][0-9]\)-\([0-9][0-9]\)T\([0-9][0-9]\):\([0-9][0-9]\):\([0-9][0-9]\)[^]]*]/[\1-\2 \3:\4:\5]/'
  else
    echo "[$(date '+%m-%d %H:%M:%S')] $line"
  fi
done | tee -a "$LOGDIR/container.log") 2>&1

log INFO "Starting FlowBOT + OneBot container..."
log INFO "Logs: $LOGDIR/container.log"

# Start DBus
log INFO "Starting DBus..."
mkdir -p /run/dbus
rm -f /run/dbus/pid 2>/dev/null || true
dbus-daemon --system --fork 2>/dev/null || true
eval $(dbus-launch --sh-syntax) 2>/dev/null || true

# Generate WebUI login password (scrypt hashed)
WEBUI_PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
node -e "
const crypto = require('crypto');
const fs = require('fs');
const password = process.argv[1];
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
fs.writeFileSync('/opt/weflow/data/webui-auth.json', JSON.stringify({hash, salt, createdAt: new Date().toISOString()}));
" "$WEBUI_PASS"

# Configure fluxbox
cat > /root/.fluxbox/init << 'EOF'
session.screen0.tabs.usePixmap: false
session.screen0.tabs.maxWidth: 200
session.screen0.tabs.useFocus: true
session.screen0.workspaces: 1
EOF
cat > /root/.fluxbox/keys << 'EOF'
OnDesktop Mouse3 :RootMenu
EOF
cat > /root/.fluxbox/menu << 'EOF'
[begin] (FlowBOT)
  [exec] (WeChat) {/opt/wechat/wechat} <wechat>
  [exec] (FlowBOT) {/opt/weflow/weflow --no-sandbox --disable-gpu} <weflow>
  [submenu] (终端)
    [exec] (Terminal) {xterm} <xterm>
  [end]
  [separator]
  [exit] (退出)
[end]
EOF

# Start Xvfb
log INFO "Starting Xvfb virtual display..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 1600x900x24 -ac &
XVFB_PID=$!
sleep 2

# Start Fluxbox window manager
log INFO "Starting Fluxbox window manager..."
DISPLAY=:99 fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!
sleep 1

# Start VNC + noVNC (requires VNC_PASSWORD)
VNC_PID=""
NOVNC_PID=""
if [ -n "$VNC_PASSWORD" ]; then
  log INFO "Starting VNC server with password (port ${VNC_PORT:-5900})..."
  x11vnc -storepasswd "$VNC_PASSWORD" /opt/weflow/data/.vncpasswd 2>/dev/null
  x11vnc -display :99 -forever -shared -rfbport 5900 -rfbauth /opt/weflow/data/.vncpasswd >/dev/null 2>&1 &
  VNC_PID=$!
  sleep 1
  log INFO "Starting noVNC web client (port ${NOVNC_PORT:-7600})..."
  websockify --web /usr/share/novnc ${NOVNC_PORT:-7600} localhost:5900 >/dev/null 2>&1 &
  NOVNC_PID=$!
else
  log WARN "VNC_PASSWORD not set, skipping VNC and noVNC"
fi

# Start WeChat
log INFO "Starting WeChat..."
sleep 2
export LD_LIBRARY_PATH="/opt/wechat:${LD_LIBRARY_PATH}"
DISPLAY=:99 /opt/wechat/wechat &
WECHAT_PID=$!

# Start FlowBOT Electron app (HTTP API on port 5031)
log INFO "Starting FlowBOT Electron app (API port ${FLOW_API_PORT:-5031})..."
cd /opt/weflow
DISPLAY=:99 WEFLOW_DOCKER=1 ONEBOT_PORT=${ONEBOT_PORT:-7100} ./weflow --no-sandbox --disable-gpu &
WEFLOW_PID=$!

# Start WebUI server (port 7300, proxies to FlowBOT API on 5031)
log INFO "Starting WebUI management panel (port ${WEBUI_PORT:-7300})..."
cd /opt/weflow-webui
FLOW_API_PORT=${FLOW_API_PORT:-5031} WEBUI_PORT=${WEBUI_PORT:-7300} node server.js &
WEBUI_PID=$!

cleanup() {
    log INFO "Shutting down..."
    kill $WEBUI_PID 2>/dev/null || true
    kill $WEFLOW_PID 2>/dev/null || true
    kill $WECHAT_PID 2>/dev/null || true
    kill $NOVNC_PID 2>/dev/null || true
    kill $VNC_PID 2>/dev/null || true
    kill $FLUXBOX_PID 2>/dev/null || true
    kill $XVFB_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT

log INFO "============================================"
log INFO "  All services started successfully!"
log INFO "============================================"
log INFO "  OneBot API : http://localhost:${ONEBOT_PORT:-7100}"
log INFO "  FlowBOT API: http://localhost:${FLOW_API_PORT:-5031}"
log INFO "  WebUI      : http://localhost:${WEBUI_PORT:-7300}"
if [ -n "$VNC_PASSWORD" ]; then
  log INFO "  noVNC      : http://localhost:${NOVNC_PORT:-7600}"
else
  log INFO "  noVNC      : disabled (set VNC_PASSWORD to enable)"
fi
log INFO "  WebUI Login Password: $WEBUI_PASS"
log INFO "============================================"

wait $WEBUI_PID
