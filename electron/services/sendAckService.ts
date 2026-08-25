/**
 * sendAckService — 媒体发送回执（SendAck）兜底模块
 *
 * 定位（IMAGE-SEND-ACK-FALLBACK.md）：
 * 图片/视频发送（GUI 自动化 xdotool 粘贴 + Enter）后，用 WCDB 回执确认是否真正发出，
 * 未确认则触发兜底动作（二次 Enter，不清空），确保媒体能正常发送出去。
 *
 * 设计要点：
 * - 事件监听为主（chatService.addDbMonitorListener，~2.5s 确认）+ 500ms 轮询降级双通道；
 * - 指纹匹配：sessionId + kind + 时间窗（createTime >= t0-2s，对齐查询窗口），imageDatName/md5 作旁证；
 * - 状态机：submitted（isSend=1，主判据）→ acked（serverId≠0，异步补充）→ ack_timeout（兜底）；
 * - 兜底动作：二次 Enter（不清空）+ 防误发保护（探针"输入框已空则转扩展等待"）；
 * - 超时/重试配置按 kind 分化（sendAck*Image* / sendAck*Video*），视频转码更慢、默认超时更长。
 *
 * 不 import linux.ts（避免循环依赖）；通过参数接收 getNewMessages / addDbMonitorListener 回调。
 */

import { ConfigService } from './config'

/** 回查窗口（秒）：Enter 往前看多久。与 messagePushService 的 lookbackSeconds=2 对齐。
 *  微信写库时间戳可能比 Enter 早 0~2s（实测视频写库早于 GUI 响应），查询与过滤统一用它，避免误过滤。 */
const LOOKBACK_S = 2

export interface SendAckFingerprint {
  sessionId: string          // wxid（群聊为 xxx@chatroom）
  kind: 'text' | 'image' | 'video' | 'file'
  t0: number                 // Enter 按下时刻（Date.now()）
  imageDatName?: string      // 源图片 dat 名（WCDB packed_info 里的 32 位 hex，旁证，图片专用）
  sourceMd5?: string         // 源文件 md5（旁证，非主键；视频大文件不计算，跳过）
  clientTag?: string         // 可选：队列消息 id，防并发误配
  sizeMb?: number            // 媒体体积（MB）：>0 时超时按体积自适应加档（sendAckTimeoutPerMbMs）
}

export type SendAckStatus = 'submitted' | 'acked' | 'ack_timeout' | 'extended_timeout' | 'skipped' | 'error'

export interface SendAckResult {
  success: boolean
  status: SendAckStatus
  serverId?: number
  serverIdRaw?: string
  localType?: number
  messageId?: string
  error?: string
  waitedMs: number
}

export interface SendAckDeps {
  /** 查询指定时间之后的新消息（chatService.getNewMessages） */
  getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{ success: boolean; messages?: any[]; error?: string }>
  /** 注册 dbMonitor 监听（chatService.addDbMonitorListener），返回取消函数 */
  addDbMonitorListener?: (listener: (type: string, json: string) => void) => () => void
  /** 二次 Enter 兜底执行器（由 linux.ts 注入，避免循环依赖） */
  doReEnter?: () => Promise<boolean>
  /** 输入框探针：媒体是否仍在输入框。true=仍在（可放心 Enter）；false=已离开（疑似已发出，禁止 Enter）；undefined=探针不可用（保守 Enter） */
  probeImageInInput?: () => Promise<boolean | undefined>
}

const log = (msg: string) => console.log(`[SendAck] ${msg}`)
const warn = (msg: string) => console.warn(`[SendAck] ${msg}`)

/** kind → 中文标签（日志/报错用） */
function kindLabel(kind: string): string {
  if (kind === 'video') return '视频'
  if (kind === 'image') return '图片'
  if (kind === 'text') return '文本'
  return kind
}

/** 判断本地类型是否为图片（兼容高位 flag 变体，localType & 0xFF = 3） */
function isImageLocalType(localType: number | string | null | undefined): boolean {
  if (localType === null || localType === undefined) return false
  const n = Number(localType)
  if (!Number.isFinite(n)) return false
  return (n & 0xFF) === 3
}

/** 判断本地类型是否为视频（localType & 0xFF = 43，微信视频唯一类型；49 是文件/链接，不算） */
function isVideoLocalType(localType: number | string | null | undefined): boolean {
  if (localType === null || localType === undefined) return false
  const n = Number(localType)
  if (!Number.isFinite(n)) return false
  return (n & 0xFF) === 43
}

export class SendAckService {
  private deps: SendAckDeps
  private unlisten: (() => void) | null = null

  constructor(deps: SendAckDeps) {
    this.deps = deps
  }

  private cfg<K extends string>(key: K): any {
    try {
      return ConfigService.getInstance().get(key as any)
    } catch {
      return undefined
    }
  }

  private cfgBool(key: string, def: boolean): boolean {
    const v = this.cfg(key)
    return typeof v === 'boolean' ? v : def
  }

  private cfgNum(key: string, def: number): number {
    const v = this.cfg(key)
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def
  }

  /** 是否启用回执（总开关） */
  isEnabled(): boolean {
    return this.cfgBool('sendAckEnabled', true)
  }

  /**
   * 等待媒体发送回执（主入口）。
   * 在 doSend 返回成功后调用；resolve 前阻塞队列（期望行为，防顶走卡框媒体）。
   * 超时/重试配置按 fp.kind 分化：图片 sendAck*Image*，视频 sendAck*Video*。
   */
  async waitForAck(fp: SendAckFingerprint): Promise<SendAckResult> {
    const t0 = Date.now()
    if (!this.isEnabled()) {
      return { success: true, status: 'skipped', waitedMs: 0 }
    }
    if (!fp.sessionId) {
      // wxid 缺失：回执自动跳过（行为=现状）
      return { success: true, status: 'skipped', waitedMs: Date.now() - t0 }
    }

    const isVideo = fp.kind === 'video'
    // 超时：kind 基准 + 体积自适应（大图/大视频微信压缩处理更久，Enter→落库延迟随体积增长）
    const baseTimeout = isVideo ? this.cfgNum('sendAckTimeoutMsVideo', 10000) : this.cfgNum('sendAckTimeoutMsImage', 5000)
    const timeoutMs = this.computeTimeout(baseTimeout, fp.sizeMb)
    if (timeoutMs !== baseTimeout) {
      log(`超时按体积自适应: ${baseTimeout} → ${timeoutMs}ms (sizeMb=${fp.sizeMb?.toFixed(2)})`)
    }
    const pollInterval = this.cfgNum('sendAckPollIntervalMs', 500)
    const useEvent = this.cfgBool('sendAckUseEventMonitor', true)

    // 首次立即查一次（小图可能已落库）
    const first = await this.queryAck(fp)
    if (first.matched) {
      return this.finish(first, Date.now() - t0, fp)
    }

    // 事件监听通道（主）：message 表变更 → 立即查
    let eventResolved = false
    const onEvent = async () => {
      if (eventResolved) return
      const r = await this.queryAck(fp)
      if (r.matched) {
        eventResolved = true
        // 触发时通过 resolveAck 回调通知；waitForAck 的循环也会看到
      }
    }

    let unlisten: (() => void) | null = null
    if (useEvent && this.deps.addDbMonitorListener) {
      try {
        unlisten = this.deps.addDbMonitorListener((type, json) => {
          // 只对 message 表变更响应；避免身份表（contact/chatroom）误触发
          const t = String(type || '').toLowerCase()
          if (t.includes('message') || (json && String(json).includes('message'))) {
            void onEvent()
          }
        })
        this.unlisten = unlisten
      } catch (e) {
        warn(`dbMonitor 注册失败，降级纯轮询: ${String(e)}`)
      }
    }

    // 轮询降级通道（次）：事件未触发时兜底
    const deadline = Date.now() + timeoutMs
    let last: { matched: boolean; row?: any } = { matched: false }

    try {
      while (Date.now() < deadline) {
        const r = await this.queryAck(fp)
        if (r.matched) {
          last = r
          break
        }
        // 事件已命中（回调里设置了 eventResolved），提前结束
        if (eventResolved) {
          last = await this.queryAck(fp)
          break
        }
        await new Promise((r2) => setTimeout(r2, pollInterval))
      }
    } finally {
      if (unlisten) {
        try { unlisten() } catch {}
      }
      this.unlisten = null
    }

    const waitedMs = Date.now() - t0
    if (last.matched) {
      return this.finish(last, waitedMs, fp)
    }

    // 超时未确认 → 兜底动作（§五）
    return this.handleTimeout(fp, timeoutMs, waitedMs)
  }

  /** 超时按体积自适应：base + 每超出 1MB 加 sendAckTimeoutPerMbMs（默认 800ms/MB），封顶 sendAckTimeoutMaxMs（默认 20000） */
  private computeTimeout(base: number, sizeMb?: number): number {
    const perMb = this.cfgNum('sendAckTimeoutPerMbMs', 800)
    if (!sizeMb || sizeMb <= 1 || perMb <= 0) return base
    const maxMs = this.cfgNum('sendAckTimeoutMaxMs', 20000)
    const total = base + Math.ceil(sizeMb - 1) * perMb
    return Math.min(total, Math.max(base, maxMs))
  }

  /** 查询一次回执 */
  private async queryAck(fp: SendAckFingerprint): Promise<{ matched: boolean; row?: any }> {
    try {
      // 回查窗口：t0 往前 2s（对齐 lookbackSeconds=2）。
      // 注意：微信写库时间戳可能比 Enter（t0）早 0~2s（实测视频写库早于 GUI 响应），
      // 因此逐行过滤的下界必须与查询窗口一致（同用 LOOKBACK_S），否则会误过滤已落库的行。
      const minCreateTime = Math.max(0, Math.floor(fp.t0 / 1000) - LOOKBACK_S)
      const res = await this.deps.getNewMessages(fp.sessionId, minCreateTime, 1000)
      if (!res.success || !Array.isArray(res.messages)) {
        return { matched: false }
      }
      // 收集所有匹配候选，选 createTime 与 t0 绝对差最小的行。
      // 同会话连发同类媒体时窗口内可能有多条匹配（getNewMessages 按时间线排序），
      // "最近落库的才是本条"——clientTag 语义落地为最近时间差，避免误配到前一条。
      let best: { matched: boolean; row?: any; diff: number } = { matched: false, diff: Infinity }
      for (const msg of res.messages) {
        const isSend = msg.isSend
        if (isSend !== 1) continue
        const localType = msg.localType
        // 按 kind 匹配 localType（兼容高位 flag 变体：& 0xFF）
        if (fp.kind === 'image') {
          if (!isImageLocalType(localType)) continue
        } else if (fp.kind === 'video') {
          if (!isVideoLocalType(localType)) continue
        } else if (fp.kind === 'text') {
          if ((Number(localType) & 0xFF) !== 1) continue
        }
        const createTime = Number(msg.createTime || 0)
        if (createTime < minCreateTime) continue
        // 旁证：imageDatName/md5（可选，不强制——微信会重编码图片，md5 会变）
        if (fp.imageDatName && msg.imageDatName && msg.imageDatName !== fp.imageDatName) continue
        const diff = Math.abs(createTime - Math.floor(fp.t0 / 1000))
        if (!best.matched || diff < best.diff) {
          best = { matched: true, row: msg, diff }
        }
      }
      return best.matched ? { matched: true, row: best.row } : { matched: false }
    } catch (e) {
      warn(`queryAck 异常: ${String(e)}`)
      return { matched: false }
    }
  }

  /** 命中后组装结果 */
  private finish(match: { matched: boolean; row?: any }, waitedMs: number, fp?: SendAckFingerprint): SendAckResult {
    const row = match.row || {}
    const serverIdRaw = String(row.serverIdRaw || row.serverId || '')
    const serverId = Number(row.serverId || 0)
    const requireServerId = this.cfgBool('sendAckRequireServerId', false)

    if (requireServerId && (!serverIdRaw || serverIdRaw === '0')) {
      // 严格模式：serverId=0 不算成功 → 继续等（但这里只在首次匹配时被调用；严格模式交给调用方处理）
      log(`回执命中(submitted): session=${fp?.sessionId} kind=${fp?.kind} serverId=0（requireServerId 严格模式，等待 serverId） waitedMs=${waitedMs}ms`)
      return {
        success: true,
        status: 'submitted',
        serverId: serverId || undefined,
        serverIdRaw: serverIdRaw || undefined,
        localType: row.localType,
        messageId: serverIdRaw && serverIdRaw !== '0' ? serverIdRaw : `local_${Date.now()}`,
        waitedMs
      }
    }

    const hasServerId = serverIdRaw && serverIdRaw !== '0'
    const status = hasServerId ? 'acked' : 'submitted'
    log(`回执命中(${status}): session=${fp?.sessionId} kind=${fp?.kind} localType=${row.localType} serverId=${serverIdRaw || '0'} waitedMs=${waitedMs}ms`)
    return {
      success: true,
      status,
      serverId: serverId || undefined,
      serverIdRaw: serverIdRaw || undefined,
      localType: row.localType,
      messageId: hasServerId ? serverIdRaw : `local_${Date.now()}`,
      waitedMs
    }
  }

  /** 超时兜底：二次 Enter（不清空）或扩展等待或失败 */
  private async handleTimeout(fp: SendAckFingerprint, timeoutMs: number, waitedMs: number): Promise<SendAckResult> {
    const retryAction = String(this.cfg('sendAckRetryAction') || 're-enter')
    const isVideo = fp.kind === 'video'
    const failOnTimeout = isVideo ? this.cfgBool('sendAckVideoFailOnTimeout', true) : this.cfgBool('sendAckImageFailOnTimeout', true)
    const maxRetries = Math.max(0, Math.floor(isVideo ? this.cfgNum('sendAckVideoMaxRetries', 1) : this.cfgNum('sendAckImageMaxRetries', 1)))
    const extendWait = this.cfgNum('sendAckExtendWaitMs', 10000)
    const probeEnabled = this.cfgBool('sendAckInputClearProbeEnabled', false)
    const label = kindLabel(fp.kind)

    // 探针可用时：区分"媒体已离开输入框"（疑似已发出，WCDB 延迟）vs "媒体仍在"（卡框）
    const probeAvailable = probeEnabled && typeof this.deps.probeImageInInput === 'function'
    if (probeAvailable) {
      const inInput = await this.deps.probeImageInInput!()
      if (inInput === undefined) {
        log('输入框探针不可用（抓屏失败/被遮挡），退回保守处理')
      } else if (!inInput) {
        // 媒体已离开输入框 → 疑似已发出 → 扩展等待再查一次（绝不 Enter，防误发）
        warn(`超时未确认但输入框已清空（疑似已发出，WCDB 延迟），扩展等待 ${extendWait}ms`)
        await new Promise((r) => setTimeout(r, extendWait))
        const retry = await this.queryAck(fp)
        if (retry.matched) {
          return this.finish(retry, waitedMs + extendWait, fp)
        }
        if (!failOnTimeout) {
          return { success: true, status: 'extended_timeout', waitedMs: waitedMs + extendWait, error: 'ACK 超时但疑似已发出（输入框已清空）' }
        }
        // failOnTimeout=true：输入框已空时 Enter 无意义（无内容可发）也不安全，直接按超时失败告警
        warn(`扩展等待后仍未确认且输入框已空，不执行二次 Enter（无内容可发）`)
        return { success: false, status: 'ack_timeout', waitedMs: waitedMs + extendWait, error: `${label}发送超时未确认，输入框已清空（疑似已发出但未落库）` }
      }
      log('探针判定媒体仍在输入框（卡框），进入兜底动作')
    }

    if (retryAction === 'none' || maxRetries <= 0) {
      if (!failOnTimeout) {
        return { success: true, status: 'ack_timeout', waitedMs, error: 'ACK 超时（未重发）' }
      }
      return { success: false, status: 'ack_timeout', waitedMs, error: `${label}发送 ${waitedMs}ms 未获得 WCDB 回执（sendAckRetryAction=${retryAction}）` }
    }

    // 二次 Enter 兜底（re-enter）——用户决策：不清空直接再 Enter
    if (retryAction === 're-enter' && this.deps.doReEnter) {
      // 防误发保护（§5.2 步骤 2）：每次 Enter 前探输入框——已空则绝不 Enter（会把用户残留内容误发）
      if (probeAvailable && this.deps.probeImageInInput) {
        const still = await this.deps.probeImageInInput()
        if (still === undefined) {
          log('二次 Enter 前探针不可用，保守 Enter')
        } else if (!still) {
          warn('二次 Enter 前探针判定输入框已空，放弃 Enter（防误发残留内容），转扩展等待')
          await new Promise((r) => setTimeout(r, extendWait))
          const retry = await this.queryAck(fp)
          if (retry.matched) {
            return this.finish(retry, waitedMs + extendWait, fp)
          }
          return { success: true, status: 'extended_timeout', waitedMs: waitedMs + extendWait, error: 'ACK 超时但输入框已空（疑似已发出，已阻止二次 Enter）' }
        }
      }
      let attempts = 0
      while (attempts <= maxRetries) {
        attempts++
        warn(`二次 Enter 兜底（attempt ${attempts}/${maxRetries + 1}，不清空）`)
        let ok = false
        try {
          ok = await this.deps.doReEnter()
        } catch (e) {
          warn(`二次 Enter 执行异常: ${String(e)}`)
        }
        if (!ok) break

        // 再次回执确认（新 t0 由调用方二次 Enter 时更新；这里复用 fp 但放宽时间窗）
        const deadline = Date.now() + timeoutMs
        let reAck: { matched: boolean; row?: any } = { matched: false }
        while (Date.now() < deadline) {
          reAck = await this.queryAck({ ...fp, t0: Date.now() - 2000 })
          if (reAck.matched) break
          await new Promise((r) => setTimeout(r, this.cfgNum('sendAckPollIntervalMs', 500)))
        }
        if (reAck.matched) {
          return this.finish(reAck, Date.now() - fp.t0, fp)
        }
      }
      warn(`二次 Enter ${attempts} 次均未获得 WCDB 回执，可能卡框或微信异常`)
      return { success: false, status: 'ack_timeout', waitedMs: Date.now() - fp.t0, error: `${label}发送 ${attempts} 次均未获得 WCDB 回执，可能卡框或微信异常` }
    }

    // clear-repaste：清空重贴（旧方案，文档标注不推荐）
    if (retryAction === 'clear-repaste' && this.deps.doReEnter) {
      warn('clear-repaste 为旧方案，已弃用（低性能设备可能再次超时导致残留），请改用 re-enter')
      // 退化：按 failOnTimeout 处理
      if (!failOnTimeout) return { success: true, status: 'ack_timeout', waitedMs, error: 'ACK 超时（clear-repaste 已弃用）' }
      return { success: false, status: 'ack_timeout', waitedMs, error: 'ACK 超时（clear-repaste 已弃用）' }
    }

    // 未知动作
    return { success: false, status: 'error', waitedMs, error: `未知 sendAckRetryAction: ${retryAction}` }
  }
}
