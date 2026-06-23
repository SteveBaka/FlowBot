const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PORT = process.env.WEBUI_PORT || 5099
const ONEBOT_PORT = process.env.ONEBOT_PORT || 3001
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' })
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

// ─── Logs ──────────────────────────────────────────────────────────────────────

const LOG_SOURCES = {
  weflow: [
    '/tmp/weflow.log',
    '/var/log/weflow.log',
    '/opt/weflow/logs/weflow.log'
  ],
  wechat: [
    '/tmp/wechat.log',
    '/var/log/wechat.log',
    '/opt/weflow/logs/wechat.log'
  ],
  vnc: [
    '/tmp/x11vnc.log',
    '/var/log/x11vnc.log',
    '/opt/weflow/logs/vnc.log'
  ],
  system: [
    '/var/log/syslog',
    '/var/log/messages',
    '/var/log/supervisord.log'
  ],
  sender: [
    '/tmp/linuxsender.log',
    '/var/log/linuxsender.log',
    '/opt/weflow/logs/sender.log'
  ]
}

function readLogFiles(maxLines, activeCategories) {
  const lines = []
  for (const [category, paths] of Object.entries(LOG_SOURCES)) {
    if (activeCategories && !activeCategories.has(category)) continue
    for (const lp of paths) {
      try {
        if (fs.existsSync(lp)) {
          const content = fs.readFileSync(lp, 'utf-8')
          for (const line of content.split('\n').filter(Boolean)) {
            lines.push({ text: line, category })
          }
        }
      } catch {}
    }
  }
  return lines
}

function tryJournalctl(category) {
  const unitMap = {
    wechat: 'wechat',
    weflow: 'weflow',
    vnc: 'x11vnc',
    system: null,
    sender: 'linuxsender'
  }
  const unit = unitMap[category]
  if (!unit) return []
  try {
    const raw = execSync(`journalctl -u ${unit} --no-pager -n 200 2>/dev/null`, { timeout: 3000, encoding: 'utf-8' })
    return raw.split('\n').filter(Boolean).map(text => ({ text, category }))
  } catch {}
  return []
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const p = url.pathname

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
      app: 'WeFlow', version: '4.6.1', protocol: 'v11.0',
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

  // 代理所有 /api/v1/* 请求到 WeFlow HTTP API（包括 /api/v1/mgmt/*）
  if (p.startsWith('/api/v1/')) {
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
    const uptime = shell('uptime -p')
    const mem = shell("free -h | awk '/^Mem:/{print $3\"/\"$2}'")
    const disk = shell("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'")
    const nodeVer = shell('node --version')
    const appVersion = process.env.APP_VERSION || '4.6.1'
    json(res, { ok: true, system: { uptime, memory: mem, disk, node: nodeVer, version: appVersion } })
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
  // Logs  — supports categories, level, search, lines query params
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/logs' && req.method === 'GET') {
    const maxLines = Math.min(Number(url.searchParams.get('lines')) || 500, 2000)
    const categoriesParam = url.searchParams.get('categories') || ''
    const levelParam = (url.searchParams.get('level') || 'all').toLowerCase()
    const searchParam = (url.searchParams.get('search') || '').toLowerCase()

    const activeCategories = categoriesParam
      ? new Set(categoriesParam.split(',').map(s => s.trim()).filter(Boolean))
      : new Set(Object.keys(LOG_SOURCES))

    let allLines = readLogFiles(maxLines, activeCategories)

    if (allLines.length === 0) {
      for (const cat of activeCategories) {
        allLines.push(...tryJournalctl(cat))
      }
    }

    if (searchParam) {
      allLines = allLines.filter(l => l.text.toLowerCase().includes(searchParam))
    }

    if (levelParam !== 'all') {
      allLines = allLines.filter(l => {
        const t = l.text.toLowerCase()
        if (levelParam === 'error') return t.includes('error') || t.includes('fatal') || t.includes('panic') || t.includes('fail')
        if (levelParam === 'warning') return t.includes('warn') || t.includes('warning')
        if (levelParam === 'info') return true
        return true
      })
    }

    allLines = allLines.slice(-maxLines)

    json(res, { ok: true, logs: allLines.map(l => l.text), count: allLines.length })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Clear logs
  // ═══════════════════════════════════════════════════════════════════════════════

  if (p === '/api/logs/clear' && req.method === 'POST') {
    for (const [, paths] of Object.entries(LOG_SOURCES)) {
      for (const lp of paths) {
        try {
          if (fs.existsSync(lp)) fs.writeFileSync(lp, '')
        } catch {}
      }
    }
    json(res, { ok: true })
    return
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Static files (SPA fallback)
  // ═══════════════════════════════════════════════════════════════════════════════

  let fp = p === '/' ? '/index.html' : p
  file(res, path.join(__dirname, 'public', fp))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WebUI] Management panel running on http://0.0.0.0:${PORT}`)
  console.log(`[WebUI] WeFlow config path: ${discoverWeFlowConfigPath()}`)
  console.log(`[WebUI] Disclaimer accepted: ${isDisclaimerAccepted()}`)
})
