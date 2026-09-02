/**
 * mediaService —— 媒体出站统一入口（视频/文件四来源归一 + 图片归一压缩）
 *
 * 收敛 outboundMediaService / main.ts / httpService 散落的媒体处理。阶段规划见
 * MEDIA-SERVICE-DESIGN.md §六；本模块只产出「信号」（临时文件 + mime），
 * 剪贴板装载（xclip）留在发送线程（linux.ts）同步执行。
 */
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { execFile } from 'child_process'
import { ConfigService } from './config'

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

