import { EventEmitter } from 'events'
import * as http from 'http'
import * as crypto from 'crypto'

export interface OneBotConfig {
  enabled: boolean
  port: number
  accessToken: string
  selfId: string
  maxConnections: number
  broadcastBatchSize: number
  broadcastIntervalMs: number
}

interface OneBotMessage {
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

interface OneBotApiRequest {
  action: string
  params: Record<string, unknown>
  echo?: unknown
}

type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(): void
  on(event: string, handler: (...args: any[]) => void): void
}

const WS_OPEN = 1

export class OneBotServer extends EventEmitter {
  private config: OneBotConfig
  private httpServer: http.Server | null = null
  private clients: Set<WebSocketLike> = new Set()
  private messageBuffer: OneBotMessage[] = []
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private messageIdCounter = 0
  private started = false

  private readonly broadcastBatchSize: number
  private readonly broadcastIntervalMs: number

  constructor(config: OneBotConfig) {
    super()
    this.config = config
    this.broadcastBatchSize = config.broadcastBatchSize || 100
    this.broadcastIntervalMs = config.broadcastIntervalMs || 50
  }

  start(): void {
    if (this.started) return
    if (!this.config.enabled) return

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res)
    })

    this.setupWebSocketUpgrade()

    this.httpServer.listen(this.config.port, () => {
      this.started = true
      console.log(`[OneBot] Server started on port ${this.config.port}`)
      this.emit('started', { port: this.config.port })
    })

    this.httpServer.on('error', (error) => {
      console.error('[OneBot] Server error:', error)
      this.emit('error', error)
    })
  }

  stop(): void {
    if (!this.started) return

    for (const client of this.clients) {
      try { client.close() } catch {}
    }
    this.clients.clear()

    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }

    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }

    this.started = false
    console.log('[OneBot] Server stopped')
    this.emit('stopped')
  }

  updateConfig(config: Partial<OneBotConfig>): void {
    this.config = { ...this.config, ...config }
    if (this.started && !this.config.enabled) {
      this.stop()
    }
  }

  getConfig(): OneBotConfig {
    return { ...this.config }
  }

  isConnected(): boolean {
    return this.started
  }

  getClientCount(): number {
    return this.clients.size
  }

  pushMessage(msg: OneBotMessage): void {
    this.messageBuffer.push(msg)
    if (this.messageBuffer.length >= this.broadcastBatchSize) {
      this.flushBroadcast()
      return
    }
    if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null
        this.flushBroadcast()
      }, this.broadcastIntervalMs)
    }
  }

  buildMessageEvent(params: {
    messageType: 'private' | 'group'
    userId: number
    groupId?: number
    content: string
    senderNickname: string
    senderCard?: string
  }): OneBotMessage {
    this.messageIdCounter += 1
    const segments = [{ type: 'text', data: { text: params.content } }]

    return {
      time: Math.floor(Date.now() / 1000),
      self_id: this.config.selfId,
      post_type: 'message',
      message_type: params.messageType,
      message_id: this.messageIdCounter,
      user_id: params.userId,
      group_id: params.groupId,
      message: segments,
      raw_message: params.content,
      sender: {
        user_id: params.userId,
        nickname: params.senderNickname,
        card: params.senderCard,
      },
    }
  }

  buildMetaEvent(eventType: 'lifecycle' | 'heartbeat'): Record<string, unknown> {
    const base = {
      time: Math.floor(Date.now() / 1000),
      self_id: this.config.selfId,
      post_type: 'meta_event',
      meta_event_type: eventType,
    }

    if (eventType === 'heartbeat') {
      return { ...base, status: { online: true, good: true }, interval: 30000 }
    }
    return { ...base, sub_type: 'connect' }
  }

  private flushBroadcast(): void {
    if (this.messageBuffer.length === 0) return
    const messages = this.messageBuffer.splice(0, this.broadcastBatchSize)
    const data = JSON.stringify({ post_type: 'messages:batch', data: messages })

    for (const client of this.clients) {
      if (client.readyState === WS_OPEN) {
        try { client.send(data) } catch { this.clients.delete(client) }
      } else {
        this.clients.delete(client)
      }
    }

    if (this.messageBuffer.length > 0) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null
        this.flushBroadcast()
      }, this.broadcastIntervalMs)
    }
  }

  private setupWebSocketUpgrade(): void {
    if (!this.httpServer) return

    this.httpServer.on('upgrade', (req, socket, head) => {
      if (!this.verifyToken(req)) {
        socket.destroy()
        return
      }

      if (this.clients.size >= this.config.maxConnections) {
        socket.destroy()
        return
      }

      const ws = this.createWebSocketFromUpgrade(req, socket, head)
      if (ws) {
        this.clients.add(ws)
        this.setupClientEvents(ws)
        console.log(`[OneBot] WebSocket client connected (total: ${this.clients.size})`)
      }
    })
  }

  private createWebSocketFromUpgrade(
    _req: http.IncomingMessage,
    socket: Buffer | import('net').Socket,
    head: Buffer
  ): WebSocketLike | null {
    const key = crypto.randomBytes(16).toString('base64')
    const accept = crypto
      .createHash('sha1')
      .update((_req.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-5AB9AABBDC61')
      .digest('base64')

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')

    socket.write(responseHeaders)

    let buffer = Buffer.alloc(0)
    const sendFrame = (data: string): void => {
      const payload = Buffer.from(data, 'utf8')
      const mask = crypto.randomBytes(4)
      let header: Buffer

      if (payload.length < 126) {
        header = Buffer.alloc(2)
        header[0] = 0x81
        header[1] = 0x80 | payload.length
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4)
        header[0] = 0x81
        header[1] = 0x80 | 126
        header.writeUInt16BE(payload.length, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = 0x81
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(payload.length), 2)
      }

      const masked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4]
      }

      const frame = Buffer.concat([header, mask, masked])
      try { (socket as import('net').Socket).write(frame) } catch {}
    }

    const ws: WebSocketLike = {
      readyState: WS_OPEN,
      send: sendFrame,
      close: () => {
        try { (socket as import('net').Socket).destroy() } catch {}
        ws.readyState = 3
      },
      on: (_event: string, _handler: (...args: any[]) => void) => {},
    }

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const firstByte = buffer[0]
        const secondByte = buffer[1]
        const opcode = firstByte & 0x0f
        const masked = (secondByte & 0x80) !== 0
        let payloadLength = secondByte & 0x7f
        let offset = 2

        if (payloadLength === 126) {
          if (buffer.length < 4) break
          payloadLength = buffer.readUInt16BE(2)
          offset = 4
        } else if (payloadLength === 127) {
          if (buffer.length < 10) break
          payloadLength = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }

        if (masked) offset += 4
        if (buffer.length < offset + payloadLength) break

        let payload = buffer.subarray(offset, offset + payloadLength)
        if (masked) {
          const maskKey = buffer.subarray(offset - 4, offset)
          payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]))
        }

        buffer = buffer.subarray(offset + payloadLength)

        if (opcode === 0x08) {
          ws.readyState = 3
          socket.removeAllListeners('data')
          return
        }
        if (opcode === 0x01) {
          const text = payload.toString('utf8')
          try {
            const msg = JSON.parse(text) as OneBotApiRequest
            this.handleApiRequest(ws, msg)
          } catch {}
        }
      }
    }

    ;(socket as import('net').Socket).on('data', onData)
    if (head.length > 0) onData(head)

    return ws
  }

  private setupClientEvents(ws: WebSocketLike): void {
    ws.on('close', () => {
      this.clients.delete(ws)
      console.log(`[OneBot] WebSocket client disconnected (total: ${this.clients.size})`)
    })
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.verifyToken(req)) {
      this.sendJsonResponse(res, 401, { retcode: 100, status: 'failed', data: null, message: 'Unauthorized' })
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    if (pathname === '/api/get_status' || pathname === '/get_status') {
      this.sendJsonResponse(res, 200, {
        retcode: 0,
        status: 'ok',
        data: { online: this.started, good: true },
      })
      return
    }

    if (pathname === '/api/get_version_info' || pathname === '/get_version_info') {
      this.sendJsonResponse(res, 200, {
        retcode: 0,
        status: 'ok',
        data: {
          app_name: 'WeFlow-OneBot',
          app_version: '1.0.0',
          protocol_version: 'v11',
        },
      })
      return
    }

    if (pathname === '/api/get_login_info' || pathname === '/get_login_info') {
      this.sendJsonResponse(res, 200, {
        retcode: 0,
        status: 'ok',
        data: {
          user_id: Number(this.config.selfId) || 0,
          nickname: '',
        },
      })
      return
    }

    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as OneBotApiRequest
          const result = this.executeApi(parsed.action, parsed.params)
          this.sendJsonResponse(res, 200, {
            retcode: 0,
            status: 'ok',
            data: result,
            echo: parsed.echo,
          })
        } catch (error) {
          this.sendJsonResponse(res, 400, {
            retcode: 100,
            status: 'failed',
            data: null,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
      return
    }

    this.sendJsonResponse(res, 404, { retcode: 100, status: 'failed', data: null, message: 'Not found' })
  }

  private handleApiRequest(ws: WebSocketLike, request: OneBotApiRequest): void {
    try {
      const result = this.executeApi(request.action, request.params)
      const response = {
        retcode: 0,
        status: 'ok',
        data: result,
        echo: request.echo,
      }
      ws.send(JSON.stringify(response))
    } catch (error) {
      const response = {
        retcode: 100,
        status: 'failed',
        data: null,
        message: error instanceof Error ? error.message : String(error),
        echo: request.echo,
      }
      ws.send(JSON.stringify(response))
    }
  }

  private executeApi(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case 'get_status':
        return { online: this.started, good: true }

      case 'get_version_info':
        return {
          app_name: 'WeFlow-OneBot',
          app_version: '1.0.0',
          protocol_version: 'v11',
        }

      case 'get_login_info':
        return {
          user_id: Number(this.config.selfId) || 0,
          nickname: '',
        }

      case 'get_friend_list':
        return []

      case 'get_group_list':
        return []

      case 'send_private_msg': {
        const userId = params.user_id as number
        const message = params.message as string
        if (!userId || !message) throw new Error('user_id and message required')
        this.emit('api:send_private_msg', { userId, message, params })
        return { message_id: this.generateMessageId() }
      }

      case 'send_group_msg': {
        const groupId = params.group_id as number
        const groupMessage = params.message as string
        if (!groupId || !groupMessage) throw new Error('group_id and message required')
        this.emit('api:send_group_msg', { groupId, message: groupMessage, params })
        return { message_id: this.generateMessageId() }
      }

      case 'send_msg': {
        const msgType = params.message_type as string
        const msgParams = params as Record<string, unknown>
        this.emit('api:send_msg', { messageType: msgType, params: msgParams })
        return { message_id: this.generateMessageId() }
      }

      case 'get_msg': {
        const msgId = params.message_id as number
        return {
          message_id: msgId,
          user_id: 0,
          message: [],
          raw_message: '',
          sender: { user_id: 0, nickname: '' },
          time: Math.floor(Date.now() / 1000),
        }
      }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }

  private generateMessageId(): number {
    this.messageIdCounter += 1
    return this.messageIdCounter
  }

  private verifyToken(req: http.IncomingMessage): boolean {
    if (!this.config.accessToken) return true
    const auth = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth
    return token === this.config.accessToken
  }

  private sendJsonResponse(res: http.ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
}

let instance: OneBotServer | null = null

export function getOneBotServer(config?: OneBotConfig): OneBotServer {
  if (!instance) {
    instance = new OneBotServer(config || {
      enabled: false,
      port: 3001,
      accessToken: '',
      selfId: '',
      maxConnections: 10,
      broadcastBatchSize: 100,
      broadcastIntervalMs: 50,
    })
  }
  return instance
}
