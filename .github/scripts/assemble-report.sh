#!/usr/bin/env bash
# Assembles the PR Gate review report (markdown) from job results + artifacts.
# Env inputs: BUILD_RESULT, SECURITY_RESULT, SMOKE_RESULT, EVENT_NAME, RUN_URL
# Usage: assemble-report.sh <output.md>
set -uo pipefail

OUT="${1:?usage: assemble-report.sh <output.md>}"

emoji() {
  case "$1" in
    success) echo "✅";; failure) echo "❌";; cancelled) echo "🟡";;
    skipped) echo "➖";; *) echo "❔";;
  esac
}

ALL_OK=1
if [ "$BUILD_RESULT" = success ] && [ "$SECURITY_RESULT" = success ] && [ "$SMOKE_RESULT" = success ]; then
  ALL_OK=0
fi

{
  echo "# 🤖 PR Gate 审核报告"
  echo
  if [ "$ALL_OK" -eq 0 ]; then
    echo "**结论:🟢 全部检查通过,可合并。**"
  else
    echo "**结论:🔴 存在未通过项,请查看下方明细。**"
  fi
  echo
  echo "| 检查项 | 结果 |"
  echo "|---|---|"
  echo "| 构建(tsc / vite / electron-builder) | $(emoji "$BUILD_RESULT") $BUILD_RESULT |"
  echo "| 安全扫描(gitleaks / dependency-review) | $(emoji "$SECURITY_RESULT") $SECURITY_RESULT |"
  echo "| Docker 镜像冒烟(启动 + 进程/端口/API 探测) | $(emoji "$SMOKE_RESULT") $SMOKE_RESULT |"
  echo
  echo "完整日志: $RUN_URL"
  echo

  # package.json dependency diff (PR only)
  if [ "$EVENT_NAME" = "pull_request" ] && git rev-parse -q --verify origin/main >/dev/null 2>&1; then
    DIFF=$(git diff origin/main...HEAD -- package.json | grep -E '^[+-][[:space:]]+"' | head -80 || true)
    if [ -n "$DIFF" ]; then
      echo "## package.json 依赖变更"
      echo '```diff'
      echo "$DIFF"
      echo '```'
      echo
    fi
  fi

  if [ -f smoke-artifacts/smoke-report.md ]; then
    echo "## Docker 冒烟明细"
    echo
    cat smoke-artifacts/smoke-report.md
    echo
  elif [ "$SMOKE_RESULT" != "skipped" ] && [ "$SMOKE_RESULT" != "cancelled" ]; then
    echo "## Docker 冒烟明细"
    echo
    echo "冒烟任务未产出报告(可能失败于构建阶段),详见运行日志。"
    echo
  fi

  if [ -f security-artifacts/security-report.md ]; then
    cat security-artifacts/security-report.md
    echo
  fi
} > "$OUT"

cat "$OUT"
