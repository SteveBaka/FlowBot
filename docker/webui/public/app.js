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
            var label = (b.mode === 'http' ? 'HTTP' : 'WS') + ':' + b.name
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
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.onebot.color)}"></span><span class="stat-label">OneBot 状态</span></div>' +
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
    var modalToken = ref('')
    var editingBotId = ref(null)

    async function loadBots() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error && d.bots) {
        try {
          var parsed = typeof d.bots === 'string' ? JSON.parse(d.bots) : d.bots
          if (Array.isArray(parsed)) bots.value = parsed
        } catch (e) {}
      }
    }

    function openAddModal() {
      editingBotId.value = null
      modalStep.value = 1
      modalMode.value = ''
      modalDirection.value = 'server'
      modalBotName.value = 'Bot ' + (bots.value.length + 1)
      modalUrl.value = 'ws://127.0.0.1:6199/ws'
      modalToken.value = generateToken()
      showModal.value = true
    }

    function closeModal() { showModal.value = false }

    function selectMode(mode) {
      modalMode.value = mode
      modalStep.value = mode === 'http' ? 3 : 2
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
      var urlMatch = modalUrl.value.match(/^(wss?):\/\/([^:\/]+):?(\d+)(\/.*)?$/)
      var address = urlMatch ? urlMatch[2] : '127.0.0.1'
      var port = urlMatch ? parseInt(urlMatch[3]) : 6199
      if (editingBotId.value) {
        bots.value = bots.value.map(function (b) {
          if (b.id === editingBotId.value) {
            return Object.assign({}, b, {
              name: modalBotName.value || b.name,
              mode: modalMode.value,
              direction: modalDirection.value,
              url: modalUrl.value,
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
          url: modalUrl.value,
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
      modalUrl.value = botItem.url || ('ws://' + botItem.address + ':' + botItem.port + '/ws')
      modalToken.value = botItem.token
      modalStep.value = 3
      showModal.value = true
    }

    async function testBot(botItem) {
      toast('正在测试连接...', 'info')
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

    function modeBadge(m) { return m === 'http' ? 'badge-http' : 'badge-ws' }
    function modeLabel(m) { return m === 'http' ? 'HTTP' : 'WS' }
    function dirBadge(d) { return d === 'server' ? 'badge-server' : 'badge-client' }
    function dirLabel(d) { return d === 'server' ? '服务端' : '客户端' }

    onMounted(loadBots)
    return {
      bots: bots, showModal: showModal, modalStep: modalStep,
      modalMode: modalMode, modalDirection: modalDirection,
      modalBotName: modalBotName, modalUrl: modalUrl,
      modalToken: modalToken,
      editingBotId: editingBotId,
      openAddModal: openAddModal, closeModal: closeModal,
      selectMode: selectMode, selectDirection: selectDirection,
      addBot: addBot, toggleBot: toggleBot, deleteBot: deleteBot,
      editBot: editBot, testBot: testBot,
      modeBadge: modeBadge, modeLabel: modeLabel,
      dirBadge: dirBadge, dirLabel: dirLabel,
      loadBots: loadBots
    }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">Bot 配置</h1><p class="subtitle">管理多个 OneBot v11 连接</p></div>' +
    '<div class="header-actions"><button class="btn btn-secondary" @click="loadBots">刷新</button></div></div>' +

    '<div v-for="b in bots" :key="b.id" class="bot-card">' +
    '<div class="bot-info">' +
    '<div class="bot-name">{{ b.name }}</div>' +
    '<div class="bot-meta">' +
    '<span :class="[\'badge\', modeBadge(b.mode)]">{{ modeLabel(b.mode) }}</span>' +
    '<span :class="[\'badge\', dirBadge(b.direction)]">{{ dirLabel(b.direction) }}</span>' +
    '<span>{{ b.url || (b.address + ":" + b.port) }}</span>' +
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
    '<div style="font-size:12px;color:var(--text-muted)">HTTP 服务端</div></div>' +
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
    '<div class="form-group"><label>URL *</label><input type="text" v-model="modalUrl" placeholder="ws://127.0.0.1:6199/ws"></div>' +
    '<div class="form-group"><label>Token</label><input type="text" v-model="modalToken" placeholder="自动生成"></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
    '<button class="btn btn-secondary" @click="editingBotId ? closeModal() : (modalStep = modalMode===\'http\' ? 1 : 2)">{{ editingBotId ? "取消" : "返回" }}</button>' +
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

    async function loadConfig() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        wf.httpEnabled = d.httpApiEnabled || false
        wf.httpPort = d.httpApiPort || 5031
        wf.httpToken = (d.httpApiToken && d.httpApiToken !== '[encrypted]') ? d.httpApiToken : ''
        imgTransfer.mode = d.imageTransferMode || 'base64'
        imgTransfer.baseUrl = d.imageServerBaseUrl || ''
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
          toast('地址格式无效，请填写完整的 URL（如 http://192.168.1.100:7300）', 'error')
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
          imageServerBaseUrl: trimmedUrl
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

    onMounted(loadConfig)
    return { wf: wf, showHttpToken: showHttpToken, imgTransfer: imgTransfer, baseUrlError: baseUrlError, saveConfig: saveConfig, restart: restart }
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
    '外部服务（如 AstrBot）用于下载图片的完整地址。请填写从 AstrBot 所在机器能访问到的 IP 和端口。格式: http://&lt;宿主机IP&gt;:7300' +
    '</span>' +
    '</div>' +
    '<input type="text" v-model="imgTransfer.baseUrl" ' +
    'placeholder="http://192.168.1.100:7300" ' +
    ':class="{ \'input-error\': baseUrlError }" ' +
    ':disabled="imgTransfer.mode === \'base64\'">' +
    '</div>' +
    '</div>' +

    '<div class="card"><h2>重启服务</h2>' +
    '<div class="restart-module">' +
    '<button class="btn btn-restart-weflow" @click="restart(\'weflow\')">重启 WeFlow</button>' +
    '<button class="btn btn-restart-wechat" @click="restart(\'wechat\')">重启 微信</button>' +
    '</div>' +
    '</div>' +
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
    '<div class="about-logo">W</div>' +
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
    '<div class="login-logo">W</div>' +
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

var routes = [
  { path: '/', component: HomePage, meta: { title: '首页' } },
  { path: '/bot', component: BotPage, meta: { title: 'Bot 配置' } },
  { path: '/accounts', component: AccountsPage, meta: { title: '账号管理' } },
  { path: '/settings', component: SettingsPage, meta: { title: '设置' } },
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
    'class="nav-btn" @click="onNavClick">' +
    '<span class="nav-icon" v-html="item.icon"></span>' +
    '<span class="nav-label">{{ item.label }}</span>' +
    '</router-link></nav>' +
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
