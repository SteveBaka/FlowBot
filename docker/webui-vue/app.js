const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, h } = Vue
const { createRouter, createWebHashHistory, useRouter, useRoute, RouterLink, RouterView } = VueRouter

/* ──────────────────────────────────────────────
   Shared state & helpers
   ────────────────────────────────────────────── */

const toasts = ref([])
let toastId = 0
function toast(msg, type) {
  if (!type) type = 'success'
  const id = ++toastId
  toasts.value.push({ id: id, msg: msg, type: type })
  setTimeout(function () {
    toasts.value = toasts.value.filter(function (t) { return t.id !== id })
  }, 3000)
}

async function api(path, opts) {
  try {
    var res = await fetch(path, opts)
    var text = await res.text()
    try {
      var d = JSON.parse(text)
    } catch (_) {
      return { error: 'Non-JSON response (status ' + res.status + ')' }
    }
    if (!res.ok) return { error: d.error || d.message || ('HTTP ' + res.status) }
    return d
  } catch (e) {
    return { error: e.message }
  }
}

/* ──────────────────────────────────────────────
   Components: Toast
   ────────────────────────────────────────────── */

const ToastContainer = {
  setup: function () {
    return { toasts: toasts }
  },
  template: '<div class="toast-container">' +
    '<div v-for="t in toasts" :key="t.id" :class="[\'toast\', t.type]">{{ t.msg }}</div>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Components: Toggle
   ────────────────────────────────────────────── */

const ToggleSwitch = {
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  template: '<label class="toggle">' +
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)">' +
    '<span class="slider"></span>' +
    '</label>'
}

/* ──────────────────────────────────────────────
   Page: 聊天 & 消息过滤
   ────────────────────────────────────────────── */

const ChatPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var filter = reactive({
      pushEnabled: false,
      mode: 'all',
      listText: '',
      sendEnabled: true,
      sendMode: 'foreground',
      notifEnabled: true,
      notifMode: 'all'
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
      else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    onMounted(loadFilter)
    return { filter: filter, loading: loading, saveFilter: saveFilter }
  },
  template: '<div>' +
    '<h1 class="page-title">聊天 & 消息过滤</h1>' +

    '<div class="card">' +
    '<h2>消息推送</h2>' +
    '<div class="form-row"><label>启用消息推送</label><toggle-switch v-model="filter.pushEnabled" /></div>' +
    '<div class="form-row"><label>过滤模式</label>' +
    '<select v-model="filter.mode"><option value="all">全部</option><option value="whitelist">白名单</option><option value="blacklist">黑名单</option></select>' +
    '</div>' +
    '<div class="form-group"><label>过滤列表 (每行一个会话 ID)</label><textarea v-model="filter.listText" rows="4" placeholder="session_id_1\nsession_id_2"></textarea></div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>消息发送</h2>' +
    '<div class="form-row"><label>启用消息发送</label><toggle-switch v-model="filter.sendEnabled" /></div>' +
    '<div class="form-row"><label>发送模式</label>' +
    '<select v-model="filter.sendMode"><option value="foreground">前台</option><option value="background">后台</option></select>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>通知设置</h2>' +
    '<div class="form-row"><label>启用桌面通知</label><toggle-switch v-model="filter.notifEnabled" /></div>' +
    '<div class="form-row"><label>通知过滤模式</label>' +
    '<select v-model="filter.notifMode"><option value="all">全部</option><option value="whitelist">白名单</option><option value="blacklist">黑名单</option></select>' +
    '</div>' +
    '</div>' +

    '<button class="btn btn-primary" @click="saveFilter">保存过滤设置</button>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: Bot 配置
   ────────────────────────────────────────────── */

const BotPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var bot = reactive({
      enabled: false,
      port: 3001,
      accessToken: '',
      selfId: '',
      maxConnections: 10,
      broadcastBatchSize: 100,
      broadcastIntervalMs: 50,
      debounceMs: 350,
      batchSize: 50
    })

    async function loadBot() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        bot.enabled = d.oneBotEnabled || false
        bot.port = d.oneBotPort || 3001
        bot.accessToken = (d.oneBotAccessToken && d.oneBotAccessToken !== '[encrypted]') ? d.oneBotAccessToken : ''
        bot.selfId = d.oneBotSelfId || ''
        bot.maxConnections = d.oneBotMaxConnections || 10
        bot.broadcastBatchSize = d.oneBotBroadcastBatchSize || 100
        bot.broadcastIntervalMs = d.oneBotBroadcastIntervalMs || 50
        bot.debounceMs = d.oneBotDebounceMs || 350
        bot.batchSize = d.oneBotBatchSize || 50
      }
    }

    async function saveBot() {
      var payload = {
        oneBotEnabled: bot.enabled,
        oneBotPort: Number(bot.port),
        oneBotSelfId: bot.selfId,
        oneBotMaxConnections: Number(bot.maxConnections),
        oneBotBroadcastBatchSize: Number(bot.broadcastBatchSize),
        oneBotBroadcastIntervalMs: Number(bot.broadcastIntervalMs),
        oneBotDebounceMs: Number(bot.debounceMs),
        oneBotBatchSize: Number(bot.batchSize)
      }
      if (bot.accessToken) payload.oneBotAccessToken = bot.accessToken
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (d.success) toast('Bot 配置已保存')
      else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    onMounted(loadBot)
    return { bot: bot, saveBot: saveBot }
  },
  template: '<div>' +
    '<h1 class="page-title">Bot 配置 (OneBot v11)</h1>' +

    '<div class="card">' +
    '<h2>服务设置</h2>' +
    '<div class="form-row"><label>启用 OneBot 服务</label><toggle-switch v-model="bot.enabled" /></div>' +
    '<div class="form-row"><label>监听端口</label><input type="number" v-model.number="bot.port"></div>' +
    '<div class="form-row"><label>Access Token</label><input type="text" v-model="bot.accessToken" placeholder="留空不验证"></div>' +
    '<div class="form-row"><label>Self ID (wxid)</label><input type="text" v-model="bot.selfId" placeholder="机器人 wxid"></div>' +
    '</div>' +

    '<div class="card">' +
    '<h2>性能配置</h2>' +
    '<div class="form-row"><label>最大连接数</label><input type="number" v-model.number="bot.maxConnections"></div>' +
    '<div class="form-row"><label>广播批次大小</label><input type="number" v-model.number="bot.broadcastBatchSize"></div>' +
    '<div class="form-row"><label>广播间隔 (ms)</label><input type="number" v-model.number="bot.broadcastIntervalMs"></div>' +
    '<div class="form-row"><label>去抖延迟 (ms)</label><input type="number" v-model.number="bot.debounceMs"></div>' +
    '<div class="form-row"><label>处理批次大小</label><input type="number" v-model.number="bot.batchSize"></div>' +
    '</div>' +

    '<button class="btn btn-primary" @click="saveBot">保存 Bot 配置</button>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: 账号管理
   ────────────────────────────────────────────── */

const AccountsPage = {
  setup: function () {
    var accounts = ref([])
    var currentWxid = ref('')
    var dbpath = ref('未配置')
    var showAdd = ref(false)
    var newAcc = reactive({ wxid: '', name: '', key: '' })
    var rawWxidConfigs = reactive({})

    async function load() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        var wxidConfigs = d.wxidConfigs || {}
        Object.keys(rawWxidConfigs).forEach(function (k) { delete rawWxidConfigs[k] })
        Object.keys(wxidConfigs).forEach(function (k) { rawWxidConfigs[k] = wxidConfigs[k] })
        accounts.value = Object.keys(wxidConfigs).map(function (wxid) {
          return { wxid: wxid, name: wxid }
        })
        currentWxid.value = d.myWxid || ''
        dbpath.value = d.dbPath || '未配置'
      }
    }

    async function addAccount() {
      var wxid = newAcc.wxid.trim()
      if (!wxid) { toast('请输入 wxid', 'error'); return }
      var updatedConfigs = Object.assign({}, rawWxidConfigs)
      updatedConfigs[wxid] = {
        decryptKey: newAcc.key.trim() || undefined,
        updatedAt: Date.now()
      }
      var payload = { wxidConfigs: updatedConfigs, myWxid: wxid }
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      showAdd.value = false
      newAcc.wxid = ''
      newAcc.name = ''
      newAcc.key = ''
      toast('账号已添加')
      load()
    }

    async function setCurrent(wxid) {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myWxid: wxid })
      })
      toast('已切换当前账号')
      load()
    }

    async function removeAccount(wxid) {
      if (!confirm('确认删除账号 ' + wxid + '？')) return
      var updatedConfigs = Object.assign({}, rawWxidConfigs)
      delete updatedConfigs[wxid]
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wxidConfigs: updatedConfigs })
      })
      toast('账号已删除')
      load()
    }

    onMounted(load)
    return {
      accounts: accounts, currentWxid: currentWxid, dbpath: dbpath,
      showAdd: showAdd, newAcc: newAcc,
      addAccount: addAccount, setCurrent: setCurrent, removeAccount: removeAccount, load: load
    }
  },
  template: '<div>' +
    '<div class="page-header">' +
    '<div><h1 class="page-title" style="margin:0">账号管理</h1><p class="subtitle">统一管理切换账号、添加账号、删除账号配置。</p></div>' +
    '<div class="header-actions">' +
    '<button class="btn btn-secondary" @click="load">刷新</button>' +
    '<button class="btn btn-primary" @click="showAdd=true">+ 添加账号</button>' +
    '</div></div>' +

    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">数据库目录</div><div class="stat-value">{{ dbpath }}</div></div>' +
    '<div class="stat-card"><div class="stat-label">当前账号</div><div class="stat-value">{{ currentWxid || "未设置" }}</div></div>' +
    '<div class="stat-card"><div class="stat-label">账号数量</div><div class="stat-value">{{ accounts.length }}</div></div>' +
    '</div>' +

    '<div class="card" v-if="showAdd">' +
    '<h2>添加账号</h2>' +
    '<div class="form-row"><label>wxid</label><input type="text" v-model="newAcc.wxid" placeholder="wxid_xxxxx"></div>' +
    '<div class="form-row"><label>备注名</label><input type="text" v-model="newAcc.name" placeholder="可选"></div>' +
    '<div class="form-row"><label>解密密钥</label><input type="password" v-model="newAcc.key" placeholder="64位十六进制密钥"></div>' +
    '<div class="form-actions">' +
    '<button class="btn btn-secondary" @click="showAdd=false">取消</button>' +
    '<button class="btn btn-primary" @click="addAccount">保存并添加</button>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>已保存账号</h2>' +
    '<div class="account-list">' +
    '<div v-if="accounts.length===0" class="empty-state">暂无已保存账号，点击"添加账号"开始</div>' +
    '<div v-for="a in accounts" :key="a.wxid" :class="[\'account-card\', a.wxid===currentWxid?\'is-current\' : \'\']">' +
    '<div class="account-avatar">{{ (a.name || a.wxid || "?")[0].toUpperCase() }}</div>' +
    '<div class="account-info">' +
    '<div class="account-name">{{ a.name || a.wxid }}</div>' +
    '<div class="account-meta">wxid: {{ a.wxid }}</div>' +
    '<div class="account-badges">' +
    '<span v-if="a.wxid===currentWxid" class="badge current">当前</span>' +
    '<span class="badge ok">已保存配置</span>' +
    '</div></div>' +
    '<div class="account-actions">' +
    '<button v-if="a.wxid!==currentWxid" class="btn btn-secondary btn-sm" @click="setCurrent(a.wxid)">切换</button>' +
    '<button class="btn btn-danger btn-sm" @click="removeAccount(a.wxid)">删除</button>' +
    '</div></div>' +
    '</div></div>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: 数据库
   ────────────────────────────────────────────── */

const DatabasePage = {
  setup: function () {
    var db = reactive({ dbPath: '', imageXorKey: 0, imageAesKey: '' })
    var status = reactive({ connected: false, text: '未连接' })
    var currentWxid = ref('')

    async function load() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        db.dbPath = d.dbPath || ''
        db.imageXorKey = d.imageXorKey || 0
        db.imageAesKey = (d.imageAesKey && d.imageAesKey !== '[encrypted]') ? d.imageAesKey : ''
        currentWxid.value = d.myWxid || ''
        if (d.onboardingDone && d.decryptKey) {
          status.connected = true
          status.text = '已连接'
        } else {
          status.connected = false
          status.text = '未连接'
        }
      }
    }

    async function save() {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dbPath: db.dbPath,
          imageXorKey: Number(db.imageXorKey),
          imageAesKey: db.imageAesKey
        })
      })
      if (d.success) toast('数据库配置已保存')
      else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    onMounted(load)
    return { db: db, status: status, currentWxid: currentWxid, save: save }
  },
  template: '<div>' +
    '<h1 class="page-title">数据库连接</h1>' +
    '<div class="card">' +
    '<h2>连接状态</h2>' +
    '<div class="form-row"><label>数据库根目录</label><input type="text" v-model="db.dbPath" placeholder="/home/user/Documents/xwechat_files"></div>' +
    '<div class="form-row"><label>图片 XOR 密钥</label><input type="number" v-model.number="db.imageXorKey"></div>' +
    '<div class="form-row"><label>图片 AES 密钥</label><input type="text" v-model="db.imageAesKey" placeholder="可选"></div>' +
    '<div :class="[\'status-badge\', status.connected?\'connected\':\'disconnected\']">{{ status.text }}</div>' +
    '</div>' +
    '<button class="btn btn-primary" @click="save">保存数据库配置</button>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: 设置
   ────────────────────────────────────────────── */

const SettingsPage = {
  components: { ToggleSwitch: ToggleSwitch },
  setup: function () {
    var disclaimerAccepted = ref(false)
    var showSyncBanner = ref(false)

    var wf = reactive({
      httpEnabled: false, httpPort: 5031, httpToken: '',
      pushEnabled: false, sendEnabled: true, sendMode: 'foreground',
      theme: 'system', lang: 'zh-CN', debugLog: false
    })
    var settings = reactive({
      autoTranscribeVoice: false, whisperModelName: 'base', logEnabled: false
    })

    async function loadDisclaimer() {
      var d = await api('/api/v1/mgmt/disclaimer')
      if (!d.error) disclaimerAccepted.value = d.accepted === true
    }

    async function loadConfig() {
      var d = await api('/api/v1/mgmt/config')
      if (!d.error) {
        wf.httpEnabled = d.httpApiEnabled || false
        wf.httpPort = d.httpApiPort || 5031
        wf.httpToken = (d.httpApiToken && d.httpApiToken !== '[encrypted]') ? d.httpApiToken : ''
        wf.pushEnabled = d.messagePushEnabled || false
        wf.sendEnabled = d.messageSendEnabled !== false
        wf.sendMode = d.messageSendMode || 'foreground'
        wf.theme = d.theme || 'system'
        wf.lang = d.language || 'zh-CN'
        wf.debugLog = d.logEnabled || false
        settings.autoTranscribeVoice = d.autoTranscribeVoice || false
        settings.whisperModelName = d.whisperModelName || 'base'
        settings.logEnabled = d.logEnabled || false
      }
    }

    async function saveWeFlow() {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          httpApiEnabled: wf.httpEnabled,
          httpApiPort: Number(wf.httpPort),
          messagePushEnabled: wf.pushEnabled,
          messageSendEnabled: wf.sendEnabled,
          messageSendMode: wf.sendMode,
          theme: wf.theme,
          language: wf.lang,
          logEnabled: wf.debugLog
        })
      })
      if (d.success) {
        toast('WeFlow 配置已保存')
        showSyncBanner.value = true
        setTimeout(function () { showSyncBanner.value = false }, 2000)
      } else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    async function saveSettings() {
      var d = await api('/api/v1/mgmt/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoTranscribeVoice: settings.autoTranscribeVoice,
          whisperModelName: settings.whisperModelName,
          logEnabled: settings.logEnabled
        })
      })
      if (d.success) toast('设置已保存')
      else toast('保存失败: ' + (d.error || '未知错误'), 'error')
    }

    function toggleToken() {
      var el = document.getElementById('wf-httpToken-input')
      if (el) el.type = el.type === 'password' ? 'text' : 'password'
    }

    onMounted(function () {
      loadDisclaimer()
      loadConfig()
    })

    return {
      disclaimerAccepted: disclaimerAccepted, showSyncBanner: showSyncBanner,
      wf: wf, settings: settings,
      saveWeFlow: saveWeFlow, saveSettings: saveSettings, toggleToken: toggleToken
    }
  },
  template: '<div>' +
    '<div v-if="showSyncBanner" class="sync-banner">WeFlow 配置已同步</div>' +
    '<h1 class="page-title">设置</h1>' +

    '<div class="card">' +
    '<h2>免责声明</h2>' +
    '<div class="disclaimer-inline">' +
    '<p>状态：{{ disclaimerAccepted ? "已接受" : "未接受" }}</p>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>WeFlow 配置</h2>' +
    '<div class="form-row"><label>HTTP API 启用</label><toggle-switch v-model="wf.httpEnabled" /></div>' +
    '<div class="form-row"><label>HTTP API 端口</label><input type="number" v-model.number="wf.httpPort"></div>' +
    '<div class="form-row"><label>HTTP API Token</label>' +
    '<div class="input-with-toggle">' +
    '<input type="password" id="wf-httpToken-input" v-model="wf.httpToken" placeholder="自动生成">' +
    '<button class="btn btn-secondary btn-sm" @click="toggleToken">显示</button>' +
    '</div></div>' +
    '<div class="form-row"><label>消息推送启用</label><toggle-switch v-model="wf.pushEnabled" /></div>' +
    '<div class="form-row"><label>消息发送启用</label><toggle-switch v-model="wf.sendEnabled" /></div>' +
    '<div class="form-row"><label>消息发送模式</label>' +
    '<select v-model="wf.sendMode"><option value="foreground">前台</option><option value="background">后台</option></select>' +
    '</div>' +
    '<div class="form-row"><label>启用调试日志</label><toggle-switch v-model="wf.debugLog" /></div>' +
    '<button class="btn btn-primary" style="margin-top:12px" @click="saveWeFlow">保存 WeFlow 配置</button>' +
    '</div>' +

    '<div class="card">' +
    '<h2>外观与语言</h2>' +
    '<div class="form-row"><label>主题模式</label>' +
    '<select v-model="wf.theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>' +
    '</div>' +
    '<div class="form-row"><label>语言</label>' +
    '<select v-model="wf.lang"><option value="zh-CN">中文</option><option value="en-US">English</option></select>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>语音转写</h2>' +
    '<div class="form-row"><label>自动转写语音</label><toggle-switch v-model="settings.autoTranscribeVoice" /></div>' +
    '<div class="form-row"><label>Whisper 模型</label>' +
    '<select v-model="settings.whisperModelName"><option value="tiny">tiny</option><option value="base">base</option><option value="small">small</option><option value="medium">medium</option></select>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>日志</h2>' +
    '<div class="form-row"><label>启用调试日志</label><toggle-switch v-model="settings.logEnabled" /></div>' +
    '</div>' +
    '<button class="btn btn-primary" @click="saveSettings">保存设置</button>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: 日志
   ────────────────────────────────────────────── */

const LogsPage = {
  setup: function () {
    var logLines = ref([])
    var loading = ref(false)
    var autoRefresh = ref(false)
    var refreshInterval = ref(10000)
    var level = ref('all')
    var search = ref('')
    var categories = reactive({
      wechat: true, weflow: true, vnc: true, system: true, sender: true, httpapi: false
    })
    var timer = ref(null)
    var searchDebounce = ref(null)
    var viewerRef = ref(null)

    function activeCategories() {
      var cats = []
      for (var k in categories) {
        if (categories[k]) cats.push(k)
      }
      return cats
    }

    async function loadLogs() {
      loading.value = true
      logLines.value = ['[日志功能开发中，敬请期待...]']
      loading.value = false
    }

    function scrollBottom() {
      var el = document.querySelector('.log-viewer-inner')
      if (el) el.scrollTop = el.scrollHeight
    }

    function toggleCategory(cat) {
      categories[cat] = !categories[cat]
    }

    function toggleAutoRefresh() {
      if (timer.value) { clearInterval(timer.value); timer.value = null }
    }

    function onSearchInput() {
    }

    function lineClass(line) {
      var lower = line.toLowerCase()
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('panic')) return 'level-error'
      if (lower.includes('warn')) return 'level-warning'
      return 'level-info'
    }

    function lineTs(line) {
      var m = line.match(/^(\d{4}[-\/]\d{2}[-\/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)/)
      return m ? m[1] : ''
    }

    function lineText(line) {
      var m = line.match(/^(\d{4}[-\/]\d{2}[-\/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s*/)
      return m ? line.substring(m[0].length) : line
    }

    onMounted(function () { loadLogs() })
    onUnmounted(function () {
      if (timer.value) clearInterval(timer.value)
    })

    return {
      logLines: logLines, loading: loading, autoRefresh: autoRefresh,
      refreshInterval: refreshInterval, level: level, search: search,
      categories: categories,
      toggleCategory: toggleCategory, loadLogs: loadLogs,
      onSearchInput: onSearchInput,
      lineClass: lineClass, lineTs: lineTs, lineText: lineText
    }
  },
  template: '<div>' +
    '<h1 class="page-title">日志</h1>' +
    '<div class="card">' +
    '<div class="log-controls">' +
    '<div class="log-categories">' +
    '<button v-for="(active, cat) in categories" :key="cat" :class="[\'log-toggle\', active?\'active\':\'\']" @click="toggleCategory(cat)">' +
    '{{ {wechat:"WeChat 日志",weflow:"WeFlow 日志",vnc:"VNC 日志",system:"系统日志",sender:"LinuxSender 日志",httpapi:"HTTP API 日志"}[cat] || cat }}' +
    '</button>' +
    '</div>' +
    '<div class="log-toolbar">' +
    '<div class="log-toolbar-left">' +
    '<label class="toggle-label">' +
    '<label class="toggle"><input type="checkbox" v-model="autoRefresh"><span class="slider"></span></label>' +
    '<span>自动刷新</span>' +
    '</label>' +
    '</div>' +
    '<div class="log-toolbar-right">' +
    '<input type="text" v-model="search" placeholder="搜索日志..." @input="onSearchInput">' +
    '<button class="btn btn-secondary btn-sm" @click="loadLogs">刷新</button>' +
    '</div></div></div></div>' +

    '<div class="log-viewer">' +
    '<div v-if="logLines.length===0" class="log-empty">{{ loading ? "加载中..." : "暂无日志" }}</div>' +
    '<div v-else class="log-viewer-inner">' +
    '<div v-for="(line, i) in logLines" :key="i" :class="[\'log-line\', lineClass(line)]">' +
    '<span v-if="lineTs(line)" class="log-ts">{{ lineTs(line) }}</span>{{ lineText(line) }}' +
    '</div></div></div>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Page: 关于
   ────────────────────────────────────────────── */

const AboutPage = {
  setup: function () {
    var info = reactive({
      version: '-', protocol: 'OneBot v11.0',
      node: '-', uptime: '-', memory: '-', disk: '-',
      httpPort: 5031, apiEndpoint: '-', apiToken: '-', apiStatus: '-'
    })
    var testSessionId = ref('')
    var testContent = ref('')

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
      var c = await api('/api/v1/mgmt/config')
      if (!c.error) {
        var port = c.httpApiPort || 5031
        var host = window.location.hostname || 'localhost'
        info.httpPort = port
        info.apiEndpoint = 'http://' + host + ':' + port + '/api/v1/messages/send'
        var token = (c.httpApiToken && c.httpApiToken !== '[encrypted]') ? c.httpApiToken : ''
        info.apiToken = token ? token.substring(0, 8) + '...' : '(未设置)'
        info.apiStatus = c.httpApiEnabled ? '已启用' : '未启用'
      }
    }

    async function testSend() {
      var sid = testSessionId.value.trim()
      var content = testContent.value.trim()
      if (!sid || !content) { toast('请输入会话 ID 和消息内容', 'error'); return }
      var d = await api('/api/v1/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, content: content })
      })
      if (!d.error) toast('消息已发送')
      else toast('发送失败: ' + (d.error || '未知错误'), 'error')
    }

    onMounted(load)
    return { info: info, testSessionId: testSessionId, testContent: testContent, testSend: testSend }
  },
  template: '<div>' +
    '<h1 class="page-title">关于</h1>' +

    '<div class="card centered">' +
    '<div class="about-logo">W</div>' +
    '<h2>WeFlow</h2>' +
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

    '<div class="card">' +
    '<h2>免责声明</h2>' +
    '<div style="font-size:12px;color:var(--text2);line-height:1.8;max-height:200px;overflow-y:auto">' +
    '<p>WeFlow 是一款开源的微信聊天记录管理工具，仅供个人学习和研究使用。用户在使用本工具时应当遵守相关法律法规，不得将本工具用于任何非法用途。</p>' +
    '<p style="margin-top:8px">使用本工具即表示您同意以下条款：</p>' +
    '<ol style="padding-left:20px;margin-top:4px">' +
    '<li>本工具仅供个人学习和研究使用，不得用于商业用途</li>' +
    '<li>用户应自行承担使用本工具产生的一切后果</li>' +
    '<li>本工具不收集、存储或传输用户的任何个人数据</li>' +
    '<li>本工具的开发者不对因使用本工具而造成的任何损失负责</li>' +
    '<li>使用本工具即表示您已阅读并同意上述条款</li>' +
    '</ol>' +
    '<p style="margin-top:8px">GitHub: <a href="https://github.com/hicccc77/WeFlow" target="_blank" style="color:var(--accent)">https://github.com/hicccc77/WeFlow</a></p>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>端口映射</h2>' +
    '<div class="port-grid">' +
    '<div class="port-item"><span>OneBot API</span><span class="port">3001</span></div>' +
    '<div class="port-item"><span>WebUI 管理</span><span class="port">5099</span></div>' +
    '<div class="port-item"><span>noVNC 桌面</span><span class="port">6080</span></div>' +
    '<div class="port-item"><span>VNC 内部</span><span class="port">5900</span></div>' +
    '<div class="port-item"><span>WeFlow HTTP</span><span class="port">{{ info.httpPort }}</span></div>' +
    '</div></div>' +

    '<div class="card">' +
    '<h2>HTTP API 信息</h2>' +
    '<div class="about-info">' +
    '<div class="info-row"><span>API 端点</span><span>{{ info.apiEndpoint }}</span></div>' +
    '<div class="info-row"><span>API Token</span><span class="api-token-display">{{ info.apiToken }}</span></div>' +
    '<div class="info-row"><span>API 状态</span><span>{{ info.apiStatus }}</span></div>' +
    '</div>' +
    '<div class="form-row" style="border:none;padding-top:8px">' +
    '<label>发送测试消息</label>' +
    '<div class="input-with-toggle">' +
    '<input type="text" v-model="testSessionId" placeholder="会话 ID">' +
    '<input type="text" v-model="testContent" placeholder="消息内容">' +
    '<button class="btn btn-secondary btn-sm" @click="testSend">发送</button>' +
    '</div></div></div>' +

    '<div class="card">' +
    '<h2>Docker 运行提示</h2>' +
    '<div class="docker-tips">' +
    '<p>获取数据库密钥需要 <code>--cap-add=SYS_PTRACE</code> 权限：</p>' +
    '<div class="code-block">docker run -d --name weflow \\\n  --cap-add=SYS_PTRACE \\\n  -p 3001:3001 -p 5099:5099 -p 6080:6080 \\\n  weflow-onebot</div>' +
    '<p>挂载微信数据目录以访问聊天数据库：</p>' +
    '<div class="code-block">docker run -d --name weflow \\\n  --cap-add=SYS_PTRACE \\\n  -v /path/to/xwechat_files:/data/xwechat_files \\\n  -p 3001:3001 -p 5099:5099 -p 6080:6080 \\\n  weflow-onebot</div>' +
    '<p>使用 docker-compose：</p>' +
    '<div class="code-block">docker compose up -d</div>' +
    '</div></div>' +
    '</div>'
}

/* ──────────────────────────────────────────────
   Disclaimer Overlay
   ────────────────────────────────────────────── */

const DisclaimerOverlay = {
  props: { show: { type: Boolean, default: false } },
  emits: ['accepted'],
  setup: function (props, ctx) {
    var rejected = ref(false)

    async function accept() {
      var d = await api('/api/v1/mgmt/disclaimer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true })
      })
      if (d.success) {
        toast('免责声明已接受')
        ctx.emit('accepted')
      }
    }

    function reject() {
      rejected.value = true
      toast('请关闭容器并执行 docker rm weflow 移除', 'error')
    }

    return { accept: accept, reject: reject, rejected: rejected }
  },
  template: '<div v-if="show" class="disclaimer-overlay">' +
    '<div class="disclaimer-modal">' +
    '<h2>用户协议与隐私政策</h2>' +
    '<div class="disclaimer-text">' +
    '<p>WeFlow 是一款开源的微信聊天记录管理工具。本软件所有数据处理均在本地完成，不会上传任何聊天记录、个人信息到服务器。</p>' +
    '<p style="margin-top:12px;font-weight:600">使用条款：</p>' +
    '<ol style="padding-left:20px;margin-top:4px;line-height:2">' +
    '<li>本软件仅供个人学习研究使用，请勿用于任何非法用途</li>' +
    '<li>用户应确保所查看的数据为本人所有或已获得合法授权</li>' +
    '<li>本软件不收集任何用户隐私数据</li>' +
    '<li>因使用本软件产生的任何损失，开发者不承担任何责任</li>' +
    '</ol></div>' +
    '<div style="display:flex;gap:8px;justify-content:center">' +
    '<button class="btn btn-secondary" @click="reject" :disabled="rejected">不允许</button>' +
    '<button class="btn btn-primary" @click="accept" :disabled="rejected">允许</button>' +
    '</div></div></div>'
}

/* ──────────────────────────────────────────────
   Router
   ────────────────────────────────────────────── */

var routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', component: ChatPage, meta: { title: '聊天 & 消息过滤' } },
  { path: '/bot', component: BotPage, meta: { title: 'Bot 配置' } },
  { path: '/accounts', component: AccountsPage, meta: { title: '账号管理' } },
  { path: '/database', component: DatabasePage, meta: { title: '数据库' } },
  { path: '/settings', component: SettingsPage, meta: { title: '设置' } },
  { path: '/logs', component: LogsPage, meta: { title: '日志' } },
  { path: '/about', component: AboutPage, meta: { title: '关于' } }
]

var router = createRouter({
  history: createWebHashHistory(),
  routes: routes
})

/* ──────────────────────────────────────────────
   Root App
   ────────────────────────────────────────────── */

var App = {
  components: {
    ToastContainer: ToastContainer,
    DisclaimerOverlay: DisclaimerOverlay,
    RouterLink: RouterLink,
    RouterView: RouterView
  },
  setup: function () {
    var route = useRoute()
    var statusOnline = ref(false)
    var statusText = ref('检测中...')
    var disclaimerAccepted = ref(false)
    var disclaimerLoaded = ref(false)

    var navItems = [
      { path: '/chat', label: '聊天 & 消息过滤' },
      { path: '/bot', label: 'Bot 配置' },
      { path: '/accounts', label: '账号管理' },
      { path: '/database', label: '数据库' },
      { path: '/settings', label: '设置' },
      { path: '/logs', label: '日志' },
      { path: '/about', label: '关于' }
    ]

    async function checkStatus() {
      var d = await api('/api/v1/health')
      if (!d.error && d.status === 'ok') {
        statusOnline.value = true
        statusText.value = '运行中'
      } else {
        statusOnline.value = false
        statusText.value = '离线'
      }
    }

    async function checkDisclaimer() {
      var d = await api('/api/v1/mgmt/disclaimer')
      if (!d.error) {
        disclaimerAccepted.value = d.accepted === true
      }
      disclaimerLoaded.value = true
    }

    function onDisclaimerAccepted() {
      disclaimerAccepted.value = true
    }

    var statusTimer = null
    onMounted(function () {
      checkStatus()
      checkDisclaimer()
      statusTimer = setInterval(checkStatus, 15000)
    })
    onUnmounted(function () {
      if (statusTimer) clearInterval(statusTimer)
    })

    return {
      route: route, statusOnline: statusOnline, statusText: statusText,
      disclaimerAccepted: disclaimerAccepted, disclaimerLoaded: disclaimerLoaded,
      navItems: navItems,
      onDisclaimerAccepted: onDisclaimerAccepted
    }
  },
  template: '<div>' +
    '<toast-container />' +
    '<disclaimer-overlay :show="disclaimerLoaded && !disclaimerAccepted" @accepted="onDisclaimerAccepted" />' +

    '<nav class="topbar">' +
    '<div class="topbar-brand">' +
    '<span class="logo">W</span>' +
    '<span class="brand-text">WeFlow</span>' +
    '</div>' +
    '<div class="topbar-tabs">' +
    '<router-link v-for="item in navItems" :key="item.path" :to="item.path" :class="[\'nav-item\', route.path===item.path?\'active\':\'\']">' +
    '{{ item.label }}' +
    '</router-link>' +
    '</div>' +
    '<div class="topbar-status">' +
    '<div :class="[\'status-dot\', statusOnline?\'online\':\'\']"></div>' +
    '<span>{{ statusText }}</span>' +
    '</div></nav>' +

    '<main class="content">' +
    '<router-view v-slot="{ Component }">' +
    '<transition name="page" mode="out-in">' +
    '<component :is="Component" />' +
    '</transition>' +
    '</router-view>' +
    '</main></div>'
}

/* ──────────────────────────────────────────────
   Mount
   ────────────────────────────────────────────── */

var app = createApp(App)
app.use(router)
app.mount('#app')
