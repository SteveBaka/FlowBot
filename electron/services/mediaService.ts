/**
 * mediaService —— 媒体出站统一入口（视频/文件四来源归一 + 图片归一压缩）
 *
 * 收敛 outboundMediaService / main.ts / httpService 散落的媒体处理。阶段规划见
 * MEDIA-SERVICE-DESIGN.md §六；本模块只产出「信号」（临时文件 + mime），
 * 剪贴板装载（xclip）留在发送线程（linux.ts）同步执行。
 */
import { createDecipheriv, createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { ConfigService } from './config'
import { videoService } from './videoService'
import { imageDecryptService } from './imageDecryptService'
import { cdnFetchService } from './cdnFetchService'

const isEnabled = (): boolean => {
  try { return ConfigService.getInstance().get('videoSendEnabled') !== false } catch { return true }
}

/** 视频大小上限（字节）——默认 100MB */
function videoMaxBytes(): number {
  try {
    const v = ConfigService.getInstance().get('videoMaxBytes')
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  } catch {}
  return 100 * 1024 * 1024
}

/** URL 下载超时（毫秒）——默认 120s；弥补图片版无超时可无限挂起的缺陷 */
function videoUrlTimeoutMs(): number {
  try {
    const v = ConfigService.getInstance().get('videoUrlTimeoutMs')
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  } catch {}
  return 120000
}

/* ── 出站临时文件生命周期清扫（2026-09-02 快赢）────────────────────────
 * 归一产物（weflow_obv_* 视频 / weflow_img_* 图片 / weflow_comp_* 压缩中间件）
 * 写入 tmpdir 后无人回收：发送成功不删、失败也不删，只随容器重建消失。
 * 对齐 cdnFetchService.sweepExpiredProducts 模式：按前缀 + mtime 惰性清扫，
 * 仅删本模块命名产物，24h 龄期保证不误删在用文件。 */
const OUTBOUND_TMP_PREFIXES = ['weflow_obv_', 'weflow_img_', 'weflow_comp_', 'weflow_fwd_']
const OUTBOUND_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const OUTBOUND_TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000
let lastOutboundTmpSweep = 0

function sweepOutboundTmpFiles(): void {
  const now = Date.now()
  if (now - lastOutboundTmpSweep < OUTBOUND_TMP_SWEEP_INTERVAL_MS) return
  lastOutboundTmpSweep = now
  try {
    const dir = tmpdir()
    for (const name of fs.readdirSync(dir)) {
      if (!OUTBOUND_TMP_PREFIXES.some((p) => name.startsWith(p))) continue
      try {
        if (fs.statSync(path.join(dir, name)).mtimeMs < now - OUTBOUND_TMP_MAX_AGE_MS) {
          fs.unlinkSync(path.join(dir, name))
        }
      } catch { /* 单文件失败下轮再清 */ }
    }
  } catch { /* tmpdir 不可读则本轮跳过 */ }
}

/* ══════════════════════════════════════════════════════════════════
 * 入站编排层（MEDIA-INBOUND-CONVERGENCE-PLAN）
 *
 * 只产出「信号」（本地路径/meta/降级标记）：token/URL/段构造归分发层
 * （httpService/botManager/server.js），WCDB 抓取归 messagePushService。
 * 开关关闭/文件缺失/异常全部安全降级——不抛出、不阻断推送、
 * 绝不主动触发微信下载。
 * ══════════════════════════════════════════════════════════════════ */

/** 结构化最小消息（chatService.Message 天然满足，避免依赖 chatService） */
export interface InboundMediaMessage {
  localType?: number | string
  videoMd5?: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number | string
  rawContent?: string
  content?: string | null
}

export interface InboundVideoSignal {
  videoPath?: string
  videoMd5?: string
  videoPosterPath?: string
  videoMeta?: { durationSec?: number; sizeBytes?: number; posterAvailable?: boolean; fileMissing?: boolean }
}

/** 消息 XML videomsg duration 属性 → 秒（唯一提取点，两个分支共用） */
function parseVideoDurationSec(raw: string): number | undefined {
  const m = /<videomsg[^>]*\sduration="(\d+(?:\.\d+)?)"/.exec(raw)
  return m ? Number(m[1]) : undefined
}

/** 入站视频解析（INBOUND-VIDEO-PUSH-PLAN §三）：开关关闭/文件缺失/异常全部安全降级，
 * 不抛出、不触发微信下载。元数据 duration 取自消息 XML，size 取自本地 stat。 */
export async function resolveInboundVideo(message: InboundMediaMessage): Promise<InboundVideoSignal | undefined> {
  if (ConfigService.getInstance().get('inboundVideoPushEnabled') !== true) return undefined
  if (Number(message.localType || 0) !== 43) return undefined
  const videoMd5 = String(message.videoMd5 || '').trim()
  if (!videoMd5) return undefined
  try {
    const raw = String(message.rawContent || message.content || '')
    const durationSec = parseVideoDurationSec(raw)
    const info = await videoService.getVideoInfo(videoMd5, { includePoster: true, posterFormat: 'fileUrl' })
    if (!info?.exists || !info.videoUrl || !fs.existsSync(info.videoUrl)) {
      // 视频本体缺失（群视频懒下载）：降级推封面 + 元数据，文件留给二期 CDN 直传
      const posterPath = await videoService.getVideoPosterFallback(videoMd5)
      if (!posterPath) {
        return {
          videoMd5,
          videoMeta: {
            durationSec,
            fileMissing: true
          }
        }
      }
      return {
        videoMd5,
        videoPosterPath: posterPath,
        videoMeta: {
          durationSec,
          posterAvailable: true,
          fileMissing: true
        }
      }
    }
    let videoPosterPath: string | undefined
    try {
      if (info.coverUrl && info.coverUrl.startsWith('file://')) videoPosterPath = fileURLToPath(info.coverUrl)
    } catch { /* 封面路径解析失败则不提供 */ }
    return {
      videoPath: info.videoUrl,
      videoMd5,
      videoPosterPath,
      videoMeta: {
        durationSec,
        sizeBytes: fs.statSync(info.videoUrl).size,
        posterAvailable: !!videoPosterPath
      }
    }
  } catch {
    return undefined
  }
}

/* ── 入站语音（INBOUND-VOICE-PUSH-PLAN §四）：纯信号工厂 ──
 * 分工与视频同构：DB 定位/silk 解码链留在 chatService（getVoiceData），mediaService
 * 只做可用性判定与语义归一；不 import chatService（依赖图无环红线）。
 * 超限判定不在此处：base64/url 模式对 voiceMaxBytes 的取舍属分发层知识（botManager 各自裁决，
 * URL 模式超限仍可发 token 直链）。
 * 语义注意：unavailableReason='not_cached' = 语音未解码（WeFlow UI 的「点击解密」态），
 * 是缓存未命中而非数据缺失——与视频 fileMissing（文件丢失）文案严格区分。 */
export interface InboundVoiceSignal {
  voicePath?: string
  voiceMeta: {
    durationSec?: number
    sizeBytes?: number
    available: boolean
    unavailableReason?: 'not_cached' | 'decode_failed'
  }
}

export function resolveInboundVoice(input: {
  voicePath?: string
  durationSec?: number | string
  error?: string
}): InboundVoiceSignal | undefined {
  if (ConfigService.getInstance().get('inboundVoicePushEnabled') !== true) return undefined
  const durationRaw = Number(input.durationSec)
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : undefined
  const voicePath = String(input.voicePath || '').trim() || undefined
  if (!voicePath) {
    return { voiceMeta: { durationSec, available: false, unavailableReason: input.error ? 'decode_failed' : 'not_cached' } }
  }
  try {
    if (!fs.existsSync(voicePath)) {
      return { voiceMeta: { durationSec, available: false, unavailableReason: 'not_cached' } }
    }
    return { voicePath, voiceMeta: { durationSec, sizeBytes: fs.statSync(voicePath).size, available: true } }
  } catch {
    return { voiceMeta: { durationSec, available: false, unavailableReason: 'not_cached' } }
  }
}

/* ── 图片消息 XML 解析（自 chatService 下沉，纯函数；chatService 薄委托保兼容）── */
function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(xml)
  if (match) {
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }
  return ''
}

function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  // 匹配 <tagName ... attrName="value" ... /> 或 <tagName ... attrName="value" ...>
  const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"']`, 'i')
  const match = regex.exec(xml)
  return match ? match[1] : ''
}

function parseImageInfo(content: string): { md5?: string; aesKey?: string; encrypVer?: number; cdnThumbUrl?: string } {
  try {
    const md5 =
      extractXmlValue(content, 'md5') ||
      extractXmlAttribute(content, 'img', 'md5') ||
      undefined
    const aesKey = extractXmlAttribute(content, 'img', 'aeskey') || undefined
    const encrypVerStr = extractXmlAttribute(content, 'img', 'encrypver') || undefined
    const cdnThumbUrl = extractXmlAttribute(content, 'img', 'cdnthumburl') || undefined

    return {
      md5,
      aesKey,
      encrypVer: encrypVerStr ? parseInt(encrypVerStr, 10) : undefined,
      cdnThumbUrl
    }
  } catch {
    return {}
  }
}

/**
 * 解析图片消息的 CDN 直取参数（IMAGE-HD-DOWNLOAD-ANALYSIS §8.4/§8.6）
 * 4.x 的 cdn*url 是 DER filekey 而非 URL；直取需要 filekey+aeskey+length 三参数
 */
export function parseImageCdnFetchParams(content: string): { fileKey?: string; aesKey?: string; md5?: string; fileLen?: number; hdLen?: number } {
  try {
    if (!content) return {}
    const base = parseImageInfo(content)
    const fileKey =
      extractXmlAttribute(content, 'img', 'cdnbigimgurl') ||
      extractXmlAttribute(content, 'img', 'cdnmidimgurl') ||
      undefined
    const toInt = (v: string) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 ? n : undefined
    }
    return {
      fileKey,
      aesKey: base.aesKey,
      md5: base.md5,
      fileLen: toInt(extractXmlAttribute(content, 'img', 'length')),
      hdLen: toInt(extractXmlAttribute(content, 'img', 'hdlength'))
    }
  } catch {
    return {}
  }
}

/* ── 入站图片编排（自 messagePushService.resolveAndDecryptImage 迁入，逻辑逐行等价）── */

const IMAGE_DECRYPT_MAX_RETRIES = 3
const IMAGE_DECRYPT_RETRY_DELAY_MS = 1000

/** 入站图片解析：重试 + preferHd 分层 + HD dat 升级 + CDN 直取兜底 + 缩略图降级，
 * 全路径不抛出；失败返回 undefined（调用方据 lt===3 判定 imageDecryptFailed） */
export async function resolveInboundImage(message: InboundMediaMessage, sessionId: string): Promise<string | undefined> {
  if (Number(message.localType || 0) !== 3) return undefined
  const imageMd5 = String(message.imageMd5 || '').trim()
  const imageDatName = String(message.imageDatName || '').trim()
  if (!imageMd5 && !imageDatName) return undefined
  const basePayload = {
    sessionId,
    imageMd5,
    imageDatName,
    createTime: Number(message.createTime || 0),
    preferFilePath: true,
    suppressEvents: true
  }
  let lastError: unknown = undefined
  let thumbPath: string | undefined = undefined
  for (let attempt = 0; attempt <= IMAGE_DECRYPT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, IMAGE_DECRYPT_RETRY_DELAY_MS))
    }
    const isLastAttempt = attempt >= IMAGE_DECRYPT_MAX_RETRIES
    const preferHd = attempt >= 1
    const payload = { ...basePayload, preferHd }
    try {
      const result = await imageDecryptService.decryptImage(payload)
      console.log(`[DIAG][MsgPush] attempt=${attempt} preferHd=${preferHd} result.success=${result?.success} isThumb=${result?.isThumb} localPath=${result?.localPath} error=${result?.error}`)
      if (result?.success && result.localPath) {
        if (!result.isThumb) {
          return result.localPath
        }
        if (!thumbPath) {
          thumbPath = result.localPath
        }
        if (isLastAttempt) {
          // break（而非 return）：让控制流落到循环后的 CDN 直取兜底块，再由末尾统一返回缩略图
          break
        }
        if (preferHd && imageMd5) {
          const hdDat = imageDecryptService.findHdDatForUpgrade(sessionId, imageMd5)
          console.log(`[DIAG][MsgPush] attempt=${attempt} hdDat search: found=${!!hdDat} path=${hdDat}`)
          if (hdDat) {
            const ready = await imageDecryptService.waitForFullDatReady(hdDat, 1500)
            console.log(`[DIAG][MsgPush] attempt=${attempt} hdDat ready=${ready}`)
            if (ready) {
              const hdResult = await imageDecryptService.decryptImageDirect(hdDat, sessionId)
              console.log(`[DIAG][MsgPush] attempt=${attempt} decryptImageDirect: result=${hdResult}`)
              if (hdResult) return hdResult
            }
          }
        }
        continue
      }
      lastError = result?.error || 'decrypt_failed'
      console.log(`[DIAG][MsgPush] attempt=${attempt} failed: ${lastError}`)
    } catch (e) {
      lastError = e
      console.log(`[DIAG][MsgPush] attempt=${attempt} exception: ${e}`)
    }
  }
  // CDN 直取兜底（IMAGE-HD-DOWNLOAD-ANALYSIS §8.6）：仅剩缩略图且开关开启时触发；
  // 产物为解密后明文，任何失败都降级回缩略图，不阻断推送
  if (thumbPath && ConfigService.getInstance().get('imageCdnDirectFetchEnabled') === true) {
    try {
      const cdnParams = parseImageCdnFetchParams(String(message.rawContent || message.content || ''))
      if (cdnParams.fileKey && cdnParams.aesKey && cdnParams.fileLen && cdnParams.fileLen > 0) {
        const fullPath = cdnFetchService.buildSavePath(imageMd5 || `img_${Date.now()}`)
        const cdnResult = await cdnFetchService.fetch({
          fileKey: cdnParams.fileKey,
          aesKey: cdnParams.aesKey,
          fileLen: cdnParams.fileLen,
          fullPath,
          md5: imageMd5 || cdnParams.md5, // 仅诊断：XML md5 与 CDN 实存对象无关（PoC 实证），不参与产物判定
          // createTime 秒 → 毫秒（cdnFetchService 门禁按 ms 与 Date.now() 比较）
          messageCreateTime: Number(message.createTime || 0) * 1000
        })
        if (cdnResult.success && cdnResult.localPath) {
          console.log(`[DIAG][MsgPush] cdn fetch success path=${cdnResult.localPath}`)
          return cdnResult.localPath
        }
        console.log(`[DIAG][MsgPush] cdn fetch degraded: error=${cdnResult.error} code=${cdnResult.code} disposition=${cdnResult.disposition}`)
      } else {
        console.log(`[DIAG][MsgPush] cdn fetch skip: params incomplete fileKey=${!!cdnParams.fileKey} aesKey=${!!cdnParams.aesKey} fileLen=${cdnParams.fileLen ?? 'null'}`)
      }
    } catch (e) {
      console.log(`[DIAG][MsgPush] cdn fetch exception: ${e}`)
    }
  }
  if (thumbPath) {
    return thumbPath
  }
  console.warn(`[MessagePushService] Image decrypt failed after ${IMAGE_DECRYPT_MAX_RETRIES + 1} attempts: ${String(lastError)} (imageMd5=${imageMd5}, sessionId=${sessionId})`)
  return undefined
}

/**
 * 视频扩展名探测（尽力保留，绝不拒绝）：
 * - 偏移 4 处 'ftyp'（ISO BMFF）→ .mp4/.mov
 * - 0x1A45DFA3（EBML/Matroska）→ .mkv
 * - 推断不出 → null（调用方兜底 .mp4）
 * 用途：http 下载无 content-type、或来源无扩展名时推断落盘名。
 */
export function detectVideoExt(buf: Buffer): string | null {
  if (!buf || buf.length < 16) return null
  // 'ftyp' at offset 4 (bytes 66 74 79 70)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return '.mp4'
  // Matroska/WebM magic: 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.mkv'
  return null
}

/** 从来源串提取扩展名（尽力保留用户/来源给出的扩展名） */
function sourceExt(fileUrl: string): string {
  const clean = fileUrl.split(/[?#]/)[0]
  const m = /\.[A-Za-z0-9]{1,6}$/.exec(clean)
  if (m) return m[0].toLowerCase()
  return ''
}

/** [Calib] 视频源规格探针（MEDIA-SERVICE-DESIGN §2.3 任务1 / §9.1 detectVideoSpec 原型）：
 * ffmpeg -i 只读头部（实测 ~13ms）+ 5s 超时，仅打日志、零行为影响，失败静默。
 * 输出行与 linux.ts 的 [Calib] T0 行、scripts/video-tx-monitor.sh 的上传结束点
 * 组成标定三元组（源规格 → Enter 时刻 → 上传完成时刻）。 */
function probeVideoSpec(videoPath: string, srcBytes: number): void {
  try {
    if (ConfigService.getInstance().get('videoCalibrationLogEnabled') !== true) return
    const ff = getFfmpegPath()
    if (!ff) return
    execFile(ff, ['-i', videoPath], { timeout: 5000 }, (_err, _stdout, stderr) => {
      try {
        const out = String(stderr || '')
        const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
        const vid = /Stream #[^\n]*Video:\s*([^,(]+),[^,]*,\s*(\d{2,5})x(\d{2,5})/.exec(out)
        const br = /\bbitrate:\s*(\d+)\s*kb\/s/.exec(out)
        const durS = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : 0
        const parts = [`size=${srcBytes}`, `duration=${durS.toFixed(1)}s`]
        if (vid) parts.push(`res=${vid[2]}x${vid[3]}`, `codec=${vid[1].trim()}`)
        if (br) parts.push(`bitrate=${br[1]}kbps`)
        console.log(`[mediaService][Calib] video-spec ${parts.join(' ')} file=${path.basename(videoPath)}`)
      } catch { /* 标定探针永不抛出 */ }
    })
  } catch { /* 同上 */ }
}

/**
 * 视频归一：四种来源 → 本地临时文件路径。
 * 返回 { videoPath, mime } | null；
 * null 仅发生在：下载失败 / 超限 / IO 错误（与格式无关，设计文档 §1.1/§5.4）。
 *
 * - base64:// ：前缀剥离 + Buffer 写盘
 * - file://    ：URI 解码 + copyFile；仅接受绝对路径，优先只认 /tmp/weflow_uploads/ 产物（见 S3）
 * - http(s):// ：带超时（videoUrlTimeoutMs）+ 流式边下边计数，累计超 videoMaxBytes 立即 abort 并删半成品
 * - 裸绝对路径：非 scheme 且以 / 开头且存在 → 拷贝（media_parser 跨容器不适用，同主机可用）
 * 总开关 videoSendEnabled:false 时直接返回 null（一键关停，调用方均已处理 null）。
 */
export async function prepareVideoForSend(
  fileUrl: string
): Promise<{ videoPath: string; mime: string } | null> {
  if (!fileUrl) {
    console.warn('[mediaService] prepareVideoForSend: empty fileUrl')
    return null
  }
  if (!isEnabled()) {
    console.warn('[mediaService] prepareVideoForSend: videoSendEnabled=false, skipped')
    return null
  }
  sweepOutboundTmpFiles()
  const max = videoMaxBytes()
  const timeoutMs = videoUrlTimeoutMs()
  const t0 = Date.now()
  try {
    // base64://
    if (fileUrl.startsWith('base64://')) {
      const b64 = fileUrl.slice(9)
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0) {
        console.warn('[mediaService] video base64: empty after decode')
        return null
      }
      if (buf.length > max) {
        console.warn(`[mediaService] video base64: ${(buf.length / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB`)
        return null
      }
      const ext = detectVideoExt(buf) || '.mp4'
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${ext}`)
      await fsp.writeFile(tmpPath, buf, { mode: 0o600 })
      console.log(`[mediaService] video base64 → ${tmpPath} (${(buf.length / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      void probeVideoSpec(tmpPath, buf.length)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    // file:// URI
    if (fileUrl.startsWith('file://')) {
      let filePath: string
      try { filePath = decodeURIComponent(fileUrl.slice(7)) } catch { filePath = fileUrl.slice(7) }
      if (!path.isAbsolute(filePath)) {
        console.warn(`[mediaService] video file://: not absolute path: "${filePath}"`)
        return null
      }
      if (!fs.existsSync(filePath)) {
        console.warn(`[mediaService] video file://: file not found: "${filePath}"`)
        return null
      }
      const st = fs.statSync(filePath)
      if (st.size > max) {
        console.warn(`[mediaService] video file://: ${(st.size / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB: "${filePath}"`)
        return null
      }
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${sourceExt(fileUrl) || '.mp4'}`)
      await fsp.copyFile(filePath, tmpPath)
      console.log(`[mediaService] video file:// → ${tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      void probeVideoSpec(tmpPath, st.size)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    // http(s):// 下载（带超时 + 流式大小闸 + 防盗链 UA）
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
      const mod = fileUrl.startsWith('https') ? https : http
      console.log(`[mediaService] video download start: ${fileUrl.slice(0, 80)}... (max ${Math.round(max / 1024 / 1024)}MB, timeout ${timeoutMs}ms)`)
      const result = await new Promise<{ tmpPath: string }>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; cleanup(); reject(new Error(`download timeout after ${timeoutMs}ms`)) }
        }, timeoutMs)
        const chunks: Buffer[] = []
        let total = 0
        let contentType: string | undefined
        // 防盗链防护：视频 CDN（B 站 upos 等）常校验 UA，裸 node UA 会返回 403
        const req = mod.get(fileUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          },
        }, (res) => {
          if (res.statusCode !== 200) {
            if (!settled) {
              settled = true; clearTimeout(timeout); cleanup()
              reject(new Error(`HTTP ${res.statusCode}${res.statusCode === 403 ? ' (可能被防盗链拒绝，检查 UA/Referer)' : ''}`))
            }
            return
          }
          contentType = res.headers['content-type']
          res.on('data', (c: Buffer) => {
            total += c.length
            if (total > max) {
              if (!settled) {
                settled = true; clearTimeout(timeout); cleanup()
                reject(new Error(`size exceeded: ${(total / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB`))
              }
              res.destroy()
              return
            }
            chunks.push(c)
          })
          res.on('end', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            const buf = Buffer.concat(chunks)
            let ext = sourceExt(fileUrl)
            if (!ext && contentType) {
              const ct = contentType.toLowerCase().split(';')[0].trim()
              if (ct === 'video/mp4') ext = '.mp4'
              else if (ct === 'video/x-matroska' || ct === 'video/webm') ext = '.mkv'
            }
            if (!ext) ext = detectVideoExt(buf) || '.mp4'
            const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${ext}`)
            fsp.writeFile(tmpPath, buf, { mode: 0o600 })
              .then(() => resolve({ tmpPath }))
              .catch(reject)
          })
          res.on('error', (e) => {
            if (!settled) { settled = true; clearTimeout(timeout); cleanup(); reject(new Error(`stream error: ${e.message}`)) }
          })
        })
        req.on('error', (e) => {
          if (!settled) { settled = true; clearTimeout(timeout); cleanup(); reject(new Error(`request error: ${e.message}`)) }
        })
        function cleanup(): void {
          // R1（2026-08-31 修复）：超时/非 200/超限分支此前只 reject 不销毁 socket，
          // 下载在后台继续、chunks 持续累积，低配容器内存被无声吃掉。
          // 现在销毁 req，连接立即释放；半成品未落盘（chunks 未写文件）无需删除。
          req.destroy()
        }
      })
      const st = await fsp.stat(result.tmpPath)
      console.log(`[mediaService] video download ok → ${result.tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      void probeVideoSpec(result.tmpPath, st.size)
      return { videoPath: result.tmpPath, mime: 'application/octet-stream' }
    }

    // 裸绝对路径（无 scheme；media_parser 同主机场景）
    if (fileUrl.startsWith('/')) {
      if (!fs.existsSync(fileUrl)) {
        console.warn(`[mediaService] video bare path: file not found: "${fileUrl}"`)
        return null
      }
      const st = fs.statSync(fileUrl)
      if (st.size > max) {
        console.warn(`[mediaService] video bare path: ${(st.size / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB: "${fileUrl}"`)
        return null
      }
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${sourceExt(fileUrl) || '.mp4'}`)
      await fsp.copyFile(fileUrl, tmpPath)
      console.log(`[mediaService] video bare path → ${tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      void probeVideoSpec(tmpPath, st.size)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    console.warn(`[mediaService] video source scheme not supported: ${fileUrl.slice(0, 80)}`)
    return null
  } catch (e) {
    console.error(`[mediaService] prepareVideoForSend failed after ${Date.now() - t0}ms:`, e)
    return null
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 图片出站归一 + 压缩（阶段 2，MEDIA-SERVICE-DESIGN §11）
 *
 * 收敛 main.ts / httpService 的两套图片归一为单一入口，内置分界点压缩。
 * REST / Linux 直连 / OneBot 三条路径均走本方法。
 *
 * 设计约束：本方法只产出「信号」（临时文件 + mime），剪贴板装载
 * 留在发送线程（linux.ts）同步执行。压缩按 imageMaxBytes 分界点触发，
 * PNG 优先、保分辨率，详见 §11.5。
 * ══════════════════════════════════════════════════════════════════ */

/** 图片大小上限（字节）——读 imageMaxBytes 配置（默认 5MB），与 httpService 硬闸共用 */
function imageMaxBytes(): number {
  try {
    const v = ConfigService.getInstance().get('imageMaxBytes')
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  } catch {}
  return 5 * 1024 * 1024
}

/** 是否启用图片压缩（默认 true；仅对 > 分界点的大图生效，小图直通） */
function imageCompressEnabled(): boolean {
  try { return ConfigService.getInstance().get('imageCompressEnabled') !== false } catch { return true }
}

/** 压缩产物是否保分辨率（默认 true 不降像素；用户显式开启才允许降分辨率） */
function imageCompressKeepResolution(): boolean {
  try { return ConfigService.getInstance().get('imageCompressKeepResolution') !== false } catch { return true }
}

/** 压缩格式（默认 'png'；'jpeg' 照片备选；'auto' 触发内容探测分流） */
function imageCompressFormat(): 'png' | 'jpeg' | 'auto' {
  try {
    const v = ConfigService.getInstance().get('imageCompressFormat')
    if (v === 'jpeg' || v === 'auto') return v
  } catch {}
  return 'png'
}

/** PNG 降位深最大色数（默认 256 近无损；低则更小但有色带） */
function imageCompressPaletteMax(): number {
  try {
    const v = ConfigService.getInstance().get('imageCompressPaletteMax')
    if (typeof v === 'number' && Number.isFinite(v) && v >= 2) return Math.floor(v)
  } catch {}
  return 256
}

/** URL 拉图超时（毫秒）——图片版修 main 无超时挂起缺陷，默认 15s */
function imageUrlTimeoutMs(): number {
  try {
    const v = ConfigService.getInstance().get('imageUrlTimeoutMs')
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  } catch {}
  return 15000
}

/** 从字节序列探测图片扩展名（与 httpService.detectImageExt 一致） */
function detectImageExt(buf: Buffer): string {
  if (!buf || buf.length < 12) return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif'
  if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp'
  return '.png'
}

/** 从文件扩展名推断图片 mime */
function detectImageMime(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

/** 计算 PNG 解码像素量（用于判断是否值得压缩；宽 * 高） */
function imagePixelCount(ffmpegBin: string, imagePath: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const { spawnSync } = require('child_process')
      const r = spawnSync(ffmpegBin, ['-hide_banner', '-i', imagePath], { timeout: 5000 })
      const out = (r.stderr || Buffer.from('')).toString('utf8')
      const m = /(\d+)x(\d+)/.exec(out)
      if (m) resolve(Number(m[1]) * Number(m[2]))
      else resolve(0)
    } catch { resolve(0) }
  })
}

/**
 * PNG 降位深到调色板（8 位索引色，近无损，保分辨率）。
 * 返回 null = 未能压缩（ffmpeg 缺失 / 非 PNG / 失败），调用方回落原样。
 */
function quantizePngToPalette(ffmpegBin: string, inputPath: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process')
      const maxColors = imageCompressPaletteMax()
      const palettePath = `${outputPath}_pal.png`
      const proc = spawn(ffmpegBin, [
        '-y', '-i', inputPath,
        '-vf', `palettegen=max_colors=${maxColors}`,
        palettePath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      proc.stderr.on('data', (c: Buffer) => { err += c.toString() })
      proc.on('close', (code: number) => {
        if (code !== 0 || !fs.existsSync(palettePath)) {
          try { fs.unlinkSync(palettePath) } catch {}
          resolve(false)
          return
        }
        const p2 = spawn(ffmpegBin, [
          '-y', '-i', inputPath, '-i', palettePath,
          '-lavfi', 'paletteuse', '-update', '1', outputPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err2 = ''
        p2.stderr.on('data', (c: Buffer) => { err2 += c.toString() })
        p2.on('close', (c2: number) => {
          try { fs.unlinkSync(palettePath) } catch {}
          if (c2 === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) resolve(true)
          else resolve(false)
        })
      })
    } catch { resolve(false) }
  })
}

/**
 * JPEG 保分辨率重编码（照片/高色深兜底，画质 q 由配置决定，默认 q95）。
 * 返回 null = 失败，调用方回落原样。
 */
function reencodeToJpeg(ffmpegBin: string, inputPath: string, outputPath: string, q: number, scaleRatio?: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process')
      const args = ['-y', '-i', inputPath]
      if (scaleRatio && scaleRatio > 0 && scaleRatio < 1) {
        // 降分辨率兜底（§11.5 -3）：按比例缩入宽边（-2 保证偶数，兼容 yuv420）
        args.push('-vf', `scale=${Math.round(scaleRatio * 100)}:-2`)
      }
      args.push('-q:v', String(q), '-update', '1', outputPath)
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      proc.stderr.on('data', (c: Buffer) => { err += c.toString() })
      proc.on('close', (code: number) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) resolve(true)
        else resolve(false)
      })
    } catch { resolve(false) }
  })
}

/** 获取 ffmpeg-static 路径（vite 会破坏 require('ffmpeg-static')，改为显式构造 unpacked 路径） */
function getFfmpegPath(): string | null {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates: string[] = []
  try {
    const resourcesPath = (process as any).resourcesPath
    if (resourcesPath) {
      candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', bin))
    }
  } catch {}
  candidates.push(path.join(process.cwd(), 'node_modules', 'ffmpeg-static', bin))
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return null
}

/**
 * 把单字符串来源智能分散到 ImageSource 对应字段：
 *   - base64:// / data:image/...;base64,  → base64
 *   - file:// / http(s)://               → url
 *   - 裸绝对路径（以 / 开头且存在）        → path
 * 其余 → url（交由归一尝试；不匹配则由调用方处理）。
 */
function parseImageSourceString(s: string): ImageSource {
  const str = String(s).trim()
  if (str.startsWith('base64://')) return { base64: str.slice(9) }
  if (str.startsWith('data:') && str.includes(';base64,')) { return { base64: str } }
  if (str.startsWith('file://') || str.startsWith('http://') || str.startsWith('https://')) return { url: str }
  if (str.startsWith('/') || str.startsWith('.')) return { path: str }
  return { url: str }
}

/**
 * 图片归一 + 压缩管线（主入口）。
 *
 * 四来源（与 httpService.prepareImageInput 对齐）+ 分界点压缩。
 * 返回 { imagePath, mime, compressed? } | null。
 *
 * - base64:// / data:image/...;base64,  → 字节内联
 * - file://（绝对路径）                 → 拷贝；跨主机请用 token/base64/url
 * - http(s)://                          → 带超时 + 流式大小闸 + UA（修 main 无超时挂起）
 * - 裸绝对路径                          → 仅同主机
 * - token（外部已落盘路径）             → 直用（httpService prepareImageInput 的 token 分支）
 */
export interface ImageSource {
  url?: string
  base64?: string
  token?: string
  path?: string
}

export async function prepareImageForSend(
  src: string | ImageSource
): Promise<{ imagePath: string; mime: string; compressed?: boolean } | null> {
  const t0 = Date.now()
  sweepOutboundTmpFiles()
  try {
    // 兼容字符串入参（OneBot / 旧调用只传 file:// 或裸路径）：智能分散到对应来源字段。
    const source: ImageSource = typeof src === 'string'
      ? parseImageSourceString(src)
      : (src || {})
    const max = imageMaxBytes()
    const timeoutMs = imageUrlTimeoutMs()

    let imagePath: string | null = null
    let mime = 'image/png'

    // token（外部已落盘文件）
    if (source.token) {
      if (source.token && fs.existsSync(source.token)) {
        imagePath = source.token
        mime = detectImageMime(imagePath)
      } else {
        console.warn(`[mediaService] image token file not found: "${source.token}"`)
        return null
      }
    }

    // base64 内联 
    if (!imagePath && source.base64) {
      const raw = String(source.base64)
      const b64 = raw.includes('base64,') ? raw.slice(raw.indexOf('base64,') + 7) : raw
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64.trim())) {
        console.warn('[mediaService] image base64: invalid chars')
        return null
      }
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0) return null
      if (buf.length > max) {
        console.warn(`[mediaService] image base64 too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > ${Math.round(max / 1024 / 1024)}MB)`)
        return null
      }
      const ext = detectImageExt(buf)
      const tmpPath = path.join(tmpdir(), `weflow_img_${randomUUID()}${ext}`)
      await fsp.writeFile(tmpPath, buf, { mode: 0o600 })
      imagePath = tmpPath
      mime = detectImageMime(imagePath)
    }

    // file:// URI
    if (!imagePath && source.url && source.url.startsWith('file://')) {
      let filePath: string
      try { filePath = decodeURIComponent(source.url.slice(7)) } catch { filePath = source.url.slice(7) }
      if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
        const tmpPath = path.join(tmpdir(), `weflow_img_${randomUUID()}${path.extname(filePath) || '.png'}`)
        await fsp.copyFile(filePath, tmpPath)
        imagePath = tmpPath
        mime = detectImageMime(imagePath)
      } else {
        console.warn(`[mediaService] image file:// not accessible: "${filePath}"`)
        return null
      }
    }

    // http(s):// 拉取（带超时 + 流式大小闸 + UA）
    if (!imagePath && source.url && (source.url.startsWith('http://') || source.url.startsWith('https://'))) {
      const mod = source.url.startsWith('https') ? https : http
      console.log(`[mediaService] image download start: ${source.url.slice(0, 90)}... (max ${Math.round(max / 1024 / 1024)}MB, timeout ${timeoutMs}ms)`)

      const result = await new Promise<{ tmpPath: string }>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; req.destroy(); reject(new Error(`image download timeout after ${timeoutMs}ms`)) }
        }, timeoutMs)
        const chunks: Buffer[] = []
        let total = 0
        let contentType: string | undefined
        const req = mod.get(source.url as string, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept': 'image/*,*/*;q=0.8',
          },
        }, (res) => {
          if (res.statusCode !== 200) {
            if (!settled) { settled = true; clearTimeout(timeout); req.destroy(); reject(new Error(`HTTP ${res.statusCode}`)) }
            return
          }
          contentType = res.headers['content-type']
          res.on('data', (c: Buffer) => {
            total += c.length
            if (total > max) {
              if (!settled) { settled = true; clearTimeout(timeout); req.destroy(); reject(new Error(`image size exceeded ${Math.round(max / 1024 / 1024)}MB`)) }
              res.destroy()
              return
            }
            chunks.push(c)
          })
          res.on('end', () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            const buf = Buffer.concat(chunks)
            let ext = detectImageExt(buf)
            if (!ext || ext === '.png') {
              const ct = (contentType || '').toLowerCase()
              if (ct.includes('jpeg')) ext = '.jpg'
              else if (ct.includes('gif')) ext = '.gif'
              else if (ct.includes('webp')) ext = '.webp'
            }
            const tmpPath = path.join(tmpdir(), `weflow_img_${randomUUID()}${ext}`)
            fsp.writeFile(tmpPath, buf, { mode: 0o600 })
              .then(() => resolve({ tmpPath }))
              .catch((e) => reject(e))
          })
          res.on('error', (e) => {
            if (!settled) { settled = true; clearTimeout(timeout); req.destroy(); reject(new Error(`stream error: ${e.message}`)) }
          })
        })
        req.on('error', (e) => {
          if (!settled) { settled = true; clearTimeout(timeout); req.destroy(); reject(new Error(`request error: ${e.message}`)) }
        })
      })
      const st = await fsp.stat(result.tmpPath)
      imagePath = result.tmpPath
      mime = detectImageMime(imagePath)
      console.log(`[mediaService] image download ok → ${imagePath} (${(st.size / 1024 / 1024).toFixed(2)}MB, ${Date.now() - t0}ms)`)
    }

    // 裸绝对路径
    if (!imagePath && source.path) {
      if (fs.existsSync(source.path)) {
        imagePath = source.path
        mime = detectImageMime(imagePath)
      } else {
        console.warn(`[mediaService] image path not found: "${source.path}"`)
        return null
      }
    }

    if (!imagePath) {
      console.warn('[mediaService] prepareImageForSend: no usable image source')
      return null
    }

    // 分界点压缩
    const st = fs.statSync(imagePath)
    let compressed = false
    const compressOn = imageCompressEnabled() && st.size > imageMaxBytes()

    if (compressOn) {
      const compressedPath = await tryCompressImage(imagePath, st.size)
      if (compressedPath && fs.existsSync(compressedPath)) {
        const compressedSize = fs.statSync(compressedPath).size
        if (compressedSize > 0 && compressedSize < st.size) {
          // 压缩成功且确实变小：替换路径。仅清理我们生成的归一临时产物（weflow_img_ 前缀），
          // 用户直传的原始文件（base64 内联/裸路径/token）绝不删除，避免破坏用户数据。
          if (path.basename(imagePath).startsWith('weflow_img_')) {
            try { fs.unlinkSync(imagePath) } catch {}
          }
          imagePath = compressedPath
          mime = detectImageMime(compressedPath)
          compressed = true
          console.log(`[mediaService] image compressed ${(st.size / 1024 / 1024).toFixed(2)}MB → ${(compressedSize / 1024 / 1024).toFixed(2)}MB (${mime})`)
        } else {
          try { fs.unlinkSync(compressedPath) } catch {}
        }
      } else if (compressedPath && fs.existsSync(compressedPath)) {
        try { fs.unlinkSync(compressedPath) } catch {}
      }
    }

    return { imagePath, mime, compressed }
  } catch (e) {
    console.error(`[mediaService] prepareImageForSend failed after ${Date.now() - t0}ms:`, e)
    return null
  }
}

/**
 * 图片压缩管线（§11.5）：仅在 > 分界点时调用。
 * 返回**压缩后新的文件路径**（成功）或 null（失败/跳过，调用方回落原样）。
 * 内容类型分流（§11.3/§11.5）：
 *   - PNG：优先降位深到调色板（近无损，保分辨率）；若变小失败则回落 JPEG 保分辨率；
 *   - JPEG/BMP：保分辨率重编码（照片场景，默认 q95）；
 *   - WEBP：微信不支持图片卡片（§11.4），回落到 JPEG 保分辨率；
 *   - GIF：动态图绝不重编码（丢动画），直接跳过（返回 null，原样发送）。
 *   - 若 imageCompressKeepResolution=false（用户显式开启降分辨率），允许缩放像素降低体积。
 */
async function tryCompressImage(imagePath: string, size: number): Promise<string | null> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    console.warn('[mediaService] ffmpeg unavailable, skip image compress, send original')
    return null
  }
  const format = imageCompressFormat()
  const keepResolution = imageCompressKeepResolution()
  const origExt = path.extname(imagePath).toLowerCase()
  const outPath = path.join(tmpdir(), `weflow_comp_${randomUUID()}`)

  // GIF 动态图绝不能重编码（会丢动画），直接原样发送
  if (origExt === '.gif') {
    console.warn('[mediaService] image is animated GIF, skip compress')
    return null
  }

  // 格式分流：manual='jpeg' 直接走 JPEG；否则 PNG 先降位深，失败再回落 JPEG
  const preferPng = format === 'png' || format === 'auto'

  try {
    // PNG 优先降位深（近无损、保分辨率）；失败则回落 JPEG
    if (preferPng && origExt === '.png') {
      const palPath = `${outPath}_pal.png`
      const ok = await quantizePngToPalette(ffmpeg, imagePath, palPath)
      if (ok && fs.existsSync(palPath) && fs.statSync(palPath).size > 0 && fs.statSync(palPath).size < size) {
        return palPath
      }
      try { if (fs.existsSync(palPath)) fs.unlinkSync(palPath) } catch {}
    }

    // JPEG 保分辨率重编码（照片/高色深）
    const jpgPath = `${outPath}.jpg`
    const jok = await reencodeToJpeg(ffmpeg, imagePath, jpgPath, 95)
    if (jok && fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0 && fs.statSync(jpgPath).size < size) {
      return jpgPath
    }
    try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath) } catch {}

    // 仅显式开启降分辨率时才缩放像素兜底
    if (!keepResolution) {
      const scaledPath = `${outPath}_scaled.jpg`
      const ok = await reencodeToJpeg(ffmpeg, imagePath, scaledPath, 92, 0.6)
      if (ok && fs.existsSync(scaledPath) && fs.statSync(scaledPath).size > 0 && fs.statSync(scaledPath).size < size) {
        return scaledPath
      }
      try { if (fs.existsSync(scaledPath)) fs.unlinkSync(scaledPath) } catch {}
    }

    return null
  } catch {
    return null
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 入站合并转发条目媒体还原（INBOUND-FORWARD-PUSH-PLAN-PHASE2 §3.1 P1）
 *
 * 输入：chatService 解析出的 raw dataitem（aeskey / dataurl / cdn 字段等）。
 * 输出：挂到 DTO item 上的 media_* 结构化字段（wire 契约 snake_case）。
 * 原则：推送不内联 base64——本地产物由 server.js 注册 token 直链（emoji 例外，
 * 直接透传微信 CDN 直链，与常规 emoji_url 同消费方式）；单条失败不阻断文本行；
 * 不触发微信下载（cdnFetch 除外，且受 imageCdnDirectFetchEnabled + 风控门禁约束）。
 * 还原产物落 tmpdir（weflow_fwd_ 前缀，24h 惰性清扫）。
 * ══════════════════════════════════════════════════════════════════ */

export type ForwardMediaKind = 'image' | 'video' | 'voice' | 'file' | 'emoji'

/** DTO item 媒体挂载目标（字段名与 chatService.ForwardItemDTO / PHASE2 §3.1.1 契约一致） */
export interface ForwardMediaAttachTarget {
  datatype?: number
  media_kind?: ForwardMediaKind
  media_url?: string
  media_thumb_url?: string
  media_duration_sec?: number
  media_bytes?: number
  media_md5?: string
  media_available?: boolean
  media_error?: string
  media_token_ttl_ms?: number
  media_path?: string
  media_thumb_path?: string
  chat_record_items?: any[]
}

/** raw dataitem 媒体原料（chatService.parseForwardChatRecordDataItem 输出子集） */
interface ForwardMediaRaw {
  dataurl?: string
  datathumburl?: string
  datacdnurl?: string
  cdnthumburl?: string
  cdndatakey?: string
  cdnthumbkey?: string
  aeskey?: string
  md5?: string
  fullmd5?: string
  thumbfullmd5?: string
  datasize?: number
  thumbsize?: number
  duration?: number
  sourcetime?: string
  srcMsgCreateTime?: number
  externurl?: string
  cdnurlstring?: string
  encrypturlstring?: string
  chatRecordList?: any[]
}

interface ForwardItemMediaResult {
  kind: ForwardMediaKind
  path?: string
  thumbPath?: string
  url?: string
  durationSec?: number
  bytes?: number
  md5?: string
  available: boolean
  error?: string
}

const FORWARD_MEDIA_KIND_BY_DATATYPE: Record<number, ForwardMediaKind> = {
  2: 'image', // 相片（真实数据实证与 datatype=3 同映射）
  3: 'image',
  34: 'voice',
  43: 'video',
  37: 'emoji', // 動態貼圖（uiemoticon 表情族，实测 datatype=37）
  47: 'emoji',
  8: 'file',
  49: 'file'
}

/** 单事件媒体还原总时间闸默认值（毫秒）——以 config `forwardMediaTimeoutMs` 为准（默认 3000）。
 * 实测无闸时含图转发的缩略下载等待会把推送阻塞 30s，此闸保护投递延迟。 */
const FORWARD_MEDIA_DEFAULT_TIMEOUT_MS = 3000
const FORWARD_MEDIA_DOWNLOAD_TIMEOUT_MS = 15000
const FORWARD_MEDIA_VIDEO_TIMEOUT_MS = 20000
const FORWARD_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const FORWARD_THUMB_MAX_BYTES = 2 * 1024 * 1024

/** 下载地址门禁（安全红线）：只允许公网 http(s)；封禁环回 / 私网 / 链路本地 / IPv6 字面量 */
function isPublicHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(String(rawUrl || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    if (!host) return false
    if (host.includes(':')) return false // IPv6 字面量一律拒绝（CDN 均为域名/IPv4）
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    if (m) {
      const a = Number(m[1]); const b = Number(m[2])
      if (a === 0 || a === 10 || a === 127 || a >= 224) return false
      if (a === 169 && b === 254) return false
      if (a === 172 && b >= 16 && b <= 31) return false
      if (a === 192 && b === 168) return false
    }
    return true
  } catch {
    return false
  }
}

/** 图片魔数门禁（与 snsService.isValidImageBuffer 同构）：解密结果必须是合法图片头 */
function isValidForwardImageMagic(buf: Buffer): boolean {
  if (!buf || buf.length < 12) return false
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true
  return false
}

function detectForwardImageExt(buf: Buffer): string | null {
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png'
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp'
  return null
}

/** 密钥派生（与 snsService.buildKeyTries 同构：hex-decode / utf8-16 / md5 / base64） */
function buildForwardAesKeyTries(aesKey: string): Buffer[] {
  const key = String(aesKey || '')
  if (!key) return []
  const tries: Buffer[] = []
  const hexStr = key.replace(/\s/g, '')
  if (hexStr.length >= 32 && /^[0-9a-fA-F]+$/.test(hexStr)) {
    try {
      const keyBuf = Buffer.from(hexStr.slice(0, 32), 'hex')
      if (keyBuf.length === 16) tries.push(keyBuf)
    } catch { /* 非法 hex 跳过 */ }
  }
  if (key.length >= 16) tries.push(Buffer.from(key, 'utf8').subarray(0, 16))
  tries.push(createHash('md5').update(key).digest())
  try {
    const b64Buf = Buffer.from(key, 'base64')
    if (b64Buf.length >= 16) tries.push(b64Buf.subarray(0, 16))
  } catch { /* 非法 base64 跳过 */ }
  return tries
}

/** 复合密钥字段（cdnthumbkey / cdndatakey）："key-加密段长-总长" → 取 key 与加密前缀长 */
function parseCompositeCdnKey(value?: string): { key: string; encPrefixLen?: number } {
  const raw = String(value || '').trim()
  if (!raw) return { key: '' }
  const parts = raw.split('-')
  const key = (parts[0] || '').trim()
  let encPrefixLen: number | undefined
  const n = parseInt(parts[1] || '', 10)
  if (Number.isFinite(n) && n > 0 && n % 16 === 0) encPrefixLen = n
  return { key, encPrefixLen }
}

/** 4.x 的 cdndataurl / cdnthumburl 是 DER filekey（hex blob）而非 URL——据此形态分流 */
function isHexFileKey(value: string): boolean {
  const s = String(value || '').trim()
  return s.length >= 32 && /^[0-9a-fA-F]+$/.test(s)
}

/**
 * 微信 CDN 媒体 blob 解密尝试（魔数门禁：结果必须是合法图片头才被接受）。
 * 同构于 snsService.decryptEmojiAes（ciphertalk 逆向实现）的收敛子集：
 * 分段前缀布局（cdnthumbkey 段长）/ 整段 ECB / CBC(IV=key) / CBC(IV=头 16B)。
 */
function tryDecryptForwardImageBlob(encData: Buffer, keyMaterials: string[], encPrefixLen?: number): Buffer | null {
  if (!encData || encData.length < 16) return null
  const keys: Buffer[] = []
  for (const material of keyMaterials) {
    for (const k of buildForwardAesKeyTries(material)) {
      if (k.length === 16 && !keys.some((ex) => ex.equals(k))) keys.push(k)
    }
  }
  for (const key of keys) {
    // ① 分段布局：[encPrefixLen 密文][其后明文]
    if (encPrefixLen && encPrefixLen > 0 && encPrefixLen <= encData.length && encPrefixLen % 16 === 0) {
      try {
        const dec = createDecipheriv('aes-128-ecb', key, null)
        dec.setAutoPadding(false)
        const head = Buffer.concat([dec.update(encData.subarray(0, encPrefixLen)), dec.final()])
        const merged = Buffer.concat([head, encData.subarray(encPrefixLen)])
        if (isValidForwardImageMagic(merged)) return merged
      } catch { /* 尝试下一个 */ }
    }
    if (encData.length % 16 !== 0) continue
    // ② 整段 ECB
    try {
      const dec = createDecipheriv('aes-128-ecb', key, null)
      dec.setAutoPadding(false)
      const out = Buffer.concat([dec.update(encData), dec.final()])
      if (isValidForwardImageMagic(out)) return out
    } catch { /* 尝试下一个 */ }
    // ③ CBC：IV = key
    try {
      const dec = createDecipheriv('aes-128-cbc', key, key)
      dec.setAutoPadding(true)
      const out = Buffer.concat([dec.update(encData), dec.final()])
      if (isValidForwardImageMagic(out)) return out
    } catch { /* 尝试下一个 */ }
    // ④ CBC：IV = 头 16 字节
    if (encData.length > 32) {
      try {
        const dec = createDecipheriv('aes-128-cbc', key, encData.subarray(0, 16))
        dec.setAutoPadding(true)
        const out = Buffer.concat([dec.update(encData.subarray(16)), dec.final()])
        if (isValidForwardImageMagic(out)) return out
      } catch { /* 尝试下一个 */ }
    }
  }
  return null
}

/** 明文（合法图片魔数）直接可用；否则按密钥材料尝试解密 */
function normalizeForwardImageBuffer(buf: Buffer, keyMaterials: string[], encPrefixLen?: number): Buffer | null {
  if (!buf || buf.length === 0) return null
  if (isValidForwardImageMagic(buf)) return buf
  return tryDecryptForwardImageBlob(buf, keyMaterials, encPrefixLen)
}

/** http(s) 下载（超时 + 大小闸 + 防盗链 UA + 有限跳转）；destPath 给定时流式落盘 */
async function downloadForwardHttp(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; destPath?: string; redirectsLeft?: number }
): Promise<{ buf?: Buffer; destPath?: string; bytes: number }> {
  const redirectsLeft = opts.redirectsLeft ?? 3
  const mod = url.startsWith('https') ? https : http
  return await new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fileHandle: fsp.FileHandle | undefined
    const chunks: Buffer[] = []
    let total = 0
    let outStream: fs.WriteStream | undefined
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    const fail = (err: Error): void => {
      settle(() => {
        try { outStream?.destroy() } catch { /* 忽略 */ }
        void fileHandle?.close().catch(() => undefined)
        if (opts.destPath) { try { fs.unlinkSync(opts.destPath) } catch { /* 半成品可能不存在 */ } }
        reject(err)
      })
    }
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, (res) => {
      const code = res.statusCode || 0
      if (code >= 301 && code <= 308 && res.headers.location) {
        settle(() => {
          req.destroy()
          res.resume()
          if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return }
          const next = new URL(res.headers.location as string, url).toString()
          downloadForwardHttp(next, { ...opts, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject)
        })
        return
      }
      if (code !== 200) {
        fail(new Error(`HTTP ${code}`))
        return
      }
      if (opts.destPath) {
        outStream = fs.createWriteStream(opts.destPath, { mode: 0o600 })
        outStream.on('error', (e: Error) => fail(e))
      }
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > opts.maxBytes) {
          fail(new Error(`size exceeded: ${total} > ${opts.maxBytes}`))
          res.destroy()
          return
        }
        if (outStream) outStream.write(c)
        else chunks.push(c)
      })
      res.on('end', () => {
        settle(() => {
          if (outStream) {
            outStream.end(() => resolve({ destPath: opts.destPath, bytes: total }))
          } else {
            resolve({ buf: Buffer.concat(chunks), bytes: total })
          }
        })
      })
      res.on('error', (e: Error) => fail(e))
    })
    timer = setTimeout(() => {
      fail(new Error(`download timeout after ${opts.timeoutMs}ms`))
      req.destroy()
    }, opts.timeoutMs)
    req.on('error', (e: Error) => fail(e))
  })
}

async function writeForwardMediaTmp(buf: Buffer, ext: string): Promise<string> {
  const tmpPath = path.join(tmpdir(), `weflow_fwd_${randomUUID()}${ext}`)
  await fsp.writeFile(tmpPath, buf, { mode: 0o600 })
  return tmpPath
}

/** 条目源消息时间 → ms（cdnFetch 仅增量门禁输入）：srcMsgCreateTime（unix 秒）优先，
 * sourcetime 容错解析次之（"2026-9-22 21:15" 非补零格式，Date 严格解析会 NaN），最后回退转发消息时间 */
function forwardItemCreateTimeMs(raw: ForwardMediaRaw, fallbackSec: number): number {
  const t = Number(raw.srcMsgCreateTime)
  if (Number.isFinite(t) && t > 0) return Math.floor(t) * 1000
  const s = String(raw.sourcetime || '').trim()
  if (s) {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
    if (m) {
      const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || '0')).getTime()
      if (Number.isFinite(ms) && ms > 0) return ms
    }
  }
  return Math.floor(Number(fallbackSec) || 0) * 1000
}

/** 缩略/封面还原（PHASE2 P1 §3.1.3 + 方案 A，2026-09-22 拍板）：
 * URL 形态 → https 直下；DER hex 形态（4.x cdnthumburl 实测）→ thumb cdnFetch。
 * **免年龄闸**——"仅增量"门禁的本意是"超龄消息永久降级缩略图"，而转发场景缩略不在本地、
 * 必须走 CDN 才能兑现该降级；单 filekey 单次 + 限流闸照旧兜底。 */
async function resolveForwardThumbnail(
  raw: ForwardMediaRaw,
  deadlineAt: number
): Promise<{ path?: string; error?: string; rejected?: boolean }> {
  const timeLeft = (): number => Math.max(0, deadlineAt - Date.now())
  const thumbUrl = raw.datathumburl && isPublicHttpUrl(raw.datathumburl) ? raw.datathumburl : ''
  const thumbKey = isHexFileKey(raw.cdnthumburl || '')
    ? raw.cdnthumburl
    : (isHexFileKey(raw.datathumburl || '') ? raw.datathumburl : '')
  if (raw.datathumburl && !thumbUrl && !thumbKey) return { rejected: true }
  if (thumbUrl) {
    try {
      const r = await downloadForwardHttp(thumbUrl, { maxBytes: FORWARD_THUMB_MAX_BYTES, timeoutMs: Math.min(FORWARD_MEDIA_DOWNLOAD_TIMEOUT_MS, Math.max(200, timeLeft())) })
      const comp = parseCompositeCdnKey(raw.cdnthumbkey)
      const keyMaterials = [comp.key, raw.cdndatakey || '', raw.aeskey || ''].filter(Boolean) as string[]
      const img = r.buf ? normalizeForwardImageBuffer(r.buf, keyMaterials, comp.encPrefixLen) : null
      if (img) return { path: await writeForwardMediaTmp(img, detectForwardImageExt(img) || '.jpg') }
      return { error: 'decode_failed' }
    } catch {
      return { error: 'download_failed' }
    }
  }
  if (thumbKey) {
    const thumbAes = raw.cdnthumbkey || raw.cdndatakey || raw.aeskey || ''
    const thumbLen = Number(raw.thumbsize) || 0
    if (ConfigService.getInstance().get('imageCdnDirectFetchEnabled') !== true) return { error: 'cdn_unavailable' }
    if (!thumbAes || !(thumbLen > 0)) return { error: 'cdn_unavailable' }
    try {
      const r = await cdnFetchService.fetch({
        fileKey: String(thumbKey),
        aesKey: String(thumbAes),
        fileLen: thumbLen,
        fullPath: cdnFetchService.buildSavePath(raw.thumbfullmd5 || 'fwdthumb'),
        md5: raw.thumbfullmd5,
        // 方案 A：缩略免年龄闸，不传 messageCreateTime（单 key 单次 + 限流仍在）
        messageCreateTime: undefined,
        timeoutMs: Math.max(200, timeLeft())
      })
      if (r.success && r.localPath) return { path: r.localPath }
      return { error: r.error || 'cdn_failed' }
    } catch {
      return { error: 'cdn_failed' }
    }
  }
  return {}
}

async function resolveOneForwardMedia(
  raw: ForwardMediaRaw,
  kind: ForwardMediaKind,
  opts: { messageCreateTimeSec: number; deadlineAt: number }
): Promise<ForwardItemMediaResult> {
  const md5 = String(raw.fullmd5 || raw.md5 || '') || undefined
  const durationRaw = Number(raw.duration)
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : undefined
  // 相位剩余时间：所有下载/直取的单次上限都不超过它（延时闸 forwardMediaTimeoutMs 的传导）
  const timeLeft = (): number => Math.max(0, opts.deadlineAt - Date.now())

  if (kind === 'voice') {
    // 转发内嵌语音常缺少可定位的 silk blob（PHASE2 §3.1.4-2），本期不承诺还原
    return { kind, durationSec, md5, available: false, error: 'not_recoverable' }
  }
  if (kind === 'file') {
    // 文件本体默认不还原（PHASE2 §3.1.3：体积/权限），仅保留描述字段
    return { kind, available: false, error: 'skipped' }
  }
  if (kind === 'emoji') {
    // 表情/動態貼圖：微信 CDN 直链透传（47 dataurl/datathumburl；37 externurl/cdnurlstring/encrypturlstring）
    let sawRejected = false
    let url = ''
    for (const u of [raw.dataurl, raw.datathumburl, raw.externurl, raw.cdnurlstring, raw.encrypturlstring]) {
      if (!u) continue
      if (isPublicHttpUrl(u)) { url = u; break }
      sawRejected = true
    }
    if (url) return { kind, url, md5, available: true }
    return { kind, md5, available: false, error: sawRejected ? 'url_rejected' : 'no_source' }
  }

  let lastError: string | undefined
  let sawRejected = false

  if (kind === 'image') {
    // 含图还原开关（forwardImageMediaEnabled，WebUI「媒体链路」可关）：该能力尚不完善
    //（老图受仅增量门禁、缩略直取待修）——关闭时图片条目零 I/O 直接降级占位，文本行不受影响
    if (ConfigService.getInstance().get('forwardImageMediaEnabled') !== true) {
      return { kind, md5, durationSec, available: false, error: 'skipped' }
    }
    let imgPath: string | undefined
    // ① 无风控直链（dataurl；datacdnurl 为真实 URL 形态时同用）
    const bodyUrls = [raw.dataurl, isHexFileKey(raw.datacdnurl || '') ? undefined : raw.datacdnurl]
    for (const u of bodyUrls) {
      if (!u) continue
      if (!isPublicHttpUrl(u)) { sawRejected = true; continue }
      try {
        const r = await downloadForwardHttp(u, { maxBytes: FORWARD_IMAGE_MAX_BYTES, timeoutMs: Math.min(FORWARD_MEDIA_DOWNLOAD_TIMEOUT_MS, Math.max(200, timeLeft())) })
        const comp = parseCompositeCdnKey(raw.cdndatakey)
        const keyMaterials = [comp.key, raw.aeskey || ''].filter(Boolean) as string[]
        const img = r.buf ? normalizeForwardImageBuffer(r.buf, keyMaterials, comp.encPrefixLen) : null
        if (img) {
          imgPath = await writeForwardMediaTmp(img, detectForwardImageExt(img) || '.jpg')
          break
        }
        lastError = 'decode_failed'
      } catch {
        lastError = 'download_failed'
      }
    }
    // ② cdnFetch 正文（4.x 实测原料：fileKey=datacdnurl/DER、aesKey=cdndatakey、fileLen=datasize；
    // 幻影字段 aeskey 只作旧版兜底）。受 imageCdnDirectFetchEnabled + 仅增量年龄闸（方案 A 保闸）
    const bodyFileKey = isHexFileKey(raw.datacdnurl || '') ? String(raw.datacdnurl) : ''
    const bodyAesKey = String(raw.cdndatakey || raw.aeskey || '')
    const bodyFileLen = Number(raw.datasize) || 0
    if (!imgPath && (bodyFileKey || bodyAesKey)) {
      if (ConfigService.getInstance().get('imageCdnDirectFetchEnabled') !== true || !(bodyFileKey && bodyAesKey && bodyFileLen > 0)) {
        lastError = lastError || 'cdn_unavailable'
      } else {
        try {
          const r = await cdnFetchService.fetch({
            fileKey: bodyFileKey,
            aesKey: bodyAesKey,
            fileLen: bodyFileLen,
            fullPath: cdnFetchService.buildSavePath(raw.fullmd5 || raw.md5 || 'fwdimg'),
            md5: raw.md5,
            messageCreateTime: forwardItemCreateTimeMs(raw, opts.messageCreateTimeSec),
            timeoutMs: Math.max(200, timeLeft())
          })
          if (r.success && r.localPath) {
            imgPath = r.localPath
          } else {
            lastError = lastError || r.error || 'cdn_failed'
          }
        } catch {
          lastError = lastError || 'cdn_failed'
        }
      }
    }
    // ③ 缩略降级（URL 直下 / DER hex 走 thumb cdnFetch，免年龄闸）
    let thumbPath: string | undefined
    let thumbError: string | undefined
    if (!imgPath) {
      const thumb = await resolveForwardThumbnail(raw, opts.deadlineAt)
      thumbPath = thumb.path
      thumbError = thumb.error
      if (thumb.rejected) sawRejected = true
    }
    let bytes: number | undefined
    if (imgPath) {
      try { bytes = fs.statSync(imgPath).size } catch { /* stat 失败不阻断 */ }
    }
    return {
      kind,
      path: imgPath,
      thumbPath,
      bytes,
      md5,
      durationSec,
      available: !!imgPath,
      // thumb 成功优先标 thumb_only；失败时报 thumb 的真实错误（不被正文错误遮蔽），
      // 再退正文错误 / 来源分流
      error: imgPath ? undefined
        : thumbPath ? 'thumb_only'
        : (thumbError || lastError || (sawRejected ? 'url_rejected' : 'no_source'))
    }
  }

  // kind === 'video'
  let videoPath: string | undefined
  let thumbPath: string | undefined
  // ① 本地视频缓存（videoService 按 md5；同 resolveInboundVideo 复用产物）
  if (md5) {
    try {
      const info = await videoService.getVideoInfo(md5, { includePoster: true, posterFormat: 'fileUrl' })
      if (info?.exists && info.videoUrl && fs.existsSync(info.videoUrl)) {
        videoPath = info.videoUrl
        if (info.coverUrl && info.coverUrl.startsWith('file://')) {
          try {
            const coverPath = fileURLToPath(info.coverUrl)
            if (fs.existsSync(coverPath)) thumbPath = coverPath
          } catch { /* 封面路径解析失败不阻断 */ }
        }
      }
    } catch { /* 缓存查询失败继续 */ }
  }
  // ② dataurl 下载（体积闸 videoMaxBytes）
  if (!videoPath && raw.dataurl) {
    if (!isPublicHttpUrl(raw.dataurl)) {
      sawRejected = true
    } else {
      try {
        const dest = path.join(tmpdir(), `weflow_fwd_${randomUUID()}.mp4`)
        await downloadForwardHttp(raw.dataurl, {
          maxBytes: videoMaxBytes(),
          timeoutMs: Math.min(FORWARD_MEDIA_VIDEO_TIMEOUT_MS, Math.max(200, timeLeft())),
          destPath: dest
        })
        videoPath = dest
        try {
          const head = Buffer.alloc(16)
          const fd = await fsp.open(dest, 'r')
          try { await fd.read(head, 0, 16, 0) } finally { await fd.close() }
          const ext = detectVideoExt(head)
          if (ext && ext !== '.mp4') {
            const renamed = dest.replace(/\.mp4$/, ext)
            await fsp.rename(dest, renamed)
            videoPath = renamed
          }
        } catch { /* 探测失败保持 .mp4 */ }
      } catch (e) {
        lastError = /size exceeded/.test(String(e)) ? 'too_large' : 'download_failed'
      }
    }
  }
  // ③ 封面（URL 直下 / DER hex 走 thumb cdnFetch；body 成败都提供——Video 段 cover 独立有用）
  let thumbError: string | undefined
  if (!thumbPath) {
    const thumb = await resolveForwardThumbnail(raw, opts.deadlineAt)
    thumbPath = thumb.path
    thumbError = thumb.error
    if (thumb.rejected) sawRejected = true
  }
  let bytes: number | undefined
  if (videoPath) {
    try { bytes = fs.statSync(videoPath).size } catch { /* stat 失败不阻断 */ }
  }
  return {
    kind,
    path: videoPath,
    thumbPath,
    bytes,
    md5,
    durationSec,
    available: !!videoPath,
    error: videoPath ? undefined
      : thumbPath ? 'thumb_only'
      : (thumbError || lastError || (sawRejected ? 'url_rejected' : 'no_source'))
  }
}

/** 转发条目媒体还原编排（PHASE2 §4.2.2）：深度优先、预算内尽力、单条失败不阻断。
 * 延时闸：整相位（含单条在途尝试）受 timeoutMs 硬超时（config forwardMediaTimeoutMs，默认 3s），
 * 超时条目 media_error:'skipped'——保护推送投递延迟（实测无闸时含图转发阻塞 30s）。 */
export async function resolveForwardMediaForItems(
  items: ForwardMediaAttachTarget[],
  rawItems: any[],
  opts: { maxMedia: number; messageCreateTimeSec: number; timeoutMs?: number }
): Promise<void> {
  const maxMedia = Number.isFinite(opts.maxMedia) && opts.maxMedia > 0 ? Math.floor(opts.maxMedia) : 20
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? Math.floor(opts.timeoutMs as number)
    : FORWARD_MEDIA_DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let budget = maxMedia

  const attach = (item: ForwardMediaAttachTarget, r: ForwardItemMediaResult): void => {
    item.media_kind = r.kind
    item.media_available = r.available === true
    if (r.error) item.media_error = r.error
    if (r.path) item.media_path = r.path
    if (r.thumbPath) item.media_thumb_path = r.thumbPath
    if (r.url) item.media_url = r.url
    if (Number.isFinite(r.durationSec)) item.media_duration_sec = r.durationSec
    if (Number.isFinite(r.bytes)) item.media_bytes = r.bytes
    if (r.md5) item.media_md5 = r.md5
  }

  const walk = async (nodes: ForwardMediaAttachTarget[], raws: any[]): Promise<void> => {
    for (let i = 0; i < nodes.length; i++) {
      const item = nodes[i]
      if (!item || typeof item !== 'object') continue
      const raw = (raws && raws[i]) || undefined
      const kind = FORWARD_MEDIA_KIND_BY_DATATYPE[Number(item.datatype) || 0]
      if (kind) {
        const needsBudget = kind === 'image' || kind === 'video'
        if (needsBudget && (budget <= 0 || Date.now() > deadline)) {
          attach(item, { kind, available: false, error: 'skipped' })
        } else {
          if (needsBudget) budget -= 1
          const remaining = deadline - Date.now()
          let result: ForwardItemMediaResult
          if (remaining <= 0) {
            result = { kind, available: false, error: 'skipped' }
          } else {
            // 单条硬超时竞速：在途下载/直取（如 thumb cdnFetch 的微信进程等待）不得突破延时闸
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              result = await Promise.race([
                resolveOneForwardMedia((raw && typeof raw === 'object') ? raw as ForwardMediaRaw : {}, kind, {
                  messageCreateTimeSec: opts.messageCreateTimeSec,
                  deadlineAt: deadline
                }),
                new Promise<ForwardItemMediaResult>((resolve) => {
                  timer = setTimeout(() => resolve({ kind, available: false, error: 'skipped' }), remaining)
                })
              ])
            } catch {
              result = { kind, available: false, error: 'resolve_exception' }
            } finally {
              if (timer) clearTimeout(timer)
            }
          }
          attach(item, result)
          // 诊断日志（ADAPTER-FORWARD-MEDIA-NOSOURCE §5.1）：原料/结果一览，定位 no_source 与错误遮蔽类问题
          const rawAny = (raw && typeof raw === 'object') ? raw as any : {}
          console.log(`[ForwardMedia] kind=${kind} ok=${result.available === true} err=${result.error || '-'} body=${!!result.path} thumb=${!!result.thumbPath} url=${!!result.url} has_dataurl=${!!rawAny.dataurl} has_cdnkey=${!!(rawAny.cdndatakey || rawAny.aeskey)} has_filekey=${isHexFileKey(rawAny.datacdnurl || '')} has_thumbkey=${isHexFileKey(rawAny.cdnthumburl || '')} datasize=${Number(rawAny.datasize) || 0} thumbsize=${Number(rawAny.thumbsize) || 0}`)
        }
      }
      if (Array.isArray(item.chat_record_items) && item.chat_record_items.length > 0) {
        const nestedRaw = raw && typeof raw === 'object' ? (raw as any).chatRecordList : undefined
        await walk(item.chat_record_items, Array.isArray(nestedRaw) ? nestedRaw : [])
      }
    }
  }

  await walk(items, rawItems || [])
}

