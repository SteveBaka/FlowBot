/**
 * cdnFetchService —— 图片入站 CDN 直取兜底（IMAGE-HD-DOWNLOAD-ANALYSIS §8.6 定稿契约）
 *
 * 职责：本地直读（_h > .dat > _t）与 HD 升级全失败、只剩缩略图时，驱动客户端 CDN 库
 * 下载并解密原图。四要素：① 登录态前置检测 ② 串行排队 ③ 产物校验 ④ 错误码降级映射。
 * 风控防护（2026-09-01 拍板）：仅增量消息（禁历史回填）、单 filekey 单次尝试、
 * 最小间隔 + 每小时上限限流、零 hook 纯主动调用（超时即放弃不重试）。
 * 传输层（callHelper）是唯一 seam：Dev 侧 frida helper（cdn_probe15.js 模板 + cdn_fetch
 * 命令通道）交付后在此接入；当前返回 helper_not_available，调用方降级推缩略图。
 */
import { join } from 'path'
import { app } from 'electron'
import crypto from 'crypto'
import { existsSync, mkdirSync, statSync, readFileSync } from 'fs'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface CdnFetchRequest {
  /** cdnbigimgurl DER hex（ASN.1 filekey，非 URL） */
  fileKey: string
  /** img 属性 aeskey（32 hex） */
  aesKey: string
  /** 首期用 XML length（media_type=2 标准图档）；hdlength 属二期 */
  fileLen: number
  /** 独一 savepath（禁用 ImageTemp，防 -21038/寄生合并与消息层清理） */
  fullPath: string
  /** 可选：XML md5，用于产物校验 */
  md5?: string
  /** 消息 createTime（ms）；「仅增量」门禁依据，超龄消息永久降级缩略图（禁历史回填） */
  messageCreateTime?: number
}

export type CdnFetchDisposition = 'retry_once' | 'permanent_thumb' | 'impl_bug' | 'unknown'

export interface CdnFetchResult {
  success: boolean
  localPath?: string
  error?: string
  code?: number | null
  disposition?: CdnFetchDisposition
}

/** §8.5 错误码 → 处置映射 */
export function mapCdnErrorCode(code?: number | null): CdnFetchDisposition {
  if (code === -21009) return 'retry_once'            // 同 filekey 会话内重复请求
  if (code === -5103166 || code === 30001) return 'permanent_thumb' // CDN 对象过期/删除
  if (code === -21038 || code === -20003) return 'impl_bug'         // savepath 冲突 / 参数缺失
  return 'unknown'
}

export class CdnFetchService {
  private configService = ConfigService.getInstance()
  /** 要素②：StartC2CDownload 多线程并发未验证，全请求经此 promise 链串行化 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 风控防护（2026-09-01 拍板）：filekey 单次尝试台账（6h 内不重复请求，防请求风暴） */
  private attemptedKeys = new Map<string, number>()
  /** 风控防护：每小时抓取时间戳滑动窗口（张数上限） */
  private hourlyStamps: number[] = []
  /** 风控防护：上次发起抓取的时刻（最小间隔） */
  private lastFetchAt = 0

  isEnabled(): boolean {
    try {
      return this.configService.get('imageCdnDirectFetchEnabled') === true
    } catch {
      return false
    }
  }

  private getTimeoutMs(): number {
    try {
      const v = Number(this.configService.get('imageCdnDirectFetchTimeoutMs'))
      return Number.isFinite(v) && v >= 5000 ? v : 30000
    } catch {
      return 30000
    }
  }

  private getMinIntervalMs(): number {
    try {
      const v = Number(this.configService.get('imageCdnDirectFetchMinIntervalMs'))
      return Number.isFinite(v) && v >= 0 ? Math.min(v, 60000) : 3000
    } catch {
      return 3000
    }
  }

  private getHourlyLimit(): number {
    try {
      const v = Number(this.configService.get('imageCdnDirectFetchHourlyLimit'))
      return Number.isFinite(v) && v >= 1 ? Math.min(v, 600) : 30
    } catch {
      return 30
    }
  }

  private getMaxAgeMs(): number {
    try {
      const v = Number(this.configService.get('imageCdnDirectFetchMaxAgeMs'))
      return Number.isFinite(v) && v > 0 ? Math.min(v, 3600000) : 600000
    } catch {
      return 600000
    }
  }

  /** 风控防护门禁：仅增量消息 + 单 filekey 单次 + 最小间隔 + 每小时上限；任一不过即降级缩略图（不排队、不阻塞推送） */
  private checkGuards(req: CdnFetchRequest): { ok: true } | { ok: false; error: string; disposition: CdnFetchDisposition } {
    const now = Date.now()
    // 仅增量：超龄消息永久降级（禁止历史批量回填）
    const created = Number(req.messageCreateTime || 0)
    if (created > 0 && now - created > this.getMaxAgeMs()) {
      return { ok: false, error: 'too_old', disposition: 'permanent_thumb' }
    }
    // 单 filekey 台账：6h 内不二次请求
    const prev = this.attemptedKeys.get(req.fileKey)
    if (prev && now - prev < 21600000) {
      return { ok: false, error: 'already_attempted', disposition: 'permanent_thumb' }
    }
    // 最小间隔
    if (this.lastFetchAt > 0 && now - this.lastFetchAt < this.getMinIntervalMs()) {
      return { ok: false, error: 'rate_limited', disposition: 'permanent_thumb' }
    }
    // 每小时滑动窗口上限
    this.hourlyStamps = this.hourlyStamps.filter((t) => now - t < 3600000)
    if (this.hourlyStamps.length >= this.getHourlyLimit()) {
      return { ok: false, error: 'hourly_limit', disposition: 'permanent_thumb' }
    }
    return { ok: true }
  }

  private recordAttempt(fileKey: string): void {
    const now = Date.now()
    this.attemptedKeys.set(fileKey, now)
    this.hourlyStamps.push(now)
    this.lastFetchAt = now
    // 台账防泄漏：仅保留 6h 内记录
    if (this.attemptedKeys.size > 500) {
      for (const [k, t] of this.attemptedKeys) {
        if (now - t >= 21600000) this.attemptedKeys.delete(k)
      }
    }
  }

  private getElectronPath(name: 'userData' | 'temp'): string | null {
    try {
      const getter = (app as unknown as { getPath?: (n: string) => string } | undefined)?.getPath
      if (typeof getter !== 'function') return null
      const value = getter(name)
      return typeof value === 'string' && value.trim() ? value : null
    } catch {
      return null
    }
  }

  private getUserDataPath(): string {
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    if (workerUserDataPath) return workerUserDataPath
    return this.getElectronPath('userData') || process.cwd()
  }

  /** 独一 savepath：<data>/cdn_fetch/<id>_<uuid>.img */
  buildSavePath(id: string): string {
    const dir = join(this.getUserDataPath(), 'cdn_fetch')
    try {
      mkdirSync(dir, { recursive: true })
    } catch { /* fetch 内校验会兜底 */ }
    const safeId = String(id || 'img').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'img'
    return join(dir, `${safeId}_${crypto.randomUUID()}.img`)
  }

  /** 兜底入口：调用方保证仅在本地只剩缩略图时触发；任何失败都降级，不抛出 */
  async fetch(req: CdnFetchRequest): Promise<CdnFetchResult> {
    try {
      if (!this.isEnabled()) return { success: false, error: 'disabled' }
      // 要素①：登录态代理——cdn_manager 未初始化时 StartC2CDownload 走门禁，直接降级
      if (!wcdbService.isReady()) return { success: false, error: 'not_ready' }
      if (!req?.fileKey || !req?.aesKey || !(req.fileLen > 0)) {
        return { success: false, error: 'bad_request', disposition: 'impl_bug' }
      }
      // 风控防护门禁（用户拍板 2026-09-01）：仅增量 + 单 filekey 单次 + 限流；不过即降级
      const guard = this.checkGuards(req)
      if (!guard.ok) return { success: false, error: guard.error, disposition: guard.disposition }
      this.recordAttempt(req.fileKey)
      const run = this.queue.then(() => this.runFetch(req))
      // 队列容错：单个失败不阻断后续请求
      this.queue = run.catch(() => undefined)
      return await run
    } catch (e) {
      return { success: false, error: `fetch_exception:${String(e)}` }
    }
  }

  private async runFetch(req: CdnFetchRequest): Promise<CdnFetchResult> {
    const dispatched = await this.callHelper(req)
    if (!dispatched.success && dispatched.error === 'helper_not_available') return dispatched

    if (dispatched.success) {
      // 传输层已受理（code=0）→ 轮询产物落盘（500ms 间隔 / 超时上限）
      const ok = await this.waitForFile(req.fullPath, this.getTimeoutMs())
      if (!ok) {
        // 保守处置：超时不重试（零 hook 下终结错误码不可见，避免对同一 filekey 反复请求）
        return { success: false, error: 'timeout', code: dispatched.code ?? null, disposition: 'permanent_thumb' }
      }
      const verify = this.verifyFetchedFile(req.fullPath, req.md5)
      if (!verify.ok) {
        return { success: false, error: verify.error || 'verify_failed', code: dispatched.code ?? null, disposition: 'impl_bug' }
      }
      return { success: true, localPath: req.fullPath, code: dispatched.code ?? null }
    }
    // 要素④：helper 返回业务错误码 → 降级映射
    return { ...dispatched, disposition: mapCdnErrorCode(dispatched.code) }
  }

  /**
   * ★ 传输 seam（唯一待实现点）：Dev 侧常驻 frida helper 交付后在此接入。
   * 契约：fetch(fileKey, aesKey, fileLen, fullPath) → code（0=受理；负数为创建级错误码）。
   * ⚠️ 风控约束（2026-09-01 拍板）：helper **零 hook** —— 仅 NativeFunction 主动调用 +
   * 读取可见参数，禁止 Interceptor.attach / 任何代码修改；任务终结错误码不可见，
   * 成败以「落盘轮询 + md5 校验」为准，超时即放弃（不重试）。
   */
  private async callHelper(_req: CdnFetchRequest): Promise<CdnFetchResult> {
    return { success: false, error: 'helper_not_available', code: null }
  }

  /** 轮询产物落盘：文件出现且尺寸稳定（两次采样一致）视为就绪 */
  private async waitForFile(fullPath: string, timeoutMs: number): Promise<boolean> {
    const intervalMs = 500
    const deadline = Date.now() + Math.max(5000, timeoutMs)
    let lastSize = -1
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs))
      try {
        if (existsSync(fullPath)) {
          const size = statSync(fullPath).size
          if (size > 0 && size === lastSize) return true
          lastSize = size
        } else {
          lastSize = -1
        }
      } catch { lastSize = -1 }
    }
    return false
  }

  /** 要素③：产物校验——存在 + 非空 +（可选）md5 比对；产物为解密后明文，可直接 file 头校验 */
  verifyFetchedFile(fullPath: string, expectedMd5?: string): { ok: boolean; error?: string } {
    try {
      if (!existsSync(fullPath)) return { ok: false, error: 'file_missing' }
      const stat = statSync(fullPath)
      if (stat.size <= 0) return { ok: false, error: 'file_empty' }
      if (expectedMd5) {
        const actual = crypto.createHash('md5').update(readFileSync(fullPath)).digest('hex')
        if (actual.toLowerCase() !== String(expectedMd5).toLowerCase()) {
          return { ok: false, error: 'md5_mismatch' }
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `verify_exception:${String(e)}` }
    }
  }
}

export const cdnFetchService = new CdnFetchService()
