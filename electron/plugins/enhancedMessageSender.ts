/**
 * 增强消息发送器 — 平台抽象层
 *
 * 根据 process.platform 自动选择对应平台实现：
 * - win32 → platforms/windows.ts（koffi FFI + keybd_event）
 * - darwin → platforms/macos.ts（待实现）
 * - linux → platforms/linux.ts（待实现）
 *
 * 各平台实现必须提供相同的 IPlatformSender 接口。
 * 备份文件：enhancedMessageSender.foreground-only.ts（Windows 前台模式快照）
 */

import type { SendMode, SendTask, SendProgress } from './platforms/types'

export type { SendMode, SendTask, SendProgress }

export interface IPlatformSender {
  setMode(mode: SendMode): void
  sendMessage(content: string, contactName?: string): Promise<{ success: boolean; error?: string; method: string }>
  sendBatch(tasks: Array<{ sessionId: string; content: string }>): Promise<SendProgress>
  cancelPending(): number
  getProgress(): SendProgress
  isWeChatRunning(): boolean
}

let cachedSender: IPlatformSender | null = null

export function getEnhancedMessageSender(): IPlatformSender {
  if (cachedSender) return cachedSender

  switch (process.platform) {
    case 'win32': {
      const { WindowsSender } = require('./platforms/windows')
      cachedSender = new WindowsSender()
      break
    }
    // case 'darwin': { ... }
    // case 'linux': { ... }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }

  return cachedSender
}
