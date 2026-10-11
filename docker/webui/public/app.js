var _a = Vue, createApp = _a.createApp, ref = _a.ref, reactive = _a.reactive, computed = _a.computed, watch = _a.watch, onMounted = _a.onMounted, onUnmounted = _a.onUnmounted, nextTick = _a.nextTick, h = _a.h
var _b = VueRouter, createRouter = _b.createRouter, createWebHashHistory = _b.createWebHashHistory, useRouter = _b.useRouter, useRoute = _b.useRoute, RouterLink = _b.RouterLink, RouterView = _b.RouterView

var toasts = ref([])
var toastId = 0
function toast(msg, type) {
  if (!type) type = 'success'
  var id = ++toastId
  var t = { id: id, msg: msg, type: type, fading: false }
  toasts.value.push(t)
  setTimeout(function () {
    var idx = toasts.value.findIndex(function (x) { return x.id === id })
    if (idx !== -1) toasts.value[idx].fading = true
    setTimeout(function () {
      toasts.value = toasts.value.filter(function (x) { return x.id !== id })
    }, 400)
  }, 3000)
}

function generateToken() {
  var chars = '0123456789abcdef'
  var t = ''
  for (var i = 0; i < 16; i++) t += chars[Math.floor(Math.random() * chars.length)]
  return t
}

function getNoVncPort() {
  var webPort = String(window.location.port || '7300')
  return /^73\d\d$/.test(webPort) ? '76' + webPort.slice(2) : '7600'
}

function getNoVncUrl() {
  var host = window.location.hostname || '127.0.0.1'
  return 'http://' + host + ':' + getNoVncPort() + '/vnc.html'
}

async function api(path, opts) {
  try {
    var token = localStorage.getItem('weflow-auth-token')
    opts = opts || {}
    opts.headers = Object.assign({ 'X-WeFlow-Page': 'webui' }, opts.headers || {})
    if (token) {
      opts.headers = Object.assign(opts.headers, { Authorization: 'Bearer ' + token })
    }
    var res = await fetch(path, opts)
    var text = await res.text()
    try { var d = JSON.parse(text) } catch (_) { return { error: 'Non-JSON response (status ' + res.status + ')' } }
    if (res.status === 401 && path !== '/api/auth/login') {
      if (path === '/api/auth/change-password' && d.code === 'AUTH_INVALID') return d
      localStorage.removeItem('weflow-auth-token')
      window.location.hash = '#/login'
      return { error: 'Unauthorized' }
    }
    if (!res.ok) return { error: d.error || d.message || ('HTTP ' + res.status) }
    return d
  } catch (e) { return { error: e.message } }
}

var THEME_KEY = 'weflow_theme'
var THEME_ORDER = ['light', 'dark']

function loadSavedTheme() {
  try {
    var saved = localStorage.getItem(THEME_KEY)
    if (saved && THEME_ORDER.includes(saved)) return saved
  } catch {}
  return 'system'
}

function saveTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, mode)
  } catch {}
}

var themeMode = ref(loadSavedTheme())
var effectiveTheme = ref('dark')
var themeMedia = null
var handleThemeChange = null
var loginOverlayVisible = ref(false)
var appShellReveal = ref(false)
var authTransitionAuthorized = false

function resolveTheme() {
  if (themeMode.value === 'system') {
    return themeMedia?.matches ? 'dark' : 'light'
  }
  return themeMode.value
}

function applyTheme() {
  effectiveTheme.value = resolveTheme()
  document.documentElement.dataset.theme = effectiveTheme.value
}

var ToastContainer = {
  setup: function () { return { toasts: toasts } },
  template: '<div class="toast-container">' +
    '<div v-for="t in toasts" :key="t.id" :class="[\'toast\', t.type, t.fading ? \'fade-out\' : \'\']">{{ t.msg }}</div>' +
    '</div>'
}

var ToggleSwitch = {
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  template: '<label class="toggle">' +
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)">' +
    '<span class="slider"></span>' +
    '</label>'
}

var HomePage = {
  setup: function () {
    var cards = reactive({
      login: { status: '', color: '', loading: true, sub: '' },
      onebot: { status: '', color: '', loading: true, sub: '' },
      account: { status: '', color: '', loading: true, sub: '' },
      database: { status: '', color: '', loading: true, sub: '' },
      system: { cpu: 0, ram: 0, disk: 0, uptime: '-', cpuModel: '-', loading: true }
    })
    var flowbotVersion = ref('-')
    var weflowVersion = ref('-')
    var wechatVersion = ref('4.1.1.7')

    /* 链路节点：wechat / api / bot / db */
    var chain = reactive([
      { key: 'wechat', name: '微信进程', sub: '', state: 'loading', route: '/settings' },
      { key: 'api', name: 'FlowBOT API', sub: '', state: 'loading', route: '' },
      { key: 'bot', name: 'Bot 连接', sub: '', state: 'loading', route: '/bot' },
      { key: 'db', name: '数据库', sub: '', state: 'loading', route: '/settings' }
    ])
    var wechatRunning = ref(null) /* null=未知 */
    var profile = reactive({ wxid: '', displayName: '未登录', avatar: 'icon.png' })

    /* 发送概况（15s 轻量轮询，瞬时值） */
    var sendStats = reactive({ sent: 0, failed: 0, pending: 0, processing: false, samples: [], rate: null, lastMs: null })

    function dotColor(c) {
      if (c === 'green') return '#10b981'
      if (c === 'red') return '#ef4444'
      if (c === 'yellow') return '#fbbf24'
      return '#94a3b8'
    }
    function chainStateClass(n) { return 'chain-' + n.state }
    function goRoute(r) { if (r) window.location.hash = '#' + r }
    function openNoVnc() {
      window.open(getNoVncUrl(), '_blank')
    }
    function profileAvatarError() {
      profile.avatar = 'icon.png'
    }

    /* ── 总健康判定（优先级从高到低）────────────────────────────────── */
    var overall = computed(function () {
      var st = function (k) { return chain.find(function (n) { return n.key === k }).state }
      if (st('wechat') === 'down') return { level: 'danger', text: '微信进程未运行', route: '/settings', action: '去设置' }
      if (st('api') === 'down') return { level: 'danger', text: 'FlowBOT API 失联', route: '', action: '查看日志', log: true }
      if (st('db') === 'down') return { level: 'danger', text: '数据库未连接', route: '/settings', action: '去设置' }
      if (st('bot') === 'down') return { level: 'danger', text: 'Bot 全部未连接', route: '/bot', action: '去 Bot 配置' }
      if (st('bot') === 'warn') return { level: 'warn', text: '部分 Bot 未连接', route: '/bot', action: '去 Bot 配置' }
      if (st('wechat') === 'warn') return { level: 'warn', text: '微信状态未知', route: '/settings', action: '去设置' }
      return { level: 'ok', text: '全部正常', text2: ' · 微信运行中 · ' + botConnectedCount.value + '/' + botTotalCount.value + ' 个 Bot 已连接', route: '', action: '' }
    })
    var botConnectedCount = ref(0)
    var botTotalCount = ref(0)

    async function load() {
      /* API 节点：本请求成功即在位 */
      var h = await api('/api/v1/health')
      chain[1].state = (!h.error && h.status === 'ok') ? 'up' : 'down'
      chain[1].sub = chain[1].state === 'up' ? '运行中' : '无响应'

      var c = await api('/api/v1/mgmt/config')
      if (!c.error) {
        if (c.myWxid) { cards.login.status = '已登录'; cards.login.color = 'green' }
        else { cards.login.status = '未登录'; cards.login.color = 'red' }
        cards.login.loading = false

        cards.account.status = c.myWxid || '未设置'
        cards.account.loading = false
        profile.wxid = c.myWxid || ''
        profile.displayName = c.myWxid || '未登录'

        var accountProfile = await api('/api/account/profile')
        if (!accountProfile.error && accountProfile.profile) {
          profile.wxid = accountProfile.profile.wxid || profile.wxid
          profile.displayName = accountProfile.profile.displayName || profile.displayName
          profile.avatar = accountProfile.profile.avatarUrl || 'icon.png'
        }

        var dbUp = !!c.dbPath
        chain[3].state = dbUp ? 'up' : 'down'
        chain[3].sub = dbUp ? (c.dbPath.length > 28 ? '…' + c.dbPath.slice(-26) : c.dbPath) : '未配置'
        cards.database.status = dbUp ? '已连接' : '未连接'
        cards.database.color = dbUp ? 'green' : 'red'
        cards.database.sub = c.dbPath || ''
        cards.database.loading = false

        var bots = []
        try { bots = typeof c.bots === 'string' ? JSON.parse(c.bots) : (c.bots || []) } catch (_) { bots = [] }
        if (!Array.isArray(bots)) bots = []
        botTotalCount.value = bots.length
        if (bots.length === 0) {
          chain[2].state = 'warn'
          chain[2].sub = '未配置 Bot'
          cards.onebot.status = '未配置'
          cards.onebot.color = 'gray'
          cards.onebot.sub = ''
          botConnectedCount.value = 0
        } else {
          var botStatusResult = await api('/api/v1/mgmt/bots/status')
          var statusMap = {}
          var botList = []
          if (!botStatusResult.error && botStatusResult.success && botStatusResult.bots) botList = botStatusResult.bots
          else if (Array.isArray(botStatusResult)) botList = botStatusResult
          botList.forEach(function (s) { statusMap[s.id] = s })
          var connected = 0
          cards.onebot.sub = bots.map(function (b) {
            var s = statusMap[b.id]
            var st = s ? (s.connectionStatus || s.status || 'stopped') : 'stopped'
            if (st === 'connected' || st === 'running') connected++
            return { name: b.name, mode: (b.mode === 'http' || b.mode === 'plugin') ? 'http' : 'ws', status: st }
          })
          botConnectedCount.value = connected
          chain[2].sub = connected + '/' + bots.length + ' 已连接'
          if (connected === bots.length) chain[2].state = 'up'
          else if (connected === 0) chain[2].state = 'down'
          else chain[2].state = 'warn'
          cards.onebot.status = bots.length + ' 个 Bot'
          cards.onebot.color = connected > 0 ? 'green' : 'red'
        }
        cards.onebot.loading = false
      } else {
        chain[1].state = 'down'
        chain[3].state = 'down'
        cards.login.status = '无法获取配置'; cards.login.color = 'yellow'; cards.login.loading = false
        cards.onebot.status = '无法获取配置'; cards.onebot.color = 'yellow'; cards.onebot.loading = false
        cards.account.status = '无法获取配置'; cards.account.loading = false
        cards.database.status = '无法获取配置'; cards.database.color = 'yellow'; cards.database.loading = false
      }

      /* 微信进程：/api/processes 现有接口推导 */
      var pr = await api('/api/processes')
      var wechatUp = false
      if (!pr.error && pr.processes) {
        wechatUp = pr.processes.some(function (p) { return (p.cmd || '').indexOf('wechat') !== -1 })
      }
      wechatRunning.value = wechatUp
      chain[0].state = wechatUp ? 'up' : 'down'
      chain[0].sub = wechatUp ? '运行中' : '未检测到进程'

      /* 系统资源 */
      var s = await api('/api/system')
      if (!s.error && s.system) {
        var sys = s.system
        cards.system.cpu = sys.cpuCores ? Math.min(Math.round((sys.cpuLoad / sys.cpuCores) * 100), 100) : 0
        cards.system.ram = sys.memory && sys.memory.usedPercent ? sys.memory.usedPercent : 0
        cards.system.disk = sys.disk && typeof sys.disk === 'object' && sys.disk.usedPercent ? sys.disk.usedPercent : 0
        cards.system.uptime = sys.containerUptime || (sys.uptime || '').replace('up ', '') || '-'
        cards.system.cpuModel = sys.cpuModel || '-'
        cards.system.loading = false
        flowbotVersion.value = sys.version || '-'
        weflowVersion.value = sys.weflowVersion || '-'
        wechatVersion.value = sys.wechatVersion || '4.1.1.7'
      } else {
        cards.system.loading = false
      }

      /* 发送概况（失败静默，不影响首页其他部分） */
      var sd = await api('/api/v1/mgmt/send-status')
      if (!sd.error && sd.status) {
        sendStats.sent = (sd.status.stats && sd.status.stats.sent) || 0
        sendStats.failed = (sd.status.stats && sd.status.stats.failed) || 0
        sendStats.pending = (sd.status.queue && sd.status.queue.pending) || 0
        sendStats.processing = !!(sd.status.queue && sd.status.queue.processing)
        var tot = sendStats.sent + sendStats.failed
        sendStats.rate = tot > 0 ? Math.round(sendStats.sent / tot * 100) : null
        var steps = sd.status.lastSendSteps
        if (Array.isArray(steps) && steps.length) {
          var sum = 0
          for (var si = 0; si < steps.length; si++) sum += (steps[si].ms || 0)
          sendStats.lastMs = sum > 0 ? sum : null
        } else {
          sendStats.lastMs = null
        }
        var maxV = 1
        sendStats.samples.push(Math.min(sendStats.sent + sendStats.failed, 999))
        if (sendStats.samples.length > 12) sendStats.samples = sendStats.samples.slice(-12)
        for (var i = 0; i < sendStats.samples.length; i++) maxV = Math.max(maxV, sendStats.samples[i])
        sendStats.maxSample = maxV
      }
    }

    var sendBars = computed(function () {
      var maxV = sendStats.maxSample || 1
      return sendStats.samples.map(function (v) {
        return { h: Math.max(6, Math.round(v / maxV * 100)) }
      })
    })

    function botChipClass(bs) {
      var conn = bs.status === 'connected' || (bs.status === 'running')
      var state = bs.status === 'stopped' ? 'off' : (conn ? 'conn' : 'on')
      return 'chip-' + bs.mode + '-' + state
    }
    function botModeLabel(bs) { return bs.mode === 'http' ? 'HTTP' : 'WS' }
    function botStatusLabel(bs) {
      if (bs.status === 'connected') return '已连接'
      if (bs.status === 'running') return '运行中'
      if (bs.status === 'connecting') return '连接中'
      return '未连接'
    }
    function resColor(pct) {
      if (pct >= 90) return 'var(--danger)'
      if (pct >= 70) return 'var(--warn)'
      return 'var(--accent)'
    }

    var refreshTimer = null
    var hiddenPaused = false
    function startTimer() {
      if (refreshTimer) return
      refreshTimer = setInterval(function () {
        if (!hiddenPaused) load()
      }, 15000)
    }
    function stopTimer() {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
    }
    function onVisChange() {
      hiddenPaused = document.hidden
      if (!document.hidden) load()
    }
    onMounted(function () {
      load()
      startTimer()
      document.addEventListener('visibilitychange', onVisChange)
    })
    onUnmounted(function () {
      stopTimer()
      document.removeEventListener('visibilitychange', onVisChange)
    })
    return {
      cards: cards, dotColor: dotColor, load: load,
      chain: chain, chainStateClass: chainStateClass, goRoute: goRoute,
      overall: overall, botConnectedCount: botConnectedCount, botTotalCount: botTotalCount,
      sendStats: sendStats, sendBars: sendBars,
      profile: profile, openNoVnc: openNoVnc, profileAvatarError: profileAvatarError,
      flowbotVersion: flowbotVersion, weflowVersion: weflowVersion, wechatVersion: wechatVersion,
      resColor: resColor,
      botChipClass: botChipClass, botModeLabel: botModeLabel, botStatusLabel: botStatusLabel
    }
  },
  template: '<div class="home-page-inner">' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">首页</h1><p class="subtitle">系统状态总览</p></div>' +
    '<div class="header-actions"><button class="btn btn-secondary" @click="load">刷新</button></div></div>' +

    '<transition name="fade-slide">' +
    '<div v-if="overall.level !== \'ok\' || overall.text === \'全部正常\'" class="health-banner home-reveal-card home-reveal-health" :class="\'hb-\' + overall.level">' +
    '<span class="hb-dot"></span>' +
    '<span class="hb-text"><b>{{ overall.text }}</b>{{ overall.text2 || \'\' }}</span>' +
    '<button v-if="overall.route || overall.action" class="btn btn-sm hb-action" @click="goRoute(overall.route)">{{ overall.action }} →</button>' +
    '</div>' +
    '</transition>' +

    '<div class="chain-bar home-reveal-card home-reveal-chain">' +
    '<template v-for="(n, i) in chain" :key="n.key">' +
    '<div class="chain-node" :class="chainStateClass(n)" @click="goRoute(n.route)">' +
    '<span class="chain-dot"></span>' +
    '<div class="chain-node-text"><div class="chain-name">{{ n.name }}</div><div class="chain-sub">{{ n.sub || (n.state === "loading" ? "检测中…" : " ") }}</div></div>' +
    '</div>' +
    '<div v-if="i < chain.length - 1" class="chain-link" :class="{ broken: n.state === \'down\' || chain[i + 1].state === \'down\' }"></div>' +
    '</template>' +
    '</div>' +

    '<div class="stats-grid home-grid home-grid-enhanced">' +

    '<div class="card account-profile-card home-account-card">' +
    '<div class="account-card-title">当前账号</div>' +
    '<div class="account-avatar-wrap"><div class="account-avatar"><img :src="profile.avatar" alt="账号头像" @error="profileAvatarError"></div><span class="account-avatar-status" title="账号在线" aria-label="账号在线"></span></div>' +
    '<div class="account-identity"><div class="account-display-name">{{ profile.displayName }}</div><div class="account-wxid">{{ profile.wxid || "未登录" }}</div></div>' +
    '<div class="account-card-action-row"><button type="button" class="btn btn-primary account-manage-btn" @click="openNoVnc"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg><span>在noVNC中进行管理</span></button></div>' +
    '</div>' +

    '<div class="stat-card clickable home-reveal-card home-reveal-send" @click="goRoute(\'/send\')">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background: sendStats.failed > sendStats.sent * 0.2 && (sendStats.sent + sendStats.failed) > 0 ? \'#ef4444\' : \'#10b981\'}"></span><span class="stat-label">发送概况</span><span class="stat-go">→</span></div>' +
    '<div class="home-send-row">' +
    '<div class="home-send-nums">' +
    '<div class="home-send-big">{{ sendStats.sent }}<span class="home-send-fail" v-if="sendStats.failed"> / {{ sendStats.failed }}</span></div>' +
    '<div class="home-send-meta">' +
    '<span v-if="sendStats.rate !== null">成功率 <b>{{ sendStats.rate }}%</b></span>' +
    '<span v-if="sendStats.lastMs">最近 <b>~{{ (Math.round(sendStats.lastMs / 100) / 10).toFixed(1) }}s</b></span>' +
    '</div>' +
    '<div class="stat-sub">待发 {{ sendStats.pending }}{{ sendStats.processing ? " · 发送中" : " · 空闲" }}</div>' +
    '</div>' +
    '<div class="home-send-bars">' +
    '<div v-for="(b, i) in sendBars" :key="i" class="home-send-bar" :style="{ height: b.h + \'%\' }"></div>' +
    '</div>' +
    '</div>' +
    '</div>' +

    '<div class="stat-card clickable home-reveal-card home-reveal-bot" @click="goRoute(\'/bot\')">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.onebot.color)}"></span><span class="stat-label">Bot 状态</span><span class="stat-go">→</span></div>' +
    '<div class="stat-value">{{ cards.onebot.status || "检测中…" }}</div>' +
    '<div v-if="typeof cards.onebot.sub === \'object\' && cards.onebot.sub.length" class="bot-chip-flow">' +
    '<div v-for="(bs, bi) in cards.onebot.sub" :key="bi" class="bot-chip" :class="botChipClass(bs)" :title="bs.name + \' | \' + botStatusLabel(bs)">' +
    '<span class="bot-chip-mode">{{ botModeLabel(bs) }}</span>' +
    '<span class="bot-chip-name">{{ bs.name }}</span>' +
    '<span class="bot-chip-status">{{ botStatusLabel(bs) }}</span>' +
    '</div>' +
    '</div>' +
    '<div v-else-if="typeof cards.onebot.sub === \'string\' && cards.onebot.sub" class="stat-sub">{{ cards.onebot.sub }}</div>' +
    '</div>' +

    '<div class="stat-card home-reveal-card home-reveal-resources">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background: resColor(cards.system.cpu) === \'var(--danger)\' || resColor(cards.system.ram) === \'var(--danger)\' || resColor(cards.system.disk) === \'var(--danger)\' ? \'#ef4444\' : (resColor(cards.system.cpu) === \'var(--warn)\' || resColor(cards.system.ram) === \'var(--warn)\' || resColor(cards.system.disk) === \'var(--warn)\' ? \'#fbbf24\' : \'#10b981\')}"></span><span class="stat-label">资源水位</span></div>' +
    '<div class="home-res-row">' +
    '<div class="home-res-item"><span class="home-res-name">CPU</span><span class="home-res-val" :style="{color: resColor(cards.system.cpu)}">{{ cards.system.cpu }}%</span></div>' +
    '<div class="home-res-item"><span class="home-res-name">内存</span><span class="home-res-val" :style="{color: resColor(cards.system.ram)}">{{ cards.system.ram }}%</span></div>' +
    '<div class="home-res-item"><span class="home-res-name">存储</span><span class="home-res-val" :style="{color: resColor(cards.system.disk)}">{{ cards.system.disk }}%</span></div>' +
    '</div>' +
    '<div class="home-res-bar"><span class="home-res-bar-label">CPU</span><span class="home-res-bar-value" :title="cards.system.cpuModel">{{ cards.system.cpuModel }}</span></div>' +
    '<div class="home-res-bar"><span class="home-res-bar-label">运行</span><span class="home-res-bar-value">{{ cards.system.uptime }}</span></div>' +
    '</div>' +

    '<div class="stat-card home-reveal-card home-reveal-versions">' +
    '<div class="stat-header"><span class="stat-dot" style="background:#3498db"></span><span class="stat-label">版本与账号</span></div>' +
    '<div class="version-row"><span class="version-label">账号</span><span class="version-val">{{ cards.account.status || "检测中…" }}</span></div>' +
    '<div class="version-row"><span class="version-label">FlowBot</span><span class="version-val">{{ flowbotVersion }}</span></div>' +
    '<div class="version-row"><span class="version-label">WeFlow</span><span class="version-val">{{ weflowVersion }}</span></div>' +
    '<div class="version-row"><span class="version-label">微信</span><span class="version-val">{{ wechatVersion }}</span></div>' +
    '</div>' +

    '</div></div>'
}

var BotPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var bots = ref([])
    var showPanel = ref(false)
    var editingBotId = ref(null)
    var panelMode = ref('http')
    var panelDirection = ref('server')
    var panelName = ref('')
    var panelPort = ref(7100)
    var panelUrl = ref('ws://127.0.0.1:6199/ws')
    var panelToken = ref('')
    var panelSaving = ref(false)

    async function loadBots() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error && d.bots) {
        try {
          var parsed = typeof d.bots === 'string' ? JSON.parse(d.bots) : d.bots
          if (Array.isArray(parsed)) bots.value = parsed
        } catch (_) {}
      }
      try {
        var st = await api('/api/v1/mgmt/bots/status')
        if (st && st.success && Array.isArray(st.bots)) {
          var statusMap = {}
          st.bots.forEach(function (b) { statusMap[b.id] = b })
          bots.value.forEach(function (b) {
            var s = statusMap[b.id]
            if (s) { b.status = s.status; b.connectionStatus = s.connectionStatus; b.clientCount = s.clientCount; b.error = s.error }
            else if (!b.status) { b.status = 'stopped'; b.connectionStatus = 'disconnected' }
          })
        }
      } catch (e) {}
    }

    var botStatusTimer = null
    onMounted(function () {
      botStatusTimer = setInterval(function () {
      if (!bots.value.length) return
      api('/api/v1/mgmt/bots/status').then(function (st) {
        if (st && st.success && Array.isArray(st.bots)) {
          var statusMap = {}
          st.bots.forEach(function (b) { statusMap[b.id] = b })
          bots.value.forEach(function (b) {
            var s = statusMap[b.id]
            if (s) { b.status = s.status; b.connectionStatus = s.connectionStatus; b.clientCount = s.clientCount; b.error = s.error }
            else if (!b.status) { b.status = 'stopped'; b.connectionStatus = 'disconnected' }
          })
        }
      }).catch(function () {})
      }, 5000)
    })
    onUnmounted(function () {
      if (botStatusTimer) clearInterval(botStatusTimer)
    })

    function openAddPanel() {
      editingBotId.value = null
      panelMode.value = 'http'
      panelDirection.value = 'server'
      panelName.value = 'Bot ' + (bots.value.length + 1)
      panelPort.value = 7100
      panelUrl.value = 'ws://127.0.0.1:6199/ws'
      panelToken.value = generateToken()
      showPanel.value = true
    }

    function editBot(botItem) {
      editingBotId.value = botItem.id
      panelMode.value = botItem.mode
      panelDirection.value = botItem.direction || 'server'
      panelName.value = botItem.name
      if (botItem.mode === 'http' || botItem.mode === 'plugin') {
        panelPort.value = Number(botItem.port) || 7100
        panelUrl.value = ''
      } else {
        panelUrl.value = botItem.url || ('ws://' + botItem.address + ':' + botItem.port + '/ws')
        panelPort.value = Number(botItem.port) || 6199
      }
      panelToken.value = botItem.token || generateToken()
      showPanel.value = true
    }

    function closePanel() { showPanel.value = false; editingBotId.value = null }

    function onPanelModeChange(mode) {
      panelMode.value = mode
      if (mode === 'http') { panelPort.value = 7100; panelDirection.value = 'server' }
      else if (mode === 'plugin') { panelPort.value = 7400; panelDirection.value = 'server' }
      else if (mode === 'ws') { panelPort.value = 6199; panelDirection.value = 'client'; panelUrl.value = 'ws://127.0.0.1:6199/ws' }
    }

    function onPanelDirChange(dir) { panelDirection.value = dir }
    function regenerateToken() { panelToken.value = generateToken() }

    async function saveBots() {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bots: JSON.stringify(bots.value) })
      })
      if (d.success) {
        await api('/api/v1/mgmt/bots/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        toast('Bot 配置已保存')
        loadBots()
      } else { toast('保存失败: ' + (d.error || ''), 'error') }
    }

    async function savePanel() {
      panelSaving.value = true
      var isPortBased = panelMode.value === 'http' || panelMode.value === 'plugin'
      var address = '127.0.0.1', port = 6199, url = panelUrl.value
      if (isPortBased) { address = '0.0.0.0'; port = Number(panelPort.value) || 7100; url = '' }
      else {
        var urlMatch = panelUrl.value.match(/^(wss?):\/\/([^:\/]+):?(\d+)(\/.*)?$/)
        address = urlMatch ? urlMatch[2] : '127.0.0.1'
        port = urlMatch ? parseInt(urlMatch[3]) : 6199
      }
      if (editingBotId.value) {
        bots.value = bots.value.map(function (b) {
          if (b.id === editingBotId.value) {
            return Object.assign({}, b, { name: panelName.value || b.name, mode: panelMode.value, direction: panelDirection.value, url: url, address: address, port: port, token: panelToken.value })
          }
          return b
        })
      } else {
        var id = 'bot_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
        bots.value = bots.value.concat([{ id: id, name: panelName.value || 'Bot ' + (bots.value.length + 1), mode: panelMode.value, direction: panelDirection.value, url: url, address: address, port: port, token: panelToken.value, enabled: true }])
      }
      await saveBots()
      panelSaving.value = false
      showPanel.value = false
      editingBotId.value = null
    }

    async function toggleBot(botItem) { botItem.enabled = !botItem.enabled; await saveBots() }

    async function deleteBot(botItem) {
      if (!confirm('确认删除 Bot "' + botItem.name + '"？')) return
      bots.value = bots.value.filter(function (b) { return b.id !== botItem.id })
      await saveBots()
    }

    async function testBot(botItem) {
      toast('正在测试连接...', 'info')
      if (botItem.mode === 'plugin') {
        try {
          var host = window.location.hostname || '127.0.0.1'
          var port = Number(botItem.port) || 7400
          var res = await fetch('http://' + host + ':' + port + '/api/v1/sessions', { headers: botItem.token ? { Authorization: 'Bearer ' + botItem.token } : {} })
          if (res.ok) toast(botItem.name + ': 已连接', 'success')
          else toast(botItem.name + ': 未连接（HTTP ' + res.status + '）', 'error')
        } catch (e) { toast(botItem.name + ': 未连接', 'error') }
        return
      }
      var d = await api('/api/v1/mgmt/bots/status')
      if (d.success && d.bots) {
        var bot = d.bots.find(function(b) { return b.id === botItem.id })
        if (bot) {
          var status = bot.connectionStatus || bot.status || 'unknown'
          if (status === 'connected' || status === 'running') toast(bot.name + ': 已连接', 'success')
          else toast(bot.name + ': 未连接', 'error')
        } else toast(botItem.name + ': 未运行', 'error')
      } else toast('检测失败', 'error')
    }

    function modeBadge(m) { return m === 'http' ? 'badge-http' : (m === 'plugin' ? 'badge-plugin' : 'badge-ws') }
    function modeLabel(m) { return m === 'http' ? 'HTTP' : (m === 'plugin' ? '插件API' : 'WS') }
    function dirBadge(d) { return d === 'server' ? 'badge-server' : 'badge-client' }
    function dirLabel(d) { return d === 'server' ? '服务端' : '客户端' }

    onMounted(loadBots)
    return {
      bots: bots, showPanel: showPanel, editingBotId: editingBotId,
      panelMode: panelMode, panelDirection: panelDirection,
      panelName: panelName, panelPort: panelPort,
      panelUrl: panelUrl, panelToken: panelToken, panelSaving: panelSaving,
      openAddPanel: openAddPanel, closePanel: closePanel, editBot: editBot,
      onPanelModeChange: onPanelModeChange, onPanelDirChange: onPanelDirChange,
      regenerateToken: regenerateToken, savePanel: savePanel,
      toggleBot: toggleBot, deleteBot: deleteBot, testBot: testBot,
      modeBadge: modeBadge, modeLabel: modeLabel,
      dirBadge: dirBadge, dirLabel: dirLabel, loadBots: loadBots
    }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">Bot 配置</h1><p class="subtitle">管理多个 OneBot v11 连接与插件 API</p></div>' +
    '<div class="header-actions"><button class="btn btn-secondary" @click="loadBots">刷新</button></div></div>' +
    '<div v-for="b in bots" :key="b.id" class="bot-card">' +
    '<div class="bot-info">' +
    '<div class="bot-name">{{ b.name }}</div>' +
    '<div class="bot-meta">' +
    '<span :class="[\'badge\', modeBadge(b.mode)]">{{ modeLabel(b.mode) }}</span>' +
    '<span :class="[\'badge\', dirBadge(b.direction)]">{{ dirLabel(b.direction) }}</span>' +
    '<span>{{ b.url || (b.address + \':\' + b.port) }}</span>' +
    '<span v-if="b.connectionStatus === \'connected\'" class="badge badge-server">已连接{{ b.clientCount ? \' (\' + b.clientCount + \')\' : \'\' }}</span>' +
    '<span v-else-if="b.connectionStatus === \'disconnected\'" class="badge badge-client">未连接</span>' +
    '<span v-else-if="b.status === \'stopped\'" class="badge badge-client">未运行</span>' +
    '<span v-else class="badge badge-client">未知</span>' +
    '</div></div>' +
    '<div class="bot-actions">' +
    '<button class="btn btn-secondary btn-sm" @click="editBot(b)" title="编辑 Bot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
    '<button class="btn btn-secondary btn-sm" @click="testBot(b)" title="测试连接"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></button>' +
    '<toggle-switch :model-value="b.enabled" @update:model-value="toggleBot(b)" />' +
    '<button class="btn btn-danger btn-sm" @click="deleteBot(b)">&times;</button>' +
    '</div></div>' +
    '<button v-if="!showPanel" class="add-bot-btn" @click="openAddPanel">+ 添加 Bot</button>' +
    '<transition name="panel-slide">' +
    '<div v-if="showPanel" class="bot-config-panel">' +
    '<div class="panel-header"><h3>{{ editingBotId ? "编辑 Bot" : "添加 Bot" }}</h3>' +
    '<button class="panel-close-btn" @click="closePanel">&times;</button></div>' +
        '<div class="panel-row">' +
    '<div class="panel-field"><label class="panel-label">连接模式</label>' +
    '<div class="panel-capsule">' +
    '<button :class="[\'lg-capsule-btn\', { active: panelMode===\'http\' }]" @click="onPanelModeChange(\'http\')" :disabled="!!editingBotId">HTTP</button>' +
    '<button :class="[\'lg-capsule-btn\', { active: panelMode===\'plugin\' }]" @click="onPanelModeChange(\'plugin\')" :disabled="!!editingBotId">插件API</button>' +
    '<button :class="[\'lg-capsule-btn\', { active: panelMode===\'ws\' }]" @click="onPanelModeChange(\'ws\')" :disabled="!!editingBotId">WS</button>' +
    '</div>' +
    '<div v-if="panelMode===\'http\' || panelMode===\'plugin\'" class="panel-hint" style="margin-top:6px">' +
    "{{ panelMode === 'plugin' ? '插件 API：AstrBot 适配器统一消息服务端（HTTP+WS），Token 与适配器一致' : 'OneBot HTTP 服务端：OneBot v11 协议端口，机器人框架按 OneBot 标准接入' }}</div>" +
    '</div>' +
    '<div class="panel-field"><label class="panel-label">连接方向</label>' +
    '<div class="panel-capsule">' +
    '<button :class="[\'lg-capsule-btn\', { active: panelDirection===\'server\' }]" @click="onPanelDirChange(\'server\')" :disabled="!!editingBotId || panelMode===\'ws\'">服务端</button>' +
    '<button :class="[\'lg-capsule-btn\', { active: panelDirection===\'client\' }]" @click="onPanelDirChange(\'client\')" :disabled="!!editingBotId || panelMode!==\'ws\'">客户端</button>' +
    '</div></div></div>' +
    '<div class="panel-sep"></div>' +
    '<div class="panel-grid">' +
    '<div class="panel-field"><label class="panel-label">名称</label>' +
    '<input type="text" v-model="panelName" placeholder="Bot 1" class="panel-input"></div>' +
    '<div class="panel-field"><label class="panel-label">{{ panelMode===\'ws\' ? \'URL\' : \'端口\' }}</label>' +
    '<input v-if="panelMode===\'ws\'" type="text" v-model="panelUrl" placeholder="ws://127.0.0.1:6199/ws" class="panel-input">' +
    '<input v-else type="number" v-model.number="panelPort" :placeholder="panelMode===\'plugin\'?\'7400\':\'7100\'" min="1" max="65535" class="panel-input"></div>' +
    '<div class="panel-field"><label class="panel-label">Token</label>' +
    '<div class="panel-input-group"><input type="text" v-model="panelToken" placeholder="自动生成" class="panel-input" style="flex:1">' +
    '<button class="panel-icon-btn" @click="regenerateToken" title="重新生成"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></button>' +
    '</div></div></div>' +
    '<div class="panel-sep"></div>' +
    '<div class="panel-actions">' +
    '<button class="btn btn-secondary" @click="closePanel">取消</button>' +
    '<button class="btn btn-primary" @click="savePanel" :disabled="panelSaving">{{ panelSaving ? \'保存中...\' : (editingBotId ? \'更新配置\' : \'保存配置\') }}</button>' +
    '</div></div></transition></div>'
}

var SettingsPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var imgTransfer = reactive({
      mode: 'base64',
      baseUrl: ''
    })
    var baseUrlError = ref(false)
    var flowbot = reactive({
      enabled: true,
      prefix: '#flowbot',
      template: 'FlowBot 状态\n版本: {version}\n平台: {platform}\n运行时长: {uptime}',
      allowGroups: true,
      allowPrivate: true
    })
    var showTplModal = ref(false)
    var tplExpanded = ref(false)
    var tplState = ref('closed')
    var tplOrigin = reactive({ x: '100%', y: '100%' })
    var tplText = ref('')
    var tplRestoreConfirm = ref(false)
    var liveVars = reactive({ version: '-', platform: '-', uptime: '-', weflowVersion: '-' })
    var securityModal = ref(false)
    var securityExpanded = ref(false)
    var securityState = ref('closed')
    var securityOrigin = reactive({ x: '100%', y: '100%' })
    var securityRedirectMessage = ref('')
    var securitySaving = ref(false)
    var securityError = ref('')
    var passwordForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
    var tplShellHeight = ref(null)
    var tplClosedHeight = ref(0)
    var securityShellHeight = ref(null)
    var securityClosedHeight = ref(0)
    var tplOriginStyle = computed(function () {
      return {
        '--tpl-origin-x': tplOrigin.x,
        '--tpl-origin-y': tplOrigin.y
      }
    })
    var securityOriginStyle = computed(function () {
      return {
        '--tpl-origin-x': securityOrigin.x,
        '--tpl-origin-y': securityOrigin.y
      }
    })
    var tplShellStyle = computed(function () {
      return tplShellHeight.value == null ? {} : { height: tplShellHeight.value + 'px' }
    })
    var securityShellStyle = computed(function () {
      return securityShellHeight.value == null ? {} : { height: securityShellHeight.value + 'px' }
    })

    function measureShellHeight(shell) {
      return shell ? Math.round(shell.getBoundingClientRect().height) : 0
    }

    function expandedShellHeight(shell) {
      var raw = shell ? getComputedStyle(shell).getPropertyValue('--settings-editor-height') : ''
      var parsed = parseFloat(raw)
      return parsed > 0 ? parsed : 430
    }

    function expandShell(shell, heightRef, closedHeightRef) {
      if (!shell) {
        heightRef.value = 430
        closedHeightRef.value = 430
        return
      }
      var closedHeight = measureShellHeight(shell)
      closedHeightRef.value = closedHeight
      heightRef.value = closedHeight
      nextTick(function () {
        heightRef.value = Math.max(closedHeight, expandedShellHeight(shell))
      })
    }

    function collapseShell(shell, heightRef, closedHeightRef) {
      if (!shell) return
      heightRef.value = measureShellHeight(shell)
      nextTick(function () {
        heightRef.value = closedHeightRef.value > 0 ? closedHeightRef.value : 0
      })
    }

    async function loadConfig() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        imgTransfer.mode = d.mediaTransferMode || d.imageTransferMode || 'base64'
        imgTransfer.baseUrl = d.mediaServerBaseUrl || d.imageServerBaseUrl || ''
        if (d.flowbotCommand) {
          flowbot.enabled = d.flowbotCommand.enabled !== false
          flowbot.prefix = d.flowbotCommand.prefix || '#flowbot'
          flowbot.template = d.flowbotCommand.template || 'FlowBot 状态\n版本: {version}\n平台: {platform}\n运行时长: {uptime}'
          flowbot.allowGroups = d.flowbotCommand.allowGroups !== false
          flowbot.allowPrivate = d.flowbotCommand.allowPrivate !== false
        }
      }
    }

    async function saveConfig() {
      if (imgTransfer.mode === 'url' && !imgTransfer.baseUrl.trim()) {
        baseUrlError.value = true
        toast('启用 URL 传输模式必须填写对外可达地址', 'error')
        return
      }
      baseUrlError.value = false

      var trimmedUrl = imgTransfer.baseUrl.trim()
      if (imgTransfer.mode === 'url' && trimmedUrl) {
        try {
          var parsed = new URL(trimmedUrl)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            toast('地址必须以 http:// 或 https:// 开头', 'error')
            baseUrlError.value = true
            return
          }
        } catch (e) {
          toast('地址格式无效，请填写完整的 URL（如 http://你的IP:7400）', 'error')
          baseUrlError.value = true
          return
        }
      }

      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaTransferMode: imgTransfer.mode,
          mediaServerBaseUrl: trimmedUrl,
          flowbotCommand: {
            enabled: flowbot.enabled,
            prefix: flowbot.prefix || '#flowbot',
            template: flowbot.template || 'FlowBot 状态\n版本: {version}\n平台: {platform}\n运行时长: {uptime}',
            allowGroups: flowbot.allowGroups !== false,
            allowPrivate: flowbot.allowPrivate !== false,
            allowedSessions: []
          }
        })
      })
      if (d.success) toast('配置已保存')
      else toast('保存失败: ' + (d.error || ''), 'error')
    }

    async function restart(target) {
      var d = await api('/api/restart/' + target, { method: 'POST' })
      if (!d.error) toast(d.message || '正在重启，请等待重新启动')
      else toast('重启失败: ' + (d.error || ''), 'error')
    }

    function openNoVnc() {
      window.open(getNoVncUrl(), '_blank')
    }

    function openPasswordModal(event) {
      if (securityState.value === 'opening' || securityState.value === 'closing') return
      passwordForm.oldPassword = ''
      passwordForm.newPassword = ''
      passwordForm.confirmPassword = ''
      securityError.value = ''
      securityRedirectMessage.value = ''
      var button = event && event.currentTarget
      var shell = button && button.closest ? button.closest('.settings-security-shell') : null
      if (button && shell) {
        var buttonRect = button.getBoundingClientRect()
        var shellRect = shell.getBoundingClientRect()
        securityOrigin.x = Math.round(buttonRect.left + buttonRect.width / 2 - shellRect.left) + 'px'
        securityOrigin.y = Math.round(buttonRect.top + buttonRect.height / 2 - shellRect.top) + 'px'
      } else {
        securityOrigin.x = '100%'
        securityOrigin.y = '100%'
      }
      expandShell(shell, securityShellHeight, securityClosedHeight)
      securityExpanded.value = true
      securityModal.value = true
      securityState.value = 'opening'
    }

    function beginSecurityClose() {
      if (securityState.value === 'closed' || securityState.value === 'closing') return
      var shell = document.querySelector('.settings-security-shell')
      collapseShell(shell, securityShellHeight, securityClosedHeight)
      securityState.value = 'closing'
      securityModal.value = false
    }

    function closePasswordModal() {
      if (securitySaving.value) return
      beginSecurityClose()
    }

    async function changePassword() {
      if (securitySaving.value) return
      securityError.value = ''
      if (!passwordForm.oldPassword) {
        securityError.value = '请输入当前密码'
        return
      }
      if (passwordForm.newPassword !== passwordForm.confirmPassword) {
        securityError.value = '两次输入的新密码不一致'
        return
      }
      if (!/^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{10,20}$/.test(passwordForm.newPassword)) {
        securityError.value = '密码需为 10–20 位，且同时包含大写字母、小写字母、数字和特殊字符'
        return
      }
      if (passwordForm.oldPassword === passwordForm.newPassword) {
        securityError.value = '新密码不能与旧密码相同'
        return
      }
      securitySaving.value = true
      var d = await api('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: passwordForm.oldPassword,
          newPassword: passwordForm.newPassword,
          confirmPassword: passwordForm.confirmPassword
        })
      })
      securitySaving.value = false
      if (d.ok && d.relogin) {
        var message = d.message || '密码已修改，请使用新密码重新登录'
        securityRedirectMessage.value = message
        try { localStorage.setItem('weflow-login-notice', message) } catch (_) {}
        localStorage.removeItem('weflow-auth-token')
        beginSecurityClose()
      } else {
        securityError.value = d.error || '密码修改失败'
      }
    }

    function finishSecurityOpen() {
      securityState.value = 'open'
      var el = document.getElementById('security-old-password')
      if (el) el.focus()
    }

    function finishSecurityClose() {
      securityState.value = 'closed'
      securityExpanded.value = false
      nextTick(function () {
        securityShellHeight.value = null
      })
      if (securityRedirectMessage.value) {
        var message = securityRedirectMessage.value
        securityRedirectMessage.value = ''
        toast(message)
        window.location.hash = '#/login'
      }
    }

    async function refreshLiveVars() {
      try {
        var sv = await api('/api/system')
        if (sv.system) {
          liveVars.version = sv.system.version || '-'
          liveVars.uptime = sv.system.containerUptime || '-'
          liveVars.weflowVersion = sv.system.weflowVersion || '-'
          try { liveVars.platform = sv.system.platform || (typeof process !== 'undefined' && process.platform) || 'linux' } catch { liveVars.platform = 'linux' }
        }
      } catch {}
    }

    async function openTplEditor(event) {
      if (tplState.value === 'opening' || tplState.value === 'closing') return
      tplText.value = flowbot.template
      tplRestoreConfirm.value = false
      var button = event && event.currentTarget
      var shell = button && button.closest ? button.closest('.settings-command-shell') : null
      if (button && shell) {
        var buttonRect = button.getBoundingClientRect()
        var shellRect = shell.getBoundingClientRect()
        tplOrigin.x = Math.round(buttonRect.left + buttonRect.width / 2 - shellRect.left) + 'px'
        tplOrigin.y = Math.round(buttonRect.top + buttonRect.height / 2 - shellRect.top) + 'px'
      } else {
        tplOrigin.x = '100%'
        tplOrigin.y = '100%'
      }
      expandShell(shell, tplShellHeight, tplClosedHeight)
      tplExpanded.value = true
      showTplModal.value = true
      tplState.value = 'opening'
      await refreshLiveVars()
    }

    function insertVar(v) {
      var el = document.getElementById('flowbot-tpl-textarea')
      if (!el) { tplText.value += v; return }
      var start = el.selectionStart || tplText.value.length
      var end = el.selectionEnd || tplText.value.length
      var text = tplText.value
      tplText.value = text.substring(0, start) + v + text.substring(end)
      setTimeout(function () {
        el.focus()
        el.selectionStart = el.selectionStart + v.length
        el.selectionEnd = el.selectionStart
      }, 0)
    }

    function confirmResetTpl() {
      tplRestoreConfirm.value = true
    }

    function resetTpl() {
      tplText.value = 'FlowBot 状态\n版本: {version}\n平台: {platform}\n运行时长: {uptime}'
      tplRestoreConfirm.value = false
    }

    function beginTplClose() {
      if (tplState.value === 'closed' || tplState.value === 'closing') return
      var shell = document.querySelector('.settings-command-shell')
      collapseShell(shell, tplShellHeight, tplClosedHeight)
      tplState.value = 'closing'
      showTplModal.value = false
    }

    function cancelTplEditor() {
      beginTplClose()
    }

    function saveTpl() {
      flowbot.template = tplText.value
      if (tplState.value === 'open' || tplState.value === 'opening') {
        beginTplClose()
      }
      toast('模板已编辑，请点击「保存配置」持久化', 'info')
    }

    function finishTplOpen() {
      tplState.value = 'open'
      var el = document.getElementById('flowbot-tpl-textarea')
      if (el) el.focus()
    }

    function finishTplClose() {
      tplState.value = 'closed'
      tplExpanded.value = false
      nextTick(function () {
        tplShellHeight.value = null
      })
    }

    onMounted(loadConfig)
    return {
      imgTransfer: imgTransfer,
      baseUrlError: baseUrlError,
      saveConfig: saveConfig,
      restart: restart,
      flowbot: flowbot,
      showTplModal: showTplModal,
      tplExpanded: tplExpanded,
      tplState: tplState,
      tplOriginStyle: tplOriginStyle,
      tplShellStyle: tplShellStyle,
      tplText: tplText,
      tplRestoreConfirm: tplRestoreConfirm,
      liveVars: liveVars,
      openTplEditor: openTplEditor,
      refreshLiveVars: refreshLiveVars,
      insertVar: insertVar,
      confirmResetTpl: confirmResetTpl,
      resetTpl: resetTpl,
      cancelTplEditor: cancelTplEditor,
      saveTpl: saveTpl,
      finishTplOpen: finishTplOpen,
      finishTplClose: finishTplClose,
      openNoVnc: openNoVnc,
      novncPort: getNoVncPort(),
      securityModal: securityModal,
      securityExpanded: securityExpanded,
      securityState: securityState,
      securityOriginStyle: securityOriginStyle,
      securityShellStyle: securityShellStyle,
      securitySaving: securitySaving,
      securityError: securityError,
      passwordForm: passwordForm,
      openPasswordModal: openPasswordModal,
      closePasswordModal: closePasswordModal,
      changePassword: changePassword,
      finishSecurityOpen: finishSecurityOpen,
      finishSecurityClose: finishSecurityClose
    }
  },
  template: '<div class="settings-page-inner">' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">设置</h1><p class="subtitle">系统与服务配置</p></div>' +
    '<div class="header-actions"><button class="btn btn-primary" @click="saveConfig">保存配置</button></div></div>' +

    '<div class="settings-security-shell" :class="{ \'is-editing\': securityExpanded, \'is-closing\': securityState === \'closing\' }" :style="securityShellStyle">' +
    '<div class="card settings-security-card">' +
    '<h2>安全性</h2>' +
    '<p class="security-settings-copy">WebUI 密码采用容器绑定加密存储，并使用单会话登录保护。修改密码后需要重新登录。</p>' +
    '<div class="security-settings-actions">' +
    '<span class="security-settings-status"><i></i>密码保护已启用</span>' +
    '<button class="btn btn-secondary btn-sm" @click="openPasswordModal($event)">修改密码</button>' +
    '</div></div>' +
    '<transition name="tpl-expand" @after-enter="finishSecurityOpen" @after-leave="finishSecurityClose">' +
    '<div v-if="securityModal" class="tpl-editor-overlay security-editor-overlay" :style="securityOriginStyle" @click.self="closePasswordModal">' +
    '<div class="tpl-editor-panel security-editor-panel" @click.stop>' +
    '<div class="tpl-editor-head"><div><h3>修改 WebUI 密码</h3><p>新密码需为 10–20 位，并同时包含大写字母、小写字母、数字和特殊字符。</p></div></div>' +
    '<label for="security-old-password">当前密码</label>' +
    '<input id="security-old-password" type="password" v-model="passwordForm.oldPassword" autocomplete="current-password" @input="securityError=\'\'">' +
    '<label for="security-new-password">新密码</label>' +
    '<input id="security-new-password" type="password" v-model="passwordForm.newPassword" autocomplete="new-password" placeholder="输入新密码" @input="securityError=\'\'">' +
    '<label for="security-confirm-password">确认新密码</label>' +
    '<input id="security-confirm-password" type="password" v-model="passwordForm.confirmPassword" autocomplete="new-password" placeholder="再次输入新密码" @input="securityError=\'\'" @keyup.enter="changePassword">' +
    '<div v-if="securityError" class="security-modal-error">{{ securityError }}</div>' +
    '<div class="tpl-editor-actions">' +
    '<span class="tpl-actions-spacer"></span>' +
    '<button class="btn btn-secondary" @click="closePasswordModal" :disabled="securitySaving">取消</button>' +
    '<button class="btn btn-primary" @click="changePassword" :disabled="securitySaving">{{ securitySaving ? \'修改中...\' : \'确认修改\' }}</button>' +
    '</div>' +
    '</div></div></transition>' +
    '</div>' +

    '<div class="card novnc-settings-card settings-novnc-inline">' +
    '<div class="novnc-settings-hero"><span class="novnc-settings-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg></span><div class="novnc-settings-copy"><h2>虚拟桌面</h2><p>通过浏览器完成微信登录与账号切换</p></div><span class="novnc-status-pill"><i></i>服务可用</span></div>' +
    '<div class="novnc-meta-grid"><div class="novnc-meta-item"><span>访问端口</span><strong>{{ novncPort }}</strong></div><div class="novnc-meta-item"><span>连接方式</span><strong>HTML5</strong></div><div class="novnc-meta-item"><span>账号读取</span><strong>自动同步</strong></div></div>' +
    '<button type="button" class="btn btn-primary account-manage-btn novnc-settings-btn" @click="openNoVnc"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg><span>在noVNC中进行管理</span></button>' +
    '<p class="novnc-settings-footnote">登录或切换账号后返回首页，当前账号会自动读取。</p>' +
    '</div>' +

    '<div class="card settings-media-card"><h2>媒体传输模式</h2>' +
    '<div class="form-row" style="align-items:flex-start">' +
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:100px;margin-right:12px">' +
    '<label style="margin-bottom:0">传输模式</label>' +
    '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">' +
    '作用于图片与语音段：Base64 传输（默认，无需额外配置）；URL 传输（消息体缩小至 ~150 字节）。视频恒走 URL 直链，不随此模式' +
    '</span>' +
    '</div>' +
    '<select v-model="imgTransfer.mode">' +
    '<option value="base64">Base64</option>' +
    '<option value="url">URL</option>' +
    '</select>' +
    '</div>' +
    '<div class="form-row" style="margin-top:12px;align-items:flex-start">' +
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:100px;margin-right:12px">' +
    '<label style="margin-bottom:0">对外可达地址</label>' +
    '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">' +
    '媒体内容（图片/语音/视频）的对外可达地址，推送直链与插件通道共用。请填写从 AstrBot 所在机器能访问到的 IP 和端口。格式: http://&lt;宿主机IP&gt;:7400' +
    '</span>' +
    '</div>' +
    '<input type="text" v-model="imgTransfer.baseUrl" ' +
    'placeholder="http://你的IP:7400" ' +
    ':class="{ \'input-error\': baseUrlError }" ' +
    ':disabled="imgTransfer.mode === \'base64\'">' +
    '</div>' +
    '</div>' +

    '<div class="settings-command-shell" :class="{ \'is-editing\': tplExpanded, \'is-closing\': tplState === \'closing\' }" :style="tplShellStyle">' +
    '<div class="card settings-command-card"><h2>状态信息命令</h2>' +
    '<div class="form-row"><label>启用命令</label><toggle-switch v-model="flowbot.enabled" /></div>' +
    '<div class="form-row" style="align-items:flex-start">' +
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:100px;margin-right:12px">' +
    '<label style="margin-bottom:0">触发命令</label>' +
    '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">建议前缀为"#"达到最佳效果</span>' +
    '</div>' +
    '<input type="text" v-model="flowbot.prefix" placeholder="#flowbot">' +
    '</div>' +
    '<div class="form-row"><label>允许群聊</label><toggle-switch v-model="flowbot.allowGroups" /></div>' +
    '<div class="form-row"><label>允许私聊</label><toggle-switch v-model="flowbot.allowPrivate" /></div>' +
    '<div class="form-row"><label>响应模板</label><button class="btn btn-secondary btn-sm" @click="openTplEditor($event)">编辑模板</button></div>' +
    '</div>' +
    '<transition name="tpl-expand" @after-enter="finishTplOpen" @after-leave="finishTplClose">' +
    '<div v-if="showTplModal" class="tpl-editor-overlay" :style="tplOriginStyle" @click.self="cancelTplEditor">' +
    '<div class="tpl-editor-panel" @click.stop>' +
    '<div class="tpl-editor-head"><div><h3>编辑响应模板</h3><p>点击变量按钮插入到文本框光标位置。</p></div></div>' +
    '<div class="tpl-editor-vars">' +
    '<button class="tpl-var-chip" @click="insertVar(\'{version}\')">FlowBot版本：{version}</button>' +
    '<button class="tpl-var-chip" @click="insertVar(\'{platform}\')">系统平台：{platform}</button>' +
    '<button class="tpl-var-chip" @click="insertVar(\'{uptime}\')">运行时长：{uptime}</button>' +
    '<button class="tpl-var-chip" @click="insertVar(\'{weflowVersion}\')">WeFlow版本：{weflowVersion}</button>' +
    '</div>' +
    '<textarea id="flowbot-tpl-textarea" v-model="tplText" class="tpl-editor-textarea"></textarea>' +
    '<div v-if="tplRestoreConfirm" class="tpl-restore-confirm">' +
    '<span>确认恢复为默认模板？当前编辑内容将丢失。</span>' +
    '<div><button class="btn btn-danger-secondary btn-sm" @click="tplRestoreConfirm=false">取消</button>' +
    '<button class="btn btn-primary btn-sm tpl-confirm-reset" @click="resetTpl">确认恢复</button></div>' +
    '</div>' +
    '<div class="tpl-editor-actions">' +
    '<button v-if="!tplRestoreConfirm" class="btn btn-danger-secondary btn-sm tpl-restore-btn" @click="confirmResetTpl">恢复默认</button>' +
    '<span class="tpl-actions-spacer"></span>' +
    '<button class="btn btn-secondary" @click="cancelTplEditor">取消</button>' +
    '<button class="btn btn-primary" @click="saveTpl">保存模板</button>' +
    '</div>' +
    '</div></div></transition>' +
    '</div>' +

    '<div class="card settings-restart-card"><h2>重启服务</h2>' +
    '<div class="restart-module">' +
    '<button class="btn btn-restart-weflow" @click="restart(\'weflow\')">重启 WeFlow</button>' +
    '<button class="btn btn-restart-wechat" @click="restart(\'wechat\')">重启 微信</button>' +
    '</div></div>' +

    '</div>'
}

var AboutPage = {
  setup: function () {
    var info = reactive({
      flowbotVersion: '-', version: '-', protocol: 'OneBot v11.0',
      node: '-', uptime: '-', memory: '-', disk: '-',
      cpuModel: '-', wechatVersion: '-',
      attestOk: null, attestText: '未知',
      oneBotPort: '7100', flowPort: '5031', webUiPort: '7300', noVncPort: '7600'
    })

    async function load() {
      var s = await api('/api/system')
      if (!s.error && s.system) {
        var sys = s.system
        info.flowbotVersion = sys.version || '-'
        info.version = sys.weflowVersion || '-'
        info.wechatVersion = sys.wechatVersion || '-'
        info.node = sys.node ? sys.node.replace('v', '') || '-' : '-'
        info.uptime = sys.containerUptime || (sys.uptime || '').replace('up ', '') || '-'
        if (sys.memory && typeof sys.memory === 'object') {
          info.memory = sys.memory.used + 'MB / ' + sys.memory.total + 'MB (' + sys.memory.usedPercent + '%)'
        } else {
          info.memory = '-'
        }
        info.disk = (typeof sys.disk === 'object') ? (sys.disk.used + 'MB / ' + sys.disk.total + 'MB (' + sys.disk.usedPercent + '%)') : (sys.disk || '-')
        info.cpuModel = sys.cpuModel || '-'
      }
      var v = await api('/api/version')
      if (!v.error) {
        info.oneBotPort = v.onebot_port || info.oneBotPort
        info.flowPort = v.flow_port || info.flowPort
        info.webUiPort = v.webui_port || info.webUiPort
        info.noVncPort = v.novnc_port || info.noVncPort
      }
      try {
        var a = await api('/api/attest')
        if (a && !a.error) {
          var last = a.last || {}
          info.attestOk = !!last.ok
          var expired = !!a.expired || !!last.expired
          var exp = last.expires_at ? new Date(last.expires_at) : null
          var usable = !!last.ok || (exp && Date.now() < exp.getTime())
          var reasons = {
            ok: '正常',
            'client-proof-failed': '校验不通过（客户端证明错误）',
            'asar-mismatch': '程序文件指纹不一致',
            'wcdb-not-patched': 'WCDB 期限未延展',
            'connect-error': '认证模块不可达',
            timeout: '认证模块超时',
            'server-proof-failed': '校验不通过（服务端证明错误）',
            'missing-secret-or-asar': '缺少认证材料',
            expired: '已到期'
          }
          var why = reasons[last.reason] || last.reason || '未知'
          // 到期状态只在本页如实展示，不显示具体时刻
          if (expired) {
            info.attestText = '本地认证已到期'
          } else if (!last.checked_at) {
            info.attestText = '尚未校验'
          } else if (last.ok) {
            info.attestText = '本地认证通过'
          } else if (usable) {
            info.attestText = '认证异常：' + why
          } else {
            info.attestText = '认证异常，功能已暂停：' + why
          }
        }
      } catch (e) { /* ignore */ }
    }

    onMounted(load)
    return { info: info }
  },
  template: '<div>' +
    '<h1 class="page-title">关于</h1>' +

    '<div class="card about-card" style="text-align:center">' +
    '<div class="about-logo"><img src="icon.png" alt="FlowBOT"></div>' +
    '<h2 style="border:none;padding:0;justify-content:center;text-align:center">FlowBOT | {{ info.flowbotVersion }}</h2>' +
    '<p class="text-muted">基于 WeFlow & OneBot v11 制作的聊天机器人</p>' +
    '<div class="about-info">' +
    '<div class="info-row"><span>WeFlow 版本</span><span>{{ info.version }}</span></div>' +
    '<div class="info-row"><span>微信版本</span><span>{{ info.wechatVersion }}</span></div>' +
    '<div class="info-row"><span>认证情况</span><span>{{ info.attestText }}</span></div>' +
    '<div class="info-row"><span>协议</span><span>{{ info.protocol }}</span></div>' +
    '<div class="info-row"><span>Node.js</span><span>{{ info.node }}</span></div>' +
    '<div class="info-row"><span>容器运行时间</span><span>{{ info.uptime }}</span></div>' +
    '<div class="info-row"><span>CPU</span><span>{{ info.cpuModel }}</span></div>' +
    '<div class="info-row"><span>内存</span><span>{{ info.memory }}</span></div>' +
    '<div class="info-row"><span>存储</span><span>{{ info.disk }}</span></div>' +
    '</div>' +
    '<div class="about-links">' +
    '<a href="https://github.com/hicccc77/WeFlow" target="_blank">WeFlow</a>' +
    '<span> &middot; </span>' +
    '<a href="https://github.com/botuniverse/onebot-11" target="_blank">OneBot v11</a>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>免责声明</h2>' +
    '<p style="font-size:13px;color:var(--text-muted);line-height:1.8;margin:0">' +
    'WeFlow 是一款开源的微信聊天记录管理工具，FlowBot 旨在提供了一个能够让用户**学习并研究**能够与AI机器人进行聊天的协议，仅供个人学习和研究使用。用户在使用本工具时应当遵守相关法律法规，不得将本工具用于任何非法用途。' +
    '</p>' +
    '<p style="font-size:13px;color:var(--text-muted);line-height:1.8;margin:12px 0 0">' +
    '使用本工具即表示您同意以下条款：' +
    '</p>' +
    '<ol style="font-size:13px;color:var(--text-muted);line-height:1.8;padding-left:20px;margin:4px 0 0">' +
    '<li>本工具仅供个人学习和研究使用，不得用于商业用途</li>' +
    '<li>用户应自行承担使用本工具产生的一切后果</li>' +
    '<li>本工具不收集、存储或传输用户的任何个人数据</li>' +
    '<li>本工具的开发者不对因使用本工具而造成的任何损失负责</li>' +
    '</ol></div>' +

    '<div class="card"><h2>端口映射</h2>' +
    '<div class="port-grid">' +
    '<div class="port-item"><span>OneBot</span><span class="port">{{ info.oneBotPort }}</span></div>' +
    '<div class="port-item"><span>WeFlow API</span><span class="port">{{ info.flowPort }}</span></div>' +
    '<div class="port-item"><span>WebUI</span><span class="port">{{ info.webUiPort }}</span></div>' +
    '<div class="port-item"><span>noVNC</span><span class="port">{{ info.noVncPort }}</span></div>' +
    '</div></div>' +
    '</div>'
}

var PRESETS = {
  safe: { interMessage: 800, searchOpen: 400, searchSettle: 600, selectSettle: 400, focusMove: 80, inputClick: 200, textClipSettle: 100, pasteSettle: 300, imageClipSettle: 200, imagePasteSettle: 500, postSendSettle: 500 },
  standard: { interMessage: 800, searchOpen: 200, searchSettle: 350, selectSettle: 250, focusMove: 80, inputClick: 150, textClipSettle: 100, pasteSettle: 200, imageClipSettle: 200, imagePasteSettle: 400, postSendSettle: 500 },
  aggressive: { interMessage: 500, searchOpen: 120, searchSettle: 200, selectSettle: 150, focusMove: 50, inputClick: 90, textClipSettle: 60, pasteSettle: 120, imageClipSettle: 120, imagePasteSettle: 400, postSendSettle: 300 }
}

var SendManagerPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var mode = ref('standard')
    var custom = ref({})
    var params = reactive({})
    var autoDowngrade = ref(true)
    var mergeEnabled = ref(false)
    var dedupEnabled = ref(false)
    var priorityEnabled = ref(false)
    var backpressureEnabled = ref(false)
    var dynamicIntervalEnabled = ref(false)
    var bpParams = reactive({ threshold: 3, cooldownMs: 10000, backoffBaseMs: 1500, imagePasteCapMs: 1500, imageMaxBytes: 5, imageCompressEnabled: true, imageCompressKeepResolution: true, imageCompressFormat: 'png', imageCompressPaletteMax: 256, imageUrlTimeoutMs: 15000, imageCdnDirectFetchEnabled: false, imageCdnDirectFetchTimeoutMs: 30000, imageCdnDirectFetchMinIntervalMs: 3000, imageCdnDirectFetchHourlyLimit: 30, imageCdnDirectFetchDiagMd5Log: true, imageCdnDirectFetchPrefer: false, imageLocalDecryptAttempts: 4, videoCalibrationLogEnabled: false, inboundVideoPushEnabled: false, inboundVoicePushEnabled: false, forwardImageMediaEnabled: true, forwardMediaTimeoutMs: 3000 })
    var ackParams = reactive({ enabled: true, probeEnabled: false, timeoutImageMs: 3000, timeoutVideoMs: 10000, extendWaitMs: 10000, timeoutPerMbMs: 800, timeoutMaxMs: 5000, videoTimeoutMaxMs: 20000, probeDiffThreshold: 15, maxRetriesImage: 1, maxRetriesVideo: 1, failOnTimeoutImage: true, failOnTimeoutVideo: true, retryAction: "re-enter" })
    var status = reactive({
      mode: 'standard',
      queue: { pending: 0, processing: false, currentContent: null, lastSendTime: null, items: [] },
      backpressure: { consecutiveFailures: 0, coolRemainingMs: 0, autoDowngrade: true, failureThreshold: 3 },
      options: { merge: false, dedup: false, priority: false, dynamicInterval: false },
      dedupCount: 0,
      stats: { sent: 0, failed: 0 },
      lastSendSteps: [],
      successStreak: 0,
      batch: { contact: null, size: 0 },
      pinyinCacheSize: 0
    })
    var saving = ref(false)
    var clearingQueue = ref(false)
    var clearingPinyin = ref(false)

    var profileLabels = [
      { key: 'interMessage', label: '队列消息间隔' },
      { key: 'searchOpen', label: '打开搜索' },
      { key: 'searchSettle', label: '搜索结果等待' },
      { key: 'selectSettle', label: '选中联系人' },
      { key: 'focusMove', label: '聚焦移动' },
      { key: 'inputClick', label: '点击输入框' },
      { key: 'textClipSettle', label: '文本剪贴板' },
      { key: 'pasteSettle', label: '文本粘贴后发送' },
      { key: 'imageClipSettle', label: '图片剪贴板' },
      { key: 'imagePasteSettle', label: '图片粘贴后发送' },
      { key: 'postSendSettle', label: '发送后稳定' }
    ]

    /* ── 采样器：3s 轮询差分 → 5 分钟环形缓冲（100 点）────────────────── */
    var samples = ref([])
    var sessionSent = ref(0)
    var sessionFailed = ref(0)
    var prevStats = null

    function pushSample() {
      var s = status.stats
      if (prevStats) {
        var dSent = Math.max(0, s.sent - prevStats.sent)
        var dFail = Math.max(0, s.failed - prevStats.failed)
        sessionSent.value += dSent
        sessionFailed.value += dFail
        var arr = samples.value.concat([{ t: Date.now(), sent: dSent, fail: dFail, pending: status.queue.pending }])
        if (arr.length > 100) arr = arr.slice(arr.length - 100)
        samples.value = arr
      }
      prevStats = { sent: s.sent, failed: s.failed }
    }

    /* ── 健康环：红绿灯判定（冷却 > 不稳定 > 积压 > 发送中 > 空闲）────── */
    var health = computed(function () {
      var bp = status.backpressure
      if (bp.coolRemainingMs > 0) {
        return { level: 'danger', label: '冷却中', detail: Math.ceil(bp.coolRemainingMs / 1000) + 's 后恢复' }
      }
      var threshold = bp.failureThreshold || bpParams.threshold || 3
      if (bp.consecutiveFailures >= Math.max(1, Math.ceil(threshold * 0.6))) {
        return { level: 'warn', label: '不稳定', detail: '连续失败 ' + bp.consecutiveFailures + ' 次' }
      }
      if (status.queue.pending > 20) {
        return { level: 'warn', label: '队列积压', detail: '待发 ' + status.queue.pending + ' 条' }
      }
      if (status.queue.processing) {
        return { level: 'ok', label: '发送中', detail: status.batch.contact || '' }
      }
      return { level: 'ok', label: '空闲正常', detail: '队列空' }
    })
    var healthClass = computed(function () {
      return 'health-' + health.value.level + (status.queue.processing && health.value.level === 'ok' ? ' processing' : '')
    })

    /* ── 成功/失败 donut（本次会话增量）───────────────────────────────── */
    var donut = computed(function () {
      var total = sessionSent.value + sessionFailed.value
      if (!total) return null
      var c = 2 * Math.PI * 36
      var frac = sessionSent.value / total
      return {
        rate: Math.round(frac * 100),
        segs: [
          { color: 'var(--accent)', dasharray: (c * frac).toFixed(2) + ' ' + c.toFixed(2), dashoffset: 0 },
          { color: 'var(--danger)', dasharray: (c * (1 - frac)).toFixed(2) + ' ' + c.toFixed(2), dashoffset: (-c * frac).toFixed(2) }
        ]
      }
    })

    /* ── 队列积压迷你柱（最近 26 个采样）──────────────────────────────── */
    var queueBars = computed(function () {
      var arr = samples.value.slice(-26)
      if (!arr.length) return []
      var maxP = 1
      for (var i = 0; i < arr.length; i++) maxP = Math.max(maxP, arr[i].pending)
      var out = []
      for (var j = 0; j < arr.length; j++) {
        out.push({ h: Math.max(4, Math.round(arr[j].pending / maxP * 100)), warn: arr[j].pending > 20 })
      }
      return out
    })

    /* ── 吞吐趋势面积图（SVG path）────────────────────────────────────── */
    var trend = computed(function () {
      var arr = samples.value
      if (arr.length < 2) return null
      var W = 560, H = 140, pad = 6
      var maxS = 1, maxP = 1
      for (var i = 0; i < arr.length; i++) {
        maxS = Math.max(maxS, arr[i].sent + arr[i].fail)
        maxP = Math.max(maxP, arr[i].pending)
      }
      var stepX = W / (arr.length - 1)
      var line = '', pend = ''
      for (var j = 0; j < arr.length; j++) {
        var x = (j * stepX).toFixed(1)
        line += (j ? ' L ' : 'M ') + x + ' ' + (H - pad - (arr[j].sent / maxS) * (H - pad * 2)).toFixed(1)
        pend += (j ? ' L ' : 'M ') + x + ' ' + (H - pad - (arr[j].pending / maxP) * (H - pad * 2)).toFixed(1)
      }
      return { line: line, area: line + ' L ' + W + ' ' + H + ' L 0 ' + H + ' Z', pend: pend, maxS: maxS, maxP: maxP }
    })

    /* ── 发送耗时流水线（lastSendSteps → 分段条）──────────────────────── */
    var PIPE_COLORS = [
      { keys: ['激活窗口'], color: '#60a5fa' },
      { keys: ['搜索联系人', '聚焦输入框'], color: '#a78bfa' },
      { keys: ['粘贴发送'], color: 'var(--accent)' }
    ]
    function pipeColor(step) {
      for (var i = 0; i < PIPE_COLORS.length; i++) {
        if (PIPE_COLORS[i].keys.indexOf(step) !== -1) return PIPE_COLORS[i].color
      }
      return 'var(--success)'
    }
    var pipeline = computed(function () {
      var steps = status.lastSendSteps
      if (!steps || !steps.length) return null
      var total = 0
      for (var i = 0; i < steps.length; i++) total += (steps[i].ms || 0)
      if (!total) return null
      var segs = []
      for (var j = 0; j < steps.length; j++) {
        segs.push({
          title: steps[j].step + ' ' + steps[j].ms + 'ms',
          pct: Math.max(1.5, (steps[j].ms / total) * 100),
          color: pipeColor(steps[j].step)
        })
      }
      return { segs: segs, total: (Math.round(total / 100) / 10) + 's' }
    })

    /* ── 队列辅助 ─────────────────────────────────────────────────────── */
    var nowElapsed = computed(function () {
      return status.queue.items.length ? status.queue.items[0].queuedSeconds : 0
    })
    function typeLabel(t) { return t === 'image' ? '图' : t === 'video' ? '视频' : '文' }
    function urgencyClass(item) { return item.queuedSeconds > 60 ? 'danger' : item.queuedSeconds > 30 ? 'warn' : '' }

    /* ── 档位胶囊 ─────────────────────────────────────────────────────── */
    var tiers = [
      { key: 'safe', name: '安全', desc: '慢速 · 最稳', icon: '🛡' },
      { key: 'standard', name: '标准', desc: '平衡之选', icon: '⚡' },
      { key: 'aggressive', name: '激进', desc: '快速 · 高风险', icon: '🚀' }
    ]
    var TIER_NAMES = { safe: '安全', standard: '标准', aggressive: '激进' }
    function tierName(m) { return TIER_NAMES[m] || m }
    function setTier(key) {
      mode.value = key
      custom.value = {}
      customEditing.value = false
      initParams()
    }
    var customEditing = ref(false)
    var overriddenKeys = computed(function () {
      var preset = PRESETS[mode.value] || PRESETS.standard
      var out = {}
      for (var i = 0; i < profileLabels.length; i++) {
        var k = profileLabels[i].key
        if (params[k] !== undefined && params[k] !== '' && Number(params[k]) !== preset[k]) out[k] = true
      }
      return out
    })

    /* ── 折叠区与摘要 ─────────────────────────────────────────────────── */
    var secRhythm = ref(false)
    var secStrategy = ref(false)
    var secBp = ref(false)
    var secAck = ref(false)
    var secCdn = ref(false)
    var showCdnRiskModal = ref(false)
    watch(function () { return bpParams.imageCdnDirectFetchPrefer }, function (val) { if (val) showCdnRiskModal.value = true })
    function cancelCdnRisk() { showCdnRiskModal.value = false; bpParams.imageCdnDirectFetchPrefer = false }
    function confirmCdnRisk() { showCdnRiskModal.value = false }
    var secVid = ref(false)
    var strategySummary = computed(function () {
      var n = (mergeEnabled.value ? 1 : 0) + (dedupEnabled.value ? 1 : 0) + (priorityEnabled.value ? 1 : 0) + (dynamicIntervalEnabled.value ? 1 : 0)
      return '开启 ' + n + ' / 4 项'
    })
    var bpSummary = computed(function () {
      if (status.backpressure.coolRemainingMs > 0) return '冷却中 ' + Math.ceil(status.backpressure.coolRemainingMs / 1000) + 's'
      return backpressureEnabled.value ? '阈值 ' + bpParams.threshold + ' · 冷却 ' + Math.round(bpParams.cooldownMs / 1000) + 's' : '已关闭'
    })
    var ackSummary = computed(function () {
      if (!ackParams.enabled) return '已关闭'
      return '图 ' + Math.round(ackParams.timeoutImageMs / 1000) + 's · 视频 ' + Math.round(ackParams.timeoutVideoMs / 1000) + 's'
    })
    var cdnSummary = computed(function () {
      if (!bpParams.imageCdnDirectFetchEnabled) return '已关闭（实验）'
      return '开启 · 超时 ' + Math.round(bpParams.imageCdnDirectFetchTimeoutMs / 1000) + 's'
    })
    var vidSummary = computed(function () {
      var parts = []
      if (bpParams.inboundVideoPushEnabled) parts.push('视频推送开')
      if (bpParams.inboundVoicePushEnabled) parts.push('语音推送开')
      if (bpParams.videoCalibrationLogEnabled) parts.push('标定日志开')
      parts.push(bpParams.forwardImageMediaEnabled ? ('含图还原开 · 延时闸 ' + ((bpParams.forwardMediaTimeoutMs || 3000) / 1000) + 's') : '含图还原关')
      return parts.length ? parts.join(' · ') : '已关闭'
    })

    function initParams() {
      var preset = PRESETS[mode.value] || PRESETS.standard
      for (var i = 0; i < profileLabels.length; i++) {
        var key = profileLabels[i].key
        params[key] = (custom.value[key] !== undefined) ? custom.value[key] : preset[key]
      }
    }

    async function loadMode() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        if (d.sendDelayMode) mode.value = d.sendDelayMode
        autoDowngrade.value = d.sendAutoDowngrade !== false
        mergeEnabled.value = d.sendMerge === true
        dedupEnabled.value = d.sendDedup === true
        priorityEnabled.value = d.sendPriority === true
        backpressureEnabled.value = d.sendBackpressureEnabled === true
        dynamicIntervalEnabled.value = d.sendDynamicInterval === true
        bpParams.threshold = d.sendFailureThreshold || 3
        bpParams.cooldownMs = d.sendCooldownMs || 10000
        bpParams.backoffBaseMs = d.sendBackoffBaseMs || 1500
        bpParams.imagePasteCapMs = d.imagePasteCapMs || 1500
        bpParams.imageMaxBytes = (d.imageMaxBytes && d.imageMaxBytes > 0) ? Math.round(d.imageMaxBytes / (1024 * 1024)) : 5
        bpParams.imageCompressEnabled = d.imageCompressEnabled !== false
        bpParams.imageCompressKeepResolution = d.imageCompressKeepResolution !== false
        bpParams.imageCompressFormat = d.imageCompressFormat || 'png'
        bpParams.imageCompressPaletteMax = d.imageCompressPaletteMax || 256
        bpParams.imageUrlTimeoutMs = d.imageUrlTimeoutMs || 15000
        bpParams.imageCdnDirectFetchEnabled = d.imageCdnDirectFetchEnabled === true
        bpParams.imageCdnDirectFetchTimeoutMs = d.imageCdnDirectFetchTimeoutMs || 30000
        bpParams.imageCdnDirectFetchMinIntervalMs = (d.imageCdnDirectFetchMinIntervalMs !== undefined) ? d.imageCdnDirectFetchMinIntervalMs : 3000
        bpParams.imageCdnDirectFetchHourlyLimit = d.imageCdnDirectFetchHourlyLimit || 30
        bpParams.imageCdnDirectFetchDiagMd5Log = d.imageCdnDirectFetchDiagMd5Log !== false
        bpParams.imageCdnDirectFetchPrefer = d.imageCdnDirectFetchPrefer === true
        bpParams.imageLocalDecryptAttempts = (d.imageLocalDecryptAttempts !== undefined) ? d.imageLocalDecryptAttempts : 4
        bpParams.videoCalibrationLogEnabled = d.videoCalibrationLogEnabled === true
        bpParams.inboundVideoPushEnabled = d.inboundVideoPushEnabled === true
        bpParams.inboundVoicePushEnabled = d.inboundVoicePushEnabled === true
        bpParams.forwardImageMediaEnabled = d.forwardImageMediaEnabled !== false
        bpParams.forwardMediaTimeoutMs = d.forwardMediaTimeoutMs || 3000
        ackParams.enabled = d.sendAckEnabled !== false
        ackParams.probeEnabled = d.sendAckInputClearProbeEnabled === true
        ackParams.timeoutImageMs = d.sendAckTimeoutMsImage || 3000
        ackParams.timeoutVideoMs = d.sendAckTimeoutMsVideo || 10000
        ackParams.extendWaitMs = d.sendAckExtendWaitMs || 10000
        ackParams.timeoutPerMbMs = d.sendAckTimeoutPerMbMs || 800
        ackParams.timeoutMaxMs = d.sendAckTimeoutMaxMs || 5000
        ackParams.videoTimeoutMaxMs = d.sendAckVideoTimeoutMaxMs || 20000
        ackParams.probeDiffThreshold = d.sendAckProbeDiffThreshold === undefined ? 15 : Math.round(d.sendAckProbeDiffThreshold * 100)
        ackParams.maxRetriesImage = d.sendAckImageMaxRetries === undefined ? 1 : d.sendAckImageMaxRetries
        ackParams.maxRetriesVideo = d.sendAckVideoMaxRetries === undefined ? 1 : d.sendAckVideoMaxRetries
        ackParams.failOnTimeoutImage = d.sendAckImageFailOnTimeout !== false
        ackParams.failOnTimeoutVideo = d.sendAckVideoFailOnTimeout !== false
        ackParams.retryAction = d.sendAckRetryAction || 're-enter'
        custom.value = (d.sendDelayCustom && typeof d.sendDelayCustom === 'object') ? d.sendDelayCustom : {}
        initParams()
        markBaseline()
      }
    }

    async function loadStatus() {
      var d = await api('/api/v1/mgmt/send-status')
      if (!d.error && d.status) {
        status.mode = d.status.mode || 'standard'
        status.queue.pending = (d.status.queue && d.status.queue.pending) || 0
        status.queue.processing = !!(d.status.queue && d.status.queue.processing)
        status.queue.currentContent = (d.status.queue && d.status.queue.currentContent) || null
        status.queue.lastSendTime = (d.status.queue && d.status.queue.lastSendTime) || null
        status.queue.items = (d.status.queue && Array.isArray(d.status.queue.items)) ? d.status.queue.items : []
        status.backpressure = (d.status.backpressure && {
          consecutiveFailures: d.status.backpressure.consecutiveFailures || 0,
          coolRemainingMs: d.status.backpressure.coolRemainingMs || 0,
          autoDowngrade: d.status.backpressure.autoDowngrade !== false,
          failureThreshold: d.status.backpressure.failureThreshold || 3
        }) || { consecutiveFailures: 0, coolRemainingMs: 0, autoDowngrade: true, failureThreshold: 3 }
        status.options = (d.status.options && {
          merge: d.status.options.merge === true,
          dedup: d.status.options.dedup === true,
          priority: d.status.options.priority === true,
          dynamicInterval: d.status.options.dynamicInterval === true
        }) || { merge: false, dedup: false, priority: false, dynamicInterval: false }
        status.dedupCount = d.status.dedupCount || 0
        status.stats = (d.status.stats && {
          sent: d.status.stats.sent || 0,
          failed: d.status.stats.failed || 0
        }) || { sent: 0, failed: 0 }
        status.lastSendSteps = (Array.isArray(d.status.lastSendSteps)) ? d.status.lastSendSteps : []
        status.successStreak = d.status.successStreak || 0
        status.batch = (d.status.batch && {
          contact: d.status.batch.contact || null,
          size: d.status.batch.size || 0
        }) || { contact: null, size: 0 }
        status.pinyinCacheSize = d.status.pinyinCacheSize || 0
        pushSample()
        if (status.backpressure.coolRemainingMs > 0) secBp.value = true
      }
    }

    function buildCustom() {
      var preset = PRESETS[mode.value] || PRESETS.standard
      var out = {}
      for (var i = 0; i < profileLabels.length; i++) {
        var key = profileLabels[i].key
        var raw = params[key]
        if (raw === '' || raw === undefined || raw === null) continue
        var n = Number(raw)
        if (Number.isFinite(n) && n >= 0 && n !== preset[key]) out[key] = n
      }
      return out
    }

    function buildConfigPayload() {
      return {
        sendDelayMode: mode.value,
        sendDelayCustom: buildCustom(),
        sendAutoDowngrade: autoDowngrade.value,
        sendMerge: mergeEnabled.value,
        sendDedup: dedupEnabled.value,
        sendPriority: priorityEnabled.value,
        sendBackpressureEnabled: backpressureEnabled.value,
        sendDynamicInterval: dynamicIntervalEnabled.value,
        sendFailureThreshold: Math.max(1, Number(bpParams.threshold) || 3),
        sendCooldownMs: Math.max(1000, Number(bpParams.cooldownMs) || 10000),
        sendBackoffBaseMs: Math.max(100, Number(bpParams.backoffBaseMs) || 1500),
        imagePasteCapMs: Math.max(400, Number(bpParams.imagePasteCapMs) || 1500),
        imageMaxBytes: Math.max(1, Math.min(20, Number(bpParams.imageMaxBytes) || 5)) * (1024 * 1024),
        imageCompressEnabled: !!bpParams.imageCompressEnabled,
        imageCompressKeepResolution: !!bpParams.imageCompressKeepResolution,
        imageCompressFormat: ['png', 'jpeg', 'auto'].includes(bpParams.imageCompressFormat) ? bpParams.imageCompressFormat : 'png',
        imageCompressPaletteMax: Math.max(2, Math.min(256, Number(bpParams.imageCompressPaletteMax) || 256)),
        imageUrlTimeoutMs: Math.max(1000, Number(bpParams.imageUrlTimeoutMs) || 15000),
        imageCdnDirectFetchEnabled: !!bpParams.imageCdnDirectFetchEnabled,
        imageCdnDirectFetchTimeoutMs: Math.max(5000, Math.min(120000, Number(bpParams.imageCdnDirectFetchTimeoutMs) || 30000)),
        imageCdnDirectFetchMinIntervalMs: isFinite(Number(bpParams.imageCdnDirectFetchMinIntervalMs)) ? Math.max(0, Math.min(60000, Number(bpParams.imageCdnDirectFetchMinIntervalMs))) : 3000,
        imageCdnDirectFetchHourlyLimit: Math.max(1, Math.min(600, Number(bpParams.imageCdnDirectFetchHourlyLimit) || 30)),
        imageCdnDirectFetchDiagMd5Log: bpParams.imageCdnDirectFetchDiagMd5Log !== false,
        imageCdnDirectFetchPrefer: !!bpParams.imageCdnDirectFetchPrefer,
        imageLocalDecryptAttempts: Math.max(1, Math.min(10, Number(bpParams.imageLocalDecryptAttempts) || 4)),
        videoCalibrationLogEnabled: bpParams.videoCalibrationLogEnabled === true,
        inboundVideoPushEnabled: bpParams.inboundVideoPushEnabled === true,
        inboundVoicePushEnabled: bpParams.inboundVoicePushEnabled === true,
        forwardImageMediaEnabled: bpParams.forwardImageMediaEnabled === true,
        forwardMediaTimeoutMs: bpParams.forwardMediaTimeoutMs || 3000,
        sendAckEnabled: !!ackParams.enabled,
        sendAckInputClearProbeEnabled: !!ackParams.probeEnabled,
        sendAckTimeoutMsImage: Math.max(500, Number(ackParams.timeoutImageMs) || 3000),
        sendAckTimeoutMsVideo: Math.max(500, Number(ackParams.timeoutVideoMs) || 10000),
        sendAckExtendWaitMs: Math.max(0, Number(ackParams.extendWaitMs) || 10000),
        sendAckTimeoutPerMbMs: Math.max(0, Number(ackParams.timeoutPerMbMs) || 800),
        sendAckTimeoutMaxMs: Math.max(1000, Number(ackParams.timeoutMaxMs) || 5000),
        sendAckVideoTimeoutMaxMs: Math.max(1000, Number(ackParams.videoTimeoutMaxMs) || 20000),
        sendAckProbeDiffThreshold: Math.max(1, Math.min(100, Number(ackParams.probeDiffThreshold) || 15)) / 100,
        sendAckImageMaxRetries: Math.max(0, Number(ackParams.maxRetriesImage) || 1),
        sendAckVideoMaxRetries: Math.max(0, Number(ackParams.maxRetriesVideo) || 1),
        sendAckImageFailOnTimeout: !!ackParams.failOnTimeoutImage,
        sendAckVideoFailOnTimeout: !!ackParams.failOnTimeoutVideo,
        sendAckRetryAction: ackParams.retryAction
      }
    }

    /* ── 脏跟踪：修改后悬浮保存条 ─────────────────────────────────────── */
    var baseline = ref('')
    function markBaseline() { baseline.value = JSON.stringify(buildConfigPayload()) }
    var dirty = computed(function () {
      if (!baseline.value) return false
      return JSON.stringify(buildConfigPayload()) !== baseline.value
    })
    function discardChanges() { loadMode() }

    async function saveMode() {
      saving.value = true
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfigPayload())
      })
      saving.value = false
      if (d.success) {
        toast('发送配置已保存，下一条消息生效')
        custom.value = buildCustom()
        markBaseline()
        loadStatus()
      } else {
        toast('保存失败: ' + (d.error || '未知错误'), 'error')
      }
    }

    function resetCustom() {
      custom.value = {}
      initParams()
      customEditing.value = false
    }

    async function clearQueue() {
      clearingQueue.value = true
      var d = await api('/api/v1/mgmt/send-clear-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      clearingQueue.value = false
      if (!d.error) {
        toast('已清空队列（取消 ' + (d.cancelled || 0) + ' 条待发消息）')
        loadStatus()
      } else {
        toast('清空失败: ' + (d.error || '未知错误'), 'error')
      }
    }

    async function clearPinyinCache() {
      clearingPinyin.value = true
      var d = await api('/api/v1/mgmt/send-clear-pinyin-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      clearingPinyin.value = false
      if (!d.error) {
        toast('拼音缓存已清空（' + (d.cleared || 0) + ' 条）')
        loadStatus()
      } else {
        toast('清空失败: ' + (d.error || '未知错误'), 'error')
      }
    }

    function fmtTime(ts) {
      if (!ts) return '-'
      return new Date(ts).toLocaleTimeString()
    }

    var timer = null
    onMounted(function () {
      loadMode()
      loadStatus()
      timer = setInterval(loadStatus, 3000)
    })
    onUnmounted(function () {
      if (timer) clearInterval(timer)
    })

    return {
      mode: mode, params: params, status: status, saving: saving, autoDowngrade: autoDowngrade,
      mergeEnabled: mergeEnabled, dedupEnabled: dedupEnabled, priorityEnabled: priorityEnabled,
      backpressureEnabled: backpressureEnabled, dynamicIntervalEnabled: dynamicIntervalEnabled, bpParams: bpParams,
      clearingQueue: clearingQueue, clearingPinyin: clearingPinyin, ackParams: ackParams,
      profileLabels: profileLabels, saveMode: saveMode, resetCustom: resetCustom,
      clearQueue: clearQueue, clearPinyinCache: clearPinyinCache,
      fmtTime: fmtTime,
      health: health, healthClass: healthClass, donut: donut, sessionSent: sessionSent, sessionFailed: sessionFailed,
      queueBars: queueBars, trend: trend, pipeline: pipeline,
      nowElapsed: nowElapsed, typeLabel: typeLabel, urgencyClass: urgencyClass,
      tiers: tiers, tierName: tierName, setTier: setTier, customEditing: customEditing, overriddenKeys: overriddenKeys,
      secRhythm: secRhythm, secStrategy: secStrategy, secBp: secBp, secAck: secAck, secCdn: secCdn, secVid: secVid,
      showCdnRiskModal: showCdnRiskModal, cancelCdnRisk: cancelCdnRisk, confirmCdnRisk: confirmCdnRisk,
      strategySummary: strategySummary, bpSummary: bpSummary, ackSummary: ackSummary, cdnSummary: cdnSummary, vidSummary: vidSummary,
      dirty: dirty, discardChanges: discardChanges
    }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">消息管理</h1><p class="subtitle">发送流水线状态与节律配置</p></div>' +
    '</div>' +

    '<transition name="fade-slide">' +
    '<div v-if="health.level === \'danger\'" class="bp-alert-banner">' +
    '<span class="bp-alert-icon">⚠</span>' +
    '<span>队列冷却中 · <b>{{ Math.ceil(status.backpressure.coolRemainingMs / 1000) }}s</b> 后恢复 · 连续失败 {{ status.backpressure.consecutiveFailures }} 次 · 自动降档：{{ status.backpressure.autoDowngrade ? "已启用" : "未启用" }}</span>' +
    '</div>' +
    '</transition>' +

    '<div class="send-dashboard">' +
    '<div class="stat-card dash-card" :class="healthClass">' +
    '<div class="ring-wrap">' +
    '<svg class="health-ring" viewBox="0 0 120 120">' +
    '<circle class="ring-track" cx="60" cy="60" r="44"></circle>' +
    '<circle class="ring-fill" cx="60" cy="60" r="44"></circle>' +
    '</svg>' +
    '<div class="ring-center"><div class="ring-label">{{ health.label }}</div><div class="ring-detail">{{ health.detail }}</div></div>' +
    '</div>' +
    '<div class="dash-caption">系统状态</div>' +
    '</div>' +

    '<div class="stat-card dash-card">' +
    '<div class="ring-wrap">' +
    '<svg class="donut" viewBox="0 0 100 100">' +
    '<circle class="ring-track" cx="50" cy="50" r="36"></circle>' +
    '<circle v-for="(s, i) in (donut ? donut.segs : [])" :key="i" class="donut-seg" :stroke="s.color" :stroke-dasharray="s.dasharray" :stroke-dashoffset="s.dashoffset"></circle>' +
    '</svg>' +
    '<div class="ring-center"><div class="ring-label">{{ donut ? donut.rate + "%" : "—" }}</div><div class="ring-detail">成功率</div></div>' +
    '</div>' +
    '<div class="dash-caption">已发 {{ sessionSent }} · 失败 {{ sessionFailed }}<br><span style="font-size:11px">本次会话增量</span></div>' +
    '</div>' +

    '<div class="stat-card dash-card">' +
    '<div class="queue-bars">' +
    '<div v-for="(b, i) in queueBars" :key="i" class="queue-bar" :class="{ warn: b.warn }" :style="{ height: b.h + \'%\' }"></div>' +
    '<div v-if="!queueBars.length" class="chart-empty">采集中…</div>' +
    '</div>' +
    '<div class="dash-caption">队列积压走势 · 待发 <b>{{ status.queue.pending }}</b></div>' +
    '</div>' +

    '<div class="stat-card dash-card dash-misc">' +
    '<div class="misc-row"><span>连续成功</span><b class="ok-text">{{ status.successStreak }}</b></div>' +
    '<div class="misc-row"><span>连续失败</span><b :class="status.backpressure.consecutiveFailures ? \'bad-text\' : \'\'">{{ status.backpressure.consecutiveFailures }}</b></div>' +
    '<div class="misc-row"><span>累计吞吐</span><b>{{ status.stats.sent }} / {{ status.stats.failed }}</b></div>' +
    '<div class="misc-row"><span>已去重</span><b>{{ status.dedupCount }}</b></div>' +
    '<div class="misc-row"><span>最近发送</span><b>{{ fmtTime(status.queue.lastSendTime) }}</b></div>' +
    '<div class="misc-row"><span>拼音缓存</span><span><b>{{ status.pinyinCacheSize }}</b> <button class="btn btn-secondary btn-sm" style="margin-left:6px" :disabled="clearingPinyin" @click="clearPinyinCache">{{ clearingPinyin ? "清空中…" : "清空" }}</button></span></div>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>吞吐趋势 <span class="chart-sub">最近 5 分钟 · 3s 采样</span></h2>' +
    '<svg v-if="trend" class="trend-chart" viewBox="0 0 560 140" preserveAspectRatio="none">' +
    '<path :d="trend.area" class="trend-area"></path>' +
    '<path :d="trend.pend" class="trend-pend"></path>' +
    '<path :d="trend.line" class="trend-line"></path>' +
    '</svg>' +
    '<div v-else class="chart-empty" style="height:140px;display:flex;align-items:center;justify-content:center">采集中，约 10 秒后出图…</div>' +
    '<div class="trend-legend">' +
    '<span><span class="legend-dot accent"></span>成功发送</span>' +
    '<span><span class="legend-dot muted"></span>队列待发</span>' +
    '<span style="margin-left:auto">峰值：{{ trend ? "吞吐 " + trend.maxS + "/3s · 队列 " + trend.maxP : "—" }}</span>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>最近一次发送耗时 <span v-if="status.queue.lastSendTime" class="chart-sub">{{ fmtTime(status.queue.lastSendTime) }}</span></h2>' +
    '<template v-if="pipeline">' +
    '<div class="pipeline">' +
    '<div v-for="(s, i) in pipeline.segs" :key="i" class="pipe-seg" :style="{ width: s.pct + \'%\', background: s.color }" :title="s.title"></div>' +
    '</div>' +
    '<div class="pipeline-legend">' +
    '<span><span class="legend-dot" style="background:#60a5fa"></span>激活</span>' +
    '<span><span class="legend-dot" style="background:#a78bfa"></span>搜索/聚焦</span>' +
    '<span><span class="legend-dot" style="background:var(--accent)"></span>粘贴发送</span>' +
    '<span><span class="legend-dot" style="background:var(--success)"></span>其他</span>' +
    '<span class="pipe-total">总计 ~{{ pipeline.total }}</span>' +
    '</div>' +
    '</template>' +
    '<div v-else class="chart-empty" style="padding:18px 0">暂无发送记录，发送一条消息后显示耗时分解</div>' +
    '</div>' +

    '<div class="card queue-card">' +
    '<div class="queue-head">' +
    '<h2>实时队列 <span v-if="status.queue.pending" class="queue-count-badge">{{ status.queue.pending }}</span></h2>' +
    '<button class="btn btn-danger btn-sm" :disabled="clearingQueue || !status.queue.items.length" @click="clearQueue">{{ clearingQueue ? "清空中…" : "清空队列" }}</button>' +
    '</div>' +
    '<div v-if="status.queue.processing" class="now-sending">' +
    '<span class="pulse-dot"></span>' +
    '<div class="now-main">' +
    '<div class="now-contact">{{ (status.queue.items[0] && status.queue.items[0].contactName) || status.batch.contact || "发送中" }}</div>' +
    '<div class="now-content">{{ status.queue.currentContent || "媒体消息" }}</div>' +
    '</div>' +
    '<div class="now-elapsed">{{ nowElapsed }}s</div>' +
    '</div>' +
    '<div class="queue-list">' +
    '<div v-for="item in status.queue.items" :key="item.id" class="queue-item" :class="urgencyClass(item)">' +
    '<span class="badge" :class="item.type === \'image\' ? \'warn\' : (item.type === \'video\' ? \'video\' : \'ok\')">{{ typeLabel(item.type) }}</span>' +
    '<span class="queue-contact">{{ item.contactName }}</span>' +
    '<span class="queue-preview">{{ item.contentPreview || "—" }}</span>' +
    '<span class="queue-wait">{{ item.queuedSeconds }}s</span>' +
    '</div>' +
    '<div v-if="!status.queue.items.length" class="chart-empty" style="padding:10px 0">队列为空</div>' +
    '</div>' +
    '</div>' +

    '<div class="card config-section">' +
    '<button type="button" class="config-head" @click="secRhythm = !secRhythm">' +
    '<span class="chev" :class="{ open: secRhythm }">▸</span>' +
    '<span class="config-title">发送节奏</span>' +
    '<span class="config-summary">{{ tierName(mode) }} · 降档 {{ autoDowngrade ? "开" : "关" }}</span>' +
    '</button>' +
    '<div v-show="secRhythm" class="config-body">' +
    '<div class="tier-capsules">' +
    '<button v-for="t in tiers" :key="t.key" type="button" class="tier-card" :class="{ active: mode === t.key }" @click="setTier(t.key)">' +
    '<span class="tier-icon">{{ t.icon }}</span>' +
    '<span class="tier-name">{{ t.name }}</span>' +
    '<span class="tier-desc">{{ t.desc }}</span>' +
    '</button>' +
    '</div>' +
    '<div class="config-opt-grid cols1" style="margin-top:6px">' +
    '<div class="strategy-card" :class="{ on: autoDowngrade }">' +
    '<div class="strategy-top"><span class="strategy-name">失败自动降档</span><toggle-switch v-model="autoDowngrade" /></div>' +
    '<div class="strategy-desc">熔断触发时自动切换到更慢的延时档位，避免持续失败；恢复后可手动切回</div>' +
    '</div>' +
    '</div>' +
    '<div class="delay-grid">' +
    '<template v-for="(item, idx) in profileLabels" :key="item.key">' +
    '<div class="delay-group-title" v-if="idx === 6">粘贴发送（剪贴板/粘贴/发送稳定，建议 ≥ 当前值）</div>' +
    '<div class="delay-item">' +
    '<div class="delay-item-label">{{ item.label }}<span class="override-dot" v-if="overriddenKeys[item.key]" title="自定义值"></span></div>' +
    '<div class="delay-item-input">' +
    '<input type="number" min="0" step="10" v-model.number="params[item.key]" :disabled="!customEditing">' +
    '<span class="ms">ms</span>' +
    '</div>' +
    '</div>' +
    '</template>' +
    '</div>' +
    '<div class="custom-edit-bar">' +
    '<span style="font-size:12px;color:var(--text-muted)">{{ customEditing ? "自定义模式：修改值差异项将保存为覆盖参数" : "当前为「" + tierName(mode) + "」预设值" }}</span>' +
    '<button v-if="!customEditing" class="btn btn-secondary btn-sm" @click="customEditing = true">自定义参数</button>' +
    '</div>' +
    '<div style="margin-top:12px">' +
    '<button class="btn btn-secondary" @click="resetCustom">恢复预设值</button>' +
    '</div>' +
    '</div>' +
    '</div>' +

    '<div class="card config-section">' +
    '<button type="button" class="config-head" @click="secStrategy = !secStrategy">' +
    '<span class="chev" :class="{ open: secStrategy }">▸</span>' +
    '<span class="config-title">队列策略</span>' +
    '<span class="config-summary">{{ strategySummary }}</span>' +
    '</button>' +
    '<div v-show="secStrategy" class="config-body">' +
    '<div class="strategy-grid">' +
    '<div class="strategy-card" :class="{ on: mergeEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">连续文本合并</span><toggle-switch v-model="mergeEnabled" /></div>' +
    '<div class="strategy-desc">同一联系人的连续消息复用已打开的聊天窗口，仅首条搜索联系人，后续直接粘贴发送，更快</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: dedupEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">消息去重</span><toggle-switch v-model="dedupEnabled" /></div>' +
    '<div class="strategy-desc">同一联系人同时待发的相同文本只保留第一条，避免重复发送</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: priorityEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">联系人分组优先</span><toggle-switch v-model="priorityEnabled" /></div>' +
    '<div class="strategy-desc">同一联系人的消息（文字+图片）在队列中连续排列，避免图文发送割裂</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: dynamicIntervalEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">动态缩间隔</span><toggle-switch v-model="dynamicIntervalEnabled" /></div>' +
    '<div class="strategy-desc">连续成功时自动缩短消息间隔（下限 300ms），失败后复位</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>' +

    '<div class="card config-section" :class="{ \'section-alert\': status.backpressure.coolRemainingMs > 0 }">' +
    '<button type="button" class="config-head" @click="secBp = !secBp">' +
    '<span class="chev" :class="{ open: secBp }">▸</span>' +
    '<span class="config-title">熔断保护</span>' +
    '<span class="config-summary">{{ bpSummary }}</span>' +
    '</button>' +
    '<div v-show="secBp" class="config-body">' +
    '<div class="config-opt-grid cols1">' +
    '<div class="strategy-card" :class="{ on: backpressureEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">自适应背压</span><toggle-switch v-model="backpressureEnabled" /></div>' +
    '<div class="strategy-desc">发送连续失败达到阈值时暂停队列冷却，并自动降档保护；默认关闭</div>' +
    '</div>' +
    '</div>' +
    '<transition name="fade-slide">' +
    '<div v-show="backpressureEnabled" class="config-opt-grid">' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">失败阈值</span><span class="opt-input"><input type="number" min="1" step="1" v-model.number="bpParams.threshold">次</span></div>' +
    '<div class="strategy-desc">连续失败达到该次数触发队列冷却（默认 3）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">冷却时长</span><span class="opt-input"><input type="number" min="1000" step="1000" v-model.number="bpParams.cooldownMs">ms</span></div>' +
    '<div class="strategy-desc">队列暂停时长，默认 10000（10 秒）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">退避基数</span><span class="opt-input"><input type="number" min="100" step="100" v-model.number="bpParams.backoffBaseMs">ms</span></div>' +
    '<div class="strategy-desc">重试基础间隔，按 1×/2×/4× 递增，上限 6000ms（默认 1500）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">大图粘贴等待上限</span><span class="opt-input"><input type="number" min="400" step="100" v-model.number="bpParams.imagePasteCapMs">ms</span></div>' +
    '<div class="strategy-desc">大图（≥1MB）粘贴后到发送的最大等待；小图用基准不变，默认 1500</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">图片大小上限</span><span class="opt-input"><input type="number" min="1" max="20" step="1" v-model.number="bpParams.imageMaxBytes">MB</span></div>' +
    '<div class="strategy-desc">超过该体积的图片拒绝粘贴（防微信冻结，默认 5MB）；部分插件生成图约 5.26MB，可按需上调至 20MB；也是图片压缩的分界点</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.imageCompressEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">图片压缩（大图）</span><toggle-switch v-model="bpParams.imageCompressEnabled" /></div>' +
    '<div class="strategy-desc">超过图片大小上限的大图，发送前经 ffmpeg 压缩进分界点（默认开；仅大图触发，小图直通零开销）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">压缩格式</span><span class="opt-input"><select v-model="bpParams.imageCompressFormat"><option value="png">PNG（近无损，微信必支持）</option><option value="jpeg">JPEG（照片）</option><option value="auto">自动（内容探测）</option></select></span></div>' +
    '<div class="strategy-desc">漫画/图标/截图用 PNG 降位深；照片用 JPEG；auto 由内容色数探测决定（默认 PNG）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">保分辨率</span><toggle-switch v-model="bpParams.imageCompressKeepResolution" /></div>' +
    '<div class="strategy-desc">压缩不降像素（默认开，保清晰）；关闭后超阈压缩允许降分辨率兜底（画质会下降）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">PNG调色板色数</span><span class="opt-input"><input type="number" min="2" max="256" step="1" v-model.number="bpParams.imageCompressPaletteMax">色</span></div>' +
    '<div class="strategy-desc">PNG 降位深最大色数（默认 256 近无损；低则更小但有色带）</div>' +
    '</div>' +
    '</div>' +
    '</transition>' +
    '</div>' +
    '</div>' +

    '<div class="card config-section">' +
    '<button type="button" class="config-head" @click="secVid = !secVid">' +
    '<span class="chev" :class="{ open: secVid }">▸</span>' +
    '<span class="config-title">媒体链路</span>' +
    '<span class="config-summary">{{ vidSummary }}</span>' +
    '</button>' +
    '<div v-show="secVid" class="config-body">' +
    '<div class="config-opt-grid cols1">' +
    '<div class="strategy-card" :class="{ on: bpParams.inboundVideoPushEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">入站视频推送</span><toggle-switch v-model="bpParams.inboundVideoPushEnabled" /></div>' +
    '<div class="strategy-desc">收到视频时向适配器提供视频文件 URL（/api/media?token=，1h 有效）、封面与元数据（时长/体积）；多数模型不支持视频模态，是否下载与理解由适配器和模型决定；默认关，关闭时视频消息仅显示 [视频]</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.inboundVoicePushEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">入站语音推送</span><toggle-switch v-model="bpParams.inboundVoicePushEnabled" /></div>' +
    '<div class="strategy-desc">收到语音时向适配器提供 WAV 音频（24kHz/16bit/mono，OneBot 走 record 段跟随媒体传输模式，插件通道为 /api/media?token= 直链，1h 有效）与时长元数据，转写/ASR 由 astrbot 侧处理；base64 模式超过 10MB 的音频降级为仅 [语音] 文本；默认关，关闭时语音消息仅显示 [语音]</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.forwardImageMediaEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">合并转发含图还原（实验性）</span><toggle-switch v-model="bpParams.forwardImageMediaEnabled" /></div>' +
    '<div class="strategy-desc">合并转发里的图片条目尝试媒体还原（直链下载 / CDN 直取 / 缩略兜底，成功则条目带 media_url / media_thumb_url 供适配器渲染）。该能力尚不完善（老图受"仅增量"门禁、缩略直取待修，常见 too_old / thumb_only 降级）；关闭后图片条目零延迟只推 [图片] 文本占位，表情直链 / 视频 / 时长元数据与渲染全文不受影响；默认开，可随时热切换</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.videoCalibrationLogEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">视频发送标定日志</span><toggle-switch v-model="bpParams.videoCalibrationLogEnabled" /></div>' +
    '<div class="strategy-desc">发送视频时在容器日志记录源规格（体积/时长/分辨率/码率）与 Enter 时刻（[Calib] 标记），用于量化发送耗时；默认关，仅标定/排查时开启</div>' +
    '</div>' +
    '</div>' +
    '<div class="config-opt-grid">' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">转发媒体延时闸</span><span class="opt-input"><input type="number" min="500" step="500" v-model.number="bpParams.forwardMediaTimeoutMs">ms</span></div>' +
    '<div class="strategy-desc">合并转发媒体还原相对推送的额外延迟硬上限（默认 3000，钳制 500–60000），含单条在途下载也强制生效；超时条目 media_error=skipped、文本行照常秒达。网络慢、想多给下载时间可调大；求快可调小甚至贴近 500</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>' +

    '<div class="card config-section">' +
    '<button type="button" class="config-head" @click="secCdn = !secCdn">' +
    '<span class="chev" :class="{ open: secCdn }">▸</span>' +
    '<span class="config-title">图片入站原图（CDN 直取）</span>' +
    '<span class="config-summary">{{ cdnSummary }}</span>' +
    '</button>' +
    '<div v-show="secCdn" class="config-body">' +
    '<div class="config-opt-grid cols1">' +
    '<div class="strategy-card" :class="{ on: bpParams.imageCdnDirectFetchEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">CDN 直取原图（实验）</span><toggle-switch v-model="bpParams.imageCdnDirectFetchEnabled" /></div>' +
    '<div class="strategy-desc">仅缩略图消息的原图兜底：本地读取（_h.dat > .dat > _t.dat）与 HD 升级全失败、只剩缩略图时，调用内置 ptrace 注入器毫秒级驱动微信自身 CDN 库直取并解密原图（零 hook、零 frida、进程不驻留；需微信在线登录态，默认关）。任何失败都自动降级回缩略图，绝不阻断推送。防护：仅近 10 分钟内的新消息（禁历史回填）、同一图 6 小时内仅尝试一次、最小间隔与每小时上限限流、超时/错误码不重试直接降级</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.imageCdnDirectFetchPrefer }">' +
    '<div class="strategy-top"><span class="strategy-name">优先使用CDN直取获取原图（高风险）</span><toggle-switch v-model="bpParams.imageCdnDirectFetchPrefer" /></div>' +
    '<div class="strategy-desc">收到图片后优先直接向微信 CDN 请求原图，而不是等本地读取全部失败后才兜底。可显著缩短原图到达时间和增加非聊天对话的图片清晰度，但请求模式更激进。原有的时间窗口、单图去重、最小间隔与每小时上限限流仍然生效；任何失败自动回退本地读取/缩略图，不阻断推送。</div>' +
    '</div>' +
    '</div>' +
    '<div class="config-opt-grid">' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">本地解密次数</span><span class="opt-input"><input type="number" min="1" max="10" step="1" v-model.number="bpParams.imageLocalDecryptAttempts">次</span></div>' +
    '<div class="strategy-desc">收到图片后，先在本地尝试读取/解密原图的最大次数（含首次，每次间隔 1 秒，默认 4）。调低更快进入 CDN 直取兜底或缩略图、推送延迟更低，但对「原图稍后才落盘」的兼容变差；调高给微信延迟落盘的原图更多机会、原图命中率更高，但推送最多多等相应秒数。若同时开启「优先使用 CDN 直取」，本项在直取失败后的回退路径中继续生效</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">直取超时</span><span class="opt-input"><input type="number" min="5000" step="1000" v-model.number="bpParams.imageCdnDirectFetchTimeoutMs">ms</span></div>' +
    '<div class="strategy-desc">直取请求发起到产物落盘的等待上限，期间每 500ms 轮询、尺寸稳定即判定完成（默认 30000，钳制 5000–120000）。超时即放弃该图并降级缩略图——不重试，避免对同一 CDN 对象反复请求</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">最小间隔</span><span class="opt-input"><input type="number" min="0" step="500" v-model.number="bpParams.imageCdnDirectFetchMinIntervalMs">ms</span></div>' +
    '<div class="strategy-desc">两次直取请求的最小时间间隔（默认 3000，钳制 0–60000；0 为不限间隔，但仍受每小时上限约束）。未到间隔的消息不排队等待，直接降级缩略图</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">每小时上限</span><span class="opt-input"><input type="number" min="1" step="5" v-model.number="bpParams.imageCdnDirectFetchHourlyLimit">张</span></div>' +
    '<div class="strategy-desc">滑动 1 小时窗口内的直取张数上限（默认 30，钳制 1–600）。超限后该小时内的图片全部降级缩略图；运行稳定后可自行逐步提升</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: bpParams.imageCdnDirectFetchDiagMd5Log }">' +
    '<div class="strategy-top"><span class="strategy-name">md5 比对诊断日志</span><toggle-switch v-model="bpParams.imageCdnDirectFetchDiagMd5Log" /></div>' +
    '<div class="strategy-desc">直取成功后，将产物 md5 与消息 XML 声称的 md5 比对并记录日志（仅记录，不参与成败判定——服务端对象与声称值本就无关）。反馈问题时开启此开关，在容器日志中检索「诊断：产物 md5」即可提供该行</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="card config-section">' +
    '<button type="button" class="config-head" @click="secAck = !secAck">' +
    '<span class="chev" :class="{ open: secAck }">▸</span>' +
    '<span class="config-title">媒体发送回执（SendAck）</span>' +
    '<span class="config-summary">{{ ackSummary }}</span>' +
    '</button>' +
    '<div v-show="secAck" class="config-body">' +
    '<div class="config-opt-grid cols1">' +
    '<div class="strategy-card" :class="{ on: ackParams.enabled }">' +
    '<div class="strategy-top"><span class="strategy-name">启用回执</span><toggle-switch v-model="ackParams.enabled" /></div>' +
    '<div class="strategy-desc">图片/视频发送后等待 WCDB 回执确认是否真正发出；关闭则恢复"Enter 即成功"</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: ackParams.probeEnabled }">' +
    '<div class="strategy-top"><span class="strategy-name">输入框探针（防误发）</span><toggle-switch v-model="ackParams.probeEnabled" /></div>' +
    '<div class="strategy-desc">超时未确认时抓屏比对输入框是否仍含媒体。差异 &lt; 阈值(默认15%) 视为"仍在输入框"→ 允许二次 Enter（媒体卡住时差异通常 5%-15%，保二次 Enter 才不会被卡死）；仅差异 ≥ 阈值 才视为"已清空"→ 禁止二次 Enter（默认关，需 xwd 可用）</div>' +
    '</div>' +
    '</div>' +
    '<div class="config-opt-grid">' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">图片回执超时</span><span class="opt-input"><input type="number" min="500" step="500" v-model.number="ackParams.timeoutImageMs">ms</span></div>' +
    '<div class="strategy-desc">图片提交超时（默认 3000，最多 5000）；大图按体积自动加档</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">视频回执超时</span><span class="opt-input"><input type="number" min="500" step="500" v-model.number="ackParams.timeoutVideoMs">ms</span></div>' +
    '<div class="strategy-desc">视频提交超时（默认 10000，视频转码慢）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">体积加档</span><span class="opt-input"><input type="number" min="0" step="100" v-model.number="ackParams.timeoutPerMbMs">ms/MB</span></div>' +
    '<div class="strategy-desc">媒体每超 1MB 追加的超时（默认 800），0 关闭自适应</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">图片超时封顶</span><span class="opt-input"><input type="number" min="1000" step="1000" v-model.number="ackParams.timeoutMaxMs">ms</span></div>' +
    '<div class="strategy-desc">图片自适应超时上限（默认 5000）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">视频超时封顶</span><span class="opt-input"><input type="number" min="1000" step="1000" v-model.number="ackParams.videoTimeoutMaxMs">ms</span></div>' +
    '<div class="strategy-desc">视频自适应超时上限（默认 20000）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">探针差异阈值</span><span class="opt-input"><input type="number" min="1" max="100" step="1" v-model.number="ackParams.probeDiffThreshold">%</span></div>' +
    '<div class="strategy-desc">探针判定"媒体仍在"的差异上限（默认 15%）；低于该值=仍在（可放心 Enter），≥该值=已清空（禁止 Enter）。媒体卡住时差异通常 5%-15%，过低会误判</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">扩展等待</span><span class="opt-input"><input type="number" min="0" step="1000" v-model.number="ackParams.extendWaitMs">ms</span></div>' +
    '<div class="strategy-desc">探针判定"已发出但 WCDB 未确认"后的等待（默认 10000）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">图片失败重试</span><span class="opt-input"><input type="number" min="0" step="1" v-model.number="ackParams.maxRetriesImage">次</span></div>' +
    '<div class="strategy-desc">图片回执失败后的自动重试次数（默认 1）</div>' +
    '</div>' +
    '<div class="strategy-card">' +
    '<div class="strategy-top"><span class="strategy-name">视频失败重试</span><span class="opt-input"><input type="number" min="0" step="1" v-model.number="ackParams.maxRetriesVideo">次</span></div>' +
    '<div class="strategy-desc">视频回执失败后的自动重试次数（默认 1）</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: ackParams.failOnTimeoutImage }">' +
    '<div class="strategy-top"><span class="strategy-name">超时按失败处理（图）</span><toggle-switch v-model="ackParams.failOnTimeoutImage" /></div>' +
    '<div class="strategy-desc">图片回执超时视为发送失败，计入熔断统计并触发重试</div>' +
    '</div>' +
    '<div class="strategy-card" :class="{ on: ackParams.failOnTimeoutVideo }">' +
    '<div class="strategy-top"><span class="strategy-name">超时按失败处理（视频）</span><toggle-switch v-model="ackParams.failOnTimeoutVideo" /></div>' +
    '<div class="strategy-desc">视频回执超时视为发送失败，计入熔断统计并触发重试</div>' +
    '</div>' +
    '<div class="strategy-card" style="grid-column:1 / -1">' +
    '<div class="strategy-top"><span class="strategy-name">兜底动作</span>' +
    '<select v-model="ackParams.retryAction"><option value="re-enter">二次 Enter（不清空，默认）</option><option value="clear-repaste">清空重贴（旧方案）</option><option value="none">只告警</option></select>' +
    '</div>' +
    '<div class="strategy-desc">回执未确认时的兜底动作；重试次数 = 对应 kind 的失败重试 + 1</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>' +

    '<transition name="modal-zoom">' +
    '<div v-if="showCdnRiskModal" class="modal-overlay" @click.self="cancelCdnRisk">' +
    '<div class="modal">' +
    '<h3>⚠️ 开启「优先使用 CDN 直取」风险确认</h3>' +
    '<p style="margin:0 0 10px;font-size:13px;line-height:1.7">开启后，收到图片将<b>跳过本地读取流程</b>，第一时间直接向微信 CDN 服务器请求原图文件（全程无需打开聊天窗口）。</p>' +
    '<p style="margin:0 0 6px;font-size:13px"><b>请了解以下风险：</b></p>' +
    '<p style="margin:0 0 8px;font-size:13px;line-height:1.7"><b>1. 账号风控风险（高风险主因）</b><br>该模式下客户端会以「非浏览」方式持续向服务端请求原图。在活跃群聊、短时间内大量收图的场景下，请求行为与正常使用差异明显，<b>可能触发微信服务端风控，导致账号下载功能受限甚至临时封控</b>。</p>' +
    '<p style="margin:0 0 8px;font-size:13px;line-height:1.7"><b>2. 稳定性</b><br>直取依赖在线登录态与文件时效，可能被拒绝或超时；此时自动回退为本地读取/缩略图，<b>消息接收不受影响</b>。</p>' +
    '<p style="margin:0 0 8px;font-size:13px;line-height:1.7"><b>3. 定位说明</b><br>此功能仅作为可选项提供，<b>我们不鼓励日常开启</b>。仅在确需即时原图且收图量可控时使用；日常使用请保持关闭（默认「本地优先、直取兜底」）。</p>' +
    '<p class="text-muted" style="margin:0;font-size:12px">限流防护（10 分钟时间窗、同图 6 小时去重、最小间隔、每小时上限）在开启后依然生效，可在下方参数中调整。</p>' +
    '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
    '<button class="btn btn-secondary btn-sm" @click="cancelCdnRisk">取消</button>' +
    '<button class="btn btn-primary btn-sm" style="background:var(--danger)" @click="confirmCdnRisk">我已了解风险，仍要开启</button>' +
    '</div></div></div></transition>' +

    '<teleport to="body">' +
    '<transition name="fade-up">' +
    '<div v-if="dirty" class="save-bar">' +
    '<span class="save-bar-dot"></span>' +
    '<span class="save-bar-text">有未保存的更改</span>' +
    '<button class="btn btn-secondary btn-sm" @click="discardChanges">放弃</button>' +
    '<button class="btn btn-primary btn-sm" :disabled="saving" @click="saveMode">{{ saving ? "保存中…" : "保存配置" }}</button>' +
    '</div>' +
    '</transition>' +
    '</teleport>' +
    '</div>'
}

var LogsPage = {
  components: { ToggleSwitch: ToggleSwitch },
  data: function () {
    return {
      logs: [],
      levels: ['info', 'warn', 'error', 'debug'],
      levelLabels: { info: 'Info', warn: 'Warning', error: 'Error', debug: 'Debug' },
      levelColors: { info: '#61affe', warn: '#ffa502', error: '#ff4757', debug: '#8892a4' },
      selectedLevels: ['info', 'warn', 'error', 'debug'],
      search: '',
      autoRefresh: false,
      refreshTimer: null,
      loading: false
    }
  },
  mounted: function () {
    try {
      var savedLevels = localStorage.getItem('weflow-log-levels')
      if (savedLevels) { var l = JSON.parse(savedLevels); if (Array.isArray(l) && l.length) this.selectedLevels = l }
    } catch (e) {}
    this.loadLogs()
  },
  beforeUnmount: function () { if (this.refreshTimer) clearInterval(this.refreshTimer) },
  methods: {
    loadLogs: async function () {
      if (this.selectedLevels.length === 0) {
        this.logs = []
        return
      }
      var params = []
      if (this.selectedLevels.length < this.levels.length) {
        params.push('levels=' + this.selectedLevels.join(','))
      }
      if (this.search) params.push('search=' + encodeURIComponent(this.search))
      params.push('lines=300')
      var url = '/api/v1/mgmt/logs?' + params.join('&')
      var d = await api(url)
      if (d.success) {
        this.logs = d.logs || []
        this.$nextTick(function () {
          var box = document.getElementById('log-box')
          if (box) box.scrollTop = box.scrollHeight
        })
      }
    },
    toggleLevel: function (lv) {
      var idx = this.selectedLevels.indexOf(lv)
      if (idx === -1) this.selectedLevels.push(lv)
      else this.selectedLevels.splice(idx, 1)
      localStorage.setItem('weflow-log-levels', JSON.stringify(this.selectedLevels))
      this.loadLogs()
    },
    searchInput: function () {
      var self = this
      if (self._searchTimer) clearTimeout(self._searchTimer)
      self._searchTimer = setTimeout(function () { self.loadLogs() }, 300)
    },
    clearLogs: async function () {
      var d = await api('/api/v1/mgmt/logs/clear', { method: 'POST' })
      if (!d.error) { this.logs = []; toast('日志已清除') }
      else toast('清除失败: ' + d.error, 'error')
    },
    toggleAutoRefresh: function () {
      if (this.autoRefresh) {
        var self = this
        this.refreshTimer = setInterval(function () { self.loadLogs() }, 5000)
      } else {
        if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null }
      }
    },
    logColor: function (line) {
      if (!line) return 'var(--text-primary)'
      var lv = typeof line === 'object' ? (line.level || '').toLowerCase() : ''
      if (lv === 'error' || lv === 'fatal') return 'var(--danger)'
      if (lv === 'warn') return 'var(--warn)'
      if (lv === 'debug') return 'var(--text-muted)'
      return 'var(--text-primary)'
    },
    levelBadgeColor: function (lv) {
      return this.levelColors[lv] || '#94a3b8'
    }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">日志</h1><p class="subtitle">查看系统运行日志</p></div>' +
    '<div class="header-actions">' +
    '<button class="btn btn-secondary" @click="loadLogs">刷新</button>' +
    '<button class="btn btn-danger" @click="clearLogs">清除日志</button>' +
    '</div></div>' +
    '<div class="card" style="margin-bottom:16px">' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
    '<span v-for="lv in levels" :key="lv" class="log-cat-btn log-level-btn" :class="{active: selectedLevels.indexOf(lv)!==-1}" @click="toggleLevel(lv)" style="cursor:pointer">{{ levelLabels[lv] }}</span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
    '<input type="text" v-model="search" @input="searchInput" placeholder="搜索日志..." ' +
    'style="flex:1;min-width:150px;padding:6px 10px;border-radius:6px;font-size:13px">' +
    '<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)">自动跟踪<toggle-switch v-model="autoRefresh" @change="toggleAutoRefresh" /></span>' +
    '</div></div>' +
    '<div id="log-box" ref="logBox" class="log-box" ' +
    'style="height:calc(100vh - 300px);min-height:300px;overflow-y:auto;font-family:\'SF Mono\',Monaco,monospace;font-size:12.5px;line-height:1.6">' +
    '<div v-if="loading && logs.length===0" style="color:var(--text-muted)">加载中...</div>' +
    '<div v-else-if="logs.length===0" style="color:var(--text-muted)">暂无日志</div>' +
    '<div v-for="(line, i) in logs" :key="i" :style="{color: logColor(line)}" style="font-family:inherit;white-space:pre-wrap;word-break:break-all"><span style="opacity:0.65">[{{ (line.level || \'info\').toUpperCase() }}]</span> {{ typeof line === \'object\' ? line.raw : line }}</div>' +
    '</div>' +
    '</div>'
}

var LoginPage = {
  setup: function () {
    var password = ref('')
    var newPassword = ref('')
    var confirmPassword = ref('')
    var agreementAccepted = ref(false)
    var agreementVisible = ref(false)
    var mode = ref('login')
    var loading = ref(false)
    var checked = ref(false)
    var failed = ref(false)
    var hasError = ref(false)
    var success = ref(false)
    var error = ref('')
    var loginNotice = ref('')

    var policyValid = computed(function () {
      return /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{10,20}$/.test(newPassword.value)
    })
    var passwordsMatch = computed(function () {
      return Boolean(newPassword.value) && newPassword.value === confirmPassword.value
    })
    var firstChangeReady = computed(function () {
      return policyValid.value && passwordsMatch.value && agreementAccepted.value && !loading.value
    })
    var orbDisabled = computed(function () {
      if (loading.value || success.value) return true
      if (mode.value === 'first-change' && !firstChangeReady.value) return true
      return false
    })

    var pageClass = computed(function () {
      return (loading.value ? ' is-loading' : '') +
        (checked.value ? ' is-checked' : '') +
        (failed.value ? ' is-failed' : '') +
        (hasError.value ? ' has-error' : '') +
        (success.value ? ' is-success' : '') +
        (mode.value === 'first-change' ? ' is-first-change' : '')
    })

    function enterFirstChange() {
      mode.value = 'first-change'
      password.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
      agreementAccepted.value = false
      agreementVisible.value = false
      error.value = ''
      checked.value = false
      failed.value = false
      hasError.value = false
      success.value = false
      setTimeout(function () {
        if (mode.value === 'first-change' && !agreementAccepted.value) agreementVisible.value = true
      }, 650)
    }

    async function doLogin() {
      if (loading.value || checked.value || failed.value || success.value) return
      if (!password.value) { error.value = '请输入密码'; return }
      loading.value = true
      error.value = ''
      loginNotice.value = ''
      var started = Date.now()
      var d = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.value })
      })
      var elapsed = Date.now() - started
      if (elapsed < 450) await new Promise(function (done) { setTimeout(done, 450 - elapsed) })
      if (d.ok && d.token) {
        localStorage.setItem('weflow-auth-token', d.token)
        loading.value = false
        checked.value = true
        if (d.mustChange) {
          setTimeout(function () { enterFirstChange() }, 650)
          return
        }
        loginOverlayVisible.value = true
        setTimeout(async function () {
          authTransitionAuthorized = true
          window.location.hash = '#/'
          await nextTick()
          await new Promise(function (resolve) {
            requestAnimationFrame(function () {
              requestAnimationFrame(resolve)
            })
          })
          appShellReveal.value = true
          success.value = true
          setTimeout(function () {
            loginOverlayVisible.value = false
            appShellReveal.value = false
          }, 760)
        }, 360)
      } else {
        loading.value = false
        failed.value = true
        hasError.value = true
        error.value = d.error || '密码错误'
        password.value = ''
        setTimeout(function () { failed.value = false }, 1200)
      }
    }

    async function submitFirstChange() {
      if (loading.value || !firstChangeReady.value) {
        if (!agreementAccepted.value) agreementVisible.value = true
        return
      }
      loading.value = true
      error.value = ''
      var d = await api('/api/auth/first-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newPassword: newPassword.value,
          confirmPassword: confirmPassword.value,
          agreementAccepted: true
        })
      })
      loading.value = false
      if (d.ok && d.relogin) {
        localStorage.removeItem('weflow-auth-token')
        mode.value = 'login'
        password.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
        agreementAccepted.value = false
        error.value = ''
        loginNotice.value = d.message || '密码已修改，请使用新密码重新登录'
        toast(loginNotice.value)
      } else {
        error.value = d.error || '密码修改失败'
      }
    }

    function acceptAgreement() {
      agreementAccepted.value = true
      agreementVisible.value = false
      if (error.value) error.value = ''
    }

    function rejectAgreement() {
      agreementVisible.value = false
    }

    function handleOrb() {
      if (mode.value === 'first-change') submitFirstChange()
      else doLogin()
    }

    function clearError() {
      if (error.value) error.value = ''
      if (hasError.value) hasError.value = false
    }

    onMounted(async function () {
      try {
        var pendingNotice = localStorage.getItem('weflow-login-notice')
        if (pendingNotice) {
          loginNotice.value = pendingNotice
          localStorage.removeItem('weflow-login-notice')
        }
      } catch (_) {}
      if (!localStorage.getItem('weflow-auth-token')) return
      var state = await api('/api/auth/state')
      if (!state.error && state.mustChange) enterFirstChange()
    })

    return {
      password: password,
      newPassword: newPassword,
      confirmPassword: confirmPassword,
      agreementAccepted: agreementAccepted,
      agreementVisible: agreementVisible,
      mode: mode,
      loading: loading,
      checked: checked,
      failed: failed,
      hasError: hasError,
      success: success,
      error: error,
      loginNotice: loginNotice,
      pageClass: pageClass,
      policyValid: policyValid,
      passwordsMatch: passwordsMatch,
      firstChangeReady: firstChangeReady,
      orbDisabled: orbDisabled,
      doLogin: doLogin,
      submitFirstChange: submitFirstChange,
      handleOrb: handleOrb,
      acceptAgreement: acceptAgreement,
      rejectAgreement: rejectAgreement,
      clearError: clearError
    }
  },
  template: `
    <div class="login-page" :class="pageClass">
      <section class="login-card">
        <img class="login-mascot" src="icon.png" alt="">

        <div class="login-card-content-clip">
          <transition name="login-mode">
            <div v-if="mode === 'login'" key="login" class="login-card-content">
              <div class="login-brand">FlowBOT</div>
              <input id="login-password" class="login-input" type="password" v-model="password"
                @input="clearError" @keyup.enter="doLogin" placeholder="输入密码" autofocus autocomplete="current-password">
              <div class="login-error" :class="{ show: error }">{{ error }}</div>
              <p class="login-hint">首次登录的密码生成于 docker logs</p>
              <p v-if="loginNotice" class="login-notice">{{ loginNotice }}</p>
            </div>

            <div v-else key="first-change" class="login-card-content">
              <div class="login-brand">FlowBOT</div>
              <div class="login-first-title">首次登录</div>
              <p class="login-first-subtitle">检测到当前密码仍为初始密码，请先设置新的 WebUI 登录密码。</p>
              <label class="login-first-label" for="first-new-password">新密码</label>
              <input id="first-new-password" class="login-input first-change-input" type="password"
                v-model="newPassword" @input="clearError" autocomplete="new-password"
                placeholder="10–20 位，包含大小写、数字和特殊字符">
              <label class="login-first-label" for="first-confirm-password">确认新密码</label>
              <input id="first-confirm-password" class="login-input first-change-input" type="password"
                v-model="confirmPassword" @input="clearError" autocomplete="new-password"
                placeholder="再次输入新密码" @keyup.enter="submitFirstChange">
              <label class="security-agreement first-change-agreement">
                <input type="checkbox" v-model="agreementAccepted">
                <span>我已阅读并同意
                  <button type="button" class="agreement-link" @click.stop.prevent="agreementVisible = true">用户协议和免责声明</button>
                </span>
              </label>
              <div v-if="error" class="login-error show">{{ error }}</div>
            </div>
          </transition>
        </div>

        <button class="login-orb" type="button" :class="{ 'is-ready': mode === 'first-change' && firstChangeReady }"
          @click="handleOrb" :disabled="orbDisabled" aria-label="登录或设置新密码">
          <span class="login-orb-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M5 12h13"></path><path d="m12 6 6 6-6 6"></path></svg>
          </span>
          <span class="login-spin" aria-hidden="true"></span>
          <span class="login-orb-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg></span>
          <span class="login-orb-cross" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg></span>
        </button>
      </section>

      <transition name="modal-zoom">
        <div v-if="agreementVisible" class="modal-overlay login-agreement-overlay" @click.self="rejectAgreement">
          <div class="modal login-agreement-modal">
            <h3>用户协议和免责声明</h3>
            <div class="login-agreement-content">
              <p><strong>一、本地处理与零外部依赖</strong> 本项目仅在本地环境处理运行，不包含遥测、统计或行为上报组件。除微信客户端自身网络行为及你主动配置的 AI 适配器外，不会向第三方传输数据。</p>
              <p><strong>二、用途限制与平台合规</strong> 本项目仅供个人学习、研究和 AI 交流使用，不得用于商业用途、批量营销、骚扰、欺诈、侵犯隐私或其他违法违规用途。请遵守微信《软件许可及服务协议》及所在地法律法规。</p>
              <p><strong>三、网络边界与端口安全</strong> 为保证账号安全，请勿将 WebUI、noVNC/VNC、OneBot 或任何 API 端口暴露到公网。因端口暴露、转发或凭据保管不当导致的风险由用户自行承担。</p>
              <p><strong>四、数据、担保与责任豁免</strong> 本工具不收集、存储或向第三方传输个人数据。聊天数据、密钥和配置仅保存在你自己的设备与数据卷中。开发者不对使用本工具造成的损失负责，本工具按“现状”提供。</p>
              <p>继续使用即表示已阅读、理解并同意以上条款；若不同意，请立即停止使用并移除本项目。</p>
            </div>
            <div class="login-agreement-actions">
              <button class="btn btn-secondary" type="button" @click="rejectAgreement">暂不同意</button>
              <button class="btn btn-primary" type="button" @click="acceptAgreement">同意并继续</button>
            </div>
          </div>
        </div>
      </transition>
    </div>
  `
}

var FilterPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var pushEnabled = ref(true)
    var mode = ref('all')
    var list = ref([])              // 已选会话 ID（黑名单=屏蔽，白名单=放行）
    var sessions = ref([])          // 全部会话
    var search = ref('')
    var loading = ref(true)
    var saving = ref(false)
    var showOfficial = ref(false)

    function typeLabel(t) {
      if (t === 'group') return '群聊'
      if (t === 'channel') return '公众号'
      if (t === 'official') return '公众号'
      return '私聊'
    }

    function typeClass(t) {
      if (t === 'group') return 'group'
      if (t === 'channel' || t === 'official') return 'official'
      return 'private'
    }

    function formatTime(ts) {
      if (!ts) return ''
      var d = new Date(ts * 1000)
      function pad(n) { return n < 10 ? '0' + n : '' + n }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    var selectedSet = computed(function () {
      var s = {}
      list.value.forEach(function (id) { s[id] = true })
      return s
    })

    var filteredSessions = computed(function () {
      var arr = sessions.value
      if (!showOfficial.value) {
        arr = arr.filter(function (s) {
          return !(s.username || '').toLowerCase().startsWith('gh_')
        })
      }
      if (search.value) {
        var kw = search.value.toLowerCase()
        arr = arr.filter(function (s) {
          return (s.username || '').toLowerCase().indexOf(kw) !== -1 ||
                 (s.displayName || '').toLowerCase().indexOf(kw) !== -1
        })
      }
      return arr
    })

    var allSelected = computed(function () {
      var f = filteredSessions.value
      if (f.length === 0) return false
      return f.every(function (s) { return !!selectedSet.value[s.username] })
    })

    function toggleAll() {
      var next = !allSelected.value
      var current = list.value.slice()
      var currentSet = {}
      current.forEach(function (id) { currentSet[id] = true })
      filteredSessions.value.forEach(function (s) {
        if (next) currentSet[s.username] = true
        else delete currentSet[s.username]
      })
      list.value = Object.keys(currentSet)
    }

    function toggleOne(username) {
      var current = list.value.slice()
      var idx = current.indexOf(username)
      if (idx === -1) current.push(username)
      else current.splice(idx, 1)
      list.value = current
    }

    async function load() {
      loading.value = true
      var f = await api('/api/weflow/filter')
      if (!f.error && f.filter) {
        pushEnabled.value = f.filter.pushEnabled !== false
        mode.value = f.filter.mode || 'all'
        list.value = (f.filter.list || []).slice()
      }
      var s = await api('/api/weflow/sessions?limit=1000')
      if (!s.error && s.sessions) {
        sessions.value = s.sessions
      } else {
        toast('会话列表加载失败: ' + (s.error || '未知错误'), 'error')
      }
      loading.value = false
    }

    async function save() {
      saving.value = true
      var d = await api('/api/weflow/filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pushEnabled: pushEnabled.value,
          mode: mode.value,
          list: list.value
        })
      })
      saving.value = false
      if (!d.error && d.ok) toast('过滤设置已保存')
      else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    onMounted(load)
    return {
      pushEnabled: pushEnabled, mode: mode, list: list, sessions: sessions,
      search: search, loading: loading, saving: saving, showOfficial: showOfficial,
      selectedSet: selectedSet, filteredSessions: filteredSessions,
      allSelected: allSelected, toggleAll: toggleAll, toggleOne: toggleOne,
      typeLabel: typeLabel, typeClass: typeClass, formatTime: formatTime, save: save
    }
  },
  template: '<div>' +
    '<h1 class="page-title">推送过滤</h1>' +
    '<div class="card">' +
    '<div class="form-row"><label>启用消息推送</label>' +
    '<toggle-switch v-model="pushEnabled" /></div>' +
    '<div class="form-row"><label>过滤模式</label>' +
    '<select v-model="mode">' +
    '<option value="all">推送全部消息</option>' +
    '<option value="whitelist">仅推送选中的会话</option>' +
    '<option value="blacklist">不推送选中的会话</option>' +
    '</select></div>' +
    '<div class="form-row">' +
    '<input type="text" v-model="search" placeholder="搜索会话名称或 ID..." class="filter-search-input" />' +
    '</div>' +
    '<div class="select-all-bar">' +
    '<label class="checkbox-label"><input type="checkbox" :checked="allSelected" @change="toggleAll" /> 全选</label>' +
    '<label class="checkbox-label"><input type="checkbox" v-model="showOfficial" /> 显示公众号</label>' +
    '<span class="spacer"></span>' +
    '<span class="selected-count">已选择 {{ list.length }} 个会话</span>' +
    '<button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? \'保存中...\' : \'保存设置\' }}</button>' +
    '</div>' +
    '<div v-if="loading" class="filter-loading">加载中...</div>' +
    '<div v-else class="session-list">' +
    '<div v-for="s in filteredSessions" :key="s.username" class="session-row" ' +
    ':class="{ selected: !!selectedSet[s.username] }" @click="toggleOne(s.username)">' +
    '<input type="checkbox" :checked="!!selectedSet[s.username]" @click.stop="toggleOne(s.username)" />' +
    '<span class="session-type" :class="typeClass(s.sessionType || s.type)">{{ typeLabel(s.sessionType || s.type) }}</span>' +
    '<div class="session-info">' +
    '<span class="session-name">{{ s.displayName || s.username }}</span>' +
    '<span class="session-id">{{ s.username }}</span>' +
    '</div>' +
    '</div>' +
    '<div v-if="filteredSessions.length === 0" class="filter-empty">没有匹配的会话</div>' +
    '</div>' +
    '</div></div>'
}

var routes = [
  { path: '/', component: HomePage, meta: { title: '首页' } },
  { path: '/bot', component: BotPage, meta: { title: 'Bot 配置' } },
  { path: '/accounts', redirect: '/settings' },
  { path: '/filter', component: FilterPage, meta: { title: '推送过滤' } },
  { path: '/settings', component: SettingsPage, meta: { title: '设置' } },
  { path: '/send', component: SendManagerPage, meta: { title: '消息管理' } },
  { path: '/logs', component: LogsPage, meta: { title: '日志' } },
  { path: '/about', component: AboutPage, meta: { title: '关于' } },
  { path: '/login', component: LoginPage, meta: { title: '登录' } }
]

var router = createRouter({ history: createWebHashHistory(), routes: routes })

router.beforeEach(function (to, from, next) {
  if (to.path === '/login') { next(); return }
  if (authTransitionAuthorized) {
    authTransitionAuthorized = false
    next()
    return
  }
  var token = localStorage.getItem('weflow-auth-token')
  if (!token) { next('/login'); return }
  api('/api/auth/state').then(function (state) {
    if (!state.error && state.mustChange) next('/login')
    else if (state.error) next('/login')
    else next()
  }).catch(function () { next() })
})

var App = {
  components: { ToastContainer: ToastContainer, RouterLink: RouterLink, RouterView: RouterView },
  setup: function () {
    var route = useRoute()
    var serviceOnline = ref(false)
    var sidebarOpen = ref(false)
    var securityIncident = ref(null)

    var navItems = [
      { path: '/', label: '首页', icon: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
      { path: '/bot', label: 'Bot 配置', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>' },
      { path: '/filter', label: '推送过滤', icon: '<svg viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>' },
      { path: '/send', label: '消息管理', icon: '<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>' },
      { path: '/settings', label: '设置', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.5 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
      { path: '/logs', label: '日志', icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
      { path: '/about', label: '关于', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' }
    ]

    function cycleThemeMode() {
      var goingDark = effectiveTheme.value === 'light'
      if (themeMode.value === 'system') {
        themeMode.value = effectiveTheme.value === 'dark' ? 'light' : 'dark'
      } else {
        var currentIndex = THEME_ORDER.indexOf(themeMode.value)
        themeMode.value = THEME_ORDER[(currentIndex + 1) % THEME_ORDER.length]
      }
      saveTheme(themeMode.value)
      applyTheme()
    }

    function setTheme(mode) {
      themeMode.value = mode
      saveTheme(mode)
      applyTheme()
    }

    async function checkHealth() {
      try {
        var d = await api('/api/v1/health')
        if (!d.error && d.status === 'ok') serviceOnline.value = true
        else serviceOnline.value = false
      } catch {
        serviceOnline.value = false
      }
    }

    async function loadSecurityContext() {
      if (!localStorage.getItem('weflow-auth-token')) return
      var state = await api('/api/auth/state')
      if (state.error) return
      if (state.incident) securityIncident.value = state.incident
      if (state.mustChange && route.path !== '/login') {
        window.location.hash = '#/login'
      }
    }

    async function acknowledgeIncident() {
      var d = await api('/api/auth/incident/ack', { method: 'POST' })
      if (!d.error) securityIncident.value = null
    }

    watch(function () { return route.path }, function () { loadSecurityContext() })

    function toggleSidebar() { sidebarOpen.value = !sidebarOpen.value }
    function closeSidebar() { sidebarOpen.value = false }
    function onNavClick() { if (window.innerWidth <= 768) sidebarOpen.value = false }

    var statusTimer = null
    onMounted(function () {
      themeMedia = window.matchMedia('(prefers-color-scheme: dark)')
      handleThemeChange = function () {
        if (themeMode.value === 'system') applyTheme()
      }
      themeMedia.addEventListener('change', handleThemeChange)
      applyTheme()
      checkHealth()
      loadSecurityContext()
      statusTimer = setInterval(checkHealth, 15000)
    })
    onUnmounted(function () {
      if (statusTimer) clearInterval(statusTimer)
      if (themeMedia && handleThemeChange) {
        themeMedia.removeEventListener('change', handleThemeChange)
      }
    })

    function logout() {
      loginOverlayVisible.value = false
      appShellReveal.value = false
      localStorage.removeItem('weflow-auth-token')
      window.location.hash = '#/login'
    }

    return {
      route: route, serviceOnline: serviceOnline,
      navItems: navItems, sidebarOpen: sidebarOpen,
      cycleThemeMode: cycleThemeMode, setTheme: setTheme, effectiveTheme: effectiveTheme,
      toggleSidebar: toggleSidebar, closeSidebar: closeSidebar, onNavClick: onNavClick,
      logout: logout, securityIncident: securityIncident, acknowledgeIncident: acknowledgeIncident,
      LoginPage: LoginPage, loginOverlayVisible: loginOverlayVisible, appShellReveal: appShellReveal
    }
  },
  template: '<div>' +
    '<toast-container />' +
    '<component v-if="route.path === \'/login\' || loginOverlayVisible" :is="LoginPage" />' +
    '<div v-if="securityIncident" class="modal-overlay security-incident-overlay">' +
    '<div class="modal security-incident-modal">' +
    '<h3>服务曾被自动停止</h3>' +
    '<p>本容器因连续密码输入错误触发账号安全保护，WeFlow 主服务已停止。失败计数已随本次重启清零，服务已恢复。</p>' +
    '<p>请确认是否为本人操作；若不是，请检查局域网访问设备并及时修改密码。</p>' +
    '<div class="security-modal-actions"><button class="btn btn-primary" @click="acknowledgeIncident">我知道了</button></div>' +
    '</div></div>' +
    '<div v-if="route.path !== \'/login\'" class="app-shell" :class="{ \'is-login-overlay\': loginOverlayVisible && !appShellReveal }">' +

    '<div :class="[\'sidebar-backdrop\', sidebarOpen?\'visible\':\'\']" @click="closeSidebar"></div>' +

    '<nav class="mini-rail" aria-label="快捷导航">' +
    '<router-link v-for="item in navItems" :key="item.path" :to="item.path" ' +
    'custom v-slot="{ href, navigate, isActive }">' +
    '<a :href="href" :class="[\'rail-btn\', { active: isActive }]" :title="item.label" :aria-label="item.label" @click="navigate; onNavClick()">' +
    '<span class="rail-indicator"></span>' +
    '<span class="nav-icon" v-html="item.icon"></span>' +
    '</a></router-link>' +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-btn" title="展开菜单" aria-label="展开菜单" @click="toggleSidebar()">' +
    '<span class="nav-icon"><svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></span>' +
    '</button>' +
    '<button class="rail-btn rail-logout" title="退出登录" aria-label="退出登录" @click="logout">' +
    '<span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>' +
    '</button>' +
    '</nav>' +

    '<aside :class="[\'sidebar\', sidebarOpen?\'open\':\'\']">' +

    '<div class="sidebar-module module-brand">' +
    '<div class="logo">' +
    '<h1>FlowBOT</h1>' +
    '<p class="subtitle">WeChat OneBot v11 Services</p>' +
    '</div>' +
    '<div class="service-status" :class="serviceOnline ? \'status-online\' : \'status-offline\'">' +
    '<span class="status-dot"></span>' +
    '<span class="status-text">{{ serviceOnline ? \'服务运行中\' : \'服务未连接\' }}</span>' +
    '</div>' +
    '</div>' +

    '<div class="sidebar-module module-nav">' +
    '<nav class="nav-main">' +
    '<router-link v-for="item in navItems" :key="item.path" :to="item.path" ' +
    'custom v-slot="{ href, navigate, isActive }">' +
    '<a :href="href" :class="[\'nav-btn\', { active: isActive }]" @click="navigate; onNavClick()">' +
    '<span class="nav-icon" v-html="item.icon"></span>' +
    '<span class="nav-label">{{ item.label }}</span>' +
    '</a></router-link></nav>' +
    '</div>' +

    '<div class="sidebar-module module-bottom" style="margin-top:auto;padding:14px">' +
    '<button class="nav-btn" @click="logout" style="width:100%;justify-content:center">' +
    '<span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>' +
    '<span class="nav-label">退出登录</span>' +
    '</button>' +
    '</div>' +

    '</aside>' +

    '<main class="main-content">' +
    '<div class="theme-toolbar">' +
    '<div class="capsule-theme-switch">' +
    '<button :class="{active:effectiveTheme===\'dark\'}" title="深色模式" @click="setTheme(\'dark\')">' +
    '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg></button>' +
    '<button :class="{active:effectiveTheme===\'light\'}" title="浅色模式" @click="setTheme(\'light\')">' +
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg></button>' +
    '<button :class="{active:themeMode===\'system\'}" title="跟随系统" @click="setTheme(\'system\')">' +
    '<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>' +
    '</div></div>' +
    '<router-view v-slot="{ Component, route }">' +
    '<transition name="page-fade" mode="out-in">' +
    '<div :key="route.path" class="page-wrapper">' +
    '<component :is="Component" />' +
    '</div>' +
    '</transition></router-view>' +
    '</main>' +

    '</div></div>'
}

var app = createApp(App)
app.use(router)
app.mount('#app')
