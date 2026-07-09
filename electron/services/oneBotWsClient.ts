/**
 * OneBot v11 反向 WebSocket 客户端
 *
 * 连接到外部 WS Server（如 AstrBot），实现双向通信：
 * - 入站：外部 server 发送 API 请求（send_private_msg 等）→ WeFlow 执行
 * - 出站：WeFlow 新消息 → 推送到外部 server
 *
 * AstrBot 架构：
 *   AstrBot (WS Server :6199) ←── WeFlow (WS Client)
 *   WeFlow 主动连接 ws://host:port/ws
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { logger } from './logger'

export interface OneBotMessage {
  time: number
  self_id: string
  post_type: string
  message_type: string
  message_id: number
  user_id: number
  group_id?: number
  message: Array<{ type: string; data: Record<string, string> }>
  raw_message: string
  sender: { user_id: number; nickname: string; card?: string }
}

export interface OneBotWsClientConfig {
  id: string
  name: string
  url: string           // e.g. ws://192.168.1.100:6199/ws
  token?: string
  selfId: string
  reconnectIntervalMs?: number
  maxReconnectAttempts?: number
}

interface MessageBuffer {
  time: number
  self_id: string
  post_type: string
  message_type: string
  message_id: number
  user_id: number
  group_id?: number
  message: Array<{ type: string; data: Record<string, string> }>
  raw_message: string
  sender: { user_id: number; nickname: string }
}

export class OneBotWsClient extends EventEmitter {
  private config: OneBotWsClientConfig
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private messageBuffer: MessageBuffer[] = []
  private broadcastTimer: ReturnType<typeof setInterval> | null = null
  private messageIdCounter = 0
  private connected = false
  private reconnectAttempts = 0
  private maxReconnect: number

  constructor(config: OneBotWsClientConfig) {
    super()
    this.config = config
    this.maxReconnect = config.maxReconnectAttempts || 5
  }

  async connect(): Promise<void> {
    const url = this.config.url
    const headers: Record<string, string> = {
      'User-Agent': 'OneBot/11',
      'X-Self-ID': this.config.selfId || 'weflow',
      'X-Client-Role': 'Universal',
    }
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`
    }

    log(`Connecting to ${url} with X-Self-ID=${this.config.selfId}...`)

    this.ws = new WebSocket(url, {
      headers,
      handshakeTimeout: 10000,
    })

    this.ws.on('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      log(`Connected to ${url}`)
      this.emit('connected')
      this.stopHeartbeat()
      this.startBroadcast()
      this.sendMetaEvent('connect')
    })

    this.ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data.toString())
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false
      this.stopHeartbeat()
      this.stopBroadcast()
      const reasonStr = reason?.toString() || ''
      log(`Disconnected: code=${code} reason=${reasonStr}`)
      this.emit('disconnected', { code, reason: reasonStr })
      this.scheduleReconnect()
    })

    this.ws.on('error', (error: Error) => {
      warn(`WebSocket error: ${error.message}`)
      // Don't emit error to prevent UI dialogs
    })
  }

  private handleMessage(raw: string): void {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      warn('Failed to parse WebSocket message')
      return
    }

    // 外部 server 发来的 API 请求
    if (msg.action) {
      this.handleApiRequest(msg)
      return
    }

    // 其他消息类型（通知等）
    log(`Received unknown message: ${JSON.stringify(msg).substring(0, 100)}`)
  }

  private handleApiRequest(request: { action: string; params?: any; echo?: any }): void {
    const { action, params = {}, echo } = request
    log(`API request: ${action}`)

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const ack: any = { status: 'ok', retcode: 0, data: null, echo: echo }
      if (action === 'get_status') {
        ack.data = { online: true, good: true }
      } else if (action === 'get_version_info') {
        ack.data = { app_name: 'WeFlow', app_version: '4.6.1', protocol_version: 'v11.0' }
      } else if (action === 'get_login_info') {
        ack.data = { user_id: Number(this.config.selfId) || 0, nickname: '' }
      } else if (action === 'get_group_member_info') {
        ack.data = {
          group_id: params.group_id,
          user_id: params.user_id,
          nickname: '',
          card: '',
          sex: 'unknown',
          age: 0,
          area: '',
          join_time: 0,
          last_sent_time: 0,
          level: 'normal',
          role: 'member',
          unfriendly: false,
          title: '',
          title_expire_time: 0,
          nickname_changeable: true
        }
      } else if (action === 'get_stranger_info') {
        ack.data = {
          user_id: params.user_id,
          nickname: '',
          sex: 'unknown',
          age: 0,
          area: '',
          level: 'normal',
        }
      } else {
        ack.data = { message_id: Math.floor(Date.now()) }
      }
      try {
        this.ws.send(JSON.stringify(ack))
        log(`Sent ack: action=${action} echo=${echo || 'none'}`)
      } catch (e) {
        warn(`Failed to send ack: ${e}`)
      }
    }

    if (action === 'send_private_msg' || action === 'send_group_msg' || action === 'send_msg') {
      this.emit('api', { action, params })
    }
  }

  public sendResponse(response: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      warn('WebSocket not connected, cannot send response')
      return
    }
    try {
      this.ws.send(JSON.stringify(response))
      log(`Sent response: ${JSON.stringify(response).substring(0, 200)}`)
    } catch (e) {
      warn(`Failed to send response: ${e}`)
    }
  }

  public   pushMessage(event: OneBotMessage | any): void {
    this.messageBuffer.push(event as any)
  }

  public pushMessageImmediate(msg: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      warn('WebSocket not connected, cannot push message')
      return
    }
    try {
      const payload = typeof msg === 'string' ? msg : JSON.stringify(msg)
      this.ws.send(payload)
      log(`Pushed message: ${payload.substring(0, 200)}`)
    } catch (e) {
      warn(`Failed to push message: ${e}`)
    }
  }

  private startBroadcast(): void {
    this.broadcastTimer = setInterval(() => {
      if (this.messageBuffer.length === 0) return
      const batch = this.messageBuffer.splice(0, 100)
      // 逐条发送，兼容 AstrBot 等标准 OneBot v11 实现
      for (const msg of batch) {
        this.pushMessageImmediate(JSON.stringify(msg))
      }
    }, 50)
  }

  private stopBroadcast(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
  }

  private sendHeartbeatOnce(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const heartbeat = {
        time: Math.floor(Date.now() / 1000),
        self_id: this.config.selfId,
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        status: { online: true, good: true },
        interval: 30000
      }
      this.pushMessageImmediate(heartbeat)
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sendMetaEvent(eventType: 'connect' | 'lifecycle'): void {
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: this.config.selfId,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: eventType
    }
    this.pushMessageImmediate(event)
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnect) {
      warn(`已尝试 ${this.maxReconnect} 次重连均失败，停止检测。等待下次消息触发或手动重启。`)
      this.emit('failed')
      return
    }
    this.reconnectAttempts++
    const delayMs = Math.min(30000 * Math.pow(2, this.reconnectAttempts - 1), 300000)
    const delaySec = Math.round(delayMs / 1000)
    const delayMin = Math.round(delaySec / 60)
    const delayStr = delayMin > 0 ? `${delayMin} 分钟` : `${delaySec} 秒`
    warn(`连接断开，第 ${this.reconnectAttempts}/${this.maxReconnect} 次重连，${delayStr}后尝试...`)
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs)
  }

  disconnect(): void {
    this.stopHeartbeat()
    this.stopBroadcast()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close(1000, 'Normal closure') } catch {}
      this.ws = null
    }
    this.connected = false
    this.reconnectAttempts = this.maxReconnect
    log('Client disconnected')
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN
  }

  isActive(): boolean {
    return this.connected || this.reconnectAttempts < this.maxReconnect
  }

  wake(): void {
    if (this.connected) {
      log('wake() — 已连接，无需重连')
      return
    }
    if (this.reconnectAttempts >= this.maxReconnect) {
      log('wake() — 之前重连失败已达上限，重新开始重连...')
      this.reconnectAttempts = 0
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    log('wake() — 消息触发重连')
    this.connect()
  }

  getClientCount(): number {
    return this.connected ? 1 : 0
  }

  getConfig(): OneBotWsClientConfig {
    return this.config
  }
}

function log(msg: string) {
  logger.info('onebot', `[WSClient] ${msg}`)
}

function warn(msg: string) {
  logger.warn('onebot', `[WSClient] ${msg}`)
}
