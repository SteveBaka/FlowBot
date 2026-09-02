#!/usr/bin/env bash
# Docker image smoke gate: boots the image and probes service health.
# Usage: docker-smoke.sh <image> [report.md]
# Probes (no WeChat login needed): process liveness (wechat / weflow / webui),
# WebUI HTTP /api/status + /api/version (7300), WeFlow API (5031), OneBot (7100).
# Writes a markdown report; exits non-zero if any probe fails.
set -uo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image> [report.md]}"
REPORT="${2:-smoke-report.md}"
CONTAINER=flowbot-smoke
WAIT_SECONDS=300

ROWS=()
FAIL=0

record() { # record <emoji> <name> <detail>
  ROWS+=("| $1 | \`$2\` | $3 |")
  [ "$1" = "✅" ] || FAIL=$((FAIL + 1))
}
pass() { record "✅" "$1" "$2"; }
fail() { record "❌" "$1" "$2"; }

# Re-exec a cheap probe inside the container until it passes or times out.
wait_probe() { # wait_probe <cmd...>
  local deadline=$((SECONDS + WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$CONTAINER" "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ] || return 1
    sleep 5
  done
  return 1
}

cleanup() {
  docker logs "$CONTAINER" --tail 300 > smoke-container.log 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "Starting container from $IMAGE ..."
if docker run -d --name "$CONTAINER" --shm-size=2g "$IMAGE" >/dev/null 2>&1; then
  # WebUI: auth-exempt endpoints prove node server.js + its config load path.
  if wait_probe curl -sf -o /dev/null http://127.0.0.1:7300/api/status; then
    pass "WebUI /api/status (7300)" "server.js 启动并可响应"
  else
    fail "WebUI /api/status (7300)" "${WAIT_SECONDS}s 内未就绪"
  fi

  if wait_probe curl -sf -o /dev/null http://127.0.0.1:7300/api/version; then
    pass "WebUI /api/version (7300)" ""
  else
    fail "WebUI /api/version (7300)" ""
  fi

  # WeFlow API (Electron httpService): any HTTP response (incl. 404) proves listening.
  if wait_probe curl -s -o /dev/null --max-time 5 http://127.0.0.1:5031/; then
    pass "WeFlow API (5031)" "Electron httpService 监听中"
  else
    fail "WeFlow API (5031)" "${WAIT_SECONDS}s 内未监听"
  fi

  # OneBot: raw TCP accept.
  if wait_probe bash -c 'exec 3<>/dev/tcp/127.0.0.1/7100'; then
    pass "OneBot (7100)" "端口可建立 TCP 连接"
  else
    fail "OneBot (7100)" "${WAIT_SECONDS}s 内未监听"
  fi

  sleep 10
  for p in "WeChat:/opt/wechat/wechat" "WeFlow:weflow --no-sandbox" "WebUI:node server.js"; do
    name=${p%%:*}; pat=${p#*:}
    if docker exec "$CONTAINER" pgrep -f "$pat" >/dev/null 2>&1; then
      pass "进程存活: $name" ""
    else
      fail "进程存活: $name" "pgrep 未找到"
    fi
  done

  VER=$(docker exec "$CONTAINER" cat /opt/weflow/VERSION 2>/dev/null | tr -d '[:space:]')
  if [ -n "$VER" ]; then
    pass "镜像版本标记 /opt/weflow/VERSION" "$VER"
  else
    fail "镜像版本标记 /opt/weflow/VERSION" "文件缺失或为空"
  fi
else
  fail "容器启动" "docker run 失败,见 container log"
fi

{
  echo "**镜像**: \`$IMAGE\`"
  echo
  echo "| 结果 | 探测项 | 详情 |"
  echo "|---|---|---|"
  printf '%s\n' "${ROWS[@]:-| ➖ | (无探测执行) | |}"
} > "$REPORT"

cat "$REPORT"
[ "$FAIL" -eq 0 ]
