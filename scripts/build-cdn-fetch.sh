#!/usr/bin/env bash
# build-cdn-fetch.sh — 编译 CDN 直取注入器（ptrace 版）
# 产物：resources/key/linux/x64/cdn_fetch（静态链接，随 electron-builder 进 release）
# 详见 docs/dev/CDN-DIRECT-FETCH-POC-FINAL.md（机制）与 source/cdn_fetch.c 头注（硬约束）
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=resources/key/linux/x64/source/cdn_fetch.c
OUT=resources/key/linux/x64/cdn_fetch

command -v gcc >/dev/null || { echo "需要 gcc（宿主机构建，容器内不含工具链）"; exit 1; }
gcc -O2 -static -o "$OUT" "$SRC"
chmod 755 "$OUT"
echo "built: $OUT ($(stat -c %s "$OUT") bytes)"
