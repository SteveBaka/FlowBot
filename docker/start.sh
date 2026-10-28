#!/bin/bash
set -e

LOGDIR=/opt/weflow/data/logs
mkdir -p "$LOGDIR" /opt/weflow/data /root/.config /root/.fluxbox

log() {
  local level=$1; shift
  echo "[$(date '+%m-%d %H:%M:%S')] [$level] [FlowBOT] $*"
}

# Initialize WebUI authentication before log redirection. On a fresh data volume the
# initial password is printed once to docker logs only; it must not enter container.log.
DATA_DIR=/opt/weflow/data
AUTH_FILE="$DATA_DIR/webui-auth.json"
PASS_FILE="$DATA_DIR/webui-password.txt"
BOX_KEY_FILE="$DATA_DIR/.box-key"

if [ ! -s "$AUTH_FILE" ] || ! grep -qE '"ver"[[:space:]]*:[[:space:]]*2' "$AUTH_FILE" 2>/dev/null; then
  if [ -s "$PASS_FILE" ]; then
    WEBUI_INITIAL_PASS=$(cat "$PASS_FILE")
    WEBUI_PASSWORD_LABEL="WebUI migration password"
  else
    WEBUI_INITIAL_PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
    WEBUI_PASSWORD_LABEL="WebUI initial password (legacy plaintext missing; reset)"
  fi
  node - "$WEBUI_INITIAL_PASS" "$AUTH_FILE" "$BOX_KEY_FILE" <<'NODE'
const crypto = require('crypto')
const fs = require('fs')
const [password, authPath, keyPath] = process.argv.slice(2)
let key = ''
try { key = fs.readFileSync(keyPath, 'utf8').trim() } catch {}
if (!/^[0-9a-f]{64}$/.test(key)) {
  key = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
}
const derived = crypto.pbkdf2Sync(key, 'weflow-box-v1', 100000, 32, 'sha256')
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv)
const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
const passEnc = 'box:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
fs.writeFileSync(authPath, JSON.stringify({
  ver: 2,
  passEnc,
  salt: crypto.randomBytes(16).toString('hex'),
  mustChange: true,
  createdAt: new Date().toISOString()
}), { mode: 0o600 })
NODE
  echo "$WEBUI_PASSWORD_LABEL: $WEBUI_INITIAL_PASS"
fi

rm -f "$PASS_FILE" 2>/dev/null || true

# Remove old plaintext password lines left by pre-v2 images. New passwords are
# printed before log redirection and therefore never enter container.log.
if [ -f "$LOGDIR/container.log" ]; then
  sed -i -E 's/(WebUI ([Ii]nitial|[Mm]igration|[Ll]ogin) Password:).*/\1 [REDACTED]/g' "$LOGDIR/container.log" 2>/dev/null || true
fi

# Redirect all output to log files for WebUI access.
# 每条日志在落盘瞬间就打上级别标签：docker logs 直读 stdout、WebUI 读同一个
# tee 文件，两端看到的是同一份权威级别，不再各自靠关键词猜。
# -W interactive 不可省略：mawk 默认整块缓冲，少了它 docker logs 要等缓冲区
# 写满才吐字，现场排障时表现为日志"延迟几分钟突然刷一大片"。
exec > >(awk -W interactive -f /opt/logfmt.awk | tee -a "$LOGDIR/container.log") 2>&1

log INFO "Starting FlowBOT + OneBot container..."
log INFO "Logs: $LOGDIR/container.log"

# container.log 轮转：超过上限时保留末尾 KEEP 字节。
# tee 以 append 模式持有该文件，重写（truncate）后其行为 O_APPEND 会从新 EOF 续写，安全。
(
  while true; do
    sleep "${WEFLOW_CONTAINER_LOG_INTERVAL:-300}"
    _max="${WEFLOW_CONTAINER_LOG_MAX:-20971520}"   # 20MB
    _keep="${WEFLOW_CONTAINER_LOG_KEEP:-2097152}"  # 2MB
    if [ -f "$LOGDIR/container.log" ]; then
      _sz=$(stat -c %s "$LOGDIR/container.log" 2>/dev/null || echo 0)
      if [ "$_sz" -gt "$_max" ]; then
        if tail -c "$_keep" "$LOGDIR/container.log" > "$LOGDIR/container.log.tmp" 2>/dev/null; then
          cat "$LOGDIR/container.log.tmp" > "$LOGDIR/container.log" 2>/dev/null || true
        fi
        rm -f "$LOGDIR/container.log.tmp" 2>/dev/null || true
      fi
    fi
  done
) >/dev/null 2>&1 &

# Start DBus
log INFO "Starting DBus..."
mkdir -p /run/dbus
rm -f /run/dbus/pid 2>/dev/null || true
dbus-daemon --system --fork 2>/dev/null || true
eval $(dbus-launch --sh-syntax) 2>/dev/null || true

# Configure fluxbox
cat > /root/.fluxbox/init << 'EOF'
session.screen0.tabs.usePixmap: false
session.screen0.tabs.maxWidth: 200
session.screen0.tabs.useFocus: true
session.screen0.workspaces: 1
session.screen0.rootCommand: fbsetroot -solid black
EOF
cat > /root/.fluxbox/keys << 'EOF'
OnDesktop Mouse3 :RootMenu
EOF
cat > /root/.fluxbox/menu << 'EOF'
[begin] (FlowBOT)
  [exec] (WeChat) {/opt/wechat/wechat} <wechat>
  [exec] (FlowBOT) {/opt/weflow/weflow --no-sandbox --disable-gpu} <weflow>
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
  websockify --web /opt/novnc ${NOVNC_PORT:-7600} localhost:5900 >/dev/null 2>&1 &
  NOVNC_PID=$!
else
  log WARN "VNC_PASSWORD not set, skipping VNC and noVNC"
fi

# Start WeChat
#
# Do not export LD_LIBRARY_PATH=/opt/wechat globally. The root directory contains
# the main WeChat runtime (owl::v8), while RadiumWMPF/runtime contains the
# WeChatAppEx runtime (owl::v7). A global root path makes the child process load
# the wrong libowl.so and fail with a missing owl::v7 typeinfo symbol. Both
# binaries already carry their own RPATH/RUNPATH, so let the loader resolve the
# correct runtime directory locally.
log INFO "Starting WeChat..."
sleep 2
DISPLAY=:99 /opt/wechat/wechat &
WECHAT_PID=$!

# Start FlowBOT Electron app (HTTP API on port 5031)
# 守护循环：weflow 崩溃后 3 秒自动拉起；WebUI 的"重启 WeFlow"按钮只需优雅杀进程，
# 循环负责重新启动。子 shell 内的 stdout 天然走本脚本的 tee 管道（docker logs 不断流）。
log INFO "Starting FlowBOT Electron app (API port ${FLOW_API_PORT:-5031})..."
(
  cd /opt/weflow
  while true; do
    DISPLAY=:99 WEFLOW_DOCKER=1 ONEBOT_PORT=${ONEBOT_PORT:-7100} ./weflow --no-sandbox --disable-gpu
    RC=$?
    echo "[$(date '+%m-%d %H:%M:%S')] [WARN] [FlowBOT] WeFlow exited (code $RC), restarting in 3s..."
    sleep 3
  done
) &
WEFLOW_PID=$!
echo "$WEFLOW_PID" > "$DATA_DIR/weflow-watchdog.pid"

# Start WebUI server (port 7300, proxies to FlowBOT API on 5031)
log INFO "Starting WebUI management panel (port ${WEBUI_PORT:-7300})..."
cd /opt/weflow-webui
FLOW_API_PORT=${FLOW_API_PORT:-5031} WEBUI_PORT=${WEBUI_PORT:-7300} node server.js &
WEBUI_PID=$!

cleanup() {
    log INFO "Shutting down..."
    kill $WEBUI_PID 2>/dev/null || true
    # WEFLOW_PID 现在是守护循环子 shell；先停循环，再优雅停 weflow 本体
    kill $WEFLOW_PID 2>/dev/null || true
    pkill -TERM -f '^\./weflow --no-sandbox' 2>/dev/null || true
    kill $WECHAT_PID 2>/dev/null || true
    # 给微信最多 5s 优雅退出：登录级设置（如「自动下载」开关）和 SQLite WAL
    # 依赖进程正常退出时落盘，随容器被 SIGKILL 抢杀会丢失内存态
    for _i in 1 2 3 4 5; do
        kill -0 "$WECHAT_PID" 2>/dev/null || break
        sleep 1
    done
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
log INFO "============================================"

wait $WEBUI_PID
