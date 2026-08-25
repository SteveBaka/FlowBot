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

async function api(path, opts) {
  try {
    var token = localStorage.getItem('weflow-auth-token')
    opts = opts || {}
    if (token) {
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token })
    }
    var res = await fetch(path, opts)
    var text = await res.text()
    try { var d = JSON.parse(text) } catch (_) { return { error: 'Non-JSON response (status ' + res.status + ')' } }
    if (res.status === 401 && path !== '/api/auth/login') {
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
      login: { status: '检测中...', color: '', loading: true, sub: '' },
      onebot: { status: '检测中...', color: '', loading: true, sub: '' },
      account: { status: '检测中...', color: '', loading: true, sub: '' },
      database: { status: '检测中...', color: '', loading: true, sub: '' },
      system: { status: '检测中...', color: '', loading: true, sub: '' }
    })

    function dotColor(c) {
      if (c === 'green') return '#2ed573'
      if (c === 'red') return '#ff4757'
      if (c === 'yellow') return '#ffa502'
      if (c === 'gray') return '#8892a4'
      return '#8892a4'
    }

    async function load() {
      cards.login.loading = true
      cards.onebot.loading = true
      cards.account.loading = true
      cards.database.loading = true
      cards.system.loading = true

      var healthStatus = 'N/A'
      try {
        var h = await api('/api/v1/health')
        healthStatus = (!h.error && h.status === 'ok') ? '运行中' : (h.error || '异常')
      } catch (_) { healthStatus = '无法连接' }

      var c = await api('/api/v1/mgmt/config')
      if (!c.error) {
        if (c.myWxid) { cards.login.status = '已登录'; cards.login.color = 'green' }
        else { cards.login.status = '未登录'; cards.login.color = 'red' }
        cards.login.loading = false

        cards.account.status = c.myWxid || '未设置'
        cards.account.color = c.myWxid ? 'green' : 'yellow'
        cards.account.sub = ''
        cards.account.loading = false

        cards.database.status = c.dbPath ? '已连接' : '未连接'
        cards.database.color = c.dbPath ? 'green' : 'red'
        cards.database.sub = c.dbPath || ''
        cards.database.loading = false

        var bots = []
        try { bots = typeof c.bots === 'string' ? JSON.parse(c.bots) : (c.bots || []) } catch (_) { bots = [] }
        if (!Array.isArray(bots)) bots = []
        if (bots.length === 0) {
          cards.onebot.status = '未配置'
          cards.onebot.color = 'gray'
          cards.onebot.sub = ''
        } else {
          var botStatusResult = await api('/api/v1/mgmt/bots/status')
          var statusMap = {}
          var botList = []
          if (!botStatusResult.error && botStatusResult.success && botStatusResult.bots) {
            botList = botStatusResult.bots
          } else if (Array.isArray(botStatusResult)) {
            botList = botStatusResult
          }
          botList.forEach(function (s) { statusMap[s.id] = s })

          cards.onebot.sub = bots.map(function (b) {
            var s = statusMap[b.id]
            var st = s ? (s.connectionStatus || s.status || 'stopped') : 'stopped'
            // 协议标签按 bot 实际类型适配：HTTP/插件API 显示 HTTP，WS 显示 WS
            var label = (b.mode === 'http' || b.mode === 'plugin' ? 'HTTP' : 'WS') + ':' + b.name
            return { label: label, status: st }
          })
          var anyConnected = bots.some(function (b) {
            var s = statusMap[b.id]
            return s && (s.connectionStatus === 'connected' || s.status === 'running')
          })
          cards.onebot.status = bots.length + ' 个 Bot'
          cards.onebot.color = anyConnected ? 'green' : 'red'
        }
        cards.onebot.loading = false
      } else {
        cards.login.status = '无法获取配置'
        cards.login.color = 'yellow'
        cards.login.loading = false
        cards.onebot.status = '无法获取配置'
        cards.onebot.color = 'yellow'
        cards.onebot.loading = false
        cards.account.status = '无法获取配置'
        cards.account.color = 'yellow'
        cards.account.loading = false
        cards.database.status = '无法获取配置'
        cards.database.color = 'yellow'
        cards.database.loading = false
      }

      var s = await api('/api/system')
      if (!s.error && s.system) {
        var sys = s.system
        var cpuPercent = sys.cpuCores ? Math.min(Math.round((sys.cpuLoad / sys.cpuCores) * 100), 100) : 0
        var memPercent = sys.memory && sys.memory.usedPercent ? sys.memory.usedPercent : 0
        var diskPercent = sys.disk && typeof sys.disk === 'object' && sys.disk.usedPercent ? sys.disk.usedPercent : 0
        cards.system.cpu = cpuPercent
        cards.system.ram = memPercent
        cards.system.disk = diskPercent
        cards.system.uptime = sys.containerUptime || (sys.uptime || '').replace('up ', '') || '-'
        cards.system.cpuModel = sys.cpuModel || '-'
        cards.system.color = 'green'
        cards.flowbotVersion = sys.version || '-'
        cards.version = sys.weflowVersion || '-'
        cards.wechatVersion = sys.wechatVersion || '4.1.1.7'
      } else {
        cards.system.cpu = 0
        cards.system.ram = 0
        cards.system.disk = 0
        cards.system.uptime = '-'
        cards.system.cpuModel = '-'
        cards.system.color = 'red'
        cards.flowbotVersion = '-'
        cards.version = '-'
        cards.wechatVersion = '4.1.1.7'
      }
      cards.system.loading = false
    }

    var refreshTimer = null
    onMounted(function () {
      load()
      refreshTimer = setInterval(load, 15000)
    })
    onUnmounted(function () { if (refreshTimer) clearInterval(refreshTimer) })
    return { cards: cards, dotColor: dotColor, load: load }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">首页</h1><p class="subtitle">系统状态概览</p></div>' +
    '<div class="header-actions"><button class="btn btn-secondary" @click="load">刷新</button></div></div>' +

    '<div class="stats-grid">' +

    '<div class="stat-card">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.login.color)}"></span><span class="stat-label">登录状态</span></div>' +
    '<div class="stat-value">{{ cards.login.status }}</div>' +
    '</div>' +

    '<div class="stat-card">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.onebot.color)}"></span><span class="stat-label">Bot 状态</span></div>' +
    '<div class="stat-value">{{ typeof cards.onebot.sub === \'object\' ? cards.onebot.status : cards.onebot.status }}</div>' +
    '<div v-if="typeof cards.onebot.sub === \'object\' && cards.onebot.sub.length" style="margin-top:4px">' +
    '<div v-for="bs in cards.onebot.sub" :key="bs.label" style="font-size:13px;display:flex;align-items:center;gap:6px">' +
    '<span style="font-family:monospace;font-weight:500">{{ bs.label }}</span>' +
    '<span style="font-size:12px" :style="{color: bs.status===\'connected\'?\'#2ed573\':bs.status===\'running\'?\'#2ed573\':\'#ff4757\'}">{{ bs.status===\'connected\'?\'已连接\':bs.status===\'running\'?\'运行中\':\'未连接\' }}</span>' +
    '</div>' +
    '</div>' +
    '<div v-else-if="typeof cards.onebot.sub === \'string\' && cards.onebot.sub" class="stat-sub">{{ cards.onebot.sub }}</div>' +
    '</div>' +

    '<div class="stat-card">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.account.color)}"></span><span class="stat-label">账号信息</span></div>' +
    '<div class="stat-value" style="font-size:14px;word-break:break-all">{{ cards.account.status }}</div>' +
    '</div>' +

    '<div class="stat-card">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.database.color)}"></span><span class="stat-label">数据库连接</span></div>' +
    '<div class="stat-value">{{ cards.database.status }}</div>' +
    '<div v-if="cards.database.sub" class="stat-sub" style="word-break:break-all">{{ cards.database.sub }}</div>' +
    '</div>' +

    '<div class="stat-card system-info-card">' +
    '<div class="system-top">' +
    '<div class="system-ring">' +
    '<svg viewBox="0 0 36 36" class="ring-svg">' +
    '<circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--bg-input)" stroke-width="3"/>' +
    '<circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--accent)" stroke-width="3" ' +
    ':stroke-dasharray="cards.system.cpu + \', 100\'" stroke-linecap="round" transform="rotate(-90 18 18)"/>' +
    '</svg>' +
    '<div class="ring-label">CPU</div>' +
    '<div class="ring-text">{{ cards.system.cpu }}<span>%</span></div>' +
    '</div>' +
    '<div class="system-bars">' +
    '<div class="system-bar-row">' +
    '<div class="bar-label">RAM</div>' +
    '<div class="bar-track"><div class="bar-fill" :style="{width: cards.system.ram + \'%\'}"></div></div>' +
    '<div class="bar-text">{{ cards.system.ram }}%</div>' +
    '</div>' +
    '<div class="system-bar-row">' +
    '<div class="bar-label">存储</div>' +
    '<div class="bar-track"><div class="bar-fill bar-fill-disk" :style="{width: cards.system.disk + \'%\'}"></div></div>' +
    '<div class="bar-text">{{ cards.system.disk }}%</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="system-meta">' +
    '<span class="meta-item"><span class="meta-label">运行时间</span>{{ cards.system.uptime }}</span>' +
    '<span class="meta-item"><span class="meta-label">CPU</span>{{ cards.system.cpuModel }}</span>' +
    '</div>' +
    '</div>' +

    '<div class="stat-card version-card">' +
    '<div class="stat-header"><span class="stat-dot" style="background:#3498db"></span><span class="stat-label">版本信息</span></div>' +
    '<div class="version-row"><span class="version-label">FlowBot</span><span class="version-val">{{ cards.flowbotVersion }}</span></div>' +
    '<div class="version-row"><span class="version-label">WeFlow</span><span class="version-val">{{ cards.version }}</span></div>' +
    '<div class="version-row"><span class="version-label">微信</span><span class="version-val">{{ cards.wechatVersion }}</span></div>' +
    '</div>' +

    '</div></div>' +
    '<style>.ring-label{position:absolute;top:28%;left:50%;transform:translateX(-50%);font-size:9px;font-weight:600;color:var(--text-muted);pointer-events:none}.ring-text{position:absolute;top:62%;left:50%;transform:translate(-50%,-50%);font-size:15px;font-weight:700;color:var(--accent);pointer-events:none}.ring-text span{font-size:9px;font-weight:500}</style>'
}

var BotPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var bots = ref([])
    var showModal = ref(false)
    var modalStep = ref(1)
    var modalMode = ref('')
    var modalDirection = ref('server')
    var modalBotName = ref('')
    var modalUrl = ref('ws://127.0.0.1:6199/ws')
    var modalPort = ref(7100)
    var modalToken = ref('')
    var editingBotId = ref(null)

    async function loadBots() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error && d.bots) {
        try {
          var parsed = typeof d.bots === 'string' ? JSON.parse(d.bots) : d.bots
          if (Array.isArray(parsed)) {
            // 先合并状态再赋值，确保首屏即可显示正确的连接状态
            await mergeBotStatus(parsed)
            bots.value = parsed
          }
        } catch (e) {}
      }
    }

    // 合并各 bot 的实时连接状态（含插件 API 对端连接情况）
    async function mergeBotStatus(list) {
      try {
        var st = await api('/api/v1/mgmt/bots/status')
        if (st && st.success && Array.isArray(st.bots)) {
          var statusMap = {}
          st.bots.forEach(function (b) { statusMap[b.id] = b })
          list.forEach(function (b) {
            var s = statusMap[b.id]
            if (s) {
              b.status = s.status
              b.connectionStatus = s.connectionStatus
              b.clientCount = s.clientCount
              b.error = s.error
            } else if (!b.status) {
              // 状态接口未返回该 bot → 视为未运行，避免显示"未知"
              b.status = 'stopped'
              b.connectionStatus = 'disconnected'
            }
          })
        }
      } catch (e) {}
    }

    // 周期刷新连接状态（不重载配置，避免打断编辑）
    setInterval(function () {
      if (!bots.value.length) return
      api('/api/v1/mgmt/bots/status').then(function (st) {
        if (st && st.success && Array.isArray(st.bots)) {
          var statusMap = {}
          st.bots.forEach(function (b) { statusMap[b.id] = b })
          bots.value.forEach(function (b) {
            var s = statusMap[b.id]
            if (s) {
              b.status = s.status
              b.connectionStatus = s.connectionStatus
              b.clientCount = s.clientCount
              b.error = s.error
            } else if (!b.status) {
              b.status = 'stopped'
              b.connectionStatus = 'disconnected'
            }
          })
        }
      }).catch(function () {})
    }, 5000)

    function openAddModal() {
      editingBotId.value = null
      modalStep.value = 1
      modalMode.value = ''
      modalDirection.value = 'server'
      modalBotName.value = 'Bot ' + (bots.value.length + 1)
      modalUrl.value = 'ws://127.0.0.1:6199/ws'
      modalPort.value = 7100
      modalToken.value = generateToken()
      showModal.value = true
    }

    function closeModal() { showModal.value = false }

    function selectMode(mode) {
      modalMode.value = mode
      if (mode === 'http') {
        modalStep.value = 3
        modalPort.value = 7100
      } else if (mode === 'ws') {
        modalStep.value = 2
      }
    }

    // HTTP 服务类型切换：OneBot HTTP 服务端 / 插件 API（AstrBot 适配器）
    function onHttpTypeChange() {
      if (modalMode.value === 'plugin') modalPort.value = 7400
      else if (modalMode.value === 'http') modalPort.value = 7100
    }

    function selectDirection(dir) {
      modalDirection.value = dir
      modalStep.value = 3
    }

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
      } else {
        toast('保存失败: ' + (d.error || ''), 'error')
      }
    }

    async function addBot() {
      var isPortBased = modalMode.value === 'http' || modalMode.value === 'plugin'
      var address = '127.0.0.1'
      var port = 6199
      var url = modalUrl.value
      if (isPortBased) {
        // HTTP/插件API 服务端：监听端口，无 URL
        address = '0.0.0.0'
        port = Number(modalPort.value) || 7100
        url = ''
      } else {
        var urlMatch = modalUrl.value.match(/^(wss?):\/\/([^:\/]+):?(\d+)(\/.*)?$/)
        address = urlMatch ? urlMatch[2] : '127.0.0.1'
        port = urlMatch ? parseInt(urlMatch[3]) : 6199
      }
      if (editingBotId.value) {
        bots.value = bots.value.map(function (b) {
          if (b.id === editingBotId.value) {
            return Object.assign({}, b, {
              name: modalBotName.value || b.name,
              mode: modalMode.value,
              direction: modalDirection.value,
              url: url,
              address: address,
              port: port,
              token: modalToken.value
            })
          }
          return b
        })
        editingBotId.value = null
      } else {
        var id = 'bot_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
        var newBot = {
          id: id,
          name: modalBotName.value || 'Bot ' + (bots.value.length + 1),
          mode: modalMode.value,
          direction: modalDirection.value,
          url: url,
          address: address,
          port: port,
          token: modalToken.value,
          enabled: true
        }
        bots.value = bots.value.concat([newBot])
      }
      await saveBots()
      showModal.value = false
    }

    async function toggleBot(botItem) {
      bots.value = bots.value.map(function (b) {
        if (b.id === botItem.id) return Object.assign({}, b, { enabled: !b.enabled })
        return b
      })
      await saveBots()
    }

    async function deleteBot(botItem) {
      if (!confirm('确认删除 Bot "' + botItem.name + '"？')) return
      bots.value = bots.value.filter(function (b) { return b.id !== botItem.id })
      await saveBots()
    }

    function editBot(botItem) {
      editingBotId.value = botItem.id
      modalMode.value = botItem.mode
      modalDirection.value = botItem.direction
      modalBotName.value = botItem.name
      if (botItem.mode === 'http' || botItem.mode === 'plugin') {
        modalUrl.value = ''
        modalPort.value = Number(botItem.port) || 7100
      } else {
        modalUrl.value = botItem.url || ('ws://' + botItem.address + ':' + botItem.port + '/ws')
        modalPort.value = Number(botItem.port) || 6199
      }
      modalToken.value = botItem.token
      modalStep.value = 3
      showModal.value = true
    }

    async function testBot(botItem) {
      toast('正在测试连接...', 'info')
      // 插件 API bot：由 WebUI server.js 管理，直接探测 bot 端口（不走 botManager）
      if (botItem.mode === 'plugin') {
        try {
          var host = window.location.hostname || '127.0.0.1'
          var port = Number(botItem.port) || 7400
          var res = await fetch('http://' + host + ':' + port + '/api/v1/sessions', {
            headers: botItem.token ? { Authorization: 'Bearer ' + botItem.token } : {}
          })
          if (res.ok) toast(botItem.name + ': 已连接（插件 API 运行中）', 'success')
          else toast(botItem.name + ': 未连接（HTTP ' + res.status + '，检查 Token/端口）', 'error')
        } catch (e) {
          toast(botItem.name + ': 未连接（端口未监听）', 'error')
        }
        return
      }
      var d = await api('/api/v1/mgmt/bots/status')
      if (d.success && d.bots) {
        var bot = d.bots.find(function(b) { return b.id === botItem.id })
        if (bot) {
          var status = bot.connectionStatus || bot.status || 'unknown'
          if (status === 'connected' || status === 'running') {
            toast(bot.name + ': 已连接', 'success')
          } else if (status === 'disconnected' || status === 'stopped') {
            toast(bot.name + ': 未连接', 'error')
          } else if (status === 'error') {
            toast(bot.name + ': 连接错误' + (bot.error ? ': ' + bot.error : ''), 'error')
          } else {
            toast(bot.name + ': 未连接', 'error')
          }
        } else {
          toast(botItem.name + ': 未运行（请先保存并启动）', 'error')
        }
      } else {
        toast('检测失败', 'error')
      }
    }

    function modeBadge(m) { return m === 'http' ? 'badge-http' : (m === 'plugin' ? 'badge-plugin' : 'badge-ws') }
    function modeLabel(m) { return m === 'http' ? 'HTTP' : (m === 'plugin' ? '插件API' : 'WS') }
    function dirBadge(d) { return d === 'server' ? 'badge-server' : 'badge-client' }
    function dirLabel(d) { return d === 'server' ? '服务端' : '客户端' }

    onMounted(loadBots)
    return {
      bots: bots, showModal: showModal, modalStep: modalStep,
      modalMode: modalMode, modalDirection: modalDirection,
      modalBotName: modalBotName, modalUrl: modalUrl,
      modalPort: modalPort, modalToken: modalToken,
      editingBotId: editingBotId,
      openAddModal: openAddModal, closeModal: closeModal,
      selectMode: selectMode, selectDirection: selectDirection, onHttpTypeChange: onHttpTypeChange,
      addBot: addBot, toggleBot: toggleBot, deleteBot: deleteBot,
      editBot: editBot, testBot: testBot,
      modeBadge: modeBadge, modeLabel: modeLabel,
      dirBadge: dirBadge, dirLabel: dirLabel,
      loadBots: loadBots
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
    '<span>{{ b.url || (b.address + ":" + b.port) }}</span>' +
    '<span v-if="b.connectionStatus === \'connected\'" class="badge badge-server">已连接{{ b.clientCount ? " (" + b.clientCount + ")" : "" }}</span>' +
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

    '<button class="add-bot-btn" @click="openAddModal">+ 添加 Bot</button>' +

    '<transition name="modal-zoom">' +
    '<div v-if="showModal" class="modal-overlay" @click.self="closeModal">' +
    '<div class="modal">' +

    '<transition name="modal-step" mode="out-in">' +
    '<div :key="modalStep">' +
    '<div v-if="modalStep===1">' +
    '<h3>选择连接模式</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    '<div class="card" style="cursor:pointer;text-align:center;padding:24px 16px" @click="selectMode(\'http\')">' +
    '<div style="font-size:28px;margin-bottom:8px">HTTP</div>' +
    '<div style="font-size:12px;color:var(--text-muted)">OneBot HTTP 服务端 / 插件 API</div></div>' +
    '<div class="card" style="cursor:pointer;text-align:center;padding:24px 16px" @click="selectMode(\'ws\')">' +
    '<div style="font-size:28px;margin-bottom:8px">WS</div>' +
    '<div style="font-size:12px;color:var(--text-muted)">WebSocket</div></div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:16px"><button class="btn btn-secondary" @click="closeModal">取消</button></div>' +
    '</div>' +

    '<div v-else-if="modalStep===2">' +
    '<h3>选择连接方向</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    '<div class="card" style="cursor:pointer;text-align:center;padding:24px 16px" @click="selectDirection(\'server\')">' +
    '<div style="font-size:16px;font-weight:600;margin-bottom:4px">服务端</div>' +
    '<div style="font-size:12px;color:var(--text-muted)">监听端口，等待连接</div></div>' +
    '<div class="card" style="cursor:pointer;text-align:center;padding:24px 16px" @click="selectDirection(\'client\')">' +
    '<div style="font-size:16px;font-weight:600;margin-bottom:4px">客户端</div>' +
    '<div style="font-size:12px;color:var(--text-muted)">主动连接外部服务</div></div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:16px"><button class="btn btn-secondary" @click="modalStep=1">返回</button></div>' +
    '</div>' +

    '<div v-else-if="modalStep===3">' +
    '<h3>{{ editingBotId ? "编辑 Bot" : "配置 Bot" }}</h3>' +
    '<div class="form-group"><label>名称</label><input type="text" v-model="modalBotName" placeholder="Bot 1"></div>' +
    '<div v-if="modalMode === \'http\' || modalMode === \'plugin\'">' +
    '<div class="form-group"><label>服务类型</label>' +
    '<select v-model="modalMode" @change="onHttpTypeChange" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input,var(--bg-card));color:var(--text)">' +
    '<option value="http">OneBot HTTP 服务端</option>' +
    '<option value="plugin">插件 API（AstrBot 适配器）</option>' +
    '</select></div>' +
    '<div class="form-group"><label>监听端口 *</label><input type="number" v-model.number="modalPort" placeholder="7100" min="1" max="65535"></div>' +
    '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">{{ modalMode === \'plugin\' ? \'插件 API：AstrBot 适配器统一消息服务端（HTTP+WS），Token 与适配器一致，关闭此 bot 即停用插件 API\' : \'OneBot HTTP 服务端：OneBot v11 协议端口，机器人框架按 OneBot 标准接入\' }}</div>' +
    '</div>' +
    '<div v-else class="form-group"><label>URL *</label><input type="text" v-model="modalUrl" placeholder="ws://127.0.0.1:6199/ws"></div>' +
    '<div class="form-group"><label>Token</label><input type="text" v-model="modalToken" placeholder="自动生成"></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
    '<button class="btn btn-secondary" @click="editingBotId ? closeModal() : (modalStep = (modalMode===\'ws\' ? 2 : 1))">{{ editingBotId ? "取消" : "返回" }}</button>' +
    '<button class="btn btn-primary" @click="addBot">保存</button>' +
    '</div></div>' +

    '</div></transition>' +
    '</div></div></div>'
}

var AccountsPage = {
  setup: function () {
    var currentWxid = ref('')
    var showHint = ref(false)

    async function load() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) currentWxid.value = d.myWxid || ''
    }

    function handleAddAccount() { showHint.value = true }

    function openNoVnc() {
      window.open('http://' + window.location.hostname + ':7600/vnc.html', '_blank')
    }

    onMounted(load)
    return { currentWxid: currentWxid, showHint: showHint, handleAddAccount: handleAddAccount, openNoVnc: openNoVnc, load: load }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">账号管理</h1><p class="subtitle">管理微信账号登录状态</p></div>' +
    '<div class="header-actions">' +
    '<button class="btn btn-secondary" @click="load">刷新</button>' +
    '<button class="btn btn-primary" @click="handleAddAccount">添加账号</button>' +
    '</div></div>' +

    '<div class="card"><h2>当前账号</h2>' +
    '<div class="form-row"><label>微信 ID</label>' +
    '<span style="font-size:14px;font-weight:500;color:var(--accent);font-family:monospace">{{ currentWxid || "未登录" }}</span></div></div>' +

    '<div v-if="showHint" class="hint-card">' +
    '<p style="color:#000">请在 noVNC 虚拟桌面中操作 FlowBOT和WeChat 以进行登录，然后回到本页面刷新。<br>请先扫描二维码登录微信后再根据FlowBOT的流程配置数据库，才可以激活本套件。</p>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn btn-primary" @click="openNoVnc">打开 noVNC</button>' +
    '<button class="btn btn-secondary" @click="load">刷新状态</button>' +
    '</div></transition>' +
    '</div></div></div>'
}

var SettingsPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var wf = reactive({
      httpEnabled: false, httpPort: 5031, httpToken: ''
    })
    var showHttpToken = ref(false)
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
    var tplText = ref('')
    var tplRestoreConfirm = ref(false)
    var liveVars = reactive({ version: '-', platform: '-', uptime: '-', weflowVersion: '-' })

    async function loadConfig() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        wf.httpEnabled = d.httpApiEnabled || false
        wf.httpPort = d.httpApiPort || 5031
        wf.httpToken = (d.httpApiToken && d.httpApiToken !== '[encrypted]') ? d.httpApiToken : ''
        imgTransfer.mode = d.imageTransferMode || 'base64'
        imgTransfer.baseUrl = d.imageServerBaseUrl || ''
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
          httpApiEnabled: wf.httpEnabled,
          httpApiPort: Number(wf.httpPort),
          httpApiToken: wf.httpToken || undefined,
          imageTransferMode: imgTransfer.mode,
          imageServerBaseUrl: trimmedUrl,
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

    async function openTplEditor() {
      tplText.value = flowbot.template
      tplRestoreConfirm.value = false
      showTplModal.value = true
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

    function cancelTplEditor() {
      showTplModal.value = false
    }

    function saveTpl() {
      flowbot.template = tplText.value
      showTplModal.value = false
      toast('模板已编辑，请点击「保存配置」持久化', 'info')
    }

    onMounted(loadConfig)
    return { wf: wf, showHttpToken: showHttpToken, imgTransfer: imgTransfer, baseUrlError: baseUrlError, saveConfig: saveConfig, restart: restart, flowbot: flowbot, showTplModal: showTplModal, tplText: tplText, tplRestoreConfirm: tplRestoreConfirm, liveVars: liveVars, openTplEditor: openTplEditor, refreshLiveVars: refreshLiveVars, insertVar: insertVar, confirmResetTpl: confirmResetTpl, resetTpl: resetTpl, cancelTplEditor: cancelTplEditor, saveTpl: saveTpl }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">设置</h1><p class="subtitle">系统与 API 配置</p></div>' +
    '<div class="header-actions"><button class="btn btn-primary" @click="saveConfig">保存配置</button></div></div>' +

    '<div class="card"><h2>WeFlow HTTP API 配置</h2>' +
    '<div class="form-row"><label>启用 HTTP API</label><toggle-switch v-model="wf.httpEnabled" /></div>' +
    '<div class="form-row"><label>HTTP API 端口</label><input type="number" v-model.number="wf.httpPort"></div>' +
    '<div class="form-row"><label>HTTP API Token</label>' +
    '<div class="input-with-toggle">' +
    '<input :type="showHttpToken ? \'text\' : \'password\'" v-model="wf.httpToken" placeholder="自动生成">' +
    '<button class="btn btn-secondary btn-sm" @click="showHttpToken=!showHttpToken">{{ showHttpToken?\'隐藏\':\'显示\' }}</button>' +
    '</div></transition>' +
    '</div></div></div>' +

    '<div class="card"><h2>图片传输设置</h2>' +
    '<div class="form-row" style="align-items:flex-start">' +
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:100px;margin-right:12px">' +
    '<label style="margin-bottom:0">传输模式</label>' +
    '<span style="font-size:12px;color:var(--text-muted);line-height:1.4">' +
    'Base64 传输（默认，无需额外配置）；URL 传输（消息体缩小至 ~150 字节）' +
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
    '外部服务（如 AstrBot）用于下载图片的完整地址。请填写从 AstrBot 所在机器能访问到的 IP 和端口。格式: http://&lt;宿主机IP&gt;:7400（插件推送直链与 WebUI 图片传输共用）' +
    '</span>' +
    '</div>' +
    '<input type="text" v-model="imgTransfer.baseUrl" ' +
    'placeholder="http://你的IP:7400" ' +
    ':class="{ \'input-error\': baseUrlError }" ' +
    ':disabled="imgTransfer.mode === \'base64\'">' +
    '</div>' +
    '</div>' +

    '<div class="card"><h2>状态信息命令</h2>' +
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
    '<div class="form-row"><label>响应模板</label><button class="btn btn-secondary btn-sm" @click="openTplEditor">编辑模板</button></div>' +
    '</div>' +

    '<div class="card"><h2>重启服务</h2>' +
    '<div class="restart-module">' +
    '<button class="btn btn-restart-weflow" @click="restart(\'weflow\')">重启 WeFlow</button>' +
    '<button class="btn btn-restart-wechat" @click="restart(\'wechat\')">重启 微信</button>' +
    '</div></div>' +

    '<transition name="modal-zoom">' +
    '<div v-if="showTplModal" class="modal-overlay" @click.self="cancelTplEditor">' +
    '<div class="modal">' +
    '<h3>编辑响应模板</h3>' +
    '<p class="text-muted" style="margin:0 0 12px;font-size:13px">点击变量按钮插入到文本框光标位置：</p>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">' +
    '<button class="btn btn-secondary btn-sm" @click="insertVar(\'{version}\')">FlowBot版本：{version}</button>' +
    '<button class="btn btn-secondary btn-sm" @click="insertVar(\'{platform}\')">系统平台：{platform}</button>' +
    '<button class="btn btn-secondary btn-sm" @click="insertVar(\'{uptime}\')">运行时长：{uptime}</button>' +
    '<button class="btn btn-secondary btn-sm" @click="insertVar(\'{weflowVersion}\')">WeFlow版本：{weflowVersion}</button>' +
    '</div>' +
    '<textarea id="flowbot-tpl-textarea" v-model="tplText" style="width:100%;min-height:160px;font-family:monospace;font-size:13px"></textarea>' +
    '<div v-if="tplRestoreConfirm" style="margin-top:8px;padding:10px;background:var(--accent-glow);border-radius:8px;display:flex;align-items:center;justify-content:space-between">' +
    '<span style="font-size:13px;color:var(--text)">确认恢复为默认模板？当前编辑内容将丢失。</span>' +
    '<div style="display:flex;gap:6px">' +
    '<button class="btn btn-danger-secondary btn-sm" @click="tplRestoreConfirm=false">取消</button>' +
    '<button class="btn btn-primary btn-sm" style="background:var(--danger)" @click="resetTpl">确认恢复</button>' +
    '</div></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
    '<button v-if="!tplRestoreConfirm" class="btn btn-danger-secondary btn-sm" @click="confirmResetTpl">恢复默认</button>' +
    '<div style="flex:1"></div>' +
    '<button class="btn btn-danger-secondary" @click="cancelTplEditor">取消</button>' +
    '<button class="btn btn-primary" @click="saveTpl">保存模板</button>' +
    '</div>' +
    '</div></div></transition>' +

    '</div>'
}

var AboutPage = {
  setup: function () {
    var info = reactive({
      flowbotVersion: '-', version: '-', protocol: 'OneBot v11.0',
      node: '-', uptime: '-', memory: '-', disk: '-',
      cpuModel: '-', wechatVersion: '-'
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
    }

    onMounted(load)
    return { info: info }
  },
  template: '<div>' +
    '<h1 class="page-title">关于</h1>' +

    '<div class="card" style="text-align:center">' +
    '<div class="about-logo"><img src="icon.png" alt="FlowBOT"></div>' +
    '<h2 style="border:none;padding:0">FlowBOT | {{ info.flowbotVersion }}</h2>' +
    '<p class="text-muted">基于 WeFlow & OneBot v11 制作的聊天机器人</p>' +
    '<div class="about-info">' +
    '<div class="info-row"><span>WeFlow 版本</span><span>{{ info.version }}</span></div>' +
    '<div class="info-row"><span>微信版本</span><span>{{ info.wechatVersion }}</span></div>' +
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
    '<div class="port-item"><span>OneBot</span><span class="port">7100</span></div>' +
    '<div class="port-item"><span>WeFlow API</span><span class="port">5031</span></div>' +
    '<div class="port-item"><span>WebUI</span><span class="port">7300</span></div>' +
    '<div class="port-item"><span>noVNC</span><span class="port">7600</span></div>' +
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
    var bpParams = reactive({ threshold: 3, cooldownMs: 10000, backoffBaseMs: 1500, imagePasteCapMs: 1500 })
    var ackParams = reactive({ enabled: true, probeEnabled: false, timeoutImageMs: 5000, timeoutVideoMs: 10000, extendWaitMs: 10000, timeoutPerMbMs: 800, timeoutMaxMs: 20000, maxRetriesImage: 1, maxRetriesVideo: 1, failOnTimeoutImage: true, failOnTimeoutVideo: true, retryAction: "re-enter" })
    var status = reactive({
      mode: 'standard',
      queue: { pending: 0, processing: false, currentContent: null, lastSendTime: null, items: [] },
      backpressure: { consecutiveFailures: 0, coolRemainingMs: 0, autoDowngrade: true },
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
        ackParams.enabled = d.sendAckEnabled !== false
        ackParams.probeEnabled = d.sendAckInputClearProbeEnabled === true
        ackParams.timeoutImageMs = d.sendAckTimeoutMsImage || 5000
        ackParams.timeoutVideoMs = d.sendAckTimeoutMsVideo || 10000
        ackParams.extendWaitMs = d.sendAckExtendWaitMs || 10000
        ackParams.timeoutPerMbMs = d.sendAckTimeoutPerMbMs || 800
        ackParams.timeoutMaxMs = d.sendAckTimeoutMaxMs || 20000
        ackParams.maxRetriesImage = d.sendAckImageMaxRetries === undefined ? 1 : d.sendAckImageMaxRetries
        ackParams.maxRetriesVideo = d.sendAckVideoMaxRetries === undefined ? 1 : d.sendAckVideoMaxRetries
        ackParams.failOnTimeoutImage = d.sendAckImageFailOnTimeout !== false
        ackParams.failOnTimeoutVideo = d.sendAckVideoFailOnTimeout !== false
        ackParams.retryAction = d.sendAckRetryAction || 're-enter'
        custom.value = (d.sendDelayCustom && typeof d.sendDelayCustom === 'object') ? d.sendDelayCustom : {}
        initParams()
      }
    }

    function onModeChange() {
      initParams()
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
          autoDowngrade: d.status.backpressure.autoDowngrade !== false
        }) || { consecutiveFailures: 0, coolRemainingMs: 0, autoDowngrade: true }
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

    async function saveMode() {
      saving.value = true
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
          sendAckEnabled: !!ackParams.enabled,
          sendAckInputClearProbeEnabled: !!ackParams.probeEnabled,
          sendAckTimeoutMsImage: Math.max(500, Number(ackParams.timeoutImageMs) || 5000),
          sendAckTimeoutMsVideo: Math.max(500, Number(ackParams.timeoutVideoMs) || 10000),
          sendAckExtendWaitMs: Math.max(0, Number(ackParams.extendWaitMs) || 10000),
          sendAckTimeoutPerMbMs: Math.max(0, Number(ackParams.timeoutPerMbMs) || 800),
          sendAckTimeoutMaxMs: Math.max(1000, Number(ackParams.timeoutMaxMs) || 20000),
          sendAckImageMaxRetries: Math.max(0, Number(ackParams.maxRetriesImage) || 1),
          sendAckVideoMaxRetries: Math.max(0, Number(ackParams.maxRetriesVideo) || 1),
          sendAckImageFailOnTimeout: !!ackParams.failOnTimeoutImage,
          sendAckVideoFailOnTimeout: !!ackParams.failOnTimeoutVideo,
          sendAckRetryAction: ackParams.retryAction
        })
      })
      saving.value = false
      if (d.success) {
        toast('发送配置已保存，下一条消息生效')
        custom.value = buildCustom()
        loadStatus()
      } else {
        toast('保存失败: ' + (d.error || '未知错误'), 'error')
      }
    }

    function resetCustom() {
      custom.value = {}
      initParams()
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

    function stepSummary() {
      var steps = status.lastSendSteps
      if (!steps || !steps.length) return '-'
      var total = 0
      var parts = []
      for (var i = 0; i < steps.length; i++) {
        total += steps[i].ms || 0
        parts.push(steps[i].step + ' ' + steps[i].ms + 'ms')
      }
      return parts.join(' / ') + '（总计 ~' + Math.round(total / 100) / 10 + 's）'
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
      onModeChange: onModeChange, fmtTime: fmtTime, stepSummary: stepSummary
    }
  },
  template: '<div>' +
    '<h1 class="page-title">发送管理</h1>' +

    '<div class="card">' +
    '<h2>当前运行状态</h2>' +
    '<div class="form-row"><label>当前档位</label><span>{{ status.mode }}</span></div>' +
    '<div class="form-row"><label>队列待发</label><span>{{ status.queue.pending }}</span></div>' +
    '<div class="form-row"><label>当前批次</label><span>{{ status.batch.contact ? status.batch.contact + "（" + status.batch.size + " 条）" : "-" }}</span></div>' +
    '<div class="form-row"><label>正在发送</label><span class="status-badge" :class="status.queue.processing ? \'connected\' : \'disconnected\'">{{ status.queue.processing ? "是" : "否" }}</span></div>' +
    '<div class="form-row"><label>队列冷却</label><span :class="status.backpressure.coolRemainingMs > 0 ? \'status-badge disconnected\' : \'\'">{{ status.backpressure.coolRemainingMs > 0 ? "冷却中 " + Math.ceil(status.backpressure.coolRemainingMs / 1000) + "s" : "无" }}</span></div>' +
    '<div class="form-row"><label>连续失败</label><span>{{ status.backpressure.consecutiveFailures }} 次</span></div>' +
    '<div class="form-row"><label>连续成功</label><span>{{ status.successStreak }} 次</span></div>' +
    '<div class="form-row"><label>已去重</label><span>{{ status.dedupCount }} 条</span></div>' +
    '<div class="form-row"><label>吞吐统计</label><span>已发 {{ status.stats.sent }} / 失败 {{ status.stats.failed }}</span></div>' +
    '<div class="form-row"><label>最近发送耗时</label><span style="font-size:12px;text-align:right">{{ stepSummary() }}</span></div>' +
    '<div class="form-row"><label>最近发送</label><span>{{ fmtTime(status.queue.lastSendTime) }}</span></div>' +
    '<div class="form-row"><label>拼音缓存</label><span>{{ status.pinyinCacheSize }} 条 <button class="btn btn-secondary btn-sm" style="margin-left:8px" :disabled="clearingPinyin" @click="clearPinyinCache">{{ clearingPinyin ? "清空中..." : "清空" }}</button></span></div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>发送延时档位</h2>' +
    '<div class="form-row"><label>延时档位</label>' +
    '<select v-model="mode" @change="onModeChange"><option value="safe">安全（慢，更稳）</option><option value="standard">标准</option><option value="aggressive">激进（快，风险高）</option></select>' +
    '</div>' +
    '<div class="form-row"><label>失败自动降档</label><toggle-switch v-model="autoDowngrade" /></div>' +
    '<div class="delay-grid">' +
    '<template v-for="(item, idx) in profileLabels" :key="item.key">' +
    '<div class="delay-group-title" v-if="idx === 6">粘贴发送（剪贴板/粘贴/发送稳定，建议 ≥ 当前值）</div>' +
    '<div class="delay-item">' +
    '<div class="delay-item-label">{{ item.label }}</div>' +
    '<div class="delay-item-input">' +
    '<input type="number" min="0" step="10" v-model.number="params[item.key]">' +
    '<span class="ms">ms</span>' +
    '</div>' +
    '</div>' +
    '</template>' +
    '</div>' +
    '<div style="margin-top:12px">' +
    '<button class="btn btn-secondary" style="margin-right:8px" @click="resetCustom">恢复预设值</button>' +
    '<button class="btn btn-primary" :disabled="saving" @click="saveMode">{{ saving ? "保存中..." : "保存配置" }}</button>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>队列优化</h2>' +
    '<div class="form-row"><label>连续文本合并</label><toggle-switch v-model="mergeEnabled" /></div>' +
    '<div class="form-hint">同一联系人的连续消息将复用已打开的聊天窗口，仅首条搜索联系人，后续直接粘贴发送，发送更快</div>' +
    '<div class="form-row"><label>消息去重</label><toggle-switch v-model="dedupEnabled" /></div>' +
    '<div class="form-hint">同一联系人同时待发的相同文本只保留第一条，避免重复发送</div>' +
    '<div class="form-row"><label>联系人分组优先</label><toggle-switch v-model="priorityEnabled" /></div>' +
    '<div class="form-hint">同一联系人的消息（文字+图片）在队列中连续排列，按首次出现顺序分发，避免图文发送割裂</div>' +
    '<div class="form-row"><label>自适应背压</label><toggle-switch v-model="backpressureEnabled" /></div>' +
    '<div class="form-hint">发送连续失败达到阈值时暂停队列冷却，并自动降档保护；默认关闭</div>' +
    '<div class="form-row"><label>动态缩间隔</label><toggle-switch v-model="dynamicIntervalEnabled" /></div>' +
    '<div class="form-hint">连续成功时自动缩短消息间隔（下限 300ms），失败后复位；默认关闭</div>' +
    '<div class="form-row"><label>失败阈值</label><input type="number" min="1" step="1" v-model.number="bpParams.threshold" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">连续失败达到该次数触发队列冷却（默认 3）</div>' +
    '<div class="form-row"><label>冷却时长(ms)</label><input type="number" min="1000" step="1000" v-model.number="bpParams.cooldownMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">队列暂停时长，默认 10000（10 秒）</div>' +
    '<div class="form-row"><label>退避基数(ms)</label><input type="number" min="100" step="100" v-model.number="bpParams.backoffBaseMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">重试基础间隔，按 1×/2×/4× 递增，上限 6000ms（默认 1500）</div>' +
    '<div class="form-row"><label>大图粘贴等待上限(ms)</label><input type="number" min="400" step="100" v-model.number="bpParams.imagePasteCapMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">大图（≥1MB）粘贴后到发送的最大等待；小图用基准不变，默认 1500</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>媒体发送回执（SendAck）</h2>' +
    '<div class="form-row"><label>启用回执</label><toggle-switch v-model="ackParams.enabled" /></div>' +
    '<div class="form-hint">图片/视频发送后等待 WCDB 回执确认是否真正发出；关闭则恢复“Enter 即成功”</div>' +
    '<div class="form-row"><label>输入框探针（防误发）</label><toggle-switch v-model="ackParams.probeEnabled" /></div>' +
    '<div class="form-hint">超时未确认时抓屏比对输入框是否仍含媒体：已清空则判定疑似已发出、禁止二次 Enter，防误发残留内容（默认关，需 xwd 可用）</div>' +
    '<div class="form-row"><label>图片回执超时(ms)</label><input type="number" min="500" step="500" v-model.number="ackParams.timeoutImageMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">图片提交超时（默认 5000）；大图按体积自动加档</div>' +
    '<div class="form-row"><label>视频回执超时(ms)</label><input type="number" min="500" step="500" v-model.number="ackParams.timeoutVideoMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">视频提交超时（默认 10000）</div>' +
    '<div class="form-row"><label>体积加档(ms/MB)</label><input type="number" min="0" step="100" v-model.number="ackParams.timeoutPerMbMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">媒体每超 1MB 追加的超时（默认 800），0 关闭自适应</div>' +
    '<div class="form-row"><label>超时封顶(ms)</label><input type="number" min="1000" step="1000" v-model.number="ackParams.timeoutMaxMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">自适应超时上限（默认 20000）</div>' +
    '<div class="form-row"><label>扩展等待(ms)</label><input type="number" min="0" step="1000" v-model.number="ackParams.extendWaitMs" style="width:110px;text-align:right"></div>' +
    '<div class="form-hint">探针判定“已发出但 WCDB 未确认”后的等待（默认 10000）</div>' +
    '<div class="form-row"><label>图片失败重试</label><input type="number" min="0" step="1" v-model.number="ackParams.maxRetriesImage" style="width:110px;text-align:right"></div>' +
    '<div class="form-row"><label>视频失败重试</label><input type="number" min="0" step="1" v-model.number="ackParams.maxRetriesVideo" style="width:110px;text-align:right"></div>' +
    '<div class="form-row"><label>超时按失败处理(图)</label><toggle-switch v-model="ackParams.failOnTimeoutImage" /></div>' +
    '<div class="form-row"><label>超时按失败处理(视频)</label><toggle-switch v-model="ackParams.failOnTimeoutVideo" /></div>' +
    '<div class="form-row"><label>兜底动作</label>' +
    '<select v-model="ackParams.retryAction"><option value="re-enter">二次 Enter（不清空，默认）</option><option value="clear-repaste">清空重贴（旧方案）</option><option value="none">只告警</option></select>' +
    '</div>' +
    '<div class="form-hint">未确认时的兜底动作；重试次数=对应 kind 的失败重试+1</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>队列明细</h2>' +
    '<div style="max-height:300px;overflow-y:auto">' +
    '<div class="form-row" v-for="item in status.queue.items" :key="item.id">' +
    '<label>{{ item.contactName }}</label>' +
    '<span style="display:flex;align-items:center;gap:8px;font-size:12px;min-width:0">' +
    '<span class="badge" :class="item.type === \'image\' ? \'warn\' : \'ok\'">{{ item.type === "image" ? "图" : "文" }}</span>' +
    '<span style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ item.contentPreview || "-" }}</span>' +
    '<span style="color:var(--text-muted);flex-shrink:0">{{ item.queuedSeconds }}s</span>' +
    '</span>' +
    '</div>' +
    '<div v-if="!status.queue.items.length" style="color:var(--text-muted);font-size:12px;padding:10px 0">队列为空</div>' +
    '</div>' +
    '<button class="btn btn-danger btn-sm" style="margin-top:10px" :disabled="clearingQueue || !status.queue.items.length" @click="clearQueue">{{ clearingQueue ? "清空中..." : "清空队列" }}</button>' +
    '</div>' +
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
      if (!line) return '#e8eaed'
      var lv = typeof line === 'object' ? (line.level || '').toLowerCase() : ''
      if (lv === 'error' || lv === 'fatal') return '#ff4757'
      if (lv === 'warn') return '#ffa502'
      if (lv === 'debug') return '#8892a4'
      return '#e8eaed'
    },
    levelBadgeColor: function (lv) {
      return this.levelColors[lv] || '#8892a4'
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

    '<div id="log-box" ref="logBox" ' +
    'style="background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;padding:12px;' +
    'height:calc(100vh - 300px);min-height:300px;overflow-y:auto;font-family:monospace;font-size:13px;line-height:1.6">' +
    '<div v-if="loading && logs.length===0" style="color:var(--text-muted,#888)">加载中...</div>' +
    '<div v-else-if="logs.length===0" style="color:var(--text-muted,#888)">暂无日志</div>' +
    '<div v-for="(line, i) in logs" :key="i" :style="{color: logColor(line)}" style="font-family:monospace;white-space:pre-wrap;word-break:break-all"><span style="opacity:0.6">[{{ (line.level || \'info\').toUpperCase() }}]</span> {{ typeof line === \'object\' ? line.raw : line }}</div>' +
    '</div>' +

    '</div>'
}

var LoginPage = {
  setup: function () {
    var password = ref('')
    var loading = ref(false)
    var error = ref('')

    async function doLogin() {
      if (!password.value) { error.value = '请输入密码'; return }
      loading.value = true
      error.value = ''
      var d = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.value })
      })
      loading.value = false
      if (d.ok && d.token) {
        localStorage.setItem('weflow-auth-token', d.token)
        window.location.hash = '#/'
      } else {
        error.value = d.error || '密码错误'
        password.value = ''
      }
    }

    function onKeyup(e) { if (e.key === 'Enter') doLogin() }

    return { password: password, loading: loading, error: error, doLogin: doLogin, onKeyup: onKeyup }
  },
  template: '<div class="login-page">' +
    '<div class="login-card">' +
    '<div class="login-logo"><img src="icon.png" alt="FlowBOT"></div>' +
    '<h2 style="border:none;padding:0;margin:0 0 6px;font-size:22px;color:var(--accent)">FlowBOT</h2>' +
    '<p style="font-size:13px;color:var(--text-muted);margin:0 0 28px">请输入密码以访问管理面板</p>' +
    '<div v-if="error" class="login-error">{{ error }}</div>' +
    '<div style="margin-bottom:18px">' +
    '<input type="password" v-model="password" @keyup="onKeyup" placeholder="输入密码" autofocus ' +
    'style="width:100%;padding:12px 16px;border-radius:10px;font-size:15px;text-align:center;letter-spacing:4px">' +
    '</div>' +
    '<button class="btn btn-primary" @click="doLogin" :disabled="loading" ' +
    'style="width:100%;padding:12px;font-size:15px;border-radius:10px">{{ loading ? \'验证中...\' : \'登录\' }}</button>' +
    '<p style="font-size:11px;color:var(--text-muted);margin:16px 0 0;opacity:0.6">密码在容器启动时生成于 docker logs</p>' +
    '</div></div>'
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
    '<h1 class="page-title">消息推送过滤</h1>' +
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
    '<span class="selected-count">已选择 {{ list.length }} 个会话</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? \'保存中...\' : \'保存设置\' }}</button>' +
    '</div>' +
    '<div v-if="loading" class="filter-loading">加载中...</div>' +
    '<div v-else class="session-list">' +
    '<div v-for="s in filteredSessions" :key="s.username" class="session-row" ' +
    ':class="{ selected: !!selectedSet[s.username] }" @click="toggleOne(s.username)">' +
    '<input type="checkbox" :checked="!!selectedSet[s.username]" @click.stop="toggleOne(s.username)" />' +
    '<div class="session-info">' +
    '<span class="session-name">{{ s.displayName || s.username }}</span>' +
    '<span class="session-id">{{ s.username }}</span>' +
    '</div>' +
    '<span class="session-type" :class="typeClass(s.sessionType || s.type)">{{ typeLabel(s.sessionType || s.type) }}</span>' +
    '<span class="session-time">{{ formatTime(s.lastTimestamp) }}</span>' +
    '</div>' +
    '<div v-if="filteredSessions.length === 0" class="filter-empty">没有匹配的会话</div>' +
    '</div>' +
    '</div></div>'
}

var routes = [
  { path: '/', component: HomePage, meta: { title: '首页' } },
  { path: '/bot', component: BotPage, meta: { title: 'Bot 配置' } },
  { path: '/accounts', component: AccountsPage, meta: { title: '账号管理' } },
  { path: '/filter', component: FilterPage, meta: { title: '消息过滤' } },
  { path: '/settings', component: SettingsPage, meta: { title: '设置' } },
  { path: '/send', component: SendManagerPage, meta: { title: '发送管理' } },
  { path: '/logs', component: LogsPage, meta: { title: '日志' } },
  { path: '/about', component: AboutPage, meta: { title: '关于' } },
  { path: '/login', component: LoginPage, meta: { title: '登录' } }
]

var router = createRouter({ history: createWebHashHistory(), routes: routes })

router.beforeEach(function (to, from, next) {
  if (to.path === '/login') { next(); return }
  var token = localStorage.getItem('weflow-auth-token')
  if (!token) { next('/login'); return }
  next()
})

var App = {
  components: { ToastContainer: ToastContainer, RouterLink: RouterLink, RouterView: RouterView },
  setup: function () {
    var route = useRoute()
    var serviceOnline = ref(false)
    var sidebarOpen = ref(false)

    var navItems = [
      { path: '/', label: '首页', icon: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
      { path: '/bot', label: 'Bot 配置', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>' },
      { path: '/accounts', label: '账号管理', icon: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>' },
      { path: '/filter', label: '消息过滤', icon: '<svg viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>' },
      { path: '/settings', label: '设置', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.5 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
      { path: '/send', label: '发送管理', icon: '<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>' },
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
      statusTimer = setInterval(checkHealth, 15000)
    })
    onUnmounted(function () {
      if (statusTimer) clearInterval(statusTimer)
      if (themeMedia && handleThemeChange) {
        themeMedia.removeEventListener('change', handleThemeChange)
      }
    })

    function logout() {
      localStorage.removeItem('weflow-auth-token')
      window.location.hash = '#/login'
    }

    return {
      route: route, serviceOnline: serviceOnline,
      navItems: navItems, sidebarOpen: sidebarOpen,
      cycleThemeMode: cycleThemeMode, setTheme: setTheme, effectiveTheme: effectiveTheme,
      toggleSidebar: toggleSidebar, closeSidebar: closeSidebar, onNavClick: onNavClick,
      logout: logout
    }
  },
  template: '<div>' +
    '<toast-container />' +
    '<router-view v-if="route.path === \'/login\'" />' +
    '<div v-else class="app-shell">' +

    '<div :class="[\'sidebar-backdrop\', sidebarOpen?\'visible\':\'\']" @click="closeSidebar"></div>' +

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
