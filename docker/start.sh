#!/bin/bash
set -e

echo "[WeFlow] Starting WeFlow + OneBot container..."
mkdir -p /opt/weflow/data /root/.config /root/.fluxbox

# Start DBus
echo "[WeFlow] Starting DBus..."
mkdir -p /run/dbus
rm -f /run/dbus/pid 2>/dev/null
dbus-daemon --system --fork 2>/dev/null || true
eval $(dbus-launch --sh-syntax) 2>/dev/null || true

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
[begin] (WeFlow)
  [exec] (WeChat) {/opt/wechat/wechat} <wechat>
  [exec] (WeFlow) {/opt/weflow/weflow --no-sandbox --disable-gpu} <weflow>
  [submenu] (终端)
    [exec] (Terminal) {xterm} <xterm>
  [end]
  [separator]
  [exit] (退出)
[end]
EOF

# Start Xvfb
echo "[WeFlow] Starting Xvfb virtual display..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 1600x900x24 -ac &
XVFB_PID=$!
sleep 2

# Start Fluxbox window manager
echo "[WeFlow] Starting Fluxbox window manager..."
DISPLAY=:99 fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!
sleep 1

# Start VNC
echo "[WeFlow] Starting VNC server (port ${VNC_PORT:-5900})..."
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw >/dev/null 2>&1 &
VNC_PID=$!
sleep 1

# Start noVNC
echo "[WeFlow] Starting noVNC web client (port 6080)..."
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
NOVNC_PID=$!

# Start WeChat
echo "[WeFlow] Starting WeChat..."
sleep 2
export LD_LIBRARY_PATH="/opt/wechat:${LD_LIBRARY_PATH}"
DISPLAY=:99 /opt/wechat/wechat &
WECHAT_PID=$!

# Start WeFlow Electron app (HTTP API on port 5031)
echo "[WeFlow] Starting WeFlow Electron app (API port ${FLOW_API_PORT:-5031})..."
cd /opt/weflow
DISPLAY=:99 WEFLOW_DOCKER=1 ONEBOT_PORT=${ONEBOT_PORT:-3001} ./weflow --no-sandbox --disable-gpu &
WEFLOW_PID=$!

# Start WebUI server (port 5099, proxies to WeFlow API on 5031)
echo "[WeFlow] Starting WebUI management panel (port ${WEBUI_PORT:-5099})..."
cd /opt/weflow-webui
FLOW_API_PORT=${FLOW_API_PORT:-5031} WEBUI_PORT=${WEBUI_PORT:-5099} node server.js &
WEBUI_PID=$!

cleanup() {
    echo "[WeFlow] Shutting down..."
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

echo ""
echo "[WeFlow] ============================================"
echo "[WeFlow]   All services started successfully!"
echo "[WeFlow] ============================================"
echo "[WeFlow]   OneBot API : http://localhost:${ONEBOT_PORT:-3001}"
echo "[WeFlow]   WeFlow API : http://localhost:${FLOW_API_PORT:-5031}"
echo "[WeFlow]   WebUI      : http://localhost:${WEBUI_PORT:-5099}"
echo "[WeFlow]   noVNC      : http://localhost:6080"
echo "[WeFlow] ============================================"
echo ""

wait $WEBUI_PID
