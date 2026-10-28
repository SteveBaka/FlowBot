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
const NOVNC_PORT = process.env.NOVNC_PORT || 7600
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
const BOX_KEY_FILE = process.env.WEFLOW_BOX_KEY_FILE || path.join(CONFIG_DIR, '.box-key')
const AUTH_INCIDENT_FILE = path.join(CONFIG_DIR, 'auth-incident.json')
const AUTH_PASSWORD_POLICY = /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{10,20}$/
const AUTH_FAIL_WINDOW_MS = 3 * 60 * 1000
const AUTH_COOLDOWN_MS = 3 * 60 * 1000
const AUTH_MAX_TOTAL_FAILURES = 15
const AUTH_MAX_WINDOW_FAILURES = 5
const activeTokens = new Set()
let authFailureTimes = []
let authFailureTotal = 0
let authCooldownUntil = 0
let authLockdown = false

function getBoxKey() {
  try {
    const existing = fs.readFileSync(BOX_KEY_FILE, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch {}
  try {
    ensureDirSync(CONFIG_DIR)
    const key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(BOX_KEY_FILE, key, { mode: 0o600 })
    return key
  } catch {
    return ''
  }
}

function boxEncrypt(plaintext) {
  const keyHex = getBoxKey()
  if (!keyHex) return ''
  const key = crypto.pbkdf2Sync(keyHex, 'weflow-box-v1', 100000, 32, 'sha256')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return 'box:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

function boxDecrypt(stored) {
  const keyHex = getBoxKey()
  if (!keyHex || !stored || !stored.startsWith('box:')) return ''
  try {
    const buf = Buffer.from(stored.slice(4), 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const ciphertext = buf.subarray(28)
    const key = crypto.pbkdf2Sync(keyHex, 'weflow-box-v1', 100000, 32, 'sha256')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

function readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function writeAuthFile(auth) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 })
  try { fs.chmodSync(AUTH_FILE, 0o600) } catch {}
}

function writePassword(newPassword, agreementAccepted) {
  const passEnc = boxEncrypt(newPassword)
  if (!passEnc) throw new Error('密码加密初始化失败')
  writeAuthFile({
    ver: 2,
    passEnc,
    salt: crypto.randomBytes(16).toString('hex'),
    mustChange: false,
    createdAt: new Date().toISOString(),
    agreement: agreementAccepted ? { acceptedAt: new Date().toISOString(), version: 'v3' } : undefined
  })
}

function safeEqualText(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest()
  const b = crypto.createHash('sha256').update(String(right || '')).digest()
  return crypto.timingSafeEqual(a, b)
}

function verifyPassword(password) {
  const auth = readAuthFile()
  if (!auth) return { ok: false, auth: null, mustChange: false }
  if (auth.passEnc) {
    const expected = boxDecrypt(auth.passEnc)
    return {
      ok: Boolean(expected) && safeEqualText(password, expected),
      auth,
      mustChange: auth.mustChange !== false
    }
  }
  if (auth.hash && auth.salt) {
    const hash = crypto.scryptSync(String(password || ''), auth.salt, 64).toString('hex')
    return { ok: safeEqualText(hash, auth.hash), auth, mustChange: auth.mustChange !== false }
  }
  return { ok: false, auth, mustChange: true }
}

function readAuthIncident() {
  try {
    const incident = JSON.parse(fs.readFileSync(AUTH_INCIDENT_FILE, 'utf-8'))
    return incident && typeof incident === 'object' ? incident : null
  } catch {
    return null
  }
}

function writeAuthIncident() {
  try {
    fs.writeFileSync(AUTH_INCIDENT_FILE, JSON.stringify({
      time: new Date().toISOString(),
      failures: AUTH_MAX_TOTAL_FAILURES,
      reason: '连续密码输入错误'
    }), { mode: 0o600 })
  } catch {}
}

function stopWeFlowForLockdown() {
  try {
    const pidFile = path.join(CONFIG_DIR, 'weflow-watchdog.pid')
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch {}
  try {
    execSync("pkill -TERM -f 'weflow --no-sandbox --disable-gpu' 2>/dev/null || true", { timeout: 5000 })
  } catch {}
}

function authGuard() {
  if (authLockdown) {
    return { blocked: true, status: 503, message: '密码输入错误次数已达上限，本次已停止服务' }
  }
  const remaining = authCooldownUntil - Date.now()
  if (remaining > 0) {
    return {
      blocked: true,
      status: 429,
      message: '密码尝试过于频繁，请稍后再试',
      retryAfterMs: remaining
    }
  }
  return null
}

function noteAuthFailure() {
  const now = Date.now()
  authFailureTimes.push(now)
  authFailureTimes = authFailureTimes.filter(function (stamp) { return now - stamp < AUTH_FAIL_WINDOW_MS })
  authFailureTotal += 1
  if (authFailureTimes.length >= AUTH_MAX_WINDOW_FAILURES) {
    authCooldownUntil = now + AUTH_COOLDOWN_MS
  }
  if (authFailureTotal >= AUTH_MAX_TOTAL_FAILURES) {
    authLockdown = true
    writeAuthIncident()
    stopWeFlowForLockdown()
    return { blocked: true, status: 503, message: '密码输入错误次数已达上限，本次已停止服务' }
  }
  return authGuard()
}

function resetAuthFailures() {
  authFailureTimes = []
  authFailureTotal = 0
  authCooldownUntil = 0
}

function isWebUiSecurityRequest(req) {
  if (String(req.headers['x-weflow-page'] || '').toLowerCase() !== 'webui') return false
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return false
  try {
    return new URL(origin).host === String(req.headers.host || '')
  } catch {
    return false
  }
}

function passwordPolicyError(password) {
  if (!AUTH_PASSWORD_POLICY.test(String(password || ''))) {
    return '密码需为 10–20 位，且同时包含大写字母、小写字母、数字和特殊字符'
  }
  return ''
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

// ─── 会话头像本地缓存（与 Electron AvatarFileCacheService 共用同一目录与命名） ───
// 设计要点：
// 1) 缓存目录 = ~/.config/weflow/cache/avatar-files，正是 Electron 端 getCacheBasePath()+'/avatar-files'，
//    且该目录位于容器持久卷（/root/.config → host flowbot/config），重启不丢、Electron 与 WebUI 可共用。
// 2) 文件名 avatar_<hash>.png 与 Electron 端 hashString() 完全一致，命中同一 URL 即命中同一文件。
// 3) 回源只在缓存缺失时发生一次；微信 CDN 需要 Referer/UA，否则可能被拒。
// 4) 有上限的 LRU 淘汰，避免长期运行把磁盘吃满。

const AVATAR_CACHE_DIR = path.join(HOME, '.config', 'weflow', 'cache', 'avatar-files')
const AVATAR_MAX_FILES = 300
const AVATAR_FETCH_TIMEOUT_MS = 8000
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
// 与 Electron 端保持一致的 hash 算法（32 位整型滚动 hash，取绝对值转 16 进制）
function avatarHashString(str) {
  let hash = 0
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    hash = (hash << 5) - hash + code
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

function avatarCachePath(url) {
  return path.join(AVATAR_CACHE_DIR, 'avatar_' + avatarHashString(url) + '.png')
}

// 进行中的下载去重：同一 URL 并发只回源一次
const avatarInflight = new Map()

async function avatarEvictIfNeeded() {
  try {
    const names = await fs.promises.readdir(AVATAR_CACHE_DIR)
    const files = names.filter(n => n.startsWith('avatar_') && n.endsWith('.png'))
    if (files.length < AVATAR_MAX_FILES) return
    const stats = []
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(AVATAR_CACHE_DIR, f))
        stats.push({ f, mtime: st.mtimeMs })
      } catch {}
    }
    stats.sort((a, b) => a.mtime - b.mtime)
    const removeCount = stats.length - AVATAR_MAX_FILES + 1
    for (let i = 0; i < removeCount && i < stats.length; i++) {
      try { await fs.promises.unlink(path.join(AVATAR_CACHE_DIR, stats[i].f)) } catch {}
    }
  } catch {}
}

// 下载头像到本地缓存；成功返回 Buffer 与 mime，失败返回 null（前端回退文字首字）
function avatarDownload(url) {
  const cachePath = avatarCachePath(url)
  return fs.promises.readFile(cachePath)
    .then(buf => ({ buf, mime: 'image/png', cached: true }))
    .catch(() => {
      if (avatarInflight.has(url)) return avatarInflight.get(url)
      const task = (async () => {
        try {
          ensureDirSync(AVATAR_CACHE_DIR)
          await avatarEvictIfNeeded()
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS)
          let resp
          try {
            resp = await fetch(url, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351',
                Referer: 'https://servicewechat.com/',
                Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
              }
            })
          } finally {
            clearTimeout(timer)
          }
          if (!resp || !resp.ok) return null
          const ab = await resp.arrayBuffer()
          const buf = Buffer.from(ab)
          if (!buf.length || buf.length > AVATAR_MAX_BYTES) return null
          // 只接受图片魔数，避免把错误页当头像缓存下来
          const isImg = (buf[0] === 0x89 && buf[1] === 0x50) ||
                        (buf[0] === 0xff && buf[1] === 0xd8) ||
                        (buf[0] === 0x47 && buf[1] === 0x49) ||
                        (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57)
          if (!isImg) return null
          try { await fs.promises.writeFile(cachePath, buf) } catch {}
          return { buf, mime: resp.headers.get('content-type') || 'image/png', cached: false }
        } catch {
          return null
        } finally {
          avatarInflight.delete(url)
        }
      })()
      avatarInflight.set(url, task)
      return task
    })
}

// GET /api/avatar?u=<微信CDN地址>：命中本地缓存直接回图，未命中则回源一次并落盘
// 头像短签名：HMAC(secret, url) 前 16 位。前端取 /api/avatar/sign 拿签后再拼 src，
// 这样 <img> 无需 Authorization 头，也不会把接口变成任意 URL 代理。
function avatarSign(u) {
  const secret = getBoxKey()
  if (!secret) return ''
  return crypto.createHmac('sha256', secret).update(String(u)).digest('hex').slice(0, 16)
}

async function serveAvatar(req, res) {
  let u = ''
  let k = ''
  try {
    const parsed = new URL(req.url, 'http://localhost')
    u = parsed.searchParams.get('u') || ''
    k = parsed.searchParams.get('k') || ''
  } catch {}
  if (!u || !/^https?:\/\//i.test(u)) {
    json(res, { ok: false, error: 'invalid url' }, 400)
    return
  }
  // 签名不符直接拒（防止被当作开放代理滥用）
  const expect = avatarSign(u)
  if (!expect || k !== expect) {
    json(res, { ok: false, error: 'bad signature' }, 403)
    return
  }
  // 只允许微信头像域，避免被当作任意 URL 代理使用
  let host = ''
  try { host = new URL(u).hostname } catch {}
  if (!/(^|\.)(qlogo\.cn|qpic\.cn|weixin\.qq\.com)$/i.test(host)) {
    json(res, { ok: false, error: 'host not allowed' }, 403)
    return
  }
  const hit = await avatarDownload(u)
  if (!hit) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('avatar unavailable')
    return
  }
  res.writeHead(200, {
    'Content-Type': hit.mime,
    'Content-Length': hit.buf.length,
    // 本地缓存可放心强缓存：头像 URL 变更时 hash 会变
    'Cache-Control': 'public, max-age=86400',
    'X-Avatar-Cache': hit.cached ? 'hit' : 'miss'
  })
  res.end(hit.buf)
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

// ─── 头像后台主动同步 ──────────────────────────────────────────────────
// WeFlow 常驻、WebUI 页面很少打开，所以不能依赖页面访问才缓存。
// 本进程随容器常驻，由它定期把全部会话头像拉到共用缓存目录，
// 这样 Electron 与 WebUI 两边都读本地文件，且不再反复请求微信 CDN。
const AVATAR_SYNC_INTERVAL_MS = 30 * 60 * 1000
const AVATAR_SYNC_FIRST_DELAY_MS = 20 * 1000
let avatarSyncRunning = false

async function avatarSyncAll(reason) {
  if (avatarSyncRunning) return
  avatarSyncRunning = true
  try {
    const token = readApiToken()
    const headers = token ? { Authorization: 'Bearer ' + token } : {}
    const resp = await fetch('http://127.0.0.1:' + FLOW_PORT + '/api/v1/sessions?limit=2000', { headers })
    if (!resp.ok) {
      console.log('[AvatarSync] skip (' + reason + '): FLOW ' + resp.status)
      return
    }
    const data = await resp.json()
    const sessions = Array.isArray(data && data.sessions) ? data.sessions : []
    const urls = []
    const seen = new Set()
    for (const s of sessions) {
      if (!s || !s.avatarUrl) continue
      const u = String(s.avatarUrl).trim()
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue
      seen.add(u)
      urls.push(u)
    }
    if (urls.length === 0) return
    let added = 0
    let failed = 0
    // 串行 + 小延迟：避免瞬间同时轰 CDN（行为异常也容易被对端注意）
    for (const u of urls) {
      const cachePath = avatarCachePath(u)
      let exists = false
      try { await fs.promises.access(cachePath); exists = true } catch {}
      if (exists) continue
      const hit = await avatarDownload(u)
      if (hit) {
        added++
        try { const st = await fs.promises.stat(cachePath); void st } catch {}
      } else {
        failed++
      }
      await new Promise(r => setTimeout(r, 120))
    }
    console.log('[AvatarSync] ' + reason + ': sessions=' + sessions.length + ' urls=' + urls.length +
      ' added=' + added + ' failed=' + failed)
  } catch (err) {
    console.log('[AvatarSync] error (' + reason + '): ' + ((err && err.message) || err))
  } finally {
    avatarSyncRunning = false
  }
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
// 管道落盘格式（start.sh + logfmt.awk 产出，级别在写入时即已定死）
const LOG_LINE_RE = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(INFO|WARN|ERROR|DEBUG|FATAL|TRACE)\] ?(.*)$/
// 兼容升级前写下的历史日志：WeFlow Logger 自带级别，其余靠关键词猜
const WEFLOW_LOG_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+\[(\w+)\]\s+\[(\w+)\]\s+(.*)/

// 与 logfmt.awk 的 lv_of 保持同一套判定，避免新旧日志级别口径打架
function guessLevel(text) {
  var l = text.toLowerCase().replace(/[a-z_]+=0/g, ' ')
  if (l.indexOf('fatal') !== -1) return 'fatal'
  if (l.indexOf('error') !== -1) return 'error'
  if (l.indexOf('warn') !== -1) return 'warn'
  if (l.indexOf('fail') !== -1) return 'error'
  if (l.indexOf('debug') !== -1) return 'debug'
  return 'info'
}

function guessCategory(line) {
  var l = line.toLowerCase()
  if (l.indexOf('wechat') !== -1 || l.indexOf('wechatappex') !== -1) return 'wechat'
  if (l.indexOf('x11vnc') !== -1 || l.indexOf('xvfb') !== -1 || l.indexOf('vnc') !== -1) return 'vnc'
  if (l.indexOf('onebot') !== -1 || l.indexOf('wsclient') !== -1 || l.indexOf('botmanager') !== -1) return 'onebot'
  return 'system'
}

function parseContainerLog(maxLines, categories, levels, search) {
  if (!fs.existsSync(CONTAINER_LOG)) return []
  var content
  try { content = fs.readFileSync(CONTAINER_LOG, 'utf-8') } catch { return [] }
  var rawLines = content.split('\n')
  var results = []
  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i]
    if (!line) continue
    var m = LOG_LINE_RE.exec(line)
    var w = m ? null : WEFLOW_LOG_RE.exec(line)
    var ts = '', level = 'info', category = 'system', msg = line
    if (m) {
      ts = m[1]
      level = m[2].toLowerCase()
      msg = m[3]
      category = guessCategory(msg)
    } else if (w) {
      ts = w[1]
      level = w[2].toLowerCase()
      msg = w[4]
      category = w[3].toLowerCase()
    } else {
      // 旧日志里微信引擎自带 "[E][时间][文件(行)]" 前缀，须先剥掉内层时间戳才能识别
      var eng = /^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*\[([EWIDV])\]/.exec(line)
      if (eng) {
        var c = eng[1]
        level = c === 'E' ? 'error' : c === 'W' ? 'warn' : (c === 'D' || c === 'V') ? 'debug' : 'info'
        msg = line.replace(/^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*\[[EWIDV]\]/, '')
      } else {
        level = guessLevel(line)
      }
      category = guessCategory(line)
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

// ═══════════════════════════════════════════════════════════════════════════════
// 本地认证权威（Unix socket）：WebUI 进程即认证方，在线即可用。
// WeFlow 每次启动/周期向此发起双向 HMAC 校验；失败则 WeFlow 侧 gate 敏感功能。
// ═══════════════════════════════════════════════════════════════════════════════
const net = require('net')
const ATTEST_SOCK = '/run/weflow/attest.sock'
const ATTEST_SECRET_FILE = '/opt/weflow/data/attest-secret'
const ATTEST_ASAR = '/opt/weflow/resources/app.asar'
const ATTEST_MODULE = 'weflow-attest'
const ATTEST_VERSION = '1.0.0'

let attestCapMsCache = undefined // undefined=未读取, null=读取失败
function attestCorePath() {
  const cands = [
    '/opt/weflow/resources/resources/attest/linux/x64/attest_core',
    '/opt/weflow/resources/attest/linux/x64/attest_core',
    path.join(__dirname, '..', '..', 'resources', 'attest', 'linux', 'x64', 'attest_core')
  ]
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}
function attestCapMs() {
  if (attestCapMsCache !== undefined) return attestCapMsCache
  const bin = attestCorePath()
  if (!bin) { attestCapMsCache = null; return null }
  try {
    const out = execSync(`"${bin}" lease ${Date.now()}`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const j = JSON.parse(out)
    attestCapMsCache = typeof j.cap_ms === 'number' ? j.cap_ms : null
  } catch { attestCapMsCache = null }
  return attestCapMsCache
}
function attestExpired() {
  const cap = attestCapMs()
  return cap != null && Date.now() >= cap
}

function attestSecret() {
  try {
    const s = fs.readFileSync(ATTEST_SECRET_FILE, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(s)) return s
  } catch { /* fallthrough */ }
  try {
    fs.mkdirSync(path.dirname(ATTEST_SECRET_FILE), { recursive: true })
    const s = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(ATTEST_SECRET_FILE, s, { mode: 0o600 })
    return s
  } catch { return '' }
}
function attestAsarSha() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(ATTEST_ASAR)).digest('hex') } catch { return '' }
}
function attestHmac(secret, msg) { return crypto.createHmac('sha256', secret).update(msg).digest('hex') }
function attestWcdbPatched() {
  try {
    const out = execSync('python3 /opt/patch-wcdb-deadline.py --check 2>&1', { timeout: 8000 }).toString()
    return /'at_target': True/.test(out)
  } catch { return false } // --check 非 0 退出（未打到目标）视为未就绪
}
let attestLast = { ok: false, reason: 'not-yet', checked_at: null, weflow_id: null }
let attestLeaseExpires = null // 最近一次成功校验授予的租期（1 个月）

function attestHandleLine(sock, line) {
  let req
  try { req = JSON.parse(line) } catch { sock.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); return }
  const secret = attestSecret()
  const asar = attestAsarSha()
  const patched = attestWcdbPatched()
  if (!secret || !asar) { sock.write(JSON.stringify({ ok: false, error: 'attest-unavailable' }) + '\n'); return }

  if (req.op === 'hello') {
    const nonceS = crypto.randomBytes(16).toString('hex')
    sock._attestCtx = { nonceC: String(req.nonce_c || ''), nonceS, asar, patched }
    const hmacS = attestHmac(secret, ['s', String(req.nonce_c || ''), nonceS, asar].join('|'))
    sock.write(JSON.stringify({
      ok: true, module: ATTEST_MODULE, version: ATTEST_VERSION, nonce_s: nonceS,
      asar_expected: asar, asar_ok: req.asar_sha256 === asar, webui_online: true,
      wcdb_patched: patched, hmac_s: hmacS
    }) + '\n')
    return
  }
  if (req.op === 'proof') {
    const ctx = sock._attestCtx || {}
    const expect = attestHmac(secret, ['c', ctx.nonceS || '', ctx.nonceC || '', asar].join('|'))
    const clientOk = req.hmac_c === expect
    const asarOk = ctx.asar === asar
    const expired = attestExpired()
    const ok = clientOk && asarOk && patched
    if (ok) {
      const exp = new Date(); exp.setMonth(exp.getMonth() + 1)
      const cap = attestCapMs()
      attestLeaseExpires = new Date(cap != null ? Math.min(exp.getTime(), cap) : exp.getTime()).toISOString()
    }
    attestLast = {
      ok,
      expired,
      reason: !clientOk ? 'client-proof-failed'
        : (!asarOk ? 'asar-mismatch'
          : (!patched ? 'wcdb-not-patched' : 'ok')),
      checked_at: new Date().toISOString(), weflow_id: req.weflow_id || null,
      expires_at: attestLeaseExpires
    }
    sock.write(JSON.stringify({
      ok, expired, module: ATTEST_MODULE, version: ATTEST_VERSION, asar_sha256: asar,
      webui_online: true, wcdb_patched: patched, checked_at: attestLast.checked_at,
      expires_at: attestLast.expires_at, reason: attestLast.reason
    }) + '\n')
    return
  }
  if (req.op === 'status') {
    sock.write(JSON.stringify({
      ok: true, module: ATTEST_MODULE, version: ATTEST_VERSION, asar_sha256: asar,
      webui_online: true, wcdb_patched: patched, last: attestLast
    }) + '\n')
    return
  }
  sock.write(JSON.stringify({ ok: false, error: 'unknown op' }) + '\n')
}

function startAttestServer() {
  try {
    attestSecret() // 启动即生成/确保 secret 文件存在，避免与 WeFlow 首次握手竞态
    fs.mkdirSync('/run/weflow', { recursive: true })
    try { fs.unlinkSync(ATTEST_SOCK) } catch { /* ignore */ }
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8')
      let buf = ''
      sock.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          try { attestHandleLine(sock, line) } catch { /* ignore */ }
        }
      })
      sock.on('error', () => { /* ignore */ })
    })
    srv.listen(ATTEST_SOCK, () => {
      try { fs.chmodSync(ATTEST_SOCK, 0o600) } catch { /* ignore */ }
    })
    srv.on('error', (e) => console.warn('[attest] server error:', e.message))
  } catch (e) { console.warn('[attest] start failed:', e && e.message) }
}

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
    let blocked = authGuard()
    if (blocked && blocked.status === 429) blocked = noteAuthFailure() || blocked
    if (blocked) {
      json(res, { ok: false, error: blocked.message, code: authLockdown ? 'AUTH_LOCKDOWN' : 'AUTH_COOLDOWN', retryAfterMs: blocked.retryAfterMs }, blocked.status)
      return
    }
    const bodyData = await body(req)
    const verified = verifyPassword(bodyData.password || '')
    if (verified.ok) {
      resetAuthFailures()
      const token = generateToken()
      activeTokens.clear()
      activeTokens.add(token)
      json(res, {
        ok: true,
        token,
        mustChange: verified.mustChange,
        agreementAccepted: Boolean(verified.auth && verified.auth.agreement && verified.auth.agreement.acceptedAt),
        incident: readAuthIncident()
      })
    } else {
      const failure = noteAuthFailure()
      json(res, {
        ok: false,
        error: failure && failure.message ? failure.message : '密码错误',
        code: authLockdown ? 'AUTH_LOCKDOWN' : (failure && failure.status === 429 ? 'AUTH_COOLDOWN' : 'AUTH_INVALID'),
        retryAfterMs: failure && failure.retryAfterMs
      }, failure && failure.status ? failure.status : 401)
    }
    return
  }

  if (p === '/api/auth/verify' && req.method === 'GET') {
    if (isAuthenticated(req)) json(res, { ok: true })
    else json(res, { ok: false }, 401)
    return
  }

  if (p === '/api/auth/state' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }
    const auth = readAuthFile()
    json(res, {
      ok: true,
      mustChange: !auth || auth.mustChange !== false,
      agreementAccepted: Boolean(auth && auth.agreement && auth.agreement.acceptedAt),
      incident: readAuthIncident()
    })
    return
  }

  if (p === '/api/auth/first-change' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }
    if (!isWebUiSecurityRequest(req)) {
      json(res, { ok: false, error: 'Security context rejected' }, 403)
      return
    }
    const auth = readAuthFile()
    if (!auth || auth.mustChange === false) {
      json(res, { ok: false, error: '当前会话无需首次改密' }, 409)
      return
    }
    const bodyData = await body(req)
    const newPassword = String(bodyData.newPassword || '')
    const confirmPassword = String(bodyData.confirmPassword || '')
    if (!bodyData.agreementAccepted) {
      json(res, { ok: false, error: '请先阅读并同意用户协议与免责声明' }, 400)
      return
    }
    if (newPassword !== confirmPassword) {
      json(res, { ok: false, error: '两次输入的新密码不一致' }, 400)
      return
    }
    const policyError = passwordPolicyError(newPassword)
    if (policyError) {
      json(res, { ok: false, error: policyError }, 400)
      return
    }
    if (verifyPassword(newPassword).ok) {
      json(res, { ok: false, error: '新密码不能与旧密码相同' }, 400)
      return
    }
    try {
      writePassword(newPassword, true)
      activeTokens.clear()
      json(res, { ok: true, relogin: true, message: '密码已修改，请使用新密码重新登录' })
    } catch (err) {
      json(res, { ok: false, error: err.message || String(err) }, 500)
    }
    return
  }

  if (p === '/api/auth/change-password' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }
    if (!isWebUiSecurityRequest(req)) {
      json(res, { ok: false, error: 'Security context rejected' }, 403)
      return
    }
    let blocked = authGuard()
    if (blocked && blocked.status === 429) blocked = noteAuthFailure() || blocked
    if (blocked) {
      json(res, { ok: false, error: blocked.message, code: authLockdown ? 'AUTH_LOCKDOWN' : 'AUTH_COOLDOWN', retryAfterMs: blocked.retryAfterMs }, blocked.status)
      return
    }
    const bodyData = await body(req)
    const oldPassword = String(bodyData.oldPassword || '')
    const newPassword = String(bodyData.newPassword || '')
    const confirmPassword = String(bodyData.confirmPassword || '')
    const verified = verifyPassword(oldPassword)
    if (!verified.ok) {
      const failure = noteAuthFailure()
      console.warn('[WebUI Auth] Password change rejected: current password mismatch')
      json(res, {
        ok: false,
        error: failure && failure.message ? failure.message : '旧密码错误',
        code: authLockdown ? 'AUTH_LOCKDOWN' : (failure && failure.status === 429 ? 'AUTH_COOLDOWN' : 'AUTH_INVALID'),
        retryAfterMs: failure && failure.retryAfterMs
      }, failure && failure.status ? failure.status : 400)
      return
    }
    if (newPassword !== confirmPassword) {
      json(res, { ok: false, error: '两次输入的新密码不一致' }, 400)
      return
    }
    const policyError = passwordPolicyError(newPassword)
    if (policyError) {
      json(res, { ok: false, error: policyError }, 400)
      return
    }
    if (safeEqualText(oldPassword, newPassword)) {
      json(res, { ok: false, error: '新密码不能与旧密码相同' }, 400)
      return
    }
    try {
      const auth = readAuthFile()
      writePassword(newPassword, Boolean(auth && auth.agreement && auth.agreement.acceptedAt))
      resetAuthFailures()
      activeTokens.clear()
      console.log('[WebUI Auth] Password changed successfully; all sessions revoked')
      json(res, { ok: true, relogin: true, message: '密码已修改，请使用新密码重新登录' })
    } catch (err) {
      json(res, { ok: false, error: err.message || String(err) }, 500)
    }
    return
  }

  if (p === '/api/auth/incident/ack' && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      json(res, { ok: false, error: 'Unauthorized' }, 401)
      return
    }
    try { fs.unlinkSync(AUTH_INCIDENT_FILE) } catch {}
    json(res, { ok: true })
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

  if (p.startsWith('/api/') && !p.startsWith('/api/auth/') && p !== '/api/status' && p !== '/api/version' && p !== '/api/image' && p !== '/api/media' && p !== '/api/avatar') {
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
      onebot_port: Number(ONEBOT_PORT), webui_port: Number(PORT),
      novnc_port: Number(NOVNC_PORT), flow_port: Number(FLOW_PORT)
    })
    return
  }

  if (p === '/api/attest') {
    json(res, {
      ok: true,
      module: ATTEST_MODULE,
      version: ATTEST_VERSION,
      asar_sha256: attestAsarSha(),
      wcdb_patched: attestWcdbPatched(),
      cap_ms: attestCapMs(),
      expired: attestExpired(),
      last: attestLast
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

  // 头像签名批量获取：返回 { url: signedPath } 映射，供 <img src> 直接使用
  if (p === '/api/avatar/sign' && req.method === 'POST') {
    const d = await body(req)
    const urls = Array.isArray(d && d.urls) ? d.urls.slice(0, 500) : []
    const out = {}
    for (const u of urls) {
      const s0 = String(u || '').trim()
      if (!/^https?:\/\//i.test(s0)) continue
      let host = ''
      try { host = new URL(s0).hostname } catch { continue }
      if (!/(^|\.)(qlogo\.cn|qpic\.cn|weixin\.qq\.com)$/i.test(host)) continue
      const sig = avatarSign(s0)
      if (sig) out[s0] = '/api/avatar?u=' + encodeURIComponent(s0) + '&k=' + sig
    }
    json(res, { ok: true, signed: out })
    return
  }

  // 会话头像：本地缓存优先，缺失时回源微信 CDN 一次并落盘（Electron 共用同一目录）
  if (p === '/api/avatar' && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveAvatar(req, res)
    return
  }

  if (p === '/api/account/profile' && req.method === 'GET') {
    try {
      const result = await resolveAccountProfile()
      json(res, { ok: true, profile: result.profile, source: result.source })
    } catch (err) {
      json(res, { ok: false, error: String(err && err.message || err) }, 502)
    }
    return
  }

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

    // 机器人自身身份（GET /api/v1/bot/self）：配置态 myWxid（清洗后）为权威源、
    // 身份库学习值兜底——插件通道版「lifecycle connect」，适配器启动预热即知 wxid，
    // 消除"等首条推送才知道我是谁"的双端盲区（OneBot 侧无此问题，见 botManager 启动喂入）
    if (p === '/api/v1/bot/self' && req.method === 'GET') {
      const botSelf = getBotSelfId()
      json(res, { ok: true, self_id: botSelf.self_id, source: botSelf.source })
      return
    }

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

// 机器人自身身份权威值（IDENTITY 链路）：WeFlow 配置态 myWxid（清洗后）优先，
// 身份库学习值（getSelfWxid，首条推送才写入）兜底——与 OneBot 通道「启动即喂入」
// （main.ts:4743 → startBotManager(myWxid)）语义对齐，消除"首条推送才知"的冷启动盲区
// 与换号后吐旧号问题。
// 清洗逻辑逐字复刻主进程 configService.cleanAccountDirName（config.ts:1090）——server.js
// 为独立 Node 进程调不到 configService，产出形态必须与推送 payload.selfId
// （getMyWxidCleaned）严格一致，否则适配器侧唤醒/回显过滤/引用裁决全部错位。
function cleanAccountDirNameWxid(dirName) {
  const trimmed = String(dirName || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const m = trimmed.match(/^(wxid_[^_]+)/i)
    return m ? m[1] : trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

function getBotSelfId() {
  try {
    const fromConfig = cleanAccountDirNameWxid(loadWeFlowConfig().myWxid)
    if (fromConfig) return { self_id: fromConfig, source: 'config' }
  } catch (e) {}
  const learned = getSelfWxid()
  if (learned) return { self_id: learned, source: 'learned' }
  return { self_id: undefined, source: 'none' }
}

let accountProfileCache = { key: '', updatedAt: 0, data: null }
const ACCOUNT_PROFILE_CACHE_MS = 5 * 60 * 1000

function sameAccountId(left, right) {
  const a = cleanAccountDirNameWxid(left).toLowerCase()
  const b = cleanAccountDirNameWxid(right).toLowerCase()
  return Boolean(a && b && a === b)
}

async function getFlowApiJson(pathname) {
  const token = readApiToken()
  const result = await proxyRequest('http://127.0.0.1:' + FLOW_PORT + pathname, {
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  })
  if (result.status < 200 || result.status >= 300) return null
  return result.data && typeof result.data === 'object' ? result.data : null
}

async function resolveAccountProfile() {
  const botSelf = getBotSelfId()
  const rawWxid = String(botSelf.self_id || '').trim()
  const wxid = cleanAccountDirNameWxid(rawWxid) || rawWxid
  if (!wxid) {
    return {
      profile: { wxid: '', rawWxid: '', displayName: '未登录', avatarUrl: '' },
      source: 'none'
    }
  }

  const cacheKey = rawWxid + '|' + wxid
  if (accountProfileCache.data && accountProfileCache.key === cacheKey &&
      Date.now() - accountProfileCache.updatedAt < ACCOUNT_PROFILE_CACHE_MS) {
    return accountProfileCache.data
  }

  let displayName = ''
  let avatarUrl = ''
  let source = botSelf.source || 'unknown'

  const identity = identityMemory.get(rawWxid) || identityMemory.get(wxid)
  if (identity) {
    displayName = String(identity.display_name || identity.nickname || '').trim()
    avatarUrl = String(identity.avatar_url || '').trim()
    if (displayName || avatarUrl) source = 'identity'
  }

  if (!avatarUrl && identityDb) {
    try {
      const row = identityDb.prepare(
        'SELECT nickname, avatar_url FROM group_nicknames ' +
        'WHERE lower(member_wxid)=lower(?) AND avatar_url IS NOT NULL ' +
        'ORDER BY updated_at DESC LIMIT 1'
      ).get(wxid)
      if (row) {
        if (!displayName && row.nickname) displayName = String(row.nickname)
        if (row.avatar_url) avatarUrl = String(row.avatar_url)
        if (!displayName && avatarUrl) source = 'group'
      }
    } catch {}
  }

  if (!displayName || !avatarUrl) {
    const contactsData = await getFlowApiJson('/api/v1/contacts?limit=10000')
    const contacts = contactsData && Array.isArray(contactsData.contacts) ? contactsData.contacts : []
    const contact = contacts.find(function (item) {
      return item && sameAccountId(item.username, wxid)
    })
    if (contact) {
      if (!displayName) {
        displayName = String(contact.displayName || contact.nickname || contact.remark || '').trim()
      }
      if (!avatarUrl && contact.avatarUrl) avatarUrl = String(contact.avatarUrl)
      if (displayName || avatarUrl) source = source === 'identity' ? 'identity+contacts' : 'contacts'
    }
  }

  if (!avatarUrl) {
    const sessionsData = await getFlowApiJson('/api/v1/sessions?limit=1000')
    const sessions = sessionsData && Array.isArray(sessionsData.sessions) ? sessionsData.sessions : []
    const groups = sessions.filter(function (item) {
      return item && item.username && (item.sessionType === 'group' || String(item.username).endsWith('@chatroom'))
    }).slice(0, 8)
    for (const group of groups) {
      const membersData = await getFlowApiJson(
        '/api/v1/group-members?chatroomId=' + encodeURIComponent(String(group.username))
      )
      const members = membersData && Array.isArray(membersData.members) ? membersData.members : []
      const selfMember = members.find(function (item) {
        return item && sameAccountId(item.wxid || item.username, wxid)
      })
      if (selfMember && selfMember.avatarUrl) {
        avatarUrl = String(selfMember.avatarUrl)
        if (!displayName) {
          displayName = String(selfMember.displayName || selfMember.nickname || '').trim()
        }
        source = source === 'identity' ? 'identity+group' : 'group'
        break
      }
    }
  }

  const data = {
    profile: {
      wxid: wxid,
      rawWxid: rawWxid,
      displayName: displayName || wxid,
      avatarUrl: avatarUrl || ''
    },
    source: source
  }
  accountProfileCache = { key: cacheKey, updatedAt: Date.now(), data: data }
  return data
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
function fullSyncIdentityDb(quiet) {
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
      // quiet 仅用于启动首次调用：此时 5031 尚未就绪，重试循环会接手
      if (!quiet) console.error('[IdentityDB] full sync error: ' + (e && e.message || e))
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

// 合并转发条目媒体 token 化（INBOUND-FORWARD-PUSH-PLAN-PHASE2 §3.1）：
// Electron 侧还原产物以 media_path / media_thumb_path 内部字段随 payload 到达，
// 此处注册 token 直链后删除路径（契约原则 4：真实文件路径不对适配器暴露）。
// token TTL 统一 1h（与 video/voice 同寿命，避免"分析慢一点就 404"）；emoji 透传的
// 微信 CDN 直链（media_url 已终态）不注册、不改写。
function mapForwardItemMedia(it) {
  if (!it || typeof it !== 'object') return it
  const out = Object.assign({}, it)
  if (out.media_path) {
    const token = registerMediaPath(out.media_path)
    if (token) {
      out.media_url = getPushImageBaseUrl() + '/api/media?token=' + token
      out.media_token_ttl_ms = MEDIA_TOKEN_TTL_MS
    }
    delete out.media_path
  }
  if (out.media_thumb_path) {
    // 缩略图/封面与媒体同寿命 1h（对齐 video_poster_url TTL 先例）
    const token = registerImagePath(out.media_thumb_path, 60 * 60 * 1000)
    if (token) {
      out.media_thumb_url = getPushImageBaseUrl() + '/api/image?token=' + token
      out.media_token_ttl_ms = 60 * 60 * 1000
    }
    delete out.media_thumb_path
  }
  if (Array.isArray(out.chat_record_items)) {
    out.chat_record_items = out.chat_record_items.map(mapForwardItemMedia)
  }
  return out
}

function normalizePushPayload(p) {
  const realSessionId = String(p.sessionId || '')
  if (!realSessionId) return null
  // 仅转发真正的消息事件（ready/心跳等无 rawid 与内容的事件忽略）
  if (p.rawid == null && !p.content && !p.imagePath && !p.emojiUrl && !p.videoPath && !p.videoMd5 && !p.voicePath && !p.voiceMeta && !p.forwardItems) return null
  const isGroup = realSessionId.endsWith('@chatroom')
  // 入站视频（ADAPTER-MEDIA-CONTRACT §5）：无图无表情时 type='video'，
  // 同时透出容器内路径（同机排障用）与自建 token 直链（跨容器可用）
  const hasVideo = !!(p.videoPath || p.videoMd5 || p.videoPosterPath || p.videoMeta)
  // 入站语音（INBOUND-VOICE-PUSH-PLAN §4.4）：语音消息独占事件，字段组镜像 video
  const hasVoice = !!(p.voicePath || p.voiceMeta)
  // 入站合并转发（INBOUND-FORWARD-PUSH-PLAN §4.3）：media 类型优先（同帧异常时保守选 media），
  // forward 次之；content 恒为渲染全文（§3.8-3 兼容规则，旧适配器 Plain(content) 即可分析）
  const hasForward = Array.isArray(p.forwardItems) && p.forwardItems.length > 0
  const type = hasVideo && !p.imagePath && !p.emojiUrl ? 'video'
    : (hasVoice && !hasVideo && !p.imagePath && !p.emojiUrl ? 'voice'
      : (p.imagePath ? 'image' : (p.emojiUrl ? 'emoji' : (hasForward ? 'forward' : 'text'))))
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
  // 表情直链（P0）：与 image/video/voice 同构，自建 token 读本地文件，
  // 不再让下游被微信 CDN 的防盗链与时效绑定。emojiPath 缺失时退回原始 CDN 地址。
  let emojiUrl
  let emojiCdnUrl = p.emojiUrl ? String(p.emojiUrl) : undefined
  if (p.emojiPath) {
    const token = registerImagePath(p.emojiPath, 60 * 60 * 1000)
    if (token) emojiUrl = getPushImageBaseUrl() + '/api/image?token=' + token
  }
  if (!emojiUrl) emojiUrl = emojiCdnUrl

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
      // 归一化消息类型（5031 源侧 resolveMessageType 产出）。与 type 并存：
      // type 由本函数按字段反推、取值偏窄；message_type 是源侧权威判定，
      // 能区分 sticker/sticker 与 sticker/image 的差异，且对 49 复合消息更准确。
      message_type: p.messageType || undefined,
      content: String(p.content || p.forwardText || ''),
      timestamp: Number(p.timestamp || 0),
      avatar_url: p.avatarUrl ? String(p.avatarUrl) : undefined,
      group_avatar_url: p.groupAvatarUrl ? String(p.groupAvatarUrl) : undefined,
      image_path: p.imagePath || undefined,
      image_url: imageUrl,
      emoji_url: emojiUrl,
      emoji_cdn_url: emojiCdnUrl,
      emoji_path: p.emojiPath || undefined,
      emoji_md5: p.emojiMd5 || undefined,
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
      // 入站合并转发（INBOUND-FORWARD-PUSH-PLAN §3.3）：content 与 forward_text 同值恒为渲染全文
      forward_text: p.forwardText || undefined,
      forward_title: p.forwardTitle || undefined,
      forward_count: p.forwardCount ?? (hasForward ? p.forwardItems.length : undefined),
      forward_items: hasForward ? p.forwardItems.map(mapForwardItemMedia) : undefined,
      forward_truncated: p.forwardTruncated === true ? true : undefined,
      forward_max_items: p.forwardMaxItems ?? undefined,
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
  // 启动阶段 WeFlow 的 5031 还没监听，头几轮失败是必然过程，不该打扰人；
  // 只有曾经连上过之后掉线，或连续失败到明显不正常，才算真故障。
  let connectedOnce = false
  let failStreak = 0
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
        connectedOnce = true
        failStreak = 0
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
        if (pushAbort !== controller || !pushConsumerActive) return
        failStreak += 1
        if (connectedOnce || failStreak >= 4) {
          console.error('[PluginAPI] push consumer error (streak ' + failStreak + '): ' + ((err && err.message) || err))
        }
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
  startAttestServer()
  console.log(`[WebUI] FlowBOT management panel running on http://0.0.0.0:${PORT}`)
  console.log(`[WebUI] WeFlow config path: ${discoverWeFlowConfigPath()}`)
  console.log(`[WebUI] Disclaimer accepted: ${isDisclaimerAccepted()}`)
  // 身份库：建库/加载快照 + 启动全量同步（5031 就绪前的失败由 5s 重试兜底）
  initIdentityDb()
  fullSyncIdentityDb(true)
  // 头像缓存：容器常驻即开始预热，与 Electron 共用同一目录
  setTimeout(function () { avatarSyncAll('startup') }, AVATAR_SYNC_FIRST_DELAY_MS)
  setInterval(function () { avatarSyncAll('periodic') }, AVATAR_SYNC_INTERVAL_MS)
  refreshPluginApiBots()
})
