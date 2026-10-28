# 把容器的多来源混合输出归一化为 "[MM-DD HH:MM:SS] [LEVEL] 正文"。
# 级别必须在落盘时一次定死：docker logs 直读 stdout，WebUI 读同一个 tee 文件，
# 只有一份权威级别才能保证两端显示一致，否则各端只能各自靠关键词猜、互相矛盾。
function lv_of(txt,    l) {
  l = tolower(txt)
  # 统计字段取零值不代表失败（"added=2 failed=0" 是全成功的正常收尾）
  gsub(/[a-z_]+=0/, " ", l)
  if (l ~ /fatal/) return "FATAL"
  if (l ~ /error/) return "ERROR"
  # warn 先于 fail：避免 "WARN: failed to reconnect" 被降级成 ERROR 之外的结果
  if (l ~ /warn/) return "WARN"
  if (l ~ /fail/) return "ERROR"
  if (l ~ /debug/) return "DEBUG"
  return "INFO"
}
BEGIN { lastLv = "INFO" }
{
  raw = $0
  if (raw ~ /^[ \t]*$/) { print ""; fflush(); next }

  body = raw
  ts = ""
  if (match(raw, /^\[[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\]/)) {
    ts = substr(raw, 2, RLENGTH - 2)
    body = substr(raw, RLENGTH + 1)
  } else {
    # WeFlow Logger 偶带 ISO(UTC) 时间戳。管道里没有可靠的时区换算手段，
    # 丢弃后改用收行时刻（管道是实时的，误差在秒级）。
    sub(/^\[20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9](:[0-9][0-9])?[^]]*\]/, "", body)
  }
  if (ts == "") ts = strftime("%m-%d %H:%M:%S")

  # 时间戳后紧邻的单个分隔空格不是缩进，先摘掉；否则每行都会落进下面的
  # 缩进续行分支，全文件级别一起塌成第一行的值。
  sub(/^ /, "", body)

  # 续行判定必须在去缩进之前——堆栈帧只能靠缩进来标识归属
  isCont = (body ~ /^[ \t]/) || (body ~ /^[]})]/) || (body ~ /^at [A-Za-z_$]/)

  sub(/^[ \t]+/, "", body)

  lv = ""
  if (match(body, /^\[(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\] ?/)) {
    lv = toupper(substr(body, 2, RLENGTH - 3))
    if (lv == "WARNING") lv = "WARN"
    if (lv == "TRACE") lv = "DEBUG"
    sub(/^\[(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\] ?/, "", body)
  } else if (match(body, /^\[[EWIDV]\]/)) {
    c = substr(body, 2, 1)
    if (c == "E") lv = "ERROR"
    else if (c == "W") lv = "WARN"
    else if (c == "D" || c == "V") lv = "DEBUG"
    else lv = "INFO"
    body = substr(body, RLENGTH + 1)
  } else if (isCont) {
    # 缩进行、闭合括号、堆栈帧都属于上一条日志；不继承的话，
    # 一段崩溃堆栈会被拆成几十条互不相关的 INFO。
    lv = lastLv
  } else {
    lv = lv_of(body)
  }
  lastLv = lv

  print "[" ts "] [" lv "] " body
  fflush()
}
