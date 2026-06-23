var _a = Vue, createApp = _a.createApp, ref = _a.ref, reactive = _a.reactive, computed = _a.computed, watch = _a.watch, onMounted = _a.onMounted, onUnmounted = _a.onUnmounted, nextTick = _a.nextTick, h = _a.h
var _b = VueRouter, createRouter = _b.createRouter, createWebHashHistory = _b.createWebHashHistory, useRouter = _b.useRouter, useRoute = _b.useRoute, RouterLink = _b.RouterLink, RouterView = _b.RouterView

var toasts = ref([])
var toastId = 0
function toast(msg, type) {
  if (!type) type = 'success'
  var id = ++toastId
  toasts.value.push({ id: id, msg: msg, type: type })
  setTimeout(function () {
    toasts.value = toasts.value.filter(function (t) { return t.id !== id })
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
    var res = await fetch(path, opts)
    var text = await res.text()
    try { var d = JSON.parse(text) } catch (_) { return { error: 'Non-JSON response (status ' + res.status + ')' } }
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
    '<div v-for="t in toasts" :key="t.id" :class="[\'toast\', t.type]">{{ t.msg }}</div>' +
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
      return '#8892a4'
    }

    async function load() {
      cards.login.loading = true
      cards.onebot.loading = true
      cards.account.loading = true
      cards.database.loading = true
      cards.system.loading = true

      var c = await api('/api/v1/mgmt/config')
      if (!c.error) {
        if (c.myWxid && c.onboardingDone) { cards.login.status = '已登录'; cards.login.color = 'green' }
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
        var enabled = bots.filter(function (b) { return b.enabled })
        if (enabled.length > 0) {
          var modes = enabled.map(function (b) { return b.mode === 'http' ? 'HTTP' : 'WS' })
          modes = modes.filter(function (v, i, a) { return a.indexOf(v) === i })
          cards.onebot.status = '运行中'
          cards.onebot.color = 'green'
          cards.onebot.sub = modes.join(', ') + ' (' + enabled.length + ')'
        } else {
          cards.onebot.status = '未启动'
          cards.onebot.color = 'red'
          cards.onebot.sub = ''
        }
        cards.onebot.loading = false
      }

      var s = await api('/api/v1/mgmt/system')
      if (!s.error) {
        var parts = []
        if (s.uptime) parts.push('运行 ' + Math.floor(s.uptime / 3600) + 'h' + Math.floor((s.uptime % 3600) / 60) + 'm')
        if (s.memory) parts.push('内存 ' + Math.round(s.memory.used / 1024 / 1024) + 'MB')
        if (s.platform) parts.push(s.platform + ' ' + s.arch)
        cards.system.status = parts.join(' | ') || '-'
        cards.system.color = 'green'
        cards.system.sub = ''
      }
      cards.system.loading = false
    }

    onMounted(load)
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
    '<div class="stat-value">{{ cards.onebot.status }}</div>' +
    '<div v-if="cards.onebot.sub" class="stat-sub">{{ cards.onebot.sub }}</div>' +
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

    '<div class="stat-card">' +
    '<div class="stat-header"><span class="stat-dot" :style="{background:dotColor(cards.system.color)}"></span><span class="stat-label">系统信息</span></div>' +
    '<div class="stat-value" style="font-size:13px">{{ cards.system.status }}</div>' +
    '</div>' +

    '</div></div>'
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
    var modalAddress = ref('127.0.0.1')
    var modalPort = ref(3001)
    var modalToken = ref('')

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
      modalStep.value = 1
      modalMode.value = ''
      modalDirection.value = 'server'
      modalBotName.value = 'Bot ' + (bots.value.length + 1)
      modalAddress.value = '127.0.0.1'
      modalPort.value = 3001 + bots.value.length
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
        toast('Bot 配置已保存')
        loadBots()
      } else {
        toast('保存失败: ' + (d.error || ''), 'error')
      }
    }

    async function addBot() {
      var id = 'bot_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)
      var newBot = {
        id: id,
        name: modalBotName.value || 'Bot ' + (bots.value.length + 1),
        mode: modalMode.value,
        direction: modalDirection.value,
        address: modalAddress.value || '127.0.0.1',
        port: Number(modalPort.value) || 3001,
        token: modalToken.value,
        enabled: true
      }
      bots.value = bots.value.concat([newBot])
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

    function modeBadge(m) { return m === 'http' ? 'badge-http' : 'badge-ws' }
    function modeLabel(m) { return m === 'http' ? 'HTTP' : 'WS' }
    function dirBadge(d) { return d === 'server' ? 'badge-server' : 'badge-client' }
    function dirLabel(d) { return d === 'server' ? '服务端' : '客户端' }

    onMounted(loadBots)
    return {
      bots: bots, showModal: showModal, modalStep: modalStep,
      modalMode: modalMode, modalDirection: modalDirection,
      modalBotName: modalBotName, modalAddress: modalAddress,
      modalPort: modalPort, modalToken: modalToken,
      openAddModal: openAddModal, closeModal: closeModal,
      selectMode: selectMode, selectDirection: selectDirection,
      addBot: addBot, toggleBot: toggleBot, deleteBot: deleteBot,
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
    '<span>{{ b.address }}:{{ b.port }}</span>' +
    '</div></div>' +
    '<div class="bot-actions">' +
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
    '<h3>配置 Bot</h3>' +
    '<div class="form-group"><label>名称</label><input type="text" v-model="modalBotName" placeholder="Bot 1"></div>' +
    '<div class="form-group"><label>地址</label><input type="text" v-model="modalAddress" placeholder="127.0.0.1"></div>' +
    '<div class="form-group"><label>端口</label><input type="number" v-model.number="modalPort"></div>' +
    '<div class="form-group"><label>Token</label><input type="text" v-model="modalToken" placeholder="自动生成"></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">' +
    '<button class="btn btn-secondary" @click="modalStep = modalMode===\'http\' ? 1 : 2">返回</button>' +
    '<button class="btn btn-primary" @click="addBot">保存</button>' +
    '</div></div>' +

    '</div></transition>' +
    '</div></div></div>'
}

var ChatPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var filter = reactive({
      pushEnabled: false, mode: 'all', listText: '',
      sendEnabled: true, sendMode: 'foreground',
      notifEnabled: true, notifMode: 'all'
    })
    var loading = ref(true)

    async function loadFilter() {
      loading.value = true
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        filter.pushEnabled = d.messagePushEnabled || false
        filter.mode = d.messagePushFilterMode || 'all'
        filter.listText = (d.messagePushFilterList || []).join('\n')
        filter.sendEnabled = d.messageSendEnabled !== false
        filter.sendMode = d.messageSendMode || 'foreground'
        filter.notifEnabled = d.notificationEnabled !== false
        filter.notifMode = d.notificationFilterMode || 'all'
      }
      loading.value = false
    }

    async function saveFilter() {
      var list = filter.listText.split('\n').map(function (s) { return s.trim() }).filter(Boolean)
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messagePushEnabled: filter.pushEnabled,
          messagePushFilterMode: filter.mode,
          messagePushFilterList: list,
          messageSendEnabled: filter.sendEnabled,
          messageSendMode: filter.sendMode,
          notificationEnabled: filter.notifEnabled,
          notificationFilterMode: filter.notifMode
        })
      })
      if (d.success) toast('过滤设置已保存')
      else toast('保存失败: ' + (d.error || ''), 'error')
    }

    onMounted(loadFilter)
    return { filter: filter, loading: loading, saveFilter: saveFilter }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">聊天 & 消息过滤</h1><p class="subtitle">配置消息推送、发送与通知规则</p></div>' +
    '<div class="header-actions"><button class="btn btn-primary" @click="saveFilter">保存过滤设置</button></div></div>' +

    '<div class="card"><h2>消息推送</h2>' +
    '<div class="form-row"><label>启用消息推送</label><toggle-switch v-model="filter.pushEnabled" /></div>' +
    '<div class="form-row"><label>过滤模式</label>' +
    '<select v-model="filter.mode"><option value="all">全部</option><option value="whitelist">白名单</option><option value="blacklist">黑名单</option></select></div>' +
    '<div class="form-group"><label>过滤列表 (每行一个会话 ID)</label><textarea v-model="filter.listText" rows="4" placeholder="session_id_1&#10;session_id_2"></textarea></div></div>' +

    '<div class="card"><h2>消息发送</h2>' +
    '<div class="form-row"><label>启用消息发送</label><toggle-switch v-model="filter.sendEnabled" /></div>' +
    '<div class="form-row"><label>发送模式</label>' +
    '<select v-model="filter.sendMode"><option value="foreground">前台</option><option value="background">后台</option></select></div></div>' +

    '<div class="card"><h2>通知设置</h2>' +
    '<div class="form-row"><label>启用桌面通知</label><toggle-switch v-model="filter.notifEnabled" /></div>' +
    '<div class="form-row"><label>通知过滤模式</label>' +
    '<select v-model="filter.notifMode"><option value="all">全部</option><option value="whitelist">白名单</option><option value="blacklist">黑名单</option></select></div></div>' +
    '</div>'
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
      window.open('http://' + window.location.hostname + ':6080/vnc.html', '_blank')
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
    '<p>请在 noVNC 虚拟桌面中操作 WeFlow 以进行登录，然后回到本页面刷新。</p>' +
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
      httpEnabled: false, httpPort: 5031, httpToken: '',
      pushEnabled: false, sendEnabled: true, sendMode: 'foreground'
    })
    var settings = reactive({ logEnabled: false })
    var showHttpToken = ref(false)

    async function loadConfig() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        wf.httpEnabled = d.httpApiEnabled || false
        wf.httpPort = d.httpApiPort || 5031
        wf.httpToken = (d.httpApiToken && d.httpApiToken !== '[encrypted]') ? d.httpApiToken : ''
        wf.pushEnabled = d.messagePushEnabled || false
        wf.sendEnabled = d.messageSendEnabled !== false
        wf.sendMode = d.messageSendMode || 'foreground'
        settings.logEnabled = d.logEnabled || false
      }
    }

    async function saveConfig() {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          httpApiEnabled: wf.httpEnabled,
          httpApiPort: Number(wf.httpPort),
          httpApiToken: wf.httpToken || undefined,
          messagePushEnabled: wf.pushEnabled,
          messageSendEnabled: wf.sendEnabled,
          messageSendMode: wf.sendMode,
          logEnabled: settings.logEnabled
        })
      })
      if (d.success) toast('配置已保存')
      else toast('保存失败: ' + (d.error || ''), 'error')
    }

    onMounted(loadConfig)
    return { wf: wf, settings: settings, showHttpToken: showHttpToken, saveConfig: saveConfig }
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

    '<div class="card"><h2>消息设置</h2>' +
    '<div class="form-row"><label>消息推送启用</label><toggle-switch v-model="wf.pushEnabled" /></div>' +
    '<div class="form-row"><label>消息发送启用</label><toggle-switch v-model="wf.sendEnabled" /></div>' +
    '<div class="form-row"><label>消息发送模式</label>' +
    '<select v-model="wf.sendMode"><option value="foreground">前台</option><option value="background">后台</option></select></div></div>' +

    '<div class="card"><h2>日志</h2>' +
    '<div class="form-row"><label>启用调试日志</label><toggle-switch v-model="settings.logEnabled" /></div>' +
    '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">控制 WeFlow 主进程的调试日志输出，重启后生效</p></div>' +
    '</div>'
}

var AboutPage = {
  setup: function () {
    var info = reactive({
      version: '-', protocol: 'OneBot v11.0',
      node: '-', uptime: '-', memory: '-', disk: '-'
    })

    async function load() {
      var s = await api('/api/v1/mgmt/system')
      if (!s.error) {
        info.version = s.appVersion || s.electronVersion || '-'
        info.node = s.nodeVersion || '-'
        info.uptime = s.uptime ? (Math.floor(s.uptime / 3600) + 'h ' + Math.floor((s.uptime % 3600) / 60) + 'm') : '-'
        if (s.memory) {
          var usedMB = Math.round(s.memory.used / 1024 / 1024)
          var totalMB = Math.round(s.memory.total / 1024 / 1024)
          info.memory = usedMB + 'MB / ' + totalMB + 'MB (' + s.memory.usedPercent + ')'
        }
        info.disk = s.platform + ' ' + s.arch + ' (' + s.cpus + ' cores)'
      }
    }

    onMounted(load)
    return { info: info }
  },
  template: '<div>' +
    '<h1 class="page-title">关于</h1>' +

    '<div class="card" style="text-align:center">' +
    '<div class="about-logo">W</div>' +
    '<h2 style="border:none;padding:0">WeFlow</h2>' +
    '<p class="text-muted">微信聊天记录管理 & OneBot v11 服务</p>' +
    '<div class="about-info">' +
    '<div class="info-row"><span>版本</span><span>{{ info.version }}</span></div>' +
    '<div class="info-row"><span>协议</span><span>{{ info.protocol }}</span></div>' +
    '<div class="info-row"><span>Node.js</span><span>{{ info.node }}</span></div>' +
    '<div class="info-row"><span>系统运行时间</span><span>{{ info.uptime }}</span></div>' +
    '<div class="info-row"><span>内存</span><span>{{ info.memory }}</span></div>' +
    '<div class="info-row"><span>磁盘/CPU</span><span>{{ info.disk }}</span></div>' +
    '</div>' +
    '<div class="about-links">' +
    '<a href="https://github.com/hicccc77/WeFlow" target="_blank">GitHub</a>' +
    '<span> &middot; </span>' +
    '<a href="https://github.com/botuniverse/onebot-11" target="_blank">OneBot v11</a>' +
    '</div></div>' +

    '<p style="font-size:13px;color:var(--text-muted);line-height:1.8;margin-bottom:16px">' +
    'WeFlow 是一款开源的微信聊天记录管理工具，仅供个人学习和研究使用。用户在使用本工具时应当遵守相关法律法规，不得将本工具用于任何非法用途。' +
    '使用本工具即表示您同意：本工具仅供个人学习和研究使用；用户应自行承担使用本工具产生的一切后果；本工具不收集、存储或传输用户的任何个人数据；' +
    '本工具的开发者不对因使用本工具而造成的任何损失负责。' +
    '</p>' +

    '<div class="card"><h2>端口映射</h2>' +
    '<div class="port-grid">' +
    '<div class="port-item"><span>OneBot</span><span class="port">3001</span></div>' +
    '<div class="port-item"><span>WeFlow API</span><span class="port">5031</span></div>' +
    '<div class="port-item"><span>WebUI</span><span class="port">5099</span></div>' +
    '<div class="port-item"><span>noVNC</span><span class="port">6080</span></div>' +
    '</div></div>' +

    '<div class="card"><h2>Docker 运行提示</h2>' +
    '<div class="docker-tips">' +
    '<p>获取数据库密钥需要 <code>--cap-add=SYS_PTRACE</code> 权限：</p>' +
    '<div class="code-block">docker run -d --name weflow \\\n  --cap-add=SYS_PTRACE \\\n  -p 3001:3001 -p 5031:5031 -p 5099:5099 -p 6080:6080 \\\n  weflow-onebot</div>' +
    '<p>挂载微信数据目录以访问聊天数据库：</p>' +
    '<div class="code-block">docker run -d --name weflow \\\n  --cap-add=SYS_PTRACE \\\n  -v /path/to/xwechat_files:/data/xwechat_files \\\n  -p 3001:3001 -p 5031:5031 -p 5099:5099 -p 6080:6080 \\\n  weflow-onebot</div>' +
    '<p>使用 docker-compose：</p>' +
    '<div class="code-block">docker compose up -d</div>' +
    '</div></transition>' +
    '</div></div></div>'
}

var routes = [
  { path: '/', component: HomePage, meta: { title: '首页' } },
  { path: '/bot', component: BotPage, meta: { title: 'Bot 配置' } },
  { path: '/chat', component: ChatPage, meta: { title: '聊天 & 消息过滤' } },
  { path: '/accounts', component: AccountsPage, meta: { title: '账号管理' } },
  { path: '/settings', component: SettingsPage, meta: { title: '设置' } },
  { path: '/about', component: AboutPage, meta: { title: '关于' } }
]

var router = createRouter({ history: createWebHashHistory(), routes: routes })

var App = {
  components: { ToastContainer: ToastContainer, RouterLink: RouterLink, RouterView: RouterView },
  setup: function () {
    var route = useRoute()
    var serviceOnline = ref(false)
    var sidebarOpen = ref(false)

    var navItems = [
      { path: '/', label: '首页', icon: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
      { path: '/bot', label: 'Bot 配置', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>' },
      { path: '/chat', label: '聊天 & 消息过滤', icon: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
      { path: '/accounts', label: '账号管理', icon: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>' },
      { path: '/settings', label: '设置', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.5 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
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

    return {
      route: route, serviceOnline: serviceOnline,
      navItems: navItems, sidebarOpen: sidebarOpen,
      cycleThemeMode: cycleThemeMode, setTheme: setTheme, effectiveTheme: effectiveTheme,
      toggleSidebar: toggleSidebar, closeSidebar: closeSidebar, onNavClick: onNavClick
    }
  },
  template: '<div>' +
    '<toast-container />' +
    '<div class="app-shell">' +

    '<div :class="[\'sidebar-backdrop\', sidebarOpen?\'visible\':\'\']" @click="closeSidebar"></div>' +

    '<aside :class="[\'sidebar\', sidebarOpen?\'open\':\'\']">' +

    '<div class="sidebar-module module-brand">' +
    '<div class="logo">' +
    '<h1>WeFlow</h1>' +
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
