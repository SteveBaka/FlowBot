const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync, spawn } = require('child_process')
const { Readable } = require('stream')

const PORT = process.env.WEBUI_PORT || 7300
// 本进程启动时间戳：用于引导期/重放过滤（重启后摒弃先前未发送的旧消息）
const serverStartTime = Date.now()
const ONEBOT_PORT = process.env.ONEBOT_PORT || 7100
const FLOW_PORT = process.env.FLOW_API_PORT || 5031
const CONFIG_DIR = process.env.WEFLOW_CONFIG_DIR || '/opt/weflow/data'

const CONTAINER_VERSION = (() => {
  try {
    return fs.readFileSync('/opt/weflow/VERSION', 'utf8').trim()
  } catch {
    return '0.0.0'
  }
})()
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

function body(req, limit) {
  return new Promise(resolve => {
    let data = ''
    let size = 0
    const MAX = limit || 20 * 1024 * 1024
    req.on('data', chunk => {
      if (size > MAX) { return }
      size += chunk.length
      if (size > MAX) {
        req.__bodyTooLarge = true
        req.resume()
        resolve({})
        return
      }
      data += chunk
    })
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function isBodyTooLarge(req, limit) {
  const cl = Number(req.headers['content-length'] || 0)
  return cl > (limit || 20 * 1024 * 1024)
}

function shell(cmd) {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim() } catch { return '' }
}

// 后台拉起进程并继承本进程的 stdout/stderr（即 start.sh 的 tee 管道），
// 保证重启后的输出继续进入 docker logs 与 container.log，不再重定向到 /tmp。
function spawnDetached(cmd) {
  try {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
    child.unref()
    return true
  } catch (e) {
    console.error('[WebUI] spawn 失败:', (e && e.message) || e)
    return false
  }
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

// ─── 通用 API Key 鉴权（插件 API 服务端使用，独立于 WebUI 登录）────────────────

function isAuthorized(req, token) {
  if (!token) return false
  const header = req.headers.authorization || ''
  const authToken = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (authToken && authToken === token) return true
  let u
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')) } catch { return false }
  const queryToken = u.searchParams.get('access_token') || u.searchParams.get('token') || ''
  return queryToken && queryToken === token
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

const TOKEN_FILE = path.join(CONFIG_DIR, 'http-api-token.txt')

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

// 插件通道 API Key：未配置时自动生成并落盘，保证 WS/HTTP 插件链路可用
function ensureApiToken() {
  const existing = readApiToken()
  if (existing) return existing
  const token = crypto.randomBytes(24).toString('hex')
  try {
    ensureDirSync('/opt/weflow/data')
    fs.writeFileSync(TOKEN_FILE, token)
    console.log('[WebUI] Generated new API token: ' + token)
  } catch (err) {
    console.error('[WebUI] Failed to write API token:', err.message)
  }
  return token
}

// ─── 图片 token 自建注册表（插件通道图片直链）────────────────────────────────

const imageTokens = new Map() // token -> { path, expires }

// 推送媒体直链基地址：优先读 WebUI 设置（WeFlow config mediaServerBaseUrl，原 imageServerBaseUrl，
// 设置页"媒体传输模式 → 对外可达地址"，图片/语音/视频直链共用），兼容读旧键；其次 env
// PUSH_IMAGE_BASE_URL，最后默认 127.0.0.1:7400
function getPushImageBaseUrl() {
  try {
    const cfg = loadWeFlowConfig()
    const url = String(cfg.mediaServerBaseUrl || cfg.imageServerBaseUrl || '').trim()
    if (url) return url.replace(/\/+$/, '')
  } catch {}
  return (process.env.PUSH_IMAGE_BASE_URL || '').replace(/\/+$/, '') || 'http://127.0.0.1:7400'
}

function registerImagePath(filePath, ttlMs) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const token = randMediaToken()
  imageTokens.set(token, { path: filePath, expires: Date.now() + (ttlMs || 120000) })
  return token
}

function mimeByExt(fp) {
  const ext = path.extname(fp).toLowerCase()
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.wav': 'audio/wav', '.silk': 'audio/silk', '.amr': 'audio/amr' }
  return map[ext] || 'application/octet-stream'
}

// 视频文件自建 token（插件 API 通道视频直链）：与 imageTokens 同构，TTL 1h 对齐
// OneBot 侧 /api/media；文件与本进程同容器，直接读盘服务，无需回源 5031
const mediaTokens = new Map() // token -> { path, expires }
const MEDIA_TOKEN_TTL_MS = 60 * 60 * 1000

function randMediaToken() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let token = ''
  do {
    token = ''
    for (let i = 0; i < 16; i++) token += chars[Math.floor(Math.random() * 36)]
  } while (imageTokens.has(token) || mediaTokens.has(token))
  return token
}

function registerMediaPath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const token = randMediaToken()
  mediaTokens.set(token, { path: filePath, expires: Date.now() + MEDIA_TOKEN_TTL_MS })
  return token
}

/** 带 Range/HEAD 的文件服务（/api/media 自建 token 路径）：
 * 单段 bytes=N-M / -N 后缀；非法/越界回 416；HEAD 只回头 */
function serveFileWithRange(req, res, filePath, contentType) {
  let stat
  try { stat = fs.statSync(filePath) } catch { json(res, { ok: false, error: 'Media file missing' }, 404); return }
  const base = { 'Content-Type': contentType, 'Cache-Control': 'no-cache, max-age=0', 'Accept-Ranges': 'bytes' }
  const m = req.headers && req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim()) : null
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : (m[2] ? Math.max(0, stat.size - parseInt(m[2], 10)) : 0)
    let end = (m[1] && m[2]) ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1
    if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
      res.end()
      return
    }
    res.writeHead(206, Object.assign({}, base, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Content-Length': end - start + 1 }))
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(filePath, { start: start, end: end }).pipe(res)
    return
  }
  res.writeHead(200, Object.assign({}, base, { 'Content-Length': stat.size }))
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(filePath).pipe(res)
}

// /api/media 统一入口（7300 主服务与 7400 插件 API 共用）：
// 自建 token 直接读盘；未命中回源 5031（Range/HEAD 头透传，206/Content-Range 原样回传）
async function serveMediaToken(req, res, token) {
  if (!/^[a-z0-9]{16}$/.test(token || '')) {
    json(res, { ok: false, error: 'Invalid token format' }, 400)
    return
  }
  const localEntry = mediaTokens.get(token)
  if (localEntry && localEntry.expires > Date.now()) {
    serveFileWithRange(req, res, localEntry.path, mimeByExt(localEntry.path))
    return
  }
  try {
    const headers = {}
    if (req.headers && req.headers.range) headers['Range'] = req.headers.range
    const resp = await fetch('http://127.0.0.1:' + FLOW_PORT + '/api/media?token=' + token, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: headers })
    if (!resp.ok || (req.method !== 'HEAD' && !resp.body)) {
      json(res, { ok: false, error: 'Media not found or expired' }, resp.status)
      return
    }
    const out = { 'Content-Type': resp.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-cache, max-age=0', 'Accept-Ranges': 'bytes' }
    for (const k of ['content-length', 'content-range']) {
      const v = resp.headers.get(k)
      if (v) out[k] = v
    }
    res.writeHead(resp.status, out)
    if (req.method === 'HEAD') { res.end(); return }
    Readable.fromWeb(resp.body).pipe(res)
  } catch (err) {
    json(res, { ok: false, error: 'Media service unavailable' }, 502)
  }
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

  if (p === '/api/image' && req.method === 'GET') {
    var token = url.searchParams.get('token') || ''
    if (!/^[a-z0-9]{16}$/.test(token)) {
      json(res, { ok: false, error: 'Invalid token format' }, 400)
      return
    }
    // 优先服务插件通道自建 token（与 7400 统一，保证 7300/7400 双端口均可取图）
    var localEntry = imageTokens.get(token)
    if (localEntry && localEntry.expires > Date.now()) {
      try {
        var localStat = fs.statSync(localEntry.path)
        res.writeHead(200, {
          'Content-Type': mimeByExt(localEntry.path),
          'Content-Length': localStat.size,
          'Cache-Control': 'no-cache, max-age=0'
        })
        fs.createReadStream(localEntry.path).pipe(res)
      } catch (err) {
        json(res, { ok: false, error: 'Image not found or expired' }, 404)
      }
      return
    }
    // 未命中本地 token → 代理 WeFlow（OneBot / WebUI 图片直链）
    try {
      var targetUrl = 'http://127.0.0.1:' + FLOW_PORT + '/api/image?token=' + token
      var resp = await fetch(targetUrl)
      if (!resp.ok) {
        json(res, { ok: false, error: 'Image not found or expired' }, resp.status)
        return
      }
      var contentType = resp.headers.get('content-type') || 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, max-age=0'
      })
      var buf = Buffer.from(await resp.arrayBuffer())
      res.end(buf)
    } catch (err) {
      json(res, { ok: false, error: 'Image service unavailable' }, 502)
    }
    return
  }

  // 入站视频 token（INBOUND-VIDEO-PUSH-PLAN §2.3）：自建 token 直接读盘（带 Range/HEAD），
  // 否则回源 5031 流式转发（serveMediaToken，7300/7400 共用）
  if (p === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveMediaToken(req, res, url.searchParams.get('token'))
    return
  }

  if (p.startsWith('/api/') && !p.startsWith('/api/auth/') && p !== '/api/status' && p !== '/api/version' && p !== '/api/image' && p !== '/api/media') {
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
      app: 'FlowBOT', version: CONTAINER_VERSION, protocol: 'v11.0',
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
      // 群聊名称以身份库（WCDB Contact 权威源）为准，覆盖 WeFlow 会话缓存（avatarCache）的陈旧群名
      if (result.data && Array.isArray(result.data.sessions)) {
        for (const s of result.data.sessions) {
          if (s && s.username && (s.sessionType === 'group' || String(s.username).endsWith('@chatroom'))) {
            const g = identityMemory.get(String(s.username))
            if (g && g.display_name && g.display_name !== s.displayName) {
              s.displayName = g.display_name
            }
          }
        }
      }
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  // 消息推送过滤配置 — 直接读写 WeFlow config 中的过滤键
  // GET: 返回 messagePushEnabled / messagePushFilterMode / messagePushFilterList
  // POST: 仅合并这三个键（非破坏性），其余 WeFlow 配置不变
  if (p === '/api/weflow/filter' && req.method === 'GET') {
    try {
      const cfg = loadWeFlowConfig()
      json(res, {
        ok: true,
        filter: {
          pushEnabled: cfg.messagePushEnabled !== false,
          mode: cfg.messagePushFilterMode || 'all',
          list: Array.isArray(cfg.messagePushFilterList) ? cfg.messagePushFilterList : []
        }
      })
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500)
    }
    return
  }

  if (p === '/api/weflow/filter' && req.method === 'POST') {
    try {
      const d = await body(req)
      const patch = {}
      if (d && typeof d.pushEnabled === 'boolean') patch.messagePushEnabled = d.pushEnabled
      if (d && typeof d.mode === 'string' && ['all', 'whitelist', 'blacklist'].indexOf(d.mode) !== -1) {
        patch.messagePushFilterMode = d.mode
      }
      if (d && Array.isArray(d.list)) {
        patch.messagePushFilterList = d.list
          .map(function (s) { return String(s || '').trim() })
          .filter(Boolean)
      }
      if (Object.keys(patch).length === 0) {
        json(res, { ok: false, error: 'no valid fields' }, 400)
        return
      }
      // 通过 WeFlow HTTP API 写入（store.set），保证运行中的 WeFlow 内存立即生效，
      // 而不是只改磁盘文件（electron-store 不监听外部文件变化）
      const token = readApiToken()
      const result = await proxyRequest(`http://127.0.0.1:${FLOW_PORT}/api/v1/mgmt/config`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: patch
      })
      if (result.status >= 200 && result.status < 300 && result.data && result.data.success !== false) {
        json(res, { ok: true, updated: result.data.updated || Object.keys(patch) })
      } else {
        json(res, { ok: false, error: (result.data && result.data.error) || ('HTTP ' + result.status) }, result.status)
      }
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
  if (p === '/api/v1/mgmt/bots/status' && req.method === 'GET') {
    // 合并插件 API bot 的实时对端状态（server.js 管理，botManager 不感知）
    try {
      const internalToken = readApiToken()
      const result = await proxyRequest('http://127.0.0.1:' + FLOW_PORT + p, {
        headers: internalToken ? { Authorization: 'Bearer ' + internalToken } : {}
      })
      if (result.data && Array.isArray(result.data.bots)) {
        const pstatus = getPluginApiStatus()
        for (const bot of result.data.bots) {
          if (bot.mode === 'plugin') {
            const st = pstatus.find(function (x) { return x.port === Number(bot.port) })
            if (st) {
              bot.status = 'running'
              bot.connectionStatus = st.clientCount > 0 ? 'connected' : 'disconnected'
              bot.clientCount = st.clientCount
              bot.lastHttpAt = st.lastHttpAt
              bot.lastWsAt = st.lastWsAt
              bot.error = undefined
            } else {
              bot.status = 'stopped'
              bot.connectionStatus = 'disconnected'
              bot.clientCount = 0
            }
          }
        }
      }
      json(res, result.data, result.status)
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 502)
    }
    return
  }

  if (p.startsWith('/api/v1/') && !p.startsWith('/api/v1/mgmt/logs')) {
    try {
      // 媒体上传放开 body 上限（140MB：100MB 视频 base64 膨胀 1.333 + JSON 开销），其余 POST 仍 20MB
      const isMediaUpload = p === '/api/v1/media/upload'
      const uploadLimit = 140 * 1024 * 1024
      if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && isBodyTooLarge(req, isMediaUpload ? uploadLimit : undefined)) {
        json(res, { ok: false, error: isMediaUpload ? '请求体过大（>140MB，媒体上传上限）' : '请求体过大（>20MB）' }, 413)
        return
      }
      const token = readApiToken()
      const targetUrl = `http://127.0.0.1:${FLOW_PORT}${p}`
      const fetchOpts = { method: req.method, headers: {} }
      if (token) fetchOpts.headers['Authorization'] = `Bearer ${token}`
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        fetchOpts.body = await body(req, isMediaUpload ? uploadLimit : undefined)
      }
      const result = await proxyRequest(targetUrl, fetchOpts)
      json(res, result.data, result.status)
      // bot 配置变更后，防抖刷新插件 API 服务端（mode=plugin 的 bot）
      if (req.method === 'POST' && (p === '/api/v1/mgmt/config' || p === '/api/v1/mgmt/bots/start')) {
        schedulePluginApiRefresh(600)
      }
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
    const appVersion = process.env.APP_VERSION || CONTAINER_VERSION
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
    var weflowVersion = '-'
    try {
      const wf = await proxyRequest(`http://127.0.0.1:${FLOW_PORT}/api/v1/app-version`)
      if (wf.data && wf.data.version) weflowVersion = wf.data.version
    } catch { }
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
        wechatVersion,
        weflowVersion
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
          console.log('[WebUI] 正在关闭微信（SIGTERM）...')
          const wechatPid = shell("pgrep -f '^/opt/wechat/wechat$' | head -1")
          if (wechatPid) shell('kill -TERM ' + wechatPid)
          setTimeout(() => {
            // 同一 PID 补刀，避免误杀守护循环已拉起的新实例（微信无守护循环，此处直接重启）
            if (wechatPid) shell('kill -KILL ' + wechatPid + ' 2>/dev/null; true')
            console.log('[WebUI] 微信已关闭，2 秒后重新启动...')
            setTimeout(() => {
              spawnDetached('cd /opt && DISPLAY=:99 LD_LIBRARY_PATH="/opt/wechat:$LD_LIBRARY_PATH" dbus-launch /opt/wechat/wechat')
              console.log('[WebUI] 微信重启命令已执行（输出继续进入 docker logs）')
            }, 2000)
          }, 5000)
        } else {
          // WeFlow 由 start.sh 守护循环管理：这里只做优雅退出（先 TERM 后 KILL 同一 PID），
          // 循环 3 秒后自动拉起，输出全程留在原管道。
          console.log('[WebUI] 正在关闭 WeFlow（SIGTERM，守护循环将自动拉起）...')
          const weflowPid = shell("pgrep -f '^\\./weflow --no-sandbox' | head -1")
          if (weflowPid) shell('kill -TERM ' + weflowPid)
          setTimeout(() => {
            if (weflowPid) shell('kill -KILL ' + weflowPid + ' 2>/dev/null; true')
            console.log('[WebUI] WeFlow 已关闭，start.sh 守护循环将自动拉起（日志不断流）')
          }, 6000)
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

// ─── WebSocket 基础（RFC6455 手写实现，容器无 ws 依赖）────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// 入站消息重放缓冲区（断线重连补偿，插件侧按 message_id 去重）
const pushReplayBuffer = []
const PUSH_REPLAY_LIMIT = 100

function wsFrame(opcode, payload) {
  const buf = Buffer.from(payload)
  const len = buf.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, buf])
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

function wsSend(socket, clientSet, obj) {
  try { socket.write(wsFrame(0x1, JSON.stringify(obj))) } catch { clientSet.delete(socket) }
}

function consumeWsFrames(socket) {
  let buf = socket._wsBuf
  let offset = 0
  while (buf.length - offset >= 2) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let headerLen = 2
    if (len === 126) headerLen = 4
    else if (len === 127) headerLen = 10
    if (buf.length - offset < headerLen) break
    if (len === 126) len = buf.readUInt16BE(offset + 2)
    else if (len === 127) len = Number(buf.readBigUInt64BE(offset + 2))
    if (len < 0 || len > 64 * 1024 * 1024) { socket.destroy(); return }
    const maskLen = masked ? 4 : 0
    if (buf.length - offset < headerLen + maskLen + len) break
    const maskKey = masked ? buf.slice(offset + headerLen, offset + headerLen + 4) : null
    const payload = Buffer.alloc(len)
    for (let i = 0; i < len; i++) {
      payload[i] = buf[offset + headerLen + maskLen + i] ^ (masked ? maskKey[i % 4] : 0)
    }
    offset += headerLen + maskLen + len

    if (opcode === 0x9) { // ping → pong
      try { socket.write(wsFrame(0xA, payload)) } catch {}
    } else if (opcode === 0x8) { // close
      try { socket.write(wsFrame(0x8, payload)) } catch {}
      socket.end()
      return
    } else if (opcode === 0x1 || opcode === 0x0) { // text / continuation
      const text = payload.toString('utf8')
      if (opcode === 0x1) socket._wsFrag = text
      else socket._wsFrag = (socket._wsFrag || '') + text
      if (fin) {
        try {
          const msg = JSON.parse(socket._wsFrag || '{}')
          if (msg && msg.event === 'pong') { /* keepalive */ }
        } catch {}
        socket._wsFrag = null
      }
    }
  }
  socket._wsBuf = buf.slice(offset)
}

function handleWsSocket(socket, clientSet, onConnect) {
  socket._wsBuf = Buffer.alloc(0)
  socket._wsFrag = null
  socket.on('data', (chunk) => {
    socket._wsBuf = Buffer.concat([socket._wsBuf, chunk])
    consumeWsFrames(socket)
  })
  socket.on('close', () => clientSet.delete(socket))
  socket.on('error', () => clientSet.delete(socket))
  clientSet.add(socket)
  if (onConnect) onConnect(socket)
  // 重放：仅补发 60 秒内的消息（短断线续传）；重启/长断线后旧消息不再重放，避免重复回复
  const replayCutoff = Date.now() - 60000
  for (const event of pushReplayBuffer) {
    if (event.at && event.at < replayCutoff) continue
    try { socket.write(wsFrame(0x1, event.body)) } catch { break }
  }
  wsSend(socket, clientSet, { event: 'connected', data: { message: 'WeFlow push connected', timestamp: Date.now() } })
}

// ─── 插件 API 服务端（独立端口，作为可开关的 bot 管理）────────────────────────

const pluginApiServers = new Map() // port -> { server, wssClients, token }

function servePluginImage(req, res, token) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  const tk = u.searchParams.get('token') || ''
  if (!/^[a-z0-9]{16}$/.test(tk)) {
    json(res, { ok: false, error: 'Invalid token format' }, 400)
    return
  }
  const localEntry = imageTokens.get(tk)
  if (localEntry && localEntry.expires > Date.now()) {
    try {
      const st = fs.statSync(localEntry.path)
      res.writeHead(200, {
        'Content-Type': mimeByExt(localEntry.path),
        'Content-Length': st.size,
        'Cache-Control': 'no-cache, max-age=0'
      })
      fs.createReadStream(localEntry.path).pipe(res)
    } catch (err) {
      json(res, { ok: false, error: 'Image not found or expired' }, 404)
    }
    return
  }
  fetch('http://127.0.0.1:' + FLOW_PORT + '/api/image?token=' + tk)
    .then(async (resp) => {
      if (!resp.ok) { json(res, { ok: false, error: 'Image not found or expired' }, resp.status); return }
      const ct = resp.headers.get('content-type') || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache, max-age=0' })
      res.end(Buffer.from(await resp.arrayBuffer()))
    })
    .catch(() => json(res, { ok: false, error: 'Image service unavailable' }, 502))
}

function startPluginApiServer(port, token) {
  if (pluginApiServers.has(port)) return false
  const wssClients = new Set()

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
    const p = u.pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (p === '/api/image' && req.method === 'GET') {
      servePluginImage(req, res, token)
      return
    }

    // 视频直链（ADAPTER-MEDIA-CONTRACT §2.1）：与 /api/image 同构免鉴权，
    // 自建 token 读盘 + Range/HEAD，未命中回源 5031
    if (p === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveMediaToken(req, res, u.searchParams.get('token'))
      return
    }

    // API Key 鉴权（该 bot 的 token，即 AstrBot 适配器所用）
    if (p.startsWith('/api/') && !isAuthorized(req, token)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }

    // 记录对端（适配器）最近 HTTP 活动
    const entry = pluginApiServers.get(port)
    if (entry) entry.lastHttpAt = Date.now()

    // 插件 API 代理（排除 mgmt，最小权限）
    if (p.startsWith('/api/v1/') && !p.startsWith('/api/v1/mgmt/')) {
      try {
        // 媒体上传放开 body 上限（140MB：100MB 视频 base64 膨胀 1.333 + JSON 开销），其余 POST 仍 20MB
        const isMediaUpload = p === '/api/v1/media/upload'
        const uploadLimit = 140 * 1024 * 1024
        if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && isBodyTooLarge(req, isMediaUpload ? uploadLimit : undefined)) {
          json(res, { ok: false, error: isMediaUpload ? '请求体过大（>140MB，媒体上传上限）' : '请求体过大（>20MB）' }, 413)
          return
        }
        const internalToken = readApiToken()
        // 会话消息类路径：将自定义 wxid 反查为真实 wxid 再转发（如 /api/v1/sessions/:id/messages）
        let targetPath = p
        const sm = p.match(/^\/api\/v1\/sessions\/([^/]+)\//)
        if (sm) {
          const real = getRealWxid(sm[1])
          if (real) targetPath = p.replace(sm[1], real)
        }
        const targetUrl = 'http://127.0.0.1:' + FLOW_PORT + targetPath + (u.search ? u.search : '')
        const fetchOpts = { method: req.method, headers: {} }
        if (internalToken) fetchOpts.headers['Authorization'] = 'Bearer ' + internalToken
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          fetchOpts.headers['Content-Type'] = 'application/json'
          fetchOpts.body = await body(req, isMediaUpload ? uploadLimit : undefined)
        }
        const result = await proxyRequest(targetUrl, fetchOpts)
         // 会话列表：私聊 username 改写为自定义 wxid；群聊名称/头像以身份库为准自动刷新
         if (p === '/api/v1/sessions' && req.method === 'GET' && result.data && Array.isArray(result.data.sessions)) {
           for (const s of result.data.sessions) {
             const iden = s && s.username ? identityMemory.get(String(s.username)) : undefined
             if (s && iden && iden.avatar_url && !s.avatarUrl) {
               s.avatarUrl = iden.avatar_url
             }
             if (s && s.sessionType !== 'group' && s.username) {
               const alias = getCustomWxid(String(s.username))
               if (alias) s.username = alias
             } else if (s && s.sessionType === 'group' && s.username) {
               const g = identityMemory.get(String(s.username))
               if (g && g.display_name && g.display_name !== s.displayName) {
                 s.displayName = g.display_name
               }
             }
           }
         }
        json(res, result.data, result.status)
      } catch (err) {
        json(res, { ok: false, error: String(err) }, 502)
      }
      return
    }

    json(res, { ok: false, error: 'Not Found' }, 404)
  })

  srv.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname === '/api/v1/ws/messages') {
      // 兼容三种传 token 方式：?token= / ?access_token= / Authorization: Bearer
      const queryToken = u.searchParams.get('token') || u.searchParams.get('access_token') || ''
      const authHeader = req.headers['authorization'] || ''
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
      const t = queryToken || bearerToken
      if (!t || t !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const key = req.headers['sec-websocket-key']
      if (!key) { socket.destroy(); return }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n'
      )
      handleWsSocket(socket, wssClients, () => {
        const entry = pluginApiServers.get(port)
        if (entry) entry.lastWsAt = Date.now()
      })
    } else {
      socket.destroy()
    }
  })

  srv.on('error', (err) => {
    console.error('[PluginAPI] Server error on port ' + port + ': ' + (err && err.message || err))
    pluginApiServers.delete(port)
    refreshPushConsumer()
  })

  srv.listen(port, '0.0.0.0', () => {
    console.log('[PluginAPI] AstrBot adapter API running on http://0.0.0.0:' + port)
  })

  pluginApiServers.set(port, { server: srv, wssClients: wssClients, token: token, lastHttpAt: 0, lastWsAt: 0 })
  refreshPushConsumer()
  return true
}

function stopPluginApiServer(port) {
  const entry = pluginApiServers.get(port)
  if (!entry) return
  for (const socket of entry.wssClients) {
    try { socket.destroy() } catch {}
  }
  entry.wssClients.clear()
  try { entry.server.close() } catch {}
  pluginApiServers.delete(port)
  console.log('[PluginAPI] Adapter API stopped on port ' + port)
  refreshPushConsumer()
}

// WS 心跳：每 30s 向所有插件 API 服务端的客户端发送 ping
setInterval(() => {
  for (const [, entry] of pluginApiServers) {
    for (const socket of entry.wssClients) {
      try { socket.write(wsFrame(0x9, Buffer.alloc(0))) } catch { entry.wssClients.delete(socket) }
    }
  }
}, 30000)

// 插件 API 服务端状态（供 WebUI bot 状态合并）
function getPluginApiStatus() {
  const out = []
  for (const [port, entry] of pluginApiServers) {
    out.push({
      port: Number(port),
      running: true,
      clientCount: entry.wssClients.size,
      lastHttpAt: entry.lastHttpAt || 0,
      lastWsAt: entry.lastWsAt || 0
    })
  }
  return out
}

// ─── 统一身份数据库（identity.db，SQLite 单写多读）─────────────────────────────

const { DatabaseSync } = require('node:sqlite')

const IDENTITY_DB_PATH = path.join(CONFIG_DIR, 'identity.db')
const IDENTITY_SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟全量刷新
const IDENTITY_REALTIME_FLUSH_MS = 30 * 1000 // 实时写入防抖落盘

let identityDb = null
let identityMemory = new Map()          // realWxid -> { custom_wxid, display_name, type, numeric_id, ... }
let customWxidLibrary = new Map()       // realWxid -> alias（自定义 wxid，仅 friend 非空 alias）
let customWxidReverse = new Map()       // alias(小写) -> realWxid
let identityNumericReverse = new Map()  // numeric_id -> realWxid（OneBot 数字反查预留）
let identityDirtyBuffer = new Set()     // 实时触达待落盘集合

// 与 botManager 完全一致的 djb2（OneBot 数字转换同源）
function numericIdOf(wxid) {
  let hash = 5381
  const s = String(wxid || '')
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function getCustomWxid(realWxid) {
  return customWxidLibrary.get(String(realWxid)) || null
}

function getRealWxid(customWxid) {
  return customWxidReverse.get(String(customWxid).toLowerCase()) || null
}

// OneBot 数字反查（预留）：numeric_id -> { wxid }
function getNumericReverse(numericId) {
  const wxid = identityNumericReverse.get(Number(numericId))
  return wxid || null
}

function initIdentityDb() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    identityDb = new DatabaseSync(IDENTITY_DB_PATH)
    identityDb.exec(
      'CREATE TABLE IF NOT EXISTS contacts (' +
      'real_wxid TEXT PRIMARY KEY, custom_wxid TEXT, display_name TEXT, nickname TEXT, ' +
      'type TEXT, numeric_id INTEGER, updated_at INTEGER, dirty INTEGER DEFAULT 0, avatar_url TEXT)'
    )
    identityDb.exec('CREATE INDEX IF NOT EXISTS idx_contacts_custom ON contacts(custom_wxid)')
    identityDb.exec('CREATE INDEX IF NOT EXISTS idx_contacts_numeric ON contacts(numeric_id)')
    identityDb.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    identityDb.exec(
      'CREATE TABLE IF NOT EXISTS group_nicknames (' +
      'session_id TEXT NOT NULL, member_wxid TEXT NOT NULL, nickname TEXT, avatar_url TEXT, ' +
      'updated_at INTEGER, PRIMARY KEY (session_id, member_wxid))'
    )
    // 存量库迁移：补 avatar_url 列
    try {
      const cols = identityDb.prepare("PRAGMA table_info(contacts)").all().map(c => c.name)
      if (!cols.includes('avatar_url')) identityDb.exec('ALTER TABLE contacts ADD COLUMN avatar_url TEXT')
    } catch {}
    try {
      const gcols = identityDb.prepare("PRAGMA table_info(group_nicknames)").all().map(c => c.name)
      if (!gcols.includes('avatar_url')) identityDb.exec('ALTER TABLE group_nicknames ADD COLUMN avatar_url TEXT')
    } catch {}
    loadIdentityFromDb()
  } catch (e) {
    console.error('[IdentityDB] init error: ' + e.message)
  }
}

// ─── 机器人自身身份 + 群昵称（@ 信息链路在身份库中的读写）────────────────────────

let selfWxid = '' // 从推送 payload.selfId 学习

function getSelfWxid() {
  if (selfWxid) return selfWxid
  try {
    const row = identityDb.prepare('SELECT value FROM meta WHERE key=?').get('self_wxid')
    selfWxid = row ? String(row.value || '') : ''
  } catch {}
  return selfWxid
}

// 记录机器人自身 wxid：写入 meta + contacts 表（type='self'）
function rememberSelfWxid(wxid) {
  const id = String(wxid || '').trim()
  if (!id) return
  const known = getSelfWxid()
  if (known === id) return
  selfWxid = id
  try {
    identityDb.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('self_wxid', id)
    identityDb.prepare(
      'INSERT INTO contacts (real_wxid, type, updated_at, dirty) VALUES (?,?,?,0) ' +
      'ON CONFLICT(real_wxid) DO UPDATE SET type=excluded.type, updated_at=excluded.updated_at, dirty=0'
    ).run(id, 'self', Date.now())
    syncBotGroupNicknames()
  } catch (e) {
    console.error('[IdentityDB] remember self error: ' + e.message)
  }
}

// 会话/联系人头像学习入库（推送 payload 携带 CDN 链接 或 data URI 群头像）
function rememberAvatar(wxid, avatarUrl) {
  const id = String(wxid || '').trim()
  const url = String(avatarUrl || '').trim()
  const isHttp = url.startsWith('http')
  const isDataImage = url.startsWith('data:image/')
  if (!id || !url || (!isHttp && !isDataImage)) return
  try {
    // http 链接持久化到 DB（防膨胀）；data URI 仅入内存，供会话兜底读取
    if (isHttp) {
      identityDb.prepare(
        'INSERT INTO contacts (real_wxid, avatar_url, updated_at, dirty) VALUES (?,?,?,1) ' +
        'ON CONFLICT(real_wxid) DO UPDATE SET avatar_url=excluded.avatar_url, updated_at=excluded.updated_at'
      ).run(id, url, Date.now())
    }
    const existing = identityMemory.get(id)
    if (existing) {
      identityMemory.set(id, Object.assign({}, existing, { avatar_url: url, updated_at: Date.now() }))
    }
  } catch (e) {}
}

// 同步各群成员群昵称 → group_nicknames 表（供 @ 链路 / 未来特性读身份库）
async function syncBotGroupNicknames() {
  const myWxid = getSelfWxid()
  const internalToken = readApiToken()
  const authHeaders = internalToken ? { Authorization: 'Bearer ' + internalToken } : {}
  let groups = []
  try {
    const r = await fetch('http://127.0.0.1:' + FLOW_PORT + '/api/v1/sessions', { headers: authHeaders })
    const j = await r.json()
    groups = (j.sessions || []).filter(s => s && s.sessionType === 'group' && s.username)
  } catch { return }
  for (const g of groups) {
    try {
      const r = await fetch(
        'http://127.0.0.1:' + FLOW_PORT + '/api/v1/group-members?chatroomId=' + encodeURIComponent(g.username),
        { headers: authHeaders }
      )
      const j = await r.json()
      const members = Array.isArray(j.members) ? j.members : []
      if (members.length === 0) continue
      identityDb.exec('BEGIN')
      try {
        for (const m of members) {
          const mid = String(m.wxid || m.username || '').trim()
          if (!mid) continue
          const nick = String(m.groupNickname || m.nickname || m.displayName || '').trim()
          const avatar = String(m.avatarUrl || '').trim()
          identityDb.prepare(
            'INSERT INTO group_nicknames (session_id, member_wxid, nickname, avatar_url, updated_at) VALUES (?,?,?,?,?) ' +
            'ON CONFLICT(session_id, member_wxid) DO UPDATE SET nickname=excluded.nickname, avatar_url=excluded.avatar_url, updated_at=excluded.updated_at'
          ).run(g.username, mid, nick || null, avatar || null, Date.now())
        }
        identityDb.exec('COMMIT')
      } catch (e) {
        try { identityDb.exec('ROLLBACK') } catch {}
      }
    } catch {}
  }
}

// 每 30 分钟同步一次群昵称（与全量同步同频）
setInterval(syncBotGroupNicknames, IDENTITY_SYNC_INTERVAL_MS)

function loadIdentityFromDb() {
  try {
    const rows = identityDb.prepare('SELECT * FROM contacts').all()
    identityMemory = new Map()
    customWxidLibrary = new Map()
    customWxidReverse = new Map()
    identityNumericReverse = new Map()
    for (const r of rows) {
      identityMemory.set(r.real_wxid, r)
      if (r.custom_wxid) {
        customWxidLibrary.set(r.real_wxid, r.custom_wxid)
        customWxidReverse.set(String(r.custom_wxid).toLowerCase(), r.real_wxid)
      }
      if (r.numeric_id != null) identityNumericReverse.set(Number(r.numeric_id), r.real_wxid)
    }
  } catch (e) {
    console.error('[IdentityDB] load error: ' + e.message)
  }
}

function upsertContactRow(c) {
  if (!c || !c.username) return
  const realWxid = String(c.username)
  // 自定义 wxid 仅取 friend 类型的微信号 alias（老账号无 alias → NULL）
  const customWxid = (c.type === 'friend' && c.alias) ? String(c.alias) : null
  const numericId = numericIdOf(realWxid)
  identityDb.prepare(
    'INSERT INTO contacts (real_wxid, custom_wxid, display_name, nickname, type, numeric_id, updated_at, dirty) ' +
    'VALUES (?,?,?,?,?,?,?,0) ' +
    'ON CONFLICT(real_wxid) DO UPDATE SET ' +
    'custom_wxid=excluded.custom_wxid, display_name=excluded.display_name, nickname=excluded.nickname, ' +
    'type=excluded.type, numeric_id=excluded.numeric_id, updated_at=excluded.updated_at, dirty=0'
  ).run(realWxid, customWxid, c.displayName || null, c.nickname || null, c.type || null, numericId, Date.now())
}

// 启动/30min 全量同步：从 WCDB contacts API 物化身份库
function fullSyncIdentityDb() {
  const internalToken = readApiToken()
  return fetch('http://127.0.0.1:' + FLOW_PORT + '/api/v1/contacts?limit=10000&forceRefresh=1', {
    headers: internalToken ? { Authorization: 'Bearer ' + internalToken } : {}
  })
    .then(function (r) { return r.json() })
    .then(function (j) {
      const list = (j && Array.isArray(j.contacts)) ? j.contacts : []
      if (!identityDb) return
      identityDb.exec('BEGIN')
      try {
        for (const c of list) upsertContactRow(c)
        identityDb.exec('COMMIT')
      } catch (e) {
        try { identityDb.exec('ROLLBACK') } catch {}
        throw e
      }
      identityDb.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('last_sync_at', String(Date.now()))
      loadIdentityFromDb()
      return true
    })
    .catch(function (e) {
      console.error('[IdentityDB] full sync error: ' + (e && e.message || e))
      return false
    })
}

// 实时触达：SSE 消息路径命中即更新内存 + 标记 dirty（30s 防抖批量落盘）
// 私聊与群聊都记录（群聊名称由群名同步任务刷新）
function realtimeTouchWxid(wxid, isGroup) {
  const realWxid = String(wxid || '').trim()
  if (!realWxid) return
  const numericId = numericIdOf(realWxid)
  const existing = identityMemory.get(realWxid)
  identityMemory.set(realWxid, Object.assign({}, existing, {
    real_wxid: realWxid, numeric_id: numericId, updated_at: Date.now(), dirty: 1
  }))
  identityNumericReverse.set(numericId, realWxid)
  identityDirtyBuffer.add(realWxid)
}

// 群聊名称自动刷新：比全量同步更频繁（默认 5 分钟），
// 从 WCDB Contact（contacts API）同步群名，覆盖 WeFlow 会话缓存的陈旧群名
const GROUP_NAME_REFRESH_MS = 5 * 60 * 1000

function syncGroupNames() {
  const internalToken = readApiToken()
  return fetch('http://127.0.0.1:' + FLOW_PORT + '/api/v1/contacts?limit=10000&forceRefresh=1', {
    headers: internalToken ? { Authorization: 'Bearer ' + internalToken } : {}
  })
    .then(function (r) { return r.json() })
    .then(function (j) {
      const list = (j && Array.isArray(j.contacts)) ? j.contacts : []
      const groups = list.filter(function (c) { return c && c.type === 'group' && c.username })
      if (groups.length === 0 || !identityDb) return
      identityDb.exec('BEGIN')
      try {
        for (const g of groups) upsertContactRow(g)
        identityDb.exec('COMMIT')
      } catch (e) {
        try { identityDb.exec('ROLLBACK') } catch {}
        throw e
      }
      loadIdentityFromDb()
    })
    .catch(function (e) {
      console.error('[IdentityDB] group name sync error: ' + (e && e.message || e))
    })
}

setInterval(syncGroupNames, GROUP_NAME_REFRESH_MS)

// 实时写入防抖落盘
setInterval(function () {
  if (identityDirtyBuffer.size === 0 || !identityDb) return
  try {
    identityDb.exec('BEGIN')
    for (const wxid of identityDirtyBuffer) {
      const e = identityMemory.get(wxid)
      identityDb.prepare(
        'INSERT INTO contacts (real_wxid, numeric_id, updated_at, dirty) VALUES (?,?,?,1) ' +
        'ON CONFLICT(real_wxid) DO UPDATE SET numeric_id=excluded.numeric_id, updated_at=excluded.updated_at, dirty=1'
      ).run(wxid, e && e.numeric_id != null ? e.numeric_id : numericIdOf(wxid), Date.now())
    }
    identityDb.exec('COMMIT')
    identityDirtyBuffer.clear()
  } catch (e) {
    try { identityDb.exec('ROLLBACK') } catch {}
  }
}, IDENTITY_REALTIME_FLUSH_MS)

// 启动快速重试（WeFlow 5031 晚于 WebUI 就绪）：无论持久化快照是否就绪，都重试到全量同步成功（最多 12 次/60s）
let identityInitTries = 0
const identityInitTimer = setInterval(function () {
  identityInitTries += 1
  if (identityInitTries >= 12) {
    clearInterval(identityInitTimer)
    return
  }
  fullSyncIdentityDb().then(function (ok) {
    if (ok) clearInterval(identityInitTimer)
  })
}, 5000)

setInterval(fullSyncIdentityDb, IDENTITY_SYNC_INTERVAL_MS)

// ─── 入站推送：消费 WeFlow SSE + 归一化 + 广播到所有插件 API 服务端 ────────────

function broadcastPushEvent(obj) {
  const body = JSON.stringify(obj)
  pushReplayBuffer.push({ body, at: Date.now() })
  if (pushReplayBuffer.length > PUSH_REPLAY_LIMIT) pushReplayBuffer.splice(0, pushReplayBuffer.length - PUSH_REPLAY_LIMIT)
  for (const [, entry] of pluginApiServers) {
    for (const socket of entry.wssClients) {
      try { socket.write(wsFrame(0x1, body)) } catch { entry.wssClients.delete(socket) }
    }
  }
}

function normalizePushPayload(p) {
  const realSessionId = String(p.sessionId || '')
  if (!realSessionId) return null
  // 仅转发真正的消息事件（ready/心跳等无 rawid 与内容的事件忽略）
  if (p.rawid == null && !p.content && !p.imagePath && !p.emojiUrl && !p.videoPath && !p.videoMd5 && !p.voicePath && !p.voiceMeta) return null
  const isGroup = realSessionId.endsWith('@chatroom')
  // 入站视频（ADAPTER-MEDIA-CONTRACT §5）：无图无表情时 type='video'，
  // 同时透出容器内路径（同机排障用）与自建 token 直链（跨容器可用）
  const hasVideo = !!(p.videoPath || p.videoMd5 || p.videoPosterPath || p.videoMeta)
  // 入站语音（INBOUND-VOICE-PUSH-PLAN §4.4）：语音消息独占事件，字段组镜像 video
  const hasVoice = !!(p.voicePath || p.voiceMeta)
  const type = hasVideo && !p.imagePath && !p.emojiUrl ? 'video'
    : (hasVoice && !hasVideo && !p.imagePath && !p.emojiUrl ? 'voice'
      : (p.imagePath ? 'image' : (p.emojiUrl ? 'emoji' : 'text')))
  let imageUrl
  if (p.imagePath) {
    const token = registerImagePath(p.imagePath)
    if (token) imageUrl = getPushImageBaseUrl() + '/api/image?token=' + token
  }
  let videoUrl
  if (p.videoPath) {
    const token = registerMediaPath(p.videoPath)
    if (token) videoUrl = getPushImageBaseUrl() + '/api/media?token=' + token
  }
  let videoPosterUrl
  if (p.videoPosterPath) {
    // 封面与视频同寿命 1h（对齐 OneBot 侧 cover TTL）
    const token = registerImagePath(p.videoPosterPath, 60 * 60 * 1000)
    if (token) videoPosterUrl = getPushImageBaseUrl() + '/api/image?token=' + token
  }
  // 入站语音（INBOUND-VOICE-PUSH-PLAN §4.4）：token 直链与 video 同机制（registerMediaPath，TTL 1h）；
  // 降级（blob 未缓存/解码失败）时 voice_url 缺省，voice_meta.duration_sec 恒可用
  let voiceUrl
  if (p.voicePath) {
    const token = registerMediaPath(p.voicePath)
    if (token) voiceUrl = getPushImageBaseUrl() + '/api/media?token=' + token
  }
  // 自定义 wxid：私聊会话身份用微信号 alias
  const customWxid = isGroup ? null : getCustomWxid(realSessionId)
  const sessionId = customWxid || realSessionId
  const senderId = customWxid || p.senderId || (isGroup ? undefined : realSessionId)
  return {
    event: 'message',
    data: {
      message_id: p.rawid != null ? String(p.rawid) : undefined,
      session_id: sessionId,
      real_wxid: customWxid ? realSessionId : undefined,
      self_id: p.selfId ? String(p.selfId) : undefined,
      at_users: Array.isArray(p.atUsers) && p.atUsers.length ? p.atUsers.map(String) : undefined,
      session_type: p.sessionType || (isGroup ? 'group' : 'private'),
      sender_id: senderId,
      sender_name: p.senderName || p.senderCard || p.sourceName || p.groupName || p.senderId || undefined,
      type: type,
      content: String(p.content || ''),
      timestamp: Number(p.timestamp || 0),
      avatar_url: p.avatarUrl ? String(p.avatarUrl) : undefined,
      group_avatar_url: p.groupAvatarUrl ? String(p.groupAvatarUrl) : undefined,
      image_path: p.imagePath || undefined,
      image_url: imageUrl,
      emoji_url: p.emojiUrl || undefined,
      group_name: isGroup ? (p.groupName || undefined) : undefined,
      video_path: p.videoPath || undefined,
      video_md5: p.videoMd5 || undefined,
      video_meta: p.videoMeta || undefined,
      video_url: videoUrl,
      video_poster_path: p.videoPosterPath || undefined,
      video_poster_url: videoPosterUrl,
      // 入站语音（INBOUND-VOICE-PUSH-PLAN §4.4）：duration_sec 恒透出（来自消息 XML，降级时也有）；
      // voice_meta.available=false 表示 WAV 不可用（未缓存/解码失败），适配器应跳过 ASR
      voice_path: p.voicePath || undefined,
      voice_url: voiceUrl,
      voice_duration_sec: p.voiceMeta && Number.isFinite(Number(p.voiceMeta.durationSec)) ? Number(p.voiceMeta.durationSec) : undefined,
      voice_meta: p.voiceMeta || undefined,
      // 引用回复（QUOTE-REPLY-SELF-MAPPING-DESIGN §五）：isSelf 已在 FlowBot 侧裁决，
      // 插件端据 quoted_is_self 钉死 Reply.sender_id = self_id
      quoted_sender_id: p.quoted && p.quoted.senderId ? String(p.quoted.senderId) : undefined,
      quoted_sender_name: p.quoted && p.quoted.senderName ? String(p.quoted.senderName) : undefined,
      quoted_content: p.quoted && p.quoted.content ? String(p.quoted.content) : undefined,
      quoted_svrid: p.quoted && p.quoted.svrid ? String(p.quoted.svrid) : undefined,
      quoted_is_self: p.quoted ? Boolean(p.quoted.isSelf) : undefined
    }
  }
}

function handleSseBlock(block) {
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) return // 心跳注释行
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (dataLines.length === 0) return
  try {
    const payload = JSON.parse(dataLines.join('\n'))
    // 学习机器人自身 wxid 并写入身份库（@ 信息链路在身份库中的读写）
    if (payload && payload.selfId) {
      rememberSelfWxid(String(payload.selfId))
    }
    // 会话/联系人头像入库（CDN 链接）
    if (payload && payload.sessionId && payload.avatarUrl) {
      rememberAvatar(String(payload.sessionId), String(payload.avatarUrl))
    }
    // 引导期/重放过滤：丢弃时间戳早于本进程启动前 5 秒的旧消息（重启后摒弃先前消息）
    // 注意：payload.timestamp 为秒，serverStartTime 为毫秒，需换算
    if (payload && typeof payload.timestamp === 'number' && payload.timestamp * 1000 < serverStartTime - 5000) {
      return
    }
    // 实时触达：私聊消息的会话/发送者即时写入身份库（为 OneBot 数字转换准备）
    if (payload && payload.sessionId) {
      const isGroup = String(payload.sessionId).endsWith('@chatroom')
      realtimeTouchWxid(payload.sessionId, isGroup)
      if (!isGroup && payload.senderId && payload.senderId !== payload.sessionId) {
        realtimeTouchWxid(payload.senderId, false)
      }
    }
    const normalized = normalizePushPayload(payload)
    if (normalized) broadcastPushEvent(normalized)
  } catch {}
}

let pushAbort = null
let pushConsumerActive = false

// ─── SSE 断点续传状态：重启后从上次事件续传，不重放旧消息 ──────────────────────

const PUSH_STATE_FILE = path.join(CONFIG_DIR, 'push-state.json')
let pushLastEventId = 0
let pushStateSaveTimer = null

function loadPushState() {
  try {
    if (fs.existsSync(PUSH_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(PUSH_STATE_FILE, 'utf-8'))
      pushLastEventId = Number(s.lastEventId) > 0 ? Number(s.lastEventId) : 0
    }
  } catch {}
}

// 防抖持久化最后事件 id（重启后据此续传，避免重放旧消息导致重复回复）
function persistPushStateDebounced() {
  clearTimeout(pushStateSaveTimer)
  pushStateSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      fs.writeFileSync(PUSH_STATE_FILE, JSON.stringify({ lastEventId: pushLastEventId, updatedAt: Date.now() }))
    } catch {}
  }, 2000)
}

function parseSseEventId(block) {
  const m = block.match(/^id:\s*(\d+)/m)
  if (m) {
    const id = Number(m[1])
    if (Number.isFinite(id) && id > pushLastEventId) {
      pushLastEventId = id
      persistPushStateDebounced()
    }
  }
}

function refreshPushConsumer() {
  const active = pluginApiServers.size > 0
  if (active && !pushConsumerActive) {
    pushConsumerActive = true
    startPushConsumer()
  } else if (!active && pushConsumerActive) {
    pushConsumerActive = false
    const ctrl = pushAbort
    pushAbort = null
    if (ctrl) { try { ctrl.abort() } catch {} }
  }
}

function startPushConsumer() {
  const token = readApiToken()
  const headers = token ? { Authorization: 'Bearer ' + token } : {}
  let retry = 0
  const connect = () => {
    if (!pushConsumerActive) return
    const controller = new AbortController()
    pushAbort = controller
    // 携带上次事件 id 续传：重启后不重放已消费的旧消息
    let pushUrl = 'http://127.0.0.1:' + FLOW_PORT + '/api/v1/push/messages'
    if (pushLastEventId > 0) pushUrl += '?lastEventId=' + pushLastEventId
    fetch(pushUrl, { headers, signal: controller.signal })
      .then(async (resp) => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        retry = 0
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            parseSseEventId(block)
            handleSseBlock(block)
          }
        }
      })
      .catch((err) => {
        if (pushAbort === controller && pushConsumerActive) console.error('[PluginAPI] push consumer error: ' + ((err && err.message) || err))
      })
      .finally(() => {
        if (pushAbort === controller && pushConsumerActive) {
          const delay = Math.min(30000, 2000 * Math.pow(2, Math.min(retry++, 8)))
          setTimeout(connect, delay)
        }
      })
  }
  connect()
}

// ─── 插件 API bot 生命周期：根据 bots 配置（mode=plugin）启动/停止 ─────────────

let lastPluginBotHash = ''
let pluginRefreshTimer = null

// 防抖：合并 bot 保存触发的多次刷新
function schedulePluginApiRefresh(delayMs) {
  clearTimeout(pluginRefreshTimer)
  pluginRefreshTimer = setTimeout(refreshPluginApiBots, delayMs || 600)
}

function refreshPluginApiBots() {
  let botsList
  let readOk = true
  try {
    const cfg = loadWeFlowConfig()
    const raw = cfg.bots
    botsList = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
  } catch {
    readOk = false
  }
  // 配置读取失败（如 electron-store 写入中）时保留当前状态，避免误停
  if (!readOk) return

  const desired = new Map() // port -> token
  for (const b of botsList || []) {
    if (b && b.mode === 'plugin' && b.enabled !== false && Number(b.port) > 0) {
      desired.set(Number(b.port), String(b.token || ''))
    }
  }

  const hash = JSON.stringify(Array.from(desired.entries()))
  if (hash === lastPluginBotHash) return
  lastPluginBotHash = hash

  for (const [port, entry] of pluginApiServers) {
    if (!desired.has(port) || desired.get(port) !== entry.token) {
      stopPluginApiServer(port)
    }
  }
  for (const [port, token] of desired) {
    if (!pluginApiServers.has(port)) {
      startPluginApiServer(port, token)
    }
  }
}

setInterval(refreshPluginApiBots, 5000)

// ─── 启动 ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  ensureApiToken()
  loadPushState()
  console.log(`[WebUI] FlowBOT management panel running on http://0.0.0.0:${PORT}`)
  console.log(`[WebUI] WeFlow config path: ${discoverWeFlowConfigPath()}`)
  console.log(`[WebUI] Disclaimer accepted: ${isDisclaimerAccepted()}`)
  // 身份库：建库/加载快照 + 启动全量同步（5031 就绪前的失败由 5s 重试兜底）
  initIdentityDb()
  fullSyncIdentityDb()
  refreshPluginApiBots()
})
