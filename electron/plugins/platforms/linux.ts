/**
 * Linux 平台消息发送实现
 *
 * 通过 xdotool + xclip 实现：
 * - xdotool search（查找 WeChat 窗口）
 * - xdotool windowactivate（激活窗口）
 * - xclip -selection clipboard（设置剪贴板）
 * - xdotool key（模拟 Ctrl+V 粘贴、Enter 发送）
 */
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

async function xclipSet(text: string): Promise<void> {
  // execFile + input: xclip 会因为 stdin 关闭而退出，剪贴板内容丢失
  // 改用 shell 管道，确保 xclip 持有剪贴板
  const escaped = text.replace(/'/g, "'\\''")
  try {
    await execAsync(`echo -n '${escaped}' | PATH=/usr/bin:/usr/local/bin xclip -selection clipboard -silent`, {
      timeout: 3000,
      env: DISPLAY_ENV
    })
  } catch (e) {
    warn(`xclip failed: ${e}`)
    try {
      await execFileAsync('xsel', ['--clipboard', '--input'], { input: text, env: DISPLAY_ENV, timeout: 3000 })
    } catch (e2) {
      warn(`xsel also failed: ${e2}`)
    }
  }
}

export class LinuxSender implements IPlatformSender {
  private queue: SendTask[] = []
  private processing = false
  private currentMode: SendMode = 'foreground'

  setMode(mode: SendMode): void { this.currentMode = mode }

  private async findWeChatWindow(): Promise<string> {
    const display = process.env.DISPLAY || ':99'
    log(`Searching WeChat window (DISPLAY=${display})...`)

    // 先验证 xdotool 可用
    const version = await run(`xdotool version`)
    log(`xdotool version: ${version || 'NOT FOUND'}`)
    if (!version) {
      warn('xdotool not found or not working')
      return ''
    }

    // 验证 X 连接
    const info = await run(`xdotool getdisplaygeometry`)
    log(`Display geometry: ${info || 'FAILED'}`)

    // 1. 按窗口名搜索
    for (const name of WECHAT_WINDOW_NAMES) {
      const result = await run(`xdotool search --name "${name}"`)
      const wid = result.split('\n').filter(Boolean)[0] || ''
      if (wid) {
        log(`Found window by name "${name}": ${wid}`)
        return wid
      }
    }

    // 2. 按窗口类名搜索
    for (const cls of ['wechat', 'WeChat', 'WMPF', 'Weixin']) {
      const result = await run(`xdotool search --class "${cls}"`)
      const wid = result.split('\n').filter(Boolean)[0] || ''
      if (wid) {
        log(`Found window by class "${cls}": ${wid}`)
        return wid
      }
    }

    // 4. 检查进程
    const pid = await run('pidof wechat')
    if (pid) {
      warn(`WeChat process running (PID: ${pid}) but no window found`)
    } else {
      warn('WeChat process not found')
    }

    return ''
  }

  private async activateWindow(wid: string): Promise<void> {
    log(`Activating window ${wid}...`)
    await run(`xdotool windowactivate --sync "${wid}"`)
    await run(`xdotool windowfocus --sync "${wid}"`)
    await new Promise(r => setTimeout(r, 200))
  }

  private async searchAndSelectContact(contactName: string, wid: string): Promise<void> {
    log(`Step 1: Opening search with Ctrl+F...`)
    await run(`xdotool key --window "${wid}" ctrl+f`)
    await new Promise(r => setTimeout(r, 300))

    log(`Step 2: Clearing search field...`)
    await run(`xdotool key --window "${wid}" ctrl+a`)
    await new Promise(r => setTimeout(r, 100))

    log(`Step 3: Typing contact name: "${contactName}"`)
    if (contactName.length <= 50) {
      await run(`xdotool type --window "${wid}" --delay 50 "${contactName}"`)
    } else {
      await xclipSet(contactName)
      await new Promise(r => setTimeout(r, 100))
      await run(`xdotool key --window "${wid}" ctrl+v`)
    }
    await new Promise(r => setTimeout(r, 800))

    log(`Step 4: Pressing Enter to select first result...`)
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, 300))

    log(`Search complete for contact: "${contactName}"`)
  }

  private async pasteAndSend(content: string, wid: string): Promise<void> {
    log(`Step 5: Pasting message (${content.length} chars)...`)
    await xclipSet(content)
    await new Promise(r => setTimeout(r, 100))
    await run(`xdotool key --window "${wid}" ctrl+v`)
    await new Promise(r => setTimeout(r, 150))

    log(`Step 6: Pressing Enter to send...`)
    await run(`xdotool key --window "${wid}" Return`)
    await new Promise(r => setTimeout(r, 200))

    log('Message sent successfully')
  }

  private async sendToContact(content: string, contactName: string): Promise<boolean> {
    const wid = await this.findWeChatWindow()
    if (!wid) {
      warn('WeChat window not found — cannot send message')
      return false
    }
    await this.activateWindow(wid)
    await this.searchAndSelectContact(contactName, wid)
    await this.pasteAndSend(content, wid)
    return true
  }

  async sendMessage(content: string, contactName?: string): Promise<{
    success: boolean; error?: string; method: string
  }> {
    try {
      if (!contactName) {
        warn('No contact name provided')
        return { success: false, error: '联系人名称未提供', method: this.currentMode }
      }
      log(`sendMessage: contact="${contactName}", content=${content.substring(0, 50)}...`)
      const success = await this.sendToContact(content, contactName)
      return { success, method: this.currentMode, error: success ? undefined : '发送失败：找不到微信窗口或窗口未就绪' }
    } catch (error) {
      log(`sendMessage ERROR: ${error}`)
      return { success: false, error: error instanceof Error ? error.message : String(error), method: this.currentMode }
    }
  }

  async sendBatch(tasks: Array<{ sessionId: string; content: string }>): Promise<SendProgress> {
    const newTasks: SendTask[] = tasks.map(t => ({
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: t.sessionId, content: t.content,
      status: 'pending' as const, createdAt: Date.now(),
    }))
    this.queue.push(...newTasks)
    await this.processQueue()
    return this.getProgress()
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true
    while (this.queue.length > 0) {
      const task = this.queue.find(t => t.status === 'pending')
      if (!task) break
      task.status = 'sending'
      try {
        const success = await this.sendToContact(task.content, task.sessionId)
        task.status = success ? 'sent' : 'failed'
        if (!success) task.error = '发送失败'
        task.sentAt = Date.now()
      } catch (e: any) {
        task.status = 'failed'
        task.error = e?.message || '发送失败'
        task.sentAt = Date.now()
      }
      await new Promise(r => setTimeout(r, 300))
    }
    this.processing = false
  }

  cancelPending(): number {
    let count = 0
    for (const task of this.queue) {
      if (task.status === 'pending') { task.status = 'failed'; task.error = 'Cancelled'; count++ }
    }
    return count
  }

  getProgress(): SendProgress {
    const total = this.queue.length
    const sent = this.queue.filter(t => t.status === 'sent').length
    const failed = this.queue.filter(t => t.status === 'failed').length
    const current = this.queue.find(t => t.status === 'sending')
    return { total, sent, failed, current: current?.content }
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
