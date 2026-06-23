import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  WeChatHookPlugin,
  MessageType,
  HookStatus,
  ReadOptions,
  SendOptions,
  SendResult,
  Message,
  HookState,
  PluginMetadata,
  PluginCapabilities,
  PluginEventCallbacks,
} from './plugin-interface'

const execFileAsync = promisify(execFile)

export class LinuxMessageHookService extends EventEmitter implements WeChatHookPlugin {
  metadata: PluginMetadata = {
    name: 'linux-wechat-hook',
    version: '1.0.0',
    description: 'WeChat message hook for Linux (clipboard-based)',
    author: 'WeFlow',
    platform: ['linux'],
    minWeChatVersion: '4.0.0',
  }

  capabilities: PluginCapabilities = {
    canReadMessages: false,
    canSendMessage: true,
    canReadContacts: false,
    canReadGroups: false,
    supportedMessageTypes: [MessageType.Text],
  }

  private hookState: HookState = { status: HookStatus.Uninitialized }
  private callbacks: PluginEventCallbacks = {}

  constructor() {
    super()
  }

  async onLoad(): Promise<void> {
    console.log('[LinuxMessageHook] Loading plugin...')
    this.hookState = { status: HookStatus.Uninstalled }
  }

  async onUnload(): Promise<void> {
    console.log('[LinuxMessageHook] Unloading plugin...')
    this.hookState = { status: HookStatus.Uninitialized }
  }

  async onHookInstalled(): Promise<void> {
    console.log('[LinuxMessageHook] Hook installed (Linux clipboard mode)')
  }

  async onHookUninstalled(): Promise<void> {
    console.log('[LinuxMessageHook] Hook uninstalled')
  }

  async installHook(_pid: number): Promise<boolean> {
    this.hookState = {
      status: HookStatus.Installed,
      pid: _pid,
      lastActivity: Date.now(),
    }
    this.emit('status', this.hookState)
    return true
  }

  async uninstallHook(): Promise<boolean> {
    this.hookState = { status: HookStatus.Uninstalled }
    this.emit('status', this.hookState)
    return true
  }

  getHookState(): HookState {
    return { ...this.hookState }
  }

  async readMessages(_options: ReadOptions): Promise<Message[]> {
    return []
  }

  async sendMessage(options: SendOptions): Promise<SendResult> {
    if (options.type !== MessageType.Text || !options.content) {
      return {
        success: false,
        error: 'Only text messages are supported on Linux',
        timestamp: Date.now(),
      }
    }

    try {
      await this.sendViaClipboard(options.content)
      return {
        success: true,
        messageId: `linux_${Date.now()}`,
        timestamp: Date.now(),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      }
    }
  }

  private async sendViaClipboard(text: string): Promise<void> {
    try {
      await execFileAsync('xclip', ['-selection', 'clipboard'], { input: text })
    } catch {
      try {
        await execFileAsync('xsel', ['--clipboard', '--input'], { input: text })
      } catch (e) {
        throw new Error('No clipboard tool found (xclip or xsel)')
      }
    }
  }

  on(event: 'message', callback: (msg: Message) => void): void
  on(event: 'status', callback: (status: HookState) => void): void
  on(event: 'error', callback: (error: Error) => void): void
  on(event: string, callback: Function): void {
    super.on(event, callback as any)
  }

  off(event: string, callback: Function): void {
    super.off(event, callback)
  }
}

let instance: LinuxMessageHookService | null = null

export function getLinuxMessageHookService(): LinuxMessageHookService {
  if (!instance) {
    instance = new LinuxMessageHookService()
  }
  return instance
}
