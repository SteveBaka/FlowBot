const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const PORT = process.env.WEBUI_PORT || 7300
const ONEBOT_PORT = process.env.ONEBOT_PORT || 7100
const FLOW_PORT = process.env.FLOW_API_PORT || 5031
const CONFIG_DIR = process.env.WEFLOW_CONFIG_DIR || '/opt/weflow/data'
const CONFIG_FILE = path.join(CONFIG_DIR, 'webui-config.json')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function file(res, fp) {
  try {
    const c = fs.readFileSync(fp)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    })
    res.end(c)
  } catch { res.writeHead(404); res.end('Not Found') }
}

function body(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve({}) } })
  })
}

function shell(cmd) {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim() } catch { return '' }
}

function ensureDirSync(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

// ─── Auth (scrypt-hashed password, in-memory tokens) ─────────────────────────

const AUTH_FILE = path.join(CONFIG_DIR, 'webui-auth.json')
const activeTokens = new Set()

function verifyPassword(password) {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
    const hash = crypto.scryptSync(password, auth.salt, 64).toString('hex')
    return hash === auth.hash
  } catch { return false }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function isAuthenticated(req) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '').trim()
  return token.length > 0 && activeTokens.has(token)
}

// ─── WeFlow config path discovery (dynamic) ───────────────────────────────────

const HOME = process.env.HOME || '/root'

function discoverWeFlowConfigPath() {
  const candidates = [
    '/root/.config/WeFlow/WeFlow-config.json',
    '/root/.config/electron-store/WeFlow-config.json',
    path.join(HOME, '.config', 'WeFlow', 'WeFlow-config.json')
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  // Shell fallback
  try {
    const found = shell("find /root -name 'WeFlow-config.json' -type f 2>/dev/null")
    if (found) return found.split('\n')[0]
  } catch {}
  return candidates[0]
}

// ─── WeFlow config read/write ─────────────────────────────────────────────────

function loadWeFlowConfig() {
  const configPath = discoverWeFlowConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      return { _path: configPath, ...(raw.value || raw) }
    }
  } catch {}
  return { _path: configPath }
}

function saveWeFlowConfig(partial) {
  const configPath = discoverWeFlowConfigPath()
  const dir = path.dirname(configPath)
  ensureDirSync(dir)

  let existing = {}
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      existing = raw.value || raw
    }
  } catch {}

  const merged = { ...existing, ...partial }
  const wrapper = { value: merged }
  try {
    fs.writeFileSync(configPath, JSON.stringify(wrapper, null, 2))
  } catch (err) {
    console.error('[WebUI] Failed to save WeFlow config:', err.message)
  }
  return merged
}

// ─── API Token ────────────────────────────────────────────────────────────────

const TOKEN_FILE = '/opt/weflow/data/http-api-token.txt'

function readApiToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
      if (token) return token
    }
  } catch {}
  try {
    const cfg = loadWeFlowConfig()
    const val = String(cfg.httpApiToken || '').trim()
    if (val && !val.startsWith('safe:')) return val
  } catch {}
  return ''
}

// ─── Disclaimer persistence ───────────────────────────────────────────────────

const DISCLAIMER_FILE = path.join(CONFIG_DIR, 'disclaimer-accepted')

function isDisclaimerAccepted() {
  try { return fs.existsSync(DISCLAIMER_FILE) } catch { return false }
}

function acceptDisclaimer() {
  ensureDirSync(CONFIG_DIR)
  try { fs.writeFileSync(DISCLAIMER_FILE, '1') } catch (err) {
    console.error('[WebUI] Failed to write disclaimer file:', err.message)
  }
}

// ─── WebUI config (per-container) ──────────────────────────────────────────────

function loadWebuiConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {}
  return {}
}

function saveWebuiConfig(cfg) {
  ensureDirSync(CONFIG_DIR)
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.error('[WebUI] Failed to save WebUI config:', err.message)
  }
}

// ─── Logs (single source: container.log) ─────────────────────────────────────

const CONTAINER_LOG = '/opt/weflow/data/logs/container.log'
const WEFLOW_LOG_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+\[(\w+)\]\s+\[(\w+)\]\s+(.*)/

function parseContainerLog(maxLines, categories, levels, search) {
  if (!fs.existsSync(CONTAINER_LOG)) return []
  var content
  try { content = fs.readFileSync(CONTAINER_LOG, 'utf-8') } catch { return [] }
  var rawLines = content.split('\n')
  var results = []
  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i]
    if (!line) continue
    var m = WEFLOW_LOG_RE.exec(line)
    var ts = '', level = 'info', category = 'system', msg = line
    if (m) {
      ts = m[1]
      level = m[2].toLowerCase()
      category = m[3].toLowerCase()
      msg = m[4]
    } else {
      var lower = line.toLowerCase()
      if (lower.indexOf('wechat') !== -1 || lower.indexOf('wechatappex') !== -1) category = 'wechat'
      else if (lower.indexOf('x11vnc') !== -1 || lower.indexOf('xvfb') !== -1 || lower.indexOf('vnc') !== -1) category = 'vnc'
      else if (lower.indexOf('fluxbox') !== -1) category = 'system'
      else if (lower.indexOf('onebot') !== -1 || lower.indexOf('wsclient') !== -1 || lower.indexOf('botmanager') !== -1) category = 'onebot'
      else category = 'system'
      if (lower.indexOf('error') !== -1 || lower.indexOf('fatal') !== -1 || lower.indexOf('fail') !== -1) level = 'error'
      else if (lower.indexOf('warn') !== -1) level = 'warn'
      else if (lower.indexOf('debug') !== -1) level = 'debug'
    }
    if (categories && categories.length > 0 && categories.indexOf(category) === -1) continue
    if (levels && levels.length > 0 && levels.indexOf(level) === -1) continue
    if (search && line.toLowerCase().indexOf(search) === -1) continue
    results.push({ timestamp: ts, level: level, category: category, message: msg, raw: line })
  }
  if (results.length > maxLines) results = results.slice(results.length - maxLines)
  return results
}

// ─── HTTP API proxy helper ────────────────────────────────────────────────────

async function proxyRequest(targetUrl, options = {}) {
  const { method = 'GET', headers = {}, body: reqBody } = options
  const fetchOptions = { method, headers: { ...headers } }
  if (reqBody !== undefined) {
    fetchOptions.headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(reqBody)
  }
  const resp = await fetch(targetUrl, fetchOptions)
  const text = await resp.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: resp.status, data }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const p = url.pathname

  // ═══════════════════════════════════════════════════════════════════════════════
  // Auth endpoints (public)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/auth/login' && req.method === 'POST') {
    const bodyData = await body(req)
    if (verifyPassword(bodyData.password || '')) {
      const token = generateToken()
      activeTokens.add(token)
      json(res, { ok: true, token })
    } else {
      json(res, { ok: false, error: '密码错误' }, 401)
    }
    return
  }

  if (p === '/api/auth/verify' && req.method === 'GET') {
    if (isAuthenticated(req)) json(res, { ok: true })
    else json(res, { ok: false }, 401)
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Auth gate — protect all /api/* except auth + status + version
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p.startsWith('/api/') && !p.startsWith('/api/auth/') && p !== '/api/status' && p !== '/api/version') {
    if (!isAuthenticated(req)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Status & version
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/status') {
    let onebot = { online: false }
    try {
      const r = await fetch(`http://127.0.0.1:${ONEBOT_PORT}/api/get_status`)
      onebot = await r.json()
    } catch {}
    let weflow = { running: false, port: FLOW_PORT }
    try {
      const r = await fetch(`http://127.0.0.1:${FLOW_PORT}/api/status`)
      weflow = { running: true, ...(await r.json()) }
    } catch {}
    const cfg = loadWebuiConfig()
    json(res, { ok: true, onebot, weflow, config: cfg })
    return
  }

  if (p === '/api/version') {
    json(res, {
      app: 'FlowBOT', version: '4.6.1', protocol: 'v11.0',
      onebot_port: Number(ONEBOT_PORT), webui_port: Number(PORT), flow_port: Number(FLOW_PORT)
    })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // WeFlow config (electron-store) — dynamic discovery
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/weflow-config/path' && req.method === 'GET') {
    try {
      const configPath = discoverWeFlowConfigPath()
      const exists = fs.existsSync(configPath)
      json(res, { ok: true, path: configPath, exists })
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500)
    }
    return
  }

  if (p === '/api/weflow-config' && req.method === 'GET') {
    try {
      const cfg = loadWeFlowConfig()
      const configPath = cfg._path
      delete cfg._path
      json(res, { ok: true, config: cfg, path: configPath })
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500)
    }
    return
  }

  if (p === '/api/weflow-config' && req.method === 'POST') {
    try {
      const patch = await body(req)
      const merged = saveWeFlowConfig(patch)
      json(res, { ok: true, config: merged })
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500)
    }
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Disclaimer / first-launch
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/disclaimer' && req.method === 'GET') {
    json(res, { ok: true, disclaimerAccepted: isDisclaimerAccepted() })
    return
  }

  if (p === '/api/disclaimer' && req.method === 'POST') {
    acceptDisclaimer()
    try { saveWeFlowConfig({ onboardingDone: true }) } catch {}
    json(res, { ok: true, disclaimerAccepted: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HTTP API proxy — forwards to WeFlow's built-in HTTP API
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/weflow/send' && req.method === 'POST') {
    try {
      const token = readApiToken()
      const payload = await body(req)
      const result = await proxyRequest(`http://127.0.0.1:${FLOW_PORT}/api/v1/messages/send`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: payload
      })
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  if (p === '/api/weflow/sessions' && req.method === 'GET') {
    try {
      const token = readApiToken()
      const result = await proxyRequest(`http://127.0.0.1:${FLOW_PORT}/api/v1/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  if (p === '/api/weflow/health' && req.method === 'GET') {
    try {
      const result = await proxyRequest(`http://127.0.0.1:${FLOW_PORT}/health`)
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  // 代理 /api/v1/* 请求到 WeFlow HTTP API（除了日志，由本地处理）
  if (p.startsWith('/api/v1/') && !p.startsWith('/api/v1/mgmt/logs')) {
    try {
      const token = readApiToken()
      const targetUrl = `http://127.0.0.1:${FLOW_PORT}${p}`
      const fetchOpts = { method: req.method, headers: {} }
      if (token) fetchOpts.headers['Authorization'] = `Bearer ${token}`
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        fetchOpts.body = await body(req)
      }
      const result = await proxyRequest(targetUrl, fetchOpts)
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // /api/v1/mgmt/logs — handled locally (reads from container.log)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/v1/mgmt/logs' && req.method === 'GET') {
    var maxLines = Math.min(Number(url.searchParams.get('lines')) || 300, 2000)
    var categoriesParam = url.searchParams.get('categories') || ''
    var levelsParam = url.searchParams.get('levels') || ''
    var searchParam = (url.searchParams.get('search') || '').toLowerCase()

    var activeCategories = categoriesParam
      ? categoriesParam.split(',').map(function (s) { return s.trim().toLowerCase() }).filter(Boolean)
      : []
    var activeLevels = levelsParam
      ? levelsParam.split(',').map(function (s) { return s.trim().toLowerCase() }).filter(Boolean)
      : []

    var parsed = parseContainerLog(maxLines, activeCategories, activeLevels, searchParam)
    json(res, { success: true, logs: parsed, count: parsed.length })
    return
  }

  if (p === '/api/v1/mgmt/logs/stats' && req.method === 'GET') {
    var fileSize = 0
    var lineCount = 0
    try {
      if (fs.existsSync(CONTAINER_LOG)) {
        fileSize = fs.statSync(CONTAINER_LOG).size
        var statContent = fs.readFileSync(CONTAINER_LOG, 'utf-8')
        lineCount = statContent.split('\n').filter(Boolean).length
      }
    } catch {}
    json(res, { success: true, file: CONTAINER_LOG, size: fileSize, lines: lineCount })
    return
  }

  if (p === '/api/v1/mgmt/logs/clear' && req.method === 'POST') {
    try { if (fs.existsSync(CONTAINER_LOG)) fs.writeFileSync(CONTAINER_LOG, '') } catch {}
    json(res, { success: true, cleared: 'container.log' })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // WebUI config CRUD
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/config' && req.method === 'GET') {
    json(res, { ok: true, config: loadWebuiConfig() })
    return
  }
  if (p === '/api/config' && req.method === 'POST') {
    const d = await body(req)
    const current = loadWebuiConfig()
    saveWebuiConfig({ ...current, ...d })
    json(res, { ok: true })
    return
  }
  if (p === '/api/config/reset' && req.method === 'POST') {
    saveWebuiConfig({})
    json(res, { ok: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // OneBot config
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/onebot/config' && req.method === 'GET') {
    const cfg = loadWebuiConfig()
    json(res, { ok: true, config: cfg.oneBot || {} })
    return
  }
  if (p === '/api/onebot/config' && req.method === 'POST') {
    const d = await body(req)
    const current = loadWebuiConfig()
    current.oneBot = { ...(current.oneBot || {}), ...d }
    saveWebuiConfig(current)
    json(res, { ok: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Message filter config
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/filter/config' && req.method === 'GET') {
    const cfg = loadWebuiConfig()
    json(res, { ok: true, config: cfg.messageFilter || { mode: 'all', list: [] } })
    return
  }
  if (p === '/api/filter/config' && req.method === 'POST') {
    const d = await body(req)
    const current = loadWebuiConfig()
    current.messageFilter = { ...(current.messageFilter || {}), ...d }
    saveWebuiConfig(current)
    json(res, { ok: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Accounts
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/accounts' && req.method === 'GET') {
    const cfg = loadWebuiConfig()
    json(res, { ok: true, accounts: cfg.accounts || [], currentWxid: cfg.currentWxid || '' })
    return
  }
  if (p === '/api/accounts' && req.method === 'POST') {
    const d = await body(req)
    const current = loadWebuiConfig()
    if (d.action === 'setCurrent') {
      current.currentWxid = d.wxid
    } else if (d.action === 'add') {
      current.accounts = [...(current.accounts || []), { wxid: d.wxid, name: d.name || d.wxid, addedAt: Date.now() }]
    } else if (d.action === 'remove') {
      current.accounts = (current.accounts || []).filter(a => a.wxid !== d.wxid)
    }
    saveWebuiConfig(current)
    json(res, { ok: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Database
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/database' && req.method === 'GET') {
    const cfg = loadWebuiConfig()
    json(res, {
      ok: true,
      config: {
        dbPath: cfg.dbPath || '',
        currentWxid: cfg.currentWxid || '',
        onboardingDone: cfg.onboardingDone || false,
        hasKey: Boolean(cfg.decryptKey),
        hasImageKey: Boolean(cfg.imageAesKey)
      }
    })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // System info
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/system') {
    const uptime = shell('uptime -p').replace('up ', '')
    const mem = shell("free -m | awk '/^Mem:/{print $3, $2}'")
    const memParts = mem.split(' ')
    const memUsed = parseInt(memParts[0]) || 0
    const memTotal = parseInt(memParts[1]) || 1
    const memPercent = Math.round((memUsed / memTotal) * 100)
    const disk = shell("df -m / | awk 'NR==2{print $3, $2, $5}'")
    const diskParts = disk.split(' ')
    const diskUsed = parseInt(diskParts[0]) || 0
    const diskTotal = parseInt(diskParts[1]) || 1
    const diskPercent = Math.round((diskUsed / diskTotal) * 100)
    const cpuLoad = shell("cat /proc/loadavg | awk '{print $1}'")
    const cpuCores = shell("nproc")
    const cpuModel = shell("cat /proc/cpuinfo | grep 'model name' | head -1 | sed 's/model name.*: //'")
    const nodeVer = shell('node --version')
    const appVersion = process.env.APP_VERSION || '4.6.1'
    const wechatVersion = shell("/opt/wechat/wechat --version 2>/dev/null || dpkg -l wechat 2>/dev/null | awk '/^ii/{print $3}' || echo '4.1.1.7'").split('\n')[0].trim() || '4.1.1.7'
    const containerStart = shell("stat -c %Y /proc/1 2>/dev/null || echo '0'")
    const now = Math.floor(Date.now() / 1000)
    const containerStartTime = parseInt(containerStart) || (now - 1)
    const containerUptimeSec = Math.max(now - containerStartTime, 1)
    const days = Math.floor(containerUptimeSec / 86400)
    const hours = Math.floor((containerUptimeSec % 86400) / 3600)
    const mins = Math.floor((containerUptimeSec % 3600) / 60)
    var containerUptime = ''
    if (days > 0) containerUptime += days + '天'
    if (hours > 0) containerUptime += hours + 'h'
    containerUptime += mins + 'm'
    json(res, {
      ok: true,
      system: {
        uptime,
        containerUptime,
        memory: { used: memUsed, total: memTotal, usedPercent: memPercent },
        disk: { used: diskUsed, total: diskTotal, usedPercent: diskPercent },
        cpuLoad: parseFloat(cpuLoad) || 0,
        cpuCores: parseInt(cpuCores) || 1,
        cpuModel,
        node: nodeVer,
        version: appVersion,
        wechatVersion
      }
    })
    return
  }

  if ((p === '/api/restart/weflow' || p === '/api/restart/wechat') && req.method === 'POST') {
    const target = p.includes('wechat') ? 'wechat' : 'weflow'
    console.log(`[WebUI] 收到重启请求: ${target}`)
    setTimeout(() => {
      try {
        if (target === 'wechat') {
          console.log('[WebUI] 正在关闭微信...')
          shell('pkill -9 -f /opt/wechat/wechat 2>/dev/null; sleep 1')
          console.log('[WebUI] 微信已关闭，等待5秒后重启...')
          setTimeout(() => {
            shell('DISPLAY=:99 dbus-launch /opt/wechat/wechat > /tmp/wechat-restart.log 2>&1 &')
            console.log('[WebUI] 微信重启命令已执行')
          }, 5000)
        } else {
          console.log('[WebUI] 正在关闭 WeFlow...')
          shell('pkill -9 -f "weflow --no-s" 2>/dev/null; pkill -9 -f "weflow --no-sandbox" 2>/dev/null; sleep 1')
          console.log('[WebUI] WeFlow 已关闭，等待5秒后重启...')
          setTimeout(() => {
            shell('cd /opt/weflow && DISPLAY=:99 dbus-launch ./weflow --no-sandbox --disable-gpu > /tmp/weflow-restart.log 2>&1 &')
            console.log('[WebUI] WeFlow 重启命令已执行')
          }, 5000)
        }
      } catch (e) {
        console.error('[WebUI] 重启失败:', e.message || e)
      }
    }, 1000)
    json(res, { ok: true, message: '正在重启，请等待重新启动' })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Processes
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/processes') {
    const procs = shell("ps aux --no-headers | grep -E 'weflow|wechat|Xvfb|x11vnc|websockify|node.*server' | grep -v grep | awk '{print $2, $11, $12}'")
    const list = procs.split('\n').filter(Boolean).map(l => {
      const [pid, ...rest] = l.split(' ')
      return { pid, cmd: rest.join(' ') }
    })
    json(res, { ok: true, processes: list })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Static files (SPA fallback)
  // ═══════════════════════════════════════════════════════════════════════════════

  let fp = p === '/' ? '/index.html' : p
  file(res, path.join(__dirname, 'public', fp))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WebUI] FlowBOT management panel running on http://0.0.0.0:${PORT}`)
  console.log(`[WebUI] WeFlow config path: ${discoverWeFlowConfigPath()}`)
  console.log(`[WebUI] Disclaimer accepted: ${isDisclaimerAccepted()}`)
})
