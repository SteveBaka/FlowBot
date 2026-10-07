import net from 'net'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

// Electron 的 fs 会拦截含 .asar 的路径；读取 app.asar 本体需用 original-fs 绕过。
const origFs: any = (() => {
  try { return require('original-fs') } catch { return require('fs') }
})()

/**
 * 本地认证客户端（Unix socket）。
 *
 * - 认证方：容器内 WebUI 进程（/run/weflow/attest.sock）。
 * - 每次校验执行双向 HMAC（WebUI 在线 + 秘密一致 + asar 指纹一致 + WCDB 期限 patch 已应用）。
 * - 到期时刻（cap）与租期的**唯一持有者**是原生二进制 `attest_core`；由 WebUI 权威侧读取并
 *   通过响应分发 `expires_at`，客户端不再本地保存任何时间常量。
 * - 校验结果与租期仅存进程内存，不落盘；纯本地，不产生任何外联。
 */

const ATTEST_SOCK = '/run/weflow/attest.sock'
const ATTEST_SECRET_FILE = '/opt/weflow/data/attest-secret'
const DAY_MS = 24 * 60 * 60 * 1000
const DEBUG = process.env.WEFLOW_ATTEST_DEBUG === '1'

function log(...a: any[]): void {
  if (DEBUG) console.log('[attest-client]', ...a)
}

function resolveAttestCore(): string | null {
  const cands = [
    join(process.resourcesPath, 'resources', 'attest', 'linux', 'x64', 'attest_core'),
    join(process.resourcesPath, 'attest', 'linux', 'x64', 'attest_core'),
    '/opt/weflow/resources/resources/attest/linux/x64/attest_core'
  ]
  for (const p of cands) {
    try { if (origFs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

/** 兜底计算租期到期时刻：优先 WebUI 分发的值，缺失时才回落到本地 attest_core 二进制 */
function computeLeaseMs(grantedAt: number): number {
  const bin = resolveAttestCore()
  if (bin) {
    try {
      const out = execFileSync(bin, ['lease', String(grantedAt)], {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'] // 丢弃 stderr，保持日志干净
      } as any).toString().trim()
      const j = JSON.parse(out)
      if (typeof j.expires_at === 'number') return j.expires_at
    } catch { /* fallthrough */ }
  }
  const d = new Date(grantedAt)
  d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

export type AttestState = {
  attested: boolean
  reason: string
  moduleVersion: string | null
  asarSha256: string | null
  wcdbPatched: boolean
  checkedAt: string | null
  expiresAt: number | null
}

class AttestService {
  private state: AttestState = {
    attested: false,
    reason: 'not-started',
    moduleVersion: null,
    asarSha256: null,
    wcdbPatched: false,
    checkedAt: null,
    expiresAt: null
  }
  private timer: ReturnType<typeof setInterval> | null = null

  getState(): AttestState {
    return { ...this.state }
  }

  /** 最近一次校验是否通过（无需等待） */
  isAttested(): boolean {
    return this.state.attested
  }

  /** 是否可用：最近一次通过，或仍处于权威侧分发的租期内 */
  isUsable(): boolean {
    if (this.state.attested) return true
    return this.state.expiresAt != null && Date.now() < this.state.expiresAt
  }

  private secret(): string {
    try {
      const s = readFileSync(ATTEST_SECRET_FILE, 'utf8').trim()
      return /^[0-9a-f]{64}$/.test(s) ? s : ''
    } catch {
      return ''
    }
  }

  private asarSha256(): string {
    try {
      const p = join(process.resourcesPath, 'app.asar')
      if (!origFs.existsSync(p)) return ''
      return crypto.createHash('sha256').update(origFs.readFileSync(p)).digest('hex')
    } catch {
      return ''
    }
  }

  private hmac(secret: string, msg: string): string {
    return crypto.createHmac('sha256', secret).update(msg).digest('hex')
  }

  refresh(): Promise<AttestState> {
    return new Promise((resolve) => {
      const secret = this.secret()
      const asar = this.asarSha256()
      if (!secret || !asar) {
        this.state = { ...this.state, attested: false, reason: 'missing-secret-or-asar' }
        return resolve(this.state)
      }
      const nonceC = crypto.randomBytes(16).toString('hex')
      let buf = ''
      let done = false
      const sock = net.connect(ATTEST_SOCK)
      const finish = (s: AttestState) => {
        if (done) return
        done = true
        try { sock.destroy() } catch { /* ignore */ }
        this.state = s
        log(s.attested ? 'OK' : 'FAIL', s.reason)
        resolve(s)
      }
      sock.setTimeout(4000, () => finish({ ...this.state, attested: false, reason: 'timeout', checkedAt: new Date().toISOString() }))
      sock.on('error', () => finish({ ...this.state, attested: false, reason: 'connect-error', checkedAt: new Date().toISOString() }))
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        sock.write(JSON.stringify({ op: 'hello', weflow_id: process.pid, nonce_c: nonceC, asar_sha256: asar }) + '\n')
      })
      sock.on('data', (d: string) => {
        buf += d
        let i = buf.indexOf('\n')
        while (i >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          i = buf.indexOf('\n')
          let msg: any
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.nonce_s && msg.hmac_s) {
            const expectS = this.hmac(secret, ['s', nonceC, msg.nonce_s, asar].join('|'))
            if (msg.hmac_s !== expectS) {
              finish({ ...this.state, attested: false, reason: 'server-proof-failed', checkedAt: new Date().toISOString() })
              return
            }
            const hmacC = this.hmac(secret, ['c', msg.nonce_s, nonceC, asar].join('|'))
            sock.write(JSON.stringify({ op: 'proof', weflow_id: process.pid, nonce_c: nonceC, nonce_s: msg.nonce_s, hmac_c: hmacC }) + '\n')
            continue
          }
          if (typeof msg.ok === 'boolean' && (msg.reason !== undefined || msg.checked_at !== undefined)) {
            const ok = !!msg.ok
            const granted = typeof msg.expires_at === 'number' ? msg.expires_at : null
            const expiresAt = ok ? (granted ?? computeLeaseMs(Date.now())) : this.state.expiresAt
            finish({
              attested: ok,
              reason: msg.reason || (ok ? 'ok' : 'failed'),
              moduleVersion: msg.version || null,
              asarSha256: msg.asar_sha256 || msg.asar_expected || asar,
              wcdbPatched: !!msg.wcdb_patched,
              checkedAt: msg.checked_at || new Date().toISOString(),
              expiresAt
            })
            return
          }
        }
      })
    })
  }

  /** db_runner 强制一次性即时校验：当场握手，返回是否通过 */
  async verifyNow(): Promise<boolean> {
    const s = await this.refresh()
    return s.attested
  }

  start(intervalMs = DAY_MS): void {
    log('start', `interval=${intervalMs}ms`)
    // 启动期静默快速重试：WebUI 可能晚于 WeFlow 就绪（最多 6 次 × 5s）
    let quickTries = 0
    const quick = async () => {
      const s = await this.refresh()
      if (!s.attested && quickTries < 6) {
        quickTries++
        setTimeout(() => { void quick() }, 5000)
      }
    }
    void quick()
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.refresh() }, intervalMs)
    if (this.timer && typeof (this.timer as any).unref === 'function') (this.timer as any).unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

export const attestService = new AttestService()
