/**
 * 出站媒体归一 —— 视频/文件发送来源统一
 *
 * 职责：base64:// / http(s):// / file:// / 裸绝对路径 四种来源 → /tmp/weflow_obv_<uuid>.<ext>
 * 设计边界：零转换——视频字节原样落盘原样粘贴，不转码不改字节、不做格式白名单；
 *           唯一目标是让微信能正常粘贴。发送结果由文件是否为合法有效视频决定
 *           （合法视频→视频卡片，否则→文件卡片），见 VIDEO-SEND-DESIGN §1.1。
 *
 * 独立文件原因：与 main.ts（4800+ 行）及 httpService 均有依赖，独立模块避免循环导入。
 * 图片的 prepareImageForSend 本次不动（两套归一层平行是已知现状，见设计文档第十一节后续演进）。
 */
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
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
    console.warn('[outboundMedia] prepareVideoForSend: empty fileUrl')
    return null
  }
  if (!isEnabled()) {
    console.warn('[outboundMedia] prepareVideoForSend: videoSendEnabled=false, skipped')
    return null
  }
  const max = videoMaxBytes()
  const timeoutMs = videoUrlTimeoutMs()
  const t0 = Date.now()
  try {
    // ── base64:// ───────────────────────────────────────────────
    if (fileUrl.startsWith('base64://')) {
      const b64 = fileUrl.slice(9)
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0) {
        console.warn('[outboundMedia] video base64: empty after decode')
        return null
      }
      if (buf.length > max) {
        console.warn(`[outboundMedia] video base64: ${(buf.length / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB`)
        return null
      }
      const ext = detectVideoExt(buf) || '.mp4'
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${ext}`)
      await fsp.writeFile(tmpPath, buf, { mode: 0o600 })
      console.log(`[outboundMedia] video base64 → ${tmpPath} (${(buf.length / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    // ── file:// URI ─────────────────────────────────────────────
    if (fileUrl.startsWith('file://')) {
      let filePath: string
      try { filePath = decodeURIComponent(fileUrl.slice(7)) } catch { filePath = fileUrl.slice(7) }
      if (!path.isAbsolute(filePath)) {
        console.warn(`[outboundMedia] video file://: not absolute path: "${filePath}"`)
        return null
      }
      if (!fs.existsSync(filePath)) {
        console.warn(`[outboundMedia] video file://: file not found: "${filePath}"`)
        return null
      }
      const st = fs.statSync(filePath)
      if (st.size > max) {
        console.warn(`[outboundMedia] video file://: ${(st.size / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB: "${filePath}"`)
        return null
      }
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${sourceExt(fileUrl) || '.mp4'}`)
      await fsp.copyFile(filePath, tmpPath)
      console.log(`[outboundMedia] video file:// → ${tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    // ── http(s):// 下载（带超时 + 流式大小闸 + 防盗链 UA）──────────
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
      const mod = fileUrl.startsWith('https') ? https : http
      console.log(`[outboundMedia] video download start: ${fileUrl.slice(0, 80)}... (max ${Math.round(max / 1024 / 1024)}MB, timeout ${timeoutMs}ms)`)
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
      console.log(`[outboundMedia] video download ok → ${result.tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      return { videoPath: result.tmpPath, mime: 'application/octet-stream' }
    }

    // ── 裸绝对路径（无 scheme；media_parser 同主机场景）────────────
    if (fileUrl.startsWith('/')) {
      if (!fs.existsSync(fileUrl)) {
        console.warn(`[outboundMedia] video bare path: file not found: "${fileUrl}"`)
        return null
      }
      const st = fs.statSync(fileUrl)
      if (st.size > max) {
        console.warn(`[outboundMedia] video bare path: ${(st.size / 1024 / 1024).toFixed(1)}MB > max ${Math.round(max / 1024 / 1024)}MB: "${fileUrl}"`)
        return null
      }
      const tmpPath = path.join(tmpdir(), `weflow_obv_${randomUUID()}${sourceExt(fileUrl) || '.mp4'}`)
      await fsp.copyFile(fileUrl, tmpPath)
      console.log(`[outboundMedia] video bare path → ${tmpPath} (${(st.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
      return { videoPath: tmpPath, mime: 'application/octet-stream' }
    }

    console.warn(`[outboundMedia] video source scheme not supported: ${fileUrl.slice(0, 80)}`)
    return null
  } catch (e) {
    console.error(`[outboundMedia] prepareVideoForSend failed after ${Date.now() - t0}ms:`, e)
    return null
  }
}
