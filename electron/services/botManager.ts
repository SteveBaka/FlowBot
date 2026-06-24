import { OneBotServer, OneBotConfig } from './oneBotServer'
import { logger } from './logger'

interface BotEntry {
  id: string
  name: string
  mode: 'http' | 'ws'
  direction: 'server' | 'client'
  address: string
  port: number
  token: string
  enabled: boolean
  server: OneBotServer | null
  status: 'running' | 'stopped' | 'error'
  error?: string
  lastHealthCheck?: number
  clientCount?: number
  connectionStatus?: 'connected' | 'disconnected' | 'unknown'
}

interface BotConfig {
  id: string
  name: string
  mode: 'http' | 'ws'
  direction: 'server' | 'client'
  address: string
  port: number
  token: string
  enabled: boolean
}

const bots: Map<string, BotEntry> = new Map()
let onMessageCallback: ((msg: any) => void) | null = null

export function setBotMessageCallback(cb: (msg: any) => void) {
  onMessageCallback = cb
}

function parseBotsConfig(raw: string | BotConfig[]): BotConfig[] {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function startBotManager(
  botsConfigRaw: string | BotConfig[],
  getConfig: (key: string) => any
): Promise<void> {
  const configs = parseBotsConfig(botsConfigRaw)
  log(`BotManager: Found ${configs.length} bot configs`)

  for (const cfg of configs) {
    if (!cfg.enabled) {
      log(`BotManager: Skipping disabled bot "${cfg.name}" (${cfg.id})`)
      bots.set(cfg.id, {
        ...cfg,
        server: null,
        status: 'stopped'
      })
      continue
    }

    if (bots.has(cfg.id) && bots.get(cfg.id)!.status === 'running') {
      log(`BotManager: Bot "${cfg.name}" already running, skipping`)
      continue
    }

    await startBot(cfg, getConfig)
  }

  setInterval(() => { healthCheckAll() }, 30_000)
}

async function startBot(cfg: BotConfig, getConfig: (key: string) => any): Promise<void> {
  log(`BotManager: Starting bot "${cfg.name}" on port ${cfg.port} (${cfg.mode}/${cfg.direction})...`)

  const entry: BotEntry = {
    ...cfg,
    server: null,
    status: 'stopped'
  }

  if (cfg.mode === 'http' || (cfg.mode === 'ws' && cfg.direction === 'server')) {
    const serverConfig: OneBotConfig = {
      enabled: true,
      port: cfg.port,
      accessToken: cfg.token || '',
      selfId: cfg.name || cfg.id,
      maxConnections: 10,
      broadcastBatchSize: 100,
      broadcastIntervalMs: 50
    }

    const server = new OneBotServer(serverConfig)

    server.on('started', () => {
      log(`BotManager: Bot "${cfg.name}" started on port ${cfg.port}`)
      entry.status = 'running'
    })

    server.on('error', (err: any) => {
      log(`BotManager: Bot "${cfg.name}" error: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    })

    server.on('api:send_private_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_private_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_private_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    server.on('api:send_group_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_group_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_group_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    server.on('api:send_msg', (data: any) => {
      log(`BotManager: Bot "${cfg.name}" send_msg: ${JSON.stringify(data).substring(0, 100)}`)
      if (onMessageCallback) {
        onMessageCallback({
          action: 'send_msg',
          botId: cfg.id,
          botName: cfg.name,
          params: data
        })
      }
    })

    try {
      await server.start()
      entry.server = server
      entry.status = 'running'
    } catch (err: any) {
      log(`BotManager: Bot "${cfg.name}" failed to start: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    }
  } else if (cfg.mode === 'ws' && cfg.direction === 'client') {
    // WS Client 模式：WeFlow 作为客户端连接到外部 WS Server（如 AstrBot）
    const wsUrl = cfg.address.startsWith('ws') ? cfg.address
      : `ws://${cfg.address}:${cfg.port}`
    const wsPath = wsUrl.includes('/ws') ? wsUrl : `${wsUrl}/ws`

    const { OneBotWsClient } = require('./oneBotWsClient')
    const client = new OneBotWsClient({
      id: cfg.id,
      name: cfg.name,
      url: wsPath,
      token: cfg.token || '',
      selfId: cfg.name || cfg.id,
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 20
    })

    client.on('connected', () => {
      log(`BotManager: Bot "${cfg.name}" connected to ${wsPath}`)
      entry.status = 'running'
      entry.error = undefined
    })

    client.on('disconnected', () => {
      log(`BotManager: Bot "${cfg.name}" disconnected from ${wsPath}`)
      entry.status = 'stopped'
    })

    client.on('failed', () => {
      log(`BotManager: Bot "${cfg.name}" connection failed permanently`)
      entry.status = 'error'
      entry.error = 'Max reconnect attempts reached'
    })

    client.on('api', (request: { action: string; params?: any; echo?: any }) => {
      log(`BotManager: Bot "${cfg.name}" received API: ${request.action}`)
      // 外部 server 发来的 API 请求 → 转发到 onMessageCallback
      if (onMessageCallback) {
        onMessageCallback({
          action: request.action,
          botId: cfg.id,
          botName: cfg.name,
          params: request.params || {}
        })
      }
      // 返回响应
      try {
        const result = handleApiAction(request.action, request.params || {})
        client.sendResponse({
          retcode: 0,
          status: 'ok',
          data: result,
          echo: request.echo
        })
      } catch (e: any) {
        client.sendResponse({
          retcode: 100,
          status: 'failed',
          data: null,
          message: e.message || String(e),
          echo: request.echo
        })
      }
    })

    entry.server = client as any
    try {
      await client.connect()
      entry.status = 'running'
      log(`BotManager: Bot "${cfg.name}" WS client connecting to ${wsPath}`)
    } catch (err: any) {
      log(`BotManager: Bot "${cfg.name}" WS client connect failed: ${err}`)
      entry.status = 'error'
      entry.error = String(err)
    }
  }

  bots.set(cfg.id, entry)
}

export async function stopBot(botId: string): Promise<boolean> {
  const entry = bots.get(botId)
  if (!entry) return false

  if (entry.server) {
    try {
      // WS Client 有 disconnect()，Server 有 stop()
      if (typeof (entry.server as any).disconnect === 'function') {
        (entry.server as any).disconnect()
      } else if (typeof (entry.server as any).stop === 'function') {
        await (entry.server as any).stop()
      }
    } catch {}
    entry.server = null
  }
  entry.status = 'stopped'
  entry.error = undefined
  log(`BotManager: Bot "${entry.name}" stopped`)
  return true
}

export async function stopAllBots(): Promise<void> {
  for (const [id] of bots) {
    await stopBot(id)
  }
}

export async function restartBot(botId: string, getConfig: (key: string) => any): Promise<boolean> {
  await stopBot(botId)
  const raw = getConfig('bots')
  const configs = parseBotsConfig(raw)
  const cfg = configs.find((c: BotConfig) => c.id === botId)
  if (!cfg) return false
  await startBot(cfg, getConfig)
  return true
}

export async function healthCheckAll(): Promise<void> {
  const now = Date.now()
  for (const [, entry] of bots) {
    if (entry.status !== 'running') {
      entry.connectionStatus = 'unknown'
      continue
    }

    if (entry.mode === 'http' || (entry.mode === 'ws' && entry.direction === 'server')) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(`http://127.0.0.1:${entry.port}/api/get_status`, {
          signal: controller.signal,
          headers: entry.token ? { Authorization: `Bearer ${entry.token}` } : {},
        })
        clearTimeout(timeout)
        if (res.ok) {
          const body = await res.json() as any
          entry.connectionStatus = 'connected'
          entry.clientCount = body?.data?.client_count ?? entry.server?.getClientCount() ?? 0
        } else {
          entry.connectionStatus = 'disconnected'
        }
      } catch {
        entry.connectionStatus = 'disconnected'
      }
      entry.lastHealthCheck = now
    } else if (entry.mode === 'ws' && entry.direction === 'client') {
      entry.connectionStatus = entry.server?.isConnected() ? 'connected' : 'disconnected'
      entry.lastHealthCheck = now
    }
  }
}

export function getBotStatus(): Array<{
  id: string
  name: string
  mode: string
  direction: string
  port: number
  status: string
  error?: string
  clientCount: number
  connectionStatus?: 'connected' | 'disconnected' | 'unknown'
  lastHealthCheck?: number
}> {
  const result: any[] = []
  for (const [id, entry] of bots) {
    let clientCount = entry.clientCount ?? 0
    if (entry.server) {
      try {
        clientCount = (entry.server as any).clients?.size || clientCount
      } catch {}
    }
    result.push({
      id,
      name: entry.name,
      mode: entry.mode,
      direction: entry.direction,
      port: entry.port,
      status: entry.status,
      error: entry.error,
      clientCount,
      connectionStatus: entry.connectionStatus,
      lastHealthCheck: entry.lastHealthCheck,
    })
  }
  return result
}

function handleApiAction(action: string, params: any): any {
  switch (action) {
    case 'get_status':
      return { online: true, good: true, client_count: bots.size, self_id: 'WeFlow' }
    case 'get_version_info':
      return { app_name: 'WeFlow-OneBot', app_version: '1.0.0', protocol_version: 'v11' }
    case 'get_login_info':
      return { user_id: 0, nickname: '' }
    case 'get_friend_list':
      return []
    case 'get_group_list':
      return []
    case 'send_private_msg':
    case 'send_group_msg':
    case 'send_msg':
      // 消息发送已在 onMessageCallback 中处理
      return { message_id: Date.now() }
    case 'get_msg':
      return { message: null }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

export function broadcastToAllBots(event: string, data: any): void {
  for (const [, entry] of bots) {
    if (entry.server && entry.status === 'running') {
      try {
        const msg = {
          time: Math.floor(Date.now() / 1000),
          self_id: entry.name || entry.id,
          post_type: 'message',
          message_type: data.sessionType === 'group' ? 'group' : 'private',
          message_id: Date.now(),
          user_id: data.rawid || 0,
          group_id: data.sessionType === 'group' ? data.sessionId : undefined,
          message: [{ type: 'text', data: { text: data.content || '' } }],
          raw_message: data.content || '',
          sender: { user_id: data.rawid || 0, nickname: data.senderName || '' }
        }
        entry.server.pushMessage(msg)
      } catch {}
    }
  }
}

function log(msg: string) {
  logger.info('onebot', msg)
}
