#!/usr/bin/env bash
# Docker image smoke gate: boots the image and probes service health.
# Usage: docker-smoke.sh <image> [report.md]
#
# Seeds a minimal bot config (/root/.config/WeFlow/WeFlow-config.json) so the
# core channels boot WITHOUT WeChat login, then probes them for real:
#   - OneBot v11 HTTP (7100, mode=http bot): /get_version_info must answer with
#     protocol_version v11, /get_status online, unknown action -> spec failure
#   - Plugin REST API (7400, mode=plugin bot): auth layer rejects without token,
#     with token the 7400 -> 5031 proxy chain answers with upstream JSON
#   - WeFlow HTTP API (5031): /api/v1/health (auth-exempt in docker mode)
#   - WebUI (7300): /api/status + /api/version
# Writes a markdown report; exits non-zero if any probe fails.
set -uo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image> [report.md]}"
REPORT="${2:-smoke-report.md}"
CONTAINER=flowbot-smoke
WAIT_SECONDS=300
PLUGIN_TOKEN=ci-smoke-token

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

# Seed config: one file drives both sides (electron-store for the OneBot bot,
# server.js reads the same path on a 5s refresh for the plugin-API bot).
SEED_DIR=$(mktemp -d /tmp/flowbot-smoke-seed.XXXXXX)
mkdir -p "$SEED_DIR/WeFlow"
cat > "$SEED_DIR/WeFlow/WeFlow-config.json" <<EOF
{"bots":[
  {"id":"ci-onebot","name":"ci-onebot","mode":"http","direction":"server","address":"","port":7100,"token":"","enabled":true},
  {"id":"ci-plugin","name":"ci-plugin","mode":"plugin","direction":"server","address":"","port":7400,"token":"$PLUGIN_TOKEN","enabled":true}
]}
EOF

cleanup() {
  docker logs "$CONTAINER" --tail 300 > smoke-container.log 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$SEED_DIR"
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "Starting container from $IMAGE ..."
if docker run -d --name "$CONTAINER" --shm-size=2g \
    -v "$SEED_DIR/WeFlow:/root/.config/WeFlow" "$IMAGE" >/dev/null 2>&1; then

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

  # WeFlow HTTP API: /api/v1/health is auth-exempt in docker mode; a real
  # dispatched route, not just "port open".
  if wait_probe curl -sf http://127.0.0.1:5031/api/v1/health; then
    pass "WeFlow API /api/v1/health (5031)" "httpService 路由分发正常"
  else
    fail "WeFlow API /api/v1/health (5031)" "${WAIT_SECONDS}s 内未就绪"
  fi

  # OneBot v11 HTTP (7100): seeded http-mode bot boots the server without login.
  if wait_probe curl -sf http://127.0.0.1:7100/get_version_info; then
    BODY=$(docker exec "$CONTAINER" curl -sf http://127.0.0.1:7100/get_version_info 2>/dev/null || true)
    if printf '%s' "$BODY" | grep -Eq '"retcode":\s*0' && printf '%s' "$BODY" | grep -Eq '"protocol_version":\s*"v11"'; then
      pass "OneBot v11 /get_version_info (7100)" "protocol_version=v11"
    else
      fail "OneBot v11 /get_version_info (7100)" "响应非 v11 规范: ${BODY:0:120}"
    fi
  else
    fail "OneBot v11 /get_version_info (7100)" "${WAIT_SECONDS}s 内未就绪(检查种子 bot 配置)"
  fi

  BODY=$(docker exec "$CONTAINER" curl -sf http://127.0.0.1:7100/get_status 2>/dev/null || true)
  if printf '%s' "$BODY" | grep -Eq '"online":\s*true'; then
    pass "OneBot v11 /get_status (7100)" "online=true"
  else
    fail "OneBot v11 /get_status (7100)" "响应异常: ${BODY:0:120}"
  fi

  # Request parsing/dispatch: unknown action must yield a spec-shaped failure.
  BODY=$(docker exec "$CONTAINER" curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"action":"__ci_probe__","params":{}}' http://127.0.0.1:7100/ 2>/dev/null || true)
  if printf '%s' "$BODY" | grep -Eq '"status":\s*"failed"'; then
    pass "OneBot v11 未知 action 处理 (7100)" "规范失败响应"
  else
    fail "OneBot v11 未知 action 处理 (7100)" "响应异常: ${BODY:0:120}"
  fi

  # Plugin REST API (7400): auth layer, then the full 7400 -> 5031 proxy chain.
  if wait_probe curl -s -o /dev/null http://127.0.0.1:7400/api/v1/sessions; then
    CODE=$(docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7400/api/v1/sessions 2>/dev/null || true)
    if [ "$CODE" = "401" ]; then
      pass "插件 API 鉴权拒绝 (7400)" "无 token → 401"
    else
      fail "插件 API 鉴权拒绝 (7400)" "无 token 期望 401,实际: ${CODE:-无响应}"
    fi

    BODY=$(docker exec "$CONTAINER" curl -s -w '\n%{http_code}' -H "Authorization: Bearer $PLUGIN_TOKEN" \
      http://127.0.0.1:7400/api/v1/sessions 2>/dev/null || true)
    CODE=$(printf '%s' "$BODY" | tail -1)
    JSON=$(printf '%s' "$BODY" | sed '$d')
    if printf '%s' "$JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 \
        && [ "$CODE" != "401" ] && [ "$CODE" != "404" ]; then
      pass "插件 API 全链路 7400→5031 (带 token)" "上游 JSON 响应 (HTTP $CODE)"
    else
      fail "插件 API 全链路 7400→5031 (带 token)" "HTTP ${CODE:-无响应}: ${JSON:0:120}"
    fi
  else
    fail "插件 API (7400)" "${WAIT_SECONDS}s 内未就绪(检查种子 plugin bot 配置)"
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
