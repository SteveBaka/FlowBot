/**
 * cdnFetchService —— 图片入站 CDN 直取兜底（IMAGE-HD-DOWNLOAD-ANALYSIS §8.6 + POC-FINAL 契约）
 *
 * 职责：本地直读（_h > .dat > _t）与 HD 升级全失败、只剩缩略图时，驱动客户端 CDN 库
 * 下载并解密原图。四要素：① 登录态前置检测 ② 串行排队 ③ 产物校验 ④ 错误码降级映射。
 * 风控防护（2026-09-01 拍板）：仅增量消息（禁历史回填）、单 filekey 单次尝试、
 * 最小间隔 + 每小时上限限流、零 hook 纯主动调用（超时即放弃不重试）。
 *
 * 传输层（callHelper）：调用 ptrace 注入器二进制 `cdn_fetch`（resources/key/linux/x64/，
 * 与 xkey_helper 同款技法：毫秒级借线程远程调用 StartC2CDownload，零 hook 零 frida，
 * wechat md5 硬守卫绑定 RVA）。契约 `→ {"success","ret"}`；ret=0 受理后产物由微信
 * CDN 线程异步落盘 savePath（解密后明文）。二进制缺失/未安装时降级推缩略图。
 */
import { join } from 'path'
import { app } from 'electron'
import crypto from 'crypto'
import { existsSync, mkdirSync, statSync, readFileSync, openSync, readSync, closeSync, chmodSync, readdirSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

const execFileAsync = promisify(execFile)

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

/** §8.5 错误码 → 处置映射（PoC 补充：-32767 = CDN 子系统懒初始化未完成） */
export function mapCdnErrorCode(code?: number | null): CdnFetchDisposition {
  if (code === -21009) return 'retry_once'            // 同 filekey 会话内重复请求
  if (code === -32767) return 'retry_once'            // CDN 未初始化（新登录进程无媒体事件），首个媒体事件后自愈
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

  private isDiagMd5LogEnabled(): boolean {
    try {
      return this.configService.get('imageCdnDirectFetchDiagMd5Log') !== false
    } catch {
      return true
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

  /** 独一 savepath：<data>/cdn_fetch/<id>_<uuid>.img；顺带清理超 24h 的历史产物 */
  buildSavePath(id: string): string {
    const dir = join(this.getUserDataPath(), 'cdn_fetch')
    try {
      mkdirSync(dir, { recursive: true })
    } catch { /* fetch 内校验会兜底 */ }
    const safeId = String(id || 'img').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'img'
    return join(dir, `${safeId}_${crypto.randomUUID()}.img`)
  }

  /** 产物 TTL：推送消费方（token URL）取用后即无用，超 24h 删除防堆积 */
  private sweepExpiredProducts(): void {
    try {
      const dir = join(this.getUserDataPath(), 'cdn_fetch')
      if (!existsSync(dir)) return
      const cutoff = Date.now() - 24 * 3600 * 1000
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch { /* 下轮再清 */ }
      }
    } catch { /* 清理失败不影响主链路 */ }
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
      // retry_once（-32767 CDN 懒初始化 / -21009 重复请求）为瞬态：撤销台账，允许同 filekey 重试
      this.queue = run
        .then((res) => {
          if (res.disposition === 'retry_once') this.attemptedKeys.delete(req.fileKey)
          return res
        })
        .catch(() => undefined)
      this.sweepExpiredProducts()
      return await run
    } catch (e) {
      return { success: false, error: `fetch_exception:${String(e)}` }
    }
  }

  private async runFetch(req: CdnFetchRequest): Promise<CdnFetchResult> {
    const dispatched = await this.callHelper(req)
    if (!dispatched.success) {
      // 注入器自身失败（缺二进制/attach/写内存）——disposition 已由 callHelper 标注
      return { ...dispatched, disposition: dispatched.disposition ?? mapCdnErrorCode(dispatched.code) }
    }
    const ret = dispatched.code ?? -1
    if (ret !== 0) {
      // 要素④：门禁/参数错误码 → 降级映射（-32767 CDN 未初始化 / -21009 重复 / -21038 savepath 冲突…）
      return { success: false, error: `cdn_ret_${ret}`, code: ret, disposition: mapCdnErrorCode(ret) }
    }
    // ret=0 受理 → 产物由微信 CDN 线程异步落盘，轮询（500ms 间隔 / 超时上限）
    const ok = await this.waitForFile(req.fullPath, this.getTimeoutMs())
    if (!ok) {
      // 保守处置：超时不重试（避免对同一 filekey 反复请求）
      return { success: false, error: 'timeout', code: 0, disposition: 'permanent_thumb' }
    }
    const verify = this.verifyFetchedFile(req.fullPath, req.md5)
    if (!verify.ok) {
      return { success: false, error: verify.error || 'verify_failed', code: 0, disposition: 'impl_bug' }
    }
    return { success: true, localPath: req.fullPath, code: 0 }
  }

  /** 解析注入器二进制路径（仿 keyServiceLinux.getHelperPath 候选链）+ 运行时 chmod */
  private getHelperPath(): string | null {
    const candidates: string[] = []
    try {
      const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
      if (resourcesPath) {
        candidates.push(join(resourcesPath, 'resources', 'key', 'linux', 'x64', 'cdn_fetch'))
        candidates.push(join(resourcesPath, 'key', 'linux', 'x64', 'cdn_fetch'))
      }
    } catch { /* 非 Electron 环境 */ }
    try {
      candidates.push(join(app.getAppPath(), 'resources', 'key', 'linux', 'x64', 'cdn_fetch'))
    } catch { /* ignore */ }
    candidates.push(join(process.cwd(), 'resources', 'key', 'linux', 'x64', 'cdn_fetch'))
    for (const p of candidates) {
      if (existsSync(p)) {
        try { chmodSync(p, 0o755) } catch { /* 只读场景由部署层保证 */ }
        return p
      }
    }
    return null
  }

  /**
   * 传输层：调用 ptrace 注入器 `cdn_fetch`（零 hook，毫秒级借线程远程调用）。
   * 契约：`cdn_fetch <fileKey> <aesKey> <fileLen> <savePath> [taskname] → {"success","ret"}`
   * ret=0 受理（产物由微信 CDN 线程异步落盘 savePath，解密后明文）；负数为门禁/参数错误码。
   * 二进制缺失 → helper_not_installed（调用方降级缩略图，不阻断推送）。
   */
  private async callHelper(req: CdnFetchRequest): Promise<CdnFetchResult> {
    const bin = this.getHelperPath()
    if (!bin) return { success: false, error: 'helper_not_installed', disposition: 'permanent_thumb' }
    const taskname = `cdndirect_${Date.now()}_fetch`
    const args = [req.fileKey, req.aesKey, String(req.fileLen), req.fullPath, taskname]
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 64 * 1024 })
      const res = JSON.parse(String(stdout || '').trim())
      if (!res.success) {
        return { success: false, error: res.error || 'helper_failed', code: null, disposition: 'impl_bug' }
      }
      return { success: true, code: Number(res.ret) }
    } catch (e) {
      // 注入器把 JSON 错误打在 stdout（诊断日志走 stderr），execFile 拒绝时必须带上 stdout，否则无诊断信息
      const err = e as { stdout?: unknown }
      const so = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
      return { success: false, error: `helper_exec_failed:${String(e)}${so ? ` stdout=${so}` : ''}`, code: null, disposition: 'impl_bug' }
    }
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

  /** 要素③：产物校验——存在 + 非空 + 图片魔数（解密后明文）；diagMd5 仅诊断（XML md5 与
   * CDN 实存对象无关，PoC 实证：声称 26034B、实得 88873B 且内容正确），不参与判定；
   * 诊断日志经 imageCdnDirectFetchDiagMd5Log 开关控制（默认开，用户反馈问题时复现用） */
  verifyFetchedFile(fullPath: string, diagMd5?: string): { ok: boolean; error?: string } {
    try {
      if (!existsSync(fullPath)) return { ok: false, error: 'file_missing' }
      const stat = statSync(fullPath)
      if (stat.size <= 0) return { ok: false, error: 'file_empty' }
      const fd = openSync(fullPath, 'r')
      const head = Buffer.alloc(4)
      readSync(fd, head, 0, 4, 0)
      closeSync(fd)
      const hex = head.toString('hex')
      const isImage =
        hex.startsWith('ffd8') ||          // JPEG
        hex === '89504e47' ||              // PNG
        hex.startsWith('47494638') ||      // GIF87a/89a
        hex === '52494646' ||              // RIFF（WEBP 等）
        hex.startsWith('424d')             // BMP
      if (!isImage) return { ok: false, error: `bad_magic_${hex}` }
      if (diagMd5 && this.isDiagMd5LogEnabled()) {
        const actual = crypto.createHash('md5').update(readFileSync(fullPath)).digest('hex')
        if (actual.toLowerCase() !== String(diagMd5).toLowerCase()) {
          console.log(`[cdnFetch] 诊断：产物 md5 ${actual} 与消息声称 ${diagMd5} 不符（服务端对象与 XML 声称值无关，非失败）`)
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `verify_exception:${String(e)}` }
    }
  }
}

export const cdnFetchService = new CdnFetchService()
