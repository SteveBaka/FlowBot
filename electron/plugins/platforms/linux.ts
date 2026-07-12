import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import type { IPlatformSender } from '../enhancedMessageSender'
import type { SendMode, SendTask, SendProgress } from './types'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const log = (msg: string) => console.log(`[LinuxSender] ${msg}`)
const warn = (msg: string) => console.warn(`[LinuxSender] ${msg}`)

const WECHAT_WINDOW_NAMES = ['Weixin', 'WeChat', 'wechat', '微信', 'WeChatAppEx', 'WMPF']

const DISPLAY_ENV = { ...process.env, DISPLAY: process.env.DISPLAY || ':99', PATH: '/usr/bin:/usr/sbin:/bin:/sbin:/usr/local/bin:' + (process.env.PATH || '') }

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500
const INTER_MESSAGE_DELAY_MS = 800
const POST_SEND_SETTLE_MS = 500
const INPUT_CLICK_DELAY_MS = 200

interface QueuedMessage {
  id: string
  content: string
  contactName: string
  imagePath?: string
  resolve: (result: { success: boolean; error?: string; method: string }) => void
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

async function xclipSet(text: any): Promise<void> {
  const str = String(text || '')
  if (!str) return
  const escaped = str.replace(/'/g, "'\\''")
  try {
    await execAsync(`echo -n '${escaped}' | PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -silent`, {
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
    await execAsync(`PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t ${mime} -i "${imagePath.replace(/"/g, '\\"')}"`, {
      timeout: 5000,
      env: DISPLAY_ENV
    })
    return true
  } catch (e) {
    warn(`xclipSetImage failed (${mime}): ${e}`)
    if (mime !== 'image/bmp') {
      try {
        await execAsync(`PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -t image/bmp -i "${imagePath.replace(/"/g, '\\"')}"`, {
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

export class LinuxSender implements IPlatformSender {
  private queue: QueuedMessage[] = []
  private processing = false
  private currentMode: SendMode = 'foreground'
  private lastSendTime = 0
  private cachedWid = ''

  setMode(mode: SendMode): void { this.currentMode = mode }

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
      const { execSync } = require('child_process')
      const result = execSync(`python3 /opt/pinyin.py '${text.replace(/'/g, "'\\''")}'`, {
        timeout: 3000,
        encoding: 'utf-8',
        env: DISPLAY_ENV
      }).trim()
      return result || text
    } catch {
      return text
    }
  }

  private async searchAndSelectContact(contactName: string, wid: string): Promise<boolean> {
    log(`Opening search with Ctrl+F...`)
    await run(`xdotool key --window "${wid}" ctrl+f`)
    await new Promise(r => setTimeout(r, 400))

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
      await new Promise(r => setTimeout(r, 100))
      await run(`xdotool key --window "${wid}" ctrl+v`)
    }
    await new Promise(r => setTimeout(r, 600))

    log(`Pressing Enter to select first result...`)
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, 400))

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
    await new Promise(r => setTimeout(r, 80))
    await run(`xdotool click 1`)
    await new Promise(r => setTimeout(r, INPUT_CLICK_DELAY_MS))
  }

  private async pasteAndSend(content: string, wid: string, imagePath?: string): Promise<boolean> {
    if (imagePath) {
      log(`Pasting image: ${imagePath}`)
      const ok = await xclipSetImage(imagePath)
      if (!ok) {
        warn('xclipSetImage failed, falling back to text')
        await xclipSet(content)
      }
      await new Promise(r => setTimeout(r, 200))
      await run(`xdotool key --window "${wid}" ctrl+v`)
      await new Promise(r => setTimeout(r, 500))
    } else {
      log(`Pasting message (${content.length} chars)...`)
      await xclipSet(content)
      await new Promise(r => setTimeout(r, 100))
      await run(`xdotool key --window "${wid}" ctrl+v`)
      await new Promise(r => setTimeout(r, 300))
    }

    log(`Pressing Enter to send...`)
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, POST_SEND_SETTLE_MS))

    log('Message sent successfully')
    return true
  }

  private async doSend(content: string, contactName: string, imagePath?: string): Promise<{ success: boolean; error?: string }> {
    const wid = await this.findWeChatWindow()
    if (!wid) {
      return { success: false, error: '找不到微信窗口' }
    }

    return this.doSendWithWindow(content, contactName, wid, imagePath)
  }

  private async doSendWithWindow(content: string, contactName: string, wid: string, imagePath?: string): Promise<{ success: boolean; error?: string }> {
    if (!await this.activateWindow(wid)) {
      return { success: false, error: '无法激活微信窗口' }
    }

    log(`Searching contact "${contactName}"...`)
    if (!await this.searchAndSelectContact(contactName, wid)) {
      return { success: false, error: '搜索联系人失败' }
    }

    if (!imagePath) {
      await this.ensureFocusInInput(wid)
    }

    if (!await this.pasteAndSend(content, wid, imagePath)) {
      return { success: false, error: '粘贴发送失败' }
    }

    this.lastSendTime = Date.now()
    return { success: true }
  }

  async sendMessage(content: string, contactName?: string, imagePath?: string): Promise<{
    success: boolean; error?: string; method: string
  }> {
    const str = String(content || '')
    const name = String(contactName || '')
    if (!name) {
      warn('No contact name provided')
      return { success: false, error: '联系人名称未提供', method: this.currentMode }
    }

    return new Promise((resolve) => {
      const item: QueuedMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: str,
        contactName: name,
        imagePath,
        resolve,
        retries: 0,
        createdAt: Date.now()
      }
      this.queue.push(item)
      log(`Queued message ${item.id} for "${name}"${imagePath ? ' [IMAGE]' : ''} (queue size: ${this.queue.length})`)
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const item = this.queue[0]

      const elapsed = Date.now() - this.lastSendTime
      if (elapsed < INTER_MESSAGE_DELAY_MS) {
        const wait = INTER_MESSAGE_DELAY_MS - elapsed
        log(`Waiting ${wait}ms before next send...`)
        await new Promise(r => setTimeout(r, wait))
      }

      log(`Processing message ${item.id} (attempt ${item.retries + 1}/${MAX_RETRIES})${item.imagePath ? ' [IMAGE]' : ''}`)

      let result: { success: boolean; error?: string }
      try {
        result = await this.doSend(item.content, item.contactName, item.imagePath)
      } catch (e: any) {
        result = { success: false, error: e?.message || 'Unknown error' }
      }

      if (result.success) {
        log(`Message ${item.id} sent successfully`)
        item.resolve({ success: true, method: this.currentMode })
        this.queue.shift()
      } else {
        item.retries++
        if (item.retries >= MAX_RETRIES) {
          warn(`Message ${item.id} failed after ${MAX_RETRIES} attempts: ${result.error}`)
          item.resolve({ success: false, error: `发送失败（重试${MAX_RETRIES}次）: ${result.error}`, method: this.currentMode })
          this.queue.shift()
        } else {
          warn(`Message ${item.id} failed (attempt ${item.retries}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`)
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        }
      }
    }

    this.processing = false
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

  getProgress(): SendProgress {
    return {
      total: this.queue.length,
      sent: 0,
      failed: 0,
      current: this.queue[0]?.content
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
