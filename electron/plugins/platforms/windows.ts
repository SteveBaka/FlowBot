/**
 * Windows 平台消息发送实现
 *
 * 通过 koffi FFI 调用 Win32 API：
 * - FindWindowW / EnumWindows（按进程名 weixin.exe 查找窗口）
 * - SetForegroundWindow + ShowWindow（激活窗口）
 * - keybd_event（模拟 Ctrl+F 搜索、Ctrl+V 粘贴、Enter 发送）
 *
 * WeChat 4.0 是 UWP 应用，PostMessage/SendMessage 无法注入键盘输入，
 * 后台模式暂不支持（PostMessage 方案已验证不可行）。
 */
import { clipboard } from 'electron';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { IPlatformSender } from '../enhancedMessageSender';
import type { SendMode, SendTask, SendProgress } from './types';

const LOG_DIR = join(process.env.APPDATA || '', 'weflow-alpha', 'logs');
const LOG_FILE = join(LOG_DIR, 'send.log');

function sendLog(msg: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ─── 键盘虚拟键码 ───────────────────────────────────────────
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_RETURN = 0x0D;
const VK_V = 0x56;
const VK_F = 0x46;

// ─── 微信进程/窗口常量 ──────────────────────────────────────
const WECHAT_CLASS_NAMES = [
  'WeChatMainWndForPC', 'WeixinMainWnd', 'ChatWnd', 'WeChat', 'Weixin',
];

const WECHAT_PROCESS_NAMES = [
  'weixin.exe', 'wechat.exe',
];

export class WindowsSender implements IPlatformSender {
  private koffi: any = null
  private user32: any = null
  private initialized = false

  private FindWindowW: any = null
  private SetForegroundWindow: any = null
  private ShowWindow: any = null
  private keybd_event: any = null
  private EnumWindows: any = null
  private WNDENUMPROC: any = null
  private GetWindowThreadProcessId: any = null
  private OpenProcess: any = null
  private QueryFullProcessImageNameW: any = null
  private CloseHandle: any = null

  private queue: SendTask[] = []
  private processing = false
  private currentMode: SendMode = 'foreground'

  // ─── koffi 初始化 ──────────────────────────────────────────
  // 所有 HWND 参数统一用 void*（uintptr_t 会导致 FindWindowW 返回 0）
  private ensureInitialized(): boolean {
    if (this.initialized) return true
    try {
      this.koffi = require('koffi')
      this.user32 = this.koffi.load('user32.dll')

      this.FindWindowW = this.user32.func('void* FindWindowW(uint16* className, uint16* windowName)')
      this.SetForegroundWindow = this.user32.func('bool SetForegroundWindow(void* hWnd)')
      this.ShowWindow = this.user32.func('bool ShowWindow(void* hWnd, int nCmdShow)')
      this.keybd_event = this.user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)')

      this.WNDENUMPROC = this.koffi.proto('bool __stdcall (void* hWnd, intptr_t lParam)')
      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.koffi.pointer(this.WNDENUMPROC), 'intptr_t'])
      this.GetWindowThreadProcessId = this.user32.func('uint32 GetWindowThreadProcessId(void* hWnd, uint32* lpdwProcessId)')

      const kernel32 = this.koffi.load('kernel32.dll')
      this.OpenProcess = kernel32.func('void* OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)')
      this.QueryFullProcessImageNameW = kernel32.func('int QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, uint16* lpExeName, uint32* lpdwSize)')
      this.CloseHandle = kernel32.func('int CloseHandle(void* hObject)')

      this.initialized = true
      return true
    } catch (error) {
      sendLog(`ensureInitialized FAILED: ${error}`)
      console.error('[WindowsSender] Init failed:', error)
      return false
    }
  }

  setMode(mode: SendMode): void { this.currentMode = mode }

  // ─── 窗口查找 ─────────────────────────────────────────────
  // WeChat 4.0 是 UWP 应用，FindWindowW 按类名找不到
  // 必须通过进程名匹配 weixin.exe / wechat.exe
  private getWindowProcessName(hWnd: any): string | null {
    try {
      const pidBuf = new Uint32Array(1)
      this.GetWindowThreadProcessId(hWnd, pidBuf)
      const pid = pidBuf[0]
      if (!pid) return null
      const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
      const hProcess = this.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!hProcess) return null
      try {
        const sizeBuf = new Uint32Array(1)
        sizeBuf[0] = 260
        const nameBuf = Buffer.alloc(520)
        const ok = this.QueryFullProcessImageNameW(hProcess, 0, nameBuf, sizeBuf)
        if (!ok) return null
        const fullName = nameBuf.toString('utf16le').replace(/\0/g, '')
        return fullName.split('\\').pop() || null
      } finally {
        this.CloseHandle(hProcess)
      }
    } catch { return null }
  }

  private findWeChatWindow(): any {
    if (!this.ensureInitialized()) return null

    // 先尝试传统类名（兼容旧版微信）
    for (const className of WECHAT_CLASS_NAMES) {
      const buf = Buffer.from(className + '\0', 'ucs2')
      const hWnd = this.FindWindowW(buf, null)
      if (hWnd) return hWnd
    }

    // WeChat 4.0：通过进程名查找
    let foundHwnd: any = null
    this.EnumWindows((hWnd: any) => {
      if (foundHwnd) return true
      try {
        const procName = this.getWindowProcessName(hWnd)
        if (!procName) return true
        const lower = procName.toLowerCase()
        for (const expected of WECHAT_PROCESS_NAMES) {
          if (lower === expected) {
            foundHwnd = hWnd
            return false
          }
        }
      } catch {}
      return true
    }, 0)

    return foundHwnd
  }

  // ─── 键盘辅助 ─────────────────────────────────────────────
  private keyDown(vk: number): void {
    this.keybd_event(vk, 0, 0, 0)
  }

  private keyUp(vk: number): void {
    this.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
  }

  private async pressKey(vk: number, delay = 30): Promise<void> {
    this.keyDown(vk)
    await new Promise(r => setTimeout(r, delay))
    this.keyUp(vk)
    await new Promise(r => setTimeout(r, delay))
  }

  private async pressHotkey(vk1: number, vk2: number): Promise<void> {
    this.keyDown(vk1)
    await new Promise(r => setTimeout(r, 20))
    this.keyDown(vk2)
    await new Promise(r => setTimeout(r, 20))
    this.keyUp(vk2)
    await new Promise(r => setTimeout(r, 20))
    this.keyUp(vk1)
    await new Promise(r => setTimeout(r, 30))
  }

  private async typeText(text: string): Promise<void> {
    clipboard.writeText(text)
    await new Promise(r => setTimeout(r, 50))
    await this.pressHotkey(VK_CONTROL, VK_V)
  }

  // ─── 前台模式（已验证可用） ────────────────────────────────
  private activateWindow(hWnd: any): void {
    try {
      this.ShowWindow(hWnd, 9) // SW_RESTORE
      this.SetForegroundWindow(hWnd)
    } catch (e) {
      console.error('[WindowsSender] activateWindow error:', e)
    }
  }

  private async searchAndSelectContact(contactName: string): Promise<void> {
    await this.pressHotkey(VK_CONTROL, VK_F)       // Ctrl+F 打开搜索
    await new Promise(r => setTimeout(r, 300))
    await this.typeText(contactName)                // 输入搜索词
    await new Promise(r => setTimeout(r, 500))
    await this.pressKey(VK_RETURN, 30)              // Enter 选中
    await new Promise(r => setTimeout(r, 300))
  }

  private async pasteAndSend(content: string): Promise<void> {
    const original = clipboard.readText()
    clipboard.writeText(content)
    await new Promise(r => setTimeout(r, 50))
    await this.pressHotkey(VK_CONTROL, VK_V)        // Ctrl+V 粘贴消息
    await new Promise(r => setTimeout(r, 100))
    await this.pressKey(VK_RETURN, 30)              // Enter 发送
    await new Promise(r => setTimeout(r, 200))
    if (original) clipboard.writeText(original)
  }

  private async sendToContact(content: string, hWnd: any, contactName: string): Promise<boolean> {
    try {
      this.activateWindow(hWnd)
      await new Promise(r => setTimeout(r, 200))
      await this.searchAndSelectContact(contactName)
      await this.pasteAndSend(content)
      return true
    } catch (error) {
      sendLog(`sendToContact ERROR: ${error}`)
      return false
    }
  }

  // ─── 后台模式（测试中） ────────────────────────────────────
  // WeChat 4.0 (UWP) 不响应 PostMessage/SendMessage 键盘输入
  // 当前复用前台逻辑，后续可通过 UI Automation 实现真正后台
  private async sendInBackground(content: string, hWnd: any, contactName: string): Promise<boolean> {
    return this.sendToContact(content, hWnd, contactName)
  }

  // ─── 公开接口 ─────────────────────────────────────────────
  async sendMessage(content: string, contactName?: string, imagePath?: string): Promise<{
    success: boolean; error?: string; method: string
  }> {
    try {
      const hWnd = this.findWeChatWindow()
      if (!hWnd) {
        return { success: false, error: 'WeChat window not found', method: this.currentMode }
      }
      if (!contactName) {
        return { success: false, error: 'Contact name not provided', method: this.currentMode }
      }

      let success: boolean
      if (this.currentMode === 'background') {
        success = await this.sendInBackground(content, hWnd, contactName)
      } else {
        success = await this.sendToContact(content, hWnd, contactName)
      }
      return { success, method: this.currentMode, error: success ? undefined : 'Send failed' }
    } catch (error) {
      sendLog(`sendMessage ERROR: ${error}`)
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
      task.status = 'failed'
      task.error = 'Batch send not supported with search mode'
      task.sentAt = Date.now()
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

  isWeChatRunning(): boolean { return this.findWeChatWindow() !== null }
}
