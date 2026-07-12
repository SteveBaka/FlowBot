/**
 * 消息发送器平台接口定义
 * 各平台（Windows / macOS / Linux）必须实现这些类型
 */

export type SendMode = 'foreground' | 'background'

export interface SendTask {
  id: string
  sessionId: string
  content: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  error?: string
  createdAt: number
  sentAt?: number
  imagePath?: string
}

export interface SendProgress {
  total: number
  sent: number
  failed: number
  current?: string
}
