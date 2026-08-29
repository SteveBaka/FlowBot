import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import type { IPlatformSender } from '../enhancedMessageSender'
import type { SendMode, SendTask, SendProgress } from './types'
import { ConfigService } from '../../services/config'
import { SendAckService, type SendAckFingerprint, type SendAckResult } from '../../services/sendAckService'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const log = (msg: string) => console.log(`[LinuxSender] ${msg}`)
const warn = (msg: string) => console.warn(`[LinuxSender] ${msg}`)

const WECHAT_WINDOW_NAMES = ['Weixin', 'WeChat', 'wechat', '微信', 'WeChatAppEx', 'WMPF']

const DISPLAY_ENV = { ...process.env, DISPLAY: process.env.DISPLAY || ':99', PATH: '/usr/bin:/usr/sbin:/bin:/sbin:/usr/local/bin:' + (process.env.PATH || '') }

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500
const RETRY_BACKOFF_MAX_MS = 6000
const INTER_MESSAGE_DELAY_MS = 800
const POST_SEND_SETTLE_MS = 500
const INPUT_CLICK_DELAY_MS = 200

// 图片粘贴防冻结：仅 >5MB 拒绝粘贴；失败熔断 30s
const MAX_PASTE_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_PASTE_COOLDOWN_MS = 30 * 1000

// ─── 自适应背压（P1-L2）──────────────────────────────────────────────
const CONSECUTIVE_FAILURE_THRESHOLD = 3   // 连续失败 ≥3 次 → 队列冷却 10s + 自动降档（默认值，可配置）
const QUEUE_COOLDOWN_MS = 10 * 1000        // 队列冷却时长（默认值，可配置）
// ─── L2 动态缩间隔（sendDynamicInterval，默认关闭）─────────────────────
const DYNAMIC_INTERVAL_STEP_MS = 50        // 每连续成功 1 条缩短的间隔（ms）
const DYNAMIC_INTERVAL_MIN_MS = 300        // 动态缩短下限保护

// ─── 发送延时档位（safe / standard / aggressive）───────────────────────────────
type DelayMode = 'safe' | 'standard' | 'aggressive'

interface DelayProfile {
  interMessage: number
  searchOpen: number
  searchSettle: number
  selectSettle: number
  focusMove: number
  inputClick: number
  textClipSettle: number
  pasteSettle: number
  imageClipSettle: number
  imagePasteSettle: number
  postSendSettle: number
}

const DELAY_PROFILES: Record<DelayMode, DelayProfile> = {
  safe: {
    interMessage: 800, searchOpen: 400, searchSettle: 600, selectSettle: 400,
    focusMove: 80, inputClick: 200, textClipSettle: 100, pasteSettle: 300,
    imageClipSettle: 200, imagePasteSettle: 500, postSendSettle: 500
  },
  standard: {
    interMessage: 800, searchOpen: 200, searchSettle: 350, selectSettle: 250,
    focusMove: 80, inputClick: 150, textClipSettle: 100, pasteSettle: 200,
    imageClipSettle: 200, imagePasteSettle: 400, postSendSettle: 500
  },
  aggressive: {
    interMessage: 500, searchOpen: 120, searchSettle: 200, selectSettle: 150,
    focusMove: 50, inputClick: 90, textClipSettle: 60, pasteSettle: 120,
    imageClipSettle: 120, imagePasteSettle: 400, postSendSettle: 300
  }
}

/** 延时档位来源：仅 WebUI 配置（config.sendDelayMode），默认 standard */
function getDelayMode(): DelayMode {
  try {
    const cfgMode = String(ConfigService.getInstance().get('sendDelayMode') || '').trim().toLowerCase()
    if (cfgMode === 'safe' || cfgMode === 'standard' || cfgMode === 'aggressive') return cfgMode
  } catch {}
  return 'standard'
}

/** 读取 WebUI 自定义延时覆盖（config.sendDelayCustom，单位 ms） */
function getDelayCustomOverrides(): Record<string, number> {
  try {
    const raw = ConfigService.getInstance().get('sendDelayCustom')
    if (raw && typeof raw === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 0) out[k] = n
      }
      return out
    }
  } catch {}
  return {}
}

/** 计算生效延时档位：预设档位 + 自定义覆盖 */
function resolveDelayProfile(mode: DelayMode): DelayProfile {
  return { ...DELAY_PROFILES[mode] || DELAY_PROFILES.standard, ...getDelayCustomOverrides() }
}

/** 队列优化开关（WebUI 配置，独立控制） */
function isQueueOptionEnabled(key: 'sendMerge' | 'sendDedup' | 'sendPriority'): boolean {
  try {
    return ConfigService.getInstance().get(key) === true
  } catch {
    return false
  }
}

/** 自适应背压总开关（默认关闭） */
function isBackpressureEnabled(): boolean {
  try {
    return ConfigService.getInstance().get('sendBackpressureEnabled') === true
  } catch {
    return false
  }
}

/** L2 动态缩间隔开关（默认关闭） */
function isDynamicIntervalEnabled(): boolean {
  try {
    return ConfigService.getInstance().get('sendDynamicInterval') === true
  } catch {
    return false
  }
}

/** 读取数值配置（非法/缺失回退默认值） */
function getConfigNumber(key: string, def: number): number {
  try {
    const v = ConfigService.getInstance().get(key as any)
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  } catch {}
  return def
}

// ─── 拼音缓存：避免每次中文名起子进程（python3 /opt/pinyin.py）──────────────────
const pinyinCache = new Map<string, string>()
let pinyinCacheFile = ''

function resolvePinyinCacheFile(): string {
  if (pinyinCacheFile) return pinyinCacheFile
  try {
    pinyinCacheFile = require('path').join(ConfigService.getInstance().getCacheBasePath(), 'pinyin-cache.json')
  } catch { pinyinCacheFile = '' }
  return pinyinCacheFile
}

function persistPinyinCache(): void {
  const file = resolvePinyinCacheFile()
  if (!file) return
  try {
    const fs = require('fs')
    const dir = require('path').dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(pinyinCache)))
  } catch {}
}

function loadPinyinCache(): void {
  const file = resolvePinyinCacheFile()
  if (!file) return
  try {
    const fs = require('fs')
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'string') pinyinCache.set(k, v)
        }
      }
    }
  } catch {}
}

interface QueuedMessage {
  id: string
  content: string
  contactName: string
  imagePath?: string
  videoPath?: string
  atMentions?: Array<{ wxid: string; name: string }>
  sessionId?: string          // wxid（回执查询用；群聊为 xxx@chatroom）
  resolve: (result: { success: boolean; error?: string; method: string; ack?: string; serverId?: number; messageId?: string }) => void
  retries: number
  createdAt: number
}

async function run(cmd: string, timeout = 5000): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`PATH=/usr/bin:/usr/sbin:/bin:/sbin:/usr/local/bin ${cmd}`, { timeout, env: DISPLAY_ENV })
    if (stderr && stderr.trim()) warn(`run stderr: ${stderr.trim().substring(0, 300)}`)
    return stdout.trim()
  } catch (e: any) {
    warn(`run FAILED: ${cmd}`)
    warn(`  error: ${e.message?.substring(0, 300)}`)
    if (e.stderr) warn(`  stderr: ${e.stderr?.substring(0, 300)}`)
    return ''
  }
}

/**
 * 输入框探针（SendAck 防误发辅助，IMAGE-SEND-ACK-FALLBACK.md §5.3）：
 * 用 xwd 抓取指定窗口的像素，比对输入框 ROI 区域与基线是否一致。
 * 基线=粘贴完成后、Enter 前抓取（媒体卡片必在框内）；超时时再抓一次——
 * 相同 → 媒体仍在（卡框）；不同 → 已被微信取走（疑似已发出）。绝不靠几何/光标信号。
 * X11 xwd 格式：大端头 25×u32，BGRX 每像素 4 字节，bytes_per_line 可能 > width×4（对齐）。
 */

interface XwdImage {
  width: number
  height: number
  bytesPerLine: number
  data: Buffer
  dataStart: number
}

function parseXwd(buffer: Buffer): XwdImage | null {
  try {
    if (buffer.length < 100) return null
    // 头 25 个 u32（大端）：header_size, version, format, depth, width, height, xoffset, byte_order,
    // bitmap_unit, bitmap_bit_order, bitmap_pad, bits_per_pixel, bytes_per_line, visual_class, ...
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    const bytesPerLine = buffer.readUInt32BE(48)
    const headerSize = buffer.readUInt32BE(0)
    const ncolors = buffer.readUInt32BE(76)
    if (width <= 0 || height <= 0 || bytesPerLine <= 0) return null
    const dataStart = headerSize + ncolors * 12
    const expected = dataStart + bytesPerLine * height
    if (expected > buffer.length) return null
    return { width, height, bytesPerLine, data: buffer, dataStart }
  } catch {
    return null
  }
}

/** 抓取窗口像素（xwd，execFile 直取二进制 Buffer）。返回 null 表示不可用（工具缺失/窗口不可见）。 */
async function captureWindowXwd(wid: string): Promise<XwdImage | null> {
  try {
    // encoding: 'buffer' 关键——xwd 输出二进制，默认 utf8 解码会破坏数据
    const { stdout } = await execFileAsync('xwd', ['-id', wid, '-silent'], { timeout: 6000, env: DISPLAY_ENV, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' })
    const buf: Buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'binary')
    const img = parseXwd(buf)
    if (!img) return null
    // 全黑（被遮挡/窗口不可见）视为抓取无效，避免误判
    const bpl = img.bytesPerLine
    let nonBlack = 0
    for (let y = 0; y < img.height; y++) {
      const off = img.dataStart + y * bpl
      for (let x = 0; x < img.width; x++) {
        const p = off + x * 4
        if (img.data[p] !== 0 || img.data[p + 1] !== 0 || img.data[p + 2] !== 0) {
          nonBlack++
          if (nonBlack > 8) break
        }
      }
      if (nonBlack > 8) break
    }
    if (nonBlack <= 8) return null
    return img
  } catch {
    return null
  }
}

/**
 * 统计 ROI 内差异像素占比（BGRX 每像素 4 字节）。
 * 同坐标像素值完全一致才视为相同；占比 = 不同像素数 / ROI 总像素数。
 */
function roidiff(prev: XwdImage, next: XwdImage, roi: { x: number; y: number; w: number; h: number }): number {
  if (prev.width !== next.width || prev.height !== next.height) return 1
  const { x, y, w, h } = roi
  const x1 = Math.max(0, Math.min(prev.width, x + w))
  const y1 = Math.max(0, Math.min(prev.height, y + h))
  if (x1 <= x || y1 <= y) return 0
  let diff = 0
  let total = 0
  for (let py = y; py < y1; py++) {
    const pOff = prev.dataStart + py * prev.bytesPerLine + x * 4
    const nOff = next.dataStart + py * next.bytesPerLine + x * 4
    for (let px = x; px < x1; px++) {
      const a = pOff + (px - x) * 4
      const b = nOff + (px - x) * 4
      if (prev.data[a] !== next.data[b] || prev.data[a + 1] !== next.data[b + 1] || prev.data[a + 2] !== next.data[b + 2]) {
        diff++
      }
      total++
    }
  }
  return total > 0 ? diff / total : 0
}

async function xclipSet(text: any): Promise<void> {
  const str = String(text || '')
  if (!str) return
  const escaped = str.replace(/'/g, "'\\''")
  try {
    await execAsync(`echo -n '${escaped}' | PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -silent >/dev/null 2>&1`, {
      timeout: 3000,
      env: DISPLAY_ENV
    })
  } catch (e) {
    warn(`xclip failed: ${e}`)
    try {
      await execFileAsync('xsel', ['--clipboard', '--input'], { input: str, env: DISPLAY_ENV, timeout: 3000 })
    } catch (e2) {
      warn(`xsel also failed: ${e2}`)
    }
  }
}

async function xclipGet(): Promise<string> {
  try {
    const { stdout } = await execAsync(`PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -o 2>/dev/null`, {
      timeout: 2000,
      env: DISPLAY_ENV
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function xclipSetImage(imagePath: string, mime: string = 'image/png'): Promise<boolean> {
  try {
    await execAsync(`PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t ${mime} -i "${imagePath.replace(/"/g, '\\"')}" >/dev/null 2>&1`, {
      timeout: 5000,
      env: DISPLAY_ENV
    })
    return true
  } catch (e) {
    warn(`xclipSetImage failed (${mime}): ${e}`)
    if (mime !== 'image/bmp') {
      try {
        await execAsync(`PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t image/bmp -i "${imagePath.replace(/"/g, '\\"')}" >/dev/null 2>&1`, {
          timeout: 5000,
          env: DISPLAY_ENV
        })
        log('Fell back to image/bmp')
        return true
      } catch (e2) {
        warn(`xclipSetImage BMP fallback also failed: ${e2}`)
      }
    }
    return false
  }
}

/**
 * 剪贴板装载：文件 URI（视频/文件发送）。
 * P2 实测（2026-08-21）：text/uri-list 为微信 Linux 唯一生效目标；
 * x-special/gnome-copied-files 单目标实测无反应，仅作兼容可选补充。
 * 发送结果由文件是否为合法有效视频决定（合法视频→视频卡片，否则→文件卡片）。
 */
async function xclipSetFile(filePath: string): Promise<boolean> {
  const uri = `file://${filePath}`
  try {
    await execAsync(`printf '%s\\n' '${uri}' | PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t text/uri-list -i >/dev/null 2>&1`, {
      timeout: 5000,
      env: DISPLAY_ENV
    })
    return true
  } catch (e) {
    warn(`xclipSetFile(text/uri-list) failed: ${e}`)
  }
  try {
    await execAsync(`printf 'copy\\n%s' '${uri.replace(/"/g, '\\"')}' | PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t x-special/gnome-copied-files -i >/dev/null 2>&1`, {
      timeout: 5000,
      env: DISPLAY_ENV
    })
    log('Fell back to x-special/gnome-copied-files')
    return true
  } catch (e2) {
    warn(`xclipSetFile(gnome-copied-files) fallback also failed: ${e2}`)
    return false
  }
}

export class LinuxSender implements IPlatformSender {
  private queue: QueuedMessage[] = []
  private processing = false
  private currentMode: SendMode = 'foreground'
  private lastSendTime = 0
  private cachedWid = ''
  private delay: DelayProfile = DELAY_PROFILES.standard
  private delayMode: DelayMode = 'standard'
  private lastDelayMode: DelayMode | '' = ''
  // 自适应背压状态
  private consecutiveFailures = 0
  private queueCoolUntil = 0
  private activeTier: number | null = null   // 降档后的档位索引（null=跟随配置档位）
  // 队列优化状态（P1-L3）
  private dedupCount = 0
  private lastMergeContact = ''              // 当前批次的联系人（同联系人免重复搜索）
  // 吞吐统计
  private totalSent = 0
  private totalFailed = 0
  // L2 动态缩间隔 / 每步耗时
  private successStreak = 0
  private lastSendSteps: Array<{ step: string; ms: number }> = []
  // 图片粘贴熔断：连续失败 ≥1 次 → 冷却 30s；冷却后仅再试一次，失败则不发送
  private imagePasteFails = 0
  private imagePasteCoolUntil = 0
  // 输入框探针（SendAck 防误发辅助）：抓屏缓冲 + ROI 锁定
  private probeBuffer: XwdImage | null = null
  private probeWid = ''
  private probeRoi: { x: number; y: number; w: number; h: number } | null = null

  constructor() {
    try {
      const mode = getDelayMode()
      this.delay = resolveDelayProfile(mode)
      this.delayMode = mode
      log(`Delay profile: ${mode} (interMessage=${this.delay.interMessage}ms)`)
    } catch {
      this.delay = resolveDelayProfile('standard')
      this.delayMode = 'standard'
    }
    loadPinyinCache()
  }

  /** 按当前配置刷新延时档位（WebUI 改档/改参数后下一条消息生效；背压降档优先） */
  private refreshDelayProfile(): void {
    try {
      let mode = getDelayMode()
      if (this.activeTier !== null) {
        mode = this.tierIndexToMode(this.activeTier)
      }
      this.delay = resolveDelayProfile(mode)
      this.delayMode = mode
      if (mode !== this.lastDelayMode) {
        this.lastDelayMode = mode
        log(`Delay profile refreshed: ${mode} (interMessage=${this.delay.interMessage}ms)`)
      }
    } catch {
      this.delay = resolveDelayProfile('standard')
      this.delayMode = 'standard'
    }
  }

  // ─── 自适应背压：失败冷却 + 自动降档/升档 ─────────────────────────────────

  private getConfiguredTierIndex(mode: DelayMode): number {
    return mode === 'aggressive' ? 0 : mode === 'safe' ? 2 : 1
  }

  private tierIndexToMode(idx: number): DelayMode {
    if (idx <= 0) return 'aggressive'
    if (idx >= 2) return 'safe'
    return 'standard'
  }

  private isAutoDowngradeEnabled(): boolean {
    try {
      return ConfigService.getInstance().get('sendAutoDowngrade') !== false
    } catch {
      return true
    }
  }

  /** 消息发送成功：复位连续失败计数，并向上恢复一档（至多到配置档位） */
  private onSendSuccess(): void {
    this.consecutiveFailures = 0
    this.successStreak += 1
    if (this.activeTier !== null) {
      const configuredIdx = this.getConfiguredTierIndex(getDelayMode())
      const nextIdx = this.activeTier - 1
      if (nextIdx >= configuredIdx) {
        this.activeTier = nextIdx
        log(`Send success, upgraded delay tier to ${this.tierIndexToMode(nextIdx)}`)
      } else {
        this.activeTier = null
        log('Send success, delay tier restored to configured')
      }
    }
  }

  /** 消息发送失败：背压开启时累计连续失败，≥阈值 → 队列冷却 + 自动降档 */
  private onSendFailure(): void {
    this.successStreak = 0
    if (!isBackpressureEnabled()) return
    const threshold = Math.max(1, Math.floor(getConfigNumber('sendFailureThreshold', CONSECUTIVE_FAILURE_THRESHOLD)))
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= threshold) {
      this.consecutiveFailures = 0
      const cooldownMs = Math.max(1000, Math.floor(getConfigNumber('sendCooldownMs', QUEUE_COOLDOWN_MS)))
      this.queueCoolUntil = Date.now() + cooldownMs
      warn(`Send failed ${threshold} times consecutively, pausing queue for ${Math.round(cooldownMs / 1000)}s`)
      if (this.isAutoDowngradeEnabled()) this.downgradeTier()
    }
  }

  /** 降一档（aggressive→standard→safe），已到 safe 不再降 */
  private downgradeTier(): void {
    const configuredIdx = this.getConfiguredTierIndex(getDelayMode())
    const current = this.activeTier === null ? configuredIdx : this.activeTier
    if (current >= 2) return
    this.activeTier = current + 1
    warn(`Auto downgraded delay tier: ${this.tierIndexToMode(current)} → ${this.tierIndexToMode(this.activeTier)}`)
  }

  /** 生效的队列消息间隔：动态缩间隔开启时按连续成功缩短（下限 300ms），否则用档位值 */
  private getEffectiveInterMessage(): number {
    const base = this.delay.interMessage
    if (!isDynamicIntervalEnabled() || this.successStreak <= 0) return base
    const shrink = Math.min(this.successStreak * DYNAMIC_INTERVAL_STEP_MS, base * 0.5)
    return Math.max(DYNAMIC_INTERVAL_MIN_MS, Math.round(base - shrink))
  }

  setMode(mode: SendMode): void { this.currentMode = mode }

  // ─── 输入框探针（SendAck 防误发辅助，§5.3）────────────────────────────

  /** 抓取当前微信窗口并锁定输入框 ROI（用于后续像素比对）。失败返回 false（探针不可用）。 */
  private async captureProbeBaseline(): Promise<boolean> {
    try {
      const wid = await this.findWeChatWindow()
      if (!wid) return false
      const img = await captureWindowXwd(wid)
      if (!img) return false
      // 输入框 ROI：窗口底部约 30% 的宽条（y=70%~100%）。
      // 微信 Linux 聊天界面在文本输入框下方还有一条空白占位，若只取底部 7% 窄条，
      // 会落在该空白占位上，媒体卡片（渲染在输入框中上部）在/不在都不影响该窄条，
      // 导致探针把恒定噪声误读为"媒体已离开"。扩大到底部 30% 覆盖媒体卡片主体 + 占位，
      // 让差异真正反映媒体本身。
      const roi = {
        x: 0,
        y: Math.floor(img.height * 0.70),
        w: img.width,
        h: Math.max(1, img.height - Math.floor(img.height * 0.70))
      }
      this.probeBuffer = img
      this.probeWid = wid
      this.probeRoi = roi
      return true
    } catch {
      return false
    }
  }

  /** 输入框探针查询：媒体是否仍在输入框。true=仍在（可放心 Enter）；false=已离开（禁止 Enter）；undefined=探针不可用 */
  private async probeImageInInput(): Promise<boolean | undefined> {
    try {
      if (!this.probeWid) return undefined
      const img = await captureWindowXwd(this.probeWid)
      if (!img || !this.probeRoi || !this.probeBuffer) return undefined
      const diff = roidiff(this.probeBuffer, img, this.probeRoi)
      // 保守化阈值（方案一）：默认 15%。diff < 15% 一律判"媒体仍在（可放心 Enter）"，
      // 仅 diff ≥ 15% 才判"已清空"。媒体卡住时 diff 落在 5%-15% 区间（实测 6.4%），
      // 若仍用 5% 会把"卡在框里的媒体"误判为"已清空"→ 阻止二次 Enter → 媒体永久卡死。
      const threshold = Math.max(0, Math.min(1, Number(getConfigNumber('sendAckProbeDiffThreshold', 0.15))))
      log(`探针 ROI 差异 ${(diff * 100).toFixed(1)}% (阈值 ${(threshold * 100).toFixed(0)}%)`)
      return diff < threshold
    } catch {
      return undefined
    }
  }

  /** 清空探针缓冲（下一条媒体发送前重置基线） */
  private clearProbeBaseline(): void {
    this.probeBuffer = null
    this.probeWid = ''
    this.probeRoi = null
  }

  /** 探测图片体积（仅 stat，微秒级） */
  private probeImageBytes(filePath: string): number | null {
    try {
      const fs = require('fs')
      return fs.statSync(filePath).size
    } catch { return null }
  }

  /**
   * 图片粘贴后到发送前的等待，按体积自适应。
   * - 小图（<1MB）：用基准 imagePasteSettle（如标准 600ms），不额外等待
   * - 大图（≥1MB）：以 1MB 为起点，每超 1MB 追加 300ms，微信需要更长时间解码生成预览
   * 上限 3000ms，避免无限长卡死队列。
   */
  private computeImagePasteWait(bytes: number | null, baseWait: number): number {
    if (bytes === null || bytes <= 0) return baseWait
    const mb = bytes / (1024 * 1024)
    if (mb < 1) return baseWait
    // 大图：从基准（如 400ms）随体积线性增量，封顶可配置上限（默认 1500ms），保证大图能发又不过度拖沓
    const cap = Math.max(baseWait, Math.floor(getConfigNumber('imagePasteCapMs', 1500)))
    const extra = Math.ceil((mb - 1) / 1) * 300
    const total = baseWait + extra
    return Math.min(total, cap)
  }

  /** 探测文件体积（仅 stat，微秒级）——视频/通用文件大小探测 */
  private probeFileBytes(filePath: string): number | null {
    try {
      const fs = require('fs')
      return fs.statSync(filePath).size
    } catch { return null }
  }

  /**
   * 视频粘贴后的等待：按体积自适应。
   * P2 实测（2026-08-21）：2MB 视频 Ctrl+V 后 ≤1s 即可发送；
   * 因输入区不渲染预览（§1.1 约束），等待仅用于让微信完成粘贴装载。
   * 公式：2000ms 基线 + 每 10MB +500ms，封顶 videoPasteCapMs（默认 8000）。
   */
  private computeVideoPasteWait(bytes: number | null): number {
    const base = bytes !== null && bytes > 0 ? 2000 + Math.floor(bytes / (10 * 1024 * 1024)) * 500 : 2000
    const cap = Math.max(base, Math.floor(getConfigNumber('videoPasteCapMs', 8000)))
    return Math.min(base, cap)
  }

  /** 触发图片粘贴熔断：冷却 30s */
  private triggerImagePasteCooldown(): void {
    this.imagePasteFails += 1
    this.imagePasteCoolUntil = Date.now() + IMAGE_PASTE_COOLDOWN_MS
    warn(`Image paste cooldown triggered (fail #${this.imagePasteFails}), next 30s image sends will be skipped`)
  }

  private async findWeChatWindow(): Promise<string> {
    if (this.cachedWid) {
      const alive = await run(`xdotool getwindowgeometry "${this.cachedWid}"`)
      if (alive && !alive.includes('failed') && !alive.includes('error')) {
        return this.cachedWid
      }
      log(`Cached window ${this.cachedWid} no longer valid, re-searching...`)
      this.cachedWid = ''
    }

    const display = process.env.DISPLAY || ':99'
    log(`Searching WeChat window (DISPLAY=${display})...`)

    const version = await run(`xdotool version`)
    log(`xdotool version: ${version || 'NOT FOUND'}`)
    if (!version) {
      warn('xdotool not found or not working')
      return ''
    }

    for (const name of WECHAT_WINDOW_NAMES) {
      const result = await run(`xdotool search --name "${name}"`)
      const wid = result.split('\n').filter(Boolean)[0] || ''
      if (wid) {
        log(`Found window by name "${name}": ${wid}`)
        this.cachedWid = wid
        return wid
      }
    }

    for (const cls of ['wechat', 'WeChat', 'WMPF', 'Weixin']) {
      const result = await run(`xdotool search --class "${cls}"`)
      const wid = result.split('\n').filter(Boolean)[0] || ''
      if (wid) {
        log(`Found window by class "${cls}": ${wid}`)
        this.cachedWid = wid
        return wid
      }
    }

    const pid = await run('pidof wechat')
    if (pid) {
      warn(`WeChat process running (PID: ${pid}) but no window found`)
    } else {
      warn('WeChat process not found')
    }

    return ''
  }

  private async activateWindow(wid: string): Promise<boolean> {
    const active = await run(`xdotool getactivewindow`)
    if (active === wid) {
      return true
    }

    log(`Activating window ${wid}...`)
    await run(`xdotool windowactivate --sync "${wid}"`)
    await run(`xdotool windowfocus --sync "${wid}"`)
    await new Promise(r => setTimeout(r, 150))

    const focused = await run(`xdotool getactivewindow`)
    if (focused !== wid) {
      warn(`Window activation failed: expected ${wid}, got ${focused}`)
      await run(`xdotool windowactivate --sync "${wid}"`)
      await new Promise(r => setTimeout(r, 200))
      const retry = await run(`xdotool getactivewindow`)
      if (retry !== wid) {
        warn(`Window activation retry failed: expected ${wid}, got ${retry}`)
        return false
      }
    }
    return true
  }

  private containsNonAscii(text: string): boolean {
    return /[^\x00-\x7F]/.test(text)
  }

  private async toPinyin(text: string): Promise<string> {
    try {
      // 拼音缓存：命中直接返回，避免每次起子进程
      const cached = pinyinCache.get(text)
      if (cached) return cached

      const { execSync } = require('child_process')
      const result = execSync(`python3 /opt/pinyin.py '${text.replace(/'/g, "'\\''")}'`, {
        timeout: 3000,
        encoding: 'utf-8',
        env: DISPLAY_ENV
      }).trim()
      const pinyin = result || text
      if (pinyinCache.size >= 5000) pinyinCache.clear() // 防无限膨胀
      pinyinCache.set(text, pinyin)
      persistPinyinCache()
      return pinyin
    } catch {
      return text
    }
  }

  private async searchAndSelectContact(contactName: string, wid: string): Promise<boolean> {
    log(`Opening search with Ctrl+F...`)
    await run(`xdotool key --window "${wid}" ctrl+f`)
    await new Promise(r => setTimeout(r, this.delay.searchOpen))

    log(`Selecting all and typing contact name: "${contactName}"`)
    await run(`xdotool key --window "${wid}" ctrl+a`)
    await new Promise(r => setTimeout(r, 100))

    if (this.containsNonAscii(contactName)) {
      const pinyin = await this.toPinyin(contactName)
      log(`Contact name "${contactName}" → pinyin "${pinyin}", typing with xdotool`)
      await run(`xdotool type --window "${wid}" --delay 30 "${pinyin.replace(/'/g, "'\\''")}"`)
    } else if (contactName.length <= 50) {
      await run(`xdotool type --window "${wid}" --delay 30 "${contactName.replace(/'/g, "'\\''")}"`)
    } else {
      await xclipSet(contactName)
      await new Promise(r => setTimeout(r, this.delay.textClipSettle))
      await run(`xdotool key --window "${wid}" ctrl+v`)
    }
    await new Promise(r => setTimeout(r, this.delay.searchSettle))

    log(`Pressing Enter to select first result...`)
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, this.delay.selectSettle))

    log(`Search complete for contact: "${contactName}"`)
    return true
  }

  private async ensureFocusInInput(wid: string): Promise<void> {
    log(`Ensuring focus in input area...`)
    const geo = await run(`xdotool getwindowgeometry "${wid}"`)
    const match = geo.match(/Geometry:\s*(\d+)x(\d+)/)
    if (!match) {
      warn(`Failed to parse window geometry: ${geo}`)
      return
    }
    const w = parseInt(match[1])
    const h = parseInt(match[2])
    const clickX = Math.round(w * 0.70)
    const clickY = h - 100
    log(`Window ${w}x${h}, clicking input area at (${clickX}, ${clickY})`)
    await run(`xdotool mousemove --window "${wid}" ${clickX} ${clickY}`)
    await new Promise(r => setTimeout(r, this.delay.focusMove))
    await run(`xdotool click 1`)
    await new Promise(r => setTimeout(r, this.delay.inputClick))
  }

  private async pasteAndSend(content: string, wid: string, imagePath?: string, videoPath?: string, onMediaPasted?: () => Promise<void>): Promise<boolean> {
    if (videoPath) {
      log(`Pasting video: ${videoPath}`)
      // 大小闸：视频不适用图片的 5MB/30s 熔断，超 videoMaxBytes 直接拒绝（S5）
      const bytes = this.probeFileBytes(videoPath)
      const max = Math.floor(getConfigNumber('videoMaxBytes', 100 * 1024 * 1024))
      if (bytes === null || bytes > max) {
        warn(`Video too large to paste (${bytes !== null ? Math.round(bytes / 1024 / 1024) : '?'}MB > ${Math.round(max / 1024 / 1024)}MB), rejected`)
        return false
      }
      const ok = await xclipSetFile(videoPath)
      if (!ok) {
        warn('xclipSetFile failed')
        return false
      }
      await new Promise(r => setTimeout(r, this.delay.imageClipSettle))
      await run(`xdotool key --window "${wid}" ctrl+v`)
      log('Video pasted to clipboard successfully')
      const effectiveWait = this.computeVideoPasteWait(bytes)
      await new Promise(r => setTimeout(r, effectiveWait))
    } else if (imagePath) {
      log(`Pasting image: ${imagePath}`)
      // 兜底：探测图片体积，>5MB 拒绝并触发熔断（防微信粘贴冻结）
      const bytes = this.probeImageBytes(imagePath)
      if (bytes !== null && bytes > MAX_PASTE_IMAGE_BYTES) {
        warn(`Image too large to paste (${Math.round(bytes / 1024 / 1024)}MB > 5MB), rejected`)
        this.triggerImagePasteCooldown()
        return false
      }
      const mime = this.detectImageMime(imagePath)
      const ok = await xclipSetImage(imagePath, mime)
      if (!ok) {
        warn('xclipSetImage failed, triggering image paste cooldown')
        this.triggerImagePasteCooldown()
        return false
      }
      await new Promise(r => setTimeout(r, this.delay.imageClipSettle))
      await run(`xdotool key --window "${wid}" ctrl+v`)
      log('Image pasted to clipboard successfully')
      // 体积自适应等待：基准 imagePasteSettle（标准 400ms），大图按比例增量封顶 1500ms，
      // 小图用基准值不额外等待（避免小图也变慢而堵塞队列）
      const baseWait = this.delay.imagePasteSettle
      const effectiveWait = this.computeImagePasteWait(bytes, baseWait)
      if (effectiveWait !== baseWait) {
        warn(`Image ${bytes ? Math.round(bytes / 1024 / 1024 * 100) / 100 : '?'}MB: paste wait ${baseWait} → ${effectiveWait}ms (adaptive)`)
      }
      await new Promise(r => setTimeout(r, effectiveWait))
    } else {
      log(`Pasting message (${content.length} chars)...`)
      await xclipSet(content)
      await new Promise(r => setTimeout(r, this.delay.textClipSettle))
      await run(`xdotool key --window "${wid}" ctrl+v`)
      await new Promise(r => setTimeout(r, this.delay.pasteSettle))
    }

    log(`Pressing Enter to send...`)
    // 探针基线：Enter 前抓取（媒体卡片已渲染、尚未发送）——SendAck 超时时对比判定卡框/已发出。
    // 必须在 Enter 前：Enter 后输入框已被微信清空，基线=空框会导致差异恒为 0 而误判"仍在输入框"。
    if (onMediaPasted) {
      await onMediaPasted()
    }
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, this.delay.postSendSettle))

    log('Message sent successfully')
    return true
  }

  private async doSend(
    content: string,
    contactName: string,
    imagePath?: string,
    atMentions?: Array<{ wxid: string; name: string }>,
    skipSearch = false,
    videoPath?: string
  ): Promise<{ success: boolean; error?: string }> {
    const wid = await this.findWeChatWindow()
    if (!wid) {
      return { success: false, error: '找不到微信窗口' }
    }

    return this.doSendWithWindow(content, contactName, wid, imagePath, atMentions, skipSearch, videoPath)
  }

  private detectImageMime(imagePath: string): string {
    const ext = imagePath.toLowerCase().split('.').pop() || 'png'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'bmp') return 'image/bmp'
    if (ext === 'webp') return 'image/webp'
    return 'image/png'
  }

  private async doSendWithWindow(
    content: string,
    contactName: string,
    wid: string,
    imagePath?: string,
    atMentions?: Array<{ wxid: string; name: string }>,
    skipSearch = false,
    videoPath?: string
  ): Promise<{ success: boolean; error?: string }> {
    const steps: Array<{ step: string; ms: number }> = []
    let t0 = Date.now()

    if (!await this.activateWindow(wid)) {
      return { success: false, error: '无法激活微信窗口' }
    }
    steps.push({ step: '激活窗口', ms: Date.now() - t0 })

    t0 = Date.now()
    if (!skipSearch) {
      log(`Searching contact "${contactName}"...`)
      if (!await this.searchAndSelectContact(contactName, wid)) {
        return { success: false, error: '搜索联系人失败' }
      }
    } else {
      log(`Reusing open chat for "${contactName}" (skip search)`)
    }
    steps.push({ step: '搜索联系人', ms: Date.now() - t0 })

    t0 = Date.now()
    await this.ensureFocusInInput(wid)
    steps.push({ step: '聚焦输入框', ms: Date.now() - t0 })

    // 真正渲染群内 @：输入 @ + 成员名 + 回车选中，再拼正文
    if (atMentions && atMentions.length > 0) {
      await this.typeAtMentions(atMentions, wid)
    }

    t0 = Date.now()
    // 探针基线在 Enter 前抓取（onMediaPasted 回调）：粘贴完成、媒体卡片已渲染、尚未发送。
    // Enter 后输入框已被清空，此时抓基线会与超时空框一致 → 误判"仍在输入框"。移到 Enter 前修正。
    const probeBaselineCb = (imagePath || videoPath) ? async () => { await this.captureProbeBaseline() } : undefined
    if (!await this.pasteAndSend(content, wid, imagePath, videoPath, probeBaselineCb)) {
      return { success: false, error: '粘贴发送失败' }
    }
    steps.push({ step: '粘贴发送', ms: Date.now() - t0 })

    if (!imagePath && !videoPath) {
      this.clearProbeBaseline()
    }

    this.lastSendSteps = steps
    this.lastSendTime = Date.now()
    const typeLabel = videoPath ? 'video' : imagePath ? 'image' : 'text'
    log(`Message type=${typeLabel} sent to "${contactName}"${atMentions && atMentions.length ? ` with @(${atMentions.length})` : ''}`)
    return { success: true }
  }

  // 群内 @ 渲染：在输入框输入 @ 唤起成员选择器，输入成员名，回车选中，最后补空格
  private async typeAtMentions(atMentions: Array<{ wxid: string; name: string }>, wid: string): Promise<void> {
    for (const m of atMentions) {
      const name = String(m.name || m.wxid || '')
      if (!name) continue
      log(`Typing @ mention for "${name}" (${m.wxid})...`)
      await run(`xdotool type --window "${wid}" --delay 40 "@"`)
      await new Promise(r => setTimeout(r, 500))

      if (this.containsNonAscii(name)) {
        const pinyin = await this.toPinyin(name)
        log(`  @ member "${name}" → pinyin "${pinyin}"`)
        await run(`xdotool type --window "${wid}" --delay 40 "${pinyin.replace(/'/g, "'\\''")}"`)
      } else {
        await run(`xdotool type --window "${wid}" --delay 40 "${name.replace(/'/g, "'\\''")}"`)
      }
      await new Promise(r => setTimeout(r, 600))

      log(`  Selecting first @ result for "${name}"...`)
      await run(`xdotool key --window "${wid}" Return`)
      await new Promise(r => setTimeout(r, 400))

      await run(`xdotool type --window "${wid}" --delay 20 " "`)
      await new Promise(r => setTimeout(r, 120))
    }
  }

  async sendMessage(
    content: string,
    contactName?: string,
    imagePath?: string,
    atMentions?: Array<{ wxid: string; name: string }>,
    videoPath?: string,
    sessionId?: string
  ): Promise<{
    success: boolean; error?: string; method: string; ack?: string; serverId?: number; messageId?: string
  }> {
    const str = String(content || '')
    const name = String(contactName || '')
    if (!name) {
      warn('No contact name provided')
      return { success: false, error: '联系人名称未提供', method: this.currentMode }
    }

    return new Promise((resolve) => {
      // 去重（sendDedup）：同联系人 + 同内容文本，且队列中已有待发 → 丢弃本次（图片/视频/@ 不参与去重）
      if (!imagePath && !videoPath && !(atMentions && atMentions.length) && isQueueOptionEnabled('sendDedup')) {
        const dup = this.queue.find(q =>
          q.contactName === name && q.content === str && !q.imagePath && !q.videoPath && !(q.atMentions && q.atMentions.length)
        )
        if (dup) {
          this.dedupCount++
          log(`Deduplicated message to "${name}" (same content already queued as ${dup.id}), dedupCount=${this.dedupCount}`)
          resolve({ success: true, method: this.currentMode })
          return
        }
      }

      const item: QueuedMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: str,
        contactName: name,
        imagePath,
        videoPath,
        atMentions,
        sessionId,
        resolve,
        retries: 0,
        createdAt: Date.now()
      }

      // 优先级分组（sendPriority）：同联系人消息连续（组顺序=首次出现顺序，组内到达顺序）
      if (isQueueOptionEnabled('sendPriority')) {
        let insertAt = this.queue.length
        for (let i = this.queue.length - 1; i >= 0; i--) {
          if (this.queue[i].contactName === name) {
            insertAt = i + 1
            break
          }
        }
        this.queue.splice(insertAt, 0, item)
      } else {
        this.queue.push(item)
      }

      log(`Queued message ${item.id} for "${name}"${videoPath ? ' [VIDEO]' : imagePath ? ' [IMAGE]' : ''}${atMentions && atMentions.length ? ` [AT:${atMentions.length}]` : ''} (queue size: ${this.queue.length})`)
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    this.lastMergeContact = ''

    while (this.queue.length > 0) {
      this.refreshDelayProfile()

      // 背压冷却：暂停队列（新消息排队等待，不发送；仅背压开启时生效）
      if (isBackpressureEnabled() && Date.now() < this.queueCoolUntil) {
        const remaining = this.queueCoolUntil - Date.now()
        const wait = Math.min(remaining, 1000)
        log(`Queue cooldown active (${Math.ceil(remaining / 1000)}s left), pausing send queue`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      const item = this.queue[0]

      const interMessage = this.getEffectiveInterMessage()
      const elapsed = Date.now() - this.lastSendTime
      if (elapsed < interMessage) {
        const wait = interMessage - elapsed
        log(`Waiting ${wait}ms before next send...`)
        await new Promise(r => setTimeout(r, wait))
      }

      // 同批免重复搜索（sendMerge）：同一联系人的连续消息（含图片，无 @）复用已打开的聊天
      const skipSearch = isQueueOptionEnabled('sendMerge') &&
        this.lastMergeContact === item.contactName &&
        !(item.atMentions && item.atMentions.length)

      log(`Processing message ${item.id} (attempt ${item.retries + 1}/${MAX_RETRIES})${item.videoPath ? ' [VIDEO]' : item.imagePath ? ' [IMAGE]' : ''}${skipSearch ? ' [MERGED]' : ''}`)

      // 图片粘贴熔断：冷却期内图片消息快速失败，不粘贴不重试，保证队列稳定
      if (item.imagePath && Date.now() < this.imagePasteCoolUntil) {
        const remaining = Math.ceil((this.imagePasteCoolUntil - Date.now()) / 1000)
        warn(`Image paste cooldown active (${remaining}s left), skipping image send`)
        item.resolve({ success: false, error: `图片粘贴冷却中（${remaining}s）`, method: this.currentMode })
        this.queue.shift()
        continue
      }

      let result: { success: boolean; error?: string }
      try {
        result = await this.doSend(item.content, item.contactName, item.imagePath, item.atMentions, skipSearch, item.videoPath)
      } catch (e: any) {
        result = { success: false, error: e?.message || 'Unknown error' }
      }

      if (result.success) {
        const typeLabel = item.videoPath ? 'video' : item.imagePath ? 'image' : 'text'
        log(`Message ${item.id} (${typeLabel}) sent successfully`)

        // 媒体发送回执（SendAck 兜底，IMAGE-SEND-ACK-FALLBACK.md §四/§五）：
        // 图片/视频任务在 resolve 前等待 WCDB 回执（事件监听 ~2.5s / 轮询按 kind 超时），
        // 未确认则二次 Enter 兜底。回执期间队列占用 = 防下一条顶走卡框媒体（期望行为）。
        let ackResult: { success: boolean; status?: string; serverId?: number; messageId?: string; error?: string } | null = null
        if ((item.imagePath || item.videoPath) && item.sessionId) {
          try {
            ackResult = await this.waitForAck(item)
          } catch (e: any) {
            warn(`SendAck 异常（不阻塞发送）: ${e?.message || String(e)}`)
          }
        }

        this.onSendSuccess()
        this.totalSent++
        this.lastMergeContact = item.contactName
        item.resolve({
          success: ackResult ? ackResult.success : true,
          method: this.currentMode,
          ack: ackResult?.status,
          serverId: ackResult?.serverId,
          messageId: ackResult?.messageId,
          ...(ackResult && !ackResult.success ? { error: ackResult.error } : {})
        })
        this.queue.shift()
      } else {
        item.retries++
        if (item.retries >= MAX_RETRIES) {
          warn(`Message ${item.id} failed after ${MAX_RETRIES} attempts: ${result.error}`)
          this.onSendFailure()
          this.totalFailed++
          this.lastMergeContact = ''
          item.resolve({ success: false, error: `发送失败（重试${MAX_RETRIES}次）: ${result.error}`, method: this.currentMode })
          this.queue.shift()
        } else {
          const backoffBase = Math.max(100, Math.floor(getConfigNumber('sendBackoffBaseMs', RETRY_DELAY_MS)))
          const backoff = Math.min(backoffBase * Math.pow(2, item.retries - 1), RETRY_BACKOFF_MAX_MS)
          warn(`Message ${item.id} failed (attempt ${item.retries}/${MAX_RETRIES}), retrying in ${backoff}ms...`)
          await new Promise(r => setTimeout(r, backoff))
        }
      }
    }

    this.processing = false
  }

  /**
   * 媒体发送回执（SendAck）：Enter 后等待 WCDB 确认 isSend 行（IMAGE-SEND-ACK-FALLBACK.md §四/§五）。
   * 按任务类型取 kind（图片/视频），事件监听为主（chatService.addDbMonitorListener）+ 轮询降级；
   * 超时未确认 → 二次 Enter（不清空）兜底。视频大文件不计算 md5（避免读盘耗时，旁证非主判据）。
   */
  private async waitForAck(item: QueuedMessage): Promise<SendAckResult> {
    // 计算源文件旁证（尽力而为，取不到不影响主判据；视频大文件跳过 md5）
    let imageDatName: string | undefined
    let sourceMd5: string | undefined
    if (item.imagePath) {
      try {
        const fs = require('fs')
        const crypto = require('crypto')
        sourceMd5 = crypto.createHash('md5').update(fs.readFileSync(item.imagePath)).digest('hex')
        // dat 名：微信以 md5 命名缓存文件，源文件不一定有；留空由旁证逻辑跳过
        imageDatName = undefined
      } catch {}
    }

    const fp: SendAckFingerprint = {
      sessionId: item.sessionId || '',
      kind: item.videoPath ? 'video' : 'image',
      t0: this.lastSendTime || Date.now(),
      imageDatName,
      sourceMd5,
      clientTag: item.id,
      // 体积（MB）：已 stat 过，直接带进指纹做超时自适应
      sizeMb: (() => {
        const mediaPath = item.imagePath || item.videoPath
        if (!mediaPath) return undefined
        const bytes = this.probeFileBytes(mediaPath)
        return bytes !== null && bytes > 0 ? bytes / (1024 * 1024) : undefined
      })()
    }

    // 二次 Enter 执行器：仅按 Enter（不清空不重贴），并更新 lastSendTime 供再次回执的时间窗
    const doReEnter = async (): Promise<boolean> => {
      const wid = await this.findWeChatWindow()
      if (!wid) {
        warn('二次 Enter 兜底失败：找不到微信窗口')
        return false
      }
      await run(`xdotool key --window "${wid}" Return`)
      this.lastSendTime = Date.now()
      await new Promise(r => setTimeout(r, this.delay.postSendSettle))
      return true
    }

    const ackSvc = new SendAckService({
      getNewMessages: async (sessionId: string, minTime: number, limit?: number) => {
        const { chatService } = require('../../services/chatService')
        return chatService.getNewMessages(sessionId, minTime, limit)
      },
      addDbMonitorListener: (listener) => {
        const { chatService } = require('../../services/chatService')
        return chatService.addDbMonitorListener(listener)
      },
      doReEnter,
      probeImageInInput: () => this.probeImageInInput()
    })

    return ackSvc.waitForAck(fp)
  }

  async sendBatch(tasks: Array<{ sessionId: string; content: string }>): Promise<SendProgress> {
    const results = []
    for (const task of tasks) {
      const result = await this.sendMessage(task.content, task.sessionId)
      results.push(result)
    }
    return this.getProgress()
  }

  cancelPending(): number {
    let count = 0
    const pending = this.queue.splice(0)
    for (const item of pending) {
      item.resolve({ success: false, error: 'Cancelled', method: this.currentMode })
      count++
    }
    return count
  }

  /** 清空拼音缓存并持久化空文件，返回清除条数 */
  clearPinyinCache(): number {
    const cleared = pinyinCache.size
    pinyinCache.clear()
    try {
      const fs = require('fs')
      const file = resolvePinyinCacheFile()
      if (file) {
        const dir = require('path').dirname(file)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, '{}')
      }
    } catch {}
    log(`Pinyin cache cleared (${cleared} entries)`)
    return cleared
  }

  getProgress(): SendProgress {
    return {
      total: this.queue.length,
      sent: 0,
      failed: 0,
      current: this.queue[0]?.content
    }
  }

  /** 发送/队列运行状态（供 WebUI「发送管理」页只读回显） */
  getSendStatus(): Record<string, any> {
    let mode: DelayMode = this.delayMode
    try {
      let cfg = getDelayMode() || this.delayMode
      if (this.activeTier !== null) cfg = this.tierIndexToMode(this.activeTier)
      mode = cfg
    } catch {}

    // 当前批次：队首连续同联系人的消息数
    let batchContact: string | null = null
    let batchSize = 0
    if (this.queue.length > 0) {
      batchContact = this.queue[0].contactName
      for (const it of this.queue) {
        if (it.contactName === batchContact) batchSize++
        else break
      }
    }

    return {
      mode,
      profile: { ...resolveDelayProfile(mode) },
      custom: getDelayCustomOverrides(),
      backpressure: {
        enabled: isBackpressureEnabled(),
        consecutiveFailures: this.consecutiveFailures,
        coolRemainingMs: Math.max(0, this.queueCoolUntil - Date.now()),
        autoDowngrade: this.isAutoDowngradeEnabled(),
        failureThreshold: Math.max(1, Math.floor(getConfigNumber('sendFailureThreshold', CONSECUTIVE_FAILURE_THRESHOLD))),
        cooldownMs: Math.max(1000, Math.floor(getConfigNumber('sendCooldownMs', QUEUE_COOLDOWN_MS))),
        backoffBaseMs: Math.max(100, Math.floor(getConfigNumber('sendBackoffBaseMs', RETRY_DELAY_MS)))
      },
      options: {
        merge: isQueueOptionEnabled('sendMerge'),
        dedup: isQueueOptionEnabled('sendDedup'),
        priority: isQueueOptionEnabled('sendPriority'),
        dynamicInterval: isDynamicIntervalEnabled()
      },
      dedupCount: this.dedupCount,
      stats: {
        sent: this.totalSent,
        failed: this.totalFailed
      },
      lastSendSteps: this.lastSendSteps,
      successStreak: this.successStreak,
      batch: {
        contact: batchContact,
        size: batchSize
      },
      queue: {
        pending: this.queue.length,
        processing: this.processing,
        currentContent: this.queue[0]?.content || null,
        lastSendTime: this.lastSendTime || null,
        items: this.queue.slice(0, 50).map((it) => ({
          id: it.id,
          contactName: it.contactName,
          type: it.videoPath ? 'video' : it.imagePath ? 'image' : 'text',
          atMentions: !!(it.atMentions && it.atMentions.length),
          contentPreview: it.content ? it.content.slice(0, 30) : '',
          queuedSeconds: Math.round((Date.now() - it.createdAt) / 1000)
        }))
      },
      pinyinCacheSize: pinyinCache.size
    }
  }

  isWeChatRunning(): boolean {
    try {
      const result = require('child_process').execSync(
        'PATH=/usr/bin:/usr/sbin:/bin:/sbin:/usr/local/bin pidof wechat',
        { timeout: 3000, encoding: 'utf-8', env: DISPLAY_ENV }
      ).trim()
      return Boolean(result)
    } catch {
      return false
    }
  }
}
