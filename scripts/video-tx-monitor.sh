#!/usr/bin/env sh
# video-tx-monitor.sh — 视频发送标定工具（MEDIA-SERVICE-DESIGN §9.2 手段1）
# 用法：容器内后台运行，另开终端触发发送；脚本每 500ms 采样容器网络 TX，
# 输出速率时间线与"上传结束"（速率跌破 idle 阈值）时刻标记。
# 仅用于标定实验，不入镜像、不进生产链路。
#
# 用法: video-tx-monitor.sh [idle阈值KB/s，默认50] [最长监控秒数，默认600]
THRESH_KB=${1:-50}
MAXSEC=${2:-600}
IFACE=${IFACE:-eth0}
TX=/sys/class/net/$IFACE/statistics/tx_bytes

[ -r "$TX" ] || { echo "ERROR: $TX 不可读"; exit 1; }
echo "监控 $IFACE TX，idle 阈值 ${THRESH_KB}KB/s，最长 ${MAXSEC}s — $(date '+%H:%M:%S')"

last=$(cat "$TX")
lastt=$(date +%s%N)
idle_start=""
start_cnt=$last
armed=0
start=$lastt
i=0
while [ $i -lt $((MAXSEC * 2)) ]; do
  sleep 0.5
  i=$((i + 1))
  now=$(cat "$TX")
  t=$(date +%s%N)
  kbps=$(( (now - last) * 1000 / 1024 / ((t - lastt) / 1000000 + 1) ))
  ts=$(date '+%H:%M:%S.%N' | cut -c1-11)
  if [ "$kbps" -gt "$THRESH_KB" ]; then
    armed=1
    echo "$ts  TX ${kbps}KB/s  +$(( (now - start_cnt) / 1024 ))KB累计"
    idle_start=""
  elif [ "$armed" = "1" ]; then
    if [ -z "$idle_start" ]; then
      idle_start=$(date +%s)
      echo "$ts  TX ${kbps}KB/s  ▼转 idle（连续 3 次则判上传结束）"
    fi
    now_s=$(date +%s)
    if [ $((now_s - idle_start)) -ge 2 ]; then
      total=$(( (now - start_cnt) / 1024 ))
      echo "==> 上传结束判定：$ts，期间累计 TX ${total}KB（监控段 $(( (t - start) / 1000000000 ))s）"
      exit 0
    fi
  else
    echo "$ts  TX ${kbps}KB/s  …待武装（等待首次活动）"
  fi
  last=$now
  lastt=$t
done
echo "达到最长监控时限"
